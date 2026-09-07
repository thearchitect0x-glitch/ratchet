// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.RATE_LIMIT_PER_MINUTE = '5';
// Empty (not deleted) so helpers' `??=` cannot re-enable it.
process.env.RATE_LIMIT_OVERRIDE = '';
const { setupDb, closePool } = await import('../helpers.js');
const { buildApp } = await import('../../src/api/app.js');
const { createWorkspace } = await import('../../src/domain/auth.js');

let app: Awaited<ReturnType<typeof buildApp>>;
let keyA: string;
let keyB: string;

before(async () => {
  await setupDb();
  app = await buildApp({ logger: false });
  await app.ready();
  keyA = (await createWorkspace('Limit A', 'la@example.test', false)).key.plaintext;
  keyB = (await createWorkspace('Limit B', 'lb@example.test', false)).key.plaintext;
});
after(async () => { await app.close(); await closePool(); });

const hit = (key: string) =>
  app.inject({ url: '/v1/effects', headers: { authorization: `Bearer ${key}` } });

/**
 * Drives a key until it is refused, and hands back the refusal.
 *
 * Windows are fixed to wall-clock boundaries, not sliding, so a burst that
 * straddles one gets the tail of a window plus the head of the next — up to
 * twice the published limit in a rolling sixty seconds. KNOWN_LIMITATIONS §2
 * documents that as deliberate.
 *
 * These tests used to burst to `limit + 5`, assert EXACTLY `limit` successes,
 * and then let the next two tests assume the key was still throttled. On a
 * boundary crossing the counter reset mid-burst, nothing was refused, and all
 * three failed together — which is what happened in CI on 6 Sep 2026, on a
 * documentation-only branch, and cost an hour of looking for a defect that was
 * in the test.
 *
 * `plan-limits.test.ts` was fixed for this exact cause by driving past twice the
 * limit so one boundary cannot save the caller. This is the same fix, plus each
 * test now establishes its own throttled state instead of inheriting it.
 */
async function driveUntilThrottled(key: string, limit: number) {
  const codes: number[] = [];
  // Twice the limit plus a margin: one boundary reset cannot absorb it.
  for (let i = 0; i < limit * 2 + 10; i += 1) {
    const r = await hit(key);
    codes.push(r.statusCode);
    if (r.statusCode === 429) return { codes, refusal: r };
  }
  throw new Error(`never refused after ${codes.length} requests against a limit of ${limit}`);
}

describe('rate limiting', () => {
  test('an authenticated key is throttled at its PLAN limit', async () => {
    // RATE_LIMIT_PER_MINUTE governs unauthenticated traffic only; an
    // authenticated request is limited by the plan its workspace is on.
    const { PLANS } = await import('../../src/domain/plans.js');
    const limit = PLANS.free.rateLimitPerMinute;
    const { codes } = await driveUntilThrottled(keyA, limit);

    assert.ok(codes.includes(429), 'the limit must actually be enforced');
    // Not `=== limit`. A fixed window can hand out up to twice the limit across
    // a boundary, and asserting exactness claims a guarantee the system does not
    // make — see KNOWN_LIMITATIONS §2.
    const allowed = codes.filter((c) => c === 200).length;
    assert.ok(allowed <= limit * 2,
      `${allowed} allowed against a limit of ${limit}; even a boundary crossing caps at 2x`);
    assert.ok(allowed >= 1, 'a valid key must get through at least once');
  });

  test('the throttle response is machine-readable and says when to retry', async () => {
    const { PLANS } = await import('../../src/domain/plans.js');
    // Establishes its own refusal rather than inheriting one from the test above:
    // between two tests the window can roll over and the key is no longer throttled.
    const { refusal } = await driveUntilThrottled(keyA, PLANS.free.rateLimitPerMinute);

    assert.equal(refusal.statusCode, 429);
    const body = JSON.parse(refusal.payload);
    assert.equal(body.error.code, 'rate_limited');
    assert.ok(body.error.detail.retry_after_seconds > 0);
  });

  test('one tenant cannot exhaust another tenant\'s budget', async () => {
    const { PLANS } = await import('../../src/domain/plans.js');
    await driveUntilThrottled(keyA, PLANS.free.rateLimitPerMinute);
    const r = await hit(keyB);
    assert.equal(r.statusCode, 200,
      'limits are per-key, so a noisy tenant must not throttle a quiet one');
  });

  test('signup is throttled separately and more tightly than the API', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 8; i++) {
      codes.push((await app.inject({
        method: 'POST', url: '/v1/workspaces',
        payload: { name: `Spam ${i}`, email: `spam${i}@example.test` },
      })).statusCode);
    }
    assert.ok(codes.includes(429), 'unauthenticated signup must be rate limited');
    assert.ok(codes.filter((c) => c === 201).length <= 5);
  });
});

describe('request size limits', () => {
  test('an oversized body is refused before it is parsed', async () => {
    const r = await app.inject({
      method: 'POST', url: '/v1/effects/begin',
      headers: { authorization: `Bearer ${keyB}`, 'content-type': 'application/json' },
      payload: JSON.stringify({
        effect_type: 'email.send', idempotency_key: 'big',
        payload: { blob: 'x'.repeat(200_000) },
      }),
    });
    assert.ok(r.statusCode === 413 || r.statusCode === 429, `got ${r.statusCode}`);
  });
});

/**
 * A route stricter than the plan must still be a real limit. This exercises the
 * feedback letterbox with the override cleared, which is the only configuration
 * where the strictness is live.
 */
describe('routes that are deliberately stricter than the plan', () => {
  test('the feedback letterbox stops at its own ceiling', async () => {
    const seen: number[] = [];
    for (let i = 0; i < 14; i++) {
      const r = await app.inject({
        method: 'POST', url: '/v1/feedback',
        payload: { path: '/faq', was_clear: true },
        headers: { 'x-forwarded-for': '203.0.113.77' },
      });
      seen.push(r.statusCode);
    }
    assert.ok(seen.includes(429), 'the ceiling must actually be reached');
    assert.equal(seen[0], 202, 'and the first request must get through');
  });
});

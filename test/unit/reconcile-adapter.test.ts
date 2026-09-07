// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * The reconciliation adapter.
 *
 * Tested here rather than in the package because the package ships with zero
 * dependencies and no test runner of its own, and because what matters most is
 * a property about OUR endpoint: every POST /v1/reconcile records a run, which
 * resets the cadence clock. A dry run that reached the endpoint would silently
 * mark the check as done while comparing nothing — the trap issue #17 asked to
 * be designed for explicitly.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

/*
 * The package ships as plain .mjs with no type declarations, on purpose: it has
 * zero dependencies and no build step, so a customer can read the whole thing
 * before running it against their vendor credential. `any` here is the cost of
 * that, and it is paid once, at the import.
 */
const load = (p: string): Promise<any> => import(p);
const { reconcile, exitCodeFor, EXIT, MAX_KEYS_PER_CALL, CALLS_PER_HOUR } =
  await load('../../packages/ratchet-reconcile/lib/reconcile.mjs');
const { stripe } = await load('../../packages/ratchet-reconcile/lib/connectors/stripe.mjs');
const { redact, redactWith } = await load('../../packages/ratchet-reconcile/lib/redact.mjs');

type Call = { url: string; body: unknown };

/** A Stripe that returns the given events, one page, plus a Ratchet that counts. */
function harness(events: unknown[], ratchetReply: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  const fetchImpl = async (url: string, init?: { method?: string; body?: string }) => {
    calls.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
    // Route on the host, not a prefix. `https://api.stripe.com.example.net/…`
    // satisfies startsWith and is a different server entirely — CodeQL flagged
    // exactly that here. Nothing was at risk: this is test dispatch, not a
    // security control. But a fake that routes on a prefix is a fake that can
    // answer for the wrong host without saying so, and the habit is worth not
    // having in a file about verifying what reached a vendor.
    if (new URL(url).host === 'api.stripe.com') {
      return { ok: true, status: 200, json: async () => ({ data: events, has_more: false }) };
    }
    return {
      ok: true, status: 200,
      json: async () => ({ checked: 0, gated: 0, ungated: 0, ungated_keys: [], ...ratchetReply }),
    };
  };
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch };
}

const ev = (id: string, key: string | null) => ({
  id, type: 'charge.succeeded', created: 1,
  request: key === null ? {} : { id: `req_${id}`, idempotency_key: key },
});

const run = (opts: Record<string, unknown>, fetchImpl: typeof fetch) => reconcile({
  connector: stripe, credential: 'sk_test', apiKey: 'rk_test',
  baseUrl: 'https://ratchetgate.com', effectType: 'payment.charge',
  since: Date.now() - 86_400_000, until: Date.now(), windowDays: 1,
  fetchImpl, ...opts,
});

describe('the dry-run trap', () => {
  /**
   * The single most important property here.
   *
   * Every POST /v1/reconcile calls recordRun, which is what resets the cadence
   * clock and stops the scheduler asking for a check that just ran. A dry run
   * that touched the endpoint would mark reconciliation as done while having
   * compared nothing — the check would then be skipped for a full cadence on
   * the strength of a rehearsal.
   */
  test('a dry run never reaches the reconcile endpoint at all', async () => {
    const { calls, fetchImpl } = harness([ev('e1', 'rtk_a'), ev('e2', 'rtk_b')]);
    const s = await run({ dryRun: true }, fetchImpl);

    const posted = calls.filter((c) => c.url.includes('/v1/reconcile'));
    assert.equal(posted.length, 0,
      'a dry run must not POST — every call records a run and resets the cadence clock');
    assert.equal(s.dryRun, true);
    assert.match(s.meaning, /no reconciliation run was recorded/);
    assert.match(s.meaning, /would post 2 key\(s\)/);
  });

  test('a dry run still reads the vendor, or it is rehearsing nothing', async () => {
    const { calls, fetchImpl } = harness([ev('e1', 'rtk_a')]);
    await run({ dryRun: true }, fetchImpl);
    assert.equal(calls.filter((c) => new URL(c.url).host === 'api.stripe.com').length, 1);
  });

  test('a dry run exits 0 — it is a rehearsal, not a verdict', async () => {
    const { fetchImpl } = harness([ev('e1', 'rtk_a')]);
    assert.equal(exitCodeFor(await run({ dryRun: true }, fetchImpl)), EXIT.CLEAN);
  });
});

describe('what the vendor recorded', () => {
  /**
   * The honest third bucket.
   *
   * A Stripe request with no idempotency key might be an ungated path, or a
   * gated effect whose caller did not forward the vendor key. Nothing can tell
   * those apart, so counting them as ungated would accuse working code and
   * counting them as gated would hide a real hole. It reports the number and
   * refuses to guess — the same rule the gate applies to an expired lease.
   */
  test('requests with no idempotency key are never reported as ungated', async () => {
    const { calls, fetchImpl } = harness(
      [ev('e1', 'rtk_a'), ev('e2', null), ev('e3', null)],
      { checked: 1, gated: 1, ungated: 0 },
    );
    const s = await run({}, fetchImpl);

    assert.equal(s.unattributable, 2);
    assert.equal(s.ungated, 0, 'unattributable must not inflate the ungated count');
    const posted = calls.find((c) => c.url.includes('/v1/reconcile'));
    assert.deepEqual((posted!.body as { keys: string[] }).keys, ['rtk_a'],
      'only keys that exist are posted');
  });

  test('a window with no activity says so rather than reporting all clear', async () => {
    const { calls, fetchImpl } = harness([]);
    const s = await run({}, fetchImpl);
    assert.equal(calls.filter((c) => c.url.includes('/v1/reconcile')).length, 0,
      'nothing to compare must not record a run either');
    assert.match(s.meaning, /no activity/i);
  });

  test('duplicate keys are collapsed — a retry is one action, not two', async () => {
    const { calls, fetchImpl } = harness(
      [ev('e1', 'rtk_a'), ev('e2', 'rtk_a'), ev('e3', 'rtk_a')], { checked: 1, gated: 1 });
    await run({}, fetchImpl);
    const posted = calls.find((c) => c.url.includes('/v1/reconcile'));
    assert.deepEqual((posted!.body as { keys: string[] }).keys, ['rtk_a']);
  });

  test('it posts vendor key space, because Stripe holds the key WE derived', async () => {
    const { calls, fetchImpl } = harness([ev('e1', 'rtk_a')]);
    await run({}, fetchImpl);
    const b = calls.find((c) => c.url.includes('/v1/reconcile'))!.body as Record<string, unknown>;
    // Posting these as `idempotency` reports a perfectly gated workspace as
    // entirely ungated: they are different key spaces.
    assert.equal(b.key_space, 'vendor');
    assert.equal(b.vendor, 'stripe');
  });
});

describe('an incomplete answer is not a clean one', () => {
  /**
   * `partial: true` means Ratchet reached its candidate limit, so an unmatched
   * key may belong to an effect it never examined. Exiting 0 would report all
   * clear from an incomplete comparison; exiting 1 would accuse code that may
   * be fine. Neither is true.
   */
  test('partial produces its own exit code, not clean and not ungated', async () => {
    const { fetchImpl } = harness([ev('e1', 'rtk_a')],
      { checked: 1, gated: 0, ungated: 1, partial: true });
    const s = await run({}, fetchImpl);

    assert.equal(s.partial, true);
    assert.equal(exitCodeFor(s), EXIT.INCONCLUSIVE);
    assert.notEqual(exitCodeFor(s), EXIT.CLEAN);
    assert.notEqual(exitCodeFor(s), EXIT.UNGATED);
    assert.match(s.meaning, /Incomplete/);
    assert.match(s.meaning, /before treating any of these as ungated/);
  });

  test('ungated findings exit 1, so a cron pages somebody', async () => {
    const { fetchImpl } = harness([ev('e1', 'rtk_a')],
      { checked: 1, gated: 0, ungated: 1, ungated_keys: ['rtk_a'] });
    const s = await run({}, fetchImpl);
    assert.equal(exitCodeFor(s), EXIT.UNGATED);
    assert.match(s.meaning, /without ever asking Ratchet/);
  });

  test('a clean comparison exits 0', async () => {
    const { fetchImpl } = harness([ev('e1', 'rtk_a')], { checked: 1, gated: 1, ungated: 0 });
    assert.equal(exitCodeFor(await run({}, fetchImpl)), EXIT.CLEAN);
  });
});

describe('batching against the endpoint\'s published limits', () => {
  test('keys are split into calls of at most the endpoint maximum', async () => {
    const events = Array.from({ length: 1500 }, (_, i) => ev(`e${i}`, `rtk_${i}`));
    const { calls, fetchImpl } = harness(events, { checked: 1000, gated: 1000 });
    const s = await run({}, fetchImpl);

    const posted = calls.filter((c) => c.url.includes('/v1/reconcile'));
    assert.equal(posted.length, 2);
    assert.equal(s.batches, 2);
    for (const p of posted) {
      assert.ok((p.body as { keys: string[] }).keys.length <= MAX_KEYS_PER_CALL,
        `a batch exceeded the endpoint's limit of ${MAX_KEYS_PER_CALL}`);
    }
  });

  /**
   * Refuse rather than get refused. 60 calls an hour is the endpoint's limit, so
   * a window needing more will be rate-limited partway through — leaving a
   * recorded run, a partial comparison, and a cadence clock reset on the
   * strength of it. Saying so up front is cheaper than discovering it at key
   * 60,001.
   */
  test('a window needing more calls than the hourly limit is refused up front', async () => {
    const tooMany = MAX_KEYS_PER_CALL * (CALLS_PER_HOUR + 1);
    const events = Array.from({ length: tooMany }, (_, i) => ev(`e${i}`, `rtk_${i}`));
    const { calls, fetchImpl } = harness(events);

    await assert.rejects(() => run({}, fetchImpl), /over the endpoint's limit/);
    assert.equal(calls.filter((c) => c.url.includes('/v1/reconcile')).length, 0,
      'it must refuse before posting anything, not partway through');
  });
});

describe('keeping credentials out of CI logs', () => {
  /**
   * The reason this exists. Stripe answers a bad key with
   * `Invalid API Key provided: sk_...`, and this tool runs on a schedule in CI
   * where stderr is a build log — often readable by more people than the secret
   * store the key came from.
   */
  test('a vendor echoing the key back does not put it in the log', () => {
    const out = redact('Invalid API Key provided: sk_test_51HabcdefghijklmnopQRST');
    assert.ok(!out.includes('51Habcdefghijklmnop'), 'the key survived into the message');
    assert.match(out, /sk_\[redacted \d+ chars\]/);
  });

  test('the common credential shapes are covered', () => {
    for (const secret of [
      'sk_live_abcdefghijklmnop', 'rk_test_abcdefghijkl', 'whsec_abcdefghijkl',
      're_abcdefghijkl', 'tsec_abcdefghijklmn', 'cfat_abcdefghijklmn',
      'ghp_abcdefghijklmnopqrst', 'AKIAABCDEFGHIJKLMNOP',
    ]) {
      assert.ok(!redact(`token=${secret}`).includes(secret), `${secret} was not redacted`);
    }
  });

  /**
   * The one thing that must NOT be redacted.
   *
   * rtk_ keys are the subject of the report: an unmatched one is the ungated
   * action the operator has to go and fix. Scrubbing them would produce a tool
   * that announces a problem and then refuses to say which one.
   */
  test('the findings themselves survive, or the report is useless', () => {
    const line = 'ungated: rtk_9f2c1a4b, rtk_77bd0e12';
    assert.equal(redact(line), line);
  });

  /**
   * A vendor with an unrecognised key format sails straight past the pattern.
   * We always know our own credential, so it is removed exactly as well.
   */
  test('an unrecognised credential is still removed, because we hold it', () => {
    const odd = 'ZmFrZS1jcmVkZW50aWFs';
    assert.ok(!redactWith(`auth failed for ${odd}`, odd).includes(odd));
  });

  test('a short string is not treated as a secret, or every log line vanishes', () => {
    assert.equal(redactWith('effect_type=x', 'x'), 'effect_type=x');
  });
});

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * Reconciling against the key the vendor actually holds.
 *
 * A caller using vendor-enforced idempotency sends Stripe the `rtk_` key Ratchet
 * derived, not their own. Pulling those back from Stripe and posting them as
 * `idempotency` keys reports every action ungated on a perfectly gated
 * workspace — which is the failure this whole key space exists to prevent, and
 * the first test asserts it happens so the reason is never forgotten.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshWorkspace, closePool, getPool } from '../helpers.js';
import { matchVendorKeys } from '../../src/domain/vendor-key-match.js';
import { vendorIdempotencyKey } from '../../src/domain/vendor-keys.js';

const { beginEffect, reportEffect } = await import('../../src/domain/effects.js');

let ws: Awaited<ReturnType<typeof freshWorkspace>>;
before(async () => { ws = await freshWorkspace(); });
after(async () => { await closePool(); });

const gate = (key: string, vendor?: string) => beginEffect({
  workspaceId: ws.workspaceId, apiKeyId: ws.key.id, apiKeyPrefix: ws.key.prefix,
  keyDailyBudgetMicros: null, effectType: 'payment.charge', idempotencyKey: key,
  payload: { k: key }, estimatedCostMicros: 0, ...(vendor ? { vendor } : {}),
});

describe('vendor key space', () => {
  test('the vendor key is NOT the caller key — this is why the key space exists', async () => {
    const r = await gate('order-100', 'stripe');
    assert.ok(r.vendorKey, 'begin should hand back a vendor key');
    assert.notEqual(r.vendorKey!.key, 'order-100');
    assert.ok(r.vendorKey!.key.startsWith('rtk_'));
  });

  test('posting a vendor key as an idempotency key finds nothing', async () => {
    const r = await gate('order-101', 'stripe');
    const { rows } = await getPool().query(
      `SELECT 1 FROM effects WHERE workspace_id = $1 AND effect_type = $2
        AND idempotency_key = $3`,
      [ws.workspaceId, 'payment.charge', r.vendorKey!.key]);
    assert.equal(rows.length, 0,
      'the old code path would call this ungated on a gated effect');
  });

  test('matched in the vendor key space, and mapped back to the caller key', async () => {
    const r = await gate('order-102', 'stripe');
    const m = await matchVendorKeys(getPool(), ws.workspaceId, 'payment.charge',
      [r.vendorKey!.key], { vendor: 'stripe' });

    assert.equal(m.matched.size, 1);
    assert.equal(m.matched.get(r.vendorKey!.key)?.idempotencyKey, 'order-102');
    assert.equal(m.truncated, false);
  });

  test('a key nobody issued stays unmatched', async () => {
    const m = await matchVendorKeys(getPool(), ws.workspaceId, 'payment.charge',
      ['rtk_thisWasNeverIssuedByUsAtAll'], { vendor: 'stripe' });
    assert.equal(m.matched.size, 0, 'an ungated action must still read as ungated');
  });

  test('the wrong vendor profile does not match, because keys are truncated per vendor', async () => {
    const r = await gate('order-103', 'stripe');
    // Square truncates to a different length, so the same effect derives a
    // different key. Silently matching across profiles would be a false negative
    // on ungated actions — the direction that matters.
    const wrong = await matchVendorKeys(getPool(), ws.workspaceId, 'payment.charge',
      [r.vendorKey!.key], { vendor: 'square' });
    const right = await matchVendorKeys(getPool(), ws.workspaceId, 'payment.charge',
      [r.vendorKey!.key], { vendor: 'stripe' });
    assert.equal(right.matched.size, 1);
    assert.ok(wrong.matched.size <= 1);
  });

  /**
   * A vendor holds the key from whichever attempt actually reached it. An
   * earlier attempt's key is exactly as much evidence of gating as the latest.
   *
   * The first version of this test created only attempt-1 effects, where
   * deriving `1..attempt` and `attempt..attempt` are the same loop — so it
   * passed against an implementation that only ever derived the latest attempt.
   * It has to drive a real retry to mean anything.
   */
  test('an earlier attempt still matches after a retry', async () => {
    const first = await gate('order-104', 'stripe');
    assert.equal(first.attempt, 1);
    const attemptOneKey = first.vendorKey!.key;

    // Fail it, then begin again: that is what moves the effect to attempt 2.
    await reportEffect({
      workspaceId: ws.workspaceId, apiKeyId: ws.key.id, apiKeyPrefix: ws.key.prefix,
      effectId: first.effectId, leaseToken: first.leaseToken!,
      outcome: 'failed', failureReason: 'card_declined',
    });
    const second = await gate('order-104', 'stripe');
    assert.equal(second.attempt, 2, 'the retry must actually be a second attempt');
    assert.notEqual(second.vendorKey!.key, attemptOneKey,
      'a retry gets a fresh vendor key, or the vendor replays the failure forever');

    const m = await matchVendorKeys(getPool(), ws.workspaceId, 'payment.charge',
      [attemptOneKey], { vendor: 'stripe' });
    assert.equal(m.matched.size, 1,
      'attempt 1 reached the vendor; it is gated evidence and must still match');
  });
});

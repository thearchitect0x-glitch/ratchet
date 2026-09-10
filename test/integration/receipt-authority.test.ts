// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * A receipt says under whose authority the effect ran.
 *
 * Until now a receipt answered "did this happen, and did it happen once". It
 * could not answer the question an auditor asks first: *who let it*. The
 * authority was real — an API key, a per-effect ceiling, an approval threshold,
 * sometimes a named approver — and none of it was in the signed evidence.
 *
 * This is deliberately the small version. It cites the authority that already
 * exists rather than introducing a grant object, because the approval flow it
 * would build on has never once been used.
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const { setupDb, closePool, getPool } = await import('../helpers.js');
const { beginEffect } = await import('../../src/domain/effects.js');
const { createWorkspace } = await import('../../src/domain/auth.js');
const { upsertPolicy } = await import('../../src/domain/policy.js');
const { verifyReceipt, receiptPublicKey, canonicalBody, RECEIPT_VERSION } =
  await import('../../src/domain/receipts.js');

let ws: string, keyId: string;
before(async () => {
  await setupDb();
  const w = await createWorkspace('auth', `auth-${Date.now()}@example.test`);
  ws = w.workspaceId;
  keyId = w.key.id;
});
after(async () => { await closePool(); });
beforeEach(async () => {
  await getPool().query('DELETE FROM effect_policies WHERE workspace_id = $1', [ws]);
});

let n = 0;
const begin = (type: string, cost = 0) => beginEffect({
  workspaceId: ws, apiKeyId: keyId, apiKeyPrefix: 'rk_test',
  keyDailyBudgetMicros: null, effectType: type,
  idempotencyKey: `auth-${(n += 1)}-${Date.now()}`,
  payload: { n }, estimatedCostMicros: cost,
});

const receiptFor = async (effectId: string) => {
  const { rows } = await getPool().query<{ body: string; signature: string }>(
    'SELECT body, signature FROM receipts WHERE effect_id = $1 ORDER BY seq LIMIT 1', [effectId]);
  assert.ok(rows[0], 'no receipt written');
  return { body: rows[0]!.body, signature: rows[0]!.signature, parsed: JSON.parse(rows[0]!.body) };
};

describe('a receipt cites the authority it ran under', () => {
  test('it names the key that authorised the effect', async () => {
    const r = await begin('auth.plain');
    const { parsed } = await receiptFor(r.effectId);
    assert.equal(parsed.authority_key_id, keyId);
  });

  /**
   * The key ID, never the prefix and never the secret. A receipt is the one
   * artefact designed to be handed to somebody outside the workspace — an
   * auditor, a counterparty, a court — so it must not carry anything that helps
   * authenticate as the caller.
   */
  test('it carries no part of the credential itself', async () => {
    const r = await begin('auth.plain');
    const { body } = await receiptFor(r.effectId);
    assert.ok(!body.includes('rk_test'), 'the key prefix leaked into the receipt');
    assert.ok(!/\bsk_|\brk_live|\bsecret\b/i.test(body), 'something credential-shaped is in the body');
  });

  test('it records the ceiling in force, so "up to how much" is answerable later', async () => {
    await upsertPolicy(getPool(), ws, { effectType: 'auth.capped', maxCostMicros: 5_000_000 });
    const r = await begin('auth.capped', 1_000);
    const { parsed } = await receiptFor(r.effectId);
    assert.equal(parsed.authority_max_cost_micros, 5_000_000);
  });

  test('no ceiling is recorded as null, not omitted or zero', async () => {
    const r = await begin('auth.uncapped');
    const { parsed } = await receiptFor(r.effectId);
    assert.ok('authority_max_cost_micros' in parsed, 'the field must be present even when null');
    assert.equal(parsed.authority_max_cost_micros, null,
      'absent and zero are different claims — zero would mean "no spend permitted"');
  });

  test('it records the approval threshold that applied', async () => {
    await upsertPolicy(getPool(), ws, { effectType: 'auth.appr', approvalAboveMicros: 250_000 });
    const r = await begin('auth.appr', 1_000);
    const { parsed } = await receiptFor(r.effectId);
    assert.equal(parsed.authority_approval_above_micros, 250_000);
    assert.equal(parsed.authority_approved_by, null, 'nothing was approved, so nobody approved it');
  });
});

describe('the signature covers the authority, or it is decoration', () => {
  test('the receipt verifies as written', async () => {
    const r = await begin('auth.sig');
    const { body, signature } = await receiptFor(r.effectId);
    assert.equal(verifyReceipt(body, signature, receiptPublicKey()), true);
  });

  /**
   * The whole point. If the authority fields sat outside the signed bytes,
   * anyone holding a receipt could rewrite who authorised it and which ceiling
   * applied, and the signature would still check out.
   */
  test('editing who authorised it breaks the signature', async () => {
    const r = await begin('auth.tamper');
    const { body, signature, parsed } = await receiptFor(r.effectId);
    assert.equal(verifyReceipt(body, signature, receiptPublicKey()), true, 'sanity');

    const forged = canonicalBody({ ...parsed, authority_key_id: 'key_someone_else' });
    assert.equal(verifyReceipt(forged, signature, receiptPublicKey()), false,
      'the key id is outside the signature — a holder could reassign blame');
  });

  test('editing the ceiling breaks the signature', async () => {
    await upsertPolicy(getPool(), ws, { effectType: 'auth.tamper2', maxCostMicros: 1_000 });
    const r = await begin('auth.tamper2', 500);
    const { body, signature, parsed } = await receiptFor(r.effectId);
    assert.equal(verifyReceipt(body, signature, receiptPublicKey()), true, 'sanity');

    const forged = canonicalBody({ ...parsed, authority_max_cost_micros: 99_000_000 });
    assert.equal(verifyReceipt(forged, signature, receiptPublicKey()), false,
      'the ceiling is outside the signature — a holder could claim wider authority than existed');
  });
});

describe('receipts written before this existed', () => {
  /**
   * Verification runs against the bytes we stored, never a re-serialisation, so
   * a v3 body with no authority fields checks out unchanged against the same
   * key. Asserted rather than assumed, because "old evidence stops verifying"
   * is the one upgrade failure that cannot be repaired after the fact.
   */
  test('a v3 body still verifies against the current key', async () => {
    const { signBody } = await import('../../src/domain/receipts.js');
    const legacy = {
      v: 'ratchet-receipt-v3', workspace_id: ws, effect_id: 'eff_old',
      effect_type: 'auth.legacy', idempotency_key: 'k-old', decision: 'execute',
      state: 'pending', attempt: 1, payload_fingerprint: 'ab'.repeat(32),
      cost_micros: 0, kid: 'k1', decided_at: new Date().toISOString(),
    } as never;
    const signed = signBody(legacy);
    assert.equal(verifyReceipt(signed.body, signed.signature, receiptPublicKey()), true);
    assert.ok(!signed.body.includes('authority_'), 'a v3 body must not gain fields');
  });

  test('the version says v4, so a verifier knows what it may find', () => {
    assert.equal(RECEIPT_VERSION, 'ratchet-receipt-v4');
  });
});

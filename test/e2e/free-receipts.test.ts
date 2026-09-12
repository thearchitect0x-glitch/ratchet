// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * A free workspace can read the evidence for its own effects.
 *
 * Receipts were always WRITTEN for every plan; only the read was gated. So the
 * artefact the whole product argues from — signed proof, verifiable by someone
 * who is not us — existed for every free workspace and none of them could see
 * it. Eight of the first nine performed exactly one effect and never came back.
 *
 * What is still paid: volume, reconciliation, reversible groups. Things that
 * cost us something to run.
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../../src/api/app.js';
import { setupDb, closePool } from '../helpers.js';

describe('a free workspace and its receipts', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  before(async () => { await setupDb(); app = await buildApp({ logger: false }); await app.ready(); });
  after(async () => { await app.close(); await closePool(); });

  /** A keyless begin: no credential, which is how a free workspace starts. */
  const firstContact = async (n: string) => {
    const r = await app.inject({
      method: 'POST', url: '/v1/effects/begin',
      headers: { 'content-type': 'application/json' },
      payload: {
        effect_type: 'payment.charge',
        idempotency_key: `free-rcpt-${n}-${Date.now()}-${Math.random()}`,
        payload: { amount: 100 },
        estimated_cost_micros: 100_000,
      },
    });
    assert.equal(r.statusCode, 200, r.payload);
    const b = r.json();
    return { effectId: b.effect_id as string, key: b.workspace.api_key as string };
  };

  test('the plan it lands on is free, or this test proves nothing', async () => {
    const { key } = await firstContact('plan');
    const r = await app.inject({
      method: 'GET', url: '/v1/workspace',
      headers: { authorization: `Bearer ${key}` },
    });
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().plan?.id ?? r.json().plan, 'free');
  });

  /**
   * The failure this changes. It used to answer:
   *   403 forbidden — The Free plan does not include signed receipts.
   */
  test('it can read the receipt for its own effect', async () => {
    const { effectId, key } = await firstContact('read');
    const r = await app.inject({
      method: 'GET', url: `/v1/effects/${effectId}/receipts`,
      headers: { authorization: `Bearer ${key}` },
    });
    assert.equal(r.statusCode, 200, `free was refused its own receipt: ${r.payload}`);
    const b = r.json();
    assert.ok(Array.isArray(b.receipts) && b.receipts.length >= 1, 'no receipt came back');
    assert.ok(b.receipts[0].signature, 'a receipt without a signature is not evidence');
    assert.ok(b.public_key_url, 'and it must say where to get the key to check it');
  });

  test('the receipt it gets back actually verifies', async () => {
    const { effectId, key } = await firstContact('verify');
    const r = await app.inject({
      method: 'GET', url: `/v1/effects/${effectId}/receipts`,
      headers: { authorization: `Bearer ${key}` },
    });
    const { receipts } = r.json();
    const { verifyReceipt, receiptPublicKey } = await import('../../src/domain/receipts.js');
    assert.equal(verifyReceipt(receipts[0].body, receipts[0].signature, receiptPublicKey()), true);
  });

  test('it can audit its own chain end to end', async () => {
    const { key } = await firstContact('audit');
    const r = await app.inject({
      method: 'GET', url: '/v1/receipts/audit',
      headers: { authorization: `Bearer ${key}` },
    });
    assert.equal(r.statusCode, 200, r.payload);
    assert.equal(r.json().ok, true);
  });

  /**
   * Tenant isolation does not soften because the plan got more generous. A
   * cross-workspace read must still answer 404 and never hint the record exists.
   */
  test('it still cannot read another workspace receipt', async () => {
    const a = await firstContact('iso-a');
    const b = await firstContact('iso-b');
    const r = await app.inject({
      method: 'GET', url: `/v1/effects/${a.effectId}/receipts`,
      headers: { authorization: `Bearer ${b.key}` },
    });
    assert.equal(r.statusCode, 404, 'a cross-tenant receipt read must be a 404, never a 403 or a body');
    assert.ok(!r.payload.includes(a.effectId.slice(-6)),
      'the refusal must not confirm the effect exists elsewhere');
  });

  /**
   * What is still paid. If this ever passes, the paywall moved further than the
   * decision that opened receipts, and somebody should have meant to.
   */
  test('reconciliation is still a paid capability', async () => {
    const { key } = await firstContact('recon');
    const r = await app.inject({
      method: 'POST', url: '/v1/reconcile',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      payload: { effect_type: 'payment.charge', keys: ['whatever'] },
    });
    assert.equal(r.statusCode, 403, 'reconciliation was not meant to become free here');
  });
});

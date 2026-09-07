// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * The sweep that runs the analysis nobody was running.
 *
 * `structuringReport` had existed for days behind GET /v1/analysis/structuring,
 * which meant it ran only once an operator was already suspicious — and the
 * whole value of a bunching comparison is seeing the shape *before* anyone
 * suspects anything.
 *
 * Almost everything below is about restraint rather than detection. The
 * estimator cannot tell structuring from an honest cap, so this must never
 * enforce, and it must not repeat itself: a monitor that cries wolf gets muted,
 * and a muted monitor is indistinguishable from one that was never built.
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const { setupDb, closePool, getPool } = await import('../helpers.js');
const { sweepStructuring, _internals } = await import('../../src/domain/structuring-sweep.js');
const { upsertPolicy } = await import('../../src/domain/policy.js');
const { createWorkspace } = await import('../../src/domain/auth.js');
const { blind } = await import('../../src/lib/dimensions.js');

const T = 10_000_000_000;                      // $10,000 in micro-USD
const $ = (d: number) => Math.round(d * 1_000_000);

let ws: string;
before(async () => {
  await setupDb();
  ws = (await createWorkspace('sw', `sw-${Date.now()}@example.test`)).workspaceId;
});
after(async () => { await closePool(); });

/*
 * The sweep reads EVERY workspace with a threshold, not just this one, so the
 * suite's other workspaces would drift into the batch and make the counts
 * unstable. Clearing policies globally is what keeps `workspacesExamined`
 * meaningful, and these files run with --test-concurrency=1.
 */
beforeEach(async () => {
  await getPool().query('DELETE FROM effect_policies');
  await getPool().query('DELETE FROM structuring_notices');
  await getPool().query('DELETE FROM effects WHERE workspace_id = $1', [ws]);
  await getPool().query('DELETE FROM webhook_deliveries WHERE workspace_id = $1', [ws]);
  await getPool().query('DELETE FROM webhook_endpoints WHERE workspace_id = $1', [ws]);
});

let n = 0;
async function amounts(values: number[], o: { type?: string; counterparty?: string } = {}) {
  for (const v of values) {
    n += 1;
    const dims = o.counterparty ? blind(ws, { counterparty: o.counterparty }) : {};
    await getPool().query(
      `INSERT INTO effects
         (id, workspace_id, effect_type, idempotency_key, fingerprint, state,
          declared_micros, actual_micros, dimensions, created_at, expires_at)
       VALUES ($1,$2,$3,$4,decode($5,'hex'),'succeeded',$6,$6,$7,
               now(), now() + interval '30 days')`,
      [`eff_sw${n}_${Date.now().toString(36)}`, ws, o.type ?? 'payment.payout',
       `k${n}-${Math.random()}`, String(n).padStart(64, '0'), v, JSON.stringify(dims)]);
  }
}

const watch = (threshold: number | null, type = 'payment.payout') =>
  upsertPolicy(getPool(), ws, { effectType: type, structuringThresholdMicros: threshold });

const subscribe = () => getPool().query(
  `INSERT INTO webhook_endpoints (id, workspace_id, url, secret, events)
   VALUES ($1,$2,'https://example.test/hook','whsec_test',$3)`,
  [`wh_sw_${Date.now()}${n}`, ws, ['structuring.detected']]);

/*
 * An enqueued event lands as a delivery carrying an envelope
 * { type, createdAt, workspaceId, data }, so the fields the sweep sets are one
 * level down. Reading the envelope rather than the sweep's own object is the
 * point: this asserts what a subscriber actually receives.
 */
const events = async () => (await getPool().query<{ payload: { data: Record<string, unknown> } }>(
  `SELECT payload FROM webhook_deliveries
    WHERE workspace_id = $1 AND event_type = 'structuring.detected'
    ORDER BY created_at`, [ws])).rows;

const bunched = () => amounts(Array(23).fill($(9_800)));

describe('sweeping for bunching', () => {
  test('a workspace with a line and a shape under it is found and announced', async () => {
    await watch(T);
    await subscribe();
    await bunched();
    await amounts([$(8_400), $(8_800)]);

    const r = await sweepStructuring();
    assert.equal(r.workspacesExamined, 1);
    assert.equal(r.findings, 1);
    assert.equal(r.announced, 1);
    assert.equal(r.suppressed, 0);
  });

  /**
   * A workspace with nothing to bunch below has nothing to say about it.
   * Reporting it as clean would be the same lie as reporting full coverage on
   * an effect type nobody has ever reconciled.
   */
  test('a workspace with no line at all is not examined', async () => {
    await bunched();
    const r = await sweepStructuring();
    assert.equal(r.workspacesExamined, 0);
    assert.equal(r.findings, 0);
  });

  test('an ordinary spread under the line produces no finding', async () => {
    await watch(T);
    await amounts([$(500), $(1_200), $(3_000), $(4_100), $(6_500), $(7_000)]);
    const r = await sweepStructuring();
    assert.equal(r.workspacesExamined, 1, 'it must still look');
    assert.equal(r.findings, 0, 'and find nothing');
  });
});

describe('speaking once', () => {
  test('the same finding twice announces once and suppresses the second', async () => {
    await watch(T);
    await subscribe();
    await bunched();

    const first = await sweepStructuring();
    assert.equal(first.announced, 1);

    const second = await sweepStructuring();
    assert.equal(second.findings, 1, 'the shape is still there');
    assert.equal(second.announced, 0, 'but there is nothing new to say');
    assert.equal(second.suppressed, 1);

    assert.equal((await events()).length, 1, 'exactly one event, not two');
  });

  /**
   * The escape hatch from silence. A finding that is getting materially worse
   * has something new to say, and the cooldown must not swallow it.
   */
  test('a materially worse ratio speaks again inside the cooldown', async () => {
    await watch(T);
    await subscribe();
    await amounts(Array(10).fill($(9_800)));
    await amounts([$(8_400), $(8_800), $(7_900), $(6_100), $(5_000)]);
    assert.equal((await sweepStructuring()).announced, 1);

    // Same control band, far more bunching: the ratio grows past ESCALATION.
    await amounts(Array(40).fill($(9_900)));
    const r = await sweepStructuring();
    assert.equal(r.announced, 1, 'a finding that got much worse is worth repeating');
    assert.equal((await events()).length, 2);
  });

  test('a finding older than the cooldown is repeated', async () => {
    await watch(T);
    await subscribe();
    await bunched();
    assert.equal((await sweepStructuring()).announced, 1);

    // Sweep as the clock would see it after the cooldown, rather than by
    // rewriting the stored row — `now` is a parameter for exactly this.
    const later = new Date(Date.now() + (_internals.COOLDOWN_DAYS + 1) * 86_400_000);
    assert.equal((await sweepStructuring(later)).announced, 1);
    assert.equal((await events()).length, 2);
  });

  /**
   * The bug this suite was written to find, kept as a named test so the next
   * person gets a sentence rather than "1 !== 2".
   *
   * enqueueEvent derives its dedupe key from the payload. Every other field the
   * sweep sets is a function of the same counts, so an UNCHANGED finding hashed
   * identically to its last announcement and the delivery was dropped by
   * ON CONFLICT DO NOTHING — while the sweep still updated notified_at and went
   * quiet for another week. The cooldown could never actually speak.
   */
  test('a repeat announcement is distinguishable, or the delivery is deduped away', async () => {
    await watch(T);
    await subscribe();
    await bunched();
    await sweepStructuring();

    const later = new Date(Date.now() + (_internals.COOLDOWN_DAYS + 1) * 86_400_000);
    await sweepStructuring(later);

    const rows = await events();
    assert.equal(rows.length, 2, 'the cooldown re-announcement must reach the subscriber');
    const stamps = rows.map((r) => r.payload.data.announced_at);
    assert.notEqual(stamps[0], stamps[1],
      'two announcements of an identical finding must differ somewhere in the payload, '
      + 'or they collide on the dedupe key and the second is silently dropped');
  });

  test('one day after announcing, it is still quiet', async () => {
    await watch(T);
    await subscribe();
    await bunched();
    await sweepStructuring();

    const tomorrow = new Date(Date.now() + 86_400_000);
    assert.equal((await sweepStructuring(tomorrow)).announced, 0);
    assert.equal((await events()).length, 1);
  });
});

describe('what it says, and what it refuses to say', () => {
  test('the payload carries the counts and explicitly not a verdict', async () => {
    await watch(T);
    await subscribe();
    await bunched();
    await amounts([$(8_400), $(8_800)]);
    await sweepStructuring();

    const [e] = await events();
    const p = e!.payload.data;
    assert.equal(p.effect_type, 'payment.payout');
    assert.equal(p.threshold_micros, T);
    assert.equal(p.just_below, 23);
    assert.equal(p.control, 2);
    assert.equal(p.window_days, _internals.WINDOW_DAYS);
    assert.equal(p.severity, 'high');

    // The note is load-bearing, not decoration. Whoever reads this event is
    // deciding whether to freeze a customer's payouts, and a cap produces the
    // same signature as structuring.
    assert.match(String(p.note), /hint, not a verdict/i);
    assert.match(String(p.note), /intent/i);
  });

  /**
   * The property this feature would be dangerous without.
   *
   * Told they may refund up to $10,000, honest people refund $9,999 — which is
   * exactly the shape above. Refusing on this signal would decline legitimate
   * payments routinely, so the sweep must leave every effect exactly as it
   * found it.
   */
  test('it never enforces: no effect changes state, no policy changes', async () => {
    await watch(T);
    await bunched();

    const snapshot = async () => (await getPool().query(
      `SELECT state, count(*) AS n FROM effects WHERE workspace_id = $1
        GROUP BY state ORDER BY state`, [ws])).rows;
    const policyBefore = (await getPool().query(
      'SELECT * FROM effect_policies WHERE workspace_id = $1', [ws])).rows;

    const before = await snapshot();
    await sweepStructuring();

    assert.deepEqual(await snapshot(), before, 'the sweep must not touch effect state');
    assert.deepEqual(
      (await getPool().query('SELECT * FROM effect_policies WHERE workspace_id = $1', [ws])).rows,
      policyBefore, 'nor tighten the policy it just measured');
  });

  /**
   * Two worker replicas is the supported deployment, and both sweep on the same
   * six-hourly timer. The notice row is claimed FOR UPDATE inside the
   * transaction that writes it precisely so this cannot double-announce.
   */
  test('two sweeps at once still announce exactly once', async () => {
    await watch(T);
    await subscribe();
    await bunched();

    const [a, b] = await Promise.all([sweepStructuring(), sweepStructuring()]);
    assert.equal(a.announced + b.announced, 1,
      'concurrent replicas must not both announce the same finding');
    assert.equal((await events()).length, 1);
  });
});

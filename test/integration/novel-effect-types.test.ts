// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * Noticing an effect type a workspace has never gated.
 *
 * The property that matters is not that it fires — it is that it fires ONCE,
 * and that it does not fire for history. A control that announces every existing
 * effect type the moment it ships is noise, and noise is how a monitor gets
 * muted. Migration 042 backfills everything already present as notified for
 * exactly that reason, and the first test here is the one that would catch the
 * backfill being wrong.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshWorkspace, closePool, getPool } from '../helpers.js';
import { noticeNewEffectTypes } from '../../src/domain/novel-effect-types.js';

const { beginEffect } = await import('../../src/domain/effects.js');

let ws: Awaited<ReturnType<typeof freshWorkspace>>;
before(async () => { ws = await freshWorkspace(); });
after(async () => { await closePool(); });

const gate = (effectType: string, key: string) => beginEffect({
  workspaceId: ws.workspaceId, apiKeyId: ws.key.id, apiKeyPrefix: ws.key.prefix,
  keyDailyBudgetMicros: null, effectType, idempotencyKey: key,
  payload: { k: key }, estimatedCostMicros: 0,
});

/**
 * The sweep is bounded to BATCH types per pass so one call cannot monopolise the
 * worker. The integration suite shares one database, so other files leave a
 * backlog and a single pass may not reach the type this test just created —
 * which is correct behaviour and made the first draft of these tests flaky.
 * Drain, then assert.
 */
const drain = async () => {
  let announced = 0;
  for (let i = 0; i < 20; i += 1) {
    const r = await noticeNewEffectTypes();
    announced += r.announced;
    if (r.discovered === 0) break;
  }
  return announced;
};

const seen = async (effectType: string) => {
  const { rows } = await getPool().query(
    'SELECT notified_at FROM workspace_effect_types WHERE workspace_id = $1 AND effect_type = $2',
    [ws.workspaceId, effectType]);
  return rows[0] as { notified_at: Date } | undefined;
};

describe('an effect type nobody has gated before', () => {
  test('is discovered and recorded', async () => {
    await gate('payment.wire', 'w-1');
    assert.equal(await seen('payment.wire'), undefined, 'not recorded until the sweep runs');

    await drain();
    assert.ok(await seen('payment.wire'), 'the sweep should have recorded it');
  });

  test('is announced exactly once, however often the sweep runs', async () => {
    await gate('payment.wire', 'w-2');
    await gate('payment.wire', 'w-3');

    assert.equal(await drain(), 0,
      'more traffic on a type already recorded is not a discovery');
  });

  test('a genuinely new type is still caught after the first one', async () => {
    await gate('slack.post', 's-1');
    assert.equal(await drain(), 1, 'exactly the new one, and only it');
    assert.ok(await seen('slack.post'));
  });

  /**
   * The ON CONFLICT guard exists for two worker replicas sweeping at the same
   * moment: both read the same undiscovered type, both try to insert, and only
   * the one that wins the primary key may announce.
   *
   * Written because removing that guard broke nothing in the tests above. They
   * pass on the sweep query's filter alone, which single-threaded is enough —
   * so they were proving something weaker than they appeared to, and CLAUDE.md
   * §8 is explicit that a test must be watched to fail before it is trusted.
   */
  test('two replicas sweeping at once announce it once, not twice', async () => {
    await drain();
    await gate('figma.comment', 'f-1');

    const [a, b] = await Promise.all([noticeNewEffectTypes(), noticeNewEffectTypes()]);
    assert.equal(a.announced + b.announced, 1,
      'both replicas saw it; exactly one may say so');

    const { rows } = await getPool().query(
      'SELECT count(*) AS n FROM workspace_effect_types WHERE workspace_id = $1 AND effect_type = $2',
      [ws.workspaceId, 'figma.comment']);
    assert.equal(Number((rows[0] as { n: string }).n), 1, 'and exactly one row exists');
  });

  test('it refuses nothing — the effect was allowed', async () => {
    const r = await gate('notion.page.create', 'n-1');
    assert.equal(r.decision, 'execute',
      'an unconfigured type defaults to allow; deny would break every first integration');
    await drain();
    assert.ok(await seen('notion.page.create'), 'allowed, and noticed');
  });
});

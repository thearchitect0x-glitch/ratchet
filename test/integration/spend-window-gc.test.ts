// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * Retention for spend windows.
 *
 * `spend_windows` was the only windowed table in the schema with no retention
 * at all — `page_feedback_windows`, `provision_windows`, `provision_global` and
 * `run_budgets` all had some — and its rows are write-only once their day ends.
 * One row per workspace, per scope, per day, where "scope" includes an entry
 * per declared dimension VALUE, so the width is not obvious from the schema.
 *
 * The dangerous mistake here is deleting a row somebody is still spending
 * against, so most of what follows is about the boundary rather than the sweep.
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const { setupDb, closePool, getPool } = await import('../helpers.js');
const { gcSpendWindows, SPEND_WINDOW_RETENTION_DAYS, SCOPE_WORKSPACE } =
  await import('../../src/domain/budget.js');
const { createWorkspace } = await import('../../src/domain/auth.js');

let ws: string;
before(async () => {
  await setupDb();
  ws = (await createWorkspace('gc', `gc-${Date.now()}@example.test`)).workspaceId;
});
after(async () => { await closePool(); });
beforeEach(async () => {
  await getPool().query('DELETE FROM spend_windows WHERE workspace_id = $1', [ws]);
});

/** A window `daysAgo` before today's UTC date, with a distinguishable amount. */
const seed = (daysAgo: number, scope = SCOPE_WORKSPACE, micros = 1_000) =>
  getPool().query(
    `INSERT INTO spend_windows (workspace_id, scope, day, spent_micros)
     VALUES ($1, $2, (now() AT TIME ZONE 'utc')::date - make_interval(days => $3), $4)
     ON CONFLICT (workspace_id, scope, day) DO UPDATE SET spent_micros = EXCLUDED.spent_micros`,
    [ws, scope, daysAgo, micros]);

const daysPresent = async (): Promise<number[]> => {
  const { rows } = await getPool().query<{ age: string }>(
    `SELECT ((now() AT TIME ZONE 'utc')::date - day) AS age
       FROM spend_windows WHERE workspace_id = $1 ORDER BY age`, [ws]);
  return rows.map((r) => Number(r.age));
};

describe('spend window retention', () => {
  test('the retention horizon is a stated constant, not a literal in a query', () => {
    assert.equal(typeof SPEND_WINDOW_RETENTION_DAYS, 'number');
    assert.ok(SPEND_WINDOW_RETENTION_DAYS >= 1);
  });

  /**
   * The failure that matters. Deleting the current day's row loses spend
   * already reserved against a live ceiling, which would let a workspace spend
   * its whole budget a second time — the same defect as issue #15, arrived at
   * from the other direction.
   */
  test("today's row is never taken, however old the horizon", async () => {
    await seed(0);
    await gcSpendWindows();
    assert.deepEqual(await daysPresent(), [0], "today's window was deleted");
  });

  test('yesterday survives too — the horizon is days, not one day', async () => {
    await seed(0);
    await seed(1);
    await gcSpendWindows();
    assert.deepEqual(await daysPresent(), [0, 1]);
  });

  /**
   * The boundary, asserted from both sides. A `<` written where `<=` belongs
   * costs exactly one day of history, and nothing else in the suite would say so.
   */
  test('the day at the horizon stays and the day past it goes', async () => {
    const R = SPEND_WINDOW_RETENTION_DAYS;
    await seed(R);       // exactly at the horizon
    await seed(R + 1);   // one day past it
    const removed = await gcSpendWindows();

    assert.equal(removed, 1, 'exactly one row should have been collected');
    assert.deepEqual(await daysPresent(), [R],
      `the row at exactly ${R} days must survive; only older ones go`);
  });

  test('it reports how many it collected, so the sweep total means something', async () => {
    const R = SPEND_WINDOW_RETENTION_DAYS;
    await seed(R + 1, SCOPE_WORKSPACE);
    await seed(R + 2, 'key:k1');
    await seed(R + 3, 'type:payment.charge');
    await seed(0);
    assert.equal(await gcSpendWindows(), 3);
    assert.deepEqual(await daysPresent(), [0]);
  });

  test('a sweep with nothing to do removes nothing and does not fail', async () => {
    await seed(0);
    assert.equal(await gcSpendWindows(), 0);
    assert.equal(await gcSpendWindows(), 0);
    assert.deepEqual(await daysPresent(), [0]);
  });

  /**
   * Every scope shares the horizon. Dimension scopes are where the row count
   * actually grows — one per declared VALUE, not one per dimension — so a GC
   * that only collected the three fixed scopes would leave the wide part behind.
   */
  test('dimension scopes are collected like any other', async () => {
    const R = SPEND_WINDOW_RETENTION_DAYS;
    for (let i = 0; i < 5; i += 1) await seed(R + 1, `dim:counterparty:${i}`);
    assert.equal(await gcSpendWindows(), 5);
    assert.deepEqual(await daysPresent(), []);
  });
});

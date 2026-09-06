// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * /workerz — the endpoint an uptime monitor watches.
 *
 * Separate from /readyz on purpose: /readyz decides whether this API machine
 * receives traffic, and a stalled worker must never take the control plane
 * offline. The gate works perfectly without a worker; it just stops expiring
 * leases, which is invisible until someone retries and is told `in_flight`
 * for ever.
 */
import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../../src/api/app.js';
import { setupDb, getPool, closePool } from '../helpers.js';
import { recordOk } from '../../src/worker/heartbeat.js';

describe('worker liveness endpoint', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  before(async () => { await setupDb(); app = await buildApp({ logger: false }); await app.ready(); });
  after(async () => { await app.close(); await closePool(); });
  beforeEach(async () => { await getPool().query('DELETE FROM worker_heartbeats'); });

  const workerz = () => app.inject({ method: 'GET', url: '/workerz' });

  test('needs no credential, so a monitor can watch it', async () => {
    const r = await workerz();
    assert.notEqual(r.statusCode, 401);
    assert.notEqual(r.statusCode, 403);
  });

  test('a worker that never started is 503, and says so distinctly', async () => {
    const r = await workerz();
    assert.equal(r.statusCode, 503);
    assert.equal(JSON.parse(r.payload).status, 'never_started');
  });

  test('a healthy worker is 200', async () => {
    await recordOk(`e2e-fresh-${Date.now()}`, 'i-1', 2000);
    const r = await workerz();
    assert.equal(r.statusCode, 200);
    assert.equal(JSON.parse(r.payload).status, 'ok');
  });

  /**
   * The uptime probe branches on this word, so it is a contract. A replica that
   * has stopped applying WAL is invisible from every other public surface —
   * that is how one stayed frozen for 37 minutes.
   */
  test('replication health is reported alongside a healthy worker', async () => {
    await recordOk('replication-watch', 'i-1', 60_000, getPool(),
      'replica standby_a is 400.0 MB behind');
    const r = await workerz();

    // Still 200: leases are expiring and the gate is correct. Failing here
    // would invite a restart of the one process that cannot fix a database.
    assert.equal(r.statusCode, 200);
    const body = JSON.parse(r.payload);
    assert.equal(body.status, 'ok');
    assert.equal(body.replication, 'degraded');

    // The repository is public and this endpoint takes no credential, so the
    // word travels and the detail stays in the worker's logs.
    assert.equal(r.payload.includes('standby_a'), false);
    assert.equal(r.payload.includes('400.0'), false);
  });

  test('a clean replication check reports ok', async () => {
    await recordOk('replication-watch', 'i-1', 60_000, getPool());
    const r = await workerz();
    assert.equal(JSON.parse(r.payload).replication, 'ok');
  });

  /**
   * The failure mode that would quietly undo all of this: the watcher not
   * running at all looks exactly like a healthy cluster unless it is said.
   */
  test('a missing watcher is "unobserved", never "ok"', async () => {
    await getPool().query(
      `DELETE FROM worker_heartbeats WHERE loop_name = 'replication-watch'`);
    await recordOk(`e2e-other-${Date.now()}`, 'i-1', 2000);
    const r = await workerz();
    assert.equal(r.statusCode, 200);
    assert.equal(JSON.parse(r.payload).replication, 'unobserved');
  });

  test('a stalled loop is 503 and names the loop', async () => {
    const loop = `e2e-stalled-${Date.now()}`;
    await recordOk(loop, 'i-1', 2000);
    await getPool().query(
      `UPDATE worker_heartbeats SET last_ok_at = now() - interval '1 hour'`);
    const r = await workerz();
    assert.equal(r.statusCode, 503);
    const body = JSON.parse(r.payload);
    assert.equal(body.status, 'stalled');
    assert.deepEqual(body.stalled_loops, [loop]);
    assert.match(body.detail, /leases may not be expiring/i);
  });

  test('a stalled worker does NOT take the control plane down', async () => {
    // The gate keeps working without a worker. Coupling them would turn a
    // recoverable stall into an outage.
    await recordOk(`e2e-down-${Date.now()}`, 'i-1', 2000);
    await getPool().query(
      `UPDATE worker_heartbeats SET last_ok_at = now() - interval '1 hour'`);
    assert.equal((await workerz()).statusCode, 503);
    assert.equal((await app.inject({ method: 'GET', url: '/readyz' })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: '/healthz' })).statusCode, 200);
  });

  test('it leaks no instance identifiers', async () => {
    await recordOk(`e2e-leak-${Date.now()}`, 'super-secret-machine-id', 2000);
    const r = await workerz();
    assert.doesNotMatch(r.payload, /super-secret-machine-id/);
  });

  /**
   * Provisioning pressure, and the one thing this endpoint must not say.
   *
   * The keyless `begin` is what lets an agent that found Ratchet on its own
   * use it, and it is the only place a stranger gets something of value
   * without presenting anything. The global ceiling is what makes that
   * affordable. When it is spent, keyless provisioning refuses everyone for
   * the rest of the hour while the API, the worker, the database and the mail
   * queue all report themselves perfectly healthy — so this word is the only
   * public evidence the signup path is down.
   */
  describe('provisioning pressure', () => {
    /*
     * test/helpers.ts raises this ceiling to 100000 so that the suite is never
     * throttled by the feature it is exercising. That is right for every other
     * test and fatal for these, which are ABOUT the ceiling — at 100000 a count
     * of 200 is healthy, and the first draft of this block asserted `elevated`
     * against a perfectly correct `ok`. config reads the variable through a
     * getter for exactly this reason, so setting it here takes effect live.
     */
    const CEILING = 250;
    let previous: string | undefined;
    before(() => {
      previous = process.env.PROVISION_GLOBAL_PER_HOUR;
      process.env.PROVISION_GLOBAL_PER_HOUR = String(CEILING);
    });
    after(() => { process.env.PROVISION_GLOBAL_PER_HOUR = previous; });

    const hour = () => new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000);
    const setGlobal = (count: number) => getPool().query(
      `INSERT INTO provision_global (hour_start, count) VALUES ($1, $2)
       ON CONFLICT (hour_start) DO UPDATE SET count = EXCLUDED.count`,
      [hour(), count]);

    beforeEach(async () => {
      await getPool().query('DELETE FROM provision_global');
      await recordOk(`e2e-prov-${Date.now()}`, 'i-1', 2000);
    });

    test('reads ok while there is headroom', async () => {
      await setGlobal(1);
      assert.equal(JSON.parse((await workerz()).payload).provisioning, 'ok');
    });

    test('warns before the door shuts, not as it shuts', async () => {
      // 80% of the default 250. An alert that arrives WITH the outage is a
      // report; the whole value of this one is the fifty slots still left.
      await setGlobal(200);
      assert.equal(JSON.parse((await workerz()).payload).provisioning, 'elevated');
    });

    test('at the ceiling, and still 200 — containment is not worker death', async () => {
      await setGlobal(250);
      const r = await workerz();
      // Not 503. Leases are expiring, the gate is correct, and every keyed
      // request is completely unaffected. A 503 here would invite the platform
      // to restart a worker that is doing exactly what it should.
      assert.equal(r.statusCode, 200);
      assert.equal(JSON.parse(r.payload).provisioning, 'at_ceiling');
    });

    /**
     * The security property, and the reason this is a word rather than a gauge.
     *
     * This endpoint is public and takes no credential. The count and the
     * ceiling together tell an unauthenticated stranger exactly how many more
     * requests would shut the keyless door on everybody — that is not a status,
     * it is a recipe. Publishing the state costs nothing; publishing the
     * distance to it hands over the attack's only unknown.
     */
    test('never publishes the count, the ceiling, or the distance between them', async () => {
      await setGlobal(200);
      const body = JSON.parse((await workerz()).payload);
      assert.equal(body.provisioning, 'elevated');

      // Assert over the whole payload, not named fields: a future field that
      // carries the number is exactly what this test exists to catch, and it
      // will not be called `thisHour`.
      const numbers: string[] = JSON.stringify(body).match(/\d+/g) ?? [];
      for (const forbidden of ['200', '250', '50']) {
        assert.ok(!numbers.includes(forbidden),
          `/workerz leaked ${forbidden}; provisioning headroom must not be public`);
      }
    });
  });
});

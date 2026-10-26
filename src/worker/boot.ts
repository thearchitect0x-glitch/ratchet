// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * The worker waits for the database instead of exiting.
 *
 * On 16 Oct 2026 the Postgres cluster failed over. For the seconds the switch
 * took, the worker's first query failed with "Connection terminated
 * unexpectedly", the process exited 1, Fly restarted it, and it failed again —
 * ten times in about two minutes, which is Fly's restart limit. Then Fly left it
 * stopped. The database was healthy again almost at once; the worker stayed
 * down for twelve and a half hours, and leases stopped expiring for all of it.
 *
 * A worker that cannot reach its database can do nothing useful, but exiting is
 * worse than waiting: the platform's patience is finite and a failover's is not
 * known. So it waits — forever, loudly, with a capped backoff — and `/workerz`
 * goes stale while it does, which is what pages someone.
 */

export interface WaitOptions {
  log: (level: string, msg: string, extra?: Record<string, unknown>) => void;
  sleep?: (ms: number) => Promise<void>;
  isRunning?: () => boolean;
  initialDelayMs?: number;
  maxDelayMs?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Resolves once `probe` succeeds. Never rejects while the process is running. */
export async function waitForDatabase(probe: () => Promise<unknown>, o: WaitOptions): Promise<number> {
  const sleep = o.sleep ?? defaultSleep;
  const running = o.isRunning ?? (() => true);
  const max = o.maxDelayMs ?? 30_000;
  let delay = o.initialDelayMs ?? 1_000;
  for (let attempt = 1; ; attempt++) {
    try {
      await probe();
      if (attempt > 1) o.log('info', 'database reachable again', { attempts: attempt });
      return attempt;
    } catch (err) {
      if (!running()) throw err;
      o.log('error', 'database unreachable at start — waiting, not exiting', {
        attempt, retryInMs: delay, err: (err as Error).message,
      });
      await sleep(delay);
      delay = Math.min(delay * 2, max);
    }
  }
}

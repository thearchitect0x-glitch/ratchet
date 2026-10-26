# Incident: a database failover stopped the worker for twelve and a half hours

**Date:** 16 Oct 2026 ~19:40 UTC to 17 Oct 2026 08:21 UTC
**Severity:** background work stopped. The control plane kept answering. **No data lost and no customer affected.**
**Cause:** the worker exited when its first query failed during a Postgres failover, and Fly stopped restarting it after 10 attempts.

---

## What happened

The cluster failed over from `6835447a474308` to `683d492c257308`. For the seconds the switch
took, the worker's startup query (`SELECT 1`) failed with `Connection terminated unexpectedly`.
`main()` rejected, the process exited 1, and Fly restarted it. It did that ten times in about
two minutes, which is Fly's restart limit:

```
machine has reached its max restart count of 10
```

The database was healthy again almost immediately. The worker stayed stopped.

The second worker, `d8d2e56a057758`, could not take over. It had been stopped since a Fly host
migration on 9 Oct (`migrated=true`, then `stopped / update`). Every check stayed green for
those eight days because `worker_heartbeats` is keyed by loop, not by process. One healthy
worker and two healthy workers write identical rows.

The failover also left the cluster at two nodes, one primary and one standby. One more failure
would have cost quorum.

## Impact

`beginEffect` expires a lapsed lease inline under the row lock, so decisions stayed correct (see
KNOWN_LIMITATIONS §6). What stopped was the timely work: sweeping leases nobody asked about again,
webhook delivery, email alerts, receipt chaining, and GC. The only effects touched during the
window were `uptime.probe`. No webhooks were pending.

The uptime probe failed from 19:44 onward and the alert fired. An operator noticed at 08:20.

## Recovery

1. `flyctl machine start` on both workers. `/workerz` reported 16 loops.
2. `flyctl machine clone 2872d0ea562478` to restore a third node. `repmgr.nodes`: one primary
   and two active standbys. `/workerz` replication returned to `ok`.
3. A manual uptime run passed every check, including begin → replay → report.

4. **The old primary was cleaned up the same night.** `6835447a` had been demoted to a standby.
   Its Postgres was stopped, and it was no longer a repmgr member, but its machine was still
   running. Its slot `repmgr_slot_1159710080` kept `/workerz` at `replication: degraded`.
   `pg_controldata` showed it `shut down in recovery` at `101/1000028`, which is 40 bytes past the
   timeline-5 fork at `101/1000000`: its own shutdown checkpoint, nothing more. It held no writes
   the new primary lacked. Its volume was snapshotted (`vs_K3K67jajeJDfZqvNagDDQKZ`, 5-day
   retention). Then the machine and volume were destroyed and the orphan slot dropped. The result
   was one primary, two active slots, and `replication: ok`.

**Why the primary failed at 19:44 is not known.** Its exit was `exit_code=2, oom_killed=false`,
and Fly's log retention had dropped the lines that would say more by the time anyone looked.
Disk was at 4%. This is the third primary loss since 1 Sep (see the 1 Sep and 2 Sep incidents),
all on `shared-cpu-1x` in one region. If it happens again, capture `flyctl logs` within the
hour.

## What changed

- **The worker waits for the database instead of exiting** (`src/worker/boot.ts`). It retries
  indefinitely with a backoff capped at 30 s. Any fixed limit would be a guess at how long a
  failover lasts. While it waits, `/workerz` goes stale and the probe pages.
- **Live workers are counted.** Each worker upserts `worker_instances` every 30 s. `/workerz`
  reports `workers: ok | degraded | unchecked` against `EXPECTED_WORKERS` (2 in `fly.toml`).
  The uptime probe fails on `degraded`.

## Not done

- A worker stopped by the platform for any *other* reason (host migration, a manual stop) is
  now detected, but it is not restarted automatically. Someone still runs `flyctl machine start`.

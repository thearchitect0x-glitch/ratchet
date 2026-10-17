-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Deimos AI LLC
--
-- One row per worker process that is alive, refreshed every 30 seconds.
--
-- worker_heartbeats is keyed by loop, so two healthy workers and one healthy
-- worker look identical there. That is how a second worker sat stopped for
-- eight days in October 2026 with every check green: redundancy was gone and
-- nothing could say so. This table lets /workerz count live workers against
-- EXPECTED_WORKERS, the same way replication is counted against EXPECTED_REPLICAS.
CREATE TABLE IF NOT EXISTS worker_instances (
  instance     text        PRIMARY KEY,
  started_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Deimos AI LLC
--
-- The structuring analysis has existed since migration 035 and nothing has ever
-- run it. It is reachable at GET /v1/analysis/structuring, which means it runs
-- when somebody is already suspicious — the same failure reconciliation had, and
-- for the same reason: nobody schedules the check they reach for when alarmed.
--
-- This table is what lets a sweep announce a finding once rather than once per
-- pass. The ratio and severity are kept alongside the timestamp so a finding
-- that gets materially worse can speak again, while one that merely persists
-- stays quiet. A monitor that repeats itself gets muted, and a muted monitor is
-- indistinguishable from one that was never built.
CREATE TABLE structuring_notices (
  workspace_id TEXT        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  effect_type  TEXT        NOT NULL,
  notified_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- The excess ratio at the moment of the notice, so escalation is detectable.
  ratio        NUMERIC     NOT NULL,
  severity     TEXT        NOT NULL CHECK (severity IN ('medium', 'high')),
  PRIMARY KEY (workspace_id, effect_type)
);

COMMENT ON TABLE structuring_notices IS
  'One row per (workspace, effect type) that has been told about bunching. Holds the ratio at notice time so an escalation re-announces and a steady state does not.';

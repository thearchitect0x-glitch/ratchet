-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Deimos AI LLC
--
-- Which effect types has this workspace ever gated?
--
-- Nothing knew. `first_begin` is an activation milestone — it fires once per
-- workspace, the first time Ratchet is used at all — and `getPolicy` returns
-- DEFAULT_POLICY with mode 'allow' for any effect type with no row, without
-- inserting one. So an agent could gate `payment.wire` in a workspace that had
-- only ever gated `payment.charge`, be allowed by default, and nobody was told.
--
-- The assurance case names a compromised agent holding a valid key as the
-- PRIMARY adversary. An agent doing something categorically new is the highest
-- signal that adversary produces, and it was the one thing nothing watched for.
--
-- This is a record, not a gate. It does not refuse anything: defaulting new
-- types to deny would break every legitimate first integration, which is
-- precisely why the default is allow. It notices.
CREATE TABLE workspace_effect_types (
  workspace_id  TEXT        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  effect_type   TEXT        NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL,
  -- Null until announced. Separate from first_seen_at because a backfilled row
  -- must never announce: everything that already exists is not news.
  notified_at   TIMESTAMPTZ,
  PRIMARY KEY (workspace_id, effect_type)
);

-- Everything present today is history, not a discovery. Backfilled as already
-- notified so the first sweep after this migration announces nothing.
INSERT INTO workspace_effect_types (workspace_id, effect_type, first_seen_at, notified_at)
SELECT workspace_id, effect_type, min(created_at), now()
  FROM effects
 GROUP BY workspace_id, effect_type
ON CONFLICT DO NOTHING;

-- Configured types are equally not news: an operator who wrote a policy for a
-- type already knows it exists.
INSERT INTO workspace_effect_types (workspace_id, effect_type, first_seen_at, notified_at)
SELECT workspace_id, effect_type, now(), now()
  FROM effect_policies
ON CONFLICT DO NOTHING;

COMMENT ON TABLE workspace_effect_types IS
  'Every effect type a workspace has ever gated, with when it was first seen and when that was announced. Populated by the worker, never on the begin path.';

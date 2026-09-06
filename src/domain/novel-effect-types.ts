// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * The first time a workspace gates something it has never gated before.
 *
 * `getPolicy` returns DEFAULT_POLICY with mode 'allow' for any effect type with
 * no configured row, and does not insert one. `first_begin` is an activation
 * milestone that fires once per workspace, not once per type. So an agent could
 * gate `payment.wire` in a workspace that had only ever gated `payment.charge`,
 * be allowed by default, and nothing anywhere would say so.
 *
 * ASSURANCE_CASE.md names a compromised agent holding a valid key as the primary
 * adversary. Such an agent doing something *categorically new* is the highest
 * signal it produces — higher than an unusual amount, which could be a busy
 * Tuesday, and higher than a velocity spike, which could be a backfill. A type
 * that has never appeared before is either a legitimate new integration, which
 * an operator knows about, or it is not, and either way they should be told.
 *
 * THIS REFUSES NOTHING. Defaulting an unseen type to deny would break every
 * legitimate first integration, which is exactly why the default is allow. The
 * control is notice, not prevention — the same shape as reconciliation and the
 * structuring sweep, and for the same reason: what Ratchet uniquely has is the
 * record, and the record's job is to say what changed.
 *
 * IT RUNS IN THE WORKER, NOT ON `begin`. An insert there would put a new table
 * inside the transaction that creates an effect, and CLAUDE.md §7 fixes the lock
 * order at workspaces -> effects -> spend_windows because two deadlocks were
 * found the hard way. A security notice is worth minutes of latency; it is not
 * worth a fourth lock in the hot path.
 */
import { withTx, getPool, type Db } from '../db/pool.js';
import { enqueueEvent } from './events.js';

/** Types discovered per sweep. Bounded so one pass cannot monopolise the worker. */
const BATCH = 100;

export interface NoveltyResult {
  discovered: number;
  announced: number;
}

/**
 * Records effect types this workspace has not gated before, and announces them.
 *
 * Discovery and announcement are one transaction per type so a crash between
 * them cannot lose the notice: an unannounced row keeps `notified_at` null and
 * the next sweep picks it up.
 */
export async function noticeNewEffectTypes(now = new Date()): Promise<NoveltyResult> {
  const pool = getPool();
  const out: NoveltyResult = { discovered: 0, announced: 0 };

  // Types present in traffic with no row yet. Traffic first, exactly as
  // coverage() does — a type nobody configured is the case this exists for.
  const { rows } = await pool.query<{ workspace_id: string; effect_type: string; first_at: Date }>(
    `SELECT e.workspace_id, e.effect_type, min(e.created_at) AS first_at
       FROM effects e
       LEFT JOIN workspace_effect_types t
         ON t.workspace_id = e.workspace_id AND t.effect_type = e.effect_type
      WHERE t.effect_type IS NULL
      GROUP BY e.workspace_id, e.effect_type
      ORDER BY min(e.created_at)
      LIMIT $1`,
    [BATCH],
  );

  for (const r of rows) {
    const announced = await recordAndAnnounce(r.workspace_id, r.effect_type, r.first_at, now);
    out.discovered += 1;
    if (announced) out.announced += 1;
  }
  return out;
}

async function recordAndAnnounce(
  workspaceId: string, effectType: string, firstAt: Date, now: Date,
): Promise<boolean> {
  return withTx(async (tx) => {
    // SKIP LOCKED via the insert itself: whichever replica wins the primary key
    // announces, the other sees a conflict and does nothing.
    const { rowCount } = await tx.query(
      `INSERT INTO workspace_effect_types (workspace_id, effect_type, first_seen_at, notified_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (workspace_id, effect_type) DO NOTHING`,
      [workspaceId, effectType, firstAt.toISOString(), now.toISOString()],
    );
    if (!rowCount) return false;

    // How many types this workspace already had. One is a first integration;
    // the fortieth in a workspace that has used three is a different story, and
    // an operator reads those very differently.
    const { rows: [counted] } = await tx.query<{ n: string }>(
      'SELECT count(*) AS n FROM workspace_effect_types WHERE workspace_id = $1',
      [workspaceId],
    );

    await enqueueEvent(tx, workspaceId, 'effect_type.first_seen', {
      effect_type: effectType,
      first_seen_at: firstAt.toISOString(),
      known_effect_types: Number(counted?.n ?? 1),
      configured: false,
      note: 'This workspace has never gated this effect type before. It was allowed, '
        + 'because an unconfigured type defaults to allow — refusing would break every '
        + 'legitimate first integration. If you did not expect it, the key that sent it '
        + 'is doing something new.',
    });
    return true;
  });
}

export const _internals = { BATCH };

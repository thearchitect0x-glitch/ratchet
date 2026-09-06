// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * Matching what the vendor holds, not what the caller sent.
 *
 * Reconciliation compares the caller's idempotency keys against ours. But when
 * a caller uses vendor-enforced idempotency, the key the *vendor* recorded is
 * `rtk_<hmac>` — the one Ratchet derived and handed back — not the caller's own.
 * Pull those from Stripe, post them to /v1/reconcile, and every single one
 * reports ungated on a perfectly gated workspace.
 *
 * That is worse than shipping nothing. A control that cries wolf gets muted, and
 * a muted control is indistinguishable from one that was never built.
 *
 * WHY THIS DERIVES RATHER THAN STORES. The derived key could live in a column
 * on `effects`, populated at begin. That would put a write on the hot path, and
 * CLAUDE.md §7 fixes the lock order at workspaces -> effects -> spend_windows
 * because two deadlocks were found there the hard way. It would also persist
 * something entirely derivable. So it is computed on read: the reconcile path
 * already knows the workspace and the effect type, and HMAC-SHA256 costs
 * roughly a microsecond.
 *
 * The customer can never do this themselves, and that is deliberate: derivation
 * needs AUTH_SECRET. The adapter they run holds their vendor credential and none
 * of ours.
 *
 * WHAT IT REFUSES TO GUESS. The candidate set is bounded, and if the bound is
 * reached the caller is told rather than handed a confidently wrong answer. An
 * unexamined effect is not an ungated one, and reporting it as ungated would be
 * the same lie as resolving an expired lease to `succeeded`.
 */
import type { Db } from '../db/pool.js';
import { vendorIdempotencyKey } from './vendor-keys.js';

/** Effects examined per call. Beyond this the answer is reported as partial. */
export const MAX_CANDIDATES = 50_000;
/** How far back candidates are drawn from, unless the caller narrows it. */
export const DEFAULT_WINDOW_DAYS = 30;

export interface VendorKeyMatch {
  /** Posted vendor key -> the caller's idempotency key and the effect's state. */
  matched: Map<string, { idempotencyKey: string; state: string }>;
  /** True when the candidate cap was reached, so "ungated" is not a safe reading. */
  truncated: boolean;
  examinedEffects: number;
}

/**
 * Builds the derived-key index for a workspace and effect type, then matches.
 *
 * Every attempt an effect has made is derived, not just the current one: a
 * vendor holds the key from whichever attempt actually reached it, and an
 * earlier attempt's key is exactly as much evidence of gating as the latest.
 */
export async function matchVendorKeys(
  db: Db,
  workspaceId: string,
  effectType: string,
  postedKeys: string[],
  opts: { windowDays?: number; vendor?: string } = {},
): Promise<VendorKeyMatch> {
  const windowDays = Math.min(Math.max(opts.windowDays ?? DEFAULT_WINDOW_DAYS, 1), 400);
  const wanted = new Set(postedKeys);

  const { rows } = await db.query<{ idempotency_key: string; state: string; attempt: number }>(
    `SELECT idempotency_key, state, attempt
       FROM effects
      WHERE workspace_id = $1
        AND effect_type = $2
        AND created_at >= now() - make_interval(days => $3)
      ORDER BY created_at DESC
      LIMIT $4`,
    [workspaceId, effectType, windowDays, MAX_CANDIDATES + 1],
  );

  const truncated = rows.length > MAX_CANDIDATES;
  const candidates = truncated ? rows.slice(0, MAX_CANDIDATES) : rows;

  const matched = new Map<string, { idempotencyKey: string; state: string }>();
  for (const row of candidates) {
    for (let attempt = 1; attempt <= row.attempt; attempt += 1) {
      const { key } = vendorIdempotencyKey({
        workspaceId, effectType, idempotencyKey: row.idempotency_key, attempt,
        ...(opts.vendor ? { vendor: opts.vendor } : {}),
      });
      if (wanted.has(key)) {
        matched.set(key, { idempotencyKey: row.idempotency_key, state: row.state });
      }
    }
  }

  return { matched, truncated, examinedEffects: candidates.length };
}

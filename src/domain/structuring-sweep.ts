// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * Running the analysis nobody runs.
 *
 * `structuringReport` has existed since migration 035 and is reachable at
 * GET /v1/analysis/structuring. Nothing has ever called it on a schedule, which
 * means it runs when an operator is already suspicious — and the whole value of
 * a bunching comparison is that it sees the pattern *before* anyone suspects
 * anything. An analysis nobody runs is an analysis that does not exist.
 *
 * This is the same failure reconciliation had, fixed the same way: schedule the
 * asking. Ratchet already holds every amount an agent proposed next to the line
 * it was proposed against — nobody else has both halves — so the only thing
 * missing was the calendar.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. It does not enforce. The estimator cannot
 * separate structuring from an ordinary cap: told they may refund up to $10,000,
 * people refund $9,999, and that produces the same signature. Refusing on this
 * signal would decline legitimate payments routinely, and `structuring.ts` says
 * so in its own header. This emits a finding for a human. It is a hint, and
 * turning a hint into a refusal is how a good control becomes an outage.
 *
 * SPEAKING ONCE. A finding is announced once per (workspace, effect type), and
 * again only if it gets materially worse — severity escalating, or the excess
 * ratio growing by at least ESCALATION. A steady finding stays quiet until
 * COOLDOWN_DAYS have passed. A monitor that repeats itself gets muted, and a
 * muted monitor is indistinguishable from one that was never built.
 */
import { withTx, getPool, type Db } from '../db/pool.js';
import { enqueueEvent } from './events.js';
import { structuringReport } from './structuring.js';

/** Days of history each sweep measures over. */
const WINDOW_DAYS = 30;
/** Re-announce an unchanged finding no more often than this. */
const COOLDOWN_DAYS = 7;
/** A ratio must grow by this multiple to count as materially worse. */
const ESCALATION = 1.5;
/** Workspaces per sweep. Bounded so one pass cannot monopolise the worker. */
const BATCH = 50;

export interface SweepResult {
  workspacesExamined: number;
  findings: number;
  announced: number;
  /** Findings held back because they were already announced and have not worsened. */
  suppressed: number;
}

/**
 * Workspaces worth measuring: those with a line to measure against. A workspace
 * with no configured threshold has nothing to bunch below, and reporting it as
 * clean would be the same lie as reporting 100% coverage on a type nobody has
 * ever reconciled.
 */
async function candidates(db: Db): Promise<string[]> {
  const { rows } = await db.query<{ workspace_id: string }>(
    `SELECT DISTINCT p.workspace_id
       FROM effect_policies p
       JOIN workspaces w ON w.id = p.workspace_id
      WHERE p.structuring_threshold_micros IS NOT NULL
         OR p.max_cost_micros IS NOT NULL
      ORDER BY p.workspace_id
      LIMIT $1`,
    [BATCH],
  );
  return rows.map((r) => r.workspace_id);
}

export async function sweepStructuring(now = new Date()): Promise<SweepResult> {
  const pool = getPool();
  const workspaces = await candidates(pool);
  const out: SweepResult = {
    workspacesExamined: workspaces.length, findings: 0, announced: 0, suppressed: 0,
  };

  for (const workspaceId of workspaces) {
    const report = await structuringReport(pool, workspaceId, WINDOW_DAYS);
    out.findings += report.findings.length;

    for (const f of report.findings) {
      const announced = await announceOnce(workspaceId, f, now);
      if (announced) out.announced += 1;
      else out.suppressed += 1;
    }
  }
  return out;
}

/**
 * Emits at most one event, and only when it has something new to say.
 *
 * The row is claimed FOR UPDATE inside the transaction that writes it, so two
 * worker replicas sweeping at once cannot both announce the same finding.
 */
async function announceOnce(
  workspaceId: string,
  f: Awaited<ReturnType<typeof structuringReport>>['findings'][number],
  now: Date,
): Promise<boolean> {
  return withTx(async (tx) => {
    const { rows: [prior] } = await tx.query<{ ratio: string; severity: string; notified_at: Date }>(
      `SELECT ratio, severity, notified_at FROM structuring_notices
        WHERE workspace_id = $1 AND effect_type = $2
        FOR UPDATE`,
      [workspaceId, f.effectType],
    );

    if (prior) {
      const worseSeverity = prior.severity === 'medium' && f.severity === 'high';
      const worseRatio = f.excessRatio >= Number(prior.ratio) * ESCALATION;
      const stale = prior.notified_at.getTime()
        < now.getTime() - COOLDOWN_DAYS * 86_400_000;
      if (!worseSeverity && !worseRatio && !stale) return false;
    }

    await tx.query(
      `INSERT INTO structuring_notices (workspace_id, effect_type, notified_at, ratio, severity)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (workspace_id, effect_type)
       DO UPDATE SET notified_at = EXCLUDED.notified_at,
                     ratio = EXCLUDED.ratio,
                     severity = EXCLUDED.severity`,
      [workspaceId, f.effectType, now.toISOString(), f.excessRatio, f.severity],
    );

    // The payload carries the counts, not a verdict. `concentrated_in` is the
    // part an operator acts on: bunching spread across many destinations is
    // usually a cap, bunching at one destination is the shape worth opening.
    await enqueueEvent(tx, workspaceId, 'structuring.detected', {
      effect_type: f.effectType,
      threshold_micros: f.thresholdMicros,
      threshold_source: f.thresholdSource,
      window_days: WINDOW_DAYS,
      examined: f.examined,
      just_below: f.justBelow,
      control: f.control,
      excess_ratio: f.excessRatio,
      severity: f.severity,
      concentrated_in: f.concentratedIn,
      detail: f.detail,
      note: 'A hint, not a verdict. A cap produces the same shape as structuring; '
        + 'what separates them is intent, which this cannot see.',
    });
    return true;
  });
}

export const _internals = { WINDOW_DAYS, COOLDOWN_DAYS, ESCALATION, BATCH };

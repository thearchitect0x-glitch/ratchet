// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * The loop: ask the vendor what happened, ask Ratchet what it authorised,
 * report the difference.
 *
 * WHERE THIS RUNS. In the customer's infrastructure, holding the customer's
 * vendor credential, pushing to us. Ratchet never holds a vendor credential and
 * never makes an outbound call into a customer system — that boundary is the
 * product's main safety property and this adapter exists in this shape
 * specifically so that reconciliation does not erode it.
 *
 * WHY IT EXISTS. `structuringReport` had the same problem and it is worth
 * stating twice: nobody schedules the check they reach for when already
 * alarmed. POST /v1/reconcile has been available for days and running it meant
 * hand-pulling vendor records and deriving keys, which is real per-vendor
 * engineering, so it did not happen. A control that runs approximately never is
 * indistinguishable from one that does not exist.
 */

export const MAX_KEYS_PER_CALL = 1000;   // the endpoint's own limit
export const CALLS_PER_HOUR = 60;        // the endpoint's own rate limit

export const EXIT = {
  CLEAN: 0,
  UNGATED: 1,
  USAGE: 2,
  /**
   * Inconclusive, and deliberately not 0 or 1.
   *
   * The endpoint answers `partial: true` when it hit its candidate limit, which
   * means an unmatched key may belong to an effect it never examined. Exiting 0
   * would report "all clear" from an incomplete comparison; exiting 1 would
   * accuse code paths that may be perfectly gated. Neither is true, so this
   * says so and lets the cron decide. It is the same refusal the gate makes
   * when a lease expires unreported.
   */
  INCONCLUSIVE: 3,
};

const chunk = (xs, n) => {
  const out = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
};

/**
 * Post one batch of keys.
 *
 * THIS RECORDS A RUN. Every call to /v1/reconcile writes a reconciliation run,
 * which is what resets the cadence clock and stops the scheduler asking for a
 * check that just happened. That is correct for a real check and wrong for a
 * rehearsal, which is why dry-run never reaches this function rather than
 * passing it a flag — a flag is something a future edit can thread past.
 */
async function postBatch({ baseUrl, apiKey, effectType, keys, keySpace, vendor, windowDays, fetchImpl }) {
  const res = await fetchImpl(`${baseUrl}/v1/reconcile`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify({
      effect_type: effectType,
      keys,
      key_space: keySpace,
      ...(keySpace === 'vendor' ? { vendor, window_days: windowDays } : {}),
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = body?.error?.message ?? body?.message ?? `HTTP ${res.status}`;
    throw new Error(`Ratchet refused the comparison: ${detail}`);
  }
  return body;
}

export async function reconcile({
  connector, credential, baseUrl, apiKey, effectType, vendor,
  since, until, types, windowDays, dryRun = false,
  fetchImpl = fetch, log = () => {},
}) {
  const found = await connector.listActions({ credential, since, until, types, fetchImpl, log });

  const summary = {
    vendor: connector.name,
    effectType,
    eventsExamined: found.events,
    keysFound: found.keys.length,
    unattributable: found.unattributable,
    checked: 0, gated: 0, ungated: 0, ungatedKeys: [],
    partial: false,
    batches: 0,
    dryRun,
  };

  if (found.keys.length === 0) {
    summary.meaning = found.events === 0
      ? 'The vendor reported no activity in this window. Nothing to compare.'
      : 'Every action the vendor recorded was without an idempotency key, so none '
        + 'of them can be compared in either direction.';
    return summary;
  }

  const batches = chunk(found.keys, MAX_KEYS_PER_CALL);
  summary.batches = batches.length;

  if (dryRun) {
    // Deliberately no request at all. See postBatch.
    summary.meaning =
      `Dry run: would post ${found.keys.length} key(s) in ${batches.length} call(s) `
      + `to ${baseUrl}/v1/reconcile. Nothing was sent and no reconciliation run was `
      + 'recorded, so the cadence clock is untouched.';
    return summary;
  }

  if (batches.length > CALLS_PER_HOUR) {
    throw new Error(
      `${found.keys.length} keys needs ${batches.length} calls, over the endpoint's `
      + `limit of ${CALLS_PER_HOUR} per hour. Narrow the window with --since and run again; `
      + 'splitting the same window into more runs would just be refused more slowly.');
  }

  for (const [i, batch] of batches.entries()) {
    const r = await postBatch({
      baseUrl, apiKey, effectType, keys: batch,
      keySpace: connector.keySpace, vendor: vendor ?? connector.name,
      windowDays, fetchImpl,
    });
    summary.checked += r.checked ?? 0;
    summary.gated += r.gated ?? 0;
    summary.ungated += r.ungated ?? 0;
    if (Array.isArray(r.ungated_keys)) summary.ungatedKeys.push(...r.ungated_keys);
    if (r.partial) summary.partial = true;
    log(`batch ${i + 1}/${batches.length}: ${r.gated} gated, ${r.ungated} unmatched`);
  }

  summary.ungatedKeys = summary.ungatedKeys.slice(0, 100);
  summary.meaning = summary.partial
    ? 'Incomplete: Ratchet reached its candidate limit, so an unmatched key may belong '
      + 'to an effect it never examined. Narrow the window and run again before treating '
      + 'any of these as ungated.'
    : summary.ungated === 0
      ? 'Every action the vendor recorded went through the gate.'
      : `${summary.ungated} action(s) reached ${connector.name} without ever asking Ratchet. `
        + 'Those code paths are unprotected: a retry there can act twice.';
  return summary;
}

/** What a scheduler should do about it. */
export function exitCodeFor(summary) {
  if (summary.dryRun) return EXIT.CLEAN;
  if (summary.partial) return EXIT.INCONCLUSIVE;
  return summary.ungated > 0 ? EXIT.UNGATED : EXIT.CLEAN;
}

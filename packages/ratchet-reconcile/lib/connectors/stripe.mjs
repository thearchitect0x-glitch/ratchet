// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * Stripe connector.
 *
 * Stripe is first because it is the only vendor that hands the key back. The
 * Events API records `request.idempotency_key` on every API-triggered event, so
 * the key Ratchet issued and the caller forwarded can be read straight out
 * again. Nothing has to be derived, which is what makes this the right shape to
 * prove the loop with — see VENDOR_PROFILES: square, adyen, paypal, resend and
 * twilio place the key in a header and never return it, and github, slack,
 * notion and figma have no idempotency mechanism at all.
 *
 * WHAT THIS READS. Only the event list. It never reads a charge, a customer, a
 * balance or a payout. A restricted Stripe key with `rk_` scope limited to
 * events is sufficient and is what the README recommends, because this runs on
 * a schedule in the customer's CI and a full secret key there is a bad trade
 * for a reconciliation job.
 */

const API = 'https://api.stripe.com/v1/events';

/**
 * A ceiling on pages, so a paging bug cannot loop for ever.
 *
 * A hundred events a page, so this reads up to fifty thousand in one window —
 * far past any plausible run, and reaching it reports the window as incomplete
 * rather than pretending it finished.
 */
const MAX_PAGES = 500;

/**
 * Actions Stripe recorded in a window.
 *
 * Returns three groups, and the third is the point:
 *
 *   `keys`           requests that carried an idempotency key. These go to
 *                    Ratchet, which says which it authorised.
 *   `unattributable` requests Stripe recorded with NO idempotency key at all.
 *                    These cannot be reconciled in either direction and are
 *                    NEVER reported as ungated — see the note below.
 *   `events`         how many events were examined, so a caller can tell a
 *                    quiet window from a failed query.
 *
 * The unattributable group is the honest half of this. A Stripe request with no
 * idempotency key might be an ungated path, or it might be a perfectly gated
 * effect whose caller chose not to forward the vendor key. Ratchet has no way
 * to tell those apart and neither does this, so it reports the count and
 * refuses to guess — the same rule the gate applies to a lease that expired
 * without a report.
 */
export async function listActions({ credential, since, until, types, fetchImpl = fetch, log = () => {} }) {
  const keys = [];
  let unattributable = 0;
  let events = 0;
  let startingAfter;
  /** Set only when Stripe says has_more === false. See the loop below. */
  let complete = false;
  let pages = 0;

  for (;;) {
    const qs = new URLSearchParams();
    qs.set('limit', '100');
    qs.set('created[gte]', String(Math.floor(since / 1000)));
    qs.set('created[lte]', String(Math.floor(until / 1000)));
    if (startingAfter) qs.set('starting_after', startingAfter);
    for (const t of types ?? []) qs.append('types[]', t);

    const res = await fetchImpl(`${API}?${qs}`, {
      headers: { authorization: `Bearer ${credential}`, 'stripe-version': '2024-06-20' },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Stripe returned ${res.status}: ${body.slice(0, 300)}`);
    }
    const page = await res.json();

    for (const ev of page.data ?? []) {
      events += 1;
      const key = ev?.request?.idempotency_key;
      if (typeof key === 'string' && key.length > 0) keys.push(key);
      else unattributable += 1;
    }

    log(`stripe: ${events} events examined`);

    /*
     * Only an explicit has_more === false means "that was all of it".
     *
     * The previous form broke on `!page.has_more`, which is also true when the
     * field is absent, null, or any shape other than the boolean assumed here.
     * A vendor response that differs from expectation would have stopped the
     * read after one page of a hundred events and reported every one of them
     * gated — a clean bill of health from a partial read, in the tool whose
     * entire job is finding what the gate missed. That is the false all-clear,
     * and it is the failure this product exists to refuse.
     *
     * So completeness is now something the vendor has to STATE, not something
     * inferred from the loop ending. Anything else leaves `complete` false and
     * the caller reports inconclusive rather than clean.
     */
    if (page.has_more === false) { complete = true; break; }

    const batch = page.data ?? [];
    if (batch.length === 0) break;               // has_more said more, and sent none
    if (typeof page.has_more !== 'boolean') break; // a shape we do not understand

    pages += 1;
    if (pages >= MAX_PAGES) break;               // bounded, and honestly incomplete

    startingAfter = batch[batch.length - 1].id;
  }

  // Stripe replays the same key on a retried request, and one logical action can
  // raise several events. Both produce duplicates that would inflate `checked`
  // without telling anyone anything new.
  return { keys: [...new Set(keys)], unattributable, events, complete };
}

export const stripe = {
  name: 'stripe',
  /** Which Ratchet key space Stripe records. It stores what we handed it. */
  keySpace: 'vendor',
  credentialEnv: 'STRIPE_API_KEY',
  /** Stripe retains events for 30 days; asking for more is a silent short read. */
  maxWindowDays: 30,
  listActions,
};

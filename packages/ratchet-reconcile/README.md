<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 Deimos AI LLC -->

# ratchet-reconcile

Find real-world actions that **bypassed the gate**.

It reads your vendor's own record of what happened, asks Ratchet which of those
it authorised, and exits non-zero on the difference. Anything Ratchet has never
seen is a code path in your system that acted without asking — usually a bug
nobody knew was there.

```bash
STRIPE_API_KEY=rk_live_... RATCHET_API_KEY=rk_live_... \
  npx ratchet-reconcile --vendor stripe --effect-type payment.charge --days 1
```

## Why this exists

`POST /v1/reconcile` has always been able to answer this question. Running it
meant hand-pulling your vendor's records and deriving the idempotency keys your
system should have used — real per-vendor engineering — so in practice it ran
only when somebody was already suspicious.

That is the wrong time. The whole value of the comparison is that it sees the
gap *before* anyone suspects anything. **A control that runs approximately never
is indistinguishable from one that does not exist.**

## Ratchet never gets your vendor credential

```
your infrastructure                        ratchet
┌────────────────────────────────┐
│ ratchet-reconcile              │
│  ├─ your vendor key (local) ───┼──▶ vendor API: what actually happened
│  ├─ collect idempotency keys   │
│  └─ POST /v1/reconcile ────────┼──▶ which of these did you authorise?
└────────────────────────────────┘         ▲
                                            └── references only, never a credential
```

Ratchet holds no vendor credential and makes no outbound call into your systems.
That boundary is the product's main safety property, and this adapter is shaped
the way it is specifically so that scheduling the check does not erode it.

**Both credentials come from the environment, never from arguments.** A command
line is visible in the process table to every user on the machine, and on a CI
runner it ends up in logs.

## Exit codes

Designed to drop into a cron or CI job you already have.

| Code | Meaning |
|---|---|
| `0` | Every action the vendor recorded went through the gate |
| `1` | **Ungated actions found** — something acted without asking |
| `2` | Usage or configuration error |
| `3` | **Inconclusive** — the comparison was incomplete; do not read it either way |

Exit `3` matters. Ratchet answers `partial` when it reaches its candidate limit,
which means an unmatched key may belong to an effect it never examined.
Reporting that as clean would be a false all-clear; reporting it as ungated
would accuse code that is probably fine. It is neither, and it says so.

## `--dry-run` sends nothing at all

Not "sends a harmless request" — **nothing**.

Every call to `/v1/reconcile` records a reconciliation run, and that is what
resets the cadence clock and stops the scheduler asking for a check that just
happened. A dry run that touched the endpoint would mark reconciliation as done
while comparing nothing, and the real check would then be skipped for a full
cadence on the strength of a rehearsal.

A dry run does not even need `RATCHET_API_KEY`.

## The third bucket

Actions come back in three groups, and the third is the honest one:

- **gated** — Ratchet authorised it
- **ungated** — Ratchet has never seen it. This is the finding
- **unattributable** — the vendor recorded no idempotency key at all

An unattributable action might be an ungated path, or a perfectly gated effect
whose caller chose not to forward the vendor key. Nothing can tell those apart,
so it is counted, reported, and **never** added to the ungated total. Same rule
the gate applies to a lease that expired without a report: an unknown outcome
stays unknown.

## Vendors

Ratchet's vendor profiles split three ways, and this serves one of them today.

| Class | Vendors | Supported |
|---|---|---|
| Key readable back | **stripe**, sendgrid | **stripe today** |
| Key sent, not readable back | square, adyen, paypal, resend, twilio | Only where the key is derivable from business data |
| Key never sent | github, slack, notion, figma | **Not possible this way** |

That last row is not a gap in this tool. Those vendors have no idempotency
mechanism, so an ungated action carries no Ratchet key anywhere by
construction — there is nothing to match on. Catching those needs
action-identity matching (*the gate authorised 45 messages, Slack says 47
happened, here are the 2 that never asked*), which is a different capability.

### Stripe

Stripe records `request.idempotency_key` on every API-triggered event, so the
key Ratchet issued and you forwarded reads straight back out. A **restricted**
key with read access to events is enough — this never reads a charge, a
customer, a balance or a payout, and a full secret key on a scheduled CI job is
a bad trade.

Stripe retains 30 days of events. Asking for more is refused rather than
silently returning a short read, which would report actions as absent that
Stripe merely no longer remembers.

## Options

```
--vendor <name>        which connector to use (stripe)
--effect-type <type>   the Ratchet effect type these actions correspond to
--days <n>             how far back to look (default 1)
--since <iso>          explicit start, overrides --days
--until <iso>          explicit end (default now)
--types <a,b>          vendor-side event types to include
--dry-run              show what would be compared; sends nothing
--quiet                only print the verdict
--json                 machine-readable summary on stdout
```

Environment: `RATCHET_API_KEY`, `STRIPE_API_KEY`, and `RATCHET_BASE_URL`
(defaults to `https://ratchetgate.com`).

## Batching

The endpoint accepts 1000 keys per call and 60 calls an hour. A window needing
more than that is **refused up front** rather than rate-limited partway through,
which would leave you with a recorded run, a partial comparison, and a cadence
clock reset on the strength of it. Narrow the window and run more often.

---

Apache-2.0 · part of [Ratchet](https://ratchetgate.com) by Deimos AI LLC

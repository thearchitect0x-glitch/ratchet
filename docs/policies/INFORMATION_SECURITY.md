<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 Deimos AI LLC -->

# Information security policy

| | |
|---|---|
| **Owner** | Maintainer, Deimos AI LLC — see [GOVERNANCE.md](../../GOVERNANCE.md) |
| **Approved** | 6 September 2026, by merge of the pull request that added this file |
| **Review** | Annually, or on a material change to what it describes |
| **Applies to** | Everyone with access to Ratchet systems or source |

> Approval and revision history for this policy is the git history of this file.
> A change requires a pull request with an approving review from somebody other
> than the author, enforced by a repository ruleset with no bypass actors.

## Purpose

This is the umbrella policy. It states what Deimos AI LLC protects, who is
accountable, and where the specific policies live.

## What we protect

1. **Customer effect records** — what an agent asked to do, the decision, the
   outcome. Ratchet stores a payload *fingerprint*, never the payload.
2. **Blinded dimensions** — `HMAC(secret, workspace|name|value)`, truncated. The
   value cannot be recovered from what is stored.
3. **Credentials** — API keys held as HMAC-SHA256 peppered with a server-side
   secret, never plaintext and never a bare hash.
4. **The integrity of decisions** — a decision that can be forged or replayed is
   worse than no decision.

## What we deliberately do not hold

Ratchet holds **no vendor credentials** and has **no outbound access to customer
systems**. It never performs the side effect it authorises. This is the single
most important control in the system: an attacker in complete control of Ratchet
still cannot cause a real-world action to occur.

## Principles

- **Controls are enforced by tests, not described by documents.**
  [CLAUDE.md](../../CLAUDE.md) §5 states eleven non-negotiable rules and each is
  held by a test that fails the build. A policy nobody can verify is decoration.
- **An unknown state stays unknown.** Applied to security as it is to effects: a
  check that could not run has not passed, and is never reported as clean.
- **Limitations are published, not discovered.**
  [ASSURANCE_CASE.md](../../ASSURANCE_CASE.md) §6 lists what this system does not
  cover, and [KNOWN_LIMITATIONS.md](../handoff/KNOWN_LIMITATIONS.md) is
  maintained deliberately.

## The specific policies

[Access control](ACCESS_CONTROL.md) · [Change management](CHANGE_MANAGEMENT.md) ·
[Incident response](INCIDENT_RESPONSE.md) ·
[Business continuity](BUSINESS_CONTINUITY.md) ·
[Vendor management](VENDOR_MANAGEMENT.md) ·
[Data retention and classification](DATA_RETENTION.md) ·
[Acceptable use](ACCEPTABLE_USE.md)

## Accountability

The Maintainer owns every policy here. The Second Administrator holds equivalent
production access for continuity. Both are named in
[GOVERNANCE.md](../../GOVERNANCE.md). With three people and two credential
holders, separation of duty is limited and that limitation is stated rather than
implied.

## Exceptions

An exception requires written justification, a compensating control, and an
expiry date, recorded in the risk register. An exception with no expiry is a
policy change and must be made as one.

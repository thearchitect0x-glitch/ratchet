<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 Deimos AI LLC -->

# Business continuity and disaster recovery policy

| | |
|---|---|
| **Owner** | Maintainer, Deimos AI LLC — see [GOVERNANCE.md](../../GOVERNANCE.md) |
| **Approved** | 6 September 2026, by merge of the pull request that added this file |
| **Review** | Annually, or on a material change to what it describes |
| **Applies to** | Everyone with access to Ratchet systems or source |

> Approval and revision history for this policy is the git history of this file.
> A change requires a pull request with an approving review from somebody other
> than the author, enforced by a repository ruleset with no bypass actors.

## Objectives

| | Target |
|---|---|
| Recovery time objective (RTO) | 4 hours for the control plane |
| Recovery point objective (RPO) | 15 minutes |

These are targets for a total-loss scenario, not commitments in the customer
agreement.

## Architecture

The control plane is stateless and horizontally scalable; any instance may be
replaced. The **worker must be long-running** — it expires leases on a timer
whether or not a request is in flight, and treating it as serverless is the most
damaging available mistake in this system. Multiple worker replicas are safe.

The database is a three-node Postgres cluster, one node per zone, with automatic
failover. A standby that loses the primary sees two of three, which meets quorum.
Replication slot retention is bounded so a dead replica cannot fill the primary's
disk.

**Stated limitation:** single region. This is published in
[KNOWN_LIMITATIONS.md](../handoff/KNOWN_LIMITATIONS.md).

## Backups

Backups are taken on a schedule and their **restorability is verified rather than
assumed** — a backup nobody has restored is a hypothesis. Verification is
scripted and its result is recorded.

## Testing

A recovery exercise is performed and recorded **at least annually**, and after
any material change to the database topology. The record names what was
exercised, how long it took, and what did not work.

Real events count as exercises when documented as such. Three production
incidents in the first fortnight — a database OOM, a frozen standby, and a
failover that left two primaries — are published with timelines and are the most
honest evidence available that recovery procedures have been exercised.

## Succession

Two people hold the credentials the project depends on and repository
administration. [docs/handoff/RECOVERY.md](../handoff/RECOVERY.md) lists every
credential, where it lives, and what breaks without it, and is written for
somebody who is not the author.

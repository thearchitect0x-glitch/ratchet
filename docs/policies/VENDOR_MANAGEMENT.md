<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 Deimos AI LLC -->

# Vendor management policy

| | |
|---|---|
| **Owner** | Maintainer, Deimos AI LLC — see [GOVERNANCE.md](../../GOVERNANCE.md) |
| **Approved** | 6 September 2026, by merge of the pull request that added this file |
| **Review** | Annually, or on a material change to what it describes |
| **Applies to** | Everyone with access to Ratchet systems or source |

> Approval and revision history for this policy is the git history of this file.
> A change requires a pull request with an approving review from somebody other
> than the author, enforced by a repository ruleset with no bypass actors.

## Principle

A vendor with access to customer data, or whose failure interrupts the service,
is part of the system and is reviewed as such.

## Before adoption

1. What data does it receive, and is that the minimum necessary?
2. Does its failure cause an outage, data loss, or only degradation?
3. Is there a current independent attestation — SOC 2, ISO 27001 — and has it
   been read rather than merely collected?
4. What is the exit path if the vendor fails or changes terms?

A vendor receiving customer data requires the Maintainer's approval, recorded in
the vendor register.

## Ongoing

Reviewed **annually**, and immediately on notice of a breach at the vendor or a
material change to their terms. The review confirms the attestation is current,
the data flow is unchanged, and the exit path still exists.

## The register

Vendors, their data exposure, attestations and review dates are recorded in the
vendor register, which is **not published**: it describes the production stack in
a level of detail that is useful to an attacker and to nobody else.

## Software dependencies

Open source dependencies are governed separately by
[docs/OPEN_SOURCE_POLICY.md](../OPEN_SOURCE_POLICY.md), which is enforced by a
script that fails the build on a production dependency outside the licence
allowlist.

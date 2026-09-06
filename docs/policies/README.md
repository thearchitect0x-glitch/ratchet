<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 Deimos AI LLC -->

# Policies

The written policy set for Deimos AI LLC, covering Ratchet.

These are **published deliberately**. A policy nobody can read is a policy
nobody can check, and the whole argument of this project is that a claim should
be verifiable rather than asserted. Each one describes what actually happens and
points at the artefact that proves it — a test, a ruleset, a script, an incident
report — rather than describing an intention.

| Policy | Covers |
|---|---|
| [Information security](INFORMATION_SECURITY.md) | The umbrella: what is protected, who is accountable |
| [Access control](ACCESS_CONTROL.md) | Credentials, scopes, MFA, tenant isolation, access reviews |
| [Change management](CHANGE_MANAGEMENT.md) | Review, CI gates, releases, emergency changes |
| [Incident response](INCIDENT_RESPONSE.md) | Reporting, commitments, handling, publication |
| [Business continuity](BUSINESS_CONTINUITY.md) | RTO/RPO, architecture, backups, recovery testing |
| [Vendor management](VENDOR_MANAGEMENT.md) | Adoption criteria, ongoing review |
| [Data retention](DATA_RETENTION.md) | Classification, what is never stored, retention, deletion |
| [Acceptable use](ACCEPTABLE_USE.md) | Device and credential hygiene, AI assistance |

## Approval and revision

**The git history of each file is its approval record.** A change requires a
pull request with an approving review from somebody other than the author, under
a repository ruleset with no bypass actors — so an approved revision is
cryptographically attributable and dated, which a shared drive is not.

## What is not here

Registers that name specific systems, vendors and people are **not published**:
the risk register, vendor register, asset inventory, and access review log.
They describe the production stack in a level of detail useful to an attacker
and to nobody else. They are maintained privately and produced to an auditor on
request.

## Related

[GOVERNANCE.md](../../GOVERNANCE.md) · [SECURITY.md](../../SECURITY.md) ·
[ASSURANCE_CASE.md](../../ASSURANCE_CASE.md) · [SSDF conformance](../SSDF.md) ·
[Open source policy](../OPEN_SOURCE_POLICY.md) · [Code review](../CODE_REVIEW.md)

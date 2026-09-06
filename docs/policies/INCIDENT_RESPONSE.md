<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 Deimos AI LLC -->

# Incident response policy

| | |
|---|---|
| **Owner** | Maintainer, Deimos AI LLC — see [GOVERNANCE.md](../../GOVERNANCE.md) |
| **Approved** | 6 September 2026, by merge of the pull request that added this file |
| **Review** | Annually, or on a material change to what it describes |
| **Applies to** | Everyone with access to Ratchet systems or source |

> Approval and revision history for this policy is the git history of this file.
> A change requires a pull request with an approving review from somebody other
> than the author, enforced by a repository ruleset with no bypass actors.

## Scope

A security incident is any suspected or confirmed unauthorised access, loss of
confidentiality or integrity of customer data, or compromise of a credential. An
availability incident is a loss or material degradation of service. Both follow
this policy; the disclosure obligations differ.

## Reporting

- **Externally** — `security@ratchetgate.com`, or GitHub private vulnerability
  reporting. Both reach the Maintainer directly and neither is public.
- **Internally** — immediately to the Maintainer and the Second Administrator.

**Do not open a public issue for a security problem.** This is stated on the
public security page and in `SECURITY.md`.

## Commitments

| Stage | Target |
|---|---|
| Acknowledgement | 72 hours |
| Assessment | 7 days |
| Fix, or a documented reason there will not be one | before disclosure |

Reporters are credited by name unless they prefer otherwise.

## Handling

1. **Contain.** Prefer revoking a credential or disabling a path over
   investigating first. Rotation is cheap; exposure is not.
2. **Preserve.** Do not rewrite history, delete logs, or make a repository
   private. The record is evidence.
3. **Assess** scope, data involved, and whether notification is required.
4. **Remediate**, with a test that fails without the fix, and watch it fail.
5. **Record.** Every incident gets a written report naming the cause without
   euphemism, the timeline, what was done, and what changed as a result.

## Publication

Operational incidents are **published**. Three are already public with root cause
and remediation. Security incidents affecting customer data are disclosed to
affected customers first and published once remediated, unless publication would
endanger others.

## Root cause

Every defect is fixed with a test that fails without the fix, and that failure is
verified rather than assumed. Analysis is per-incident and recorded in the
report; a periodic review across incidents looking for patterns is **not yet
performed**, and that gap is stated in `docs/SSDF.md`.

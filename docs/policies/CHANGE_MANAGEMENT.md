<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 Deimos AI LLC -->

# Change management policy

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

No change reaches production without review, automated verification, and a
recorded approval — including changes made by the Maintainer.

## The gate

`main` carries a repository ruleset with **no bypass actors**:

- deletion and non-fast-forward pushes are refused
- a change reaches `main` only through a pull request
- with at least one approving review
- from somebody other than the last person to push

This binds the Maintainer. It was verified by attempting a direct push and being
refused, not by reading a settings page.

## What must pass before merge

Automated, on every push and pull request:

- typecheck of source, tests and scripts
- unit, integration and end-to-end suites against a disposable database
- property-based fuzzing of every function that reads attacker-supplied input
- a reproducible-build check — two clean builds must be byte-identical
- production dependency audit, where a registry outage is reported as an outage
  and never as a pass
- static analysis on every push and weekly

By reading, against the project contract: does the change preserve at-most-once
enforcement in the database, keep an unknown outcome unknown, avoid storing raw
payloads, keep every query workspace-scoped, and preserve the documented lock
order. See [docs/CODE_REVIEW.md](../CODE_REVIEW.md).

**A test must be watched to fail before it is trusted.** Break the implementation
deliberately and confirm the test goes red. This project has shipped a
log-redaction test that passed against an unredacted logger and a fuzz harness
whose mutations silently patched nothing; neither would have been found by
reading.

## Releases

Deployment refuses to promote a build whose tree is uncommitted or unpushed,
whose CI is not green for that exact commit, that staging is not already running,
or whose staging smoke test does not pass at that moment. The emergency override
is a separate command so it cannot be reached by habit.

Release tags are signed and verified before publication.

## Emergency changes

An emergency change may use the override, and must be followed within one
business day by a pull request recording what was changed and why, reviewed
normally. An override with no follow-up review is an incident in its own right.

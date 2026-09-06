<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 Deimos AI LLC -->

# Acceptable use policy

| | |
|---|---|
| **Owner** | Maintainer, Deimos AI LLC — see [GOVERNANCE.md](../../GOVERNANCE.md) |
| **Approved** | 6 September 2026, by merge of the pull request that added this file |
| **Review** | Annually, or on a material change to what it describes |
| **Applies to** | Everyone with access to Ratchet systems or source |

> Approval and revision history for this policy is the git history of this file.
> A change requires a pull request with an approving review from somebody other
> than the author, enforced by a repository ruleset with no bypass actors.

## Applies to

Everyone with access to Ratchet systems, source or credentials.

## Required

- Multi-factor authentication on every account with production or repository
  access. TOTP or a hardware key — **not SMS**.
- Full-disk encryption and a screen lock on any device holding credentials or
  source.
- Credentials in a password manager. Never in a message, a ticket, a commit, or a
  file in the repository.
- Report a lost device or suspected credential exposure **immediately**.
  Rotation is cheap and blame is not the point.

## Prohibited

- Using production credentials for development or testing.
- Copying customer data to a personal device or account.
- Disabling a security control to work faster. If a control is wrong, change it
  through review — the override exists for incidents, not for convenience.
- Committing a secret. If it happens: rotate first, then remove. A secret in git
  history is compromised the moment it is pushed, and removing the commit does
  not un-compromise it.

## AI assistance

Ratchet is built with substantial AI assistance and this is stated publicly.
Where such a tool is used, the same rules apply: no customer data, no secrets,
and every change still passes review and the full test suite. **The author of a
change is accountable for it regardless of what helped write it.**

## Acknowledgement

Each person acknowledges this policy on joining and annually thereafter. The
acknowledgement record is held with the HR records, not in this repository.

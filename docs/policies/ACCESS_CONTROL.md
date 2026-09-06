<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 Deimos AI LLC -->

# Access control policy

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

Least privilege, enforced in code rather than by convention.

## Credentials and how they are stored

| Credential | Storage | Control |
|---|---|---|
| API keys | HMAC-SHA256 peppered with a server-side secret | Never plaintext, never a bare hash. Compared in constant time, and the comparison runs even for unknown prefixes so timing reveals nothing |
| Console sessions | Server-side session records | Bound to a session id; operator actions require a second factor |
| Signing keys | Operator workstation only | The private half of the registry signing key never leaves the operator's machine |

## Scopes

API keys carry explicit scopes. Signup issues **two** keys: an operator key with
full scope, and a narrow agent key limited to `effects:begin`, `effects:report`
and `effects:read`. Quickstart hands over the narrow one, so the key a customer
pastes into an agent cannot rewrite its own policy or close its own circuit
breaker. A test asserts this.

**An agent may never widen its own limits.** This is requirement R7 of the
assurance case and is held by tests.

## Multi-factor authentication

Operator actions in the console require TOTP second-factor verification, with a
15-minute step-up window, lockout after 5 consecutive failures for 15 minutes,
and single-use recovery codes. The factor gates *actions*, not merely the login,
so a stolen session cannot perform an operator action.

## Tenant isolation

Every query is workspace-scoped. There is no unscoped read path. A cross-tenant
lookup returns 404 and never hints that the record exists elsewhere. Held by
tests in the integration suite.

## Access reviews

Access is reviewed **quarterly** and on any change of personnel. The review
covers: repository collaborators and their permission level, platform accounts
(compute, database, DNS, registry, payments), and any long-lived API key issued
for internal use. The reviewer records the date, what was examined, and what was
revoked, in the access review log.

Access is revoked **on the same day** a person's involvement ends.

## Physical access

Delegated entirely to the infrastructure provider. Deimos AI LLC operates no
premises containing production systems. The provider's own attestation is held
in the vendor register.

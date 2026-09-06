<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 Deimos AI LLC -->

# Data retention and classification policy

| | |
|---|---|
| **Owner** | Maintainer, Deimos AI LLC — see [GOVERNANCE.md](../../GOVERNANCE.md) |
| **Approved** | 6 September 2026, by merge of the pull request that added this file |
| **Review** | Annually, or on a material change to what it describes |
| **Applies to** | Everyone with access to Ratchet systems or source |

> Approval and revision history for this policy is the git history of this file.
> A change requires a pull request with an approving review from somebody other
> than the author, enforced by a repository ruleset with no bypass actors.

## Classification

| Class | Examples | Handling |
|---|---|---|
| **Secret** | API key pepper, signing keys, database credentials, session secrets | Platform secret store or operator workstation only. Never in the repository, never in logs, never in a support channel |
| **Confidential** | Effect records, decisions, receipts, blinded dimensions, workspace metadata | Encrypted in transit and at rest. Workspace-scoped access only |
| **Internal** | Operational metrics, aggregate counts | No per-workspace identifiers may appear in metrics; enforced by test |
| **Public** | Source, documentation, published incidents, this policy | Apache-2.0 |

## What is deliberately never stored

- **The payload of a gated effect.** Only `sha256(canonicalize(payload))`.
- **The value of a declared dimension.** Only a truncated HMAC, with the
  workspace id inside the MAC so the same value in two workspaces produces two
  unrelated identifiers and there is no cross-tenant correlation to leak.
- **API keys in recoverable form.**

A database disclosure alone therefore yields no usable credential, no payload,
and no destination.

## Retention

Effect results are retained for a configurable period per effect type, defaulting
to **7 days** and capped at **400**. Expired results are pruned; the decision
record and its receipt survive, so the audit trail is not shortened by result
retention.

Logs redact `authorization`, `x-api-key`, `cookie`, payment signature headers and
`set-cookie`. This list is extended whenever a credential header is added.

**Stated limitation:** retention deletes replayable results, so a duplicate
arriving after the retention period cannot replay the recorded outcome. Published
in [KNOWN_LIMITATIONS.md](../handoff/KNOWN_LIMITATIONS.md).

## Deletion

On workspace deletion, records cascade. Backups age out on their own schedule;
deletion is therefore complete once the last backup containing the data expires,
and that period is stated to customers rather than described as immediate.

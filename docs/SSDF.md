<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 Deimos AI LLC -->

# NIST SSDF conformance

How Ratchet is built, mapped to the four practice groups of the **Secure Software
Development Framework**, NIST SP 800-218 version 1.1.

**What this is.** A statement of what Deimos AI LLC actually does when building
Ratchet, with a pointer to the file, workflow or test that makes each claim
checkable. Where a practice is not met, it says so.

**What this is not.** A certification. Nobody issues an SSDF badge. It is also
not a [CISA Secure Software Development Attestation](https://www.cisa.gov/resources-tools/resources/secure-software-development-attestation-form) —
that form is submitted to a federal agency purchasing the software, and no
agency purchases Ratchet. This document is the substance such an attestation
would rest on, published so it can be read rather than asserted.

**Scope.** The Ratchet control plane, worker, MCP bridge and website, in
[this repository](https://github.com/thearchitect0x-glitch/ratchet). Deimos AI LLC
is three people, one of whom builds and releases Ratchet; several practices
below are met by automation precisely because no second person is in the path of
a change to catch a mistake.

---

## PO — Prepare the Organization

*Ensure the organization's people, processes and technology are prepared to
perform secure software development.*

**PO.1 — Define security requirements.** Seven security requirements are stated
in [`ASSURANCE_CASE.md`](../ASSURANCE_CASE.md), each with the countermeasure and
the test holding it. [`CLAUDE.md`](../CLAUDE.md) §5 carries eleven
non-negotiable rules — no raw payload storage, no plaintext key storage,
workspace-scoped queries, no client-supplied prices or decisions, SSRF pinning,
agent-supplied text never reaching a decision. Each is enforced by a test, so a
change that breaks one fails the build rather than a review.

**PO.2 — Roles and responsibilities.** [`GOVERNANCE.md`](../GOVERNANCE.md) names
the roles and who holds them. A partner at Deimos AI LLC holds the credentials
the project depends on and admin on the repository, so the recovery procedure in
[`docs/handoff/RECOVERY.md`](handoff/RECOVERY.md) is written for a successor who
exists and can already act without recovering an account first. **Still open:**
direction rests on one person. Both can act and both are now in the path of every
change, but only one decides what the change should be.

**PO.3 — Supporting toolchains.** Every push to `main` and every pull request
runs: typecheck of `src`, `test` and `scripts`; unit, integration and
end-to-end suites against a disposable PostgreSQL database; property-based
fuzzing; a reproducible-build check; and a production dependency audit. CodeQL
runs on every push and weekly. Dependency updates arrive by Dependabot, grouped,
and are evaluated in an isolated worktree before merge when they cross a major
version.

**PO.4 — Criteria for software security checks.** [`CLAUDE.md`](../CLAUDE.md)
§11 defines done: full suite green, a test at the right layer, published API
schemas updated, MCP tool descriptions still true, handoff docs updated, no
claim anywhere made untrue, zero production vulnerabilities. Coverage floors are
explicit (90% statements, 78% branches, 90% lines, 88% functions) and set
deliberately above nothing — an unset threshold is not a neutral choice.

**PO.5 — Secure development environments.** Secrets live in the platform secret
store, never in the repository; `.env` files are gitignored and the encrypted
form is deliberately *not* committed, because a public repository would make it
an offline brute-force target. `assertProductionSafety()` in
[`src/lib/config.ts`](../src/lib/config.ts) refuses to start in production with
a development `AUTH_SECRET`, a wildcard CORS origin, or private-network webhook
delivery enabled. **Partial:** the developer workstation itself is not covered
by a documented hardening standard.

---

## PS — Protect the Software

*Protect all components of the software from tampering and unauthorized access.*

**PS.1 — Protect code from unauthorized access and tampering.** `main` is
protected against deletion and non-fast-forward pushes. The account that can
push holds TOTP two-factor authentication, not SMS. Every commit added by a pull
request must carry a `Signed-off-by` line certifying the
[Developer Certificate of Origin](https://developercertificate.org/), enforced
by [`.github/workflows/dco.yml`](../.github/workflows/dco.yml).

**PS.2 — Verify release integrity.** Two independent signatures cover a release.
Release tags are annotated and signed with an ed25519 SSH key registered to the
maintainer; GitHub reports `verified: true` for each. npm packages are published
with `--provenance`, producing a SLSA v1 attestation bound to the exact workflow
run and commit, verifiable with `npm audit signatures`.

`npm audit signatures` proves the attestation is genuine. It does not check
which workflow made it or from which ref, so a genuine attestation made by a
workflow pushed to some other branch would pass it too. The strict check names
both, and refuses a self-hosted runner:

```bash
npm pack ratchet-mcp@X.Y.Z               # downloads ratchet-mcp-X.Y.Z.tgz without installing it
curl -fsSL https://registry.npmjs.org/-/npm/v1/attestations/ratchet-mcp@X.Y.Z \
  | jq -c '.attestations[] | select(.predicateType == "https://slsa.dev/provenance/v1") | .bundle' \
  > ratchet-mcp-X.Y.Z.sigstore.jsonl
gh attestation verify ratchet-mcp-X.Y.Z.tgz --bundle ratchet-mcp-X.Y.Z.sigstore.jsonl --digest-alg sha512 \
  --repo thearchitect0x-glitch/ratchet \
  --signer-workflow thearchitect0x-glitch/ratchet/.github/workflows/publish.yml --source-ref refs/tags/vX.Y.Z \
  --deny-self-hosted-runners
```

`--digest-alg sha512` because npm attests the tarball's SHA-512. For
`ratchet-reconcile`, use its own version and the tag of the release that
published it. 0.2.1 and later were published from their release tags; 0.2.0 was
published by a manual run on `main`, so its source ref is `refs/heads/main`.
`ratchet-mcp` 0.1.0 and 0.1.1 were published without provenance: npm holds no
attestation for either, so neither check can verify them.

The publish workflow **refuses to publish from a tag whose signature does not
verify** — provenance answers "which workflow, at which commit", not "was that
the commit the maintainer released", and a release can otherwise be cut from any
tag at all.

Publishing also waits for a maintainer. Both publishing jobs run in a `release`
environment that admits only `v*` tags and holds each run until a maintainer
approves it, and only an admin can create, move or delete a tag. The tag is read
after that wait, so the signature check also confirms the tag still points at
the commit the run checked out: a tag moved in the meantime stops the publish.
**Residual:** the approval does not stop a single compromised admin account.
Either admin can push a tag, publish a release and approve its run alone, and
can change the tag rules back; the owner can also change the environment. It
stops everyone else.

*No SLSA level is claimed.* The only tooling that certified Build L3 for npm on
GitHub Actions is no longer maintained, and neither npm nor GitHub documents a
level for the maintained alternative. A level nobody can substantiate is not
worth asserting.

**PS.3 — Archive and protect each release.** Every release is a signed tag on a
public repository with published notes. Database backups are taken on a schedule
and their restorability is verified rather than assumed — see
[`scripts/backup-verify.sh`](../scripts/backup-verify.sh) and
[`scripts/verify-restore.mjs`](../scripts/verify-restore.mjs).

An SBOM is attached to every release in both SPDX 2.3 and CycloneDX 1.5, the
two formats procurement tooling reads. A lockfile is not a substitute: it
records what was resolved, not what shipped, and nobody else's tooling reads it.
The bill is generated *after* the tag signature check, so it describes a commit
whose tag verified.

**Partial:** a release's files can still be replaced. Releases are not locked
(GitHub's immutable releases), because the SBOM is attached after the release is
published and a locked release refuses that. So anyone with write access, or a
workflow given `contents: write`, can replace or delete the SBOM files on a
release. The npm packages are not affected: npm never accepts a second upload of
a version, and their provenance names the commit.

---

## PW — Produce Well-Secured Software

*Produce well-secured software with minimal security vulnerabilities.*

**PW.1 — Design to meet security requirements.**
[`ASSURANCE_CASE.md`](../ASSURANCE_CASE.md) states the threat model, what is
explicitly out of scope, the trust boundary and what crosses it. The central
design property is architectural rather than procedural: Ratchet performs no
side effect itself, holds no vendor credential, and has no outbound access to
customer systems. At-most-once initiation is enforced by a database unique index
rather than by application logic.

**PW.2 — Review the design.** **Met, as of 5 September 2026.** A second engineer
at Deimos AI LLC reviews, and `main` now requires it: a ruleset with no bypass
actors admits a change only through a pull request carrying an approving review
from somebody other than the last pusher. Verified by attempting a direct push
and being refused, not by reading the setting. The OpenSSF `two_person_review`
criterion asks that 50% of proposed modifications be reviewed before release; the
rule holds it at 100% going forward, over a history where it was 3 of 247.

**PW.4 — Reuse well-secured software.** Production dependencies are deliberately
few; the published MCP bridge has none at all. Nothing is vendored or forked, so
every component updates in place. `npm audit --omit=dev` gates CI and
distinguishes a registry outage from a finding — it never reports clean for a
check that did not run.

**PW.5 — Secure coding practices.** TypeScript strict with
`noUncheckedIndexedAccess`, applied to source, tests and scripts. Every request
body, query and parameter is validated against a JSON Schema at the route
boundary with `additionalProperties: false`, so an unexpected field is rejected
rather than silently dropped. Credentials are stored as HMAC-SHA256 peppered
with a server-side secret and compared in constant time, including for unknown
key prefixes. All cryptography uses `node:crypto`; nothing is hand-rolled.

**PW.6 — Configure build processes.** The build is reproducible and proven so by
[`scripts/verify-reproducible.sh`](../scripts/verify-reproducible.sh), which runs
in CI: two clean builds must be byte-identical and must contain nothing specific
to the machine that produced them. The compiler is pinned to an exact version,
every container base image is pinned by digest, and `npm ci` resolves from a
committed lockfile. The container runs as a non-root user.

**PW.7 — Review human-readable code.** CodeQL's security query suite runs on
every push and weekly. The compiler in strict mode acts as a second static
analyser over source, tests and scripts. Human review is documented in
[`docs/CODE_REVIEW.md`](CODE_REVIEW.md), including its honest limitation: a
second engineer reviews, but no record shows which changes they were in front
of, and the checks that compensate for that are automated.

**PW.8 — Test executable code.** Over a thousand tests across unit, integration
and end-to-end suites, the latter two against a real PostgreSQL database.
Property-based fuzzing covers the three functions that read attacker-supplied
input before anything has been verified: the payload fingerprint, the SSRF
guard, and payment webhook signature verification — roughly a million generated
inputs per run.

A rule that has repeatedly earned its place: **a test must be watched to fail
before it is trusted.** Break the implementation on purpose and confirm the test
goes red. This project has shipped a log-redaction test that passed against an
unredacted logger, and a fuzz harness whose mutations silently patched nothing.
Neither would have been found by reading.

**PW.9 — Secure settings by default.** An effect type with no explicit policy
gets safe defaults: allowed, 60-second lease, three attempts, and **block** on
an unknown outcome. An unknown outcome is never resolved to success on a guess.
Signup issues a narrow key alongside the operator key, so the key a quickstart
invites you to paste into an agent cannot change its own policy or close its own
circuit breaker. Security headers — CSP, HSTS, `X-Content-Type-Options`,
`X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy` — are on by default.

---

## RV — Respond to Vulnerabilities

*Identify residual vulnerabilities in releases and respond appropriately.*

**RV.1 — Identify vulnerabilities on an ongoing basis.** Dependabot monitors
dependencies and GitHub Actions. `npm audit --omit=dev` gates every CI run.
CodeQL runs on every push and weekly. Private reporting is available by email to
`security@ratchetgate.com` and through GitHub private vulnerability reporting,
which is enabled — both reach the maintainer directly and neither is public.
Policy: [`SECURITY.md`](../SECURITY.md).

**RV.2 — Assess, prioritise, remediate.** [`SECURITY.md`](../SECURITY.md)
commits to acknowledgement within 72 hours, an assessment within 7 days, and a
fix or a documented reason there will not be one before disclosure. Reporters
are credited by name unless they prefer otherwise.

**RV.3 — Root cause analysis.** Every defect is fixed with a test that fails
without the fix, and that failure is verified rather than assumed. Recent
examples, each with the test that now holds it: a cross-tenant leak caused by a
workspace predicate in a `FULL OUTER JOIN`'s `ON` clause; a worker loop racing
its own migration; a coverage figure that counted the test files; an assertion
message that could only ever have printed `undefined`.

**Partial:** this is per-defect analysis recorded in commit messages rather than
a periodic review looking for patterns across defects.

---

## Summary of gaps

Stated here rather than left to be inferred:

| Practice | Gap |
|---|---|
| PO.2 | Two people can act; one decides. Direction still rests on a single person. |
| PO.5 | The developer workstation is not covered by a documented hardening standard. |
| PS.2 | The release approval does not stop a single compromised admin account. |
| PS.3 | A release's files (the SBOMs) stay replaceable: releases are not locked, because the SBOM is attached after publishing. |
| RV.3 | Root cause analysis is per-defect, not periodic across defects. |

PW.2 closed on 5 September 2026; PO.2 did not, and the distinction is worth
keeping rather than rounding away. Two people can act, and a rule now puts one of
them in the path of every change — but direction still rests on a single person,
and no ruleset fixes that. The remainder is on [`ROADMAP.md`](../ROADMAP.md).

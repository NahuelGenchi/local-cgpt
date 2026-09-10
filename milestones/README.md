# local-cgpt milestones

This folder is the source of truth for the `local-cgpt` roadmap.
GitHub Milestones mirror these documents; GitHub Issues are the actionable work
inside each milestone.

## Product principle

> **Local authority must be explicit, minimal, revocable, and enforced by code or the operating system.**

`local-cgpt` is a privileged bridge between ChatGPT and a user's computer. A
prompt, model instruction, UI label, or working-directory convention is not a
security boundary. Capabilities that can read, mutate, execute, observe, or
transmit local data must fail closed when their authority cannot be proven.

Product quality follows the same discipline: presentation may simplify a workflow,
but it must not hide a materially distinct authority, invent runtime certainty, or
make documentation/UI state more authoritative than live enforcement.

## Current platform policy

**Linux is the only supported product target for the current roadmap phase.**
Inherited Windows/macOS code may remain and portability checks may continue where useful, but
non-Linux platform-specific failures do not block the Linux release. No Linux security boundary
may be weakened to preserve unsupported-platform behavior. Windows/macOS product support will get
a future milestone only if it becomes an approved goal.

The selected-model product contract is also explicit: local-cgpt must not perform model inference
through a second provider or silently substitute a model for the one selected in the user's
ChatGPT chat. Removing the existing external Goal path is planned M3 work (#62), with M8/#57
integration; this roadmap update does not claim the current runtime already meets that target.

## Roadmap at a glance

| ID | Milestone | Status | Target outcome |
| --- | --- | --- | --- |
| M0 | [Security-hardened baseline](M0-security-hardened-baseline.md) | **Complete** | Establish the fork's fail-closed Linux baseline, Linux command isolation, security regression gates, and a reviewed first-test boundary. |
| M1 | [Linux sandbox hardening and usability](M1-linux-sandbox-hardening.md) | **Current** | Make Linux containment dependable for daily use with compatibility checks, diagnostics, packaging integration, and representative runtime proof. |
| M2 | [Capability and network least privilege](M2-capability-network-least-privilege.md) | **In progress (pulled-forward work landed)** | Make local mutation, process execution, network egress, desktop access, external data transfer and trusted host-runtime authority independently explicit and enforceable. |
| M3 | [Browser and session privacy](M3-browser-session-privacy.md) | Planned | Encrypt sensitive recordings, enforce per-chat consent/revocation, remove external Goal inference, and strengthen browser-content/lifecycle privacy tests. |
| M4 | [Release provenance and signing](M4-release-provenance-signing.md) | Planned | Produce signed Linux artifacts with publisher verification, exact-commit provenance, SBOM/checksums and fail-closed publication gates. |
| M5 | [Hardened upstream maintenance](M5-hardened-upstream-maintenance.md) | Planned | Define a repeatable intake/review process for upstream changes and dependencies without silently weakening fork security guarantees. |
| M6 | [Product and repository experience](M6-product-repository-experience.md) | **In progress (pulled-forward work landed)** | Build on the renderer/cockpit foundation with accurate connectivity, accessible reading/code controls and bounded chat history/search/organization. |
| M7 | [Architecture, performance and maintainability](M7-architecture-performance-maintainability.md) | Planned | Measure and improve incremental/lazy rendering, introduce state-driven cockpit components, decompose oversized state machines and improve deterministic developer/CI feedback. |
| M8 | [Agent orchestration v2](M8-agent-orchestration-v2.md) | **In progress (pulled-forward work landed)** | Build on durable autonomy work with structured workers/scopes/dependencies and explicit succession that respects recording consent and the selected ChatGPT model. |

The broader quality rationale lives in [`docs/product-quality-plan.md`](../docs/product-quality-plan.md).
The complete seven-area review mapping and dependencies live in
[`docs/review-follow-up-2026-09-08.md`](../docs/review-follow-up-2026-09-08.md).
Milestone records remain authoritative for scope/status.

## Current milestone

**M1 — Linux sandbox hardening and usability** is the current sequential milestone.

M0 is complete: Issue #3 records the final-head CI/security/candidate and representative
Ubuntu 24.04 normal-user sandbox evidence. M0's completion does not mean the product is a
public signed production release; M1–M5 retain the later hardening/privacy/release work.

Selected M2 work was intentionally pulled forward because network-isolated command execution
created concrete daily-use blockers. Restricted GitHub transport, trusted Rust toolchain
projection and reviewed public-reference transport have landed, but those changes do not by
themselves close M2. The broader least-privilege review, migration/revocation matrix and any
remaining M2 acceptance work still belong to M2. M2 remains in progress while M1 is current.

M6 has landed focused synchronization, worker-instruction, accessibility, Home and identity slices
(#47/#49/#51/#53/#55 and their PRs). M8 has landed the durable-autonomy slice in PR #58, while its
tracking issue #57 remains open. Neither milestone is complete: their remaining scope and evidence
must be tracked explicitly rather than describing them as wholly planned or wholly finished.

M6–M8 work may be pulled forward when explicitly tracked and when it does not relax M1–M5
security contracts. Do not use a UX/performance/agent milestone to bypass current security/release
gates. Existing merged implementation and newly added acceptance requirements are different facts.

## September 8 review priorities and issues

Planning tracker: [#59](https://github.com/NahuelGenchi/local-cgpt/issues/59).
The following priorities apply within this follow-up backlog, not as a silent reordering of M1–M8:

1. Recording privacy and provider removal: M3 #60 (encryption), #61 (per-chat consent), #62
   (selected ChatGPT model only), with M8/#57 integration.
2. Release integrity: M4 #64 (signed Linux artifacts and verifiable provenance).
3. Connection reliability: M6 #68 (Cloudflare monitoring/recovery and manual readiness evidence).
4. Chat/renderer usability: M7 #65 (incremental/lazy histories), #66 (state-driven cockpit), and
   M6 #67 (keyboard/reading controls), #69 (text/code format), #70 (bounded history/search/grouping).

M3 #63 (adversarial/fuzz sanitizer coverage) is a security prerequisite for #69. A verified security
vulnerability takes priority and follows private reporting. M3's existing dependency on M2 and M4's
release-readiness dependency on M3 remain intact. Independent design/test work can run in parallel
without granting new runtime authority or enabling publication.

All seven review areas are covered by the linked addendum. Each implementation issue has its own
acceptance checklist, scope and evidence; completing the planning PR does not complete those issues.

## GitHub tracking contract

Every live roadmap milestone must have one matching GitHub Milestone with the
same ID/title. Every implementation change — including documentation, tests,
CI, security work, refactors, and independently reviewable follow-ups found
during investigation — must have a GitHub Issue assigned to the correct
milestone before implementation starts.

Required workflow:

1. Read this roadmap and inspect open GitHub Milestones/Issues.
2. Select the milestone that owns the requested behavior.
3. If the matching GitHub Milestone is missing, create/synchronize it before filing implementation work.
4. Create one focused Issue per independently reviewable change, titled `M<N>: <imperative summary>`.
5. Use a focused branch, push it early, and open a draft PR after the first meaningful commit.
6. Keep the Issue, milestone record, and draft PR synchronized with material discoveries, blockers, and scope changes.
7. Close Issues only through the merged PR after acceptance criteria pass, or explicitly as superseded/not-planned with a pointer to the replacement.
8. Close a milestone only when its required Issues and completion evidence are complete, or mark it superseded with the same discipline.

If no documented milestone genuinely fits a user-approved change, define the
next milestone, add its `milestones/M<n>-*.md` record and roadmap row, and
synchronize the matching GitHub Milestone before implementation. Do not make an
unrelated current milestone unclosable by dumping arbitrary work into it.

## Milestone synchronization health

The historical object/string lookup defect was repaired in PR #48, merged September 4, 2026.
The current synchronizer declares M0–M8. M8's live milestone is attached to #57, and the new
review issues were successfully assigned to the existing M3/M4/M6/M7 milestone objects.
The old statement that M6–M8 are all missing is no longer an accurate current blocker.

This is not a claim that the entire live mirror was reverified. The connected GitHub interface used
for #59 exposes issue assignment and repository edits but not milestone-description mutation or
workflow dispatch; its generic fetch also rejects the milestone collection endpoint. Updated
scope/status descriptions are carried in `scripts/sync-github-milestones.sh` as planning metadata.
They remain pending owner-approved PR merge and a verified run of the existing synchronizer.

After that run, verify M0–M8 titles, descriptions and states and check idempotence. Keep M0 closed
and M1–M8 open unless their completion evidence changes. Do not confuse a successful issue
assignment with verification of the complete milestone mirror.

## Bootstrap history

GitHub Issues were disabled when PRs #1 and #2 were created. After Issues were
enabled, Issues #3 and #4 were created and assigned to M0, and GitHub Milestones
#1–#6 were synchronized from this roadmap. Those are the documented one-time bootstrap
exceptions; they are not a general exception to milestone-bound implementation work.

Issue #45 / PR #46 introduced M6–M8 while synchronization was blocked. Issue #47 / PR #48
subsequently repaired the synchronizer. Preserve that history without presenting the historical
failure as an unresolved current implementation defect.

## Scope discipline

Milestone IDs express tracking identity; roadmap order expresses the default sequence.
Security defects that require urgent correction and narrowly scoped product correctness fixes may
be pulled forward, but the roadmap and GitHub tracking must record that decision rather than silently
changing scope. Parallel work is acceptable only where dependencies and security contracts make the
independence explicit.

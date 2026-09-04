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

## Roadmap at a glance

| ID | Milestone | Status | Target outcome |
| --- | --- | --- | --- |
| M0 | [Security-hardened baseline](M0-security-hardened-baseline.md) | **Complete** | Establish the fork's fail-closed Linux baseline, Linux command isolation, security regression gates, and a reviewed first-test boundary. |
| M1 | [Linux sandbox hardening and usability](M1-linux-sandbox-hardening.md) | **Current** | Make Linux containment dependable for daily use with compatibility checks, diagnostics, packaging integration, and representative runtime proof. |
| M2 | [Capability and network least privilege](M2-capability-network-least-privilege.md) | **In progress (pulled-forward work landed)** | Make local mutation, process execution, network egress, desktop access, external data transfer and trusted host-runtime authority independently explicit and enforceable. |
| M3 | [Browser and session privacy](M3-browser-session-privacy.md) | Planned | Minimize sensitive browser/session retention, make external processing obvious, and provide verifiable lifecycle/deletion controls. |
| M4 | [Release provenance and signing](M4-release-provenance-signing.md) | Planned | Produce reviewable releases with provenance, SBOM/checksums, hardened packaging gates, and publisher signing where applicable. |
| M5 | [Hardened upstream maintenance](M5-hardened-upstream-maintenance.md) | Planned | Define a repeatable intake/review process for upstream changes and dependencies without silently weakening fork security guarantees. |
| M6 | [Product and repository experience](M6-product-repository-experience.md) | Planned | Make the repository and app coherent, accessible, responsive and trustworthy while fixing user-facing correctness/documentation drift. |
| M7 | [Architecture, performance and maintainability](M7-architecture-performance-maintainability.md) | Planned | Decompose oversized state machines, measure runtime costs, minimize dormant feature work, and improve deterministic developer/CI feedback. |
| M8 | [Agent orchestration v2](M8-agent-orchestration-v2.md) | Planned | Add structured worker results/scopes/dependencies, logical worker succession and, only after isolation is proven, bounded multi-prime scheduling. |

The cross-cutting rationale and September 2026 review mapping for M6–M8 live in
[`docs/product-quality-plan.md`](../docs/product-quality-plan.md). Milestone records remain authoritative
for scope/status.

## Current milestone

**M1 — Linux sandbox hardening and usability** is the current sequential milestone.

M0 is complete: Issue #3 records the final-head CI/security/candidate and representative
Ubuntu 24.04 normal-user sandbox evidence. M0's completion does not mean the product is a
public signed production release; M1–M5 retain the later hardening/privacy/release work.

Selected M2 work was intentionally pulled forward because network-isolated command execution
created concrete daily-use blockers. Restricted GitHub transport, trusted Rust toolchain
projection and reviewed public-reference transport have landed, but those changes do not by
themselves close M2. The broader least-privilege review, migration/revocation matrix and any
remaining M2 acceptance work still belong to M2. M2 therefore remains in progress while M1 is
current rather than being incorrectly described as wholly planned or wholly complete.

M6–M8 are the next product-quality/agent evolution sequence. High-confidence correctness fixes
from those milestones may be pulled forward when explicitly tracked and when they do not relax
M1–M5 security contracts. Do not use a UX/performance/agent milestone as a reason to bypass the
current security/release gates.

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

The GitHub Milestone mirror is infrastructure, not the source of truth, but a broken mirror is
still a tracking defect. The `Milestone sync` workflow on `main` failed on August 31, 2026 in
`scripts/sync-github-milestones.sh` with an object/string parsing error. Until that is repaired:

- do not claim a newly documented milestone has been synchronized merely because its Markdown exists;
- treat missing/outdated GitHub Milestone objects as a visible governance blocker;
- track the synchronizer repair as focused M6 correctness work;
- after repair, run the synchronizer idempotently and verify M0–M8 titles/descriptions/state rather
  than manually editing only the newest entries.

Issue #45 / PR #46 define M6–M8 in the repository roadmap. The connected GitHub interface used for
that documentation update does not expose GitHub Milestone creation, so the matching GitHub objects
remain explicitly pending synchronization instead of being reported as complete.

## Bootstrap history

GitHub Issues were disabled when PRs #1 and #2 were created. After Issues were
enabled, Issues #3 and #4 were created and assigned to M0, and GitHub Milestones
#1–#6 were synchronized from this roadmap. Those are the documented one-time bootstrap
exceptions; the current M6 synchronization blocker above is an infrastructure limitation to be
repaired, not a new general exception to milestone-bound implementation work.

## Scope discipline

Milestone IDs express tracking identity; roadmap order expresses the default sequence.
Security defects that require urgent correction and narrowly scoped product correctness fixes may
be pulled forward, but the roadmap and GitHub tracking must record that decision rather than silently
changing scope. Parallel work is acceptable only where dependencies and security contracts make the
independence explicit.

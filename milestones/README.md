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

## Roadmap at a glance

| ID | Milestone | Status | Target outcome |
| --- | --- | --- | --- |
| M0 | [Security-hardened baseline](M0-security-hardened-baseline.md) | **Current** | Establish the fork's fail-closed baseline, Linux command isolation, security regression gates, and a reviewed release boundary. |
| M1 | [Cross-platform command containment](M1-cross-platform-command-containment.md) | Planned | Give supported Windows/macOS command execution an OS-enforced containment story instead of falling back to full-account authority. |
| M2 | [Capability and network least privilege](M2-capability-network-least-privilege.md) | Planned | Make local mutation, process execution, network egress, desktop access, and external data transfer independently explicit and enforceable. |
| M3 | [Browser and session privacy](M3-browser-session-privacy.md) | Planned | Minimize sensitive browser/session retention, make external processing obvious, and provide verifiable lifecycle/deletion controls. |
| M4 | [Release provenance and signing](M4-release-provenance-signing.md) | Planned | Produce reviewable releases with provenance, SBOM/checksums, hardened packaging gates, and publisher signing/notarization where credentials exist. |
| M5 | [Hardened upstream maintenance](M5-hardened-upstream-maintenance.md) | Planned | Define a repeatable intake/review process for upstream changes and dependencies without silently weakening fork security guarantees. |

## Current milestone

**M0 — Security-hardened baseline** is current.

The pre-roadmap security work already underway in draft PR #1 is retroactively
owned by M0. This is a one-time bootstrap exception: once this governance system
lands, every new implementation change must have its milestone-bound Issue
before tracked files are edited.

M0 is complete only when its final-head validation and documented release gate
are accurate. A passing subset of tests is evidence for that subset, not a
substitute for the milestone's complete acceptance criteria.

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

## Bootstrap exception

This repository had GitHub Issues disabled when the tracking system was
introduced. The governance branch/PR therefore necessarily predates its own
bootstrap Issue. Enable repository Issues, create the governance Issue, and run
`scripts/sync-github-milestones.sh` (or the milestone-sync workflow) before this
bootstrap is considered complete.

## Scope discipline

Milestone IDs express tracking identity; roadmap order expresses sequence.
Security defects that require urgent correction may be pulled forward, but the
roadmap and GitHub tracking must record that decision rather than silently
changing scope.

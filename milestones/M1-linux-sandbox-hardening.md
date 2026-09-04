# M1 — Linux sandbox hardening and usability

**Status:** Current

**Depends on:** M0 (complete)

## Goal

Turn the first secure Linux command sandbox into a dependable daily-use boundary with clear
compatibility checks, actionable diagnostics, packaging integration, and representative runtime
proof without weakening the fail-closed model established by M0.

## Current sequencing note

M1 is the current sequential milestone after M0 completion. Selected M2 work was intentionally
pulled forward because the network-isolated command boundary created concrete daily-use blockers
for GitHub workflow, Rust toolchains and reviewed public engineering references. Those landed M2
slices do not close M1 and must not be used to skip M1's compatibility/usability acceptance.

## Scope

- Detect Bubblewrap/user-namespace/network-namespace support before command execution and surface actionable diagnostics.
- Keep approved project roots as the explicit writable filesystem authority boundary.
- Preserve private home/temp, stripped ambient credentials, and network-denied execution by default.
- Add representative target-Linux runtime tests for filesystem escape attempts, environment leakage, process lifecycle, and network denial.
- Make Debian/Ubuntu installation/package guidance install or clearly require the sandbox prerequisites.
- Verify packaged Linux builds use the same containment path as development builds.
- Improve sandbox failure reporting without exposing host secrets, paths, or credentials unnecessarily.
- Preserve deterministic terminal/session semantics through the containment layer.
- Reconcile the supported Linux compatibility matrix with the real packaged candidate rather than assuming one successful M0 host proves broader distribution readiness.

## Contracts

- A working directory is not containment.
- Application path validation is defense in depth; command isolation remains OS-enforced.
- Missing or incompatible sandbox support fails closed.
- Hosted CI limitations are recorded as limitations rather than worked around by weakening production policy.
- Linux security and usability take priority over inherited cross-platform abstractions during this product phase.
- Later product/UX/performance work in M6–M8 may improve presentation or diagnostics but cannot weaken this milestone's sandbox boundary.

## Completion direction

M1 should close only with an explicit inventory of supported Linux host prerequisites, actionable
failure diagnostics, packaged/runtime parity evidence and representative normal-user target proof.
A convenient UI or successful M2 remote workflow is not evidence that the command sandbox itself is
dependable on the supported Linux target set.

## Out of scope

- User-grantable command network egress and broader capability decomposition, which are M2.
- Browser/session privacy lifecycle redesign, release signing/provenance and upstream intake policy, which are M3–M5.
- Repository/app visual redesign and agent-orchestration architecture, which are M6–M8.
- Windows/macOS product support or command-containment parity; define a future milestone only if those platforms become an approved product target.

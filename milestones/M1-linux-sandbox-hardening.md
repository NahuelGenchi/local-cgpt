# M1 — Linux sandbox hardening and usability

**Status:** Planned

**Depends on:** M0

## Goal

Turn the first secure Linux command sandbox into a dependable daily-use boundary with clear
compatibility checks, actionable diagnostics, packaging integration, and representative runtime
proof without weakening the fail-closed model established by M0.

## Scope

- Detect Bubblewrap/user-namespace/network-namespace support before command execution and surface actionable diagnostics.
- Keep approved project roots as the explicit writable filesystem authority boundary.
- Preserve private home/temp, stripped ambient credentials, and network-denied execution by default.
- Add representative target-Linux runtime tests for filesystem escape attempts, environment leakage, process lifecycle, and network denial.
- Make Debian/Ubuntu installation/package guidance install or clearly require the sandbox prerequisites.
- Verify packaged Linux builds use the same containment path as development builds.
- Improve sandbox failure reporting without exposing host secrets, paths, or credentials unnecessarily.
- Preserve deterministic terminal/session semantics through the containment layer.

## Contracts

- A working directory is not containment.
- Application path validation is defense in depth; command isolation remains OS-enforced.
- Missing or incompatible sandbox support fails closed.
- Hosted CI limitations are recorded as limitations rather than worked around by weakening production policy.
- Linux security and usability take priority over inherited cross-platform abstractions during this product phase.

## Out of scope

- User-grantable command network egress and broader capability decomposition, which are M2.
- Windows/macOS product support or command-containment parity; define a future milestone only if those platforms become an approved product target.

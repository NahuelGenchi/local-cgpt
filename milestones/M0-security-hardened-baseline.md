# M0 — Security-hardened baseline

**Status:** Current

**Depends on:** none

## Goal

Establish a reviewable **Linux-first** security baseline for this fork before broader feature
work: safe first-launch behavior, minimized ambient authority, OS-enforced Linux command
containment, explicit security regression gates, and accurate public security documentation.

## Current platform policy

Linux is the only supported product target during the current phase. Windows and macOS code may
remain in the inherited codebase and may receive best-effort portability coverage, but they are
not release targets and their platform-specific behavior does not block M0. Where a hardened
Linux-only capability has no safe backend on another platform, it must fail closed rather than
fall back to unrestricted execution.

## Scope

- Fresh-install and corrupt-config recovery fail closed.
- Model-facing capabilities are opt-in; read-only is the safe initial state.
- Session recording, automatic continuation/compaction, multi-agent operation,
  Goal mode, and other data-expanding features are disabled until explicitly enabled.
- Generic child processes do not inherit ambient credential-like environment variables.
- Linux command execution uses an OS-enforced sandbox with approved roots as the
  only writable host mounts, a private home/tmp, reduced environment, and no host network access.
- Missing or incompatible Linux sandbox support denies command execution.
- Security CI covers defaults, privacy, dependency audit, extension host origins,
  command-sandbox policy, and real Linux filesystem/environment containment.
- Production policy continues to require network isolation even when a hosted CI runner cannot
  itself create a nested network namespace; that runner limitation must be reported explicitly.
- The security audit and user-facing documentation describe the implemented boundary accurately.
- Final-head Linux CI and the Linux security gate are green before merge.

## Contracts

- Prompt/model instructions are never treated as a security boundary.
- Existing explicit user choices may be preserved unless a vulnerability requires revocation.
- Test harnesses opt into capabilities they exercise; production defaults are never weakened merely to satisfy tests.
- A missing sandbox backend is an execution denial, not permission to fall back.
- Command network isolation remains required by production M0 policy; M2 owns user-grantable network egress as a separate capability.
- Security evidence distinguishes policy/unit proof, hosted-runner integration proof, and target-machine runtime proof.
- Non-Linux failures cannot be used as a reason to weaken the Linux security model.

## Completion evidence

Draft PR #1 contains the pre-roadmap M0 implementation and is retroactively tracked by Issue #3.
The PR remains draft until its final Linux head satisfies this record and its CI/security/user-facing
documentation evidence is synchronized.

## Out of scope

- Linux sandbox compatibility hardening, diagnostics, packaging integration, and usability beyond the first secure baseline (M1).
- Independent user-granted network-egress permissions and broader capability decomposition (M2).
- Session/browser data lifecycle redesign (M3).
- Publisher signing/provenance beyond the M0 review boundary (M4).
- Windows/macOS product support and command-containment parity; define a future milestone if/when those platforms become a product target.

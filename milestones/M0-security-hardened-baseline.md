# M0 — Security-hardened baseline

**Status:** Complete

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
- Packaged renderer loading and privileged IPC are bound to trusted app content/current main-frame identity.
- Hardened Electron runtime state and Linux install identity are separate from upstream.
- Security CI covers defaults, privacy, dependency audit, extension host origins,
  command-sandbox policy, and execution of the exact production Bubblewrap profile.
- Because GitHub's hosted Azure worker restricts unprivileged nested namespace setup, CI may
  execute that exact profile with runner-root privileges; this is not a substitute for the
  required normal-user target-Linux acceptance check.
- The security audit and user-facing documentation describe the implemented boundary accurately.
- Final-head Linux CI and the Linux security gate are green before merge.

## Contracts

- Prompt/model instructions are never treated as a security boundary.
- Explicit choices made within the hardened fork may be preserved unless a vulnerability requires revocation; upstream application state is not implicitly imported.
- Test harnesses opt into capabilities they exercise; production defaults are never weakened merely to satisfy tests.
- A missing sandbox backend is an execution denial, not permission to fall back.
- Command network isolation remains required by production M0 policy; M2 owns distinct user-granted network/external-data authorities.
- Security evidence distinguishes policy/unit proof, hosted-runner privileged integration proof, and target-machine normal-user runtime proof.
- Non-Linux failures cannot be used as a reason to weaken the Linux security model.

## Completion evidence

M0 is complete. Issue #3 records the accepted baseline and exact evidence, including:

- frozen hardened baseline SHA `a1cd0d02e6abab75dd20402a2822e41cc8c6a408`;
- successful final-head Linux CI, Security and controlled Linux candidate runs;
- a source-identified Linux x64 candidate artifact/checksum/test-instructions bundle;
- successful Ubuntu 24.04.4 normal-user execution of the exact production Bubblewrap profile with
  approved-root, environment and network-isolation assertions;
- AppArmor's global unprivileged-userns restriction left enabled; and
- no sudo/root execution of application commands required for representative target proof.

Subsequent work has landed on `main`; M0 remains the historical baseline rather than the mutable
"current" milestone. Later milestones may strengthen it but must not silently redefine what M0
claimed to prove.

M0 completion is a controlled first-test/security baseline, not a claim that a public signed
production release exists. M1–M5 retain compatibility, least-privilege, privacy, provenance and
maintenance work.

## Out of scope

- Linux sandbox compatibility hardening, diagnostics, packaging integration, and usability beyond the first secure baseline (M1).
- Independent user-granted network/external-data permissions and broader capability decomposition (M2).
- Session/browser data lifecycle redesign (M3).
- Publisher signing/provenance beyond the M0 review boundary (M4).
- Windows/macOS product support and command-containment parity; define a future milestone if/when those platforms become a product target.
- Product/repository UX polish, internal performance architecture and Agent v2 orchestration, now tracked by M6–M8.

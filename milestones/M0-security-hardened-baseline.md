# M0 — Security-hardened baseline

**Status:** Current

**Depends on:** none

## Goal

Establish a reviewable security baseline for this fork before broader feature
work: safe first-launch behavior, minimized ambient authority, OS-enforced Linux
command containment, explicit security regression gates, and accurate public
security documentation.

## Scope

- Fresh-install and corrupt-config recovery fail closed.
- Model-facing capabilities are opt-in; read-only is the safe initial state.
- Session recording, automatic continuation/compaction, multi-agent operation,
  Goal mode, and other data-expanding features are disabled until explicitly enabled.
- Generic child processes do not inherit ambient credential-like environment variables.
- Linux command execution uses an OS-enforced sandbox with approved roots as the
  only writable host mounts, a private home/tmp, reduced environment, and no network namespace.
- Unsupported command-sandbox platforms fail closed rather than silently executing with full user authority.
- Security CI covers defaults, privacy, dependency audit, extension host origins,
  command-sandbox policy, and a real Linux sandbox smoke test.
- The security audit and user-facing documentation describe the implemented boundary accurately.
- Full supported-platform CI is green on the final PR head before merge.

## Contracts

- Prompt/model instructions are never treated as a security boundary.
- Existing explicit user choices may be preserved unless a vulnerability requires revocation.
- Test harnesses opt into capabilities they exercise; production defaults are never weakened merely to satisfy tests.
- A missing sandbox backend is an execution denial, not permission to fall back.
- Security evidence distinguishes unit/CI proof from manual/runtime proof.

## Completion evidence

Draft PR #1 contains the pre-roadmap M0 implementation and is retroactively
tracked by this milestone. The PR remains draft until its final head satisfies
this record and its CI/release evidence is synchronized.

## Out of scope

- Windows/macOS OS command containment beyond fail-closed denial (M1).
- Independent network-egress permissions and broader capability decomposition (M2).
- Session/browser data lifecycle redesign (M3).
- Publisher signing/notarization and full release provenance (M4).

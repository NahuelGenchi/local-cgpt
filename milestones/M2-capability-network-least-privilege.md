# M2 — Capability and network least privilege

**Status:** Planned

**Depends on:** M1

## Goal

Make each materially different kind of local or remote authority independently
visible, grantable, revocable, and enforced at the narrowest practical boundary.

## Scope

- Separate command execution authority from command network egress.
- Review file read, file write, command, session, agent, desktop, clipboard, and external-provider permissions for least-privilege composition.
- Treat user-installed compiler/toolchain access as narrow host executable/read authority: expose only validated, read-only runtime roots needed by the sandbox, never the user's real HOME or credential/config state. Initial tracked work is Issue #38 for rustup-managed Rust.
- Ensure revocation takes effect immediately even when ChatGPT has cached an older tool schema.
- Make migrations conservative: newly introduced authority is never silently granted to an existing installation.
- Inventory expected remote destinations and fail security review when a new destination is introduced without an explicit contract.
- Add regression tests for permission combinations, revocation, migration, network-denied execution, and trusted runtime provenance.

## Contracts

- Capability discovery is descriptive; live enforcement is authoritative.
- One useful permission never implicitly grants a distinct higher-impact permission.
- New authority defaults off.
- Network access is treated as data egress, not merely as a shell implementation detail.
- User toolchains may become executable authority only through trusted application discovery and read-only sandbox projection; model/project inputs cannot nominate arbitrary host runtime paths.

## Out of scope

Browser transcript/session retention and external-model disclosure UX, which are M3.

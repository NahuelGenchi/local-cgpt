# M2 — Capability and network least privilege

**Status:** Planned

**Depends on:** M1

## Goal

Make each materially different kind of local or remote authority independently
visible, grantable, revocable, and enforced at the narrowest practical boundary.

## Scope

- Separate command execution authority from command network egress.
- Review file read, file write, command, session, agent, desktop, clipboard, and external-provider permissions for least-privilege composition.
- Ensure revocation takes effect immediately even when ChatGPT has cached an older tool schema.
- Make migrations conservative: newly introduced authority is never silently granted to an existing installation.
- Inventory expected remote destinations and fail security review when a new destination is introduced without an explicit contract.
- Add regression tests for permission combinations, revocation, migration, and network-denied execution.

## Contracts

- Capability discovery is descriptive; live enforcement is authoritative.
- One useful permission never implicitly grants a distinct higher-impact permission.
- New authority defaults off.
- Network access is treated as data egress, not merely as a shell implementation detail.

## Out of scope

Browser transcript/session retention and external-model disclosure UX, which are M3.

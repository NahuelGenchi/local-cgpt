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
- Repository/project content is untrusted input and cannot nominate or parameterize a network destination.
- A read-only network feature must expose only the minimum request authority it actually needs; it must not inherit browser cookies, user credentials, proxy credentials, shell networking, or a general URL fetch primitive.

## Tracked work

- Issue #40 adds a separate default-off public-engineering-reference capability. The model selects an application-owned reference id, while trusted local-cgpt code owns the exact HTTPS destination catalog. `exec_command` remains network-isolated; repository text cannot add a destination; DNS/redirect/response policy fails closed; and live capability checks remain authoritative after schema caching.

## Out of scope

Browser transcript/session retention and external-model disclosure UX, which are M3.

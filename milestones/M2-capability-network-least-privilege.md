# M2 — Capability and network least privilege

**Status:** Planned

**Depends on:** M1

## Goal

Make each materially different kind of local or remote authority independently
visible, grantable, revocable, and enforced at the narrowest practical boundary.

## Scope

- Separate command execution authority from every network-egress authority; ordinary `exec_command` remains offline.
- Keep restricted GitHub transport behind its own capability. Repository identity must be derived from an approved local workspace rather than a model-supplied repository/URL, and the reviewed action set must not expose merge or force-push authority.
- Keep reviewed public engineering-reference access behind its own default-off `publicReference` capability. The model may select only application-owned catalog ids; it cannot supply or parameterize URL/host/path/query/header/body/method/size authority. Local reference-search terms must never be sent over the network.
- Review file read, file write, command, session, agent, desktop, clipboard, GitHub, public-reference, and other external-provider permissions for least-privilege composition.
- Treat user-installed compiler/toolchain access as narrow host executable/read authority: expose only validated, read-only runtime roots needed by the sandbox, never the user's real HOME or credential/config state. Initial tracked work is Issue #38 for rustup-managed Rust.
- Ensure revocation takes effect immediately even when ChatGPT has cached an older tool schema.
- Make migrations conservative: newly introduced authority is never silently granted to an existing installation.
- Inventory expected remote destinations and fail security review when a new destination is introduced without an explicit contract.
- Add regression tests for permission combinations, revocation, migration, network-denied execution, SSRF/redirect handling, exact destination authority, and trusted runtime provenance.

## Contracts

- Capability discovery is descriptive; live enforcement is authoritative.
- One useful permission never implicitly grants a distinct higher-impact permission.
- New authority defaults off.
- Network access is treated as data egress, not merely as a shell implementation detail.
- Granting `local_github` or `reference_web` never grants network access to ordinary shell commands or to the other transport.
- GitHub authority is repository-scoped by approved local provenance; credentials remain application-side and are not exposed to the command sandbox or model.
- Public-reference authority comes only from the immutable application-owned catalog. DNS/address validation, pinned TLS, bounded same-host redirects, textual-response limits and explicit untrusted-content labeling remain part of the transport boundary.
- Repository/project/model text may recommend a reviewed reference id but cannot extend network authority.
- User toolchains may become executable authority only through trusted application discovery and read-only sandbox projection; model/project inputs cannot nominate arbitrary host runtime paths.

## Out of scope

Browser transcript/session retention and external-model disclosure UX, which are M3.

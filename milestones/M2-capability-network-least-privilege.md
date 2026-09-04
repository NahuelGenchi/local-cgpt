# M2 — Capability and network least privilege

**Status:** In progress (selected work pulled forward and landed)

**Depends on:** M1 for milestone closure; narrow blockers may land earlier when explicitly tracked

## Goal

Make each materially different kind of local or remote authority independently
visible, grantable, revocable, and enforced at the narrowest practical boundary.

## Landed pulled-forward slices

The current `main` already contains several M2 capabilities that were intentionally implemented
before M1 closure because the hardened offline command sandbox created concrete daily-use blockers:

- restricted `local_github` repository transport with separate default-off network authority;
- trusted read-only projection of supported rustup-managed Rust toolchains/public crates.io cache
  state into the Linux command sandbox without exposing the real HOME/credentials or restoring
  command networking; and
- separate default-off `publicReference` authority plus `reference_web`, whose application-owned
  catalog controls exact reviewed destinations while search phrases remain local.

These landed slices are evidence of M2 progress, not evidence that the complete least-privilege
milestone is closed. The broader capability composition/migration/revocation/destination review below
still needs explicit completion evidence.

## Scope

- Separate command execution authority from every network-egress authority; ordinary `exec_command` remains offline.
- Keep restricted GitHub transport behind its own capability. Repository identity must be derived from an approved local workspace rather than a model-supplied repository/URL, and the reviewed action set must not expose merge or force-push authority.
- Keep reviewed public engineering-reference access behind its own default-off `publicReference` capability. The model may select only application-owned catalog ids; it cannot supply or parameterize URL/host/path/query/header/body/method/size authority. Local reference-search terms must never be sent over the network.
- Review file read, file write, command, session, agent, desktop, clipboard, GitHub, public-reference, and other external-provider permissions for least-privilege composition.
- Treat user-installed compiler/toolchain access as narrow host executable/read authority: expose only validated, read-only runtime roots needed by the sandbox, never the user's real HOME or credential/config state. Initial tracked work covered rustup-managed Rust.
- Ensure revocation takes effect immediately even when ChatGPT has cached an older tool schema.
- Make migrations conservative: newly introduced authority is never silently granted to an existing installation.
- Inventory expected remote destinations and fail security review when a new destination is introduced without an explicit contract.
- Add/retain regression tests for permission combinations, revocation, migration, network-denied execution, SSRF/redirect handling, exact destination authority, and trusted runtime provenance.
- Audit UI/docs naming so distinct external authorities are understandable without implying that command, GitHub and reviewed-reference networking are interchangeable.

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
- Product/UX presets introduced later under M6 may compose these capabilities only by showing/applying an explicit delta; they never become a parallel authorization system.
- Agent scopes introduced later under M8 can only narrow these authorities for a worker, never widen the user's grant.

## Completion direction

Before M2 closes, reconcile the complete effective-capability matrix (including read-only masking),
upgrade/default migration behavior, cached-schema live revocation, remote destination inventory and
user-facing permission descriptions. Confirm the landed GitHub/reference/toolchain slices still meet
their security contracts when composed with the rest of the app rather than treating their focused
PR tests as the whole milestone.

## Out of scope

- Browser transcript/session retention and external-model disclosure UX, which are M3.
- Repository/app visual redesign and documentation presentation beyond truthful capability naming,
  which are M6.
- Agent worker-scoped narrowing/orchestration, which is M8 and must build on M2 rather than create
  another authority plane.

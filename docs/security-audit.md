# Security audit — hardened baseline

## Audit baseline

This fork started from upstream `totec448-spec/chat-on-steroids` v2.0.2 at commit:

`e254b954eb6570c52f2e7cc059700deff1214a9b`

Security work should remain reviewable as a diff from that immutable baseline.

## Security objective

The product is unusually privileged by design: it can expose local files, local commands, browser conversation state and (on Windows) desktop control to a remote model through MCP. The security objective of this fork is therefore **deny by default, explicit grant, least privilege, and fail closed**.

A feature being useful is not itself consent to enable it.

## Current findings

### HIGH — model-launched commands run with the logged-in OS user's authority

**Status: OPEN, mitigated by default-off permission.**

`exec_command` launches native shells/processes as the normal logged-in user. Starting the command in an approved project directory does not confine the process to that directory. A command can attempt to access any file, credential store, browser profile, network endpoint or device available to that OS account.

The hardened baseline changes first-launch behavior so command execution is disabled and read-only mode is enabled. This prevents accidental exposure on a fresh installation, but it is not an OS sandbox.

Required follow-up: isolate command execution at the operating-system boundary. Linux should use a dedicated sandbox (for example namespaces/bubblewrap and, where practical, Landlock) with only explicitly approved project roots mounted. Network access should be a separate permission. Windows and macOS need equivalent platform-specific containment before unrestricted command execution can be described as sandboxed.

### HIGH — inherited environment variables may contain unrelated credentials

**Status: MITIGATED in the hardened baseline.**

Upstream already removed a small fixed set of application/control-plane secrets. This fork additionally scrubs inherited credential-like variables before generic child processes are created, including common token/API-key/password/private-key/client-secret patterns plus SSH/GPG askpass/agent sockets and common cloud/Kubernetes credential pointers.

Internal processes that legitimately require a credential can add that specific value explicitly after normalization; the protection is against ambient credentials being inherited merely because Electron was launched from a credential-bearing terminal.

Regression tests cover GitHub, Anthropic, AWS and generic secret/key/password patterns while confirming ordinary development variables remain available.

This does not replace OS sandboxing: a process with normal user filesystem authority may still discover credentials stored on disk.

### HIGH — browser extension can observe ChatGPT page content

**Status: MITIGATED, inherent capability.**

The companion extension runs content scripts on `chatgpt.com` and `chat.openai.com`. That access is required for transcript capture, Compact & Resume and worker coordination, but it means the extension is part of the trusted computing base for conversation privacy.

The hardened baseline disables session recording, automatic compaction and multi-agent operation on first launch. Installing/enabling the browser extension remains an explicit user action.

The security workflow also pins the expected extension host-permission set and fails if a new remote origin is added without review.

### MEDIUM/HIGH — optional Goal mode sends conversation text to OpenRouter

**Status: MITIGATED by explicit opt-in.**

Goal mode sends authored user messages and final ChatGPT answers to OpenRouter so a second model can decide whether to continue the chat. It does not need local file/tool payloads for that decision, but conversation text is still external data transfer.

Goal mode is disabled by default. It must remain opt-in and the UI/documentation should clearly identify the external provider and data category before activation.

### MEDIUM — recorded session history is sensitive local data

**Status: MITIGATED by default-off recording.**

Session recording writes detailed conversation/tool history to local application storage and is not protected by the OS credential encryption used for API keys. Anyone able to read the user's local application data may be able to read those records.

The hardened baseline changes first-launch recording from enabled to disabled. If recording is enabled later, retention should stay bounded and deletion should be easy and verifiable.

### MEDIUM — release binaries are unsigned / supply-chain trust is material

**Status: OPEN.**

A user who downloads a prebuilt privileged desktop application must trust the release pipeline and the produced binary, not merely the visible TypeScript source.

For this fork, releases should be built from reviewed commits through GitHub Actions, accompanied by checksums and an SBOM where feasible. Dependency and source verification must run before packaging. Code signing/notarization should be added when signing identities are available.

## Positive controls inherited from upstream

The audit found several useful security controls worth retaining:

- Filesystem primitives resolve approved roots through canonical real paths and defend against symlink/junction escapes.
- Secret storage uses Electron `safeStorage`; Linux refuses the insecure hard-coded-key fallback.
- MCP/extension bridge services bind to loopback and use bearer/tokenized paths.
- Model-facing filesystem writes are gated by explicit capabilities and read-only mode.
- Child process launching avoids `shell: true` in the direct execution helper and bounds command output/time.
- The repository includes a privacy-history verification gate after a previous Git-metadata privacy incident.

These controls reduce risk but do not make arbitrary command execution equivalent to a sandbox.

## First hardened baseline changes

Fresh installations now start with:

- all model-facing capabilities disabled;
- read-only mode enabled;
- session recording disabled;
- automatic Compact & Resume disabled;
- multi-agent mode disabled;
- Goal mode disabled.

Additionally, generic child environments now scrub ambient credential-like variables before process launch.

Existing stored choices are preserved. A security update should not silently rewrite a user's explicit permission choices unless a vulnerability requires revocation.

## Network / data-flow inventory

Expected remote destinations should be narrowly explainable:

- OpenAI: MCP Secure Tunnel / ChatGPT service integration when configured.
- Cloudflare: only when the user selects the Cloudflare tunnel option.
- OpenRouter: only when the user explicitly enables Goal mode and supplies a key.
- GitHub: build-time retrieval of pinned helper binaries/dependencies and normal repository/release operations.
- ChatGPT web origins: browser extension content-script scope.
- Loopback (`127.0.0.1`): local app/extension bridge.

Adding a new remote destination is security-sensitive and should require explicit review and documentation.

## Threat model

### Assets to protect

- personal files outside approved project roots;
- browser profiles, cookies and authenticated sessions;
- SSH/GPG keys and cloud credentials;
- API tokens and environment variables;
- ChatGPT conversation content;
- clipboard/desktop contents;
- source repositories and Git credentials.

### Main attackers / failure modes

- malicious or compromised upstream dependency;
- malicious code introduced through an upstream update;
- prompt injection causing an otherwise legitimate model to issue harmful tool calls;
- a compromised ChatGPT page/extension context;
- unsafe command generated accidentally by a model;
- local malware racing application-level path checks;
- compromised release artifacts or CI dependencies.

### Security boundary rule

Prompt instructions are not a security boundary. Anything that must be forbidden must be enforced in code or by the operating system.

## Release gate

Before a hardened release is considered suitable for normal use:

1. CI/type/tests/privacy checks pass on supported operating systems.
2. Production dependency audit has no unresolved high/critical vulnerability, or an explicit documented exception exists.
3. Browser-extension host permissions have not expanded unexpectedly.
4. Remote network destinations are reviewed.
5. Release is built from a reviewed commit and checksums are published.
6. Command execution is still described as **unsandboxed** until an OS-enforced isolation implementation is complete and tested.

## Audit statement

No deliberate credential-stealing or covert exfiltration mechanism was identified in the reviewed upstream security-sensitive paths. This is not a proof that the entire codebase is defect-free. The application has a high-impact trust surface, so the fork intentionally relies on restrictive defaults, automated checks, reproducible reviewable changes, and progressively stronger OS isolation rather than trust in source inspection alone.

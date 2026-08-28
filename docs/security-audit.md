# Security audit — Linux hardened baseline

## Audit baseline

This fork started from upstream `totec448-spec/chat-on-steroids` v2.0.2 at commit:

`e254b954eb6570c52f2e7cc059700deff1214a9b`

Security work remains reviewable as a diff from that immutable baseline.

## Security objective and current platform

The product is unusually privileged by design: it can expose local files, local commands and browser conversation state to a remote model through MCP. The security objective of this fork is therefore **deny by default, explicit grant, least privilege, and fail closed**.

Linux is the only supported product target during the current roadmap phase. Windows/macOS code inherited from upstream may remain for future work, but those platforms are not part of M0 release acceptance and Linux security is not weakened to preserve unsupported-platform behavior.

A feature being useful is not itself consent to enable it.

## Current findings

### HIGH — model-launched commands require OS containment

**Status: MITIGATED for the M0 Linux baseline; normal-user target acceptance still required.**

Upstream command execution ran with the full logged-in user's authority. The hardened Linux path now routes `exec_command` through Bubblewrap instead of launching the requested shell directly.

The production sandbox starts from an isolated namespace, mounts system runtime directories read-only, mounts only explicitly approved project roots read/write, provides private HOME/TMP/XDG paths, rebuilds the child environment from a narrow allowlist and uses `--unshare-all` so the command does not share the host network namespace. The requested command runs only after Bubblewrap successfully establishes that boundary.

If Bubblewrap is unavailable, the working directory is outside the approved roots, or namespace setup fails, the requested command does not execute. There is no unrestricted fallback.

Unit tests pin the production policy. A real integration test executes the exact generated production Bubblewrap argv and verifies filesystem/environment isolation plus absence of the host network interface. GitHub's hosted Azure worker restricts unprivileged nested namespace setup, so that integration runs with runner-root privileges in CI. This is useful proof of the generated namespace/mount policy, but it is not proof that an ordinary desktop user on the target machine has compatible user-namespace/kernel settings.

M0 therefore still requires the exact same production profile to pass as the normal user on a representative Linux target before the first secure hands-on test is declared ready. M1 then owns broader compatibility diagnostics, packaging integration and Linux sandbox usability.

### HIGH — inherited environment variables may contain unrelated credentials

**Status: MITIGATED in the hardened baseline.**

Upstream already removed a small fixed set of application/control-plane secrets. This fork additionally scrubs inherited credential-like variables before generic child processes are created, including common token/API-key/password/private-key/client-secret patterns plus SSH/GPG askpass/agent sockets and common cloud/Kubernetes credential pointers.

Internal processes that legitimately require a credential can add that specific value explicitly after normalization; the protection is against ambient credentials being inherited merely because Electron was launched from a credential-bearing terminal.

Regression tests cover GitHub, Anthropic, AWS and generic secret/key/password patterns while confirming ordinary development variables remain available. The Linux command sandbox adds a second boundary by clearing/rebuilding the environment inside Bubblewrap.

### HIGH — privileged renderer and IPC must stay bound to bundled app content

**Status: MITIGATED in the hardened baseline.**

A privileged Electron preload must not be attachable to arbitrary web content. Packaged builds therefore ignore `ELECTRON_RENDERER_URL` and always load the bundled renderer. Development renderer URLs are accepted only for loopback HTTP(S). Privileged IPC handlers additionally require the sender to be the current application window's main frame, so another WebContents/frame cannot invoke the fixed IPC surface merely by knowing channel names.

Regression tests pin both rules.

### MEDIUM/HIGH — upstream runtime/install identity could import old authority or collide on install

**Status: MITIGATED in the hardened baseline.**

The fork deliberately does not reuse upstream Electron state. Before configuration, secrets, sessions or the single-instance lock are initialized, the app moves Electron `userData` to a fork-owned `local-cgpt` directory. This prevents an existing upstream installation from silently supplying stored permissions, recordings, browser state or secret metadata to a supposedly fresh hardened install.

The Linux package also uses the distinct `local-cgpt` package name, `com.localcgpt.app` application id, `/usr/bin/local-cgpt` executable and `Local-CGPT-Linux-*` artifact naming so the controlled candidate does not overwrite or masquerade as the upstream Linux install identity. Explicit choices made later inside the hardened fork remain eligible for normal fork migrations.

### HIGH — extension recovery could reintroduce unreviewed upstream browser code

**Status: MITIGATED in the hardened baseline.**

The inherited app exposed a recovery button whose URL fetched the matching extension ZIP from the upstream `totec448-spec/chat-on-steroids` release. That defeats the fork's review boundary even when the version is pinned: the browser code would come from a different publisher/repository than the reviewed hardened source.

M0 removes the remote extension-download IPC/preload/renderer path entirely. If the optional extension is used, Chrome must load the extension directory bundled with the reviewed app/source. Public remote extension distribution remains deferred until this fork has its own release provenance policy. Security CI rejects reintroduction of the upstream release-download URL in runtime source.

### HIGH — browser extension can observe ChatGPT page content

**Status: MITIGATED, inherent capability.**

The companion extension runs content scripts on `chatgpt.com` and `chat.openai.com`. That access is required for transcript capture, Compact & Resume and worker coordination, but it means the extension is part of the trusted computing base for conversation privacy.

The hardened baseline disables session recording, automatic compaction and multi-agent operation on first launch. Installing/enabling the browser extension remains an explicit user action.

The security workflow pins the expected extension host-permission set and fails if a new remote origin is added without review.

### MEDIUM/HIGH — optional Goal mode sends conversation text to OpenRouter

**Status: MITIGATED by explicit opt-in.**

Goal mode sends authored user messages and final ChatGPT answers to OpenRouter so a second model can decide whether to continue the chat. It does not need local file/tool payloads for that decision, but conversation text is still external data transfer.

Goal mode is disabled by default. It remains opt-in and should clearly identify the external provider and data category before activation.

### MEDIUM — recorded session history is sensitive local data

**Status: MITIGATED by default-off recording.**

Session recording writes detailed conversation/tool history to local application storage and is not protected by the OS credential encryption used for API keys. Anyone able to read the user's local application data may be able to read those records.

The hardened baseline changes first-launch recording from enabled to disabled. If recording is enabled later, retention remains a separate privacy concern owned more deeply by M3.

### MEDIUM — release binaries / supply-chain trust are material

**Status: OPEN beyond the first controlled-test boundary.**

A user who downloads a privileged desktop application must trust the release pipeline and produced binary, not merely the visible TypeScript source.

For the first M0 Linux test, the artifact or source revision must be traceable to the reviewed M0 commit and the user must not be directed to an inherited/upstream release as though it were the hardened fork. Stronger release provenance, SBOM/checksum policy and publisher signing are M4 work.

## Positive controls inherited from upstream

The audit found several useful controls worth retaining:

- Filesystem primitives resolve approved roots through canonical real paths and defend against symlink/junction escapes.
- Secret storage uses Electron `safeStorage`; Linux refuses the insecure `basic_text` fallback.
- MCP/extension bridge services bind to loopback and use bearer/tokenized paths.
- Model-facing filesystem writes are gated by explicit capabilities and read-only mode.
- Child process launching avoids `shell: true` in the direct helper and bounds command output/time.
- The repository includes a privacy-history verification gate after a previous Git-metadata privacy incident.

These controls remain defense in depth around the stronger Linux command boundary.

## First hardened baseline changes

Fresh installations now start with:

- all model-facing capabilities disabled;
- read-only mode enabled;
- session recording disabled;
- automatic Compact & Resume disabled;
- multi-agent mode disabled;
- Goal mode disabled.

Additionally:

- corrupt/missing config recovery uses the same fail-closed capability set;
- generic child environments scrub ambient credential-like variables;
- Linux command execution is routed through Bubblewrap and fails closed when the backend cannot establish the boundary;
- Linux is the only current supported product target.
- packaged renderer loading and privileged IPC are bound to trusted app content/main-frame identity;
- Electron runtime state and Linux install identity are separated from upstream.

Explicit choices made inside this hardened fork are preserved across ordinary fork migrations. Upstream Chat On Steroids state is intentionally not imported into the hardened fork. A security update should not silently rewrite a fork user's explicit permission choices unless a vulnerability requires revocation.

## Network / data-flow inventory

Expected remote destinations should be narrowly explainable:

- OpenAI: MCP Secure Tunnel / ChatGPT service integration when configured.
- Cloudflare: only when the user selects the Cloudflare tunnel option.
- OpenRouter: only when the user explicitly enables Goal mode and supplies a key.
- GitHub: build-time retrieval of pinned helper binaries/dependencies and normal repository/release operations.
- ChatGPT web origins: browser extension content-script scope.
- Loopback (`127.0.0.1`): local app/extension bridge.

Model-launched Linux commands have no host-network access in the M0 production sandbox. A future explicit command-network permission belongs to M2.

Adding a new remote destination is security-sensitive and requires explicit review and documentation.

## Threat model

### Assets to protect

- personal files outside approved project roots;
- browser profiles, cookies and authenticated sessions;
- SSH/GPG keys and cloud credentials;
- API tokens and environment variables;
- ChatGPT conversation content;
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

Prompt instructions are not a security boundary. Anything that must be forbidden is enforced in code or by the operating system.

## M0 evidence model

M0 keeps three evidence classes separate:

1. **Policy/unit evidence** — fail-closed defaults, credential scrubbing, Bubblewrap launch construction, approved-root mounts and `--unshare-all` network policy.
2. **Hosted CI evidence** — production dependency/privacy gates plus execution of the exact production Bubblewrap argv with runner-root privileges because the hosted Azure worker restricts unprivileged nested namespace setup.
3. **Target Linux evidence** — the exact production Bubblewrap profile executes as the normal user on the representative target and proves approved-root containment plus network denial before the first secure hands-on test.

## M0 release / first-test gate

Before the hardened Linux baseline is considered suitable for the first controlled user test:

1. Final-head Linux `verify:ci` passes.
2. The Security workflow passes, including dependency audit, privacy verification, hardened unit tests, exact production Bubblewrap integration and extension-origin guard.
3. The exact production Bubblewrap profile is verified as the normal user on a representative Linux target, including network denial and approved-root containment.
4. README, `SECURITY.md` and this audit describe the implemented defaults and limitations accurately.
5. No inherited Windows/macOS platform-specific failure is allowed to weaken the Linux model or block an otherwise valid Linux baseline.
6. The test artifact/source revision is clearly identified, uses the distinct hardened Linux package/app/executable identity, and cannot be confused with or overwrite the upstream Linux install identity.

M0 is a controlled first-test boundary, not a claim that M1–M5 are unnecessary for stronger everyday-use assurance.

## Audit statement

No deliberate credential-stealing or covert exfiltration mechanism was identified in the reviewed upstream security-sensitive paths. This is not proof that the entire codebase is defect-free. The application has a high-impact trust surface, so the fork relies on restrictive defaults, automated checks, reviewable changes and OS-enforced Linux containment rather than trust in source inspection alone.

# Security policy

## Reporting a vulnerability

**Please do not open a public issue or pull request for a security problem.** Use GitHub's private vulnerability reporting for this repository: **Security → Report a vulnerability**.

Include the smallest useful reproduction, the app version, Linux distribution/version and architecture, and whether the Chrome extension was connected. Redact personal file contents, usernames/paths, conversation text and account/workspace identifiers. Never post live API keys, connector URLs, tunnel tokens or other credentials. Rotate anything accidentally exposed.

This is a solo-maintained beta. There is no bug bounty or guaranteed response window.

## Current support target

The hardened `local-cgpt` fork currently supports **Linux only**. Windows/macOS code inherited from upstream may remain in the repository, but those platforms are not current release targets and their platform-specific behavior is not part of the M0 security acceptance gate.

No Linux security boundary may be weakened to preserve unsupported-platform behavior. Windows/macOS product support should receive a separate future milestone if it becomes an approved goal.

## Security model

`local-cgpt` is a permission boundary between ChatGPT and the Linux account running the app:

- Fresh installations and conservative/corrupt-config recovery start **fail closed**: model-facing capabilities are disabled, read-only mode is enabled, session recording is disabled, automatic compaction is disabled, multi-agent mode is disabled, and Goal mode is disabled.
- The hardened fork uses a fork-owned Electron `userData` directory and a distinct Linux package/app/executable identity, so an upstream installation cannot silently donate stored permissions, recordings, browser state or secret metadata and the hardened package cannot overwrite the upstream Linux install identity.
- Packaged builds always load the bundled renderer. The development renderer override is accepted only for loopback HTTP(S), and privileged IPC handlers accept requests only from the current application window's main frame.
- On Linux, model-influenced filesystem I/O under approved roots is bound to stable directory/file descriptors; intermediate and final symlink traversal is rejected for M0, and pathname canonicalization alone is not treated as the containment boundary.
- Read-only mode disables effective file writes and command execution while read capabilities remain separately grantable.
- Generic child processes are launched with credential-like ambient environment variables removed. Unsandboxed Linux host helpers additionally use least-authority environments that strip ambient loader/plugin/startup authority.
- On Linux, `exec_command` is available only through the hardened Bubblewrap path. Approved project roots are the only writable host mounts; system runtime paths are read-only; HOME/TMP/XDG state is private; the child environment is cleared/rebuilt; and the production profile uses a separate network namespace rather than the host network.
- If Linux command containment cannot be constructed or Bubblewrap is unavailable, command execution fails closed. There is no unrestricted command fallback.
- MCP servers bind to loopback and use secret tokenized paths. Public reachability comes only from the tunnel you configure.
- On Linux, automatic tunnel-helper discovery accepts only the reviewed bundled helper and fixed system-managed locations; it does not silently substitute a same-named executable from ambient `PATH`, the home directory, a writable repository, or other user-controlled locations, including during development. An explicit native-picker `binaryPath` override remains a deliberate user-authority choice.
- The companion-extension bridge is a separate loopback service. It exposes no generic filesystem route, shell-command route, API-key read, or capability/permission mutation route. Its browser-owned settings route can intentionally change only automatic compaction and Goal enablement, alongside the session/continuation/worker controls required by the companion.
- Companion controls embedded in the ChatGPT DOM reject synthetic page-generated click/keyboard/input events before privileged content-script handlers run. Chrome isolated worlds share the DOM, so isolated-world execution alone is not treated as proof of a real user gesture.
- The optional Chrome extension must come from the extension directory bundled with the reviewed hardened app/source. M0 exposes no runtime path that downloads an extension ZIP from the upstream project.
- Stored API/bridge credentials use Electron `safeStorage`. On Linux, the unencrypted `basic_text` backend is refused, so a working secure desktop secret store/keyring is required for stored secrets.
- Session recording is separate durable local history and is **off by default** for fresh hardened installations.

## Command-sandbox evidence

M0 distinguishes three different forms of evidence instead of treating them as interchangeable:

1. **Policy/unit proof** verifies that production command launches require Linux + Bubblewrap, contain `--unshare-all`, do not contain a host-network sharing override, clear/rebuild the environment, and expose only approved writable roots.
2. **Hosted CI integration proof** executes the exact production Bubblewrap argv, including its namespace/mount/environment policy. GitHub's hosted Azure worker restricts unprivileged nested namespace setup, so this CI integration runs with runner-root privileges. That proves the generated production profile can establish and enforce its real namespaces/mounts in the hosted environment, but it does not prove that a normal desktop user on the target machine has the required kernel/user-namespace support.
3. **Target Linux runtime proof** executes the same production profile as the normal user on the representative target before M0 is considered ready for the first secure hands-on test, including approved-root containment and network denial.

A hosted-runner privilege requirement is an evidence limitation, not permission to weaken or bypass the production sandbox.

## Expected limitations

These are properties of the current design, not vulnerability reports by themselves:

- **M0 is a first secure Linux baseline, not a claim of perfect isolation.** Model-facing approved-root filesystem operations use the Linux stable-FD containment layer and deliberately reject symlink traversal, but this does not protect against a native process that already has the same user's authority or against unrelated third-party software outside the local-cgpt trust boundary.
- **Browser augmentation has a broad data sensitivity.** The companion Chrome extension can observe ChatGPT page content on its narrowly allowlisted ChatGPT origins when explicitly used. Recording/workers/Goal are therefore disabled by default in the hardened baseline.
- **Companion install identity is a browser-boundary credential, not protection from native same-user compromise.** A native process already able to read or rewrite this account's `local-cgpt` userData/materialized extension can copy or replace the proof; that capability is outside Issue #17's browser-extension/page identity boundary. The generated proof authenticates possession of the app-materialized companion state, not publisher signing or a clean host account.
- **Companion pairing uses install-local cryptographic identity, not Origin identity.** The app generates a random 256-bit proof in its fork-owned `userData`, injects it only into the app-materialized extension as a non-web-accessible generated resource, and requires a single-use HMAC challenge/response before `/pair` can mint/rotate the ordinary bridge bearer token. The proof is never shipped as a source constant or placed in `chrome.storage`, content-script messages, DOM, or MAIN-world helpers. Missing/spoofed Origin therefore grants no pairing authority; ordinary web Origins remain rejected as a separate layer. Explicit unpair revokes the bearer, clears pending challenges, rotates the install proof, and rewrites the materialized resource. App/browser restarts preserve the install proof and bearer authorization, while unfinished challenges are process-memory-only and do not survive an app/bridge restart.
- **Session recordings are detailed local data and are not encrypted by `safeStorage`.** They remain local to the app but may be readable by someone who already has access to the same OS account. Recording is off by default.
- **Goal mode uses an external model provider when explicitly enabled.** Treat it as a separate data-egress boundary and do not enable it for sensitive conversations unless you accept that provider boundary.
- **Publisher signing/provenance is not yet the completed M0 release guarantee.** The M0 Linux candidate has a distinct `local-cgpt` package/app/executable identity and a source-SHA/checksum record, but it is still a controlled test artifact rather than a signed public release. M4 owns stronger release provenance/signing work.
- **The inherited Windows Desktop automation code is not part of the current Linux product surface.** Do not infer current Windows support from its presence in the source tree.

The application-level findings, classifications, assumptions and evidence for the 2026-08-28 review are recorded in `docs/application-security-audit-2026-08-28.md`.

## Safe testing rule

For M0 controlled testing, use disposable/non-sensitive project data until the candidate you are testing has passed the documented final-head gates. The supported secure-test gate is: final-head Linux CI green, Security workflow green, exact production Bubblewrap profile verified as the normal user on a representative Linux runtime, and README/security documentation synchronized with the implemented behavior.

## Scope

In scope: this repository's Linux desktop app, Core MCP surface, local browser bridge, companion `extension/`, Linux command sandbox, and hardened configuration/secrets behavior.

Currently unsupported as a product target: Windows/macOS runtime behavior and Windows Desktop automation.

Out of scope: ChatGPT/OpenAI infrastructure, Electron/Chromium upstream, `tunnel-client`, `cloudflared`, Bubblewrap itself, and other third-party dependencies. Report upstream vulnerabilities to the relevant project as well.

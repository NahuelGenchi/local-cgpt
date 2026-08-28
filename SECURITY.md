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
- Filesystem tools validate and canonicalize paths against folders you explicitly approve.
- Read-only mode disables effective file writes and command execution while read capabilities remain separately grantable.
- Generic child processes are launched with credential-like ambient environment variables removed.
- On Linux, `exec_command` is available only through the hardened Bubblewrap path. Approved project roots are the only writable host mounts; system runtime paths are read-only; HOME/TMP/XDG state is private; the child environment is cleared/rebuilt; and the production profile uses a separate network namespace rather than the host network.
- If Linux command containment cannot be constructed or Bubblewrap is unavailable, command execution fails closed. There is no unrestricted command fallback.
- MCP servers bind to loopback and use secret tokenized paths. Public reachability comes only from the tunnel you configure.
- The companion-extension bridge is a separate loopback service and exposes no filesystem, command or settings-mutation route.
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

- **M0 is a first secure Linux baseline, not a claim of perfect isolation.** Application-level path validation remains defense in depth around the OS-enforced command sandbox, and same-user filesystem races elsewhere in the app can still matter.
- **Browser augmentation has a broad data sensitivity.** The companion Chrome extension can observe ChatGPT page content on its narrowly allowlisted ChatGPT origins when explicitly used. Recording/workers/Goal are therefore disabled by default in the hardened baseline.
- **Session recordings are detailed local data and are not encrypted by `safeStorage`.** They remain local to the app but may be readable by someone who already has access to the same OS account. Recording is off by default.
- **Goal mode uses an external model provider when explicitly enabled.** Treat it as a separate data-egress boundary and do not enable it for sensitive conversations unless you accept that provider boundary.
- **Publisher signing/provenance is not yet the completed M0 release guarantee.** Do not treat an inherited/upstream installer or unsigned artifact as the hardened fork merely because it has a similar name. M4 owns stronger release provenance/signing work.
- **The inherited Windows Desktop automation code is not part of the current Linux product surface.** Do not infer current Windows support from its presence in the source tree.

## Safe testing rule

Until M0 is complete, test only with disposable/non-sensitive project data. The first supported secure-test gate is: final-head Linux CI green, Security workflow green, exact production Bubblewrap profile verified as the normal user on a representative Linux runtime, and README/security documentation synchronized with the implemented behavior.

## Scope

In scope: this repository's Linux desktop app, Core MCP surface, local browser bridge, companion `extension/`, Linux command sandbox, and hardened configuration/secrets behavior.

Currently unsupported as a product target: Windows/macOS runtime behavior and Windows Desktop automation.

Out of scope: ChatGPT/OpenAI infrastructure, Electron/Chromium upstream, `tunnel-client`, `cloudflared`, Bubblewrap itself, and other third-party dependencies. Report upstream vulnerabilities to the relevant project as well.

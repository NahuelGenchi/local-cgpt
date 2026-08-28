<div align="center">
  <img src="extension/icons/icon128.png" width="88" alt="Chat On Steroids icon" />
  <h1>local-cgpt</h1>
  <p><strong>Give ChatGPT a controlled bridge to your computer.</strong></p>
  <p>A Linux-first, fail-closed local bridge for ChatGPT over MCP.</p>
  <p>
    <a href="#three-minute-setup">Setup</a>
    · <a href="#permissions-and-security-boundaries">Security</a>
    · <a href="CHANGELOG.md">Changelog</a>
  </p>
</div>

<p align="center">
  <img src="docs/images/app-home.jpg" width="68%" alt="Chat On Steroids Home screen" />
  <img src="docs/images/extension-popup.jpg" width="23%" alt="Chat On Steroids Chrome extension" />
</p>
<p align="center">
  <img src="docs/images/app-chat.jpg" width="92%" alt="Chat On Steroids session timeline" />
</p>

`local-cgpt` is currently a **Linux-only supported desktop app** that gives ChatGPT a deliberately restricted local MCP bridge. The hardened fork starts with no model-facing capabilities enabled and treats the app plus Linux OS sandbox as the authority boundary. The companion Chrome extension is optional and adds browser-side chat attribution, session capture, Compact & Resume and experimental worker coordination only when you explicitly enable the features that need it. Windows/macOS code inherited from upstream is not a current product target.

## Current test status

**There is not yet a hardened release artifact that should be treated as ready for normal use.** The current supported target is Linux. Until M0 is complete, use only disposable/non-sensitive project data and do not treat inherited/upstream installers as the hardened fork.

The first supported hands-on test gate is:

- final-head Linux CI is green;
- the Security workflow is green;
- the exact production Bubblewrap profile is verified on a representative Linux machine, including approved-root containment and network denial;
- README/security documentation matches the implemented boundary; and
- the tested source/artifact revision is identified explicitly.

### M0 fail-closed defaults

Fresh hardened installations start with **all model-facing capabilities disabled** and **read-only mode enabled**. Session recording, automatic compaction, multi-agent mode and Goal mode are also disabled.

When command execution is explicitly granted on Linux, it requires Bubblewrap. Approved project roots are the only writable host mounts, system runtime paths are read-only, HOME/TMP/XDG state is private, credential-like ambient environment variables are removed, and the production command profile does not share the host network namespace. If Bubblewrap cannot establish the boundary, the requested command does not run; there is no unrestricted fallback.

Use a narrow project folder rather than your home directory or filesystem root. See [Permissions and security boundaries](#permissions-and-security-boundaries), [`SECURITY.md`](SECURITY.md) and [`docs/security-audit.md`](docs/security-audit.md).

## What it adds

| Area | What ChatGPT gets |
| --- | --- |
| Files | Bounded read/search plus preflighted multi-file text patches inside approved roots |
| Commands | Native shell processes and interactive terminal sessions, when enabled |
| Desktop | Inherited Windows automation code exists upstream, but it is not part of the current Linux product surface |
| Sessions | Local durable history, real tool-call evidence and Compact & Resume |
| Workers | Experimental prime/worker chats with deterministic local routing |
| Goal loop | Optional: a second model writes your next message until the goal is met (needs an OpenRouter key) |

The app has no replacement chat UI and does not host a model. On the current Linux target it runs as the local permission/execution bridge for the capabilities you explicitly grant.

## Requirements

- A modern desktop **Linux** distribution on x64 or ARM64. M0 CI currently gates on Ubuntu 24.04 x64; broader distribution compatibility is hardened further in M1.
- **Bubblewrap (`bwrap`)** for command execution. On Debian/Ubuntu install the `bubblewrap` package. If it is unavailable or incompatible, command execution remains unavailable rather than falling back unsandboxed.
- A working Secret Service/keyring backend such as GNOME Keyring or KWallet when storing API keys or using the companion extension. Electron's unencrypted `basic_text` fallback is deliberately refused.
- **Chrome 116+** only if you want browser attribution, Compact & Resume, Overwrite or worker chats.
- A ChatGPT workspace where Developer mode/custom MCP apps are available for the capabilities you intend to use.

Use a normal ChatGPT conversation with the custom app enabled. OpenAI's built-in **Agent mode** currently does not use custom apps; `local-cgpt`'s experimental worker chats are a separate browser-augmentation feature.

The recommended connection uses OpenAI's Secure MCP Tunnel. Packaged Linux test builds are expected to bundle a pinned, checksum-verified [`tunnel-client`](https://github.com/openai/tunnel-client/releases) for the target architecture. An **explicit binary path you configure** wins; otherwise the bundled tested copy wins, with `PATH` / normal install locations used only as fallback. Cloudflare and self-hosted HTTPS tunnels remain available as alternatives.

## Three-minute setup

1. On Linux, build/run the reviewed hardened revision or use the explicitly identified M0 test artifact once one is published.
2. **Review permissions**, then approve one or more project folders.
3. Create an OpenAI Secure MCP Tunnel and a restricted API key with **Tunnels: Read** and **Use**.
4. In ChatGPT on the web, enable Developer mode and create the Core app. Your workspace admin may need to grant or enable Developer mode first.
5. **Optional browser augmentation only:** if you explicitly want recording, Compact & Resume or worker features later, press **Open extension folder**, load that folder unpacked in Chrome, and pair it. The Core MCP bridge does not require the extension.

The Setup tab tracks each hop and only marks it complete once that side of the chain has actually been observed.

### OpenAI Secure MCP Tunnel

1. In [Platform → Tunnels](https://platform.openai.com/settings/organization/tunnels), create a tunnel in the **same workspace you use in ChatGPT** and copy its ID (`tunnel_…`).
2. In [Platform → API keys](https://platform.openai.com/settings/organization/api-keys), create a **Restricted** key with only **Tunnels: Read** and **Tunnels: Use**.
3. Paste both into the Setup tab and press **Connect**.
4. In ChatGPT on the web, enable Developer mode from **Settings → Apps → Advanced settings**, or from the workspace Apps area. Business workspaces require an admin/owner; Enterprise/Edu may also require RBAC access from an admin.
5. Create a custom app, choose **Tunnel**, select the tunnel, review the discovered actions, and publish/enable it as your workspace requires.

The current Linux-supported product publishes the Core MCP surface only.

### Cloudflare quick tunnel

Press **Connect**, copy the URL the app shows, and use it as the MCP server URL when creating the custom app in ChatGPT. The URL is public and its random path is the capability secret, so treat the complete URL like a password. It changes when the app restarts.

### Run your own tunnel

Point your own HTTPS tunnel at the loopback URL shown by the app and give ChatGPT the public equivalent, including the secret path.

After changing permissions or tool shape, refresh/review the custom app in ChatGPT, or recreate it if your workspace does not expose a refresh action, then start a new conversation. ChatGPT can retain the previously reviewed action set, so the desktop app does not pretend it can hot-rewrite an already cached schema.

### Experimental browser augmentation and OpenAI terms

The MCP connector uses ChatGPT's documented Developer mode and Secure MCP Tunnel path. The **companion extension is different**: it observes ChatGPT's web UI, records browser-rendered conversation state locally, and the experimental worker feature opens and seeds additional ChatGPT tabs. Those browser-augmentation paths are experimental and are **not a documented public ChatGPT automation API**. Depending on the account and workflow, OpenAI terms and policies around automated extraction, rate limits, access controls, safeguards and permitted use may apply. **Review the agreement that governs your account before using the extension or multi-agent mode.** Do not use these features to scrape or bulk-extract ChatGPT data, evade limits or confirmations, or bypass access and safety controls. See OpenAI's [Terms and policies](https://openai.com/policies/), [Services Agreement](https://openai.com/policies/services-agreement/) and current [Developer mode documentation](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt).

### Hardened test artifacts

Do not use an inherited/upstream release binary as evidence that the hardened fork is running. Until the M0 test artifact is explicitly identified, build from the reviewed `security/hardened-baseline` revision only for disposable testing. Stronger release provenance, checksums/SBOM policy and publisher signing are roadmap M4 work.

## Permissions and security boundaries

Fresh hardened installs start with **all model-facing capabilities disabled**, **read-only mode enabled**, and data-expanding features (session recording, automatic compaction, multi-agent and Goal) disabled. Explicit choices made later inside this hardened fork are preserved unless a security migration requires otherwise. The fork uses its own Electron application-data directory and does not import upstream Chat On Steroids permissions, recordings or secret metadata.

The important boundaries are:

- **File tools are limited to approved folders.** Paths are canonicalized before access. These application-level checks remain defense in depth around command isolation.
- **Commands are Linux-only in the current supported product and are OS-sandboxed when enabled.** `exec_command` is launched through Bubblewrap, not directly as an unrestricted shell. Approved roots are the only writable host mounts; system runtime paths are read-only; HOME/TMP/XDG are private; the child environment is rebuilt; and the production profile does not share the host network namespace.
- **Command setup fails closed.** If Bubblewrap is missing, the working directory is outside an approved root, or namespace setup fails, the requested command does not execute.
- **Ambient credentials are not inherited by generic model-run child processes.** Common token/key/password/client-secret variables and credential-helper sockets/pointers are stripped. This is additional defense in depth, not permission to expose unrelated host files.
- **The MCP server is loopback-only.** A random secret path protects each local connector. ChatGPT reaches it through the tunnel you configure; treat any complete public tunnel URL as a secret.
- **Secrets use Electron `safeStorage`.** On Linux the app refuses Electron's unencrypted `basic_text` fallback, so a secure keyring/Secret Service backend is required for stored secrets.
- **The browser bridge is separate and loopback-only.** It exists for the companion extension and exposes no filesystem, command or settings-mutation route. The extension can observe ChatGPT page content on its narrow ChatGPT-origin allowlist when explicitly used, so recording/workers/Goal remain off by default.

Read-only mode remains the fast kill switch for local mutation. See [`SECURITY.md`](SECURITY.md) for the supported threat boundary and first-test gate.

## Connectors and tools

The current Linux-supported product exposes the **Core** MCP surface only. Windows Desktop automation code remains inherited source, not a supported current connector.

| Connector | Purpose | Possible tool names |
| --- | --- | --- |
| **Core** | Approved files, search, patches, sandboxed terminal, session lookup and optional workers | `read`, `view_image`, `find`, `apply_patch`, `exec_command`, `write_stdin`, `session`, `agents` |

Core declares eight possible names but exposes only the capabilities currently granted; `find` and the command pair are mutually exclusive. Revoking a permission takes effect at live enforcement even if ChatGPT still displays a previously cached schema. Refresh/review the custom app and start a new chat after changing exposed capability shape.

The public tool contract and permission mapping live in [`docs/tool-surface.md`](docs/tool-surface.md).

## Session recording and the extension

Session recording is **off by default for fresh hardened installs**. If you explicitly enable it, detailed conversation/tool history is stored under the fork-owned `local-cgpt` Linux per-user application-data directory and is not encrypted by `safeStorage`; treat it as sensitive local data. The small Activity log is separate, capped, redacted and memory-only. Session retention remains bounded by the configured retention policy.

The bundled Chrome extension adds browser-side conversation identity, page-visible transcript capture, richer tool rows, Compact & Resume, and worker-tab coordination. It runs only on `chatgpt.com` / `chat.openai.com` plus the app's loopback bridge ports. App and extension versions move together, so after updating the app, use **Reload** for the unpacked extension in `chrome://extensions`.

### Compact & Resume

For long recorded sessions, the app estimates context pressure locally. The warning/limit thresholds remain available, but **automatic compaction is off by default** in the hardened baseline and must be explicitly enabled. These are local estimates, not ChatGPT's private context counter.

Compact & Resume asks the current chat to write a handoff, stores it locally, opens a fresh ChatGPT conversation and rebinds the **same local session** to it. The original session remains intact if the handoff cannot be completed.

<p align="center">
  <img src="docs/images/composer-gear-sheet.png" width="52%" alt="Gear sheet beside the ChatGPT composer; in worker chats Auto-compaction and Goal are locked off and Compact and Resume is unavailable" />
</p>

### The goal loop (optional, off by default)

Long tasks are mostly you typing "carry on" for an hour. With the goal loop on, a second model
reads each answer ChatGPT finishes. The shipped prompt is deliberately eager: it keeps going while
any concrete task or question you actually asked for is not yet clearly completed or answered,
including requested checklist items the latest answer simply omitted. It stops only when ChatGPT
clearly presents the whole request as done and all requested questions as answered. That explicit
all-done claim is still authoritative, so the second model does not invent extra testing, polish
or follow-up after a genuinely finished task.

It runs only when a turn has genuinely finished. The strongest signal is ChatGPT's exact Fiber
`end_turn` evidence for the current response. When that bit is missing, the extension stays
conservative: Stop must remain gone through the four-second settle window, the answer and tool
rail must be quiet, no connector call may still be unanswered, and a fresh completed-message
action must belong to the exact terminal assistant section. Hidden tabs do not depend on a
throttled debounce timer to notice the final Stop removal. A message sent into a turn that is
still working would read as a correction to it, so ambiguous/interim states stay open.

**Give one chat a specific goal.** The gear beside the composer has an **add specific goal**
line under the Goal switch. Write what the chat has to reach, press Save, and the same loop
prompts towards that goal until it is reached, then stops without forgetting the goal text. A
goal is enough on its own: you do not have to turn the standing switch on as well. In a **New
Chat** it also writes the first message, so a goal is all you have to type. Goals are durable and
per-chat: reopening an old finished chat restores its goal in the UI without automatically
starting stale work, and **Compact & Resume transfers the same goal to the replacement chat** so
an unattended chain can keep pursuing it across multiple resumptions. The goal stays until you
clear or replace it. A worker chat spawned by an agent run cannot be given one — its prime already
writes its messages, and the sheet says so.

The loop also answers a turn ChatGPT cut short by itself, not only one it finished cleanly. A
turn you stopped by hand is still left alone: you are about to type something yourself.

What is sent is only your messages and ChatGPT's final answers. Tool calls, their results and
the commentary a turn produces while it works never leave the machine; a recorded session holds
file contents and command output, and none of that belongs in a chat message.

It needs an **OpenRouter API key**, which is stored encrypted alongside the app's other secrets
and never reaches the browser: the request is made by the app. Set the key, model, reasoning level
and editable system prompt under **Chat → Settings**; the prompt editor includes a one-click
restore to the eager-but-bounded shipped default. The model picker lists OpenRouter's catalogue newest first,
twenty at a time. The switch is also on the gear beside the ChatGPT composer, together with
automatic compaction. A finished or failed Goal status stays visible above the composer for the
finished turn, can be dismissed immediately with its top-right ×, and clears automatically when
you send the next prompt, open New Chat or switch conversations.

Goal decisions use OpenRouter strict JSON Schema with parameter-aware provider routing,
reasoning excluded from the returned response, and Response Healing for malformed JSON. The app
validates the result again locally: wrapped `NO_REPLY`, tokenizer markers such as
`<|begin_of_sentence|>`, reasoning tags, malformed schemas and empty normalized replies stop or
fail closed and are never typed into ChatGPT.

This spends your OpenRouter credit on every finished turn, and it sends messages to ChatGPT
without asking each time. Turn it off when you are not watching. The terms note in
[Experimental browser augmentation and OpenAI terms](#experimental-browser-augmentation-and-openai-terms)
applies here too.

### Multi-agent mode (experimental)

Multi-agent mode is **off by default** in fresh hardened installs. If explicitly enabled, one prime chat can open worker chats and exchange brokered messages with them; the configured worker limit remains bounded and workers cannot message each other directly.

Workers are **reusable conversations**, not disposable one-shot tabs. When a worker reports its
result, or the app durably observes that its turn has naturally settled, it normally goes to
sleep and frees its worker slot while keeping the full ChatGPT conversation. Messaging that
sleeping worker wakes the same conversation again. If its tab is still open the extension reuses
and focuses that exact tab; if it was closed, the app reopens the stored `/c/<conversation>` and
types the prime's new instruction there as an ordinary user message. Waking consumes a free slot
and is refused before anything is queued or typed when no slot is available. At roughly 400k
recorded context tokens a worker becomes non-revivable after its next stop instead of being
reused indefinitely.

Worker chats **never Compact & Resume themselves**: automatic compaction is disabled for them and
the manual Compact & Resume action is unavailable. Reaching 400k does not interrupt or replace the
worker conversation; it may finish the live task and receive messages normally, then its next stop
becomes permanent and the same chat remains only as non-revivable history.

Sleeping workers belong to the **prime conversation's durable worker history**, not to a global
swarm lock. If the last working worker goes to sleep, that active run is parked immediately and
another ChatGPT conversation may start its own workers. The original prime still sees its own full
history in `agents action=status`, including sleeping and permanently non-revivable rows, can spawn
a fresh `worker-N` without reviving an older sleeper, and can later wake any reusable old worker in
its exact original chat once the global execution slot is free. Friendly ids such as `worker-1`
are scoped to that prime history, so two primes may each retain their own `worker-1` without
sharing identity or workspace. **Compact & Resume moves that complete worker history and revival
authority from the parent chat to its resumed child.** Explicitly clearing the swarm is the action
that discards that retained ownership. Turning Multi-agent **off is only an execution pause**:
queued browser work is withdrawn and active workers are parked, but every prime-owned worker
history stays durable across disabled app restarts and is available again after re-enable.

Agent identity is deliberately fail-closed. `spawn`, worker messaging and other identity-sensitive
operations require the companion extension to prove which ChatGPT conversation made the MCP call.
If the same chat is being used from a client the extension cannot observe, such as a phone app,
ordinary Core tools can still work but multi-agent control is refused rather than guessed.

This is experimental browser automation, and parallel chats can edit the same files or spend account limits quickly. Use it only on work you can recover, keep worker ownership explicit, and turn the feature off when you do not want ChatGPT tabs opened or coordinated automatically. The terms note in [Experimental browser augmentation and OpenAI terms](#experimental-browser-augmentation-and-openai-terms) applies here.

## Troubleshooting

- **Tools missing or still visible after a permission change:** refresh/review the custom app in ChatGPT, or recreate it if needed, then start a new conversation so it discovers the current schema.
- **Extension says app not found:** session recording or multi-agent mode must be on for the browser bridge to run; then reopen the extension popup.
- **Extension version mismatch:** reload the unpacked extension after every app update.
- **`agents` says `UNIDENTIFIED_CALLER`:** open/use that same ChatGPT conversation in the paired desktop browser so the extension can observe its connector request id. The app intentionally will not infer agent identity from the active tab or timing.
- **OS/browser warning about an unverified app:** expected for the unsigned beta. Verify `SHA256SUMS.txt` before overriding an OS trust prompt.
- **Linux says secure credential storage is unavailable:** start/unlock GNOME Keyring, KWallet or another Secret Service provider, then restart the app. The insecure Electron `basic_text` fallback is intentionally rejected.
- **Tunnel unavailable:** use Advanced settings to point at an explicit `tunnel-client` / `cloudflared` executable, or use the bundled copy from the release build.

## Contributing

Bug reports, feature requests and PRs are welcome. Please read [`CONTRIBUTING.md`](CONTRIBUTING.md) first. Security issues go through [`SECURITY.md`](SECURITY.md), privately rather than in an issue or PR. Release history is in [`CHANGELOG.md`](CHANGELOG.md).

## Development

```sh
npm ci
npm run dev        # run the app with hot reload
npm run verify     # the same gate CI runs
```

## Building

Current supported packaging is Linux-only:

```sh
npm run dist:linux:x64
npm run dist:linux:arm64
```

For the first hardened test, prefer the Debian package on Debian/Ubuntu once the M0 artifact is explicitly identified. Do not treat inherited Windows/macOS packaging or an upstream release as a supported `local-cgpt` build. M1 owns broader Linux packaging/sandbox compatibility and M4 owns stronger release provenance/signing.

## Licence

MIT — see [`LICENSE`](LICENSE).

Not affiliated with, endorsed by, or connected to OpenAI. "ChatGPT" is a trademark of
OpenAI; it is used here only to describe what this tool interoperates with.

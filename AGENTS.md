# local-cgpt — the agent map

The single orientation document for this repository. Read it before changing anything.

**How to use it.** §1–§3 is the mental model; read those once, in order. §4 is "where is the
thing". §5–§17 is one section per subsystem, each with the same shape — what it owns, its
files, its flow, **what must hold**, how it fails, which tests cover it. §18 is the fastest
entry point when you have a symptom and no theory. §19–§22 is how to work here.

**One file, complete.** This replaces the old `AGENTS.md` + `agent.md` split, which
duplicated roughly 60% of its content and had already drifted between copies. It is sized
for completeness rather than for any tool's default project-document budget; if your
harness truncates long project docs, raise its limit rather than cutting this down.

Because a truncated tail would drop §19 first, the one rule whose loss is irreversible is
repeated here: **this tree is usually dirty and shared with the user and other agents —
never `reset`, `checkout`, `clean`, reformat, or overwrite work you did not do.**

---

## Milestone-driven work tracking

`milestones/README.md` is the single source of truth for mutable roadmap state;
`docs/agent-workflow.md` defines the tracking procedure. Do not duplicate the
current milestone in this file.

For product/repository UX, architecture/performance or agent-orchestration work,
also read `docs/product-quality-plan.md` and the owning M6–M8 milestone. Those
records add quality evidence requirements without superseding M0–M5 security,
privacy or release contracts.

Before changing tracked files for implementation, documentation, tests, CI,
security work, or refactors, select the owning roadmap milestone and create one
focused GitHub Issue titled `M<N>: <imperative summary>` assigned to that
milestone. Use a focused branch and open a draft PR after the first meaningful
commit. Keep Issue, milestone record, and PR synchronized as scope changes.

If no roadmap milestone fits, define and synchronize the next milestone before
implementation. PRs #1 and #2 are the documented one-time bootstrap exceptions;
Issues #3 and #4 retroactively track them under M0. If milestone synchronization
itself is broken, record that as a visible blocker and fix the synchronizer rather
than pretending the GitHub mirror is current.

---

## 1. The app in sixty seconds

A **Linux-supported Electron app** that hands ChatGPT a deliberately small set of local
computer capabilities over MCP. It is a bridge and a permission layer — not a chat client,
not a model host. It also ships an optional Chrome extension that can observe ChatGPT itself
for conversation attribution, session capture, Compact & Resume and worker coordination when
those features are explicitly enabled. The inherited codebase still contains Windows/macOS
paths and Windows Desktop automation, but Linux is the only current product/release target;
unsupported-platform behavior must never weaken the Linux security model.

Four runtime planes, only two of which are servers:

```text
              ── PUBLIC / CHATGPT SIDE ──────────────────────────────

 ChatGPT model                                    ChatGPT web page
   │  MCP over HTTPS                                │
   ▼                                                ├─ chatgpt-dom.js  selectors only
 ┌──────────────┐  ┌──────────────┐                 ├─ content.js      isolated-world
 │ Core         │  │ Desktop      │                 │                  recorder + UI
 │ files/term/  │  │ inherited    │                 └─ fiber.js        MAIN-world React
 │ GitHub/refs/ │  │ Windows-only │                                    evidence
 │ session/     │  │ screen/input │                        │
 │ agents       │  │ clipboard    │                        ▼
 └──────┬───────┘  └──────┬───────┘              background.js  MV3 worker, journal,
        └────────┬────────┘                                      tab↔conversation registry
                 │ tunnel                                         │ HTTP 8765-8769
                 ▼                                                ▼
   127.0.0.1  MCP server                                    bridge.ts
   secret tokenized path per surface                              │
                 │                                                ├→ recorder / correlation
   server.ts → tools.ts → kernel.ts                               ├→ Compact & Resume
                 │                                                └→ agent bootstrap
        ┌────────┴────────┐
   Core tools        inherited Desktop tools       ── ELECTRON RENDERER ──
        │                 │                        renderer → preload (fixed API)
   sandbox +        computer/*                              → ipc.ts → main services
   codex/* ports
        │
   files + sandboxed processes
```

**The MCP server and the browser bridge are two different servers with two different
threat models.** MCP is the model's capability endpoint. The bridge exists only for the
Chrome extension and deliberately has no route that reads a file, runs a command, or
changes a capability permission. Never merge their lifecycles or their auth.

The extension never executes a tool. It observes ChatGPT and reports evidence. **The app is
the only authority on what a local tool actually did.** The renderer has no Node, no
filesystem, no command, no network authority; it crosses preload through named IPC.

## 2. Where the bugs actually are

Almost nothing hard here is a local algorithm bug. The hard ones live on six boundaries:

| Boundary | The two things people confuse |
| --- | --- |
| Discovery vs. enforcement | a schema ChatGPT cached vs. a permission that is live *now* |
| Path spelling | `/project/src/a.ts` vs. a native `C:\work\...` or `/home/...` path — same decision required |
| Request vs. conversation | HTTP `x-request-id` vs. the ChatGPT conversation that owns it |
| Process lifetime | content script (document) vs. service worker (suspends) vs. app (restarts) |
| Durable vs. frontend identity | local session id vs. the ChatGPT conversation attached to it |
| Async vs. selection | a load started for A vs. the B the user has since selected |

If a bug looks like four subsystems failing at once, it is one of these, once. Find the
**earliest wrong identity or state transition** — not the last UI that displayed it.

### Name the identity, then find where it is lost

Every boundary above is a place where one specific identity is supposed to survive. Before
reading any code, say which one this bug is about. If you cannot state it, you have not
found the real boundary yet.

| Plane | The identity that must survive |
| --- | --- |
| filesystem | approved root + stable contained object/path authority |
| MCP call | normalized request id |
| tool ownership | request id -> conversation id |
| browser observation | conversation id + navigation epoch + message/turn identity |
| agent | conversation id -> prime or worker slot |
| workspace | conversation/agent key -> cwd |
| terminal | proven owner -> exec session id |
| session | local session id + conversation lineage |
| compaction | continuation token + from/to conversation |
| renderer load | selected session id + load generation |
| connection | tunnel/endpoint generation |
| desktop coordinates | screenshot frame id |

Then classify which plane produced the **first** wrong fact — MCP transport/discovery,
permission/sandbox/tool runtime, browser observation/identity, bridge/session/agent
orchestration, renderer presentation, or tunnel/packaging. Do not start in the file where
the symptom is displayed.

Three policies apply everywhere and are not repeated per section:

- **Fail closed** when a guess could cause cross-root access, cross-chat attribution,
  cross-agent terminal control, wrong workspace mutation, wrong compaction target, unsafe
  rendered HTML, or invalid image content reaching the model. For presentation-only
  degradation, keep the UI usable and label the uncertainty instead.
- **Scope every async result to the epoch that requested it** — navigation epoch, load
  generation, connection generation, endpoint lifetime. Id equality alone is not enough:
  an A → B → A navigation defeats it.
- **Bound every representation of large output** — bytes, tokens, decoded pixels, base64,
  structured fields. Not just the visible text, and not just the compressed input.

## 3. What is authoritative

Sources disagree here because the architecture moved fast. Precedence:

1. current implementation **plus a reproducible test or live repro**;
2. current declarations: `mcp/surfaces.ts`, `mcp/tools-core.ts`, `mcp/tools-github.ts`,
   `mcp/reference-tool.ts`, `shared/types.ts`, `package.json`, `main/version.ts`,
   `extension/manifest.json`;
3. `README.md`;
4. public design references such as `docs/tool-surface.md`. Internal working notes and
   security reproductions are maintainer-only; a public clone should treat §5–§18 of this
   file as the architecture and design record.

**Code comments in this project are unusually load-bearing.** Many name the exact live
failure that motivated a guard. Read the comment before deleting the guard or "simplifying"
the state machine. Code and current tests still win when a comment has drifted.

### Baseline

Release numbers are authoritative in `package.json`, `src/main/version.ts` and
`extension/manifest.json`; the bridge protocol is `version.ts::BRIDGE_PROTOCOL`. Tests assert
the app/extension versions stay in sync, so this architecture guide deliberately does not
copy a release number that can drift. Core is cross-platform at the source abstraction level;
the supported product/release target is Linux. Main process is TypeScript; extension is plain
MV3 JavaScript with no build step; Vitest; `node-pty` is the main native terminal dependency.
Desktop automation remains inherited and explicitly Windows-only.

Fresh-install defaults from `config.ts` are security-first: **all model-facing capabilities off**,
**read-only on**, **recording off**, **automatic compaction off**, **multi-agent off**, and
**Goal off**. Existing explicit stored choices are preserved by migration. Linux is the only
current supported product target. When command execution is granted on Linux it must pass through
the Bubblewrap sandbox; there is no unrestricted command fallback when the backend cannot establish
the boundary. Windows/macOS code may remain inherited, but platform-specific behavior there is not
a supported-product acceptance requirement.

### Stale-doc traps

Do not "restore" these from an older document:

- `view_image` is its own Core tool, not a mode of `read`.
- Core declares **10** possible tool names and exposes at most **9** live schemas: `find` and the
  `exec_command`/`write_stdin` pair are mutually exclusive at initial discovery. The names are
  `read`, `view_image`, `find`, `apply_patch`, `exec_command`, `write_stdin`, `local_github`,
  `reference_web`, `session`, `agents`. Reporting must derive from the surface projection, never
  a hardcoded count.
- `local_github` and `reference_web` are separate application-controlled network authorities;
  neither grants network access to ordinary `exec_command`, and neither grants the other.
- `session` has exactly two actions, `search` and `read`. Search discovers recordings; read
  requires an explicit local session id and returns lossless cursor pages. Compact & Resume is
  app/browser orchestration — there is no model-visible `save_handoff`.
- Extension pairing is silent loopback `/pair` bearer provisioning plus companion authentication.
  The six-digit flow is gone.
- Canonical messages live in `messages/*.json`, one replaceable shard per logical id; legacy
  `messages.json` is read during lazy migration. They are not appended forever to `events.jsonl`.
- The current Linux command path is Bubblewrap-contained. Old statements that approved roots only
  constrain the starting cwd and the command otherwise runs unrestricted on the host are obsolete.
- The supported product is Linux-only. Windows/macOS packaging and Desktop automation source are
  inherited code, not current release surfaces.

## 4. Repository map

```text
── shell / config ─────────────────────────────────────────────────────────
src/main/index.ts             Electron startup, window/tray, shutdown, security shell
src/main/shutdown.ts          ordered teardown phases, each bounded, ending in the exit
src/main/config.ts            validated settings, migrations, defaults, read-only caps
src/main/connection.ts        MCP + tunnel lifecycle, per-surface publication & status
src/main/ipc.ts               every renderer→main operation and main→renderer push
src/preload/index.ts          the complete renderer-facing API allowlist
src/main/secrets.ts           Electron safeStorage-backed secret storage
src/main/logger.ts            redacted RAM-only operational log (not the session store)
src/main/durable.ts           small named JSON state files under userData/state
src/main/diagnostics.ts       the UI self-test chain, hop by hop
src/main/host-env.ts          least-authority environments for trusted host helpers

── MCP ────────────────────────────────────────────────────────────────────
src/main/mcp/server.ts        HTTP transport, secret paths, body bounds, exposure cache
src/main/mcp/tools.ts         builds exactly one surface's server; refuses foreign names
src/main/mcp/surfaces.ts      Core/Desktop discovery boundaries + declared tool names
src/main/mcp/kernel.ts        dispatch, live guards, caller/workspace identity, agent inbox
src/main/mcp/tools-core.ts    Core filesystem/exec/session/agent registration + wrappers
src/main/mcp/tools-github.ts  restricted repository-scoped GitHub tool registration
src/main/mcp/reference-tool.ts reviewed-reference tool registration
src/main/mcp/tools-desktop.ts inherited Windows Desktop registration + wrappers
src/main/mcp/inbound.ts       x-request-id extraction and normalization
src/main/mcp/call-context.ts  AsyncLocalStorage per call + in-flight accounting
src/main/mcp/instructions.ts  model-facing server instructions

── filesystem / execution / restricted external authority ────────────────
src/main/sandbox.ts           approved-root authority + virtual/native mapping
src/main/contained-fs.ts      stable-FD Linux model-facing filesystem containment
src/main/workspace.ts         per-chat/agent learned project cwd (convenience, not auth)
src/main/rawfs.ts             raw Node fs, bypassing Electron's asar interception
src/main/fsops.ts             shared bounded file/image/text helpers
src/main/search.ts            connector search implementation
src/main/command-sandbox.ts   production Bubblewrap launch/profile assembly
src/main/linux-toolchain.ts   trusted read-only Linux toolchain/cache projection
src/main/github-remote.ts     restricted host-side GitHub transport/provenance
src/main/reference-web.ts     fixed-catalog reviewed public-reference transport
src/main/codex/tool-specs.ts  model-visible Codex contract text
src/main/codex/unified-exec.ts        exec_command / write_stdin runtime
src/main/codex/unified-exec-constants.ts  yield deadlines, buffer and token policy
src/main/codex/exec-output.ts model-facing exec serialization
src/main/codex/shell.ts       shell selection/quoting inside the approved launch path
src/main/codex/ownership.ts   terminal-session caller ownership
src/main/codex/filesystem.ts  ported low-level Codex fs primitives (no policy)
src/main/codex/read-backend.ts  connector read semantics over those primitives
src/main/codex/view-image.ts  image load/validate + MCP content adaptation
src/main/codex/apply-patch/*  V4A parser / matcher / runtime / shell interception

── sessions ───────────────────────────────────────────────────────────────
src/main/session/store.ts     durable sessions, messages, assets, handoffs
src/main/session/recorder.ts  merges MCP truth with browser observations
src/main/session/correlation.ts  requestId → conversationId proof registry
src/main/session/continuation.ts transactional Compact & Resume rebind
src/main/session/handoff-prompt.ts  the brief injected into the old chat
src/main/session/summarize.ts human-readable activity summaries
src/shared/chronology.ts      timeline ordering and folding
src/shared/session.ts         session/activity/swarm wire types
src/shared/goal.ts            Goal prompts (continuation + specific goal) and their bounds
src/shared/types.ts           config/app/IPC types and Capabilities

── browser ────────────────────────────────────────────────────────────────
src/main/bridge.ts            extension HTTP bridge + compaction/worker orchestration
src/main/goal.ts              the goal loop: OpenRouter request, context, one draft per turn
src/main/agents.ts            the global-active-run/reusable-worker multi-agent broker
src/main/companion-auth.ts    app-materialized companion identity proof
extension/chatgpt-dom.js      EVERY ChatGPT selector and DOM-shape assumption
extension/content.js          page recorder, turn lifecycle, Overwrite, compact/agent UI
extension/fiber.js            MAIN-world React/Fiber evidence reader (least trusted)
extension/background.js       service worker: token, journal, tab↔conversation registry
extension/popup.*             status/reconnect UI

── other ──────────────────────────────────────────────────────────────────
src/renderer/main.ts          setup/settings/connection/activity UI
src/renderer/chat.ts          session timeline, handoff, swarm UI
src/main/computer/*           inherited Windows screenshots/UIA/input helper
src/main/tunnel/*             index.ts lifecycle · health.ts metrics · locate.ts binaries
test/*.test.ts                subsystem-focused regression suites
scripts/*                     build, provenance, privacy, milestone and verification helpers
electron-builder.yml          current package contents/target policy
```

`exec.ts` remains as the shared low-level process/environment primitive used by unified exec,
the inherited Windows desktop helper and tunnels. The retired connector-native managed-process
and patch stacks were removed after production moved to `codex/unified-exec.ts` and
`codex/apply-patch/*`; do not recreate parallel runtimes beside those live owners.

---

## 5. Startup and shutdown — `index.ts`

```text
single-instance lock → fork-owned userData paths (config/secrets/sessions/state)
  → load validated config + durable state
  → restore request correlations, repair deterministic attribution
  → restore durable swarm/worker history as permitted
  → hardened BrowserWindow → register fixed IPC handlers
  → start bridge when browser augmentation needs it → prune old sessions
  → auto-connect MCP/tunnel if configured
```

**Must hold.** The window keeps context isolation on, Node integration off, renderer
sandbox on, navigation and window creation constrained, permission requests denied unless
explicitly supported. Never weaken that to solve a renderer convenience problem. Every new
long-lived process, timer, listener, queue or durable writer names its shutdown owner —
teardown covers tunnels, both listeners, process sessions, then flushes session and durable state.

`will-quit` calls `preventDefault()` and owns the decision to quit from then on, and it
destroys the tray before teardown starts. So teardown is not merely ordered, it is **bounded**:
`shutdown.ts` gives each phase its own budget and always ends the process. A task that never
settles would otherwise strand an invisible main process holding the single-instance lock, and
every later launch of the app would silently do nothing. Per-task bounds are not a substitute
for that — "each piece is bounded" is a different claim from "the sequence ends".

Ending it is `app.exit(0)`, never `app.quit()`, and that is not interchangeable. Electron drops
a quit raised from the promise continuation that finishes teardown: on Windows the call returns
without even emitting `before-quit`, while the same call one macrotask later quits normally.
`shutdown.ts` therefore owns the exit itself rather than trusting its caller to remember.

## 6. MCP surfaces and discovery — `surfaces.ts`, `tools.ts`, `server.ts`

ChatGPT discovers **one server's entire tool list as a unit**: a no-query
`list_resources` returns every schema that server advertises. Splitting into separate
servers is therefore the only mechanism that actually bounds the worst case. The current
Linux-supported product publishes Core only; the inherited Desktop surface remains documented
for source review/future work but is not a Linux product surface.

**Core** (required current surface):

| Tool | Live when | Implementation |
| --- | --- | --- |
| `read` | `read` \| `browse` \| `metadata` | `tools-core.ts` → `codex/read-backend.ts` |
| `view_image` | `read` | `tools-core.ts` → `codex/view-image.ts` |
| `find` | `search` **and not** `command` at initial discovery | `tools-core.ts` → `search.ts` |
| `apply_patch` | any of `create`/`edit`/`move`/`deleteFile` | `codex/apply-patch/*` |
| `exec_command`, `write_stdin` | `command` | `codex/unified-exec.ts` through Linux Bubblewrap containment |
| `local_github` | separate GitHub/network capability and effective mutation mode | `tools-github.ts` → `github-remote.ts` |
| `reference_web` | `publicReference` | `reference-tool.ts` → `reference-web.ts` |
| `session` | recording enabled | session subsystem |
| `agents` | multi-agent enabled | `agents.ts` |

**Inherited Desktop** is Windows-only source: `observe` needs `screen`; `computer` registers on
`control` **or** either clipboard permission, then re-checks every action at runtime. Do not
advertise or execute it as a current Linux product connector.

**Exposure is monotonic per endpoint lifetime.** ChatGPT caches schemas, and yanking one
from under a cached snapshot surfaces as a transport-level UNKNOWN failure. So
`server.ts` remembers what this endpoint has ever exposed. A permission revoked after
exposure leaves the schema registered and its handler returns `TOOL_DISABLED`. The
`find`-vs-exec choice is frozen the same way, at first discovery.

**Must hold.** Two separate concepts, never collapsed: *exposed* (a schema may exist
because it was visible earlier) and *live* (the operation is allowed now).
**Schema visibility is never the security boundary** — `config.ts::effectiveCapabilities()`
and the live guards are. A server registers only tools its surface declares and answers
anything else with a protocol-level unknown-tool error; there is no merged list and no
hidden acceptance. A deliberate reconnect/new conversation is the clean boundary for
changing the discovered shape; live revocation still applies immediately.

**Tests.** `mcp.test.ts`, `config.test.ts`, `mcp-shutdown.test.ts`,
`tools-github.test.ts`, `public-reference-capability.test.ts`.

## 7. One MCP call, end to end

```text
tunnel request
 → server.ts    loopback Host/Origin, secret tokenized path, bounded body,
                x-request-id read + normalized (split before '/')
 → tools.ts     build only the requested surface
 → kernel.ts    AsyncLocalStorage call context
                resolve exact caller from correlation evidence
                resolve agent identity if a swarm is active
                wait for identity when the operation genuinely needs it
                enforce the live capability / read-only guard
 → tool handler contain model paths / execute through the owning authority,
                attach structured evidence (changes, counts, exit code,
                session id, assets, restricted external result metadata)
 → recorder.ts  exact args/result/outcome; attach ONLY on proven ownership
 → kernel       agent inbox offer/ack bookkeeping
 → response
```

`server.ts` manually reads and bounds chunked / no-`Content-Length` POST bodies before
handing parsed JSON to the MCP adapter. **Do not regress that to a `Content-Length`-only
guard.** `inbound.ts` captures the raw header because the MCP library's higher-level
context has not reliably exposed it.

`call-context.ts` keeps **two** in-flight counters: handlers currently executing, and MCP
requests still in dispatch (including the identity wait and the durable recording that
happens after the handler returns). Orphan and stale-agent cleanup depends on the wider
one — a tool can have finished mutating the machine while its request is still being
attributed.

## 8. Filesystem and command containment — `sandbox.ts`, `contained-fs.ts`, `command-sandbox.ts`

Approved folders get virtual roots such as `/project`; native absolute paths are also accepted
when they resolve inside an approved root. Model-facing Linux filesystem operations must retain
containment at the point of use rather than treating one earlier pathname canonicalization as
a security boundary.

**Must hold for filesystem tools.**

- Every model filesystem path converges on approved-root authorization and the hardened contained
  I/O path appropriate to the operation. "It is only a read" is not an exemption — reads are
  confidentiality-sensitive.
- **Virtual and native spellings receive identical authorization.** Test both forms and never
  normalize a native spelling into a traversal the virtual spelling would reject.
- Authorization must survive symlink/path replacement races at actual I/O. Stable-FD containment
  exists precisely because repeated `realpath()`/pathname checks are not enough.
- Native filesystem error text must not leak hidden physical root paths back to the model.

**Linux commands are separately OS-contained.** `exec_command`/`write_stdin` launch through the
production Bubblewrap profile when command authority is enabled. Approved roots are the only
writable host mounts; required system/toolchain runtime roots are read-only and provenance-checked;
HOME/TMP/XDG are private; ambient credential-like state is removed; and ordinary commands do not
share the host network namespace. If Bubblewrap, the workdir, namespace setup or required
containment cannot be proven, the command does not start. There is no unrestricted Linux fallback.

Approved-root filesystem containment and command containment are related but different boundaries:
file tools are main-process I/O constrained to approved roots; commands are arbitrary project code
inside an OS sandbox whose writable host authority is those roots. Do not claim one boundary proves
the other.

Read-only mode disables effective write/command/GitHub mutation authority without pretending the
stored configuration changed. New write capabilities must become read-only-blocked automatically.

**Tests.** `filesystem-containment.test.ts`, `sandbox.test.ts`, `command-sandbox*.test.ts`,
`env-security.test.ts`, `linux-toolchain.test.ts`, plus retained adversarial repros.

## 9. Workspaces — `workspace.ts`

Two ideas that are easy to confuse: **approved roots** are the security boundary the user
configured; a **workspace** is convenience state saying which project *this exact chat or
agent* is working in.

Keyed by exact chat/agent identity, learned from proven absolute paths and project markers,
inherited by spawned workers, moved by Compact & Resume.

**Must hold.** A relative path or omitted `workdir` with no trustworthy workspace **fails**
rather than mutating a guessed project. When caller identity is unresolved during a swarm,
never silently fall back to the first approved root — that turns an attribution failure
into a wrong-target mutation. Moving a workspace is state continuity, never a new
permission; the target still has to be legal.

**Tests.** `workspace.test.ts`, `swarm.test.ts`.

## 10. The Codex-derived tools — `src/main/codex/*`

Selected public Codex behavior ported into TypeScript. **It does not launch a Codex model
or require a Codex installation.**

**`exec_command` / `write_stdin`.** `unified-exec.ts` ports session ids, output draining,
head/tail buffering, yield deadlines, output token policy, interactive stdin, and sessions
that outlive the call that created them. The local MCP adaptation accepts `cmds` to run
related commands sequentially in one labeled shell session, and an empty `write_stdin` poll
returns on first output instead of holding the full collection window. On the supported Linux
product, shell/runtime selection is subordinate to the trusted Bubblewrap launch path; do not
reintroduce host-network or real-HOME behavior as "parity". Start at `tools-core.ts`
→ `unified-exec.ts` → `shell.ts` → `ownership.ts` → `exec-output.ts`.

**`apply_patch`.** Model syntax is Codex V4A. MCP cannot expose a true freeform tool, so
the raw patch rides inside the `patch` string while the grammar lives in the description.
Engine under `apply-patch/`; the wrapper adds capability checks (per hunk kind — add needs
`create`, delete needs `deleteFile`, content change needs `edit`, rename needs `move`),
contained filesystem resolution, workspace behavior, recorder evidence. **Shell interception**
also exists so a model emitting `apply_patch` as a shell command still reaches the port — if the
failure involves `cd`, quoting, `&&` or other control flow, the bug is above the parser.

**`read`.** Deliberately layered: `tools-core.ts` owns the model contract and multi-path behavior;
`read-backend.ts` owns decoding/listing semantics; `filesystem.ts` is primitives only; the
sandbox/contained filesystem layer owns authority. **Do not push authorization down into low-level
Codex primitives and assume the public tool became safe.**

**`view_image`.** 8 MiB transport ceiling. PNG gets a real decode check; JPEG/GIF/WebP
validation has documented limits and does not yet match upstream's full-decoder guarantee.
Synchronous validation of an adversarial compressed payload is a main-process resource
risk. An invalid `image` content block can break an entire model turn — **prefer rejection
over optimistic decoding.**

**Tests.** `codex-runtime-parity`, `codex-apply-patch-parity`,
`codex-apply-patch-invocation-parity`, `codex-view-image-parity`, `mcp`.

## 11. Identity — the spine of the whole project

An MCP payload contains **no trustworthy ChatGPT conversation id**. There is exactly one
accepted proof chain:

```text
HTTP x-request-id                       (inbound.ts, normalized before '/')
  ≡ page message.metadata.request_id
  → fiber.js      emits allowlisted request evidence from the MAIN world
  → content.js    reports requestId + conversationId
  → background.js journals it durably
  → bridge.ts     accepts it for that conversation
  → correlation.ts  proves requestId → conversationId
  → consumed by: kernel · recorder · agents · workspace · terminal ownership
```

**Never substitute** active tab, timing, tool name, most-recent chat, only-generating chat,
worker payload, or arrival order. If proof is missing the safe state is **Unattributed**,
no workspace, or refusal for identity-sensitive work. Guessing is worse than losing
attribution: it routes commands, files, messages and history into the *wrong* chat.

This one chain explains symptoms that look unrelated — worker `WORKER_IDENTITY_LOST`, calls
piling into Unattributed, false worker stalls, wrong or absent project cwd, terminal
polling crossing chats, agent messages stopping, Overwrite having no local activity to
render. When several appear together, **debug the chain, not the symptoms**, in this order:

```text
server.ts/inbound.ts  did x-request-id arrive and normalize?
fiber.js              did the page model expose a matching metadata.request_id?
content.js            did refreshFiber receive it and emit tool_evidence?
background.js         was it journalled and delivered?
bridge.ts             was it accepted for the intended conversation?
correlation.ts        was requestId→conversationId stored, and restored after restart?
kernel.ts/recorder.ts did the call wait for, find and use the exact proof?
```

Agent routing is *downstream* of this. Do not start there.

**Tests.** `correlation.test.ts`, `mcp-inbound.test.ts`, `fiber.test.ts`,
`content-script.test.ts`, `swarm.test.ts`.

## 12. Session recording — `recorder.ts`, `store.ts`

Two independent producers, one durable timeline, neither replaceable by the other:

1. **MCP/app truth** — exact tool, arguments, result, outcome, file changes, duration, assets.
2. **Browser observation** — authored messages, turn lifecycle, native progress, visible
   errors, conversation identity, page request evidence.

The app knows *what the tool did*. The browser knows *which conversation and turn showed it*.

```text
userData/sessions/<id>/
  events.jsonl        append-oriented tool/turn/error/activity events
  messages/*.json     canonical user/assistant messages, one shard per logical id
  messages.json       legacy canonical map, read during lazy migration
  meta.json           atomically rewritten projection
  assets/<id>         screenshots and large/binary material
  handoffs/<id>.json  saved compaction briefs
```

**Must hold.** Streaming website messages are mutable snapshots of one logical message, so
Canonical message shards **replace by stable identity** — never turn that back into blind appends.
Structured activity stays append-oriented. Large values bound inline and spill to assets;
never fix a display-size problem by discarding the durable source. Durable state is the
authority across restart, and `meta.json` must never claim events that `events.jsonl` does
not contain. Unattributed is a **first-class state**, not a bug to paper over.

Distinct from `logger.ts`, which is small, redacted, RAM-only and operational.

**Tests.** `session.test.ts`, `chronology.test.ts`, `resume.test.ts`.

## 13. The Chrome extension — `extension/*`

Three execution contexts with **three different lifetimes**:

| File | World / lifetime | Owns |
| --- | --- | --- |
| `chatgpt-dom.js` | isolated, document | every selector and DOM-shape assumption |
| `content.js` | isolated, document | observation, turn lifecycle, Overwrite, compact/agent UI |
| `fiber.js` | **MAIN**, document | React/Fiber evidence the DOM does not reveal |
| `background.js` | MV3 worker, **suspends freely** | bridge token, journal, tab↔conversation registry |

Plus `chrome.storage.session` — survives worker sleep, dies with the browser session — and
tab↔conversation binding, which follows tab lifetime and explicit navigation.

**`chatgpt-dom.js`** groups logical turns, extracts authored text, finds buttons/errors/tool
rows, and strips local-cgpt-owned surfaces before reading so rendered replacements do not feed
back into recording. When ChatGPT changes markup, fix it here. **Never scatter emergency
selectors into `content.js`.**

**`content.js`** owns per-document memory: conversation epoch, seen-message identities, live
turn state, Fiber cache, rendered replacement state, pre-service-worker queue.

**`fiber.js` is intentionally least trusted.** It emits a strict **allowlist** (not copied
props minus a denylist), never tool argument values, validates the expected connector
identities, and fails closed on unfamiliar React shapes. Its `postMessage` output is
page-controlled evidence useful for joining page to local truth — **never a credential**.
Its protocol version and the content-side expectations move together.

**Must hold.** ChatGPT is an SPA: every async result proves it still belongs to its
navigation epoch before mutating state. `pagehide` is **not** proof a conversation ended —
reload and bfcache fire it too; real closure is decided at the service-worker layer from tab
removal and navigation away. **Reload is not conversation close.** Content-script acceptance
means *handed to the journal*, not *stored by the app*, and the journal must never silently
lose something it already acknowledged as durable. Recovery must validate **every** context
whose health it needs — proving the isolated recorder is alive says nothing about a dead
MAIN-world Fiber helper. Recorder takeover is total ownership transfer: the predecessor must
disconnect MutationObservers and DOM/window handlers **and** unregister extension-level
`chrome.runtime.onMessage` / `chrome.storage.onChanged` listeners. An `alive=false` predecessor
must never answer a health check, compete for a worker-revival command, or repaint Overwrite
after the successor owns the document.

M7 owns reducing always-on extension work by keeping feature-specific observers/state machines
dormant when their corresponding feature is disabled. That optimization must preserve the
identity/pairing/health evidence required by this section.

**Tests.** `content-script.test.ts`, `fiber.test.ts`, `extension.test.ts`,
`extension-security.test.ts`.

## 14. The browser bridge — `bridge.ts`

A second loopback HTTP service on the first free port of **8765–8769**. The extension finds
it with `/hello`, pairs through the authenticated companion flow, then uses bearer-authenticated
routes for status/events/activity, compaction, Goal, settings and durable browser commands.
Exact route inventory is implementation/protocol state; do not copy an old list into a security
argument without checking `bridge.ts` and bridge tests.

**Must hold.** The bearer never enters the ChatGPT page — the service worker holds it in
extension-owned state and the app keeps its counterpart out of config and log surfaces. Pairing
authenticates the reviewed/materialized companion rather than trusting Origin as identity. The
bridge exposes **no generic filesystem, shell-command, capability-grant or secret-read route**.
Its settings mutation surface is intentionally narrow (browser/Goal/compaction behavior), validated
by the app, and must never become a generic config write escape hatch. Protocol mismatch against
`BRIDGE_PROTOCOL` warns once rather than spamming. Concurrent startup must not race on listener
ownership.

Because this is where browser-observed lifecycle meets recorder, agents, continuation and
workspace state, a `bridge.ts` bug presents as a session, extension, or agent bug depending
on which end you inspect.

**Tests.** `bridge.test.ts`, `extension.test.ts`, `companion-auth.test.ts`.

## 15. Compact & Resume — `session/continuation.ts`

**The local session id is the durable identity.** ChatGPT conversations A and B are
frontends attached to that one session in sequence.

```text
chat A owns session S
  → A writes its own final handoff brief   → captured and stored verbatim
  → open continuation token for S
  → open one marked fresh chat; exactly one claimant B redeems it
  → preflight   freeze prime/swarm transfers that must move atomically
  → DURABLE COMMIT   rebind S from A to B on disk        ← the one fallible phase
  → publish     recorder mapping, workspace binding, swarm prime binding
  → B continues session S
```

**Must hold.** If preflight or the durable write fails, **A keeps the session**. Once the
durable write succeeds, publication is total in-memory map movement. Never implement
compaction by creating a second session or copying history — the whole feature is continuity
of one durable id. Automatic compaction is **edge-triggered and durable**: reopening an
already-large old chat must not re-fire merely because its level sits above the threshold.

**Tests.** `continuation.test.ts`, `resume.test.ts`, `goal-resume-handoff.test.ts`.

## 16. Multi-agent — `agents.ts`

Experimental and **off on fresh installs** while existing configs preserve their explicit stored
choice. The current broker permits **one global active execution run at a time**, with durable
prime-owned histories parked when no worker occupies a slot. Star topology remains
`worker ← prime → worker`; workers never message each other.

**Identity.** The prime is the conversation that successfully called `agents action=spawn`
with proven caller identity. Worker slots are opened by the app through browser bootstrap;
once the page has a real conversation id the extension reports it and the broker binds that
exact conversation before normal worker work proceeds. **Conversation identity is the
routing credential** — established from the same evidence as recorder attribution — so no
secret token rides in model arguments and **sender identity never comes from a model
argument**. There is no model-carried recovery credential: a worker whose binding was lost
is rebound only through app/extension evidence for its chat.

**Messaging is at-least-once until acknowledged**: queued durably → offered on a tool result
→ acknowledged by the next authenticated tool call. Offering on a result is **not** proof
the model received it. Never delete a message merely because it was offered.

**Workers sleep; they do not end.** `finish` reports a result and normally puts that worker to
*sleep*: it keeps its conversation, keeps its history, and stays revivable. Sleeping frees
its worker slot, so `maxWorkers` counts working workers only — a prime can create a new worker
while an older one sleeps and still wake that older worker afterwards. The same sleep may happen
without a finish tool call from durable evidence that the worker stopped: a settled final assistant
turn, or bounded quiescence when page evidence is unavailable.

Model-facing instructions must teach this exact reuse model. A statement that a normally finished
worker is permanently finished and should always be replaced is stale and currently tracked as M6
correctness debt; M8 adds lifecycle/instruction contract tests so prose cannot drift from the broker.

**Ownership outlives the active run.** When no worker occupies a slot, the active incarnation is
parked immediately and the one global execution claim is released. Its complete agent map becomes
a durable history keyed by the prime conversation: sleeping workers, terminal/non-revivable rows,
their exact ChatGPT conversation bindings, queued prime reports and monotonically allocated
`worker-N` history all remain. Another prime may now start its own active incarnation, including
its own same-named `worker-1`, without seeing or mutating the first prime's history. Caller-scoped
`status` always returns the history owned by that prime. A dormant prime may spawn a fresh worker
without reviving a sleeper; waking an old worker reactivates that owner's history only when the
global execution slot is free. Explicit swarm clear is different from parking: it retires worker
conversation fences and discards retained histories. Turning Multi-agent **off is not Clear**: it
stops/withdraws live execution, parks owner history, and keeps that history durable through disabled
app restarts so re-enable can still show and revive the exact old worker conversations.

**Waking is messaging.** `agents action=message` to a sleeping worker reserves a free slot
inside the same durable barrier that queues the message, and only after that commit does the
browser get asked for anything. The revival is an ordinary durable bridge command whose spec
names the worker's own `conversationId`: the app opens that exact conversation, reuses/focuses an
existing tab when possible, and the content script types the prime's words as a genuine user
message. No free slot means the send is refused outright — nothing is queued and nothing is typed.
A revival that fails returns the worker to `sleeping`, returns the slot, leaves the message queued,
and reports the failure.

**The current ceiling is the only normal permanent ending.** A worker becomes non-revivable when
its chat reaches `WORKER_CONTEXT_CEILING_TOKENS` (400k), measured from the app's durable session
accounting — never from a model-carried counter. Crossing it does **not** interrupt work in flight;
it makes the *next* stop permanent. Workers currently **never Compact & Resume themselves** because
the conversation is their bound identity. M8 may replace this retirement model only through an
explicit transactional logical-worker/conversation-generation design; never silently open a
replacement chat based on similarity or timing.

**Finish and cleanup.** `finish` is idempotent; final worker output routes to the exact prime
conversation even if parking happens on that same finish. Once no worker holds a slot, the active
incarnation releases immediately; pending reports remain in the dormant prime's inbox and retain
the same at-least-once offer/ack semantics. Dormant worker conversations remain authority fences,
including terminal rows, so stale tabs cannot fall through as ordinary unidentified chats while a
different prime is active. Orphan cleanup uses durable quiescence plus the wider in-flight
MCP/observation counters — not a heartbeat guess. Compact & Resume moves active **or dormant**
prime ownership together with session/workspace state; normal commit and recovery repair transfer
the same complete worker history to the child conversation or move nothing.

**Tests.** `agents.test.ts`, `swarm.test.ts`; revival/browser behavior is also covered by
`bridge.test.ts`, `extension.test.ts` and `content-script.test.ts`.

## 17. Renderer, IPC, connection and desktop

**Goal.** `goal.ts` sends only authored user messages and final assistant answers to
OpenRouter. **Two** persisted prompts are editable under Chat → Settings, both bounded by the
same shared limit at config and IPC: `goal.prompt` is the gate used by a chat with no goal of
its own, and `goal.objectivePrompt` is the driver used instead once a chat carries one. The
driver was a source constant until it became editable; nothing else about which one applies
changed. Both are written as meta-prompter instructions rather than as review policies — the
model is told it sits in the user's seat, given the two moves it has (next user message, or
exactly `NO_REPLY`), and taught by worked examples including silence. A change to either prompt
retires existing drafts so one draft never mixes old and new instructions. Terminal Goal cards
persist for visibility but their dismissal is scoped to the exact finished turn. Provider output
is still validated locally; malformed schema, reasoning wrappers/tags or empty cleaned replies fail
closed before anything reaches the browser composer.

**A chat's own goal.** The composer control can exist in New Chat because a stored goal may write
that chat's first message; compaction remains unavailable there. `/goal/objective` stores one goal
per conversation in durable Goal state, separate from global config. A stored goal arms the loop for
that chat even while the standing switch is off; worker rules still override it. Compact & Resume
projects the objective A→B in the continuation transaction, including recovery repair.

**Turn outcomes the loop answers.** `completed` and app-observed `interrupted`, and no user-stopped
turn. Do not broaden this from renderer timing guesses.

**Renderer/IPC.** `renderer/main.ts` is setup/permissions/connection/activity;
`renderer/chat.ts` is session timeline, handoff, swarm. To add a capability: narrow
main-process action → validate in `ipc.ts` → expose exactly that method in
`preload/index.ts` → call it. **Never add a generic `invoke(method, args)` escape hatch.**
Async loads use generation counters so a slow load for session A cannot paint over the B the
user selected, and unsolicited state pushes must not clobber a focused unsaved form field.
Captured ChatGPT HTML is untrusted: `chat.ts::renderedMessage()` allowlists semantic tags,
strips attributes, drops executable/form/embed content and non-safe link schemes.
Tests: `ipc.test.ts`, `renderer-html.test.ts`, `renderer-layout.test.ts`, `renderer-state.test.ts`.

M6 owns responsive layout, accessibility semantics, visual regression and first-class agent status
presentation. Those are presentation improvements; live main-process capability enforcement remains
the authority.

**Connection and tunnel.** `connection.ts` owns local MCP server → current surface publication →
UI status across `openai`, `cloudflared` and `manual` transports. Lifecycle operations are serialized
and generation ids invalidate callbacks from replaced tunnels — reuse that for any new async status
producer. `tunnel/index.ts` supervises the child; `tunnel/health.ts` parses route metrics/status.
Diagnostics must distinguish a local listener from a genuinely usable remote route and preserve the
same grace periods as production connection logic.

**Desktop automation (inherited Windows-only source).** `tools-desktop.ts` + `computer/*` contain
screenshots, UI Automation and input/clipboard behavior. They are not a supported current Linux
product surface. If future platform support revives them, registration-time permission is not enough:
each action must re-check authority and stale coordinate/frame protections.

**On-disk state to inspect.** The hardened fork uses its own `local-cgpt` Electron `userData`
namespace rather than importing upstream Chat On Steroids state. On supported Linux, inspect the
fork-owned config/state/sessions directory reported by Electron/app diagnostics rather than assuming
an upstream `chat-on-steroids` path. It contains validated non-secret config, durable sessions,
small durable indexes and the stable materialized extension copy; credentials stay behind
`secrets.ts`/OS safeStorage. Extension state is separate in `chrome.storage.local/session`.
When a restart bug appears, **first name which process restarted** — app, service worker, content
script, Fiber helper, document, tab, or browser. Each has a different persistence boundary.

---

## 18. Symptom → open these → tests

| Symptom | Open, in order | Tests |
| --- | --- | --- |
| tool missing/extra in ChatGPT | `surfaces.ts`, `tools-core.ts`, `tools-github.ts`, `reference-tool.ts`, `server.ts` | `mcp` |
| tool still visible after permission off | `server.ts` exposure cache, `kernel.ts` guard | `mcp`, `config` |
| permission / read-only mismatch | `config.ts`, `kernel.ts`, the tool wrapper | `config`, `mcp` |
| native vs virtual path disagreement | `sandbox.ts`, `contained-fs.ts`, `kernel.ts` | `sandbox`, `filesystem-containment` |
| symlink/path replacement escape or race | `contained-fs.ts`, `sandbox.ts`, actual I/O call | `filesystem-containment`, `fsops` |
| `read` wrong content/list/glob/budget | `tools-core.ts`, `read-backend.ts`, `filesystem.ts`, `fsops.ts` | `mcp`, `fsops` |
| `view_image` validation/transport | `view-image.ts`, `tools-core.ts`, `fsops.ts` | `codex-view-image-parity` |
| patch parse/match/write | `apply-patch/*`, `tools-core.ts`, contained I/O | both `codex-apply-patch-*` |
| shell-intercepted patch behavior | `tools-core.ts`, `apply-patch/invocation.ts` | invocation parity, `mcp` |
| exec / PTY / stdin / output / session | `unified-exec.ts`, `command-sandbox.ts`, `shell.ts`, `ownership.ts`, `exec-output.ts` | runtime parity, command-sandbox, `mcp` |
| command sees host network/HOME/credential unexpectedly | `command-sandbox.ts`, `env.ts`, `host-env.ts`, `linux-toolchain.ts` | command-sandbox, env-security, linux-toolchain |
| GitHub transport/ref sync/push/PR/issue | `tools-github.ts`, `github-remote.ts`, host env/provenance | `tools-github`, `github-remote` |
| reviewed public reference/SSRF/redirect/bounds | `reference-tool.ts`, `reference-web.ts` | `reference-web`, `public-reference-capability` |
| one chat touches another's terminal | `ownership.ts`, `kernel.ts`, then §11 chain | `mcp`, `workspace` |
| **calls land in Unattributed** | **§11 chain in order** — `inbound`→`fiber`→`content`→`background`→`bridge`→`correlation`→`recorder` | `correlation`, `mcp-inbound`, `fiber`, `content-script` |
| worker identity / inbox / liveness | §11 chain **first**, then `agents.ts`, stale sweep in `bridge.ts` | `agents`, `swarm` |
| wrong worker/project cwd | `workspace.ts`, `kernel.ts`, §11 chain | `workspace`, `swarm` |
| transcript duplicates / reorders / jumps | `chatgpt-dom.js`, `fiber.js`, `content.js`, `background.js`, `recorder.ts`, `chronology.ts` | `content-script`, `extension`, `session` |
| turn ends early / false stall | `content.js` lifecycle + Fiber terminal evidence | `content-script`, `fiber` |
| Overwrite vanishes / sticks / stale rows | `content.js` paint streams, `fiber.js`, `/activity` in `bridge.ts` | `content-script`, `bridge` |
| extension dies after reload/update | `background.js::restoreOpenChatgptTabs`, content↔Fiber handshake | `extension`, `fiber` |
| navigation resurrects wrong chat | `background.js` tab registry, `content.js` epoch | `extension`, `content-script` |
| bridge pairing / connect / stop | `bridge.ts`, `companion-auth.ts`, `background.js`, `popup.*` | `bridge`, `companion-auth`, `extension` |
| Compact & Resume split or lost | `continuation.ts`, `bridge.ts`, `store.ts`, `workspace.ts`, `agents.ts` | `continuation`, `resume` |
| auto-compaction repeats or never fires | `store.ts` edge state, compaction routes in `bridge.ts` | `continuation`, `resume` |
| agents spawn/message/finish/revival | `agents.ts`, `tools-core.ts`, `bridge.ts` | `agents`, `swarm`, `bridge` |
| session UI or main process freezes | `store.ts`, `chronology.ts`, `ipc.ts` read path, `chat.ts` | `session`, retained stress probe |
| stale render / typed input clobbered | `renderer/main.ts`, `chat.ts` generation guards, `ipc.ts` push order | `ipc`, `renderer-state` |
| theme/resize/accessibility regression | `renderer/styles.css`, `renderer/index.html`, `renderer/main.ts` | `renderer-layout`, future M6 visual/a11y gates |
| inherited screenshot/input/clipboard behavior | `tools-desktop.ts`, `computer/*` | `computer*` |
| connector offline / tunnel / self-test | `connection.ts`, `tunnel/*`, `diagnostics.ts`, `server.ts` | `tunnel`, `mcp` |
| renderer has too much authority | `preload/index.ts`, `ipc.ts`, `index.ts` window config | `ipc`, preload/renderer security |
| installed Linux build missing extension/tunnel/rg/node-pty | `electron-builder.yml`, `extension-path.ts`, packaging scripts | packaging/candidate smoke tests |

## 19. Working in this repository

### The tree is dirty and shared

Several agents and the user may be editing at once. Before touching anything:

```sh
git status --short
git diff -- <files you plan to touch>
```

Assume unrelated changes belong to someone else. **Never** `reset`, `checkout`, `clean`,
broad-format, or overwrite unrelated work to simplify your patch. If the exact lines you
planned to edit changed underneath you, reread and integrate — do not replay an old patch.

### The fix loop

1. Reproduce the real bug, or add a regression that **fails under the old input/ordering**.
2. Fix the earliest root cause — not the last place the wrongness became visible.
3. Run the nearest test file.
4. Run adjacent boundary tests when a protocol crosses modules.
5. `npm run verify` before calling production code done.
6. `npm run build` / package checks when bundling, native modules, resources, extension
   shipping or installer behavior could differ.

For M6–M8 work, use the additional UX/performance/agent evidence matrix in
`docs/agent-workflow.md`; a typecheck is not evidence that a visual, performance or state-machine
acceptance criterion passed.

A good fix here has three parts: the root-cause change, a targeted regression, and a comment
naming the non-obvious invariant when a future "simplification" could reopen it.

**Green unit tests do not prove** a browser race, a filesystem replacement race, an Electron
ordering race, a live ChatGPT Fiber shape, a process race, or resource-scale behavior. Model
the missing adversarial ordering, and use a live repro when feasible. For races prefer
epochs, generation ids, serialized mutation queues, idempotency keys, exact identity or
ownership locks — **not sleeps**, unless time really is the protocol. The reusable pattern:

```text
start A → pause A before its durable/publish step → run B to completion
        → resume A → assert B was not overwritten, resurrected or misattributed
```

Every security or identity fix needs its **negative case**: in-root native path works /
escaping native path fails; exact correlation routes / conflicting correlation does not
guess; owner polls the terminal / another worker cannot; current epoch accepts the Fiber
answer / stale epoch discards it.

**Both sides of a protocol.** A compiling one-sided edit is still broken. The multi-hop
protocols are: app↔extension bridge, content↔Fiber `postMessage`, main↔preload↔renderer
IPC, MCP schema↔handler↔recorder summary, durable store↔restart restoration.

### Commands

```sh
npm ci
npm run dev                              # electron-vite dev
npm run typecheck
npm test -- --run test/<target>.test.ts
npm run verify:privacy                   # public Git identity/session/path gate
npm run verify                           # the exact normal CI verification chain
npm run build                            # electron-vite bundles
npm run verify:linux-sandbox             # representative production Bubblewrap assertions
npm run dist:linux:x64                   # supported Linux x64 package family
npm run dist:linux:arm64                 # supported Linux arm64 package family
```

Do not infer supported Windows/macOS release behavior from inherited `dist:*` scripts. The current
product target and release/candidate policy are Linux-only and are documented in the roadmap and
packaging tests/workflows.

Vitest uses real filesystem, real processes and real HTTP in many suites; default
test/hook timeout is 30 seconds.

### Where a regression belongs

Suites are named for the subsystem they cover; use the nearest focused suite and then the wider
boundary/security gates. Important families include:

| Suite | Covers |
| --- | --- |
| `agents` / `swarm` | broker rules, prime/worker identity, reusable lifecycle, integration |
| `bridge` / `companion-auth` | extension↔app HTTP bridge, routes, auth, orchestration |
| `chronology` / `session` | recorded timeline/store behavior |
| `codex-apply-patch-*` | V4A parser / matcher / invocation/runtime parity |
| `codex-runtime-parity` | `exec_command` / `write_stdin` runtime parity |
| `codex-view-image-parity` | image validation, limits, transport adaptation |
| `command-sandbox*` / `filesystem-containment` | Linux OS/path containment boundaries |
| `config` | validation, migrations, read-only capability collapse |
| `content-script` / `fiber` / `extension` | browser recorder, evidence, lifecycle, journal |
| `continuation` / `resume` | Compact & Resume transaction and recovery paths |
| `correlation` / `mcp-inbound` | requestId→conversationId proof/persistence |
| `env-security` / `linux-toolchain` | child/host-helper environment and trusted runtime projection |
| `goal` | Goal privacy/prompt/output boundary |
| `github-remote` / `tools-github` | restricted GitHub authority and tool contract |
| `ipc` / renderer security/layout/state | main↔renderer authority and UI state contracts |
| `mcp` / `mcp-shutdown` | surfaces, handlers, integration and accepted-call draining |
| `reference-web` / `public-reference-capability` | reviewed-reference transport and live authority |
| `sandbox` / `fsops` / `search` | path policy and bounded file/search helpers |
| `shutdown` | bounded teardown phases |
| `tunnel` / provenance tests | tunnel routing, executable provenance and health |
| `workspace` | per-chat/agent workspace learning and keying |

### Delegating to workers

The prompt is part of the engineering work — a worker receives its task, not this
conversation. Each assignment states: project path, concrete objective, relevant subsystem
and likely files, evidence or reproduced symptoms it should inherit, constraints and
ownership boundaries, what it may edit, validation to run, and the expected handoff.

Start with the actual task. **Do not** open with canned text like "you have zero prior
context". Workers are already bound to their slot when launched, so nothing is asked of them
about identity. Put what every worker in the batch needs — project path, conventions file,
ownership boundaries, validation to run — in `spawn`'s `context` once; each `task` then
carries only that worker's own objective and files.

A normally completed worker sleeps and is reusable. If further work genuinely benefits from the
same context, message that sleeping worker to wake it rather than blindly spawning a duplicate.
A fresh spawn remains appropriate for independent work or when a worker is terminal/non-revivable.
Repeated-spawn idempotence is retry handling, not the same thing as deliberate worker reuse.

For audit-only roles make the write boundary explicit: source, tests, app data and config
stay read-only, and each worker may create only its named report. The prime then reads the
source itself, reproduces release-blocking claims, records what it accepted or rejected, and
owns every production edit. **Parallel reports are independent hypotheses — not votes, not
proof.**

When a recurring symptom is not yet a clean issue, use the available local transcripts and
durable session metadata to follow **one** concrete request id, conversation id, worker slot
or event sequence end to end. Keep any security-sensitive reproduction material private.

## 20. Packaging and release — `electron-builder.yml`, packaging workflows/scripts

The current supported product target is **Linux**. Hardened identity is `local-cgpt`, with Electron
app id `com.localcgpt.app`, Linux executable/package identity `local-cgpt`, and source-identified
Linux candidate artifacts. Inherited Windows/macOS packaging scripts/source may remain, but they are
not current release targets and must not weaken Linux policy.

- Packaged Linux command execution still uses the same fail-closed Bubblewrap containment path.
- Debian packaging must declare/install the host prerequisites required by the supported Ubuntu/
  Debian boundary, including Bubblewrap/AppArmor policy handling where documented.
- Reviewed tunnel-client/ripgrep/native resources use pinned/provenance-checked packaging paths;
  packaged builds must not silently replace them with ambient host binaries.
- `extension/` ships/materializes as reviewed bundled source; do not restore an upstream remote
  extension-download path.
- Public release publishing remains disabled until the owning release-provenance milestone says
  otherwise. A successful candidate build is not permission to publish a GitHub Release.
- M4 owns SBOM/checksum/provenance/signing policy beyond the controlled candidate boundary.

Before calling packaging work done, verify the **packaged** app contains and executes the expected
native resources, preserves fork-owned userData identity, and exercises the same supported Linux
security path as development. See `electron-builder.yml`, `scripts/package.mjs`,
`scripts/packaging-*.mjs`, `linux-test-build.yml` and packaging/candidate tests for the current
contract rather than reviving old six-platform release assumptions.

## 21. Security-sensitive areas

Some subsystems sit directly on trust boundaries and need extra review: browser/session identity,
MCP request lifecycle, approved-path enforcement, process execution, restricted external transports,
desktop control source, secrets, and resource limits. Keep public documentation focused on contracts
and invariants rather than publishing exploit recipes or detailed reproductions for unresolved
weaknesses.

Before changing one of these areas, reproduce the behavior against the current tree, preserve
fail-closed behavior, add a deterministic regression where practical, and verify neighboring
negative/security cases. Suspected security issues and reproduction details belong through the
private process in `SECURITY.md`, not in public issues, comments, or fixtures.

**Do not scatter fixes across symptoms before proving the shared root.**

## 22. Definition of done

- The reproduced failure is gone **for the root reason** — not hidden in the UI, not retried
  until lucky.
- The neighboring negative / security case still holds.
- A targeted regression captures the old failure ordering or input.
- Every producer and consumer of any changed protocol agrees.
- Model-visible schema, model-facing instructions and user-visible surface still match the implementation.
- Unrelated dirty work is untouched.
- Targeted tests pass and `npm run verify` passes for production changes.
- Build/packaging checked when the changed layer can differ after bundling.
- UX/performance/agent acceptance evidence is recorded when M6–M8 work requires it.
- Comments, README/tool docs and this file are updated only where behavior/facts genuinely changed.

> **The rule.** Name the identity crossing the failing boundary, follow one concrete item
> end to end, and fix the earliest place where reality diverges from that identity or
> invariant.

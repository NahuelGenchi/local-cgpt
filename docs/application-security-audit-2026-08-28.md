# Application security audit — 2026-08-28

## Audit target

Repository: `NahuelGenchi/local-cgpt`

Baseline reviewed: `security/hardened-baseline` at `686b74cde322991632051b8c0bb06fbe4b203e33`.

Audit branch: `work/app-security-audit`.

This review is intentionally **outside the Linux Bubblewrap command sandbox** except where an application-level boundary controls which host executable is launched. It focuses on malicious ChatGPT/web content, prompt injection, a compromised Electron renderer, browser-extension/page boundaries, local state/secrets, and runtime network/provenance.

## Threat model and security assumptions

These assumptions are part of the finding classifications. A change to one of them requires re-evaluating the affected finding.

1. **ChatGPT page content and page JavaScript are untrusted.** Prompt text, model output, React metadata, DOM attributes and synthetic DOM events are data, never authority.
2. **A compromised Electron renderer is untrusted.** It may call every method exposed by the preload with arbitrary JSON-compatible values and may control both sides of any renderer-generated merge payload.
3. **The main process and the isolated preload are trusted application code.** The renderer has no raw `ipcRenderer`, Node.js, filesystem, process-spawn or arbitrary network capability unless a named preload method grants one.
4. **The packaged renderer is the production renderer.** Development mode is a developer-controlled boundary. A loopback `ELECTRON_RENDERER_URL` is acceptable only in non-packaged runs; packaged builds must ignore it.
5. **A native Electron file picker is an explicit host authority gesture.** A renderer-supplied pathname is not equivalent to the user choosing that executable in the native picker.
6. **Tunnel helpers are privileged host processes.** `tunnel-client`/`cloudflared` are not run inside the model command Bubblewrap sandbox, so executable provenance is a security boundary.
7. **An explicit alternate tunnel executable selected through the native picker is user-authorized.** Automatic packaged lookup must prefer the reviewed bundle and fail closed rather than silently substituting an ambient host executable.
8. **A same-user native process is outside the web/renderer containment boundary.** Such a process can read or alter this account's application files and can make loopback requests directly. The browser bridge is not claimed to contain native malware already running as the same OS user.
9. **A separately installed browser extension is not automatically trusted as the companion.** This audit therefore treats automatic pairing that accepts any `chrome-extension://` caller as a residual browser-boundary weakness even though ordinary web pages are rejected.
10. **Chrome extension isolated worlds do not provide a private DOM.** Page JavaScript can locate and dispatch events at extension-inserted DOM nodes. Privileged extension UI actions must therefore require browser-trusted user events, not merely isolated-world listeners.
11. **The extension service worker and `chrome.storage` are outside ChatGPT page JavaScript.** The page cannot directly read the bearer token stored by the background worker. `fiber.js`, which runs in the MAIN world, is treated as page-controlled evidence and must not receive privileged extension state.
12. **Electron `safeStorage` is acceptable only when backed by protected OS storage.** On Linux this application deliberately refuses Chromium's hard-coded-key `basic_text`/`v10` fallback.
13. **Session recordings are local application data, not encrypted credential material.** Someone who can already read the same OS account may be able to read them; recording is therefore a privacy-sensitive opt-in and remains off by default.
14. **Goal mode is an explicit external-data boundary.** When enabled, authored conversation text is intentionally sent to OpenRouter; local tool arguments/results and local file payloads are not required for Goal decisions.
15. **The materialized extension fingerprint is update/recovery metadata, not a MAC against same-user filesystem compromise.** A same-user process that can rewrite the Chrome-visible extension directory is outside the browser/web threat boundary described above.
16. **Build-time pinned downloads are distinct from runtime code loading.** Fetching a version- and SHA-256-pinned helper during the controlled build is acceptable; downloading executable/browser code dynamically at application runtime would require a separate trust mechanism.
17. **Public release publishing remains disabled.** This audit does not treat an unsigned controlled M0 candidate as equivalent to a signed public release; stronger release signing/provenance remains separate release work.

## Material findings

### HIGH — AS-01: compromised renderer could choose an unsandboxed tunnel executable

**Status: FIXED in this branch.**

`settings:save` accepted the full tunnel settings object, including `binaryPath`. The main-process merge correctly validated shape but could not distinguish a legitimate renderer form value from an attacker-controlled renderer value. A compromised renderer could supply the same malicious path in both its merge `base` and `patch`, making that path look like unchanged user state or an intentional settings edit. A later Connect reaches the tunnel launcher, which uses direct `spawn()` outside Bubblewrap. For the OpenAI transport that child also receives the tunnel credential and local connector URL in its explicitly constructed environment.

The path resolver still requires the selected object to have the expected executable name (or be a directory containing it), so exploitation requires a pre-positioned executable with the expected name. That precondition does not make the renderer an appropriate authority to choose the host process.

**Fix:** the isolated preload now remembers `tunnel.binaryPath` only from main-process `AppState` responses and overwrites both the renderer-controlled `base` and `patch` values before invoking `settings:save`. The generic settings channel therefore presents the binary path to main as unchanged. Only `binary:pick`, whose pathname is chosen by Electron's native file dialog in the main process, can update that trusted value through the exposed renderer API.

**Regression:** `test/preload-security.test.ts` gives the renderer control of both merge inputs and verifies that an attacker path never reaches IPC.

### HIGH — AS-02: ChatGPT page JavaScript could synthesize privileged companion UI events

**Status: FIXED in this branch.**

Chrome's isolated content-script world isolates JavaScript globals, not the DOM. `content.js` installed click/input/keyboard handlers on `.clf-*` companion controls but did not require `Event.isTrusted`. ChatGPT page JavaScript could therefore dispatch synthetic events at those DOM nodes. The affected handlers reach bridge-backed settings (automatic compaction / Goal), Goal objective save/clear, and Compact/Resume control flow.

This did not expose the bridge bearer token or direct filesystem/command IPC, but it let malicious page JavaScript cross the intended page-to-extension action boundary and drive local extension-backed behavior without a real user gesture.

**Fix:** `extension/event-guard.js` is loaded before `content.js` in the isolated world. Capture-phase guards reject untrusted click/double-click/keyboard/input/change/submit events whose composed path contains companion-owned `.clf-*` nodes, while leaving ordinary ChatGPT DOM events untouched.

**Regression:** `test/extension-security.test.ts` verifies manifest ordering, verifies that a synthetic companion click is cancelled before the privileged handler runs, and verifies that ordinary page controls are unaffected.

### MEDIUM — AS-03: automatic bridge pairing identifies an extension origin class, not the bundled companion

**Status: OPEN RESIDUAL; not disguised as fixed.**

The bridge binds only to `127.0.0.1`, rejects ordinary web origins, requires its protocol version, mints a random bearer token, stores that token through protected secret storage, and requires it on protected routes. Those controls prevent a normal ChatGPT page from directly using the bridge.

However, the unauthenticated `/pair` admission rule accepts a `chrome-extension://` Origin generically (and deliberately tolerates a missing Origin because extension fetches may omit it). It does not cryptographically identify the specific bundled companion extension. A malicious separately installed extension with permission to reach the loopback ports could therefore pair, receive the current bearer token, inspect bridge activity, and invoke browser-owned Goal/compaction/command routes.

The protected bridge does **not** expose generic filesystem operations, shell commands, capability grants, arbitrary URL opening, or API-key reads, which bounds impact below the renderer executable-path finding. The residual still crosses a browser privacy/control boundary and is material.

A superficial exact-Origin check is not an adequate fix because the Origin may be absent and an HTTP Origin string is not a cryptographic companion identity. A justified fix should add an install-local proof available to the materialized companion but not web pages/other extensions, use native messaging, or restore an explicit app-side pairing-intent/confirmation mechanism. This branch does not add a public/static shared secret or an unreliable Origin equality check merely to make the finding look closed.

### MEDIUM — AS-04: packaged tunnel lookup could fall back to ambient host executables

**Status: FIXED in this branch.**

The build fetches reviewed tunnel helpers by pinned version and SHA-256, but runtime lookup previously fell through from an absent/damaged bundle to `PATH`, home-directory and common-system locations. In a packaged application that silently changes provenance: a same-named host executable can replace the helper the package was expected to run.

**Fix:** ambient `PATH`/common-location discovery is now permitted only in ordinary Node/test processes and stock Electron development runs (`process.defaultApp === true`). A packaged Electron process fails closed after an explicit native-picker hint and the bundled resource have both failed. The explicit native-picker override remains available because it is a user authority action.

**Regression:** `test/tunnel-provenance.test.ts` pins development-versus-packaged fallback policy.

### LOW — AS-05: security documentation overstated bridge immutability

**Status: FIXED in documentation in this branch.**

`SECURITY.md` said the companion bridge exposed no "settings-mutation route." The implementation has an intentional `/settings` route that can change the browser-owned automatic-compaction and Goal enablement state. It does not grant filesystem/command/capability permissions, but the previous statement was factually too broad and hid part of the bridge's control surface.

`SECURITY.md` is corrected to describe the actual narrow mutation surface and the residual companion-pairing limitation.

## Reviewed controls classified NOT A VULNERABILITY

The following were specifically reviewed because they are material privilege boundaries. On the audited baseline plus the fixes above, no application-level vulnerability was verified in these controls.

### Electron window and renderer containment — NOT A VULNERABILITY

- `BrowserWindow` uses a fixed local preload with `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, `webviewTag: false`, and `webSecurity: true`.
- Window creation is denied; `will-navigate`, `will-redirect`, and `will-attach-webview` are blocked both on the application window and defensively for newly created WebContents.
- Packaged builds load the bundled renderer and ignore `ELECTRON_RENDERER_URL`. Non-packaged overrides are limited to loopback HTTP(S).
- The default session denies permission requests.
- The renderer CSP denies by default and permits scripts/connections only from self; it has no remote script source.

### IPC sender identity, payload validation and secrets — NOT A VULNERABILITY after AS-01 fix

All privileged renderer IPC is registered through the centralized handler wrapper in `src/main/ipc.ts`. The wrapper requires the sender WebContents id to equal the current application `BrowserWindow` and requires `senderFrame === sender.mainFrame`. Payloads are parsed through bounded Zod schemas before the endpoint implementation runs.

The reviewed named endpoints are: `state:get`, `settings:save`, `roots:add`, `roots:remove`, `roots:rename`, `secret:set`, `goal:models`, `binary:pick`, `connection:connect`, `connection:disconnect`, `diagnostics:run`, `log:get`, `log:text`, `log:json`, `clipboard:write`, `link:open`, `sessions:list`, `sessions:events`, `sessions:delete`, `handoff:get`, `bridge:unpair`, `bridge:openExtensionFolder`, `bridge:extensionPath`, `swarm:get`, `swarm:reset`, and `swarm:clearAgent`.

`secret:set` is write-only from the renderer and accepts only named secret slots. API-key plaintext is not returned in `AppState`. `link:open` accepts only a fixed set of HTTPS documentation/settings/release destinations rather than an arbitrary renderer URL.

### State identity, defaults and corruption recovery — NOT A VULNERABILITY

- The main process moves Electron `userData` to the fork-owned `local-cgpt` path before config, secrets, sessions or single-instance state are initialized. There is no automatic import of upstream authority.
- Fresh defaults and corrupt-config recovery disable model-facing capabilities, enable read-only mode, and leave recording/automatic compaction/multi-agent/Goal disabled.
- Config writes are serialized and use a temporary-file/rename pattern.
- Stored capability state is ordinary configuration, not treated as a secret; recovery does not silently enable it.

### Secret storage — NOT A VULNERABILITY

- API keys and the bridge bearer token use Electron `safeStorage` and are never exposed through renderer reads.
- Linux detects and rejects Electron/Chromium `v10` hard-coded-key ciphertext rather than treating it as protected storage.
- A malformed/undecryptable credential blob is not replaced with an empty authoritative store; mutations fail closed instead of erasing unknown ciphertext.

### Session recordings — NOT A VULNERABILITY under the documented local-data assumption

Recordings are durable local history rather than credentials and are not encrypted with `safeStorage`. This is sensitive data, but recording is disabled by default and the existing security documentation already treats same-account read access as a privacy limitation rather than promising encryption at rest.

### Extension manifest and page/service-worker split — NOT A VULNERABILITY after AS-02 fix

- Manifest V3 permissions are limited to `storage`, `scripting`, and `alarms`.
- Host permissions are limited to the two ChatGPT origins and the five fixed loopback bridge ports.
- No `update_url` or externally-connectable page API was identified in the manifest.
- The bridge bearer token stays in the service worker / `chrome.storage.local`, not in the content script or page.
- `fiber.js` runs in the MAIN world to read page-owned React/request metadata, but its page messages carry evidence rather than privileged extension secrets or local capability authority.
- Browser-supplied `MessageSender` frame/document identity and navigation generation, not page body fields, decide which content-script document owns an observation/command exchange.

### Bridge origin/CORS/token controls — NOT A VULNERABILITY except AS-03

- The server listens on `127.0.0.1` only.
- Ordinary `https://chatgpt.com`/web Origins are rejected; CORS is not opened to the page.
- Protected routes require the random bearer token and protocol compatibility, use bounded request bodies and rate limiting, and preserve explicit disconnect state.
- Page evidence is reconstructed field-by-field and is not promoted into filesystem/command authority.
- The open residual is companion identity during `/pair`, not a claim that ordinary page JavaScript can directly read the token.

### OpenRouter / Goal — NOT A VULNERABILITY under explicit opt-in

Goal uses a fixed `https://openrouter.ai/api/v1` base, keeps the key in the main process, bounds response handling, validates/normalizes structured model decisions, and sends authored conversation text rather than local tool arguments/results. Model output is treated as untrusted control data. The external-provider privacy boundary remains documented and opt-in.

### Runtime downloads, updater and remote code — NOT A VULNERABILITY in reviewed paths

- The application package has no `electron-updater` dependency and no app auto-update mechanism was identified in the reviewed main-process path.
- `scripts/package.mjs` passes `--publish never` to electron-builder.
- `scripts/fetch-tunnel-client.mjs` downloads a fixed GitHub release version selected by `scripts/packaging-versions.mjs` and verifies the target SHA-256 before use.
- The extension recovery path uses reviewed bundled source rather than downloading an upstream extension release.
- The extension service worker injects bundled `fiber.js`; no runtime remote JavaScript loading path was identified.
- Cloudflare is reached only when that tunnel mode is selected, and the spawned `cloudflared` path uses `--no-autoupdate`.
- OpenAI tunnel control-plane traffic is delegated to the reviewed/pinned tunnel helper when that transport is configured.

## Prompt-injection reachability conclusion

No direct path was verified from malicious ChatGPT text/model output to raw main-process IPC, secret reads, arbitrary URL opening, filesystem operations, or unsandboxed command execution.

Two indirect application-level paths were verified and fixed: page JavaScript could synthesize extension UI events (AS-02), and a compromised Electron renderer could choose the tunnel host executable through generic settings (AS-01). Prompt injection alone does not become renderer code execution, but the audit treats either a compromised page script or compromised renderer as hostile because those are the relevant post-compromise boundaries.

## Validation added by this branch

- `test/extension-security.test.ts` — page-to-extension synthetic event boundary.
- `test/preload-security.test.ts` — renderer cannot smuggle a tunnel executable through generic settings.
- `test/tunnel-provenance.test.ts` — packaged runtime refuses ambient executable fallback.

Existing Electron/IPC/config/secrets/bridge/tunnel tests remain part of `npm run verify:ci` and are not bypassed or weakened by these changes.

## Residual work

AS-03 should be resolved with a real companion-authentication mechanism before claiming that the loopback bridge is isolated from other installed browser extensions. The fix must not rely solely on `Origin` equality or a public static secret. Suitable designs include an install-local secret placed only in the materialized non-web-accessible companion, native messaging, or explicit app-side pairing intent/confirmation with replay protection.

No Bubblewrap policy change is proposed by this audit.

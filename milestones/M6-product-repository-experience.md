# M6 — Product and repository experience

**Status:** In progress (pulled-forward work landed; milestone acceptance remains open)

**Depends on:** M0; may run in parallel with later security milestones only when their contracts remain unchanged

## Goal

Turn the hardened technical foundation into a coherent, polished product that is easy to understand,
configure, inspect, and trust. Make the GitHub repository and Electron/extension UI present one
consistent `local-cgpt` identity, remove correctness/documentation drift, and establish repeatable
UX/accessibility/visual quality gates without weakening any security boundary.

## Progress and planning evidence

The synchronization repair (#47 / PR #48), reusable-worker guidance (#49 / PR #50), renderer
foundation (#51 / PR #52), Home cockpit (#53 / PR #54) and visible identity (#55 / PR #56) have
landed. Treat them as foundations to preserve, not new implementation requests. Their presence
does not prove all M6 acceptance, external repository settings or metadata work complete.

The September 8 follow-up is tracked by #59 and
[`docs/review-follow-up-2026-09-08.md`](../docs/review-follow-up-2026-09-08.md).
M7 owns architecture/performance; M8 owns agent-orchestration evolution. This milestone owns
user-facing connectivity, accessibility, recorded text/code and chat navigation.

## Correctness and trust debt

- Preserve the corrected reusable-worker model guidance and its lifecycle regression tests.
- Keep the repaired milestone synchronizer deterministic and aligned with current roadmap state;
  distinguish pending description synchronization from a historical script defect.
- Keep milestone status accurate without marking unfinished work complete.
- Remove remaining stale repository/product metadata describing the supported product as Windows.
- Eliminate tool-surface count/name drift between implementation, README, AGENTS and tool-surface
  documentation; prefer generated/validated facts over copied counts.
- Preserve renderer theme-token fixes and cover stateful controls with visual regression tests.
- Protect `main` with appropriate repository rules/status checks so accidental direct pushes cannot
  bypass normal security/release gates; do not claim external settings changed without evidence.

## September review implementation backlog

- **#67 — Keyboard-accessible chat controls and adjustable reading.** Session rows and agent filters
  need complete keyboard/selection semantics and predictable focus through updates/deletion.
  Provide persistent local reading-width/text-size preferences with reset and zoom/theme evidence.
- **#68 — Accurate tunnel health and recovery.** Monitor Cloudflare beyond startup; add bounded,
  cancellable recovery, generation-safe status and explicit URL-change handling. Manual tunnels
  must distinguish local readiness from proven remote connectivity. Preserve M2 transport authority.
- **#69 — Safe text/code presentation.** Locally bundled syntax highlighting, language labels,
  copy-code fidelity, wrapping and inert raw/rendered switching. Disclose truncation and recorded
  versus inferred language/source metadata. Security prerequisite: M3/#63 sanitizer coverage.
- **#70 — Bounded history and chat organization.** Earlier/later cursor navigation beyond the current
  newest 160-row window, local search/jump-to-event, pinning, project grouping and explicit resumed
  lineage. Search must distinguish a loaded window from all retained history; no unbounded loading.

Coordinate #67/#69/#70 with M7/#65 incremental/lazy rendering, and #68 with M7/#66 state-driven
cockpit components. Privacy requirements #60/#61 apply to recordings, indexes and grouping metadata;
M8/#57 provides explicit lineage, not title/timing-based identity inference. Pinning must not silently
override retention. The app remains a recorded-session viewer, not a replacement chat client.

## Repository experience

- Establish one explicit product naming hierarchy. Prefer `local-cgpt`; explain any retained
  upstream/lineage branding instead of mixing identities across app, extension and metadata.
- Structure the README landing path around what it is, Linux support, why its boundary is different,
  a short visual demo, setup, security, architecture and deeper documentation.
- Keep threat-model/history material available behind obvious documentation links.
- Add an architecture diagram for ChatGPT, companion, local-cgpt and bounded local/remote authorities.
- Keep screenshots current and add a representative approve-folder/connect/inspect/validate demo
  when practical.
- Curate repository description/topics and contributor navigation to match the Linux-first product.
- Validate copied platform, tool, identity and default-capability facts against authoritative sources.

## App UX/UI

Preserve the restrained monochrome visual language and semantic red/green states while simplifying
information architecture.

- Build on Home's control cockpit: connection/safety, effective capabilities, approved projects,
  current work and actionable problems. Its presentation must use authoritative state.
- Keep granular capability switches authoritative. Observe/Code/Custom presets may be explicit
  helpers only when they preview the exact delta before apply; no hidden authority grants.
- Preserve responsive layouts, independent disclosures and the resizable Electron window.
- Give agent activity a first-class dashboard with role, lifecycle, context pressure, messages,
  task, last activity, result/validation summary and safe wake/retire controls.
- Distinguish destructive/high-authority actions without making the interface a wall of warnings.
- Preserve immediate read-only/kill-switch affordances and plain-language cached-schema versus
  live-enforcement distinctions.
- Present connection verification evidence, uncertain/offline states and corrective actions without
  equating a running local process or a published URL with successful remote use.

## Accessibility and interaction quality

- Use correct tab/disclosure/switch/session/filter semantics and complete keyboard operation.
- Validate focus order, visible focus, labels, contrast and screen-reader names for permissions,
  setup, activity, sessions, agents, code controls and history navigation.
- Respect reduced motion and offer system theme behavior alongside light/dark where unambiguous.
- Verify minimum/preferred/maximized layouts and 125/150/200% zoom, including adjusted reading width,
  long code and tables without app-wide clipping.
- Automate representative visual states: errors, indeterminate groups, rename/edit, setup, agents,
  chat filters, empty/locked history, code wrapping and copy feedback.

## Quality gates

M6 is complete only when:

- correctness/trust debt is resolved or explicitly tracked as narrower blocking work with evidence;
- repository/product identity and Linux claims agree across GitHub, README, app and package metadata;
- setup, permissions, session/filter/history and code controls work with mouse, keyboard and screen reader;
- responsive/zoom/theme states have representative automated visual regressions;
- #68 proves connection lifecycle/race behavior and distinguishes local from remote evidence;
- #69 passes #63 security fixtures without weakening sanitization or adding remote assets;
- #70 exposes retained history through bounded cursors, honest search completeness and explicit lineage;
- copied tool/default/platform facts have source references or mechanical consistency protection;
- product changes preserve M0–M5 contracts and relevant final-head CI/security/candidate gates.

## Contracts

- UX simplification never collapses materially distinct authorities into a hidden permission.
- Visual state is descriptive; main-process/live enforcement remains authoritative.
- Product/performance measurements remain local; remote analytics are not required for polish.
- Accessibility is acceptance work, not post-release cleanup.
- Security/capability documentation must point to authoritative sources or be consistency-tested.
- More navigable history or richer formatting does not authorize larger unbounded payloads, data
  collection, executable content, network probes or a second inference provider.

## Out of scope

- Large module decomposition, incremental-rendering architecture, state-driven cockpit refactoring,
  startup costs and CI optimization: M7.
- Logical worker identity, structured results, scopes/DAGs, succession and multi-prime scheduling: M8.
- Recording encryption/consent/provider removal and sanitizer-security coverage: M3.
- Weakening M0–M5 boundaries, enabling releases or replacing ChatGPT with an in-app model/chat client.

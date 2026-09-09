# M7 — Architecture, performance and maintainability

**Status:** Planned

**Depends on:** M6 for product-facing contracts; preserves M0–M5 security boundaries

## Goal

Reduce the cost and risk of changing `local-cgpt` by decomposing oversized stateful modules,
measuring the runtime paths that matter, minimizing unnecessary browser/renderer work, and making CI
and code-quality feedback faster without trading away security evidence.

## Why this milestone exists

Several large files combine transport, identity, lifecycle, durability and presentation concerns.
They are test-rich, but their size complicates review, conflict resolution and regression localization.
Performance work must be evidence-driven rather than inferred from source size or a static review.

## September review implementation backlog

Planning tracker #59 and [`docs/review-follow-up-2026-09-08.md`](../docs/review-follow-up-2026-09-08.md)
add two independently reviewable implementation issues:

- **#65 — Incremental histories and lazy tool details.** Reconcile session/event/message rows by
  durable identity instead of rebuilding complete lists/timelines; replace canonical revisions
  without duplicates. Build expensive collapsed tool arguments/results on expansion, retain row,
  text and HTML budgets, and preserve selection, focus, expanded state and scroll anchors.
- **#66 — State-driven cockpit components.** Replace DOM-text/class parsing and observer overlays
  with explicit AppState projections and reusable presentation components. Give disclosure state
  one owner without changing granular permission controls or main-process enforcement.

Both require reproducible local before/after measurements and behavioral parity tests. #65 coordinates
with M6/#67 accessibility, #69 formatting and #70 bounded history; #66 coordinates with #67 and #68
connection presentation. No framework migration or broader broker rewrite is implied.

## Architecture decomposition

Refactor by authoritative state machine/domain, not arbitrary line-count targets.

Priority candidates include:

- `src/main/agents.ts`: identity/ownership, lifecycle/slot accounting, messaging, durability,
  browser delivery and scheduling, preserving transactional spawn/message semantics.
- `src/main/bridge.ts`: authentication, routing, session/compaction orchestration, worker bootstrap
  and browser telemetry.
- `src/main/mcp/tools-core.ts`: schemas/contracts separated from filesystem, execution, GitHub,
  reference, session and agent registration/adaptation.
- `extension/content.js`: page bootstrap, recorder, turn lifecycle, companion UI,
  compaction/overwrite and agent integration behind stable boundaries.
- `src/renderer/cockpit.ts`: explicit state projections and presentation ownership under #66.
- Large session/store/test modules where independent state machines can be isolated without hiding
  cross-boundary tests.

Every decomposition preserves load-bearing comments or moves their invariant into a test/contract;
cleanup is not a reason to weaken a guard with a documented failure mode.

## Extension and renderer efficiency

- Keep always-on ChatGPT content-script bootstrap minimal; initialize expensive feature-specific
  observers/state machines only when the corresponding user-enabled feature needs them.
- Recording, retained local continuation controls, compaction UI and workers remain dormant when
  disabled beyond minimum safe identity/pairing/status work. M3/#62 removes external Goal inference;
  optimization is not permission to retain or introduce another provider.
- Avoid redundant DOM scans/observers; centralize ChatGPT DOM-shape reads behind the evidence layer.
- Keep hidden renderer panels quiescent while preserving immediate correctness when reopened.
- Use stable keyed incremental updates and lazy tool details (#65). Preserve canonical message
  revision semantics, epoch-scoped asynchronous loads, open state and user scroll/selection/focus.
- Expose earlier history through M6/#70 bounded cursors, not larger unbounded DOM/IPC payloads.
- Track bundle/source growth so new features cannot silently add large always-injected costs.

## Local performance evidence

Add development/diagnostic measurements for:

- Electron cold/warm startup to usable Home;
- extension initialization and bridge pairing;
- first MCP handshake/tool call and broker overhead around cheap reads;
- session search/read across representative store sizes;
- session-list/timeline load, live repaint, expanded large-tool cost and DOM/memory work;
- cockpit update/observer work;
- worker spawn/bind/sleep/wake latency;
- shutdown duration and bounded-phase overruns.

Use the same representative fixtures before and after optimization, including long histories,
burst updates, canonical revisions and large tool output. Record local results; a source-review
observation does not prove a speedup. Measurements are diagnostics, not remote analytics or usage
reporting.

Define budgets after a baseline; prefer percentiles or worst-representative budgets over one-machine
microbenchmark claims. Encryption/locked-state and consent behavior from M3/#60/#61 must remain correct.

## CI and developer feedback

- Add a small deterministic formatter/linter gate; prefer a single fast tool over a sprawling
  plugin stack unless evidence justifies otherwise.
- Keep TypeScript typecheck and security/privacy tests authoritative.
- Split independent safe CI domains when useful, retaining complete final integration/security/
  candidate proof for the supported product.
- Cache only unambiguous provenance/invalidation; never cache away current-head security checks.
- Expose slow/flaky test evidence rather than masking failures with broad retries.
- Add architecture/contract tests where explicit modules replace implicit same-file state.

## Documentation and contract generation

- Generate or mechanically validate tool names/counts, supported platforms, capability/default
  matrices and product identity where facts currently drift.
- Keep AGENTS as the architecture map and make stale-doc traps testable against implementation.
- Add a contributor architecture index for separated domains so human/AI agents enter the correct
  state machine without scanning monoliths.

## Quality gates

M7 is complete only when:

- highest-risk stateful modules have explicit domain boundaries and regression coverage;
- disabled extension features are measurably dormant;
- local startup/tool/session/worker baselines and regression thresholds exist;
- #65 demonstrates bounded incremental/lazy rendering with preserved focus, selection, scroll and
  disclosure state, including stale loads and message revisions;
- #66 derives summaries from state, removes redundant observer projections and proves authority/
  visual/accessibility parity without new grants;
- formatting/lint/typecheck/test feedback is deterministic and preserves final security gates;
- CI identifies subsystem failures promptly while keeping complete integration evidence;
- documentation consistency guards prevent known tool/platform/identity drift;
- no refactor changes authority, caller identity, durability or fail-closed behavior without separate
  reviewed scope and evidence.

## Contracts

- Remove redundant work, not threat-boundary validation or security checks.
- Preserve observable behavior unless an owning issue explicitly changes it with acceptance criteria.
- Keep measurements local by default.
- File size is a symptom, not a target; cohesion/state ownership defines boundaries.
- CI speed never outranks trustworthy final-head security/candidate evidence.
- Bounded rendering remains bounded even when all retained history becomes navigable.

## Out of scope

Product navigation/visual language belongs to M6; new agent topology/identity/DAGs/scheduling to M8;
recording encryption, consent and provider removal to M3. Windows/macOS expansion, remote analytics,
new external inference and weakened security/payload limits are not optimization work.

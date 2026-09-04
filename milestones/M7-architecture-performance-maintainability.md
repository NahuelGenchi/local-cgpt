# M7 — Architecture, performance and maintainability

**Status:** Planned

**Depends on:** M6 for product-facing contracts; preserves M0–M5 security boundaries

## Goal

Reduce the cost and risk of changing `local-cgpt` by decomposing oversized stateful modules,
measuring the runtime paths that matter, minimizing unnecessary browser/renderer work, and making CI
and code-quality feedback faster without trading away security evidence.

## Why this milestone exists

The current codebase contains several very large files that combine transport, identity, lifecycle,
durability and presentation concerns. They are test-rich, but their size makes review, AI-assisted
reasoning, conflict resolution and regression localization harder than necessary. Performance work
should also be evidence-driven rather than inferred from source size.

## Architecture decomposition

Refactor by authoritative state machine/domain, not by arbitrary line-count targets.

Priority candidates include:

- `src/main/agents.ts`: split identity/ownership, lifecycle/slot accounting, messaging, durability,
  browser delivery and scheduling while preserving transactional spawn/message semantics.
- `src/main/bridge.ts`: separate bridge authentication, request routing, session/compaction
  orchestration, worker bootstrap and browser telemetry.
- `src/main/mcp/tools-core.ts`: separate schemas/contracts from filesystem, execution, GitHub,
  reference, session and agent registration/adaptation.
- `extension/content.js`: separate page bootstrap, recorder, turn lifecycle, companion UI,
  compaction/overwrite and agent integration behind stable module boundaries.
- large session/store/test modules where independent state machines can be isolated without hiding
  cross-boundary tests.

Every decomposition must preserve load-bearing comments or move their invariant into a test/contract;
"cleanup" is not a reason to weaken a guard whose failure mode is documented.

## Extension and renderer efficiency

- Keep the always-on ChatGPT content-script bootstrap minimal. Expensive observers/state machines
  should initialize only when the corresponding user-enabled feature needs them.
- Session recording, Goal, compaction UI and worker coordination should remain dormant when disabled,
  beyond the minimum identity/connectivity work required for safe pairing and current status.
- Avoid redundant DOM scans and observers; centralize ChatGPT DOM-shape reads behind the existing
  selector/evidence layer.
- Keep hidden panels and expensive renderer views quiescent when not visible, while preserving
  immediate state correctness when reopened.
- Track bundle/source growth so a new feature cannot silently add a large always-injected browser
  cost without review.

## Local performance evidence

Add development/diagnostic measurements for the paths users feel:

- Electron cold/warm startup to usable Home state;
- extension document initialization and bridge pairing;
- first MCP handshake and first tool call;
- overhead added by the capability broker around cheap local reads;
- session search/read latency across representative store sizes;
- renderer session-timeline load and repaint cost;
- worker spawn, bind, sleep and wake latency;
- shutdown duration and bounded-phase overruns.

Measurements are local diagnostics, not analytics. Do not introduce remote telemetry, identifiers or
usage reporting as part of this milestone.

Define representative performance budgets only after a baseline is measured. Prefer percentile or
worst-representative budgets over one-machine microbenchmark claims.

## CI and developer feedback

- Add a formatter/linter gate with a small, deterministic configuration; Biome or an equivalent
  single fast tool is preferred over a sprawling plugin stack unless evidence justifies otherwise.
- Keep TypeScript typecheck and existing security/privacy tests authoritative.
- Split independent safe CI domains into parallel jobs when this materially reduces feedback time,
  while retaining final integration/security/candidate gates that prove the complete supported
  product.
- Cache only content whose provenance and invalidation are unambiguous; never cache away a security
  or packaging check whose purpose is to validate the current head.
- Make slow-test and flaky-test evidence visible instead of masking failures with broad retries.
- Add targeted architecture/contract tests where module boundaries replace implicit same-file state.

## Documentation and contract generation

- Generate or mechanically validate facts that currently drift: model-visible tool lists/counts,
  supported platform statements where practical, capability/default matrices and product identity.
- Keep `AGENTS.md` as the architecture orientation map, but make its stale-doc traps testable against
  the current implementation wherever possible.
- Add a small contributor-facing architecture index for the newly separated domains so human and AI
  agents can enter the correct state machine without scanning monoliths.

## Quality gates

M7 is complete only when:

- the highest-risk oversized stateful modules have explicit domain boundaries and regression tests;
- extension feature initialization is measurably dormant when the feature is off;
- local startup/tool/session/worker performance baselines exist and regressions have documented
  budgets or review thresholds;
- formatting/lint/typecheck/test feedback is deterministic and does not weaken final security gates;
- CI wall-clock time is improved or at least decomposed so failures identify their subsystem quickly;
- generated/validated documentation facts prevent recurrence of known tool/platform identity drift;
- no decomposition changes authority, caller identity, durability or fail-closed behavior without a
  separately reviewed milestone issue.

## Contracts

- Performance optimization may remove redundant work, not validation or security checks that are part
  of the threat boundary.
- Refactors must preserve externally observable behavior unless the owning issue explicitly changes
  that behavior and carries its own acceptance criteria.
- Runtime measurements remain local by default.
- File size is a symptom, not a target; cohesion/state ownership defines module boundaries.
- CI speed never outranks trustworthy final-head security/candidate evidence.

## Out of scope

- Redesigning the product navigation/visual language: M6.
- New agent topology, logical worker identity, task DAGs or multi-prime scheduling: M8.
- Broad platform expansion to Windows/macOS.

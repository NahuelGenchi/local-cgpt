# M8 — Agent orchestration v2

**Status:** Planned

**Depends on:** M6 product contracts and the relevant M7 broker/module boundaries

## Goal

Evolve experimental prime/worker chats from a careful reusable-worker broker into a more explicit,
structured and efficient orchestration system: durable logical workers, enforceable worker scopes,
structured results, dependency-aware task scheduling, context succession and eventually bounded
concurrent prime runs without weakening conversation identity or local authority.

## Starting contract

The existing broker already has important invariants that v2 must preserve:

- the app, not the model, binds a worker to a proved ChatGPT conversation;
- model-carried bearer credentials are not agent identity;
- spawn/message publication crosses a durability barrier before browser side effects;
- sleeping workers retain their conversation and may release their active slot;
- stale/foreign conversations cannot inspect another prime's run;
- worker context exhaustion never interrupts work already in flight;
- agent tools remain optional/default-off and live permission enforcement remains authoritative.

Before larger v2 work, fix model-facing instructions so they accurately teach the existing sleeping
worker reuse contract. New scheduling intelligence built on contradictory instructions would only
amplify waste.

## Structured worker results

Replace convention-only `RESULT / CHANGES / VALIDATION / BLOCKERS` prose with schema-backed finish
fields while retaining a human-readable summary. The exact schema should support, at minimum:

- outcome/summary;
- changed paths or explicit no-change result;
- validation performed and validation not performed;
- blockers/risks;
- follow-up suggestions only when material;
- optional machine-readable artifacts/references that already exist in local-cgpt authority.

The app should render and aggregate this structure without treating a worker's self-report as proof
that a file changed or a test passed; authoritative local tool/session evidence still wins.

## Worker scopes

Allow the prime to assign structured scopes to a worker:

- approved read roots/subpaths;
- approved write roots/subpaths;
- preferred/required workdir;
- allowed model-facing local tools/capabilities within the user's already-granted authority;
- optional path ownership hints for conflict detection.

Where a scope can be enforced at the local-cgpt broker/tool boundary, enforce it. Natural-language
instructions remain useful context but must not be mistaken for an authorization boundary.

Worker scope can only narrow existing user authority; a prime cannot grant a capability/root the
user did not grant.

## Task graph and coordination

- Add explicit task ids and dependency edges so downstream work can remain sleeping until required
  worker results arrive.
- Deliver structured dependency results to newly unblocked workers without forcing the prime to
  manually copy large prose between chats.
- Detect overlapping claimed write paths and warn/block according to a documented conflict policy.
- Preserve direct prime steering for exploratory work; a DAG is an orchestration aid, not a mandatory
  ceremony for every spawn.
- Keep workers star-topology from an authority perspective unless a separately reviewed design proves
  worker-to-worker messaging can be added without cross-run confusion.

## Logical worker identity and context succession

Decouple the durable logical worker from one permanently fixed ChatGPT conversation while keeping
conversation binding explicit and authenticated.

A logical worker may have ordered conversation generations, for example:

`worker-research -> conversation A -> handoff/snapshot -> conversation B`

Requirements:

- succession is app-orchestrated and transactional, never inferred from similar content;
- the previous conversation remains historical identity and cannot silently become another worker;
- workspace/task/scope/result lineage transfers explicitly;
- the handoff is bounded and excludes unnecessary sensitive tool-result bulk;
- the prime can see which generation produced each result;
- failures leave the last proven generation authoritative rather than half-moving identity.

This replaces context-ceiling retirement only when the successor transaction is proven reliable.

## Context and scheduling efficiency

- Surface worker context pressure early enough for the prime/broker to decide between reuse,
  succession or a fresh specialist.
- Prefer waking a suitable sleeping worker over spawning a duplicate when the prime explicitly asks
  to reuse that worker/task context.
- Keep repeated-spawn retry idempotence distinct from deliberate reuse.
- Batch steering/status/result delivery so orchestration does not spend one MCP round trip per trivial
  worker interaction.
- Measure spawn/bind/wake/result latency and context transferred per coordination step as part of the
  M7 local diagnostics.

## Detached/long-turn robustness

Exercise the existing detached-worker silence policy against genuinely long server-side turns and
closed/hidden tabs. Add deterministic tests for:

- worker tab closes while the model continues a long response;
- the silence timer transitions the worker only after the documented evidence threshold;
- a later result cannot be duplicated by an overlapping wake;
- waking a genuinely sleeping worker does not replay the previous task;
- context-ceiling crossing during work changes only the next stop/succession decision.

If five-minute detached silence proves too aggressive or too static, replace it only with an
explicit evidence-based policy rather than an unbounded timeout.

## Bounded multi-prime scheduling

The current one-active-swarm rule is a strong and simple isolation boundary. Do not remove it early.
After logical worker identity, scopes, durable scheduling and cross-prime privacy tests are mature,
consider a bounded global scheduler:

- global active-worker budget;
- per-prime quota/fairness;
- no visibility into another prime's workers/tasks/messages;
- deterministic admission and backpressure;
- no shared mutable workspace unless the user explicitly approved the same root and conflict policy;
- safe shutdown/restart recovery of independent run claims.

This is the final subphase of M8, not a prerequisite for the earlier structured-result/scope/DAG work.

## Agent UX and model guidance

Coordinate with M6 so the app can show logical worker, conversation generation, lifecycle, context,
scope, dependencies, pending messages, validation and blockers without exposing internal noise.

Model-facing agent instructions and schemas must be mechanically checked against lifecycle semantics.
Add contract tests that fail when instructions say a state transition is impossible or terminal while
the broker implements it as reusable/sleeping, or vice versa.

## Quality gates

M8 is complete only when:

- model-facing guidance agrees with the implemented lifecycle and is protected by contract tests;
- `finish` produces bounded structured results with clear evidence semantics;
- worker scopes can narrow tool/path authority and cannot widen user grants;
- dependency-aware tasks and conflict detection work without requiring worker-to-worker authority;
- a logical worker can safely continue through a successor conversation or the milestone explicitly
  documents why the context-ceiling retirement remains preferable;
- detached/long-turn tests cover sleep/wake races and duplicate-work prevention;
- any multi-prime scheduler preserves cross-prime privacy/identity and has bounded global capacity;
- agent UI exposes enough state for a user to understand and intervene in a run;
- the full relevant agent/bridge/session/security regression suite remains green.

## Contracts

- Agent prompts are not security boundaries.
- Structured scopes only subtract authority.
- Worker self-reports are not proof of local state; tool/session evidence remains authoritative.
- Conversation succession is explicit identity transfer, never similarity matching.
- Concurrency is added only after isolation is proven for the simpler topology.
- The app must always offer a deterministic way to stop/clear agent activity without leaving browser
  bootstraps or durable run claims alive.

## Out of scope

- General autonomous browser scraping or undocumented account automation beyond the existing reviewed
  companion use case.
- Giving workers independent authority to create their own workers without prime/broker control.
- Remote/cloud agent infrastructure hosted by local-cgpt.
- Weakening user capability prompts, approved-root containment or browser-companion authentication.

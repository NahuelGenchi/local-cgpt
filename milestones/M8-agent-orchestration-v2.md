# M8 — Agent orchestration v2

**Status:** In progress (pulled-forward autonomy work landed; milestone acceptance remains open)

**Depends on:** M6 product contracts and relevant M7 broker boundaries; M3 privacy/model contracts for affected continuation work

## Goal

Evolve prime/worker chats into explicit, structured and efficient orchestration: durable logical
workers, narrow scopes, structured results, dependencies, context succession and eventually bounded
concurrent prime runs without weakening conversation identity, privacy or local authority.

## Progress and September review constraints

PR #58 landed the durable-autonomy slice tracked by #57. That issue remains open; the merged slice
does not complete structured results, scope/DAG, succession or the other M8 quality gates. Corrected
sleep/reuse model guidance from #49 / PR #50 is a foundation to preserve, not an outstanding request
to repeat that fix.

Planning tracker #59 and [`docs/review-follow-up-2026-09-08.md`](../docs/review-follow-up-2026-09-08.md)
add cross-cutting requirements to #57 and future M8 work:

- **M3/#62:** remove external Goal inference. Any retained continuation uses local orchestration and
  the user's selected ChatGPT model, not OpenRouter, another provider or a hidden fallback.
  Worker/resume flows cannot silently substitute a model; preserve or explicitly verify supported
  visible selection, and pause when continuity cannot be established rather than claiming hidden
  backend guarantees.
- **M3/#61:** global/per-chat recording consent remains explicit. A worker, autonomy preset or
  resumed chat cannot silently enable capture or override revocation; absent consent must cause
  dependent features to pause/degrade safely without disabling independently granted Core tools.
- **M3/#60:** sensitive durable handoffs, checkpoints, task metadata and indexes receive the
  documented storage protections; no new plaintext side store or bulk transcript duplication.
- **M6/#70:** expose recorded project/resume/worker lineage in the viewer using explicit durable
  identities. Presentation grouping is never execution authority or a substitute for binding proof.

These are follow-up target requirements, not retroactive claims that PR #58 implements them.
Do not expand autonomous authority or alter command networking as part of this planning update.

## Starting contract

Preserve the broker's existing invariants:

- the app binds workers to proved ChatGPT conversations; model-carried bearer tokens are not identity;
- spawn/message publication crosses a durability barrier before browser side effects;
- sleeping workers retain their conversation and may release active capacity;
- stale/foreign conversations cannot inspect another prime's run;
- context exhaustion never interrupts work already in flight;
- agents remain optional/default-off and live permissions authoritative;
- explicit manual stop, confirmations and uncertain turn-completion states remain respected.

## Structured worker results

Replace convention-only RESULT / CHANGES / VALIDATION / BLOCKERS prose with bounded schema-backed
finish fields plus a human-readable summary. Include outcome, changed paths or no-change result,
validation performed/not performed, blockers/risks, material follow-ups and optional references to
artifacts already inside local-cgpt authority.

Render and aggregate worker claims without treating self-reports as proof that a file changed or a
test passed. Actual local tool/session evidence remains authoritative.

## Worker scopes

Allow structured read/write subpaths within approved roots, preferred/required workdir, permitted
local tools/capabilities within existing grants, and optional path-ownership hints for conflict
handling. Enforce applicable scope at the broker/tool boundary; natural-language scope is not auth.
A prime can only narrow the user's authority, never add a capability or root.

## Task graph and coordination

- Add task ids and dependency edges so downstream workers sleep until prerequisites are available.
- Deliver bounded structured dependency results without manually copying large histories.
- Detect overlapping claimed write paths with a documented warning/block policy.
- Preserve direct prime steering; a DAG is an aid, not mandatory ceremony for every spawn.
- Retain star-topology authority unless separately reviewed worker-to-worker messaging proves isolation.

## Logical worker identity and context succession

Decouple logical worker identity from one permanent ChatGPT conversation while preserving explicit
authenticated generations: worker -> conversation A -> bounded handoff -> conversation B.

- Succession is transactional app orchestration, never content/timing similarity inference.
- Prior conversations remain historical identities and cannot become another worker silently.
- Workspace/task/scope/result lineage transfers explicitly without widening authority or consent.
- Handoffs exclude unnecessary sensitive tool-result bulk and follow M3/#60 storage protection.
- Prime and viewer can identify which generation produced a result.
- Failure leaves the last proven generation authoritative; model selection and consent uncertainties
  cannot be hidden by an automatic replacement conversation.

Replace context-ceiling retirement only once the successor transaction is proven reliable.

## Context and scheduling efficiency

- Surface context pressure early enough to choose reuse, succession or a fresh specialist.
- Prefer the explicitly requested suitable sleeping worker over duplicate spawning.
- Distinguish idempotent spawn retries from deliberate reuse.
- Batch bounded steering/status/result delivery without adding recursive worker authority.
- Measure spawn/bind/wake/result latency and context transferred per coordination step locally under M7.

## Detached/long-turn robustness

Test closed/hidden tabs while server-side turns continue; evidence thresholds for detached silence;
late results racing wake; sleeping-worker wake without task replay; and context-ceiling crossing
changing only the next stop/succession decision. Any timeout change requires evidence and bounded
failure behavior, not an unbounded wait.

Integrate #57 durable task/process/checkpoint recovery without confusing process survival, browser
availability and remote turn completion. Do not claim local-cgpt can raise hidden ChatGPT budgets.

## Bounded multi-prime scheduling

Keep one-active-swarm isolation until logical identity, scopes, durable scheduling and cross-prime
privacy are mature. Only then consider bounded global capacity, per-prime fairness, no cross-prime
visibility, deterministic admission/backpressure, explicit shared-root/conflict policy and safe
shutdown/restart recovery. This is the final subphase, not a prerequisite for earlier M8 work.

## Agent UX and model guidance

Coordinate M6 views for worker/generation, lifecycle, context, scope, dependencies, pending messages,
validation and blockers. Encrypted/locked or consent-disabled state must be explainable, not hidden.
Mechanically test instructions/schemas against lifecycle semantics so reusable states are not
incorrectly presented as terminal. Recorded operational evidence and model self-reports remain distinct.

## Quality gates

M8 is complete only when:

- model guidance agrees with lifecycle and is contract-tested;
- finish results are bounded/structured with honest evidence semantics;
- scopes narrow tool/path authority and cannot widen user grants;
- dependencies/conflict handling work without requiring worker-to-worker authority;
- successor conversations preserve authenticated lineage, model-selection requirements and consent,
  or evidence explains why retirement remains preferable;
- detached/long-turn and durable recovery tests prevent duplicate work and unsafe rebinding;
- any multi-prime scheduler proves isolation and bounded capacity before activation;
- user views expose sufficient state to understand and stop/intervene in a run;
- #57 follow-up acceptance aligns with #60/#61/#62 instead of requiring external-model Goal processing;
- relevant agent/bridge/session/privacy/security regressions and actual runtime evidence pass.

## Contracts

Prompts are not security boundaries. Structured scopes only subtract authority. Worker self-reports
are not proof. Succession is explicit identity transfer. Concurrency follows isolation proof.
There must be a deterministic stop/clear path without surviving unwanted bootstraps or durable run
claims. Model choice and recording consent cannot be broadened by orchestration.

## Out of scope

General browser scraping, undocumented automation beyond the reviewed companion use case,
recursive worker-created swarms, cloud agent hosting, second inference providers, hidden model
substitution, replacement chat/model hosting, and weakened permissions/containment/authentication
are not authorized. Recording encryption/provider removal implementation belongs to M3; viewer
history/grouping belongs to M6.

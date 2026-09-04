# Product quality and agent evolution plan

This document turns the September 2026 repository review into a maintained planning reference.
It does not authorize implementation by itself. Implementation still follows `AGENTS.md`,
`docs/agent-workflow.md`, milestone-bound Issues, focused branches and reviewed PRs.

The roadmap records own scheduling/status. This document owns the cross-cutting product rationale,
priority order, measurable outcomes and mapping from findings to M6–M8.

## Product direction

`local-cgpt` should feel as deliberate in presentation and orchestration as it already is in security.
The product target remains Linux-first. The app should stay a capability/permission bridge rather than
becoming a replacement chat client or a model host.

The next quality phase has four principles:

1. **Trust through consistency.** Product name, supported platform, live capability surface, roadmap,
   screenshots and model-facing instructions must agree with the implementation.
2. **Calm power.** Keep granular authority and fail-closed behavior, but make the safe state and the
   next useful action obvious without requiring users to understand every subsystem.
3. **Measure before optimizing.** Source size and architectural complexity are review signals;
   performance changes require local evidence from startup, browser, tool, session and agent paths.
4. **Orchestration is state, not prompt folklore.** Agent identity, scope, completion, dependencies,
   context succession and concurrency should increasingly be represented by explicit app state and
   schemas rather than conventions the model must remember.

## Priority order

### P0 — correctness and trust

These should be resolved before large visual or agent-v2 work:

- **Worker lifecycle instruction contradiction.** The broker and public tool contract implement
  reusable sleeping workers, but current server instructions still say a finished worker is finished
  and remaining work should go to a new one. This wastes chats/context and teaches the model the
  opposite of the intended lifecycle. M6 owns the immediate correction; M8 adds lifecycle/instruction
  contract tests.
- **Broken milestone synchronization.** The current `Milestone sync` workflow fails in
  `scripts/sync-github-milestones.sh` with an object/string parsing error. Roadmap files and GitHub
  milestone state must not silently diverge. M6 owns repair and synchronization hygiene.
- **Roadmap status drift.** M0 completion evidence exists and M2 work has landed on `main`, while the
  roadmap still presents M0 as current and M2 as wholly planned. The roadmap must distinguish
  complete, current and pulled-forward/in-progress work accurately.
- **Supported-platform metadata drift.** GitHub repository metadata still describes a Windows bridge
  while the supported product and package metadata are Linux-first. M6 owns product-facing identity.
- **Tool-surface documentation drift.** Current Core includes restricted GitHub and reviewed-reference
  tools beyond the older eight-name documentation. Tool names/counts should come from, or be validated
  against, the authoritative surface declarations.
- **Unprotected main branch.** Repository rules should require the appropriate review/status checks
  for changes to `main`, consistent with the security/release workflow. This is repository governance,
  not an app security substitute.
- **Theme-token defect risk.** Renderer controls should not refer to undefined design variables (for
  example a rename input using names that differ from the root token set). Visual regression tests
  should cover stateful controls in both themes.

### P1 — product quality and maintainability

- coherent `local-cgpt` naming across GitHub, Electron and companion extension;
- shorter visual README landing path and clear docs information architecture;
- architecture diagram and current screenshots/demo;
- Home/control-cockpit redesign and progressive permission disclosure;
- explicit capability presets that preview their exact delta rather than hiding grants;
- responsive layout using the resizable Electron window rather than fixed composition assumptions;
- first-class worker dashboard;
- accessibility semantics, keyboard operation, zoom and reduced-motion/system-theme behavior;
- screenshot/visual-regression testing;
- formatter/linter gate;
- modularization of oversized stateful modules;
- lazy/dormant extension feature initialization;
- local performance diagnostics and baselines;
- faster/more diagnosable CI without weakening final security/candidate evidence.

### P2 — Agent v2 enhancements

- schema-backed worker results;
- enforceable worker scopes that can only narrow user authority;
- task ids/dependency DAG and result handoff;
- write-scope conflict detection;
- logical worker identity with explicit conversation generations/succession;
- earlier context-pressure visibility and reuse/succession decisions;
- detached/long-turn race coverage;
- eventually, bounded multi-prime scheduling after the simpler topology's privacy/isolation is proven.

## M6 — product and repository experience

M6 owns everything a user or repository visitor directly experiences, plus the correctness debt that
makes presentation untrustworthy.

### Repository landing experience

The first README viewport should answer, in order:

- What is local-cgpt?
- What platform is supported now?
- Why is its permission/security model different?
- What does the app look like?
- How do I try it safely?
- Where are the security/architecture/agent details?

Keep threat-model and audit history, but link to it rather than making the landing page read like an
incident archive. Add an architecture diagram and a short representative workflow demo when the UI is
stable enough that the media will not immediately become stale.

### Naming

Preferred direction: make `local-cgpt` the visible product identity. If "Chat On Steroids" remains as
lineage/project branding, use an explicit relationship such as "local-cgpt, based on Chat On Steroids"
or similar. Do not alternate names without explanation between title bar, extension, screenshots,
package metadata and GitHub.

### Home and permissions

Home should answer three questions:

- Is the bridge connected and healthy?
- What can ChatGPT access right now?
- What is happening / what needs attention?

A compact status header can show connection, safety/read-only state, approved project and active
capability count. Permissions remain granular. Presets such as Observe/Code/Custom may be convenience
operations only when they show the exact switches that will change before applying.

### Responsive interaction

The Electron window is already resizable/maximizable. Renderer layout should respond to the actual
space instead of preserving a fixed-frame mental model. At minimum test 640×480, the preferred
1080×700 and a large maximized work area, plus 125/150/200% zoom.

### Agent dashboard

Show logical information, not broker noise:

- label/role;
- active/sleeping/waking/detached/finished state;
- task;
- context pressure;
- pending/awaiting messages;
- latest structured result/validation once M8 exists;
- safe wake/retire/clear actions;
- conversation generation once succession exists.

### Accessibility

Use semantic controls and explicit state (`aria-expanded`, `aria-controls`, appropriate tab/disclosure
patterns), complete keyboard support, visible focus and stable labels. Respect reduced motion and test
screen-reader names for permission, setup, activity and agent controls.

## M7 — architecture, performance and maintainability

### Why the large modules matter

Very large files are not automatically runtime bugs. They are a change-risk signal because identity,
durability, transport and lifecycle transitions become harder to reason about locally. This matters
especially for AI-assisted development: a model can more easily edit the right function under the
wrong state assumptions when unrelated transitions share one module.

Split by authority/state ownership, for example:

- agents: identity/ownership, lifecycle/capacity, messages, durability, browser delivery, scheduler;
- bridge: authentication, routing, session/compaction, worker bootstrap, telemetry;
- Core tools: schemas/contracts separated from domain registration/adaptation;
- extension content: bootstrap, recorder, turn lifecycle, companion UI, compaction, agents.

Do not pursue line-count targets or remove load-bearing comments for aesthetics.

### Browser work

The companion currently injects several scripts on ChatGPT pages. Keep a minimal always-on bootstrap;
feature-specific observers/state machines should be dormant while recording, Goal, compaction or
multi-agent functionality is off. Measure the actual initialization savings.

### Performance diagnostics

Keep metrics local. Useful baselines:

- app startup to usable UI;
- extension initialization/pairing;
- MCP handshake and cheap tool overhead;
- session query/render latency at representative history sizes;
- agent spawn/bind/sleep/wake;
- shutdown bounded phases.

Only after measurement should budgets be set.

### CI/developer quality

Add fast deterministic formatting/linting, keep typecheck, split independent test domains when useful,
and retain complete final gates. Track slow/flaky tests explicitly rather than broad retries. Generate
or validate copied documentation facts.

## M8 — Agent orchestration v2

### Fix the current lifecycle model first

Sleeping worker reuse is already an architectural feature. The model instructions must teach it
accurately before adding smarter scheduling. Reuse remains explicit: a repeated spawn retry and a
prime deliberately waking a sleeping worker are different intents.

### Structured finish

Move RESULT/CHANGES/VALIDATION/BLOCKERS from prompt convention into a bounded schema. The app may
render and aggregate the worker's claims, but a worker claiming a test passed is not stronger evidence
than the actual recorded local tool result.

### Scopes

A prime should be able to assign subpaths/workdir/tool scope to a worker. Enforce these at local-cgpt
where practical. A worker scope only narrows the user's existing grants; it can never add a root,
network authority or capability.

### Task DAG

Allow task dependencies so downstream workers can sleep until prerequisites produce results. Deliver
bounded structured dependency outputs automatically. Add conflict detection for overlapping claimed
write paths.

### Logical worker and conversation generations

Today conversation identity is valuable because it is strong and concrete. Preserve that evidence but
allow a durable logical worker to explicitly transition to a successor conversation when context is
exhausted. Treat succession like Compact & Resume: staged, durable, explicit, auditable and fail-closed.
Never infer the successor from similar content or timing.

### Long-turn/detached behavior

Test closed-tab workers that continue server-side for long periods. The silence policy should not
create duplicate work when a late result overlaps a wake. Any timeout change requires evidence and
bounded failure semantics.

### Multi-prime scheduling

One active swarm is simple and strong. Keep it until per-prime isolation, logical worker durability,
scope accounting and scheduler recovery are mature. Then consider a bounded global active-worker pool
with per-prime quotas and zero cross-prime visibility.

## Success measures

The quality program should eventually be able to answer these with evidence:

### Repository/product

- A new visitor can identify supported platform and core value proposition without reading security
  history first.
- GitHub description, README, package/app/extension names and screenshots do not contradict one
  another.
- Authoritative tool/platform/default facts have mechanical drift protection.

### UX/accessibility

- Common setup and permission changes work at minimum/preferred/maximized sizes and 200% zoom.
- Keyboard-only and screen-reader smoke paths cover setup, permissions, connection and agent control.
- Stateful light/dark visual regression states are reviewed automatically.

### Performance/maintainability

- App/browser/tool/session/agent performance baselines are reproducible locally.
- Disabled optional extension features create negligible feature-specific observer/work compared with
  enabled mode.
- CI failures identify their subsystem early while full final security evidence remains intact.
- High-risk state machines are no longer concentrated in a handful of monolithic files without clear
  module ownership.

### Agents

- Sleeping workers are reused when explicitly requested and are not needlessly replaced because of
  stale model instructions.
- Worker results/scopes/dependencies are structured and bounded.
- Scope cannot widen user authority.
- Context succession cannot cross-bind a worker or lose its lineage.
- No multi-prime design ships until tests prove cross-prime privacy and bounded capacity.

## Work-item decomposition guidance

Do not implement M6–M8 in one PR. Suggested focused issue groups:

### M6

1. Repair milestone synchronization and roadmap-state validation.
2. Correct agent lifecycle guidance and add the first instruction/lifecycle regression.
3. Synchronize Linux/product/tool-surface metadata and naming.
4. Add repository rules/status-check policy.
5. Fix renderer token/accessibility defects and establish visual regression harness.
6. Redesign README/docs landing structure.
7. Redesign responsive Home/permissions.
8. Add first-class agent dashboard.

### M7

1. Introduce formatter/linter and code-quality gate.
2. Establish local performance diagnostics/baseline.
3. Decompose agent broker by state ownership.
4. Decompose bridge orchestration.
5. Modularize/lazy-initialize extension content features.
6. Separate Core tool domain registration and contracts.
7. Parallelize/diagnose CI while preserving final integration gates.
8. Add generated/validated documentation contracts.

### M8

1. Define structured `finish` schema/evidence semantics.
2. Add worker scopes and path/tool narrowing.
3. Add task ids/dependency scheduling and conflict detection.
4. Add context-pressure/succession design and transactional generations.
5. Harden detached/long-turn sleep/wake behavior.
6. Integrate Agent v2 state into the M6 dashboard.
7. Only then evaluate bounded multi-prime scheduling.

## Deferred ideas

These are intentionally not part of M6–M8 unless separately approved:

- Windows/macOS product expansion;
- cloud-hosted local-cgpt agents;
- arbitrary web browsing/network-enabled shell access;
- analytics/remote usage telemetry;
- recursive worker-created swarms;
- replacing ChatGPT with an in-app model/chat UI.

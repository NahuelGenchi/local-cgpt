# M6 — Product and repository experience

**Status:** Planned

**Depends on:** M0; may run in parallel with later security milestones only when their contracts remain unchanged

## Goal

Turn the hardened technical foundation into a coherent, polished product that is easy to understand,
configure, inspect, and trust. Make the GitHub repository and Electron/extension UI present one
consistent `local-cgpt` identity, remove known correctness/documentation drift, and establish
repeatable UX/accessibility/visual quality gates without weakening any security boundary.

## Why this milestone exists

The security model is more mature than the current product presentation. The September 2026 review
found a set of small but high-impact correctness and trust defects together with larger product UX
work that does not belong in M0–M5. This milestone owns the user-facing and repository-facing layer;
M7 owns deeper architecture/performance work and M8 owns the next agent-orchestration architecture.

## Priority 0 — correctness and trust debt

Resolve these before treating visual polish as complete:

- Align model-facing multi-agent instructions with the implemented reusable-worker lifecycle. A worker
  that reports/settles normally sleeps and may be explicitly revived with `agents action=message`;
  instructions must not tell the prime to replace every finished worker with a new chat.
- Repair the `Milestone sync` workflow/script and make roadmap/GitHub milestone synchronization
  deterministic again. Do not hide sync failures behind manual state.
- Bring roadmap status forward from the stale M0-current/M2-planned snapshot without claiming
  unfinished milestones complete.
- Remove stale repository/product metadata that describes the supported product as Windows when the
  current target is Linux.
- Eliminate tool-surface count/name drift between implementation, README, AGENTS and
  `docs/tool-surface.md`; prefer generated/validated facts over copied counts.
- Fix renderer design-token inconsistencies such as controls referring to undefined theme variables,
  and protect theme-critical controls with visual regression coverage.
- Protect `main` with repository rules/status checks appropriate to the release/security model so an
  accidental direct push cannot bypass the normal gates.

## Repository experience

- Establish one explicit product naming hierarchy. Prefer `local-cgpt` as the product name; if
  "Chat On Steroids" remains as project/lineage branding, present the relationship consistently
  rather than mixing identities across app title, extension name, metadata and screenshots.
- Rewrite the README landing section around the first-time decision path: what it is, supported
  platform, why the boundary is different, short visual demo, setup, security, architecture and
  deeper documentation.
- Keep detailed threat-model/history material available, but move it behind obvious documentation
  links instead of forcing every first-time reader through audit history.
- Add a simple architecture diagram for ChatGPT ↔ companion ↔ local-cgpt ↔ capability broker ↔
  bounded local/remote authorities.
- Add current screenshots and, when practical, a short looping demo of approve folder → connect →
  inspect/edit → validate.
- Curate repository description/topics and contributor-facing navigation so GitHub metadata matches
  the Linux-first product.
- Add documentation consistency checks for facts that already have authoritative source files
  (supported platform, tool names/counts, package/app identity, default capability state).

## App UX/UI

Preserve the restrained monochrome visual language and semantic use of red/green, but simplify the
information architecture.

- Reframe Home as a control cockpit: connection/safety state, active capability count, approved
  project(s), current work and problems requiring attention.
- Keep granular capability switches authoritative. Optional presets such as **Observe**, **Code** and
  **Custom** may exist only as explicit UI helpers that preview the exact capability delta before the
  user applies it; a preset is never a hidden authority grant.
- Replace fixed-layout assumptions with responsive behavior that uses the already-resizable Electron
  window. Expansion/scroll rules should adapt to available space rather than enforcing one-open-group
  solely to keep a fixed composition stable.
- Give multi-agent activity a first-class dashboard showing worker role/label, lifecycle state,
  context pressure, pending messages, task, last activity, validation/result summary and safe
  wake/retire controls.
- Make destructive/high-authority controls visually distinct without turning the interface into a
  warning wall.
- Preserve immediate read-only/kill-switch affordances and make cached-schema/live-enforcement
  distinctions understandable in plain language.

## Accessibility and interaction quality

- Add correct tab, disclosure and switch semantics (`aria-expanded`, `aria-controls`, tab roles or
  equivalent native patterns) and maintain complete keyboard operation.
- Validate focus order, visible focus, labels, contrast and screen-reader names for permissions,
  setup, activity, session and agent controls.
- Respect `prefers-reduced-motion` and offer system theme behavior in addition to explicit light/dark
  selection if it can be added without ambiguity.
- Verify layout and usability at 125%, 150% and 200% zoom and at minimum, preferred and maximized
  window sizes.
- Add visual regression coverage for light/dark themes and stateful controls, including errors,
  indeterminate permission groups, rename/edit states, setup completion and agent states.

## Quality gates

M6 is complete only when:

- the Priority 0 correctness/trust items above are resolved or explicitly moved to a narrower blocking
  issue with evidence;
- repository/product naming and Linux support claims agree across GitHub metadata, README, app,
  extension and package metadata;
- first-run setup and common permission changes are usable with mouse, keyboard and screen reader;
- responsive/zoom/theme visual regressions are automated for representative states;
- README/docs no longer hard-code model-facing tool facts that can silently drift, unless protected by
  a consistency test;
- product changes preserve M0–M5 security contracts and the relevant CI/security/candidate gates.

## Contracts

- UX simplification must never collapse materially distinct authorities into one hidden permission.
- Visual state is descriptive. Main-process/live capability enforcement remains authoritative.
- Product polish must not require remote analytics or telemetry. Any quality/performance measurement
  introduced for development remains local unless a future explicit privacy-reviewed feature says
  otherwise.
- Accessibility is part of acceptance, not a post-release cleanup task.
- Documentation that describes a security or capability fact must point to an authoritative source or
  be guarded by a consistency test.

## Out of scope

- Large internal module decomposition, startup/runtime performance architecture and CI execution-time
  optimization: M7.
- Logical worker identities, structured agent result schemas, task DAGs, context succession and
  multi-prime scheduling: M8.
- Weakening or redesigning the M0–M5 security boundaries for convenience.

# Task-oriented agent workflow

Use this together with [`AGENTS.md`](../AGENTS.md). `AGENTS.md` owns architecture
and repository safety; [`milestones/README.md`](../milestones/README.md) owns
mutable roadmap state. Do not duplicate the current milestone elsewhere.

For product/repository UX, architecture/performance or agent-orchestration work,
also read [`docs/product-quality-plan.md`](product-quality-plan.md) and the owning
M6–M8 milestone record. That plan explains the cross-cutting rationale; milestone
records remain authoritative for scope/status.

## Fast path

1. Classify the request by subsystem and read only the relevant `AGENTS.md` section/code/tests.
2. Read `milestones/README.md` and inspect open GitHub Milestones/Issues.
3. Select the milestone that owns the requested behavior. If none fits, define the next roadmap milestone before implementation.
4. Before editing tracked files, create one focused milestone-bound Issue titled `M<N>: <imperative summary>`.
5. Create a focused branch, push it early, and open a draft PR after the first meaningful commit.
6. Keep the Issue, milestone record, and PR synchronized when investigation changes scope or exposes an independently reviewable follow-up.
7. Run the narrowest meaningful test first, then the relevant broader gates. Record only checks actually run.
8. Close the Issue through the merged PR after its acceptance criteria pass, or explicitly close it as superseded/not-planned with a replacement pointer.

## Issue contract

An implementation Issue should normally contain:

- **Summary** — the behavior/change in one bounded statement.
- **Why** — why it belongs in the selected milestone and why it matters.
- **Acceptance criteria** — observable, testable completion conditions.
- **Scope / out of scope** — prevent opportunistic widening.
- **Evidence** — repro, audit finding, failing test, relevant review, or other provenance when useful.

Do not pre-close an Issue because code exists. Code, tests, runtime/manual evidence,
documentation, and final-head CI are different forms of evidence; record them accurately.

## Product-quality evidence

M6–M8 work needs evidence appropriate to the thing being changed; a typecheck is not a
substitute for UX, performance or lifecycle proof.

### M6 — product/repository experience

Record the relevant evidence from:

- minimum/preferred/maximized window layouts and 125/150/200% zoom;
- light/dark (and system theme when supported) visual states;
- keyboard-only/focus behavior and screen-reader semantics for changed controls;
- visual regression snapshots for stateful controls;
- README/GitHub/package/app/extension naming/platform consistency;
- tool/default/capability documentation consistency checks where those facts are copied.

A polished screenshot is not evidence that a permission boundary is correct. Existing
security/capability tests remain required whenever the UI changes authority configuration.

### M7 — architecture/performance

For refactors, state which state machine/authority moved and which regression tests prove
behavioral parity. Preserve or relocate load-bearing comments/invariants.

For optimization, capture a baseline and the same measurement after the change. Relevant
metrics include app/extension startup, MCP/tool overhead, session lookup/render, worker
spawn/wake and shutdown. Performance diagnostics remain local by default; do not add remote
analytics merely to obtain a benchmark.

If CI is parallelized, keep a final integration/security/candidate proof where the existing
release/security contract requires one. Faster partial jobs do not replace final-head gates.

### M8 — agent orchestration

Agent changes require tests for identity and state transitions, not just prompt examples.
At minimum consider:

- prime/worker/stranger conversation attribution;
- spawn/message durability before browser side effects;
- sleeping/revival/idempotent-retry distinctions;
- structured finish bounds and evidence semantics;
- worker scopes only narrowing user authority;
- task dependency/conflict transitions;
- successor-conversation transaction/recovery;
- detached/long-turn sleep/wake races and duplicate-work prevention;
- cross-prime isolation/capacity before any multi-prime scheduler is enabled.

Model-facing instructions/schemas must agree with the implemented lifecycle. Add contract tests
when prose can otherwise drift into telling the model the opposite of the broker behavior.

## GitHub tracking recipe

From a checkout with authenticated `gh`:

```bash
gh auth status
gh repo view --json nameWithOwner
gh issue list --state open --limit 100
```

Synchronize roadmap milestone objects before filing work when necessary:

```bash
bash scripts/sync-github-milestones.sh
```

The script verifies that it is running against `NahuelGenchi/local-cgpt` and is
idempotent. GitHub Issues must be enabled for milestone/Issue tracking to work.

If synchronization itself is failing, do not manually pretend roadmap and GitHub state are
synchronized. File/fix the synchronizer as focused governance/product-correctness work, record
the blocker in the affected Issue/PR, and verify the complete milestone mirror after repair.

## Pre-existing untracked work

Do not throw useful work away solely because tracking was introduced later.
Stop before adding more scope, identify the owning milestone, create/assign the
Issue, ensure the branch/draft PR exists, document the retroactive relationship,
and then continue. The initial security PR #1 and the governance bootstrap are
the repository's two explicit bootstrap cases.

## Investigation discipline

- Search narrowly for the earliest wrong authority/identity/state transition.
- Read existing tests and load-bearing comments before changing a guard.
- Split a follow-up when it has its own acceptance criteria or can be reviewed independently.
- Never weaken a production security boundary merely to restore a legacy test assumption.
- Never state that a manual/platform/security/UX/performance check passed when it was not actually run.
- For product polish, distinguish a visual defect from an authority/state defect; fix the earliest
  wrong fact rather than masking it with renderer state.
- For optimization, distinguish measured user cost from source-code aesthetics.

## PR discipline

A PR should reference its tracked Issue, identify the milestone, explain the
smallest material change, list actual validation, and call out intentionally
unverified/manual items. Keep draft status while acceptance is materially open.
Do not merge without the repository owner's approval.

For M6–M8, explicitly name which product/security contracts remain unchanged. If a supposedly
visual/performance/agent refactor changes authority, identity, persistence or external disclosure,
that is a scope change and normally deserves its own focused issue/review.

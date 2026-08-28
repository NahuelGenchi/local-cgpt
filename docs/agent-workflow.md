# Task-oriented agent workflow

Use this together with [`AGENTS.md`](../AGENTS.md). `AGENTS.md` owns architecture
and repository safety; [`milestones/README.md`](../milestones/README.md) owns
mutable roadmap state. Do not duplicate the current milestone elsewhere.

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
- **Why** — why it belongs in the milestone and why it matters.
- **Acceptance criteria** — observable, testable completion conditions.
- **Scope / out of scope** — prevent opportunistic widening.
- **Evidence** — repro, audit finding, failing test, relevant review, or other provenance when useful.

Do not pre-close an Issue because code exists. Code, tests, runtime/manual evidence,
documentation, and final-head CI are different forms of evidence; record them accurately.

## GitHub tracking recipe

From a checkout with authenticated `gh`:

```bash
gh auth status
gh repo view --json nameWithOwner
gh issue list --state open --limit 100
gh milestone list 2>/dev/null || true
```

Synchronize roadmap milestone objects before filing work when necessary:

```bash
./scripts/sync-github-milestones.sh
```

The script verifies that it is running against `NahuelGenchi/local-cgpt` and is
idempotent. GitHub Issues must be enabled for milestone/Issue tracking to work.

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
- Never state that a manual/platform/security check passed when it was not actually run.

## PR discipline

A PR should reference its tracked Issue, identify the milestone, explain the
smallest material change, list actual validation, and call out intentionally
unverified/manual items. Keep draft status while acceptance is materially open.
Do not merge without the repository owner's approval.

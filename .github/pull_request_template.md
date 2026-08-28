## Tracking

- Milestone: `M<N> — ...`
- Issue: Closes #...

If this is one of the documented bootstrap exceptions, explain the exception instead of inventing an Issue link.

## What changed

Describe the root cause/need and the smallest behavior change that satisfies the tracked Issue.

## Acceptance evidence

List only evidence actually observed on this PR head. Distinguish automated, platform/runtime, and manual checks when relevant.

## Validation

- [ ] The PR has one focused milestone-bound Issue, or documents a bootstrap exception.
- [ ] The Issue acceptance criteria and PR scope are synchronized.
- [ ] Added or updated a deterministic regression test where behavior changed.
- [ ] `npm run verify` passes.
- [ ] Packaging/runtime smoke was run when the change can differ after bundling, or is explicitly recorded as not run.
- [ ] No unrelated formatting, generated output, local debugging notes, or private data is included.
- [ ] Screenshots, logs and examples use placeholders instead of real usernames, paths, chat text, IDs or credentials.
- [ ] Security-sensitive details are being handled privately instead of disclosed here.

## Scope changes / follow-ups

Record material discoveries that changed this Issue's scope. Create a separate milestone-bound Issue for independently reviewable follow-up work rather than silently expanding this PR.

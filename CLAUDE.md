# Claude repository instructions

Read and follow `AGENTS.md` before changing this repository. For tracked work,
also read `milestones/README.md` and `docs/agent-workflow.md`. The milestone
roadmap is the single source of truth for mutable roadmap state; do not duplicate
a "current milestone" here.

Before changing tracked files, create/select the matching GitHub Milestone and
create one focused milestone-bound Issue as required by the agent workflow. Use
a focused branch and open/keep a draft PR while material acceptance remains
open. The documented initial governance/security work is the only bootstrap
exception.

This is a public repository. Never add Claude provenance session URLs or session trailers to
commit messages, files, release notes, logs, or generated artifacts. Maintainer commits must use
a GitHub noreply address; never use a personal mailbox or a private local path. Before every
commit, push, tag, or release, run `npm run verify:privacy`. The versioned Git hooks installed by
`npm run hooks:install` enforce the same policy for Claude-created commits.

Do not bypass these guards with `--no-verify`. If a privacy check blocks a change, remove the
private value at its source and create a new clean commit instead.

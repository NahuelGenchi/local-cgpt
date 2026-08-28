# M5 — Hardened upstream maintenance

**Status:** Planned

**Depends on:** M4

## Goal

Keep the fork maintainable as upstream evolves without allowing upstream feature
work, dependency updates, or release changes to silently weaken the security
contracts established by earlier milestones.

## Scope

- Define an explicit upstream intake/review procedure from pinned source commits or tags.
- Classify upstream changes by trust boundary: permissions, MCP surfaces, execution, browser observation, storage, secrets, network, packaging, or ordinary feature code.
- Require focused regression review when a change touches a security boundary.
- Keep dependency updates locked, auditable, and separated when they materially change native/runtime authority.
- Track intentionally diverged fork behavior so future rebases do not "restore" insecure upstream defaults by accident.
- Add automated guards for critical fork invariants that can be checked mechanically.

## Contracts

- Upstream provenance is evidence, not automatic approval.
- Security-sensitive merges remain reviewable as focused changes.
- Conflicts are resolved according to current fork contracts, not by choosing the newer side blindly.
- No milestone or Issue is closed because upstream changed; acceptance criteria must still be demonstrated in this fork.

## Out of scope

New product features unrelated to maintenance. They require their own roadmap milestone when approved.

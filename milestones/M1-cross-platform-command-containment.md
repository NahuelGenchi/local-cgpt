# M1 — Cross-platform command containment

**Status:** Planned

**Depends on:** M0

## Goal

Provide OS-enforced containment for model-launched commands on every platform
where command execution is offered, without silently widening authority when a
backend is missing or unavailable.

## Scope

- Define and implement supported Windows and macOS containment backends.
- Keep approved project roots as the explicit filesystem authority boundary.
- Isolate process home/temp and ambient credential access where the platform permits it.
- Preserve deterministic terminal/session semantics through the containment layer.
- Detect unavailable/incompatible sandbox support and fail closed with actionable diagnostics.
- Add platform-specific integration tests that prove host resources outside the grant are inaccessible.

## Contracts

- A working directory is not containment.
- Application path validation is defense in depth; command isolation must be OS-enforced.
- Unsupported configurations do not fall back to unrestricted execution.
- Platform differences must be explicit in capability discovery and documentation.

## Out of scope

Independent user-granted network egress policy, which is M2.

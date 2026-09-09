# September 8, 2026 review follow-up

Planning tracker: [#59](https://github.com/NahuelGenchi/local-cgpt/issues/59).

This records the owner's request to incorporate all seven review areas into the roadmap,
milestones and actionable issues. It is a planning update, not implementation or evidence that
a proposed security, privacy, performance or UX change has passed acceptance.

The reviewed source was `main` at `792e9f53c901b8dbf111c28b50476bee88d2f863`.
[`milestones/README.md`](../milestones/README.md) remains authoritative for mutable roadmap state;
[`product-quality-plan.md`](product-quality-plan.md) supplies the broader rationale. This dated
addendum supersedes older planning language only where it explicitly tightens the provider,
recording, Linux release or completion-status direction below.

## Complete recommendation map

| Review area | Required follow-up | Owning milestone / issue |
| --- | --- | --- |
| Security | Signed Linux artifacts, publisher verification, exact-commit attestations, SBOM and checksums | M4 / [#64](https://github.com/NahuelGenchi/local-cgpt/issues/64) |
| Security | Adversarial fixtures and bounded seeded fuzz/property tests for captured HTML and URLs | M3 / [#63](https://github.com/NahuelGenchi/local-cgpt/issues/63) |
| Privacy | Authenticated encryption for sensitive recordings and indexes, secure key handling and recoverable migration | M3 / [#60](https://github.com/NahuelGenchi/local-cgpt/issues/60) |
| Privacy | Per-chat recording consent, visible state and immediate revocation, including late writes and resume/worker identity | M3 / [#61](https://github.com/NahuelGenchi/local-cgpt/issues/61) |
| Privacy | Remove external-model Goal inference; use only the user's selected ChatGPT model | M3 / [#62](https://github.com/NahuelGenchi/local-cgpt/issues/62), with M8 / [#57](https://github.com/NahuelGenchi/local-cgpt/issues/57) integration |
| Smoothness | Incremental session/timeline reconciliation, lazy tool details, stable selection/focus/scroll and local before/after measurements | M7 / [#65](https://github.com/NahuelGenchi/local-cgpt/issues/65) |
| Front-end design | Keyboard-accessible session rows and agent filters; adjustable local reading width/text size | M6 / [#67](https://github.com/NahuelGenchi/local-cgpt/issues/67) |
| Front-end design | Reusable state-driven cockpit components instead of DOM-observer/text-parsing projections | M7 / [#66](https://github.com/NahuelGenchi/local-cgpt/issues/66) |
| Connectivity | Monitored Cloudflare lifecycle, bounded cancellable recovery, URL-change handling, and separate local-ready/remote-verified manual-tunnel states | M6 / [#68](https://github.com/NahuelGenchi/local-cgpt/issues/68), preserving M2 boundaries |
| Text and code format | Local syntax highlighting, language labels, exact copy-code, wrap controls and inert raw/rendered switching | M6 / [#69](https://github.com/NahuelGenchi/local-cgpt/issues/69) |
| Chats | Bounded earlier/later history, viewer search and jump-to-event, pinning, project grouping and explicit resumed-conversation lineage | M6 / [#70](https://github.com/NahuelGenchi/local-cgpt/issues/70) |

Each implementation issue owns its detailed acceptance checklist, scope, evidence and dependencies.
The planning tracker does not close those implementation issues.

## Priority and dependency policy

Within this follow-up backlog, prioritize recording privacy/provider removal (#60–#62), then
release integrity (#64), connection reliability (#68), and chat/renderer usability (#65–#70).
Preventive sanitizer coverage (#63) is a security prerequisite for formatting enhancements (#69).
A newly verified security defect takes priority and follows the private reporting policy.

M1 remains the current sequential milestone. These priorities do not reorder the whole roadmap,
waive M2/M3 dependencies, reopen M0, or authorize release publication. Independent design/test work
may run in parallel only when the owning milestone's contracts remain intact.

Coordinate related work without combining it into one implementation PR:

- #60 and #61 define storage/consent behavior for #57 and #70. Search indexes and grouping metadata
  must not create a new plaintext or cross-chat privacy leak.
- #62 constrains #57: no external Goal model, hidden fallback provider or silent model substitution
  in worker/resume flows. Where supported UI evidence cannot establish model continuity, pause for
  explicit user verification rather than claiming unobservable backend guarantees.
- #63 precedes #69. Syntax highlighting is presentation, never executable or network authority.
- #65, #67 and #70 share stable identity, pagination, focus and scroll contracts. More accessible
  history must not mean unbounded retention, IPC payloads, DOM or HTML parsing.
- #66 and #68 must use authoritative state, not infer connection health from labels or stale DOM.

## Completion and evidence discipline

The review identified source-level opportunities. It did not measure runtime performance, conduct
a new penetration test, validate a screen reader, encrypt recordings or sign a release.

Preserve already-landed work as history: milestone synchronization repair (#47 / PR #48),
worker-reuse instruction correction (#49 / PR #50), renderer foundation (#51 / PR #52), Home
cockpit (#53 / PR #54), visible identity (#55 / PR #56), and the autonomy slice (#57 / PR #58).
Their presence does not complete M6 or M8. #57 remains open; new privacy/model constraints are
follow-up acceptance, not retroactive claims about PR #58.

Required implementation evidence includes threat-model/migration tests for recordings; negative
provider-egress tests; sanitizer fixtures/fuzz seeds; signature/provenance verification failures;
connection lifecycle/race tests; keyboard/zoom/theme/screen-reader checks; and representative local
performance measurements. A source-size observation or a typecheck alone is not that evidence.

## Unchanged product and authority boundaries

Linux remains the only supported product target. The app remains a capability/permission bridge
and recorded-session viewer, not a replacement chat client or a model host. No remote analytics,
arbitrary probe destinations, wider extension origins, new external inference provider, relaxed
HTML filtering, hidden permission grants or generic shell-network expansion is authorized here.
Ordinary command isolation, secure-keyring requirements, live revocation, bounded representations
and explicit conversation identity remain mandatory.

Encryption does not protect an unlocked application from native same-user compromise; deletion
cannot promise secure erasure of every SSD or backup copy. Stopping recording is distinct from
deleting retained history, and pinning must not silently override retention.

## Publication and milestone synchronization

Issues #59–#70 are live GitHub tracking and are assigned to the existing M3/M4/M6/M7 milestones.
Roadmap/milestone documents and the synchronizer's description data are proposed on
`work/september-review-roadmap` for review; no merge is authorized by this update.

The connected GitHub interface does not expose milestone-description mutation or workflow dispatch.
The existing synchronizer can publish the revised descriptions after the planning PR is merged
through the normal owner-approved workflow. Until that run is verified, distinguish live issue
assignments from pending milestone-description synchronization. Do not report the full mirror as
verified merely because an issue assignment or Markdown edit succeeded.

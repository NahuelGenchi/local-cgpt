# M3 — Browser and session privacy

**Status:** Planned

**Depends on:** M2

## Goal

Minimize sensitive data retained or transferred by browser augmentation, recording,
continuation and workers. Protect retained recordings, make per-chat collection revocable,
and remove external-provider Goal inference so local-cgpt uses only the model selected
in the user's ChatGPT chat.

These are target requirements, not claims about the current runtime. The September 8, 2026
planning update is tracked in #59 and [`docs/review-follow-up-2026-09-08.md`](../docs/review-follow-up-2026-09-08.md).

## Scope and tracked work

- Review required ChatGPT-origin access and keep companion host permissions narrowly pinned.
- Minimize transcript/tool data captured and retained for each feature; preserve bounded retention
  and verifiable deletion behavior.
- **#60 — Encrypt recorded session data.** Authenticated encryption, supported OS-keyring-protected
  keys, sensitive metadata/index coverage, explicit legacy migration, rotation/recovery and
  tamper/crash tests. Missing keys or an insecure backend must not cause plaintext fallback.
- **#61 — Per-chat recording consent and revocation.** Global-off takes precedence, unknown identity
  fails closed, and revocation stops queued/late capture. Define resume/worker consent explicitly
  and distinguish stopping recording from deleting existing history.
- **#62 — Selected ChatGPT model only.** Remove OpenRouter/other external-model Goal requests,
  associated selectors/prompts and obsolete credentials through an explicit migration. Retained
  continuation must use local orchestration and the user's selected ChatGPT conversation, not a
  second model or hidden fallback provider. Coordinate M8/#57 worker/resume integration.
- **#63 — Adversarial captured-HTML coverage.** Deterministic fixtures and bounded seeded
  fuzz/property tests for tags, attributes, URL protocols, namespaces, malformed/deep markup,
  mutation cases and payload bounds. This is preventive testing, not a confirmed vulnerability.
- Keep data-expanding browser features independently opt-in and add lifecycle/privacy regression
  coverage for capture, retention, deletion, key failures and provider-egress denial.

The previous plan to permit OpenRouter Goal processing merely after provider disclosure is
superseded by #62. Do not rewrite current user/security documentation as though removal has
already shipped; update runtime-facing claims with the implementing PR and evidence.

## Acceptance and evidence

M3 requires evidence that:

- sensitive recordings, assets, handoffs, relevant checkpoint material and indexes receive the
  documented encryption treatment, with residual metadata and same-user compromise limits clear;
- interrupted migration/key rotation is recoverable, corrupted records fail safely, and a locked
  or missing keyring never silently creates plaintext recordings;
- global/per-chat consent, exact conversation identity, late writes, restart and resume/worker
  transitions cannot broaden collection without explicit user authorization;
- no external Goal inference request occurs for fresh, migrated, stale or hostile settings;
- selected-model continuity is preserved or explicitly verified where supported; uncertain
  worker/resume binding pauses rather than claiming hidden backend guarantees;
- sanitized display cannot introduce executable content, unsolicited network requests or privileged
  controls, while safe prose/code/table semantics and resource bounds remain intact;
- retention/deletion and local bounded search work correctly with encrypted/locked records.

Each issue owns its detailed checklist and exact validation. Privacy and relevant security gates
remain required; no runtime or cryptographic acceptance is implied by the planning update.

## Contracts

- Browser observation is part of the trusted computing base, not harmless metadata access.
- API keys and detailed recordings are different data classes requiring appropriate controls.
- Disabling a feature stops the data-expanding behavior it owns; recording consent cannot be
  silently enabled by an autonomy preset, worker or continuation.
- No second inference provider, wider origin access or remote analytics is authorized here.
- The app remains a bridge/viewer, not a model host or replacement chat client.
- Encryption at rest is not protection from a compromised unlocked app or native same-user access.
- Deletion cannot promise secure erasure of every SSD, snapshot or backup copy; disclose limitations.
- Formatting work in M6/#69 may not weaken the #63 sanitizer boundary.

## Dependencies and out of scope

Coordinate M6/#70 history/search/group metadata with #60/#61 and M8/#57 with #61/#62.
Storage encryption must cover sensitive indexes rather than creating a new plaintext search leak.
Existing M2 authority separation and live revocation remain prerequisites.

Release artifact provenance and publisher signing belong to M4. Broad platform expansion,
new external providers and replacement chat/model hosting are out of scope.

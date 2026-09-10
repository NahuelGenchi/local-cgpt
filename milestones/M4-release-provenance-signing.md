# M4 — Release provenance and signing

**Status:** Planned

**Depends on:** M3 for release readiness; independent design/testing may proceed without publication

## Goal

Make a downloaded privileged Linux desktop build verifiably traceable to its reviewed
source commit, hardened build pipeline and publisher. Controlled unsigned M0 candidates
remain distinct from a signed production distribution.

## Tracked review work

**#64 — Deliver signed Linux artifacts with verifiable release provenance.**
Planning context: #59 and [`docs/review-follow-up-2026-09-08.md`](../docs/review-follow-up-2026-09-08.md).
This extends the completed M0 packaging work in #8; it does not reopen M0 or authorize release
publishing as part of the planning update.

## Scope

- Build Linux artifacts from reviewed commits through pinned CI actions and locked dependencies.
- Produce checksums, an SBOM and build provenance/attestations bound to the exact artifact,
  source commit, packaged helpers and final-head build/test evidence.
- Define a Linux publisher-signing/trust-root policy with protected key custody, verification,
  rotation/revocation and recovery. Signing credentials never enter model-visible output.
- Verify packaged helpers and architecture-specific native dependencies before publication.
- Provide an independently executable verification path for artifact integrity, publisher identity
  and provenance; a checksum alone is not publisher authentication.
- Gate publication on privacy, dependency, security, test and packaging checks.
- Document reproducibility limitations instead of claiming bit-for-bit reproducibility without proof.
- Keep explicitly labeled controlled unsigned test artifacts separate from the signed release path.

## Acceptance and evidence

- Artifact, source-SHA, checksum, SBOM, attestation and signature records agree and are produced
  by the reviewed pipeline rather than reconstructed manually after publication.
- Verification rejects tampered artifacts, wrong commits, invalid/missing signatures or
  attestations and untrusted publisher identities.
- Missing signing capability or verification failure blocks the signed distribution path;
  no silent downgrade to an apparently signed release.
- Linux package/app/executable identity and helper-provenance checks remain unchanged.
- Required M3 privacy and final-head security/packaging evidence precedes release readiness.
- Public release enablement remains separately owner-approved; this roadmap update neither
  enables publishing nor restores unsupported platform release gates.

## Contracts

- A source review does not authenticate a downloaded binary.
- Release metadata is produced by the reviewed pipeline, not reconstructed after publication.
- Signing failure does not silently publish an artifact as though it were signed.
- Provenance, publisher signing, integrity checks and reproducibility are distinct claims;
  describe and verify each claim actually made.
- Linux is the only supported product/release target in this phase.

## Out of scope

Routine upstream intake and dependency-update governance belong to M5.
Windows publisher signing and macOS signing/notarization are deferred until separately approved
platform-expansion milestones exist; they are not current M4 completion conditions.
No new signing credentials, public release or packaging/security relaxation is authorized by #59.

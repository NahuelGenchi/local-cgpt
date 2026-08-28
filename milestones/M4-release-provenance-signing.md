# M4 — Release provenance and signing

**Status:** Planned

**Depends on:** M3

## Goal

Make a downloaded privileged desktop build traceable to a reviewed source
commit and a hardened build pipeline, with machine-verifiable release metadata
and publisher identity where signing credentials are available.

## Scope

- Build release artifacts from reviewed commits through pinned CI actions and locked dependencies.
- Publish checksums and an SBOM for release artifacts.
- Add build provenance/attestation where the hosting/toolchain supports it.
- Verify packaged helpers and architecture-specific native dependencies before publication.
- Add Windows publisher signing and macOS signing/notarization when appropriate credentials are available; document any unavoidable unsigned development channel explicitly.
- Gate release publication on privacy, dependency, security, test, and packaging checks.
- Document reproducibility limitations instead of claiming bit-for-bit reproducibility without proof.

## Contracts

- A source review does not authenticate a downloaded binary.
- Release metadata is produced by the reviewed pipeline, not reconstructed manually after publication.
- Signing failure does not silently publish an artifact as though it were signed.

## Out of scope

Routine upstream intake and dependency-update governance, which are M5.

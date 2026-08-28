# M3 — Browser and session privacy

**Status:** Planned

**Depends on:** M2

## Goal

Minimize the sensitive data retained or transferred by browser augmentation,
session recording, continuation features, worker coordination, and Goal mode,
while keeping every external-processing boundary explicit to the user.

## Scope

- Review the companion extension's required ChatGPT-origin access and keep host permissions narrowly pinned.
- Minimize transcript/tool data captured and retained for each feature.
- Provide clear, bounded retention and verifiable deletion behavior for local session data.
- Evaluate practical at-rest protections for retained sensitive session material without weakening portability or recoverability silently.
- Make OpenRouter/other external processing disclose the provider and data category before activation.
- Ensure recording, continuation, workers, and Goal remain independently opt-in when they expand data collection or transfer.
- Add lifecycle/privacy regression coverage for capture, retention, deletion, and provider-boundary behavior.

## Contracts

- Browser observation is part of the trusted computing base and is never described as harmless metadata access.
- A locally stored API key and locally stored conversation history are different data classes and may require different controls.
- Disabling a feature stops the data-expanding behavior it owns.
- No new remote origin or external provider is introduced without explicit review.

## Out of scope

Release artifact provenance, publisher signing, and notarization, which are M4.

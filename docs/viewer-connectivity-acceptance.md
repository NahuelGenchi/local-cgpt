# Viewer, cockpit and connectivity acceptance snapshot

Tracked by #75. This branch combines exact implementation blobs for CI and review; it is not a merge approval or a production distribution.

## Inputs

- Baseline main: `792e9f53c901b8dbf111c28b50476bee88d2f863`.
- PR #72, #63/#65/#67/#69/#70: `4aa264f092b12a1f0d991b91a764212e5fa159aa`.
- PR #73, #66/manual #68: `b70c7f53813d5891901517dbde4f9056112a1f0a`.
- PR #74, Cloudflare #68: `db88dcc70c5f906cd381d22fc06826de0766a29e`.

Their implementation file sets are disjoint. The acceptance snapshot uses the viewer tree plus the exact four cockpit and three Cloudflare file blobs. No merge commit, main-branch update, public release, runtime configuration or dependency change is involved.

## Delivered behavior

The recorded-session viewer keeps durable keyed rows and creates tool payload DOM only when expanded. It preserves focus/selection and uses scroll anchors; explicit bounded history pages replace an unbounded transcript. Sessions have native keyboard controls, reading size/width settings, pins and presentation-only project/explicit lineage groups. Content search is scoped to the selected recording, with bounded pages and explicit continuation; the session-title filter is labelled as page-only.

Captured HTML keeps the strict sanitizer. Locally bundled lexical highlighting uses inert text nodes, known-language inference is labelled as inference, and copy preserves retained code rather than controls/truncation notices. Raw mode displays retained text, not reconstructed original Markdown.

Home receives authoritative state projections rather than parsing rendered DOM. Permission disclosure expansion has one owner and never writes permissions. Manual transport readiness is distinct from request-based remote verification; request evidence is not caller/proxy identity attestation.

Cloudflare requires a public URL plus readiness from its owned helper's fixed loopback endpoint. Recovery uses at most five exponential-backoff restarts per unstable run, cancellation/generation checks, observed process retirement and explicit new-URL warnings. It never logs raw helper output or grants arbitrary probe destinations.

## Evidence and limits

Normal CI passed separately for all three input heads. Combined results are recorded in the acceptance PR and #75 after execution, not predicted here. Candidate package installation/native checks/Xvfb startup are distinct from source security acceptance.

The existing production dependency audit remains blocking. Do not suppress it or interpret skipped downstream checks as passes. These changes do not upgrade dependencies or enable public candidate uploads after a failed source gate.

Automated evidence includes jsdom interaction/focus/selection tests, seeded sanitizer cases, bounded history/search tests, deterministic row-construction counts, fake process/timer lifecycle tests and a real local HTTP readiness probe. These are not a complete live Cloudflare outage test or manual screen-reader/zoom/theme review. No wall-clock performance improvement is claimed from construction counts alone.

Recording encryption and per-chat consent (#60/#61), and external Goal-provider removal (#62), are separate work. Viewer pins/project labels are local presentation metadata, not encrypted storage or capability grants; pinning does not override retention. The app remains a permission bridge and recording viewer, not a replacement model/chat client.

Review the focused implementation PRs. Keep them unmerged until owner review, required security gates and remaining acceptance are satisfied.

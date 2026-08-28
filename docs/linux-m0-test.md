# Linux M0 controlled test procedure

M0 is a controlled first-test boundary for the Linux-only hardened fork. It is **not** a public production release, and the GitHub Actions candidate is uploaded only as a short-lived workflow artifact. Public release publishing remains disabled until the release-provenance/signing milestone defines its acceptance gates.

## Security assumptions for the controlled candidate

The M0 packaging pipeline relies on the following explicit assumptions. A failed assumption is a stop condition, not a reason to weaken a control.

- The reviewed source is identified by one exact 40-character Git commit SHA. On pull requests the candidate workflow checks out the PR head SHA rather than GitHub's synthetic merge SHA, verifies `git rev-parse HEAD`, and records that same SHA in `M0-LINUX-SOURCE.txt` and the workflow artifact name.
- Source verification is an issuance gate. Package build/install/runtime validation may still run after source verification fails so packaging defects remain observable, but the overall workflow stays failed and the controlled candidate upload is suppressed unless source verification succeeds.
- The supported M0 install format is the x64 Debian package only. AppImage configuration remains reviewed, but AppImage is not built, uploaded, installed, or required by the controlled M0 candidate gate.
- The Debian package identity is `local-cgpt`, the Electron app ID is `com.localcgpt.app`, the installed launcher is `/usr/bin/local-cgpt`, and the candidate filename is `Local-CGPT-Linux-x64.deb`. These identities must not reuse the upstream Chat On Steroids package/artifact identity.
- Bubblewrap is a mandatory Debian runtime dependency because `exec_command` is expected to fail closed without the Linux sandbox backend. The candidate pipeline must not introduce an unsandboxed fallback.
- The packaged Chrome extension is copied from the reviewed repository `extension/` tree. The candidate pipeline must not download an extension from an upstream release.
- `tunnel-client` and ripgrep downloads remain version-pinned and SHA-256 verified before extraction. Moving `latest` URLs are not acceptable.
- GitHub Actions dependencies are referenced by immutable 40-character action commit SHAs. Candidate and disabled release workflows have read-only repository contents permission.
- The Xvfb smoke proves that the installed Electron application remains running during a short disposable-profile GUI startup window without adding `--no-sandbox`. It is a packaging/runtime smoke, not a substitute for the Bubblewrap containment tests.
- `SHA256SUMS.txt` authenticates artifact bytes only after the reviewer has independently matched `M0-LINUX-SOURCE.txt` to the approved source commit. M0 does not yet claim signed release provenance.

## 1. Verify the target Linux sandbox as your normal user

Do **not** use `sudo` for this check.

From the exact reviewed source revision:

```bash
npm ci
npm run verify:linux-sandbox
```

The command must finish with `Linux sandbox verification passed.`

This executes the same production Bubblewrap profile used by `exec_command` and verifies that:

- a writable approved root remains writable;
- a symlink to data outside that root cannot be read;
- an injected secret-like environment variable does not enter the child;
- HOME and TMP are the private sandbox locations; and
- the sandbox does not expose the host network interface.

If the command fails because Bubblewrap or namespace support is unavailable, stop. Do not use an unsandboxed fallback or run the desktop app with command capability enabled.

On Debian/Ubuntu, install Bubblewrap with:

```bash
sudo apt-get update
sudo apt-get install -y bubblewrap
```

Then rerun `npm run verify:linux-sandbox` as the normal user.

## 2. Obtain only the controlled M0 Linux candidate

Use the `Linux M0 test candidate` workflow artifact for the exact reviewed source SHA. The workflow artifact is issued only when the workflow's exact-source verification job succeeds. Its name is `local-cgpt-m0-linux-x64-<SOURCE_SHA>` and it contains:

- `Local-CGPT-Linux-x64.deb`;
- `SHA256SUMS.txt`;
- `M0-LINUX-SOURCE.txt` with the exact source repository, ref, commit SHA, package/app/executable identity, `public_release=false`, and `source_verification=success`; and
- `LINUX-M0-TEST.md` with these instructions.

If source verification fails, the workflow may still exercise the DEB build, install, package ownership checks, native-runtime checks, and Xvfb startup for diagnostic evidence, but it must not upload a controlled candidate artifact.

Do not substitute an upstream release, an older local-cgpt artifact, an AppImage, or a Windows/macOS build.

Verify the checksum, source revision, and hardened package identity before installation:

```bash
sha256sum -c SHA256SUMS.txt
cat M0-LINUX-SOURCE.txt
dpkg-deb --field Local-CGPT-Linux-x64.deb Package
dpkg-deb --field Local-CGPT-Linux-x64.deb Architecture
dpkg-deb --field Local-CGPT-Linux-x64.deb Depends
```

The package field must be exactly `local-cgpt`, architecture must be `amd64`, and the dependency list must include `bubblewrap`. The `source_sha` entry must exactly match the commit approved for testing, `source_verification` must be `success`, and `public_release` must be `false`.

## 3. Install the Debian candidate

```bash
sudo apt install ./Local-CGPT-Linux-x64.deb
```

Confirm the installed launcher resolves to a package-owned executable and Bubblewrap is present:

```bash
resolved="$(readlink -f /usr/bin/local-cgpt)"
test -x "$resolved"
test "$(basename "$resolved")" = local-cgpt
dpkg-query -S "$resolved"
bwrap --version
```

The ownership query must report `local-cgpt`.

## 4. Use disposable data for the first run

Create a new empty test workspace containing no personal documents, SSH keys, browser data, password stores, cloud credentials, production repositories, or other sensitive material.

On first launch, verify that:

- no model-facing capability is enabled;
- read-only mode is enabled;
- session recording is disabled;
- automatic compaction is disabled;
- multi-agent mode is disabled; and
- Goal mode is disabled.

Approve only that disposable workspace. Do not approve your home directory, filesystem root, or a broad parent directory.

## 5. Increase authority gradually

For the first connection, enable only the minimum read capability needed to prove the MCP connection works.

Only after that succeeds should you enable command execution. Keep the workspace disposable and confirm commands cannot read outside the approved root or reach the network.

Do not enable session recording, Goal mode, worker/multi-agent features, or the companion Chrome extension during the first security smoke. Those add separate privacy surfaces and are not needed to prove the core Linux sandbox boundary.

## 6. AppImage status for M0

The repository retains AppImage configuration so its behavior can continue to be reviewed. electron-builder's static AppImage runtime toolset remains pinned, and regression tests cover its conditional Chromium sandbox fallback behavior. However, M0 deliberately packages the Debian target only; no AppImage result is part of the candidate checksum set or acceptance gate.

## 7. Stop conditions

Stop testing and report the result if any of these occur:

- the normal-user sandbox verification fails;
- the installed package does not have Bubblewrap available;
- `/usr/bin/local-cgpt` does not resolve to an executable owned by the `local-cgpt` package;
- the candidate metadata SHA differs from the reviewed source SHA;
- `source_verification` in candidate metadata is not `success`;
- the artifact uses an upstream Chat On Steroids package/artifact identity;
- a command can read a file outside the approved root;
- a command has host network access;
- any capability/data-expanding feature is enabled unexpectedly on a fresh configuration; or
- the artifact checksum does not match.

Do not work around a failed security check by adding `sudo`, disabling the sandbox, adding `--no-sandbox`, broadening the approved root, or sharing the host network.

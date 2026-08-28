# Linux M0 controlled test procedure

Use this procedure only after PR #1 reports all automated M0 gates green. M0 is a controlled first-test boundary, not a claim that later privacy/provenance milestones are unnecessary.

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

Use the `Linux M0 test candidate` artifact produced from the final reviewed PR #1 head. The artifact contains:

- `Local-CGPT-Linux-x64.deb`;
- `SHA256SUMS.txt`; and
- `M0-LINUX-SOURCE.txt` with the exact source commit.

Do not substitute an upstream release, an older local-cgpt artifact, or a Windows/macOS build.

Verify the checksum, source revision and hardened package identity before installation:

```bash
sha256sum -c SHA256SUMS.txt
cat M0-LINUX-SOURCE.txt
dpkg-deb --field Local-CGPT-Linux-x64.deb Package
```

The package field must be exactly `local-cgpt`.

The source SHA must match the PR #1 revision approved for testing.

## 3. Install the Debian candidate

```bash
sudo apt install ./Local-CGPT-Linux-x64.deb
```

The package declares `bubblewrap` as a runtime dependency. Confirm it is present:

```bash
bwrap --version
```

## 4. Use disposable data for the first run

Create a new empty test workspace containing no personal documents, SSH keys, browser data, password stores, cloud credentials, production repositories or other sensitive material.

On first launch, verify that:

- no model-facing capability is enabled;
- read-only mode is enabled;
- session recording is disabled;
- automatic compaction is disabled;
- multi-agent mode is disabled; and
- Goal mode is disabled.

Approve only that disposable workspace. Do not approve your home directory, filesystem root or a broad parent directory.

## 5. Increase authority gradually

For the first connection, enable only the minimum read capability needed to prove the MCP connection works.

Only after that succeeds should you enable command execution. Keep the workspace disposable and confirm commands cannot read outside the approved root or reach the network.

Do not enable session recording, Goal mode, worker/multi-agent features or the companion Chrome extension during the first security smoke. Those add separate privacy surfaces and are not needed to prove the core Linux sandbox boundary.

## 6. Stop conditions

Stop testing and report the result if any of these occur:

- the normal-user sandbox verification fails;
- the installed package does not have Bubblewrap available;
- a command can read a file outside the approved root;
- a command has host network access;
- any capability/data-expanding feature is enabled unexpectedly on a fresh configuration; or
- the artifact source SHA/checksum does not match the reviewed candidate.

Do not work around a failed security check by adding `sudo`, disabling the sandbox, broadening the approved root or sharing the host network.

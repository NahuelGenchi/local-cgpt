# Project-scoped autonomous engineering

`pokeming-world-autonomous` is an explicit repository profile for long Linux engineering loops. It changes lifecycle policy only inside an already-approved root. A repository marker is intent, **not authority**: normal local-cgpt root and capability settings remain the grant.

## Pokeming World setup

1. In local-cgpt, approve `~/Documents/projects/pokeming-world` as a root named `pokeming-world`.
2. Keep read-only mode off. Enable the project capabilities needed for engineering: browse/search/read/metadata, create/edit/move/delete-file, command, and network. Network remains off inside Bubblewrap unless both the global network capability and the profile marker below allow it.
3. Enable **Record sessions**, **Automatic Compact & Resume**, **Goal Mode**, and **Multi-agent mode**. For a long unattended job, set the chat Goal to the concrete task. Goal Mode requires its configured OpenRouter key; Compact & Resume itself does not.
4. For substantial parallel work, raise the multi-agent maximum deliberately (up to the app's bounded maximum of 8). The conservative default remains 2 because higher ChatGPT concurrency has previously triggered rate limiting.
5. Create `.local/local-cgpt/profile.json` inside Pokeming World:

```json
{
  "version": 1,
  "profile": "pokeming-world-autonomous",
  "network": true,
  "persistentProcesses": true,
  "persistentHome": true,
  "maxLogBytes": 67108864
}
```

Pokeming World already ignores `/.local/`. Do not commit this marker, task checkpoints, process logs, ROMs, saves, captures, translated private code/objects, addresses/offsets/selectors, credentials, or other private oracle material.

The first autonomous command creates `.local/local-cgpt/task.json` with mode 0600. The model should fill and maintain its bounded fields: original goal, plan, completed/outstanding steps, decisions, Git branch/HEAD/status, worker assignments/results, persistent process ids, validation, blockers, and continuation instructions. The app maintains a separate privacy-safe durable runtime ledger in its own user-data directory. The repository checkpoint can never grant capabilities or process ownership.

## Long-running processes

Ordinary projects retain the Codex-compatible five-minute background-terminal lease. In this profile, non-TTY commands use the persistent supervisor instead: process identity and ownership are persisted with Linux `/proc` start-time fingerprints, output is retained only up to the configured cap, and an app restart can reconnect to the same session id when the process still exists.

Use non-TTY mode for reconnectable debugger/server processes. `write_stdin` polls the session; Ctrl-C is forwarded as SIGINT. Explicit termination is bounded and escalates from SIGTERM to SIGKILL. Persistent project processes are preserved across normal app shutdown only while the same profile and command authority remain active; revoking the profile/capability makes shutdown clean them up.

The profile can bind localhost ports because its explicit network projection uses the sandbox's own network namespace choice. It does not expose a listener publicly by itself; bind development services to loopback unless the project explicitly requires otherwise.

## Continuation model

There are two different lifetimes:

- **Browser/model lease:** one ChatGPT turn, worker turn, or Compact & Resume delivery may have bounded transport deadlines.
- **Engineering task:** the project checkpoint, recorded session, Git/worktree, durable worker history and persistent-process registry outlive those individual leases.

When a turn ends before the task is complete, Goal Mode supplies the next user turn. When recorded context approaches the configured compaction threshold, Automatic Compact & Resume moves the recorded session, Goal objective, process ownership and swarm prime binding to a fresh ChatGPT conversation. The task file is the project-private machine-state checkpoint a fresh context can re-read instead of reconstructing the job from prose.

Before a long validation/debug phase, and before reporting completion, update `.local/local-cgpt/task.json`. A completed task sets `completed: true`, has no outstanding steps/blockers, and records the exact validation actually run.

## Git and GitHub

Use ordinary Git inside the approved repository for local branches, commits, rebases and merges. For authenticated github.com operations, prefer local-cgpt's `local_github` transport (sync, non-force push, PR/issue create/update) or the separately authorized ChatGPT GitHub connector. The shell environment deliberately does not inherit arbitrary host credentials.

`local_github` intentionally has no force-push and no PR-merge action. A merge remains a cloud-side repository operation and should be performed through the authorized GitHub connector only after exact-head gates pass. This is a security boundary, not a runtime timeout.

## Privacy

Persistent process metadata records ids, virtual cwd, timestamps, bounded output size and conversation ownership; it does not persist model command text. The autonomous runtime ledger likewise stores no source snippets or private oracle values. Detailed checkpoint content stays under the approved project's ignored `.local/` tree.

Do not paste private Pokeming material into issue/PR bodies, public logs or CI output. Private oracle/debugger tools may consume local ROM-derived state, but public evidence must be reduced to safe PASS/failure summaries and non-proprietary diagnostics.

## Diagnostics

The runtime ledger uses explicit reason codes instead of a generic "tool execution ended": `TASK_ACTIVE`, `PROCESS_YIELDED`, `PROCESS_EXITED`, `PROCESS_INTERRUPTED`, `CHECKPOINT_INVALID`, `PROFILE_REVOKED`, and `TASK_COMPLETED`. A yielded process is not a stopped task: `continuationQueued` remains true and the process id remains attached to the durable task record.

Hard limits remain bounded for safety: command output/result payloads, retained background logs, worker concurrency, provider request timeouts, browser command delivery leases, and the underlying ChatGPT context window. The task itself has no fixed wall-clock deadline in the autonomous profile.

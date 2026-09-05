# Project-scoped autonomous engineering

`pokeming-world-autonomous` is an explicit repository profile for long Linux engineering loops. It changes lifecycle policy only inside an already-approved root. A repository marker is intent, **not authority**: normal local-cgpt root and capability settings remain the grant.

## Pokeming World setup

1. In local-cgpt, approve `~/Documents/projects/pokeming-world` as a root named `pokeming-world`.
2. Keep read-only mode off. Enable the project capabilities needed for engineering: browse/search/read/metadata, create/edit/move/delete-file, command, network, and **Project autonomy**. The Project autonomy capability is the app-owned grant; the repository marker below cannot turn it on. Network remains off inside Bubblewrap unless both the global network capability and the marker allow it.
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

Pokeming World already ignores `/.local/`. Do not commit this marker, task checkpoints, ROMs, saves, captures, translated private code/objects, addresses/offsets/selectors, credentials, or other private oracle material. Persistent process logs and control FIFOs live in local-cgpt's private user-data directory, not in the repository.

The first autonomous command creates `.local/local-cgpt/task.json` with mode 0600. The active model instructions require the agent to maintain its bounded fields: original goal, plan, completed/outstanding steps, decisions, virtual Git worktree/branch/HEAD/status, worker assignments/results, persistent process ids, validation, blockers, and continuation instructions. The app maintains a separate privacy-safe durable runtime ledger in its own user-data directory. The repository checkpoint can never grant capabilities or process ownership.

## Long-running processes

Ordinary projects retain the Codex-compatible five-minute background-terminal lease. In this profile, non-TTY commands use the persistent supervisor instead: process identity and ownership are persisted with Linux `/proc` start-time fingerprints, output is retained only up to the configured cap, and an app restart can reconnect to the same session id when the process still exists. A production persistent launch also resolves the exact ChatGPT conversation before spawn; the first durable process row already contains that owner. If exact request evidence is unavailable, no persistent command starts.

Use non-TTY mode for reconnectable debugger/server processes. `write_stdin` can poll or send bounded text to the app-private FIFO; Ctrl-C is forwarded as SIGINT. Pipe-friendly clients such as GDB/MI are therefore suitable for reconnectable debugger control. Explicit termination validates the detached wrapper's `/proc` start-time and process-group identity before signaling the whole supervised process tree; it sends SIGTERM, waits a bounded grace period, then re-proves that same group before escalating to SIGKILL. This prevents ordinary child/grandchild processes from being orphaned while retaining stale-PID protection. A command that deliberately daemonizes into a different session/process group is outside that supervised tree and should not be used for autonomous debugger/server jobs. Persistent project processes are preserved across normal app shutdown only while the same profile and command authority remain active; revoking the profile/capability makes shutdown clean them up.

Autonomous lifetime is deliberately not an excuse for unbounded process creation. Ordinary and persistent sessions share the existing unified-exec ceiling of 64 live processes. Dead durable rows do not consume that live-process allowance, while their ids remain reserved until reconciliation so a restarted app cannot accidentally attach old ownership to a recycled session id.

The profile can bind localhost ports because its explicit network projection uses the sandbox's network-namespace choice. It does not expose a listener publicly by itself; bind development services such as melonDS's GDB stub to loopback unless the project explicitly requires otherwise.

## Continuation model

There are two different lifetimes:

- **Browser/model lease:** one ChatGPT turn, worker turn, or Compact & Resume delivery may have bounded transport deadlines.
- **Engineering task:** the project checkpoint, recorded session, Git/worktree, durable worker history and persistent-process registry outlive those individual leases.

When a turn ends before the task is complete, Goal Mode supplies the next user turn. When recorded context approaches the configured compaction threshold, Automatic Compact & Resume moves the recorded session, Goal objective, process ownership and swarm prime binding to a fresh ChatGPT conversation. The task file is the project-private machine-state checkpoint a fresh context can re-read instead of reconstructing the job from prose.

Persistent process ownership follows the app-owned committed Compact & Resume continuation record, not the writable project checkpoint. If an app restart lands between the durable A→B continuation commit and an in-memory owner projection, the replacement chat can repair ownership only when the committed continuation chain unambiguously proves that exact successor and every relevant handoff is newer than the process. Ambiguous, historical, anonymous, or unrelated callers fail closed.

Before a long validation/debug phase, after important worker/Git/process changes, before a rollover, and before reporting completion, update `.local/local-cgpt/task.json`. A completed task sets `completed: true`, has no outstanding steps or blockers, has no live persistent process attached, and records the exact validation actually run. Only that internally consistent state is reconciled to runtime reason `TASK_COMPLETED`; setting the flag alone does not make active work disappear. Because the checkpoint is untrusted project data, this reconciliation can only narrow/stop continuation—it cannot grant a capability, adopt a process, or widen the filesystem/network sandbox. Any later command moves the runtime back to an active/process state.

## Git and GitHub

Use ordinary Git inside the approved repository for local branches, commits, rebases and merges. For authenticated github.com operations, prefer local-cgpt's `local_github` transport (sync, non-force push, PR/issue create/update) or the separately authorized ChatGPT GitHub connector. The shell environment deliberately does not inherit arbitrary host credentials.

`local_github` intentionally has no force-push and no PR-merge action. A merge remains a cloud-side repository operation and should be performed through the authorized GitHub connector only after exact-head gates pass. This is a security boundary, not a runtime timeout.

## Privacy

Persistent process metadata records ids, virtual cwd, timestamps, bounded output size and conversation ownership; it does not persist model command text. The autonomous runtime ledger likewise stores no source snippets, command text, native home paths or private oracle values. Detailed checkpoint content stays under the approved project's ignored `.local/` tree.

Do not paste private Pokeming material into issue/PR bodies, public logs or CI output. Private oracle/debugger tools may consume local ROM-derived state, but public evidence must be reduced to safe PASS/failure summaries and non-proprietary diagnostics.

## Diagnostics and recovery

The runtime ledger uses explicit reason codes instead of a generic "tool execution ended": `TASK_ACTIVE`, `PROCESS_YIELDED`, `PROCESS_EXITED`, `PROCESS_INTERRUPTED`, `CHECKPOINT_INVALID`, `PROFILE_REVOKED`, and `TASK_COMPLETED`. Its privacy-safe diagnostic record also exposes checkpoint validity/time, whether continuation remains queued, active process session ids and last exit code. A yielded process is not a stopped task: `continuationQueued` remains true and the process id remains attached to the durable task record.

`CALLER_IDENTITY_REQUIRED` is different from those task/process reasons. It is a fail-closed authorization result: local-cgpt could not prove which ChatGPT conversation made a call while a worker or workspace identity boundary mattered, so it ran nothing. Do not work around it by relaxing worker isolation. Restore the browser-extension identity path/reload the affected ChatGPT page and retry; the durable task, checkpoint and persistent process registry remain intact while identity is repaired.

Hard limits remain bounded for safety: individual output/result payloads, retained background logs, a 64 KiB `write_stdin` payload, 64 live ordinary+persistent exec sessions, worker concurrency, provider request timeouts, browser command delivery leases, and the underlying ChatGPT context window. The task itself has no fixed wall-clock deadline in the autonomous profile.

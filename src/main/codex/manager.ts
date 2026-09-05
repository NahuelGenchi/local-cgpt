/**
 * The one process-manager facade for this app.
 *
 * Ordinary calls retain the Codex-derived in-memory manager exactly as before. A project that
 * explicitly opts into the autonomous profile may additionally project its already-granted
 * network/persistent-HOME policy into Bubblewrap, and non-TTY jobs may move to the restart-
 * resilient project supervisor. Keeping the switch here is intentional: tools-core.ts still has
 * one exec contract, one ownership layer and one model-visible surface.
 */

import nodePath from 'node:path';
import { ensureAutonomousTask, noteAutonomousExecResult } from '../autonomous-task.js';
import { getConfig } from '../config.js';
import { currentCall } from '../mcp/call-context.js';
import {
  projectAutonomyForVirtualCwd,
  applyProjectAutonomyToLaunch,
  type ProjectAutonomyPolicy
} from '../project-autonomy.js';
import { awaitFreshCallOrigin, evidenceWindow } from '../session/recorder.js';
import type { TruncationPolicy } from './truncate.js';
import {
  DEFAULT_MAX_BACKGROUND_TERMINAL_TIMEOUT_MS,
  DEFAULT_MAX_OUTPUT_TOKENS,
  MAX_UNIFIED_EXEC_PROCESSES,
  UNIFIED_EXEC_OUTPUT_MAX_TOKENS
} from './unified-exec-constants.js';
import {
  UnifiedExecError,
  UnifiedExecProcessManager,
  type BackgroundTerminalInfo,
  type ExecCommandRequest,
  type ExecCommandToolOutput,
  type WriteStdinRequest
} from './unified-exec.js';
import {
  persistentExecDiagnostics,
  persistentProjectProcesses,
  persistentSessionIds
} from './persistent-exec.js';

/** Match the exact-request evidence window used by the MCP identity boundary without importing kernel.ts. */
const AUTONOMOUS_OWNER_EVIDENCE_MS = evidenceWindow(15_000);

/**
 * Resolve the exact ChatGPT conversation before a restart-resilient process exists.
 *
 * Ordinary exec deliberately does not wait for browser attribution. Persistent autonomous exec is
 * different: its process can outlive this app process, so allowing it to exist before ownership is
 * known creates a crash window in which a live session can be restored as anonymous. Production
 * MCP calls therefore fail closed before spawn when their exact request id cannot be joined to one
 * conversation. Direct/internal tests have no call context and may still exercise the supervisor
 * with a null owner explicitly.
 */
async function autonomousOwnerForCurrentCall(): Promise<string | null> {
  const call = currentCall();
  if (!call) return null;
  let owner = call.caller.conversationId;
  if (!owner && call.caller.requestId) {
    owner = await awaitFreshCallOrigin('exec_command', call.startedAt, AUTONOMOUS_OWNER_EVIDENCE_MS, {
      requestId: call.caller.requestId
    });
    if (owner) call.caller.conversationId = owner;
  }
  return owner;
}

function insidePath(parent: string, child: string): boolean {
  const relative = nodePath.relative(parent, child);
  return relative === '' ||
    (!relative.startsWith(`..${nodePath.sep}`) && relative !== '..' && !nodePath.isAbsolute(relative));
}

function policyFingerprint(policy: ProjectAutonomyPolicy): string {
  return JSON.stringify([
    policy.profile,
    policy.rootName,
    nodePath.resolve(policy.rootPath),
    policy.virtualRoot,
    policy.allowNetwork,
    policy.persistentProcesses,
    policy.persistentHome,
    policy.maxLogBytes
  ]);
}

/**
 * Writable host roots encoded in the already-built production Bubblewrap argv.
 *
 * command-sandbox places approved writable roots before `--chdir` and uses `--bind source source`.
 * Stop there so a user's command containing the literal string `--bind` cannot be mistaken for
 * sandbox authority. Any other writable-bind shape fails closed rather than being guessed at.
 */
function writableSandboxRoots(command: readonly string[]): string[] | null {
  const chdir = command.indexOf('--chdir');
  if (chdir < 0) return null;
  const roots: string[] = [];
  for (let index = 0; index + 2 < chdir; index += 1) {
    if (command[index] !== '--bind') continue;
    const source = command[index + 1];
    const destination = command[index + 2];
    if (!source || !destination || source !== destination || !nodePath.isAbsolute(source)) return null;
    roots.push(nodePath.resolve(source));
    index += 2;
  }
  return [...new Set(roots)].sort();
}

/**
 * Prove that an argv built immediately before entering the manager still represents current
 * authority after an asynchronous caller-identity proof.
 *
 * The identity wait can last seconds. During it the user may revoke Command/Project autonomy,
 * remove an approved root, or the project may narrow its marker policy. We therefore re-resolve
 * the policy and compare the writable Bubblewrap mounts against the *live* approved roots before
 * spawn. Nested roots are allowed to be covered by an approved parent mount, matching
 * command-sandbox's `uniqueRoots` behavior. A stale extra mount is always rejected.
 *
 * This function is exported only for deterministic regression tests; it grants no authority.
 */
export function autonomousLaunchStillAuthorized(
  command: readonly string[],
  displayCwd: string,
  initialPolicy: ProjectAutonomyPolicy
): ProjectAutonomyPolicy | null {
  const refreshed = projectAutonomyForVirtualCwd(displayCwd);
  if (!refreshed || policyFingerprint(refreshed) !== policyFingerprint(initialPolicy)) return null;

  const mounted = writableSandboxRoots(command);
  if (!mounted) return null;
  const configured = [...new Set(getConfig().roots.map((root) => nodePath.resolve(root.path)))];

  // Every writable bind must still be an approved root. Conversely, every currently configured
  // root must be covered by one of those binds; command-sandbox deliberately coalesces nested roots
  // beneath their approved parent, so exact one-to-one equality would reject a legitimate shape.
  if (!mounted.every((root) => configured.includes(root))) return null;
  if (!configured.every((root) => mounted.some((parent) => insidePath(parent, root)))) return null;
  return refreshed;
}

/**
 * Autonomous lifetime may be unbounded; concurrent host process count may not be.
 *
 * Keep the same reviewed ceiling the Codex-derived manager already enforces instead of giving the
 * persistent backend a second independent allowance. The caller supplies *live* counts, not
 * durable registry-row counts, so a naturally exited process awaiting reconciliation cannot pin
 * capacity forever after a restart.
 */
export function atUnifiedExecProcessLimit(ordinaryCount: number, persistentCount: number): boolean {
  return ordinaryCount + persistentCount >= MAX_UNIFIED_EXEC_PROCESSES;
}

class LocalExecProcessManager {
  private readonly ordinary = new UnifiedExecProcessManager(DEFAULT_MAX_BACKGROUND_TERMINAL_TIMEOUT_MS);

  /** Allocate against both process registries so an app restart cannot recycle a durable id. */
  allocateProcessId(): number {
    for (let attempt = 0; attempt < MAX_UNIFIED_EXEC_PROCESSES * 4; attempt += 1) {
      const processId = this.ordinary.allocateProcessId();
      if (!persistentSessionIds().has(processId)) return processId;
      this.ordinary.releaseProcessId(processId);
    }
    throw UnifiedExecError.createProcess('could not allocate a unique process id across persistent sessions');
  }

  releaseProcessId(processId: number): void {
    this.ordinary.releaseProcessId(processId);
  }

  private atLiveProcessLimit(): boolean {
    // Count every /proc-proven live persistent row, including a process whose project
    // root/profile/capability was revoked after launch: revocation hides it from the model-facing
    // list but it still consumes a real host process until shutdown cleanup.
    const persistentLive = persistentExecDiagnostics().filter((process) => process.running).length;
    return atUnifiedExecProcessLimit(this.ordinary.listProcesses().length, persistentLive);
  }

  private releaseAndThrow(processId: number, message: string): never {
    this.ordinary.releaseProcessId(processId);
    throw UnifiedExecError.createProcess(message);
  }

  async execCommand(request: ExecCommandRequest): Promise<ExecCommandToolOutput> {
    // tools-core reserves an ordinary id before this facade knows which backend will own it. Apply
    // one global live-process ceiling before selecting ordinary vs persistent execution.
    if (this.atLiveProcessLimit()) {
      this.releaseAndThrow(
        request.processId,
        `process limit reached (${MAX_UNIFIED_EXEC_PROCESSES} live sessions across ordinary and autonomous execution)`
      );
    }

    const policy = projectAutonomyForVirtualCwd(request.displayCwd);
    if (!policy) return this.ordinary.execCommand(request);

    // Creating/validating the project-private checkpoint happens before launch. If the checkpoint
    // is malformed the app-owned runtime ledger records that explicitly, but a writable project
    // file never becomes an authority source and therefore cannot widen the execution grant.
    ensureAutonomousTask(policy);

    const persistent = policy.persistentProcesses && !request.tty;
    let output: ExecCommandToolOutput;
    let effectivePolicy = policy;
    if (!persistent) {
      const command = applyProjectAutonomyToLaunch(request.command, policy, { surviveParent: false });
      output = await this.ordinary.execCommand({ ...request, command });
    } else {
      // A restart-resilient process must never be spawned first and attributed later. The initial
      // durable supervisor row includes this exact owner, eliminating the crash interval in which
      // the app could otherwise restore a live process as an anonymous session.
      const call = currentCall();
      const ownerConversationId = await autonomousOwnerForCurrentCall();
      if (call && !ownerConversationId) {
        this.releaseAndThrow(
          request.processId,
          'CALLER_IDENTITY_REQUIRED: persistent autonomous execution needs this ChatGPT conversation to be proven before the process starts. Restore the extension identity path and retry; no command was run.'
        );
      }

      // Identity proof is intentionally asynchronous, so all launch authority is checked again
      // afterwards. A permission/root/profile change during the wait invalidates the prebuilt
      // Bubblewrap argv; retrying rebuilds it from current settings instead of launching a stale
      // writable mount or stale network grant.
      const refreshed = autonomousLaunchStillAuthorized(request.command, request.displayCwd, policy);
      if (!refreshed) {
        this.releaseAndThrow(
          request.processId,
          'PROJECT_AUTHORITY_CHANGED: Project autonomy permissions, approved roots, or profile changed while caller identity was being proven. Retry the command so the sandbox is rebuilt from current authority; no command was run.'
        );
      }
      effectivePolicy = refreshed;

      // The process ceiling is also live authority/resource state. Another request may have filled
      // the remaining slot while this call waited for browser identity evidence.
      if (this.atLiveProcessLimit()) {
        this.releaseAndThrow(
          request.processId,
          `process limit reached (${MAX_UNIFIED_EXEC_PROCESSES} live sessions across ordinary and autonomous execution)`
        );
      }

      // Apply the project projection only after the post-wait authority check. The call into the
      // supervisor executes synchronously through spawn() before its first await, so app settings
      // cannot interleave between this proof and process creation on the main event loop.
      const command = applyProjectAutonomyToLaunch(request.command, refreshed, { surviveParent: true });
      const projected = { ...request, command };

      // The ordinary allocator reserved this id before tools-core knew which backend would own it.
      // Transfer that reservation only after owner proof and all live launch checks succeed.
      this.ordinary.releaseProcessId(request.processId);
      output = await persistentProjectProcesses.execCommand(projected, refreshed, ownerConversationId);
    }
    noteAutonomousExecResult(effectivePolicy, output);
    return output;
  }

  async writeStdin(request: WriteStdinRequest): Promise<ExecCommandToolOutput> {
    if (persistentProjectProcesses.hasPersistedSession(request.processId)) {
      return persistentProjectProcesses.writeStdin(request);
    }
    return this.ordinary.writeStdin(request);
  }

  listProcesses(): BackgroundTerminalInfo[] {
    return [...this.ordinary.listProcesses(), ...persistentProjectProcesses.listProcesses()].sort(
      (left, right) => left.processId - right.processId
    );
  }

  async terminateProcess(processId: number): Promise<boolean> {
    if (persistentProjectProcesses.hasPersistedSession(processId)) {
      return persistentProjectProcesses.terminateProcess(processId);
    }
    return this.ordinary.terminateProcess(processId);
  }

  async terminateAllProcesses(): Promise<void> {
    // Normal sessions are process-lifetime resources. Explicit autonomous sessions are preserved
    // only while their project profile and command authority are still live; the persistent
    // supervisor terminates revoked/inactive rows itself.
    await Promise.all([this.ordinary.terminateAllProcesses(), persistentProjectProcesses.shutdown()]);
  }
}

export const unifiedExecManager = new LocalExecProcessManager();

/**
 * The budget for output the model was given no way to ask about.
 *
 * `formatExecOutputForModel` takes a policy and nothing else, so for the intercepted `apply_patch`
 * path this value *is* the whole budget rather than a ceiling over a request. It is therefore the
 * advertised default, stated in the same unit the contract is written in.
 */
export const DEFAULT_TRUNCATION_POLICY: TruncationPolicy = { kind: 'tokens', tokens: DEFAULT_MAX_OUTPUT_TOKENS };

/**
 * The ceiling for the tools that *do* take `max_output_tokens`, which is a different job.
 *
 * `modelOutputMaxTokens` is `min(max_output_tokens ?? DEFAULT_MAX_OUTPUT_TOKENS, policyTokenBudget(policy))`.
 * Two limits meet in that expression and only one of them is the default: `resolveMaxTokens`
 * supplies the 10_000-token default when the caller omitted a budget, and the policy is the safety
 * ceiling over whatever the caller did ask for. Setting the policy to the default collapses both
 * roles into one and makes every explicit request above 10_000 inert — the same class of bug, one
 * order of magnitude up, as the `{ kind: 'bytes', bytes: 10_000 }` policy that made the real ceiling
 * 2_500 tokens while `MAX_OUTPUT_TOKENS_DESCRIPTION` promised the model 10_000.
 *
 * So the ceiling is the largest output that can physically reach here: `HeadTailBuffer` stops
 * collecting at `UNIFIED_EXEC_OUTPUT_MAX_BYTES` (1 MiB), and `UNIFIED_EXEC_OUTPUT_MAX_TOKENS` is
 * that same cap expressed in the truncator's four-bytes-per-token estimate. `min(request, policy)`
 * is preserved exactly: omitted yields 10_000 tokens, an explicit 30_000 yields 30_000, and an
 * absurd request is bounded by a limit the collection buffer has already enforced in bytes.
 *
 * The policy here is therefore not a second default. It is the collection ceiling, in tokens.
 */
export const EXEC_OUTPUT_CEILING_POLICY: TruncationPolicy = {
  kind: 'tokens',
  tokens: UNIFIED_EXEC_OUTPUT_MAX_TOKENS
};

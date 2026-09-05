/**
 * The one process-manager facade for this app.
 *
 * Ordinary calls retain the Codex-derived in-memory manager exactly as before. A project that
 * explicitly opts into the autonomous profile may additionally project its already-granted
 * network/persistent-HOME policy into Bubblewrap, and non-TTY jobs may move to the restart-
 * resilient project supervisor. Keeping the switch here is intentional: tools-core.ts still has
 * one exec contract, one ownership layer and one model-visible surface.
 */

import { ensureAutonomousTask, noteAutonomousExecResult } from '../autonomous-task.js';
import { currentCall } from '../mcp/call-context.js';
import { projectAutonomyForVirtualCwd, applyProjectAutonomyToLaunch } from '../project-autonomy.js';
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
import { persistentProjectProcesses, persistentSessionIds } from './persistent-exec.js';

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

  async execCommand(request: ExecCommandRequest): Promise<ExecCommandToolOutput> {
    // tools-core reserves an ordinary id before this facade knows which backend will own it. Apply
    // the one global live-process ceiling before selecting ordinary vs persistent execution so a
    // large autonomous workload cannot be bypassed merely by launching a command from an ordinary
    // project (or vice versa).
    if (atUnifiedExecProcessLimit(
      this.ordinary.listProcesses().length,
      persistentProjectProcesses.listProcesses().length
    )) {
      this.ordinary.releaseProcessId(request.processId);
      throw UnifiedExecError.createProcess(
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
    const command = applyProjectAutonomyToLaunch(request.command, policy, { surviveParent: persistent });
    const projected = { ...request, command };
    let output: ExecCommandToolOutput;
    if (!persistent) {
      output = await this.ordinary.execCommand(projected);
    } else {
      // A restart-resilient process must never be spawned first and attributed later. The initial
      // durable supervisor row includes this exact owner, eliminating the crash interval in which
      // the app could otherwise restore a live process as an anonymous session.
      const call = currentCall();
      const ownerConversationId = await autonomousOwnerForCurrentCall();
      if (call && !ownerConversationId) {
        this.ordinary.releaseProcessId(request.processId);
        throw UnifiedExecError.createProcess(
          'CALLER_IDENTITY_REQUIRED: persistent autonomous execution needs this ChatGPT conversation to be proven before the process starts. Restore the extension identity path and retry; no command was run.'
        );
      }

      // The ordinary allocator reserved this id before tools-core knew which backend would own it.
      // Transfer that reservation only after the profile/sandbox projection and owner proof have
      // succeeded.
      this.ordinary.releaseProcessId(request.processId);
      output = await persistentProjectProcesses.execCommand(projected, policy, ownerConversationId);
    }
    noteAutonomousExecResult(policy, output);
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
 */
export const EXEC_OUTPUT_CEILING_POLICY: TruncationPolicy = {
  kind: 'tokens',
  tokens: UNIFIED_EXEC_OUTPUT_MAX_TOKENS
};

/**
 * The one process-manager facade for this app.
 *
 * Ordinary calls retain the Codex-derived in-memory manager exactly as before. A project that
 * explicitly opts into the autonomous profile may additionally project its already-granted
 * network/persistent-HOME policy into Bubblewrap, and non-TTY jobs may move to the restart-
 * resilient project supervisor. Keeping the switch here is intentional: tools-core.ts still has
 * one exec contract, one ownership layer and one model-visible surface.
 */

import { projectAutonomyForVirtualCwd, applyProjectAutonomyToLaunch } from '../project-autonomy.js';
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
    const policy = projectAutonomyForVirtualCwd(request.displayCwd);
    if (!policy) return this.ordinary.execCommand(request);

    const persistent = policy.persistentProcesses && !request.tty;
    const command = applyProjectAutonomyToLaunch(request.command, policy, { surviveParent: persistent });
    const projected = { ...request, command };
    if (!persistent) return this.ordinary.execCommand(projected);

    // The ordinary allocator reserved this id before tools-core knew which backend would own it.
    // Transfer that reservation only after the profile/sandbox projection has succeeded.
    this.ordinary.releaseProcessId(request.processId);
    return persistentProjectProcesses.execCommand(projected, policy);
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

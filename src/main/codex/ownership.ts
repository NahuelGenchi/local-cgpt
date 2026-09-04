/**
 * Which ChatGPT conversation owns a live `exec_command` session.
 *
 * Ordinary Codex-parity sessions are process-memory handles and keep the existing in-memory
 * ownership registry. Explicit autonomous project sessions can outlive this Electron process,
 * so their owner is stored with the app-owned persistent-process snapshot instead. Project files
 * never participate in this authorization decision.
 */

import { requestCorrelation } from '../session/correlation.js';
import {
  forgetPersistentExecOwner,
  movePersistentExecOwners,
  notePersistentExecOwner,
  persistentExecOwner
} from './persistent-exec.js';

/** Owners for ordinary in-memory sessions, keyed by the process id returned as `session_id`. */
const owners = new Map<number, string | null>();

/**
 * The conversation behind an in-flight MCP request, when it is already proven.
 *
 * Never waits. The correlation registry resolves a request id the moment the page reports the
 * matching connector request, and everything here degrades to "unknown" rather than blocking a
 * command on browser evidence.
 */
export function provenConversation(requestId: string | null, conversationId: string | null): string | null {
  if (conversationId) return conversationId;
  return requestCorrelation(requestId)?.conversationId ?? null;
}

/** Records the conversation that opened a still-running exec session. */
export function noteExecOwner(processId: number | null, conversationId: string | null): void {
  if (processId === null) return;
  if (notePersistentExecOwner(processId, conversationId)) {
    owners.delete(processId);
    return;
  }
  owners.set(processId, conversationId);
}

/** Drops a session's owner once it can no longer be written to. */
export function forgetExecOwner(processId: number | null): void {
  if (processId === null) return;
  owners.delete(processId);
  forgetPersistentExecOwner(processId);
}

/** The conversation that opened this session, or null when it was never proven. */
export function execOwner(processId: number): string | null {
  const persistent = persistentExecOwner(processId);
  if (persistent !== undefined) return persistent;
  return owners.get(processId) ?? null;
}

/**
 * Whether `conversationId` may write to `processId`.
 *
 * Proven sessions require the same proven caller. Anonymous sessions can only be continued by
 * anonymous callers; they are never adoptable by a later identified conversation. A process
 * with no registry entry at all is refused. Persistent autonomous sessions obey the same rule,
 * with the owner coming from app-owned durable state after a restart.
 */
export function execOwnershipDenied(processId: number, conversationId: string | null): boolean {
  const persistent = persistentExecOwner(processId);
  if (persistent !== undefined) {
    if (persistent === null) return conversationId !== null;
    if (!conversationId) return true;
    return persistent !== conversationId;
  }
  if (!owners.has(processId)) return true;
  const owner = owners.get(processId);
  if (owner === null) return conversationId !== null;
  if (!conversationId) return true;
  return owner !== conversationId;
}

/**
 * Moves live process authority with a proven Compact & Resume chat A→B transition.
 *
 * Autonomous process ownership is updated in the same publish step as ordinary process ownership;
 * its snapshot is app-owned and durable, so a later app restart resolves the replacement chat as
 * the only writer. Anonymous sessions and other conversations are untouched.
 */
export function moveExecConversationOwners(fromConversationId: string, toConversationId: string): number {
  if (!fromConversationId || !toConversationId || fromConversationId === toConversationId) return 0;
  let moved = movePersistentExecOwners(fromConversationId, toConversationId);
  for (const [processId, owner] of owners) {
    if (owner !== fromConversationId) continue;
    owners.set(processId, toConversationId);
    moved += 1;
  }
  return moved;
}

/** Test seam: the ordinary registry is process-global state with no natural lifetime boundary. */
export function resetExecOwnershipForTests(): void {
  owners.clear();
}

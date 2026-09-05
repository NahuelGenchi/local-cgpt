/**
 * Which ChatGPT conversation owns a live `exec_command` session.
 *
 * Ordinary Codex-parity sessions are process-memory handles and keep the existing in-memory
 * ownership registry. Explicit autonomous project sessions can outlive this Electron process,
 * so their owner is stored with the app-owned persistent-process snapshot instead. Project files
 * never participate in this authorization decision.
 */

import { durableStoreReady, readDurableSync } from '../durable.js';
import { requestCorrelation } from '../session/correlation.js';
import { CONTINUATIONS_STATE, type ContinuationSnapshot } from '../session/continuation.js';
import {
  PERSISTENT_EXEC_STATE,
  forgetPersistentExecOwner,
  movePersistentExecOwners,
  notePersistentExecOwner,
  persistentExecOwner,
  type PersistentExecSnapshot
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
 * Start time from the app-owned durable process record.
 *
 * The process supervisor makes this record durable before returning the first session id, so it
 * is a stronger boundary than model/project checkpoint data. We need only the timestamp here: it
 * prevents an old A→B continuation from being replayed as authority for a new process that a user
 * later starts after returning to chat A.
 */
function persistentStartedAt(processId: number): number | null {
  if (!durableStoreReady()) return null;
  const snapshot = readDurableSync<PersistentExecSnapshot>(PERSISTENT_EXEC_STATE);
  if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.records)) return null;
  const row = snapshot.records.find((record) => record.sessionId === processId);
  return row && Number.isSafeInteger(row.startedAt) && row.startedAt > 0 ? row.startedAt : null;
}

/**
 * Whether the durable Compact & Resume WAL proves `from` became `to` after this process began.
 *
 * This is deliberately stricter than "find any old handoff involving these chats". Only committed
 * continuations count, every edge must be newer than the process, and each hop must have exactly
 * one successor. A reused conversation with two possible descendants is ambiguous and therefore
 * cannot adopt process authority. The short hop cap is a corruption/runaway guard, not a task
 * lifetime: a process can survive many app restarts; it just cannot require an unbounded graph
 * walk in an authorization check.
 */
function committedContinuationTransfers(from: string, to: string, notBefore: number): boolean {
  if (!durableStoreReady()) return false;
  const snapshot = readDurableSync<ContinuationSnapshot>(CONTINUATIONS_STATE);
  if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.entries)) return false;

  let current = from;
  const seen = new Set<string>();
  for (let hop = 0; hop < 32; hop += 1) {
    if (current === to) return true;
    if (seen.has(current)) return false;
    seen.add(current);

    const successors = new Set<string>();
    for (const entry of snapshot.entries) {
      if (
        entry.state !== 'committed' ||
        entry.from !== current ||
        typeof entry.to !== 'string' ||
        entry.to.length === 0 ||
        !Number.isSafeInteger(entry.openedAt) ||
        entry.openedAt < notBefore
      ) continue;
      successors.add(entry.to);
    }
    if (successors.size !== 1) return false;
    current = [...successors][0]!;
  }
  return current === to;
}

/**
 * Whether `conversationId` may write to `processId`.
 *
 * Proven sessions require the same proven caller. Anonymous sessions can only be continued by
 * anonymous callers; they are never adoptable by a later identified conversation. A process
 * with no registry entry at all is refused. Persistent autonomous sessions obey the same rule,
 * with one recovery path: if the app's durable continuation WAL proves that the process owner's
 * exact chat was committed through Compact & Resume into this exact proven caller after the
 * process started, ownership is repaired lazily and durably. This covers app restart between the
 * session rebind and its in-memory projections without making a project file or timing heuristic
 * an authority source.
 */
export function execOwnershipDenied(processId: number, conversationId: string | null): boolean {
  const persistent = persistentExecOwner(processId);
  if (persistent !== undefined) {
    if (persistent === null) return conversationId !== null;
    if (!conversationId) return true;
    if (persistent === conversationId) return false;

    const startedAt = persistentStartedAt(processId);
    if (
      startedAt !== null &&
      committedContinuationTransfers(persistent, conversationId, startedAt) &&
      notePersistentExecOwner(processId, conversationId)
    ) {
      return false;
    }
    return true;
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
 * This is the eager projection used when the caller already has the committed transition in
 * hand. `execOwnershipDenied` independently repairs from the durable WAL if an app restart or
 * crash lands between that commit and this in-memory projection. Anonymous sessions and other
 * conversations are untouched.
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

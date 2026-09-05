import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execOwnershipDenied, resetExecOwnershipForTests } from '../src/main/codex/ownership.js';
import {
  PERSISTENT_EXEC_STATE,
  persistentExecOwner,
  resetPersistentExecForTests,
  restorePersistentExec,
  type PersistentExecRecord,
  type PersistentExecSnapshot
} from '../src/main/codex/persistent-exec.js';
import { initDurableStore, resetDurableForTests, writeDurableNow } from '../src/main/durable.js';
import { CONTINUATIONS_STATE, type ContinuationSnapshot } from '../src/main/session/continuation.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let stateDir: string;

function processRecord(sessionId: number, startedAt: number): PersistentExecRecord {
  return {
    version: 1,
    sessionId,
    rootName: 'workspace',
    pid: 99_999,
    startTicks: '1',
    childPid: null,
    childStartTicks: null,
    startedAt,
    displayCwd: '/workspace',
    readOffset: 0,
    capNoticeDelivered: false,
    maxLogBytes: 1024 * 1024,
    ownerConversationId: 'chat-a'
  };
}

function continuation(
  token: string,
  from: string,
  to: string,
  openedAt: number
): ContinuationSnapshot['entries'][number] {
  return {
    token,
    sessionId: `session-${token}`,
    from,
    to,
    openedAt,
    state: 'committed',
    summary: '',
    handoffId: null,
    claimedBy: to,
    armed: true,
    error: null
  };
}

async function install(process: PersistentExecRecord, entries: ContinuationSnapshot['entries']): Promise<void> {
  const processes: PersistentExecSnapshot = { version: 1, savedAt: Date.now(), records: [process] };
  await writeDurableNow(PERSISTENT_EXEC_STATE, processes);
  await writeDurableNow(CONTINUATIONS_STATE, { version: 1, savedAt: Date.now(), entries });
  restorePersistentExec(processes);
}

beforeEach(async () => {
  stateDir = await makeTempDir('local-cgpt-persistent-owner-');
  initDurableStore(stateDir);
  resetPersistentExecForTests();
  resetExecOwnershipForTests();
});

afterEach(async () => {
  resetPersistentExecForTests();
  resetExecOwnershipForTests();
  resetDurableForTests();
  await removeTempDir(stateDir);
});

describe('persistent exec ownership across Compact & Resume', () => {
  it('repairs an exact proven successor from the committed continuation WAL', async () => {
    await install(processRecord(33_333, 1_000), [continuation('a-to-b', 'chat-a', 'chat-b', 2_000)]);

    expect(execOwnershipDenied(33_333, 'chat-b')).toBe(false);
    expect(persistentExecOwner(33_333)).toBe('chat-b');
    expect(execOwnershipDenied(33_333, 'chat-c')).toBe(true);
  });

  it('follows an unambiguous chain of committed replacements', async () => {
    await install(processRecord(33_334, 1_000), [
      continuation('a-to-b', 'chat-a', 'chat-b', 2_000),
      continuation('b-to-c', 'chat-b', 'chat-c', 3_000)
    ]);

    expect(execOwnershipDenied(33_334, 'chat-c')).toBe(false);
    expect(persistentExecOwner(33_334)).toBe('chat-c');
  });

  it('does not replay a continuation that predates the process', async () => {
    await install(processRecord(33_335, 5_000), [continuation('old-a-to-b', 'chat-a', 'chat-b', 4_000)]);

    expect(execOwnershipDenied(33_335, 'chat-b')).toBe(true);
    expect(persistentExecOwner(33_335)).toBe('chat-a');
  });

  it('fails closed when a reused source conversation has ambiguous successors', async () => {
    await install(processRecord(33_336, 1_000), [
      continuation('a-to-b', 'chat-a', 'chat-b', 2_000),
      continuation('a-to-c', 'chat-a', 'chat-c', 3_000)
    ]);

    expect(execOwnershipDenied(33_336, 'chat-b')).toBe(true);
    expect(execOwnershipDenied(33_336, 'chat-c')).toBe(true);
    expect(persistentExecOwner(33_336)).toBe('chat-a');
  });
});

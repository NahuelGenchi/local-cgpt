import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  flushDurable,
  initDurableStore,
  resetDurableForTests
} from '../src/main/durable.js';
import { atUnifiedExecProcessLimit } from '../src/main/codex/manager.js';
import { MAX_UNIFIED_EXEC_PROCESSES } from '../src/main/codex/unified-exec-constants.js';
import {
  PERSISTENT_EXEC_STATE,
  forgetPersistentExecOwner,
  movePersistentExecOwners,
  notePersistentExecOwner,
  persistentExecOwner,
  persistentSessionIds,
  resetPersistentExecForTests,
  restorePersistentExec,
  type PersistentExecSnapshot
} from '../src/main/codex/persistent-exec.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let dir: string;

function snapshot(owner: string | null = null): PersistentExecSnapshot {
  return {
    version: 1,
    savedAt: Date.now(),
    records: [{
      version: 1,
      sessionId: 4242,
      rootName: 'pokeming-world',
      pid: 999_999,
      startTicks: '123456',
      childPid: null,
      childStartTicks: null,
      startedAt: Date.now(),
      displayCwd: '/pokeming-world',
      readOffset: 0,
      capNoticeDelivered: false,
      maxLogBytes: 64 * 1024 * 1024,
      ownerConversationId: owner
    }]
  };
}

beforeEach(async () => {
  dir = await makeTempDir('local-cgpt-persistent-exec-');
  initDurableStore(dir);
  restorePersistentExec(snapshot());
});

afterEach(async () => {
  resetPersistentExecForTests();
  resetDurableForTests();
  await removeTempDir(dir);
});

describe('persistent autonomous process state', () => {
  it('persists ownership in app durable state and restores it lazily after a restart', async () => {
    expect(notePersistentExecOwner(4242, 'conversation-a')).toBe(true);
    await flushDurable();

    const stored = JSON.parse(await fs.readFile(path.join(dir, 'state', `${PERSISTENT_EXEC_STATE}.json`), 'utf8'));
    expect(stored.records[0].ownerConversationId).toBe('conversation-a');

    resetPersistentExecForTests();
    expect(persistentExecOwner(4242)).toBe('conversation-a');
    expect(persistentSessionIds()).toEqual(new Set([4242]));
  });

  it('moves a persisted owner during Compact & Resume publication', async () => {
    notePersistentExecOwner(4242, 'conversation-a');
    expect(movePersistentExecOwners('conversation-a', 'conversation-b')).toBe(1);
    await flushDurable();

    resetPersistentExecForTests();
    expect(persistentExecOwner(4242)).toBe('conversation-b');
  });

  it('fails closed when a durable snapshot row has an invalid PID fingerprint shape', async () => {
    await fs.mkdir(path.join(dir, 'state'), { recursive: true });
    const invalid = snapshot('conversation-a') as any;
    invalid.records[0].startTicks = '../../not-a-kernel-tick';
    await fs.writeFile(path.join(dir, 'state', `${PERSISTENT_EXEC_STATE}.json`), JSON.stringify(invalid), 'utf8');

    resetPersistentExecForTests();
    expect(persistentExecOwner(4242)).toBeUndefined();
    expect(persistentSessionIds().size).toBe(0);
  });

  it('does not leave a durable owner after explicit forget', async () => {
    notePersistentExecOwner(4242, 'conversation-a');
    forgetPersistentExecOwner(4242);
    await flushDurable();

    resetPersistentExecForTests();
    expect(persistentExecOwner(4242)).toBeNull();
  });

  it('shares the existing unified-exec process ceiling with autonomous sessions', () => {
    expect(atUnifiedExecProcessLimit(MAX_UNIFIED_EXEC_PROCESSES - 1, 0)).toBe(false);
    expect(atUnifiedExecProcessLimit(MAX_UNIFIED_EXEC_PROCESSES - 1, 1)).toBe(true);
    expect(atUnifiedExecProcessLimit(0, MAX_UNIFIED_EXEC_PROCESSES)).toBe(true);
  });
});

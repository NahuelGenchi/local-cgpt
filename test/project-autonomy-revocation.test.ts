import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  autonomousRuntimeForRoot,
  ensureAutonomousTask,
  noteAutonomousExecResult,
  resetAutonomousTasksForTests
} from '../src/main/autonomous-task.js';
import { unifiedExecManager } from '../src/main/codex/manager.js';
import {
  persistentExecOwner,
  persistentProjectProcesses,
  resetPersistentExecForTests
} from '../src/main/codex/persistent-exec.js';
import type { ExecCommandRequest } from '../src/main/codex/unified-exec.js';
import {
  defaultConfig,
  initConfigPath,
  saveConfig,
  setProjectAutonomyRevocationHook,
  updateConfig
} from '../src/main/config.js';
import { initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import {
  POKEMING_AUTONOMY_PROFILE,
  PROJECT_AUTONOMY_MARKER,
  projectAutonomyForVirtualCwd
} from '../src/main/project-autonomy.js';
import { makeTempDir, removeTempDir } from './helpers.js';

const PROCESS_ID = 34_321;
const truncationPolicy = { kind: 'tokens' as const, tokens: 10_000 };
let stateDir: string;
let projectDir: string;

function request(): ExecCommandRequest {
  return {
    command: ['/bin/sh', '-c', 'sleep 30'],
    shellType: 'bash',
    hookCommand: '',
    processId: PROCESS_ID,
    yieldTimeMs: 250,
    maxOutputTokens: 10_000,
    truncationPolicy,
    cwd: '/',
    displayCwd: '/project',
    env: {},
    tty: false
  };
}

beforeEach(async () => {
  if (process.platform !== 'linux') return;
  stateDir = await makeTempDir('local-cgpt-autonomy-revoke-state-');
  projectDir = await makeTempDir('local-cgpt-autonomy-revoke-project-');
  initConfigPath(stateDir);
  initDurableStore(stateDir);
  setProjectAutonomyRevocationHook(null);

  const marker = path.join(projectDir, PROJECT_AUTONOMY_MARKER);
  await fs.mkdir(path.dirname(marker), { recursive: true });
  await fs.writeFile(marker, JSON.stringify({
    version: 1,
    profile: POKEMING_AUTONOMY_PROFILE,
    network: true,
    persistentProcesses: true
  }), 'utf8');

  const base = defaultConfig();
  await saveConfig({
    ...base,
    readOnly: false,
    roots: [{ name: 'project', path: projectDir }],
    capabilities: {
      ...base.capabilities,
      command: true,
      network: true,
      projectAutonomy: true
    }
  });
});

afterEach(async () => {
  if (process.platform !== 'linux') return;
  setProjectAutonomyRevocationHook(null);
  try { await persistentProjectProcesses.terminateProcess(PROCESS_ID); } catch { /* best effort */ }
  resetPersistentExecForTests();
  resetAutonomousTasksForTests();
  resetDurableForTests();
  await removeTempDir(stateDir);
  await removeTempDir(projectDir);
});

describe.skipIf(process.platform !== 'linux')('project autonomy live revocation', () => {
  it('terminates a live persistent process before a network revocation reports success', async () => {
    const policy = projectAutonomyForVirtualCwd('/project');
    expect(policy?.allowNetwork).toBe(true);
    ensureAutonomousTask(policy!);

    const started = await persistentProjectProcesses.execCommand(request(), policy!, 'conversation-revoke');
    expect(started.processId).toBe(PROCESS_ID);
    noteAutonomousExecResult(policy!, started);
    expect(persistentExecOwner(PROCESS_ID)).toBe('conversation-revoke');

    setProjectAutonomyRevocationHook(() => unifiedExecManager.revokePersistentProjectProcesses());
    await updateConfig((config) => ({
      ...config,
      capabilities: { ...config.capabilities, network: false }
    }));

    expect(persistentExecOwner(PROCESS_ID)).toBeUndefined();
    expect(autonomousRuntimeForRoot('project')?.activeProcessIds).toEqual([]);
    expect(autonomousRuntimeForRoot('project')?.lastStopReason).toBe('PROFILE_REVOKED');
  }, 10_000);
});

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  autonomousRuntimeForRoot,
  ensureAutonomousTask,
  noteAutonomousExecResult,
  readAutonomousCheckpoint,
  resetAutonomousTasksForTests
} from '../src/main/autonomous-task.js';
import { flushDurable, initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import type { ProjectAutonomyPolicy } from '../src/main/project-autonomy.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let stateDir: string;
let rootDir: string;
let policy: ProjectAutonomyPolicy;

beforeEach(async () => {
  stateDir = await makeTempDir('local-cgpt-autonomous-task-state-');
  rootDir = await makeTempDir('local-cgpt-autonomous-task-root-');
  initDurableStore(stateDir);
  policy = {
    profile: 'pokeming-world-autonomous',
    rootName: 'pokeming-world',
    rootPath: rootDir,
    virtualRoot: '/pokeming-world',
    projectStateDir: path.join(rootDir, '.local', 'local-cgpt'),
    homeDir: path.join(rootDir, '.local', 'local-cgpt', 'home'),
    taskPath: path.join(rootDir, '.local', 'local-cgpt', 'task.json'),
    allowNetwork: true,
    persistentProcesses: true,
    persistentHome: true,
    maxLogBytes: 64 * 1024 * 1024
  };
});

afterEach(async () => {
  resetAutonomousTasksForTests();
  resetDurableForTests();
  await removeTempDir(stateDir);
  await removeTempDir(rootDir);
});

describe('autonomous task checkpoint state', () => {
  it('creates a private project checkpoint and a privacy-safe durable runtime ledger', async () => {
    const task = ensureAutonomousTask(policy);
    expect(task.rootName).toBe('pokeming-world');
    expect(task.checkpointValid).toBe(true);

    const checkpoint = readAutonomousCheckpoint(policy);
    expect(checkpoint?.taskId).toBe(task.taskId);
    expect(checkpoint?.project).toBe('/pokeming-world');
    expect(checkpoint?.git.worktree).toBe('/pokeming-world');

    const stat = await fs.stat(policy.taskPath);
    expect(stat.mode & 0o077).toBe(0);
  });

  it('survives a simulated app restart and records a yielded background process', async () => {
    const first = ensureAutonomousTask(policy);
    noteAutonomousExecResult(policy, {
      chunkId: 'abc123',
      wallTimeMs: 250,
      rawOutput: Buffer.from('ready\n'),
      truncationPolicy: { kind: 'tokens', tokens: 10_000 },
      maxOutputTokens: 10_000,
      processId: 4242,
      exitCode: null,
      originalTokenCount: null,
      outputOmittedBytes: null
    });
    await flushDurable();

    resetAutonomousTasksForTests();
    const restored = autonomousRuntimeForRoot('pokeming-world');
    expect(restored?.taskId).toBe(first.taskId);
    expect(restored?.activeProcessIds).toEqual([4242]);
    expect(restored?.lastStopReason).toBe('PROCESS_YIELDED');
    expect(restored?.continuationQueued).toBe(true);
  });

  it('treats the project checkpoint as untrusted data and rejects path disclosure or symlinks', async () => {
    const task = ensureAutonomousTask(policy);
    const checkpoint = readAutonomousCheckpoint(policy)!;
    await fs.writeFile(
      policy.taskPath,
      JSON.stringify({ ...checkpoint, taskId: task.taskId, git: { ...checkpoint.git, worktree: '/home/user/private' } }),
      'utf8'
    );
    expect(readAutonomousCheckpoint(policy)).toBeNull();

    const target = path.join(rootDir, 'task-target.json');
    await fs.writeFile(target, JSON.stringify(checkpoint), 'utf8');
    await fs.rm(policy.taskPath, { force: true });
    await fs.symlink(target, policy.taskPath);
    expect(readAutonomousCheckpoint(policy)).toBeNull();
  });
});

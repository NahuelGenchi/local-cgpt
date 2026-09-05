import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  autonomousRuntimeForRoot,
  ensureAutonomousTask,
  noteAutonomousExecResult,
  readAutonomousCheckpoint,
  resetAutonomousTasksForTests
} from '../src/main/autonomous-task.js';
import { persistentProjectProcesses, resetPersistentExecForTests } from '../src/main/codex/persistent-exec.js';
import type { ExecCommandRequest, WriteStdinRequest } from '../src/main/codex/unified-exec.js';
import { defaultConfig, getConfig, setConfigForTests } from '../src/main/config.js';
import { flushDurable, initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import {
  POKEMING_AUTONOMY_PROFILE,
  PROJECT_AUTONOMY_MARKER,
  projectAutonomyForVirtualCwd
} from '../src/main/project-autonomy.js';
import { makeTempDir, removeTempDir } from './helpers.js';

const PROCESS_ID = 33_333;
const truncationPolicy = { kind: 'tokens' as const, tokens: 10_000 };
let stateDir: string;
let projectDir: string;

function execRequest(): ExecCommandRequest {
  return {
    command: [
      '/bin/sh',
      '-c',
      "printf 'READY\\n'; IFS= read -r first; printf 'FIRST:%s\\n' \"$first\"; IFS= read -r second; printf 'SECOND:%s\\n' \"$second\"; sleep 30"
    ],
    shellType: 'bash',
    hookCommand: '',
    processId: PROCESS_ID,
    yieldTimeMs: 250,
    maxOutputTokens: 10_000,
    truncationPolicy,
    cwd: '/',
    displayCwd: '/pokeming-world',
    env: {},
    tty: false
  };
}
function stdinRequest(input: string): WriteStdinRequest {
  return {
    processId: PROCESS_ID,
    input,
    yieldTimeMs: 250,
    maxOutputTokens: 10_000,
    truncationPolicy
  };
}

async function sendAndCollect(input: string, expected: string, prefix = ''): Promise<string> {
  let text = prefix;
  let nextInput = input;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const result = await persistentProjectProcesses.writeStdin(stdinRequest(nextInput));
    text += result.rawOutput.toString('utf8');
    if (text.includes(expected)) return text;
    // Input is sent exactly once. Empty calls are ordinary status/output polls and return as soon
    // as more output arrives; this is the same contract a debugger client uses after reconnect.
    nextInput = '';
  }
  return text;
}

function installAutonomyConfig(): void {
  const config = defaultConfig();
  setConfigForTests({
    ...config,
    roots: [{ name: 'pokeming-world', path: projectDir }],
    readOnly: false,
    capabilities: {
      ...config.capabilities,
      command: true,
      network: true,
      projectAutonomy: true
    }
  });
}

beforeAll(async () => {
  if (process.platform !== 'linux') return;
  stateDir = await makeTempDir('local-cgpt-pokeming-acceptance-state-');
  projectDir = await makeTempDir('local-cgpt-pokeming-acceptance-project-');
  initDurableStore(stateDir);

  const marker = path.join(projectDir, PROJECT_AUTONOMY_MARKER);
  await fs.mkdir(path.dirname(marker), { recursive: true });
  // Use the canonical minimum profile declaration. Network, persistent process supervision,
  // persistent HOME and the bounded default log cap all default on inside this profile, but only
  // after the independent app-owned capability gates below allow them.
  await fs.writeFile(marker, JSON.stringify({
    version: 1,
    profile: POKEMING_AUTONOMY_PROFILE
  }), 'utf8');
});

afterAll(async () => {
  if (process.platform !== 'linux') return;
  try { await persistentProjectProcesses.terminateProcess(PROCESS_ID); } catch { /* best-effort test cleanup */ }
  resetPersistentExecForTests();
  resetAutonomousTasksForTests();
  resetDurableForTests();
  await removeTempDir(stateDir);
  await removeTempDir(projectDir);
});

describe.skipIf(process.platform !== 'linux')('Pokeming autonomous M20-shaped acceptance', () => {
  it('survives a runtime rollover with process control, worker findings and Git state intact', async () => {
    // Runtime acceptance owns its exact authority snapshot. Config persistence/root-admission have
    // their own tests; sharing config.ts process-global mutation queues with unrelated Vitest files
    // made this test depend on whichever settings test happened to finish last.
    installAutonomyConfig();
    expect(process.platform).toBe('linux');
    const live = getConfig();
    expect(live.readOnly).toBe(false);
    expect(live.capabilities.command).toBe(true);
    expect(live.capabilities.network).toBe(true);
    expect(live.capabilities.projectAutonomy).toBe(true);
    expect(live.roots).toContainEqual({ name: 'pokeming-world', path: projectDir });

    const marker = path.join(projectDir, PROJECT_AUTONOMY_MARKER);
    const markerStat = await fs.lstat(marker);
    expect(markerStat.isFile()).toBe(true);
    expect(markerStat.isSymbolicLink()).toBe(false);
    expect(await fs.realpath(projectDir)).toBe(projectDir);
    expect(await fs.realpath(marker)).toBe(marker);
    expect(JSON.parse(await fs.readFile(marker, 'utf8'))).toEqual({
      version: 1,
      profile: POKEMING_AUTONOMY_PROFILE
    });

    const policy = projectAutonomyForVirtualCwd('/pokeming-world');
    expect(policy?.profile).toBe(POKEMING_AUTONOMY_PROFILE);
    const task = ensureAutonomousTask(policy!);

    // Populate only synthetic/private-safe progress. Three worker findings exercise the checkpoint
    // shape used by the prime after parallel investigations without invoking browser/model workers
    // from the deterministic CI test process.
    const checkpoint = readAutonomousCheckpoint(policy!)!;
    await fs.writeFile(policy!.taskPath, `${JSON.stringify({
      ...checkpoint,
      originalGoal: 'Synthetic M20 parity loop',
      currentPlan: ['build', 'start oracle', 'compare', 'fix', 'rerun'],
      completedSteps: ['repository state inspected'],
      outstandingSteps: ['compare synthetic oracle', 'finish validation'],
      git: {
        worktree: '/pokeming-world-worktree',
        branch: 'work/synthetic-m20',
        head: '0123456789abcdef0123456789abcdef01234567',
        status: ' M synthetic-safe-file.txt'
      },
      workers: [
        { id: 'worker-a', assignment: 'inspect build', status: 'done', result: 'build finding retained' },
        { id: 'worker-b', assignment: 'inspect debugger', status: 'done', result: 'debugger finding retained' },
        { id: 'worker-c', assignment: 'inspect parity harness', status: 'done', result: 'parity finding retained' }
      ],
      checkpointAt: Date.now()
    }, null, 2)}\n`, 'utf8');

    const started = await persistentProjectProcesses.execCommand(execRequest(), policy!);
    noteAutonomousExecResult(policy!, started);
    expect(started.processId).toBe(PROCESS_ID);
    await flushDurable();

    // Artificial application/model rollover: drop every in-memory registry while leaving the
    // detached process, private runtime files and durable JSON on disk. A restarted app would
    // also reload the same persisted config, so reinstall that already-proven authority snapshot.
    resetPersistentExecForTests();
    resetAutonomousTasksForTests();
    installAutonomyConfig();

    const restoredTask = autonomousRuntimeForRoot('pokeming-world');
    expect(restoredTask?.taskId).toBe(task.taskId);
    expect(restoredTask?.activeProcessIds).toEqual([PROCESS_ID]);
    expect(restoredTask?.continuationQueued).toBe(true);
    const restoredCheckpoint = readAutonomousCheckpoint(policy!);
    expect(restoredCheckpoint?.git.branch).toBe('work/synthetic-m20');
    expect(restoredCheckpoint?.git.head).toBe('0123456789abcdef0123456789abcdef01234567');
    expect(restoredCheckpoint?.workers).toHaveLength(3);
    expect(restoredCheckpoint?.workers.map((worker) => worker.result)).toEqual([
      'build finding retained', 'debugger finding retained', 'parity finding retained'
    ]);

    const firstText = await sendAndCollect(
      'continue-one\n',
      'FIRST:continue-one',
      started.rawOutput.toString('utf8')
    );
    expect(firstText).toContain('READY');
    expect(firstText).toContain('FIRST:continue-one');

    const secondText = await sendAndCollect('continue-two\n', 'SECOND:continue-two');
    expect(secondText).toContain('SECOND:continue-two');

    expect(await persistentProjectProcesses.terminateProcess(PROCESS_ID)).toBe(true);
    expect(autonomousRuntimeForRoot('pokeming-world')?.activeProcessIds).toEqual([]);
    expect(autonomousRuntimeForRoot('pokeming-world')?.lastStopReason).toBe('PROCESS_INTERRUPTED');
  }, 25_000);
});

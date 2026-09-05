import { execFile } from 'node:child_process';
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
import {
  persistentExecOwner,
  persistentProjectProcesses,
  resetPersistentExecForTests
} from '../src/main/codex/persistent-exec.js';
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
let workspaceDir: string;
let repositoryDir: string;
let projectDir: string;

function runFile(file: string, args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { cwd, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(error, { stdout, stderr }));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function git(args: string[], cwd = projectDir): Promise<string> {
  const { stdout } = await runFile('git', args, cwd);
  return stdout.trim();
}

async function processStillRunning(pid: number): Promise<boolean> {
  try {
    const text = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
    const close = text.lastIndexOf(')');
    if (close < 0) return false;
    const state = text.slice(close + 1).trim().split(/\s+/, 1)[0];
    return state !== 'Z';
  } catch {
    return false;
  }
}

async function waitForProcessStopped(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (!(await processStillRunning(pid))) return true;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  return !(await processStillRunning(pid));
}

function execRequest(): ExecCommandRequest {
  return {
    command: [
      '/bin/sh',
      '-c',
      "printf 'READY\\n'; IFS= read -r first; printf 'FIRST:%s\\n' \"$first\"; IFS= read -r second; printf 'SECOND:%s\\n' \"$second\"; sleep 30 & sleeper=$!; printf 'SLEEPER:%s\\n' \"$sleeper\"; wait \"$sleeper\""
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
  workspaceDir = await makeTempDir('local-cgpt-pokeming-acceptance-workspace-');
  repositoryDir = path.join(workspaceDir, 'repository');
  projectDir = path.join(workspaceDir, 'worktree');
  await fs.mkdir(path.join(repositoryDir, 'src'), { recursive: true });
  initDurableStore(stateDir);

  // A real clean Git repository/worktree is part of the acceptance. The synthetic build uses only
  // the installed Node runtime and never touches the network or proprietary inputs.
  await runFile('git', ['init', '--initial-branch=main'], repositoryDir);
  await runFile('git', ['config', 'user.name', 'local-cgpt synthetic acceptance'], repositoryDir);
  await runFile('git', ['config', 'user.email', 'synthetic@local-cgpt.invalid'], repositoryDir);
  await fs.writeFile(path.join(repositoryDir, '.gitignore'), '/.local/\n/dist/\n', 'utf8');
  await fs.writeFile(path.join(repositoryDir, 'src', 'input.txt'), 'seed\n', 'utf8');
  await fs.writeFile(path.join(repositoryDir, 'build.mjs'), [
    "import { mkdir, readFile, writeFile } from 'node:fs/promises';",
    "const input = (await readFile('src/input.txt', 'utf8')).trim();",
    "await mkdir('dist', { recursive: true });",
    "await writeFile('dist/result.txt', `built:${input}\\n`, 'utf8');",
    ''
  ].join('\n'), 'utf8');
  await fs.writeFile(path.join(repositoryDir, 'synthetic.test.mjs'), [
    "import assert from 'node:assert/strict';",
    "import { readFile } from 'node:fs/promises';",
    "import test from 'node:test';",
    "test('synthetic build output', async () => {",
    "  assert.equal(await readFile('dist/result.txt', 'utf8'), 'built:seed\\n');",
    "});",
    ''
  ].join('\n'), 'utf8');
  await runFile('git', ['add', '.'], repositoryDir);
  await runFile('git', ['commit', '-m', 'synthetic baseline'], repositoryDir);
  await runFile('git', ['worktree', 'add', '-b', 'work/synthetic-m20', projectDir, 'HEAD'], repositoryDir);

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
  await removeTempDir(workspaceDir);
});

describe.skipIf(process.platform !== 'linux')('Pokeming autonomous M20-shaped acceptance', () => {
  it('survives a runtime rollover with process control, workers, build/test and Git state intact', async () => {
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

    // Prove the selected worktree is clean, then run a real offline build and test inside it. The
    // generated artifact is ignored, matching the real Pokeming rule that private/generated state
    // must not become public Git material.
    expect(await git(['status', '--porcelain'])).toBe('');
    await runFile(process.execPath, ['build.mjs'], projectDir);
    const testRun = await runFile(process.execPath, ['--test', 'synthetic.test.mjs'], projectDir);
    expect(testRun.stdout).toContain('pass 1');
    const gitBranch = await git(['branch', '--show-current']);
    const gitHead = await git(['rev-parse', 'HEAD']);
    const gitStatus = await git(['status', '--porcelain']);
    expect(gitBranch).toBe('work/synthetic-m20');
    expect(gitHead).toMatch(/^[0-9a-f]{40}$/);
    expect(gitStatus).toBe('');

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
      completedSteps: ['clean worktree selected', 'synthetic build passed', 'synthetic test passed'],
      outstandingSteps: ['compare synthetic oracle', 'finish validation'],
      git: {
        worktree: '/pokeming-world',
        branch: gitBranch,
        head: gitHead,
        status: gitStatus
      },
      workers: [
        { id: 'worker-a', assignment: 'inspect build', status: 'done', result: 'build finding retained' },
        { id: 'worker-b', assignment: 'inspect debugger', status: 'done', result: 'debugger finding retained' },
        { id: 'worker-c', assignment: 'inspect parity harness', status: 'done', result: 'parity finding retained' }
      ],
      validation: [
        { command: 'node build.mjs', status: 'pass', detail: 'synthetic offline build passed' },
        { command: 'node --test synthetic.test.mjs', status: 'pass', detail: 'synthetic offline test passed' }
      ],
      checkpointAt: Date.now()
    }, null, 2)}\n`, 'utf8');

    // The real MCP path proves the owner before spawn. This direct supervisor acceptance supplies
    // that already-proven identity explicitly and then verifies the owner is part of the first
    // durable process row rather than a later best-effort projection.
    const started = await persistentProjectProcesses.execCommand(execRequest(), policy!, 'conversation-a');
    noteAutonomousExecResult(policy!, started);
    expect(started.processId).toBe(PROCESS_ID);
    expect(persistentExecOwner(PROCESS_ID)).toBe('conversation-a');
    await flushDurable();

    // Artificial application/model rollover: drop every in-memory registry while leaving the
    // detached process, private runtime files and durable JSON on disk. A restarted app would
    // also reload the same persisted config, so reinstall that already-proven authority snapshot.
    resetPersistentExecForTests();
    resetAutonomousTasksForTests();
    installAutonomyConfig();
    expect(persistentExecOwner(PROCESS_ID)).toBe('conversation-a');

    const restoredTask = autonomousRuntimeForRoot('pokeming-world');
    expect(restoredTask?.taskId).toBe(task.taskId);
    expect(restoredTask?.activeProcessIds).toEqual([PROCESS_ID]);
    expect(restoredTask?.continuationQueued).toBe(true);
    const restoredCheckpoint = readAutonomousCheckpoint(policy!);
    expect(restoredCheckpoint?.git.branch).toBe(gitBranch);
    expect(restoredCheckpoint?.git.head).toBe(gitHead);
    expect(restoredCheckpoint?.git.status).toBe(gitStatus);
    expect(restoredCheckpoint?.workers).toHaveLength(3);
    expect(restoredCheckpoint?.workers.map((worker) => worker.result)).toEqual([
      'build finding retained', 'debugger finding retained', 'parity finding retained'
    ]);
    expect(restoredCheckpoint?.validation.map((row) => row.status)).toEqual(['pass', 'pass']);

    // The checkpoint is not treated as authority: independently re-read the actual Git worktree
    // after rollover and require it to agree with the retained progress record.
    expect(await git(['branch', '--show-current'])).toBe(gitBranch);
    expect(await git(['rev-parse', 'HEAD'])).toBe(gitHead);
    expect(await git(['status', '--porcelain'])).toBe(gitStatus);

    const firstText = await sendAndCollect(
      'continue-one\n',
      'FIRST:continue-one',
      started.rawOutput.toString('utf8')
    );
    expect(firstText).toContain('READY');
    expect(firstText).toContain('FIRST:continue-one');

    const secondText = await sendAndCollect('continue-two\n', 'SLEEPER:');
    expect(secondText).toContain('SECOND:continue-two');
    const sleeperMatch = secondText.match(/SLEEPER:(\d+)/);
    expect(sleeperMatch).not.toBeNull();
    const sleeperPid = Number(sleeperMatch![1]);
    expect(await processStillRunning(sleeperPid)).toBe(true);

    expect(await persistentProjectProcesses.terminateProcess(PROCESS_ID)).toBe(true);
    expect(await waitForProcessStopped(sleeperPid)).toBe(true);
    expect(autonomousRuntimeForRoot('pokeming-world')?.activeProcessIds).toEqual([]);
    expect(autonomousRuntimeForRoot('pokeming-world')?.lastStopReason).toBe('PROCESS_INTERRUPTED');
  }, 35_000);
});

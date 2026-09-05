import { randomUUID } from 'node:crypto';
import nodeFs from 'node:fs';
import nodePath from 'node:path';
import { durableStoreReady, readDurableSync, writeDurableSoon } from './durable.js';
import { projectAutonomyForVirtualCwd, type ProjectAutonomyPolicy } from './project-autonomy.js';
import type { ExecCommandToolOutput } from './codex/unified-exec.js';

/**
 * App-owned runtime ledger for autonomous engineering tasks. It deliberately stores no command
 * lines, source snippets, ROM-derived values, credentials, native project paths or model output.
 * Detailed progress stays in the project's ignored `.local/local-cgpt/task.json`; that project
 * file is untrusted progress data and is never a capability/ownership source.
 */
export const AUTONOMOUS_TASK_STATE = 'autonomous-tasks';
export const AUTONOMOUS_TASK_VERSION = 1;
export const AUTONOMOUS_TASK_FILE_MAX_BYTES = 256 * 1024;

export type AutonomousStopReason =
  | 'TASK_ACTIVE'
  | 'PROCESS_YIELDED'
  | 'PROCESS_EXITED'
  | 'PROCESS_INTERRUPTED'
  | 'CHECKPOINT_INVALID'
  | 'PROFILE_REVOKED'
  | 'TASK_COMPLETED';

export interface AutonomousRuntimeRecord {
  version: 1;
  taskId: string;
  rootName: string;
  profile: string;
  createdAt: number;
  updatedAt: number;
  checkpointAt: number;
  checkpointValid: boolean;
  continuationQueued: boolean;
  lastStopReason: AutonomousStopReason;
  activeProcessIds: number[];
  lastExitCode: number | null;
}

export interface AutonomousTasksSnapshot {
  version: 1;
  savedAt: number;
  tasks: AutonomousRuntimeRecord[];
}

export interface AutonomousCheckpoint {
  version: 1;
  taskId: string;
  project: string;
  originalGoal: string;
  currentPlan: string[];
  completedSteps: string[];
  outstandingSteps: string[];
  importantDecisions: string[];
  git: { worktree: string; branch: string; head: string; status: string };
  workers: Array<{ id: string; assignment: string; status: string; result: string }>;
  processIds: number[];
  validation: Array<{ command: string; status: 'pass' | 'fail' | 'blocked' | 'not-run'; detail: string }>;
  blockers: string[];
  continuationInstructions: string;
  completed: boolean;
  checkpointAt: number;
}

export interface AutonomousTaskDiagnostic {
  taskId: string;
  rootName: string;
  profile: string;
  activeProcessIds: number[];
  checkpointValid: boolean;
  checkpointAt: number;
  continuationQueued: boolean;
  stopReason: AutonomousStopReason;
  lastExitCode: number | null;
}

const tasks = new Map<string, AutonomousRuntimeRecord>();
let restored = false;

function validTaskId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f-]{20,80}$/i.test(value);
}
function boundedText(value: unknown, max = 32_000): string | null {
  return typeof value === 'string' && value.length <= max ? value : null;
}
function boundedTextArray(value: unknown, maxItems = 200, maxChars = 8_000): string[] | null {
  if (!Array.isArray(value) || value.length > maxItems) return null;
  const out: string[] = [];
  for (const item of value) {
    const text = boundedText(item, maxChars);
    if (text === null) return null;
    out.push(text);
  }
  return out;
}
function validRuntime(raw: unknown): raw is AutonomousRuntimeRecord {
  if (!raw || typeof raw !== 'object') return false;
  const row = raw as Partial<AutonomousRuntimeRecord>;
  const reasons = new Set<AutonomousStopReason>([
    'TASK_ACTIVE','PROCESS_YIELDED','PROCESS_EXITED','PROCESS_INTERRUPTED',
    'CHECKPOINT_INVALID','PROFILE_REVOKED','TASK_COMPLETED'
  ]);
  return (
    row.version === AUTONOMOUS_TASK_VERSION &&
    validTaskId(row.taskId) &&
    typeof row.rootName === 'string' && /^[a-z0-9][a-z0-9._-]{0,31}$/.test(row.rootName) &&
    typeof row.profile === 'string' && row.profile.length <= 100 &&
    Number.isSafeInteger(row.createdAt) && Number.isSafeInteger(row.updatedAt) && Number.isSafeInteger(row.checkpointAt) &&
    typeof row.checkpointValid === 'boolean' && typeof row.continuationQueued === 'boolean' &&
    typeof row.lastStopReason === 'string' && reasons.has(row.lastStopReason as AutonomousStopReason) &&
    Array.isArray(row.activeProcessIds) && row.activeProcessIds.length <= 64 &&
    row.activeProcessIds.every((id) => Number.isInteger(id) && id > 0) &&
    (row.lastExitCode === null || Number.isInteger(row.lastExitCode))
  );
}

function restoreLazy(): void {
  if (restored) return;
  restored = true;
  if (!durableStoreReady()) return;
  const snapshot = readDurableSync<AutonomousTasksSnapshot>(AUTONOMOUS_TASK_STATE);
  if (!snapshot || snapshot.version !== AUTONOMOUS_TASK_VERSION || !Array.isArray(snapshot.tasks)) return;
  for (const raw of snapshot.tasks) {
    if (!validRuntime(raw)) continue;
    tasks.set(raw.rootName, { ...raw, activeProcessIds: [...new Set(raw.activeProcessIds)] });
  }
}
export function snapshotAutonomousTasks(): AutonomousTasksSnapshot {
  restoreLazy();
  return {
    version: AUTONOMOUS_TASK_VERSION,
    savedAt: Date.now(),
    tasks: [...tasks.values()].map((task) => ({ ...task, activeProcessIds: [...task.activeProcessIds] }))
  };
}
function changed(): void { writeDurableSoon(AUTONOMOUS_TASK_STATE, snapshotAutonomousTasks()); }

function safeCheckpointTemplate(policy: ProjectAutonomyPolicy, taskId: string): AutonomousCheckpoint {
  return {
    version: AUTONOMOUS_TASK_VERSION,
    taskId,
    project: `/${policy.rootName}`,
    originalGoal: '',
    currentPlan: [],
    completedSteps: [],
    outstandingSteps: [],
    importantDecisions: [],
    git: { worktree: `/${policy.rootName}`, branch: '', head: '', status: '' },
    workers: [],
    processIds: [],
    validation: [],
    blockers: [],
    continuationInstructions:
      'Resume the recorded user goal from this checkpoint. Re-check Git/process state before mutating anything, then continue outstandingSteps without asking for routine engineering confirmation.',
    completed: false,
    checkpointAt: Date.now()
  };
}
function ensureCheckpointFile(policy: ProjectAutonomyPolicy, taskId: string): boolean {
  try {
    nodeFs.mkdirSync(nodePath.dirname(policy.taskPath), { recursive: true, mode: 0o700 });
    try {
      const stat = nodeFs.lstatSync(policy.taskPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > AUTONOMOUS_TASK_FILE_MAX_BYTES) return false;
      return readAutonomousCheckpoint(policy)?.taskId === taskId;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
    }
    const fd = nodeFs.openSync(policy.taskPath, 'wx', 0o600);
    try {
      nodeFs.writeFileSync(fd, `${JSON.stringify(safeCheckpointTemplate(policy, taskId), null, 2)}\n`, 'utf8');
    } finally {
      nodeFs.closeSync(fd);
    }
    return true;
  } catch {
    return false;
  }
}

function checkpointCompletesTask(task: AutonomousRuntimeRecord, checkpoint: AutonomousCheckpoint): boolean {
  return (
    checkpoint.taskId === task.taskId &&
    checkpoint.completed &&
    checkpoint.outstandingSteps.length === 0 &&
    checkpoint.blockers.length === 0 &&
    task.activeProcessIds.length === 0
  );
}

/**
 * Reconcile only a narrowing state transition from the project checkpoint. The writable checkpoint
 * can never grant authority or adopt a process; at most a valid, internally consistent completed
 * record can tell the privacy-safe runtime ledger that no continuation is queued. A later command
 * immediately returns the ledger to an active/process state.
 */
function reconcileCompletedCheckpoint(task: AutonomousRuntimeRecord, policy?: ProjectAutonomyPolicy): boolean {
  const activePolicy = policy ?? projectAutonomyForVirtualCwd(`/${task.rootName}`);
  if (!activePolicy || activePolicy.rootName !== task.rootName || activePolicy.profile !== task.profile) return false;
  const checkpoint = readAutonomousCheckpoint(activePolicy);
  if (!checkpoint || checkpoint.taskId !== task.taskId || !checkpointCompletesTask(task, checkpoint)) return false;
  task.checkpointValid = true;
  task.checkpointAt = checkpoint.checkpointAt;
  if (task.lastStopReason === 'TASK_COMPLETED' && task.continuationQueued === false) return false;
  task.updatedAt = Date.now();
  task.lastStopReason = 'TASK_COMPLETED';
  task.continuationQueued = false;
  return true;
}

export function ensureAutonomousTask(policy: ProjectAutonomyPolicy): AutonomousRuntimeRecord {
  restoreLazy();
  let task = tasks.get(policy.rootName);
  if (!task || task.profile !== policy.profile) {
    const now = Date.now();
    task = {
      version: AUTONOMOUS_TASK_VERSION,
      taskId: randomUUID(),
      rootName: policy.rootName,
      profile: policy.profile,
      createdAt: now,
      updatedAt: now,
      checkpointAt: now,
      checkpointValid: false,
      continuationQueued: true,
      lastStopReason: 'TASK_ACTIVE',
      activeProcessIds: [],
      lastExitCode: null
    };
    tasks.set(policy.rootName, task);
  }
  const checkpointValid = ensureCheckpointFile(policy, task.taskId);
  task.checkpointValid = checkpointValid;
  task.updatedAt = Date.now();
  task.checkpointAt = task.updatedAt;
  task.continuationQueued = true;
  task.lastStopReason = checkpointValid ? 'TASK_ACTIVE' : 'CHECKPOINT_INVALID';
  reconcileCompletedCheckpoint(task, policy);
  changed();
  return { ...task, activeProcessIds: [...task.activeProcessIds] };
}

export function noteAutonomousExecResult(
  policy: ProjectAutonomyPolicy,
  output: ExecCommandToolOutput
): AutonomousRuntimeRecord {
  ensureAutonomousTask(policy);
  const live = tasks.get(policy.rootName);
  if (!live) throw new Error('autonomous task runtime was not initialized');
  live.updatedAt = Date.now();
  live.checkpointAt = live.updatedAt;
  live.lastExitCode = output.exitCode;
  if (output.processId !== null) {
    live.activeProcessIds = [...new Set([...live.activeProcessIds, output.processId])].slice(-64);
    live.lastStopReason = 'PROCESS_YIELDED';
  } else {
    live.lastStopReason = output.exitCode === 130 ? 'PROCESS_INTERRUPTED' : 'PROCESS_EXITED';
  }
  live.continuationQueued = true;
  changed();
  return { ...live, activeProcessIds: [...live.activeProcessIds] };
}

export function noteAutonomousProcessFinished(rootName: string, processId: number, exitCode: number | null): void {
  restoreLazy();
  const task = tasks.get(rootName);
  if (!task) return;
  task.activeProcessIds = task.activeProcessIds.filter((id) => id !== processId);
  task.lastExitCode = exitCode;
  task.updatedAt = Date.now();
  task.checkpointAt = task.updatedAt;
  task.lastStopReason = exitCode === 130 ? 'PROCESS_INTERRUPTED' : 'PROCESS_EXITED';
  task.continuationQueued = true;
  reconcileCompletedCheckpoint(task);
  changed();
}
export function noteAutonomousProfileRevoked(rootName: string, processId?: number): void {
  restoreLazy();
  const task = tasks.get(rootName);
  if (!task) return;
  if (processId !== undefined) task.activeProcessIds = task.activeProcessIds.filter((id) => id !== processId);
  task.updatedAt = Date.now();
  task.checkpointAt = task.updatedAt;
  task.lastStopReason = 'PROFILE_REVOKED';
  task.continuationQueued = false;
  changed();
}
export function markAutonomousTaskCompleted(rootName: string): boolean {
  restoreLazy();
  const task = tasks.get(rootName);
  if (!task || !reconcileCompletedCheckpoint(task)) return false;
  changed();
  return true;
}
export function autonomousRuntimeForRoot(rootName: string): AutonomousRuntimeRecord | null {
  restoreLazy();
  const task = tasks.get(rootName);
  if (!task) return null;
  if (reconcileCompletedCheckpoint(task)) changed();
  return { ...task, activeProcessIds: [...task.activeProcessIds] };
}
export function autonomousTaskDiagnostics(): AutonomousTaskDiagnostic[] {
  restoreLazy();
  let reconciled = false;
  for (const task of tasks.values()) reconciled = reconcileCompletedCheckpoint(task) || reconciled;
  if (reconciled) changed();
  return [...tasks.values()].map((task) => ({
    taskId: task.taskId,
    rootName: task.rootName,
    profile: task.profile,
    activeProcessIds: [...task.activeProcessIds],
    checkpointValid: task.checkpointValid,
    checkpointAt: task.checkpointAt,
    continuationQueued: task.continuationQueued,
    stopReason: task.lastStopReason,
    lastExitCode: task.lastExitCode
  }));
}

/**
 * Read detailed project checkpoint as untrusted progress data. In particular, native paths are
 * rejected so a model-visible checkpoint cannot accidentally become a home-directory disclosure.
 */
export function readAutonomousCheckpoint(policy: ProjectAutonomyPolicy): AutonomousCheckpoint | null {
  try {
    const stat = nodeFs.lstatSync(policy.taskPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > AUTONOMOUS_TASK_FILE_MAX_BYTES) return null;
    const raw = JSON.parse(nodeFs.readFileSync(policy.taskPath, 'utf8')) as Record<string, unknown>;
    if (!raw || raw['version'] !== AUTONOMOUS_TASK_VERSION || !validTaskId(raw['taskId'])) return null;
    const project = boundedText(raw['project'], 100);
    const originalGoal = boundedText(raw['originalGoal']);
    const currentPlan = boundedTextArray(raw['currentPlan']);
    const completedSteps = boundedTextArray(raw['completedSteps']);
    const outstandingSteps = boundedTextArray(raw['outstandingSteps']);
    const importantDecisions = boundedTextArray(raw['importantDecisions']);
    const blockers = boundedTextArray(raw['blockers']);
    const continuationInstructions = boundedText(raw['continuationInstructions']);
    if (
      project !== `/${policy.rootName}` || originalGoal === null || currentPlan === null || completedSteps === null ||
      outstandingSteps === null || importantDecisions === null || blockers === null || continuationInstructions === null
    ) return null;

    const git = raw['git'];
    if (!git || typeof git !== 'object') return null;
    const gitRow = git as Record<string, unknown>;
    const worktree = boundedText(gitRow['worktree'], 4096);
    const branch = boundedText(gitRow['branch'], 512);
    const head = boundedText(gitRow['head'], 128);
    const status = boundedText(gitRow['status'], 32_000);
    const virtualRoot = `/${policy.rootName}`;
    const worktreeInsideRoot = worktree === virtualRoot || worktree?.startsWith(`${virtualRoot}/`);
    if (
      !worktree || !worktreeInsideRoot || nodePath.posix.normalize(worktree) !== worktree ||
      branch === null || head === null || status === null
    ) return null;

    const processIds = raw['processIds'];
    if (!Array.isArray(processIds) || processIds.length > 64 || !processIds.every((id) => Number.isInteger(id) && (id as number) > 0)) return null;

    const workerRows = raw['workers'];
    if (!Array.isArray(workerRows) || workerRows.length > 64) return null;
    const workers: AutonomousCheckpoint['workers'] = [];
    for (const value of workerRows) {
      if (!value || typeof value !== 'object') return null;
      const row = value as Record<string, unknown>;
      const id = boundedText(row['id'], 100);
      const assignment = boundedText(row['assignment'], 8_000);
      const workerStatus = boundedText(row['status'], 100);
      const result = boundedText(row['result'], 16_000);
      if (id === null || assignment === null || workerStatus === null || result === null) return null;
      workers.push({ id, assignment, status: workerStatus, result });
    }

    const validationRows = raw['validation'];
    if (!Array.isArray(validationRows) || validationRows.length > 200) return null;
    const validation: AutonomousCheckpoint['validation'] = [];
    for (const value of validationRows) {
      if (!value || typeof value !== 'object') return null;
      const row = value as Record<string, unknown>;
      const command = boundedText(row['command'], 8_000);
      const validationStatus = row['status'];
      const detail = boundedText(row['detail'], 16_000);
      if (
        command === null || detail === null ||
        (validationStatus !== 'pass' && validationStatus !== 'fail' && validationStatus !== 'blocked' && validationStatus !== 'not-run')
      ) return null;
      validation.push({ command, status: validationStatus, detail });
    }

    if (typeof raw['completed'] !== 'boolean' || !Number.isSafeInteger(raw['checkpointAt'])) return null;
    return {
      version: AUTONOMOUS_TASK_VERSION,
      taskId: raw['taskId'],
      project,
      originalGoal,
      currentPlan,
      completedSteps,
      outstandingSteps,
      importantDecisions,
      git: { worktree, branch, head, status },
      workers,
      processIds: processIds as number[],
      validation,
      blockers,
      continuationInstructions,
      completed: raw['completed'],
      checkpointAt: raw['checkpointAt'] as number
    };
  } catch {
    return null;
  }
}

export function resetAutonomousTasksForTests(): void {
  tasks.clear();
  restored = false;
}

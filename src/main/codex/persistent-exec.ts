import { spawn } from 'node:child_process';
import nodeFs from 'node:fs';
import nodePath from 'node:path';
import { noteAutonomousProcessFinished } from '../autonomous-task.js';
import { getConfig } from '../config.js';
import {
  durablePrivateDirectory,
  durableStoreReady,
  readDurableSync,
  writeDurableNow,
  writeDurableSoon
} from '../durable.js';
import {
  prepareProjectAutonomyDirectories,
  projectAutonomyForVirtualCwd,
  type ProjectAutonomyPolicy
} from '../project-autonomy.js';
import {
  generateChunkId,
  INTERRUPT,
  MAX_YIELD_TIME_MS,
  MIN_EMPTY_YIELD_TIME_MS,
  MIN_YIELD_TIME_MS,
  UNIFIED_EXEC_OUTPUT_MAX_BYTES
} from './unified-exec-constants.js';
import {
  UnifiedExecError,
  type BackgroundTerminalInfo,
  type ExecCommandRequest,
  type ExecCommandToolOutput,
  type WriteStdinRequest
} from './unified-exec.js';

export const PERSISTENT_EXEC_STATE = 'persistent-exec';
const SNAPSHOT_VERSION = 1;
const POLL_INTERVAL_MS = 100;
const SAFE_DEFAULT_OUTPUT_BYTES = 10_000 * 4;
const MAX_INCREMENTAL_OUTPUT_BYTES = 256 * 1024;
const MAX_STDIN_WRITE_BYTES = 64 * 1024;
const STDIN_WRITE_DEADLINE_MS = 2_000;
const EXIT_FILE_MAX_BYTES = 64;
const CHILD_FILE_MAX_BYTES = 64;
const PRIVATE_RUNTIME_NAME = 'persistent-exec-runtime';

/**
 * Run model argv without interpolating it into shell syntax. The app-private output FIFO is
 * continuously drained through a bounded logger. `head` is deliberately forced unbuffered:
 * coreutils otherwise keeps small FIFO writes in userspace while the producer remains open, which
 * makes a live debugger look silent until it exits or emits a large block. A second app-private
 * FIFO is held open by the wrapper and inherited as the child's stdin, which makes non-TTY
 * debugger/REPL clients reconnectable after a model-context or app-process rollover without
 * exposing the control path to the writable project.
 *
 * The Node parent starts this wrapper detached, making the wrapper PID the process-group id. An
 * explicit TERM is therefore a two-phase operation: the app signals the proven whole group, while
 * this trap keeps the wrapper (the durable /proc identity anchor) alive for a short grace window.
 * If any descendant ignores TERM the app can still re-prove the same group and KILL it without
 * ever signaling a recycled/unrelated process group.
 */
const DETACHED_WRAPPER = `
set -u
umask 077
log=$1
exit_file=$2
child_file=$3
input_fifo=$4
max_bytes=$5
shift 5
output_fifo="${'${log}'}.pipe.$$"
terminating=0
cleanup() { exec 9>&- 2>/dev/null || true; rm -f "$output_fifo" "$input_fifo" "$child_file"; }
trap cleanup EXIT
mkfifo "$output_fifo" "$input_fifo"
{ stdbuf -o0 head -c "$max_bytes"; cat >/dev/null; } <"$output_fifo" >"$log" &
logger=$!
exec 9<>"$input_fifo"
"$@" <&9 >"$output_fifo" 2>&1 &
child=$!
printf '%s\\n' "$child" >"$child_file"
forward_int() { kill -INT "$child" 2>/dev/null || true; }
forward_term() { terminating=1; kill -TERM "$child" 2>/dev/null || true; }
trap forward_int INT
trap forward_term TERM HUP
set +e
while true; do
  wait "$child"
  code=$?
  if kill -0 "$child" 2>/dev/null; then
    continue
  fi
  break
done
if [ "$terminating" -eq 1 ]; then
  sleep 3
fi
exec 9>&-
wait "$logger" 2>/dev/null || true
printf '%s\\n' "$code" >"$exit_file"
exit "$code"
`.trim();

export interface PersistentExecRecord {
  version: 1;
  sessionId: number;
  rootName: string;
  pid: number;
  startTicks: string;
  childPid: number | null;
  childStartTicks: string | null;
  startedAt: number;
  displayCwd: string;
  readOffset: number;
  capNoticeDelivered: boolean;
  maxLogBytes: number;
  ownerConversationId: string | null;
}

export interface PersistentExecSnapshot {
  version: 1;
  savedAt: number;
  records: PersistentExecRecord[];
}

interface LocatedRecord {
  policy: ProjectAutonomyPolicy | null;
  record: PersistentExecRecord;
  logPath: string;
  exitPath: string;
  childPath: string;
  inputPath: string;
}

interface LinuxProcessIdentity {
  startTicks: string;
  processGroupId: number;
  state: string;
}

const records = new Map<number, PersistentExecRecord>();
let restored = false;

function runtimeRoot(): string {
  const directory = durablePrivateDirectory(PRIVATE_RUNTIME_NAME);
  if (!directory) throw new Error('persistent exec runtime is not initialized');
  return directory;
}
function logPath(sessionId: number): string { return nodePath.join(runtimeRoot(), `process-${sessionId}.log`); }
function exitPath(sessionId: number): string { return nodePath.join(runtimeRoot(), `process-${sessionId}.exit`); }
function childPath(sessionId: number): string { return nodePath.join(runtimeRoot(), `process-${sessionId}.child`); }
function inputPath(sessionId: number): string { return nodePath.join(runtimeRoot(), `process-${sessionId}.stdin`); }

function snapshot(): PersistentExecSnapshot {
  return { version: SNAPSHOT_VERSION, savedAt: Date.now(), records: [...records.values()] };
}
function persistSoon(): void { writeDurableSoon(PERSISTENT_EXEC_STATE, snapshot()); }
async function persistNow(): Promise<void> { await writeDurableNow(PERSISTENT_EXEC_STATE, snapshot()); }

function validRecord(raw: unknown): PersistentExecRecord | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const allowed = new Set([
    'version','sessionId','rootName','pid','startTicks','childPid','childStartTicks','startedAt',
    'displayCwd','readOffset','capNoticeDelivered','maxLogBytes','ownerConversationId'
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return null;
  if (
    value.version !== SNAPSHOT_VERSION ||
    typeof value.sessionId !== 'number' || !Number.isSafeInteger(value.sessionId) || value.sessionId < 1_000 || value.sessionId >= 100_000 ||
    typeof value.rootName !== 'string' || !/^[A-Za-z0-9._-]{1,80}$/.test(value.rootName) ||
    typeof value.pid !== 'number' || !Number.isSafeInteger(value.pid) || value.pid <= 1 ||
    typeof value.startTicks !== 'string' || !/^\d+$/.test(value.startTicks) ||
    (value.childPid !== null && (typeof value.childPid !== 'number' || !Number.isSafeInteger(value.childPid) || value.childPid <= 1)) ||
    (value.childStartTicks !== null && (typeof value.childStartTicks !== 'string' || !/^\d+$/.test(value.childStartTicks))) ||
    (value.childPid === null) !== (value.childStartTicks === null) ||
    typeof value.startedAt !== 'number' || !Number.isSafeInteger(value.startedAt) || value.startedAt <= 0 ||
    typeof value.displayCwd !== 'string' ||
    (value.displayCwd !== `/${value.rootName}` && !value.displayCwd.startsWith(`/${value.rootName}/`)) ||
    typeof value.readOffset !== 'number' || !Number.isSafeInteger(value.readOffset) || value.readOffset < 0 ||
    typeof value.capNoticeDelivered !== 'boolean' ||
    typeof value.maxLogBytes !== 'number' || !Number.isSafeInteger(value.maxLogBytes) || value.maxLogBytes < 1024 * 1024 || value.maxLogBytes > 256 * 1024 * 1024 ||
    (value.ownerConversationId !== null && typeof value.ownerConversationId !== 'string')
  ) return null;
  return value as unknown as PersistentExecRecord;
}

export function restorePersistentExec(snapshotInput: PersistentExecSnapshot | null): void {
  records.clear();
  if (snapshotInput && snapshotInput.version === SNAPSHOT_VERSION && Array.isArray(snapshotInput.records)) {
    for (const raw of snapshotInput.records) {
      const record = validRecord(raw);
      if (!record || records.has(record.sessionId)) continue;
      records.set(record.sessionId, record);
    }
  }
  restored = true;
}

/** Authorization lookup is synchronous; first use lazily restores the durable registry. */
function ensureRestored(): void {
  if (restored || !durableStoreReady()) return;
  restorePersistentExec(readDurableSync<PersistentExecSnapshot>(PERSISTENT_EXEC_STATE));
}
function removeIfPresent(file: string): void {
  try { nodeFs.unlinkSync(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
function boundedText(file: string, maxBytes: number): string | null {
  try {
    const stat = nodeFs.statSync(file);
    if (!stat.isFile() || stat.size > maxBytes) return null;
    return nodeFs.readFileSync(file, 'utf8');
  } catch { return null; }
}

/** Linux /proc starttime is stable for one PID lifetime and changes on PID reuse. */
function processIdentity(pid: number): LinuxProcessIdentity | null {
  const text = boundedText(`/proc/${pid}/stat`, 8 * 1024);
  if (text === null) return null;
  const close = text.lastIndexOf(')');
  if (close < 0) return null;
  const fields = text.slice(close + 1).trim().split(/\s+/);
  const state = fields[0];
  const processGroupId = Number(fields[2]);
  const startTicks = fields[19];
  if (!state || !Number.isSafeInteger(processGroupId) || processGroupId <= 1 || !startTicks || !/^\d+$/.test(startTicks)) return null;
  return { state, processGroupId, startTicks };
}
function processStartTicks(pid: number): string | null { return processIdentity(pid)?.startTicks ?? null; }
function sameProcess(pid: number, startTicks: string): boolean { return processStartTicks(pid) === startTicks; }
function wrapperAlive(record: PersistentExecRecord): boolean { return sameProcess(record.pid, record.startTicks); }
function supervisedGroupProven(record: PersistentExecRecord): boolean {
  const identity = processIdentity(record.pid);
  return identity?.startTicks === record.startTicks && identity.processGroupId === record.pid;
}
function childAnchorsSupervisedGroup(record: PersistentExecRecord): boolean {
  if (record.childPid === null || record.childStartTicks === null) return false;
  const identity = processIdentity(record.childPid);
  return identity?.startTicks === record.childStartTicks && identity.processGroupId === record.pid;
}
function signalSupervisedGroup(record: PersistentExecRecord, signal: NodeJS.Signals): boolean {
  if (!supervisedGroupProven(record) && !childAnchorsSupervisedGroup(record)) return false;
  try {
    process.kill(-record.pid, signal);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

function readExitCode(file: string): number | null {
  const text = boundedText(file, EXIT_FILE_MAX_BYTES)?.trim();
  if (!text || !/^-?\d+$/.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : null;
}
function readChildIdentity(file: string, expectedProcessGroupId?: number): { pid: number; startTicks: string; processGroupId: number } | null {
  const text = boundedText(file, CHILD_FILE_MAX_BYTES)?.trim();
  if (!text || !/^\d+$/.test(text)) return null;
  const pid = Number(text);
  if (!Number.isSafeInteger(pid) || pid <= 1) return null;
  const identity = processIdentity(pid);
  if (!identity) return null;
  if (expectedProcessGroupId !== undefined && identity.processGroupId !== expectedProcessGroupId) return null;
  return { pid, startTicks: identity.startTicks, processGroupId: identity.processGroupId };
}

function activePolicy(record: PersistentExecRecord): ProjectAutonomyPolicy | null {
  const policy = projectAutonomyForVirtualCwd(record.displayCwd);
  return policy && policy.rootName === record.rootName && policy.persistentProcesses ? policy : null;
}
function located(sessionId: number): LocatedRecord | null {
  ensureRestored();
  const record = records.get(sessionId);
  if (!record) return null;
  return {
    policy: activePolicy(record), record,
    logPath: logPath(sessionId), exitPath: exitPath(sessionId), childPath: childPath(sessionId), inputPath: inputPath(sessionId)
  };
}
function processFinished(row: LocatedRecord): { finished: boolean; exitCode: number | null } {
  const code = readExitCode(row.exitPath);
  if (code !== null) return { finished: true, exitCode: code };
  return wrapperAlive(row.record) ? { finished: false, exitCode: null } : { finished: true, exitCode: null };
}

function outputLimitBytes(requestedTokens: number | undefined): number {
  const requested = requestedTokens === undefined ? SAFE_DEFAULT_OUTPUT_BYTES : Math.max(1, requestedTokens) * 4;
  return Math.min(MAX_INCREMENTAL_OUTPUT_BYTES, requested);
}
function fileSize(file: string): number {
  try { const stat = nodeFs.statSync(file); return stat.isFile() ? stat.size : 0; }
  catch { return 0; }
}
function readRange(file: string, start: number, bytes: number): Buffer {
  if (bytes <= 0) return Buffer.alloc(0);
  const buffer = Buffer.alloc(bytes);
  const fd = nodeFs.openSync(file, 'r');
  try {
    const read = nodeFs.readSync(fd, buffer, 0, bytes, start);
    return read === bytes ? buffer : buffer.subarray(0, read);
  } finally { nodeFs.closeSync(fd); }
}
function readIncremental(row: LocatedRecord, requestedTokens: number | undefined): Buffer {
  const size = fileSize(row.logPath);
  if (size <= row.record.readOffset) return Buffer.alloc(0);
  const bytes = Math.min(outputLimitBytes(requestedTokens), size - row.record.readOffset);
  const chunk = readRange(row.logPath, row.record.readOffset, bytes);
  row.record.readOffset += chunk.length;
  persistSoon();
  return chunk;
}
function readFinal(row: LocatedRecord): { bytes: Buffer; omitted: number | null } {
  const size = fileSize(row.logPath);
  const remaining = Math.max(0, size - row.record.readOffset);
  if (remaining === 0) return { bytes: Buffer.alloc(0), omitted: null };
  if (remaining <= UNIFIED_EXEC_OUTPUT_MAX_BYTES) {
    const bytes = readRange(row.logPath, row.record.readOffset, remaining);
    row.record.readOffset += bytes.length;
    return { bytes, omitted: null };
  }
  const headBytes = Math.floor(UNIFIED_EXEC_OUTPUT_MAX_BYTES / 2);
  const tailBytes = UNIFIED_EXEC_OUTPUT_MAX_BYTES - headBytes;
  const head = readRange(row.logPath, row.record.readOffset, headBytes);
  const tailStart = Math.max(row.record.readOffset + head.length, size - tailBytes);
  const tail = readRange(row.logPath, tailStart, size - tailStart);
  row.record.readOffset = size;
  return { bytes: Buffer.concat([head, tail]), omitted: Math.max(0, remaining - head.length - tail.length) };
}
function capNotice(row: LocatedRecord): Buffer {
  if (row.record.capNoticeDelivered || fileSize(row.logPath) < row.record.maxLogBytes) return Buffer.alloc(0);
  row.record.capNoticeDelivered = true;
  persistSoon();
  return Buffer.from(`\n[local-cgpt autonomous process log reached its ${row.record.maxLogBytes}-byte private cap; further stdout/stderr is discarded while the process continues.]\n`, 'utf8');
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => { const timer = setTimeout(resolve, Math.max(0, ms)); timer.unref?.(); });
}
interface WaitedOutput { bytes: Buffer; omitted: number | null; finished: boolean; exitCode: number | null; }
async function waitFor(row: LocatedRecord, timeoutMs: number, returnOnOutput: boolean, requestedTokens: number | undefined): Promise<WaitedOutput> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  for (;;) {
    const state = processFinished(row);
    if (state.finished) {
      const final = readFinal(row);
      const notice = capNotice(row);
      return { bytes: notice.length ? Buffer.concat([final.bytes, notice]) : final.bytes, omitted: final.omitted, ...state };
    }
    if (returnOnOutput && fileSize(row.logPath) > row.record.readOffset) {
      const bytes = readIncremental(row, requestedTokens);
      const notice = capNotice(row);
      return { bytes: notice.length ? Buffer.concat([bytes, notice]) : bytes, omitted: null, ...state };
    }
    if (Date.now() >= deadline) {
      const bytes = readIncremental(row, requestedTokens);
      const notice = capNotice(row);
      return { bytes: notice.length ? Buffer.concat([bytes, notice]) : bytes, omitted: null, ...state };
    }
    await sleep(Math.min(POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())));
  }
}
function result(
  row: LocatedRecord,
  waited: WaitedOutput,
  wallTimeMs: number,
  request: { maxOutputTokens: number | undefined; truncationPolicy: ExecCommandRequest['truncationPolicy'] }
): ExecCommandToolOutput {
  return {
    chunkId: generateChunkId(), wallTimeMs, rawOutput: waited.bytes, truncationPolicy: request.truncationPolicy,
    maxOutputTokens: request.maxOutputTokens, processId: waited.finished ? null : row.record.sessionId,
    exitCode: waited.exitCode, originalTokenCount: Math.ceil((waited.bytes.byteLength + (waited.omitted ?? 0)) / 4),
    outputOmittedBytes: waited.omitted
  };
}
function cleanupFiles(row: LocatedRecord): void {
  const outputFifo = `${row.logPath}.pipe.${row.record.pid}`;
  for (const file of [row.logPath, row.exitPath, row.childPath, row.inputPath, outputFifo]) {
    try { removeIfPresent(file); } catch { /* best effort */ }
  }
}
function forgetRecord(row: LocatedRecord, exitCode: number | null = readExitCode(row.exitPath)): void {
  records.delete(row.record.sessionId);
  noteAutonomousProcessFinished(row.record.rootName, row.record.sessionId, exitCode);
  cleanupFiles(row);
  persistSoon();
}

async function writePersistentInput(row: LocatedRecord, input: string): Promise<void> {
  const bytes = Buffer.from(input, 'utf8');
  if (bytes.byteLength > MAX_STDIN_WRITE_BYTES) throw UnifiedExecError.writeToStdin();
  if (!wrapperAlive(row.record)) throw UnifiedExecError.stdinClosed();
  try {
    const stat = nodeFs.lstatSync(row.inputPath);
    if (!stat.isFIFO() || stat.isSymbolicLink()) throw UnifiedExecError.stdinClosed();
  } catch (error) {
    if (error instanceof UnifiedExecError) throw error;
    throw UnifiedExecError.stdinClosed();
  }

  let fd: number | null = null;
  try {
    fd = nodeFs.openSync(row.inputPath, nodeFs.constants.O_WRONLY | nodeFs.constants.O_NONBLOCK);
    let offset = 0;
    const deadline = Date.now() + STDIN_WRITE_DEADLINE_MS;
    while (offset < bytes.byteLength) {
      try {
        const written = nodeFs.writeSync(fd, bytes, offset, bytes.byteLength - offset);
        if (written <= 0) throw UnifiedExecError.writeToStdin();
        offset += written;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if ((code === 'EAGAIN' || code === 'EWOULDBLOCK') && Date.now() < deadline && wrapperAlive(row.record)) {
          await sleep(10);
          continue;
        }
        if (error instanceof UnifiedExecError) throw error;
        throw UnifiedExecError.writeToStdin();
      }
    }
  } finally {
    if (fd !== null) {
      try { nodeFs.closeSync(fd); } catch { /* best effort */ }
    }
  }
}

export class PersistentProjectProcessManager {
  hasPersistedSession(sessionId: number): boolean { ensureRestored(); return records.has(sessionId); }
  persistedSessionIds(): Set<number> { ensureRestored(); return new Set(records.keys()); }

  async execCommand(
    request: ExecCommandRequest,
    policy: ProjectAutonomyPolicy,
    ownerConversationId: string | null = null
  ): Promise<ExecCommandToolOutput> {
    ensureRestored();
    if (request.tty) throw UnifiedExecError.createProcess('persistent project processes do not support TTY mode');
    if (!policy.persistentProcesses) throw UnifiedExecError.createProcess('persistent process mode is disabled for this project');
    runtimeRoot();
    prepareProjectAutonomyDirectories(policy);
    const rowPaths = {
      logPath: logPath(request.processId), exitPath: exitPath(request.processId), childPath: childPath(request.processId),
      inputPath: inputPath(request.processId)
    };
    for (const file of Object.values(rowPaths)) removeIfPresent(file);

    let child;
    try {
      child = spawn('/bin/bash', [
        '--noprofile','--norc','-c',DETACHED_WRAPPER,'local-cgpt-autonomous-process',
        rowPaths.logPath,rowPaths.exitPath,rowPaths.childPath,rowPaths.inputPath,String(policy.maxLogBytes),...request.command
      ], { cwd: '/', env: {}, detached: true, stdio: 'ignore', shell: false });
    } catch (error) { throw UnifiedExecError.createProcess(error instanceof Error ? error.message : String(error)); }
    const pid = child.pid;
    if (!pid || pid <= 1) throw UnifiedExecError.createProcess('detached process did not receive a usable pid');
    child.unref();

    let wrapperIdentity: LinuxProcessIdentity | null = null;
    for (let attempt = 0; attempt < 20 && wrapperIdentity === null; attempt += 1) {
      wrapperIdentity = processIdentity(pid);
      if (wrapperIdentity === null) await sleep(10);
    }
    if (wrapperIdentity === null || wrapperIdentity.processGroupId !== pid) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
      throw UnifiedExecError.createProcess('detached process-group identity could not be proven through /proc');
    }
    const startTicks = wrapperIdentity.startTicks;

    let childIdentity: { pid: number; startTicks: string; processGroupId: number } | null = null;
    for (let attempt = 0; attempt < 200 && childIdentity === null; attempt += 1) {
      childIdentity = readChildIdentity(rowPaths.childPath, pid);
      if (childIdentity === null && sameProcess(pid, startTicks)) await sleep(10);
    }
    if (childIdentity === null) {
      if (processIdentity(pid)?.processGroupId === pid && sameProcess(pid, startTicks)) {
        try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
      } else {
        try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
      }
      for (const file of [...Object.values(rowPaths), `${rowPaths.logPath}.pipe.${pid}`]) {
        try { removeIfPresent(file); } catch { /* best effort */ }
      }
      throw UnifiedExecError.createProcess('detached child identity could not be proven in the supervised process group');
    }

    const record: PersistentExecRecord = {
      version: SNAPSHOT_VERSION, sessionId: request.processId, rootName: policy.rootName, pid, startTicks,
      childPid: childIdentity.pid, childStartTicks: childIdentity.startTicks,
      startedAt: Date.now(), displayCwd: request.displayCwd, readOffset: 0, capNoticeDelivered: false,
      maxLogBytes: policy.maxLogBytes, ownerConversationId
    };
    records.set(request.processId, record);
    try { await persistNow(); }
    catch (error) {
      try {
        if (!signalSupervisedGroup(record, 'SIGKILL')) process.kill(pid, 'SIGKILL');
      } catch { /* already gone or best-effort rollback */ }
      records.delete(request.processId);
      cleanupFiles({ policy, record, ...rowPaths });
      throw UnifiedExecError.createProcess(`detached process state could not be made durable: ${error instanceof Error ? error.message : String(error)}`);
    }

    const row: LocatedRecord = { policy, record, ...rowPaths };
    const start = performance.now();
    const waited = await waitFor(row, Math.min(Math.max(request.yieldTimeMs, MIN_YIELD_TIME_MS), MAX_YIELD_TIME_MS), false, request.maxOutputTokens);
    const response = result(row, waited, Math.max(0, performance.now() - start), request);
    if (waited.finished) forgetRecord(row, waited.exitCode);
    return response;
  }

  async writeStdin(request: WriteStdinRequest): Promise<ExecCommandToolOutput> {
    const row = located(request.processId);
    if (!row || !row.policy) throw UnifiedExecError.unknownProcessId(request.processId);
    if (request.input === INTERRUPT && wrapperAlive(row.record)) {
      try { process.kill(row.record.pid, 'SIGINT'); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
          throw UnifiedExecError.processFailed(error instanceof Error ? error.message : String(error));
        }
      }
    } else if (request.input !== '') {
      await writePersistentInput(row, request.input);
    }
    const base = Math.max(request.yieldTimeMs, MIN_YIELD_TIME_MS);
    const timeoutMs = request.input === '' ? Math.max(base, MIN_EMPTY_YIELD_TIME_MS) : Math.min(base, MAX_YIELD_TIME_MS);
    const start = performance.now();
    const waited = await waitFor(row, timeoutMs, request.input === '', request.maxOutputTokens);
    const response = result(row, waited, Math.max(0, performance.now() - start), request);
    if (waited.finished) forgetRecord(row, waited.exitCode);
    return response;
  }

  listProcesses(): BackgroundTerminalInfo[] {
    ensureRestored();
    return [...records.values()].map((record) => located(record.sessionId))
      .filter((row): row is LocatedRecord => Boolean(row?.policy) && !processFinished(row!).finished)
      .map((row) => ({
        processId: row.record.sessionId, command: '[autonomous project process]', cwd: row.record.displayCwd,
        pid: row.record.pid, tty: false
      }))
      .sort((left, right) => left.processId - right.processId);
  }

  async terminateProcess(sessionId: number): Promise<boolean> {
    const row = located(sessionId);
    if (!row) return false;
    if (wrapperAlive(row.record)) {
      if (!supervisedGroupProven(row.record)) {
        throw UnifiedExecError.processFailed('persistent process-group identity no longer matches its durable session');
      }
      try { signalSupervisedGroup(row.record, 'SIGTERM'); }
      catch (error) { throw UnifiedExecError.processFailed(error instanceof Error ? error.message : String(error)); }
      const deadline = Date.now() + 2_000;
      while (wrapperAlive(row.record) && Date.now() < deadline) await sleep(50);
      if (wrapperAlive(row.record)) {
        if (!supervisedGroupProven(row.record)) {
          throw UnifiedExecError.processFailed('persistent process-group identity changed during termination');
        }
        try { signalSupervisedGroup(row.record, 'SIGKILL'); }
        catch (error) { throw UnifiedExecError.processFailed(error instanceof Error ? error.message : String(error)); }
      }
    } else if (childAnchorsSupervisedGroup(row.record)) {
      // If the wrapper died unexpectedly but its exact child still proves membership in the old
      // group, kill that group before forgetting the row. Without an exact live anchor we fail
      // closed and never signal a bare historical process-group number.
      try { signalSupervisedGroup(row.record, 'SIGKILL'); }
      catch (error) { throw UnifiedExecError.processFailed(error instanceof Error ? error.message : String(error)); }
    }
    forgetRecord(row, 130);
    return true;
  }

  async shutdown(): Promise<void> {
    ensureRestored();
    for (const record of [...records.values()]) {
      if (activePolicy(record)) continue;
      await this.terminateProcess(record.sessionId);
    }
    persistSoon();
  }
}

export const persistentProjectProcesses = new PersistentProjectProcessManager();

export function persistentExecOwner(sessionId: number): string | null | undefined {
  ensureRestored();
  return records.get(sessionId)?.ownerConversationId;
}
export function notePersistentExecOwner(sessionId: number, conversationId: string | null): boolean {
  ensureRestored();
  const record = records.get(sessionId);
  if (!record) return false;
  record.ownerConversationId = conversationId;
  persistSoon();
  return true;
}
/**
 * Publishes a persistent owner change across an immediate durability barrier.
 *
 * Production autonomous launches now put their proven conversation owner in the first durable
 * supervisor row before the session id can escape. This helper remains the fail-closed barrier for
 * later owner replacement/repair (including continuation recovery): callers do not publish the
 * changed owner until the owner-bearing snapshot is atomically on disk. On write failure the
 * in-memory owner is rolled back.
 */
export async function notePersistentExecOwnerNow(sessionId: number, conversationId: string | null): Promise<boolean> {
  ensureRestored();
  const record = records.get(sessionId);
  if (!record) return false;
  const previous = record.ownerConversationId;
  record.ownerConversationId = conversationId;
  try {
    await persistNow();
    return true;
  } catch (error) {
    record.ownerConversationId = previous;
    throw error;
  }
}
export function forgetPersistentExecOwner(sessionId: number): void {
  ensureRestored();
  const record = records.get(sessionId);
  if (!record) return;
  record.ownerConversationId = null;
  persistSoon();
}
export function movePersistentExecOwners(fromConversationId: string, toConversationId: string): number {
  ensureRestored();
  if (!fromConversationId || !toConversationId || fromConversationId === toConversationId) return 0;
  let moved = 0;
  for (const record of records.values()) {
    if (record.ownerConversationId !== fromConversationId) continue;
    record.ownerConversationId = toConversationId;
    moved += 1;
  }
  if (moved > 0) persistSoon();
  return moved;
}

/** Privacy-safe process diagnostics: no command text, output, native roots or child argv. */
export function persistentExecDiagnostics(): Array<{
  sessionId: number; rootName: string; running: boolean; active: boolean; startedAt: number; outputBytes: number
}> {
  ensureRestored();
  return [...records.values()].map((record) => ({
    sessionId: record.sessionId, rootName: record.rootName, running: wrapperAlive(record),
    active: activePolicy(record) !== null, startedAt: record.startedAt, outputBytes: fileSize(logPath(record.sessionId))
  }));
}
export function persistentSessionIds(): Set<number> { ensureRestored(); return new Set(records.keys()); }
export function resetPersistentExecForTests(): void { records.clear(); restored = false; }
export function persistentExecConfiguredRoots(): string[] {
  ensureRestored();
  const names = new Set(getConfig().roots.map((root) => root.name));
  return [...records.values()].filter((record) => names.has(record.rootName)).map((record) => record.rootName);
}

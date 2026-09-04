import { spawn } from 'node:child_process';
import nodeFs from 'node:fs';
import nodePath from 'node:path';
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
const EXIT_FILE_MAX_BYTES = 64;
const CHILD_FILE_MAX_BYTES = 64;
const PRIVATE_RUNTIME_NAME = 'persistent-exec-runtime';

/**
 * The wrapper executes argv with `"$@"`; no model-controlled text is interpolated into shell
 * syntax. A private FIFO lets a tiny logger retain at most max_bytes while continuing to drain
 * excess stdout/stderr, so a noisy compiler cannot grow the app-private log without bound or get
 * SIGPIPE merely because the diagnostic cap was reached. INT/TERM are forwarded to Bubblewrap.
 */
const DETACHED_WRAPPER = `
set -u
umask 077
log=$1
exit_file=$2
child_file=$3
max_bytes=$4
shift 4
fifo="${'${log}'}.pipe.$$"
cleanup() { rm -f "$fifo" "$child_file"; }
trap cleanup EXIT
mkfifo "$fifo"
{ head -c "$max_bytes"; cat >/dev/null; } <"$fifo" >"$log" &
logger=$!
"$@" >"$fifo" 2>&1 &
child=$!
printf '%s\\n' "$child" >"$child_file"
forward_int() { kill -INT "$child" 2>/dev/null || true; }
forward_term() { kill -TERM "$child" 2>/dev/null || true; }
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
}

const records = new Map<number, PersistentExecRecord>();
let restored = false;

function runtimeRoot(): string {
  const directory = durablePrivateDirectory(PRIVATE_RUNTIME_NAME);
  if (!directory) throw new Error('persistent exec runtime is not initialized');
  return directory;
}

function logPath(sessionId: number): string {
  return nodePath.join(runtimeRoot(), `process-${sessionId}.log`);
}
function exitPath(sessionId: number): string {
  return nodePath.join(runtimeRoot(), `process-${sessionId}.exit`);
}
function childPath(sessionId: number): string {
  return nodePath.join(runtimeRoot(), `process-${sessionId}.child`);
}

function snapshot(): PersistentExecSnapshot {
  return { version: SNAPSHOT_VERSION, savedAt: Date.now(), records: [...records.values()] };
}
function persistSoon(): void {
  writeDurableSoon(PERSISTENT_EXEC_STATE, snapshot());
}
async function persistNow(): Promise<void> {
  await writeDurableNow(PERSISTENT_EXEC_STATE, snapshot());
}

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
    typeof value.displayCwd !== 'string' || !value.displayCwd.startsWith(`/${value.rootName}`) ||
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

/**
 * Authorization checks are synchronous, so restoration cannot wait on the normal async startup
 * path. The durable store is initialized before model-facing tools can run; the first process or
 * ownership lookup reads its tiny snapshot synchronously and every later lookup stays in memory.
 */
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
function processStartTicks(pid: number): string | null {
  const text = boundedText(`/proc/${pid}/stat`, 8 * 1024);
  if (text === null) return null;
  const close = text.lastIndexOf(')');
  if (close < 0) return null;
  const fields = text.slice(close + 1).trim().split(/\s+/);
  const start = fields[19];
  return start && /^\d+$/.test(start) ? start : null;
}
function sameProcess(pid: number, startTicks: string): boolean { return processStartTicks(pid) === startTicks; }
function wrapperAlive(record: PersistentExecRecord): boolean { return sameProcess(record.pid, record.startTicks); }

function readExitCode(file: string): number | null {
  const text = boundedText(file, EXIT_FILE_MAX_BYTES)?.trim();
  if (!text || !/^-?\d+$/.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : null;
}
function readChildIdentity(file: string): { pid: number; startTicks: string } | null {
  const text = boundedText(file, CHILD_FILE_MAX_BYTES)?.trim();
  if (!text || !/^\d+$/.test(text)) return null;
  const pid = Number(text);
  if (!Number.isSafeInteger(pid) || pid <= 1) return null;
  const startTicks = processStartTicks(pid);
  return startTicks ? { pid, startTicks } : null;
}

function activePolicy(record: PersistentExecRecord): ProjectAutonomyPolicy | null {
  const policy = projectAutonomyForVirtualCwd(record.displayCwd);
  return policy && policy.rootName === record.rootName && policy.persistentProcesses ? policy : null;
}
function located(sessionId: number): LocatedRecord | null {
  ensureRestored();
  const record = records.get(sessionId);
  if (!record) return null;
  return { policy: activePolicy(record), record, logPath: logPath(sessionId), exitPath: exitPath(sessionId), childPath: childPath(sessionId) };
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
function result(row: LocatedRecord, waited: WaitedOutput, wallTimeMs: number, request: { maxOutputTokens: number | undefined; truncationPolicy: ExecCommandRequest['truncationPolicy'] }): ExecCommandToolOutput {
  return {
    chunkId: generateChunkId(), wallTimeMs, rawOutput: waited.bytes, truncationPolicy: request.truncationPolicy,
    maxOutputTokens: request.maxOutputTokens, processId: waited.finished ? null : row.record.sessionId,
    exitCode: waited.exitCode, originalTokenCount: Math.ceil((waited.bytes.byteLength + (waited.omitted ?? 0)) / 4),
    outputOmittedBytes: waited.omitted
  };
}
function cleanupFiles(row: LocatedRecord): void {
  for (const file of [row.logPath, row.exitPath, row.childPath]) {
    try { removeIfPresent(file); } catch { /* best effort */ }
  }
}
function forgetRecord(row: LocatedRecord): void {
  records.delete(row.record.sessionId);
  cleanupFiles(row);
  persistSoon();
}

export class PersistentProjectProcessManager {
  hasPersistedSession(sessionId: number): boolean { ensureRestored(); return records.has(sessionId); }
  persistedSessionIds(): Set<number> { ensureRestored(); return new Set(records.keys()); }

  async execCommand(request: ExecCommandRequest, policy: ProjectAutonomyPolicy): Promise<ExecCommandToolOutput> {
    ensureRestored();
    if (request.tty) throw UnifiedExecError.createProcess('persistent project processes do not support TTY mode');
    if (!policy.persistentProcesses) throw UnifiedExecError.createProcess('persistent process mode is disabled for this project');
    runtimeRoot();
    prepareProjectAutonomyDirectories(policy);
    const rowPaths = { logPath: logPath(request.processId), exitPath: exitPath(request.processId), childPath: childPath(request.processId) };
    for (const file of Object.values(rowPaths)) removeIfPresent(file);

    let child;
    try {
      child = spawn('/bin/bash', [
        '--noprofile','--norc','-c',DETACHED_WRAPPER,'local-cgpt-autonomous-process',
        rowPaths.logPath,rowPaths.exitPath,rowPaths.childPath,String(policy.maxLogBytes),...request.command
      ], { cwd: '/', env: {}, detached: true, stdio: 'ignore', shell: false });
    } catch (error) { throw UnifiedExecError.createProcess(error instanceof Error ? error.message : String(error)); }
    const pid = child.pid;
    if (!pid || pid <= 1) throw UnifiedExecError.createProcess('detached process did not receive a usable pid');
    child.unref();

    let startTicks: string | null = null;
    for (let attempt = 0; attempt < 20 && startTicks === null; attempt += 1) {
      startTicks = processStartTicks(pid);
      if (startTicks === null) await sleep(10);
    }
    if (startTicks === null) {
      try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
      throw UnifiedExecError.createProcess('detached process identity could not be proven through /proc');
    }
    let childIdentity: { pid: number; startTicks: string } | null = null;
    for (let attempt = 0; attempt < 40 && childIdentity === null; attempt += 1) {
      childIdentity = readChildIdentity(rowPaths.childPath);
      if (childIdentity === null && sameProcess(pid, startTicks)) await sleep(10);
    }

    const record: PersistentExecRecord = {
      version: SNAPSHOT_VERSION, sessionId: request.processId, rootName: policy.rootName, pid, startTicks,
      childPid: childIdentity?.pid ?? null, childStartTicks: childIdentity?.startTicks ?? null,
      startedAt: Date.now(), displayCwd: request.displayCwd, readOffset: 0, capNoticeDelivered: false,
      maxLogBytes: policy.maxLogBytes, ownerConversationId: null
    };
    records.set(request.processId, record);
    try { await persistNow(); }
    catch (error) {
      try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
      records.delete(request.processId);
      cleanupFiles({ policy, record, ...rowPaths });
      throw UnifiedExecError.createProcess(`detached process state could not be made durable: ${error instanceof Error ? error.message : String(error)}`);
    }

    const row: LocatedRecord = { policy, record, ...rowPaths };
    const start = performance.now();
    const waited = await waitFor(row, Math.min(Math.max(request.yieldTimeMs, MIN_YIELD_TIME_MS), MAX_YIELD_TIME_MS), false, request.maxOutputTokens);
    const response = result(row, waited, Math.max(0, performance.now() - start), request);
    if (waited.finished) forgetRecord(row);
    return response;
  }

  async writeStdin(request: WriteStdinRequest): Promise<ExecCommandToolOutput> {
    const row = located(request.processId);
    if (!row || !row.policy) throw UnifiedExecError.unknownProcessId(request.processId);
    if (request.input !== '' && request.input !== INTERRUPT) throw UnifiedExecError.stdinClosed();
    if (request.input === INTERRUPT && wrapperAlive(row.record)) {
      try { process.kill(row.record.pid, 'SIGINT'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw UnifiedExecError.processFailed(error instanceof Error ? error.message : String(error)); }
    }
    const base = Math.max(request.yieldTimeMs, MIN_YIELD_TIME_MS);
    const timeoutMs = request.input === '' ? Math.max(base, MIN_EMPTY_YIELD_TIME_MS) : Math.min(base, MAX_YIELD_TIME_MS);
    const start = performance.now();
    const waited = await waitFor(row, timeoutMs, request.input === '', request.maxOutputTokens);
    const response = result(row, waited, Math.max(0, performance.now() - start), request);
    if (waited.finished) forgetRecord(row);
    return response;
  }

  listProcesses(): BackgroundTerminalInfo[] {
    ensureRestored();
    return [...records.values()].map((record) => located(record.sessionId))
      .filter((row): row is LocatedRecord => Boolean(row?.policy) && !processFinished(row!).finished)
      .map((row) => ({ processId: row.record.sessionId, command: '[autonomous project process]', cwd: row.record.displayCwd, pid: row.record.pid, tty: false }))
      .sort((left, right) => left.processId - right.processId);
  }

  async terminateProcess(sessionId: number): Promise<boolean> {
    const row = located(sessionId);
    if (!row) return false;
    if (wrapperAlive(row.record)) {
      try { process.kill(row.record.pid, 'SIGTERM'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      const deadline = Date.now() + 2_000;
      while (wrapperAlive(row.record) && Date.now() < deadline) await sleep(50);
      if (wrapperAlive(row.record)) {
        if (row.record.childPid !== null && row.record.childStartTicks !== null && sameProcess(row.record.childPid, row.record.childStartTicks)) {
          try { process.kill(row.record.childPid, 'SIGKILL'); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
        }
        try { process.kill(row.record.pid, 'SIGKILL'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      }
    }
    forgetRecord(row);
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
export function persistentExecDiagnostics(): Array<{ sessionId: number; rootName: string; running: boolean; active: boolean; startedAt: number; outputBytes: number }> {
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

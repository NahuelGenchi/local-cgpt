import { spawn } from 'node:child_process';
import nodeFs from 'node:fs';
import nodePath from 'node:path';
import { getConfig } from '../config.js';
import {
  activeProjectAutonomyPolicies,
  persistentProcessExitPath,
  persistentProcessLogPath,
  persistentProcessMetadataPath,
  prepareProjectAutonomyDirectories,
  projectAutonomyForVirtualCwd,
  type ProjectAutonomyPolicy
} from '../project-autonomy.js';
import {
  INTERRUPT,
  MAX_YIELD_TIME_MS,
  MIN_EMPTY_YIELD_TIME_MS,
  MIN_YIELD_TIME_MS
} from './unified-exec-constants.js';
import {
  UnifiedExecError,
  type BackgroundTerminalInfo,
  type ExecCommandRequest,
  type ExecCommandToolOutput,
  type WriteStdinRequest
} from './unified-exec.js';

const META_VERSION = 1;
const MAX_META_BYTES = 16 * 1024;
const POLL_INTERVAL_MS = 100;
const MAX_POLL_OUTPUT_BYTES = 256 * 1024;
const SAFE_DEFAULT_OUTPUT_BYTES = 10_000 * 4;
const EXIT_FILE_MAX_BYTES = 64;
const CHILD_FILE_MAX_BYTES = 64;

/**
 * The detached wrapper is deliberately boring shell plumbing, not a second command parser.
 *
 * Every model-controlled argument is passed after `--` as an argv element and executed with
 * `"$@"`; none is interpolated into this script. The wrapper owns only three pieces of policy:
 * a private FIFO so stdout/stderr can be capped without backpressuring the real process, signal
 * forwarding to the Bubblewrap process, and a tiny exit-code record. The model command itself
 * remains inside the already-reviewed Bubblewrap argv produced by command-sandbox.ts.
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
wait "$child"
code=$?
wait "$logger" 2>/dev/null || true
printf '%s\\n' "$code" >"$exit_file"
exit "$code"
`.trim();

interface PersistentProcessRecord {
  version: 1;
  sessionId: number;
  rootName: string;
  pid: number;
  startTicks: string;
  startedAt: number;
  displayCwd: string;
  readOffset: number;
  capNoticeDelivered: boolean;
  ownerConversationId: string | null;
}

interface LocatedRecord {
  policy: ProjectAutonomyPolicy | null;
  rootPath: string;
  runtimeDir: string;
  record: PersistentProcessRecord;
  metadataPath: string;
  logPath: string;
  exitPath: string;
  childPath: string;
}

function childPath(runtimeDir: string, sessionId: number): string {
  return nodePath.join(runtimeDir, `process-${sessionId}.child`);
}

function metadataName(sessionId: number): string {
  return `process-${sessionId}.json`;
}

function atomicWriteJson(file: string, value: unknown): void {
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  nodeFs.writeFileSync(tmp, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  nodeFs.renameSync(tmp, file);
}

function removeIfPresent(file: string): void {
  try {
    nodeFs.unlinkSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function boundedText(file: string, maxBytes: number): string | null {
  try {
    const stat = nodeFs.statSync(file);
    if (!stat.isFile() || stat.size > maxBytes) return null;
    return nodeFs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function validRecord(value: unknown, rootName: string): PersistentProcessRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const allowed = new Set([
    'version',
    'sessionId',
    'rootName',
    'pid',
    'startTicks',
    'startedAt',
    'displayCwd',
    'readOffset',
    'capNoticeDelivered',
    'ownerConversationId'
  ]);
  if (Object.keys(raw).some((key) => !allowed.has(key))) return null;
  if (
    raw.version !== META_VERSION ||
    raw.rootName !== rootName ||
    typeof raw.sessionId !== 'number' ||
    !Number.isSafeInteger(raw.sessionId) ||
    raw.sessionId < 1_000 ||
    raw.sessionId >= 100_000 ||
    typeof raw.pid !== 'number' ||
    !Number.isSafeInteger(raw.pid) ||
    raw.pid <= 1 ||
    typeof raw.startTicks !== 'string' ||
    !/^\d+$/.test(raw.startTicks) ||
    typeof raw.startedAt !== 'number' ||
    !Number.isSafeInteger(raw.startedAt) ||
    raw.startedAt <= 0 ||
    typeof raw.displayCwd !== 'string' ||
    !raw.displayCwd.startsWith(`/${rootName}`) ||
    typeof raw.readOffset !== 'number' ||
    !Number.isSafeInteger(raw.readOffset) ||
    raw.readOffset < 0 ||
    typeof raw.capNoticeDelivered !== 'boolean' ||
    (raw.ownerConversationId !== null && typeof raw.ownerConversationId !== 'string')
  ) {
    return null;
  }
  return raw as unknown as PersistentProcessRecord;
}

function readRecord(file: string, rootName: string): PersistentProcessRecord | null {
  const text = boundedText(file, MAX_META_BYTES);
  if (text === null) return null;
  try {
    return validRecord(JSON.parse(text), rootName);
  } catch {
    return null;
  }
}

/** Linux /proc starttime is stable for one PID lifetime and changes on PID reuse. */
function processStartTicks(pid: number): string | null {
  const text = boundedText(`/proc/${pid}/stat`, 8 * 1024);
  if (text === null) return null;
  const close = text.lastIndexOf(')');
  if (close < 0) return null;
  const fields = text.slice(close + 1).trim().split(/\s+/);
  const start = fields[19]; // field 22; fields[0] is kernel field 3 after `(comm)`.
  return start && /^\d+$/.test(start) ? start : null;
}

function sameProcess(record: PersistentProcessRecord): boolean {
  return processStartTicks(record.pid) === record.startTicks;
}

function readExitCode(file: string): number | null {
  const text = boundedText(file, EXIT_FILE_MAX_BYTES)?.trim();
  if (!text || !/^-?\d+$/.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : null;
}

function readChildPid(file: string): number | null {
  const text = boundedText(file, CHILD_FILE_MAX_BYTES)?.trim();
  if (!text || !/^\d+$/.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) && value > 1 ? value : null;
}

function rootRuntime(rootPath: string): string {
  return nodePath.join(rootPath, '.local', 'local-cgpt', 'runtime');
}

function policyForRoot(rootName: string): ProjectAutonomyPolicy | null {
  return projectAutonomyForVirtualCwd(`/${rootName}`);
}

/**
 * Discover persisted process rows under configured approved roots, even when the marker was
 * removed or autonomy was disabled. Inactive rows are never writable through the model, but the
 * app must still be able to identify/clean a process it previously launched instead of turning a
 * permission revocation into an immortal orphan.
 */
function discoverRecords(): LocatedRecord[] {
  const rows: LocatedRecord[] = [];
  const config = getConfig();
  for (const root of config.roots) {
    const runtimeDir = rootRuntime(root.path);
    let names: string[];
    try {
      names = nodeFs.readdirSync(runtimeDir);
    } catch {
      continue;
    }
    for (const name of names) {
      const match = /^process-(\d+)\.json$/.exec(name);
      if (!match) continue;
      const sessionId = Number(match[1]);
      if (!Number.isSafeInteger(sessionId)) continue;
      const metadataPath = nodePath.join(runtimeDir, name);
      const record = readRecord(metadataPath, root.name);
      if (!record || record.sessionId !== sessionId) continue;
      rows.push({
        policy: policyForRoot(root.name),
        rootPath: root.path,
        runtimeDir,
        record,
        metadataPath,
        logPath: nodePath.join(runtimeDir, `process-${sessionId}.log`),
        exitPath: nodePath.join(runtimeDir, `process-${sessionId}.exit`),
        childPath: childPath(runtimeDir, sessionId)
      });
    }
  }
  return rows;
}

function located(sessionId: number): LocatedRecord | null {
  return discoverRecords().find((row) => row.record.sessionId === sessionId) ?? null;
}

function persist(row: LocatedRecord): void {
  atomicWriteJson(row.metadataPath, row.record);
}

function cleanup(row: LocatedRecord): void {
  for (const file of [row.metadataPath, row.logPath, row.exitPath, row.childPath]) {
    try {
      removeIfPresent(file);
    } catch {
      // Cleanup is best effort. A stale metadata row still fails PID-fingerprint validation.
    }
  }
}

function maxReadBytes(requestedTokens: number | undefined): number {
  const wanted = requestedTokens === undefined ? SAFE_DEFAULT_OUTPUT_BYTES : Math.max(1, requestedTokens) * 4;
  return Math.min(MAX_POLL_OUTPUT_BYTES, wanted);
}

function readNewOutput(row: LocatedRecord, requestedTokens: number | undefined): Buffer {
  let stat: nodeFs.Stats;
  try {
    stat = nodeFs.statSync(row.logPath);
  } catch {
    return Buffer.alloc(0);
  }
  if (!stat.isFile() || stat.size <= row.record.readOffset) return Buffer.alloc(0);
  const bytes = Math.min(maxReadBytes(requestedTokens), stat.size - row.record.readOffset);
  const buffer = Buffer.alloc(bytes);
  const fd = nodeFs.openSync(row.logPath, 'r');
  try {
    const read = nodeFs.readSync(fd, buffer, 0, bytes, row.record.readOffset);
    row.record.readOffset += read;
    persist(row);
    return read === bytes ? buffer : buffer.subarray(0, read);
  } finally {
    nodeFs.closeSync(fd);
  }
}

function maybeCapNotice(row: LocatedRecord): Buffer {
  if (!row.policy || row.record.capNoticeDelivered) return Buffer.alloc(0);
  let size = 0;
  try {
    size = nodeFs.statSync(row.logPath).size;
  } catch {
    return Buffer.alloc(0);
  }
  if (size < row.policy.maxLogBytes) return Buffer.alloc(0);
  row.record.capNoticeDelivered = true;
  persist(row);
  return Buffer.from(
    `\n[local-cgpt autonomous process log reached its ${row.policy.maxLogBytes}-byte private cap; further stdout/stderr is discarded while the process continues.]\n`,
    'utf8'
  );
}

function processFinished(row: LocatedRecord): { finished: boolean; exitCode: number | null } {
  const code = readExitCode(row.exitPath);
  if (code !== null) return { finished: true, exitCode: code };
  return sameProcess(row.record) ? { finished: false, exitCode: null } : { finished: true, exitCode: null };
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
}

async function waitFor(
  row: LocatedRecord,
  timeoutMs: number,
  returnOnOutput: boolean
): Promise<{ output: Buffer; finished: boolean; exitCode: number | null }> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  const chunks: Buffer[] = [];
  for (;;) {
    const next = readNewOutput(row, undefined);
    if (next.length > 0) {
      chunks.push(next);
      if (returnOnOutput) {
        const state = processFinished(row);
        return { output: Buffer.concat(chunks), ...state };
      }
    }
    const state = processFinished(row);
    if (state.finished || Date.now() >= deadline) {
      const tail = readNewOutput(row, undefined);
      if (tail.length > 0) chunks.push(tail);
      const cap = maybeCapNotice(row);
      if (cap.length > 0) chunks.push(cap);
      return { output: Buffer.concat(chunks), ...state };
    }
    await sleep(Math.min(POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())));
  }
}

function output(
  row: LocatedRecord,
  rawOutput: Buffer,
  wallTimeMs: number,
  state: { finished: boolean; exitCode: number | null },
  request: { maxOutputTokens: number | undefined; truncationPolicy: ExecCommandRequest['truncationPolicy'] }
): ExecCommandToolOutput {
  return {
    chunkId: Math.random().toString(16).slice(2, 8).padEnd(6, '0'),
    wallTimeMs,
    rawOutput,
    truncationPolicy: request.truncationPolicy,
    maxOutputTokens: request.maxOutputTokens,
    processId: state.finished ? null : row.record.sessionId,
    exitCode: state.exitCode,
    originalTokenCount: Math.ceil(rawOutput.byteLength / 4),
    outputOmittedBytes: null
  };
}

function requireActive(row: LocatedRecord): ProjectAutonomyPolicy {
  const policy = projectAutonomyForVirtualCwd(row.record.displayCwd);
  if (!policy || policy.rootName !== row.record.rootName || !policy.persistentProcesses) {
    throw UnifiedExecError.unknownProcessId(row.record.sessionId);
  }
  row.policy = policy;
  return policy;
}

export class PersistentProjectProcessManager {
  hasPersistedSession(sessionId: number): boolean {
    return located(sessionId) !== null;
  }

  persistedSessionIds(): Set<number> {
    return new Set(discoverRecords().map((row) => row.record.sessionId));
  }

  async execCommand(request: ExecCommandRequest, policy: ProjectAutonomyPolicy): Promise<ExecCommandToolOutput> {
    if (request.tty) throw UnifiedExecError.createProcess('persistent project processes do not support TTY mode');
    if (!policy.persistentProcesses) throw UnifiedExecError.createProcess('persistent process mode is disabled for this project');
    prepareProjectAutonomyDirectories(policy);

    const metadataPath = persistentProcessMetadataPath(policy, request.processId);
    const logPath = persistentProcessLogPath(policy, request.processId);
    const exitPath = persistentProcessExitPath(policy, request.processId);
    const childFile = childPath(policy.runtimeDir, request.processId);
    for (const file of [metadataPath, logPath, exitPath, childFile]) removeIfPresent(file);

    const maxBytes = String(policy.maxLogBytes);
    let child;
    try {
      child = spawn(
        '/bin/bash',
        [
          '--noprofile',
          '--norc',
          '-c',
          DETACHED_WRAPPER,
          'local-cgpt-autonomous-process',
          logPath,
          exitPath,
          childFile,
          maxBytes,
          ...request.command
        ],
        { cwd: '/', env: {}, detached: true, stdio: 'ignore', shell: false }
      );
    } catch (error) {
      throw UnifiedExecError.createProcess(error instanceof Error ? error.message : String(error));
    }
    const pid = child.pid;
    if (!pid || pid <= 1) throw UnifiedExecError.createProcess('detached process did not receive a usable pid');
    child.unref();

    let startTicks: string | null = null;
    for (let attempt = 0; attempt < 20 && startTicks === null; attempt += 1) {
      startTicks = processStartTicks(pid);
      if (startTicks === null) await sleep(10);
    }
    if (startTicks === null) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // already gone
      }
      throw UnifiedExecError.createProcess('detached process identity could not be proven through /proc');
    }

    const row: LocatedRecord = {
      policy,
      rootPath: policy.rootPath,
      runtimeDir: policy.runtimeDir,
      metadataPath,
      logPath,
      exitPath,
      childPath: childFile,
      record: {
        version: META_VERSION,
        sessionId: request.processId,
        rootName: policy.rootName,
        pid,
        startTicks,
        startedAt: Date.now(),
        displayCwd: request.displayCwd,
        readOffset: 0,
        capNoticeDelivered: false,
        ownerConversationId: null
      }
    };
    persist(row);

    const start = performance.now();
    const waited = await waitFor(row, Math.min(Math.max(request.yieldTimeMs, MIN_YIELD_TIME_MS), MAX_YIELD_TIME_MS), false);
    const result = output(row, waited.output, Math.max(0, performance.now() - start), waited, request);
    if (waited.finished) cleanup(row);
    return result;
  }

  async writeStdin(request: WriteStdinRequest): Promise<ExecCommandToolOutput> {
    const row = located(request.processId);
    if (!row) throw UnifiedExecError.unknownProcessId(request.processId);
    requireActive(row);

    if (request.input !== '' && request.input !== INTERRUPT) throw UnifiedExecError.stdinClosed();
    if (request.input === INTERRUPT) {
      try {
        process.kill(row.record.pid, 'SIGINT');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
          throw UnifiedExecError.processFailed(error instanceof Error ? error.message : String(error));
        }
      }
    }

    const base = Math.max(request.yieldTimeMs, MIN_YIELD_TIME_MS);
    const timeoutMs = request.input === ''
      ? Math.max(base, MIN_EMPTY_YIELD_TIME_MS)
      : Math.min(base, MAX_YIELD_TIME_MS);
    const start = performance.now();
    const waited = await waitFor(row, timeoutMs, request.input === '');
    const result = output(row, waited.output, Math.max(0, performance.now() - start), waited, request);
    if (waited.finished) cleanup(row);
    return result;
  }

  listProcesses(): BackgroundTerminalInfo[] {
    const rows: BackgroundTerminalInfo[] = [];
    for (const row of discoverRecords()) {
      if (!row.policy || !row.policy.persistentProcesses) continue;
      if (processFinished(row).finished) continue;
      rows.push({
        processId: row.record.sessionId,
        command: '[autonomous project process]',
        cwd: row.record.displayCwd,
        pid: row.record.pid,
        tty: false
      });
    }
    return rows.sort((left, right) => left.processId - right.processId);
  }

  async terminateProcess(sessionId: number): Promise<boolean> {
    const row = located(sessionId);
    if (!row) return false;
    const identityMatches = sameProcess(row.record);
    if (identityMatches) {
      const child = readChildPid(row.childPath);
      for (const target of [row.record.pid, child].filter((value): value is number => value !== null)) {
        try {
          process.kill(target, 'SIGTERM');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
      }
      const deadline = Date.now() + 2_000;
      while (sameProcess(row.record) && Date.now() < deadline) await sleep(50);
      if (sameProcess(row.record)) {
        const forcedChild = readChildPid(row.childPath);
        for (const target of [forcedChild, row.record.pid].filter((value): value is number => value !== null)) {
          try {
            process.kill(target, 'SIGKILL');
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
          }
        }
      }
    }
    cleanup(row);
    return true;
  }

  /**
   * App shutdown preserves only still-authorized autonomous jobs. Rows whose project marker or
   * command authority disappeared are terminated instead; revocation must not manufacture an
   * unmanageable orphan just because the previous process was intentionally restart-resilient.
   */
  async shutdown(): Promise<void> {
    for (const row of discoverRecords()) {
      const active = row.policy?.persistentProcesses === true;
      if (!active) await this.terminateProcess(row.record.sessionId);
    }
  }
}

export const persistentProjectProcesses = new PersistentProjectProcessManager();

export function persistentExecOwner(sessionId: number): string | null | undefined {
  const row = located(sessionId);
  if (!row) return undefined;
  return row.record.ownerConversationId;
}

export function notePersistentExecOwner(sessionId: number, conversationId: string | null): boolean {
  const row = located(sessionId);
  if (!row) return false;
  row.record.ownerConversationId = conversationId;
  persist(row);
  return true;
}

export function forgetPersistentExecOwner(sessionId: number): void {
  const row = located(sessionId);
  if (!row) return;
  row.record.ownerConversationId = null;
  persist(row);
}

export function movePersistentExecOwners(fromConversationId: string, toConversationId: string): number {
  if (!fromConversationId || !toConversationId || fromConversationId === toConversationId) return 0;
  let moved = 0;
  for (const row of discoverRecords()) {
    if (row.record.ownerConversationId !== fromConversationId) continue;
    row.record.ownerConversationId = toConversationId;
    persist(row);
    moved += 1;
  }
  return moved;
}

/** Test/support diagnostic: persisted rows, without commands, output, native paths or child argv. */
export function persistentExecDiagnostics(): Array<{
  sessionId: number;
  rootName: string;
  running: boolean;
  active: boolean;
  startedAt: number;
  outputBytes: number;
}> {
  return discoverRecords().map((row) => {
    let outputBytes = 0;
    try {
      outputBytes = nodeFs.statSync(row.logPath).size;
    } catch {
      // absent output is zero bytes
    }
    return {
      sessionId: row.record.sessionId,
      rootName: row.record.rootName,
      running: !processFinished(row).finished,
      active: row.policy?.persistentProcesses === true,
      startedAt: row.record.startedAt,
      outputBytes
    };
  });
}

/** Used by the wrapper allocator to avoid recycling an id that survived an app restart. */
export function persistentSessionIds(): Set<number> {
  return new Set(discoverRecords().map((row) => row.record.sessionId));
}

/** Active profiles only, exported for shutdown/status tests without exposing native root paths. */
export function activePersistentRootNames(): string[] {
  return activeProjectAutonomyPolicies()
    .filter((policy) => policy.persistentProcesses)
    .map((policy) => policy.rootName);
}

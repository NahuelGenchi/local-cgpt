import nodeFs from 'node:fs';
import nodePath from 'node:path';
import { getConfig } from './config.js';

/**
 * Project-local autonomy is an opt-in *profile*, never a permission source.
 *
 * Enabling it requires two independent gates: the app-owned `projectAutonomy` capability and a
 * strict marker inside an already-approved root. The repository controls only the second gate.
 * It therefore cannot grant itself persistence/network/command authority merely by committing a
 * marker. Network and command remain independent app-owned capabilities as well.
 */
export const POKEMING_AUTONOMY_PROFILE = 'pokeming-world-autonomous' as const;
export const PROJECT_AUTONOMY_MARKER = '.local/local-cgpt/profile.json';
export const PROJECT_AUTONOMY_TASK = '.local/local-cgpt/task.json';
const PROFILE_MAX_BYTES = 8 * 1024;
const DEFAULT_MAX_LOG_BYTES = 64 * 1024 * 1024;
const MIN_MAX_LOG_BYTES = 1024 * 1024;
const MAX_MAX_LOG_BYTES = 256 * 1024 * 1024;
const PROJECT_STATE_SEGMENTS = ['.local', 'local-cgpt'] as const;
// Linux O_PATH. Node does not expose it consistently through fs.constants on supported Node 22.
const O_PATH = 0o10000000;

interface StoredProjectAutonomyProfile {
  version: 1;
  profile: typeof POKEMING_AUTONOMY_PROFILE;
  network?: boolean;
  persistentProcesses?: boolean;
  persistentHome?: boolean;
  maxLogBytes?: number;
}

export interface ProjectAutonomyPolicy {
  profile: typeof POKEMING_AUTONOMY_PROFILE;
  rootName: string;
  rootPath: string;
  virtualRoot: string;
  projectStateDir: string;
  homeDir: string;
  taskPath: string;
  allowNetwork: boolean;
  persistentProcesses: boolean;
  persistentHome: boolean;
  maxLogBytes: number;
}

function integerBetween(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}

function parseProfile(raw: string): StoredProjectAutonomyProfile | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const object = value as Record<string, unknown>;
  const allowed = new Set(['version', 'profile', 'network', 'persistentProcesses', 'persistentHome', 'maxLogBytes']);
  if (Object.keys(object).some((key) => !allowed.has(key))) return null;
  if (object.version !== 1 || object.profile !== POKEMING_AUTONOMY_PROFILE) return null;
  for (const key of ['network', 'persistentProcesses', 'persistentHome'] as const) {
    if (object[key] !== undefined && typeof object[key] !== 'boolean') return null;
  }
  if (
    object.maxLogBytes !== undefined &&
    !integerBetween(object.maxLogBytes, MIN_MAX_LOG_BYTES, MAX_MAX_LOG_BYTES)
  ) {
    return null;
  }
  return object as unknown as StoredProjectAutonomyProfile;
}

function fdPath(fd: number): string {
  return `/proc/self/fd/${fd}`;
}

function childPath(fd: number, name: string): string {
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\0')) {
    throw new Error('invalid autonomous project-state path component');
  }
  return `${fdPath(fd)}/${name}`;
}

function closeQuietly(fd: number): void {
  try {
    nodeFs.closeSync(fd);
  } catch {
    // best effort while unwinding another filesystem error
  }
}

/**
 * Open the approved root as a stable kernel object before touching model-writable descendants.
 *
 * This mirrors the hardened contained-fs boundary used by normal filesystem tools: no descendant
 * pathname is trusted after validation, every directory component is opened with O_NOFOLLOW, and
 * later operations are relative to a held parent FD through /proc/self/fd. A model racing `.local`
 * into a symlink can therefore make the operation fail, but cannot redirect app-main I/O outside
 * the approved root.
 */
function openApprovedRoot(rootPath: string): number {
  if (process.platform !== 'linux') throw new Error('project autonomy state is Linux-only');
  const expected = nodePath.resolve(rootPath);
  const fd = nodeFs.openSync(
    expected,
    O_PATH | nodeFs.constants.O_DIRECTORY | nodeFs.constants.O_NOFOLLOW
  );
  try {
    const opened = nodePath.resolve(nodeFs.realpathSync.native(fdPath(fd)));
    if (opened !== expected || !nodeFs.fstatSync(fd).isDirectory()) {
      throw new Error('approved project root changed identity');
    }
    return fd;
  } catch (error) {
    closeQuietly(fd);
    throw error;
  }
}

function openChildDirectory(parentFd: number, name: string): number {
  return nodeFs.openSync(
    childPath(parentFd, name),
    O_PATH | nodeFs.constants.O_DIRECTORY | nodeFs.constants.O_NOFOLLOW
  );
}

function ensureChildDirectory(parentFd: number, name: string, mode = 0o700): number {
  try {
    return openChildDirectory(parentFd, name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    nodeFs.mkdirSync(childPath(parentFd, name), { mode });
    return openChildDirectory(parentFd, name);
  }
}

function openProjectStateDirectory(rootPath: string, create: boolean): number {
  let fd = openApprovedRoot(rootPath);
  try {
    for (const segment of PROJECT_STATE_SEGMENTS) {
      const next = create ? ensureChildDirectory(fd, segment) : openChildDirectory(fd, segment);
      closeQuietly(fd);
      fd = next;
    }
    return fd;
  } catch (error) {
    closeQuietly(fd);
    throw error;
  }
}

function readProjectStateFile(rootPath: string, name: string, maxBytes: number): string | null {
  let parentFd: number | null = null;
  let fileFd: number | null = null;
  try {
    parentFd = openProjectStateDirectory(rootPath, false);
    fileFd = nodeFs.openSync(
      childPath(parentFd, name),
      nodeFs.constants.O_RDONLY | nodeFs.constants.O_NOFOLLOW
    );
    const stat = nodeFs.fstatSync(fileFd);
    if (!stat.isFile() || stat.size > maxBytes) return null;
    return nodeFs.readFileSync(fileFd, 'utf8');
  } catch {
    return null;
  } finally {
    if (fileFd !== null) closeQuietly(fileFd);
    if (parentFd !== null) closeQuietly(parentFd);
  }
}

function createProjectStateFile(rootPath: string, name: string, content: string, mode: number): boolean {
  let parentFd: number | null = null;
  let fileFd: number | null = null;
  try {
    parentFd = openProjectStateDirectory(rootPath, true);
    fileFd = nodeFs.openSync(
      childPath(parentFd, name),
      nodeFs.constants.O_WRONLY |
        nodeFs.constants.O_CREAT |
        nodeFs.constants.O_EXCL |
        nodeFs.constants.O_NOFOLLOW,
      mode
    );
    nodeFs.writeFileSync(fileFd, content, 'utf8');
    return true;
  } catch {
    return false;
  } finally {
    if (fileFd !== null) closeQuietly(fileFd);
    if (parentFd !== null) closeQuietly(parentFd);
  }
}

function safeMarker(rootPath: string): StoredProjectAutonomyProfile | null {
  const raw = readProjectStateFile(rootPath, 'profile.json', PROFILE_MAX_BYTES);
  return raw === null ? null : parseProfile(raw);
}

function rootNameFromVirtualCwd(displayCwd: string): string | null {
  if (!displayCwd.startsWith('/')) return null;
  const [name] = displayCwd.slice(1).split('/');
  return name || null;
}

/**
 * Resolve the autonomy policy for a model-visible cwd.
 *
 * Fail closed at every ambiguity: unsupported host, no approved root, read-only mode, command or
 * project-autonomy authority disabled, malformed/symlinked marker, or unknown profile all mean
 * ordinary local-cgpt behavior. The marker can narrow features but can never widen the live
 * capability set.
 */
export function projectAutonomyForVirtualCwd(displayCwd: string): ProjectAutonomyPolicy | null {
  // The launch transformation and restart fingerprints rely on Bubblewrap and Linux /proc. Never
  // attempt to approximate them on a platform whose security model has not been reviewed.
  if (process.platform !== 'linux') return null;
  const rootName = rootNameFromVirtualCwd(displayCwd);
  if (!rootName) return null;
  const config = getConfig();
  if (config.readOnly || !config.capabilities.command || !config.capabilities.projectAutonomy) return null;
  const root = config.roots.find((candidate) => candidate.name === rootName);
  if (!root) return null;
  const stored = safeMarker(root.path);
  if (!stored) return null;

  const projectStateDir = nodePath.join(root.path, '.local', 'local-cgpt');
  return {
    profile: POKEMING_AUTONOMY_PROFILE,
    rootName,
    rootPath: root.path,
    virtualRoot: `/${root.name}`,
    projectStateDir,
    homeDir: nodePath.join(projectStateDir, 'home'),
    taskPath: nodePath.join(root.path, PROJECT_AUTONOMY_TASK),
    allowNetwork: (stored.network ?? true) && config.capabilities.network,
    persistentProcesses: stored.persistentProcesses ?? true,
    persistentHome: stored.persistentHome ?? true,
    maxLogBytes: stored.maxLogBytes ?? DEFAULT_MAX_LOG_BYTES
  };
}

/** All currently opted-in project roots, used for bounded process reconciliation/status only. */
export function activeProjectAutonomyPolicies(): ProjectAutonomyPolicy[] {
  const config = getConfig();
  if (config.readOnly || !config.capabilities.command || !config.capabilities.projectAutonomy) return [];
  const policies: ProjectAutonomyPolicy[] = [];
  for (const root of config.roots) {
    const policy = projectAutonomyForVirtualCwd(`/${root.name}`);
    if (policy) policies.push(policy);
  }
  return policies;
}

/**
 * Create only project-owned generated/cache directories inside the already-approved root.
 * Every component is created/opened relative to a stable directory FD, never by reopening a
 * model-mutable pathname after validation.
 */
export function prepareProjectAutonomyDirectories(policy: ProjectAutonomyPolicy): void {
  let stateFd: number | null = null;
  let homeFd: number | null = null;
  try {
    stateFd = openProjectStateDirectory(policy.rootPath, true);
    if (!policy.persistentHome) return;

    homeFd = ensureChildDirectory(stateFd, 'home');
    for (const name of ['.config', '.cache', '.cargo'] as const) {
      const child = ensureChildDirectory(homeFd, name);
      closeQuietly(child);
    }
    const local = ensureChildDirectory(homeFd, '.local');
    try {
      const share = ensureChildDirectory(local, 'share');
      closeQuietly(share);
    } finally {
      closeQuietly(local);
    }
  } finally {
    if (homeFd !== null) closeQuietly(homeFd);
    if (stateFd !== null) closeQuietly(stateFd);
  }
}

/** Stable-FD read for the untrusted detailed task checkpoint. */
export function readProjectAutonomyTaskText(policy: ProjectAutonomyPolicy, maxBytes: number): string | null {
  return readProjectStateFile(policy.rootPath, 'task.json', maxBytes);
}

/** Stable-parent exclusive creation for the initial untrusted detailed task checkpoint. */
export function createProjectAutonomyTaskText(policy: ProjectAutonomyPolicy, content: string): boolean {
  return createProjectStateFile(policy.rootPath, 'task.json', content, 0o600);
}

/**
 * Project the explicit profile into the already-reviewed Bubblewrap launch.
 *
 * The approved root is already the only writable host mount and is mounted at its canonical native
 * path. Persistent HOME/XDG therefore point at the state directory *through that existing root
 * mount* rather than adding a second bind whose model-controlled source pathname could be swapped
 * before Bubblewrap opened it. Network namespace sharing, Cargo policy and pdeath behavior remain
 * the only other changes. If the expected Bubblewrap shape is absent, fail closed.
 */
export function applyProjectAutonomyToLaunch(
  command: readonly string[],
  policy: ProjectAutonomyPolicy,
  options: { surviveParent: boolean }
): string[] {
  const out = [...command];
  const unshare = out.indexOf('--unshare-all');
  const chdir = out.indexOf('--chdir');
  if (unshare < 0 || chdir < 0 || chdir <= unshare) {
    throw new Error('AUTONOMY_SANDBOX_SHAPE: expected Bubblewrap launch arguments were not present');
  }

  if (policy.allowNetwork && !out.includes('--share-net')) {
    // --unshare-all first removes host networking; --share-net opts only the network namespace
    // back in. The existing seccomp AF_VSOCK/io_uring restrictions remain in the argv unchanged.
    out.splice(unshare + 1, 0, '--share-net');
  }

  if (policy.persistentHome) {
    prepareProjectAutonomyDirectories(policy);
    const values = new Map<string, string>([
      ['HOME', policy.homeDir],
      ['XDG_CONFIG_HOME', nodePath.join(policy.homeDir, '.config')],
      ['XDG_CACHE_HOME', nodePath.join(policy.homeDir, '.cache')],
      ['XDG_DATA_HOME', nodePath.join(policy.homeDir, '.local', 'share')]
    ]);
    const seen = new Set<string>();
    for (let index = 0; index + 2 < out.length; index += 1) {
      if (out[index] !== '--setenv') continue;
      const name = out[index + 1]!;
      const value = values.get(name);
      if (value === undefined) continue;
      out[index + 2] = value;
      seen.add(name);
    }
    for (const name of values.keys()) {
      if (!seen.has(name)) {
        throw new Error(`AUTONOMY_SANDBOX_SHAPE: expected ${name} environment projection was not present`);
      }
    }
  }

  if (policy.allowNetwork) {
    // The normal Rust projection is intentionally offline and may point CARGO_HOME at a host
    // cache parent whose selected public crates.io children are mounted read-only. Autonomous
    // online work must never turn that parent into writable host authority or expose credentials,
    // so Cargo writes into the persistent HOME inside the already-approved project root instead.
    for (let index = 0; index + 2 < out.length; index += 1) {
      if (out[index] !== '--setenv') continue;
      if (out[index + 1] === 'CARGO_NET_OFFLINE') out[index + 2] = 'false';
      if (out[index + 1] === 'CARGO_HOME') out[index + 2] = nodePath.join(policy.homeDir, '.cargo');
    }
  }

  if (options.surviveParent) {
    const dieWithParent = out.indexOf('--die-with-parent');
    if (dieWithParent >= 0) out.splice(dieWithParent, 1);
  }
  return out;
}

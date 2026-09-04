import nodeFs from 'node:fs';
import nodePath from 'node:path';
import { getConfig } from './config.js';

/**
 * Project-local autonomy is an opt-in *profile*, never a permission source.
 *
 * The marker lives inside an already-approved root and may only select behavior for authority
 * the user has granted globally. In particular, `network: true` is inert unless the app's
 * independent network capability is live. A repository can therefore ask for a profile, but it
 * cannot grant itself filesystem, command or network authority.
 */
export const POKEMING_AUTONOMY_PROFILE = 'pokeming-world-autonomous' as const;
export const PROJECT_AUTONOMY_MARKER = '.local/local-cgpt/profile.json';
export const PROJECT_AUTONOMY_TASK = '.local/local-cgpt/task.json';
const PROFILE_MAX_BYTES = 8 * 1024;
const DEFAULT_MAX_LOG_BYTES = 64 * 1024 * 1024;
const MIN_MAX_LOG_BYTES = 1024 * 1024;
const MAX_MAX_LOG_BYTES = 256 * 1024 * 1024;
const SANDBOX_HOME = '/run/local-cgpt/home';

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
  runtimeDir: string;
  homeDir: string;
  taskPath: string;
  allowNetwork: boolean;
  persistentProcesses: boolean;
  persistentHome: boolean;
  maxLogBytes: number;
}

function inside(parent: string, child: string): boolean {
  const relative = nodePath.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${nodePath.sep}`) && relative !== '..' && !nodePath.isAbsolute(relative));
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

function safeMarker(rootPath: string): StoredProjectAutonomyProfile | null {
  const marker = nodePath.join(rootPath, PROJECT_AUTONOMY_MARKER);
  try {
    const stat = nodeFs.lstatSync(marker);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > PROFILE_MAX_BYTES) return null;
    const canonicalRoot = nodeFs.realpathSync.native(rootPath);
    const canonicalMarker = nodeFs.realpathSync.native(marker);
    if (!inside(canonicalRoot, canonicalMarker)) return null;
    return parseProfile(nodeFs.readFileSync(canonicalMarker, 'utf8'));
  } catch {
    return null;
  }
}

function rootNameFromVirtualCwd(displayCwd: string): string | null {
  if (!displayCwd.startsWith('/')) return null;
  const [name] = displayCwd.slice(1).split('/');
  return name || null;
}

/**
 * Resolve the autonomy policy for a model-visible cwd.
 *
 * Fail closed at every ambiguity: no approved root, read-only mode, command disabled, malformed
 * marker, symlinked marker, or unknown profile all mean ordinary local-cgpt behavior. The profile
 * can narrow its own features but can never widen the live capability set.
 */
export function projectAutonomyForVirtualCwd(displayCwd: string): ProjectAutonomyPolicy | null {
  const rootName = rootNameFromVirtualCwd(displayCwd);
  if (!rootName) return null;
  const config = getConfig();
  if (config.readOnly || !config.capabilities.command) return null;
  const root = config.roots.find((candidate) => candidate.name === rootName);
  if (!root) return null;
  const stored = safeMarker(root.path);
  if (!stored) return null;

  const localDir = nodePath.join(root.path, '.local', 'local-cgpt');
  return {
    profile: POKEMING_AUTONOMY_PROFILE,
    rootName,
    rootPath: root.path,
    virtualRoot: `/${root.name}`,
    runtimeDir: nodePath.join(localDir, 'runtime'),
    homeDir: nodePath.join(localDir, 'home'),
    taskPath: nodePath.join(root.path, PROJECT_AUTONOMY_TASK),
    // The project marker is only intent. Network remains independently user-granted authority.
    allowNetwork: (stored.network ?? true) && config.capabilities.network,
    persistentProcesses: stored.persistentProcesses ?? true,
    persistentHome: stored.persistentHome ?? true,
    maxLogBytes: stored.maxLogBytes ?? DEFAULT_MAX_LOG_BYTES
  };
}

/** All currently opted-in project roots, used only for bounded durable-process reconciliation. */
export function activeProjectAutonomyPolicies(): ProjectAutonomyPolicy[] {
  const config = getConfig();
  if (config.readOnly || !config.capabilities.command) return [];
  const policies: ProjectAutonomyPolicy[] = [];
  for (const root of config.roots) {
    const policy = projectAutonomyForVirtualCwd(`/${root.name}`);
    if (policy) policies.push(policy);
  }
  return policies;
}

/** Create only app-private/generated directories inside the already-approved project root. */
export function prepareProjectAutonomyDirectories(policy: ProjectAutonomyPolicy): void {
  const mode = 0o700;
  nodeFs.mkdirSync(policy.runtimeDir, { recursive: true, mode });
  if (policy.persistentHome) nodeFs.mkdirSync(policy.homeDir, { recursive: true, mode });
}

/**
 * Project the explicit profile into the already-reviewed Bubblewrap launch.
 *
 * This deliberately edits only arguments whose meaning is already fixed by command-sandbox.ts:
 * network namespace sharing, the private HOME mount, Cargo's offline flag, and pdeath behavior.
 * If the expected Bubblewrap shape is absent, throw rather than guessing at an unrelated command.
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
    out.splice(unshare + 1, 0, '--share-net');
  }

  if (policy.persistentHome) {
    prepareProjectAutonomyDirectories(policy);
    const currentChdir = out.indexOf('--chdir');
    const alreadyBound = out.some(
      (value, index) => value === '--bind' && out[index + 1] === policy.homeDir && out[index + 2] === SANDBOX_HOME
    );
    if (!alreadyBound) out.splice(currentChdir, 0, '--bind', policy.homeDir, SANDBOX_HOME);
  }

  if (policy.allowNetwork) {
    for (let index = 0; index + 2 < out.length; index += 1) {
      if (out[index] === '--setenv' && out[index + 1] === 'CARGO_NET_OFFLINE') out[index + 2] = 'false';
    }
  }

  if (options.surviveParent) {
    const dieWithParent = out.indexOf('--die-with-parent');
    if (dieWithParent >= 0) out.splice(dieWithParent, 1);
  }
  return out;
}

export function persistentProcessMetadataPath(policy: ProjectAutonomyPolicy, sessionId: number): string {
  return nodePath.join(policy.runtimeDir, `process-${sessionId}.json`);
}

export function persistentProcessLogPath(policy: ProjectAutonomyPolicy, sessionId: number): string {
  return nodePath.join(policy.runtimeDir, `process-${sessionId}.log`);
}

export function persistentProcessExitPath(policy: ProjectAutonomyPolicy, sessionId: number): string {
  return nodePath.join(policy.runtimeDir, `process-${sessionId}.exit`);
}

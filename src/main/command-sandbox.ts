import { accessSync, constants, existsSync, statSync } from 'node:fs';
import nodePath from 'node:path';
import type { Root } from '../shared/types.js';

export class CommandSandboxError extends Error {
  readonly code: 'UNSUPPORTED_PLATFORM' | 'BUBBLEWRAP_MISSING' | 'INVALID_WORKDIR';

  constructor(code: CommandSandboxError['code'], message: string) {
    super(message);
    this.name = 'CommandSandboxError';
    this.code = code;
  }
}

export interface CommandSandboxLaunch {
  command: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface CommandSandboxInput {
  command: readonly string[];
  cwd: string;
  roots: readonly Root[];
  env: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  bubblewrapPath?: string | null;
  /** Host paths required by the app runtime itself, mounted read-only inside the sandbox. */
  runtimeReadPaths?: readonly string[];
}

const SAFE_SYSTEM_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const SYSTEM_BINDS = ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc'] as const;
const PRIVATE_RUNTIME = '/run/local-cgpt';
const SANDBOX_HOME = `${PRIVATE_RUNTIME}/home`;
const SANDBOX_TMP = `${PRIVATE_RUNTIME}/tmp`;

let testBypass = false;

/** Test harness only. Production callers cannot disable command containment. */
export function setCommandSandboxBypassForTests(enabled: boolean): void {
  if (process.env.VITEST !== 'true') {
    throw new Error('setCommandSandboxBypassForTests is available only under Vitest');
  }
  testBypass = enabled;
}

function executable(candidate: string): boolean {
  try {
    return statSync(candidate).isFile() && (accessSync(candidate, constants.X_OK), true);
  } catch {
    return false;
  }
}

export function locateBubblewrap(): string | null {
  for (const candidate of ['/usr/bin/bwrap', '/bin/bwrap']) {
    if (executable(candidate)) return candidate;
  }
  return null;
}

function inside(parent: string, child: string): boolean {
  const relative = nodePath.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${nodePath.sep}`) && relative !== '..' && !nodePath.isAbsolute(relative));
}

function uniquePaths(paths: readonly string[]): string[] {
  const resolved = paths
    .map((entry) => nodePath.resolve(entry))
    .filter((entry, index, all) => all.indexOf(entry) === index)
    .sort((a, b) => a.length - b.length);
  return resolved.filter((entry, index) => !resolved.slice(0, index).some((parent) => inside(parent, entry)));
}

function uniqueRoots(roots: readonly Root[]): string[] {
  return uniquePaths(roots.map((root) => root.path));
}

function parentDirectories(target: string): string[] {
  const dirs: string[] = [];
  let current = nodePath.dirname(target);
  while (current !== '/' && current !== '.') {
    dirs.push(current);
    current = nodePath.dirname(current);
  }
  return dirs.reverse();
}

function setEnv(args: string[], name: string, value: string): void {
  args.push('--setenv', name, value);
}

function coveredBySystemBind(candidate: string): boolean {
  return SYSTEM_BINDS.some((system) => inside(system, candidate));
}

/**
 * Build the Linux Bubblewrap launch without executing anything. The sandbox starts from an
 * empty mount namespace: system runtime directories are read-only, approved roots are the
 * only host paths mounted read/write, app-owned runtime files are read-only, /tmp is private,
 * HOME/XDG point into a private tmpfs, and --unshare-all removes network access as well as the
 * other host namespaces.
 */
export function buildBubblewrapLaunch(input: CommandSandboxInput, bwrap: string): CommandSandboxLaunch {
  const cwd = nodePath.resolve(input.cwd);
  const roots = uniqueRoots(input.roots);
  if (!roots.some((root) => inside(root, cwd))) {
    throw new CommandSandboxError('INVALID_WORKDIR', 'Command working directory is outside the approved roots.');
  }

  const args: string[] = [
    '--die-with-parent',
    '--new-session',
    '--unshare-all',
    '--proc', '/proc',
    '--dev', '/dev',
    '--dir', '/tmp',
    '--dir', '/run',
    '--tmpfs', PRIVATE_RUNTIME,
    '--dir', SANDBOX_HOME,
    '--dir', SANDBOX_TMP
  ];

  for (const source of SYSTEM_BINDS) {
    if (existsSync(source)) args.push('--ro-bind', source, source);
  }

  const created = new Set<string>(['/tmp', '/run', PRIVATE_RUNTIME, SANDBOX_HOME, SANDBOX_TMP]);
  for (const root of roots) {
    for (const dir of parentDirectories(root)) {
      if (!created.has(dir) && !coveredBySystemBind(dir)) {
        args.push('--dir', dir);
        created.add(dir);
      }
    }
    args.push('--bind', root, root);
  }

  const runtimeReadPaths = uniquePaths(input.runtimeReadPaths ?? []).filter(
    (entry) => existsSync(entry) && !coveredBySystemBind(entry) && !roots.some((root) => inside(root, entry))
  );
  for (const source of runtimeReadPaths) {
    for (const dir of parentDirectories(source)) {
      if (!created.has(dir) && !coveredBySystemBind(dir)) {
        args.push('--dir', dir);
        created.add(dir);
      }
    }
    args.push('--ro-bind', source, source);
  }

  args.push('--chdir', cwd);
  args.push('--clearenv');
  setEnv(args, 'HOME', SANDBOX_HOME);
  setEnv(args, 'TMPDIR', SANDBOX_TMP);
  setEnv(args, 'XDG_CONFIG_HOME', `${SANDBOX_HOME}/.config`);
  setEnv(args, 'XDG_CACHE_HOME', `${SANDBOX_HOME}/.cache`);
  setEnv(args, 'XDG_DATA_HOME', `${SANDBOX_HOME}/.local/share`);
  setEnv(args, 'PATH', SAFE_SYSTEM_PATH);
  setEnv(args, 'LANG', input.env.LANG ?? 'C.UTF-8');
  setEnv(args, 'LC_ALL', input.env.LC_ALL ?? 'C.UTF-8');
  if (input.env.TERM) setEnv(args, 'TERM', input.env.TERM);
  if (input.env.COLORTERM) setEnv(args, 'COLORTERM', input.env.COLORTERM);
  args.push('--', ...input.command);

  return {
    command: [bwrap, ...args],
    // Bubblewrap performs the authoritative chdir after entering the namespace. Starting the
    // wrapper itself from / avoids giving child_process an additional host-path dependency.
    cwd: '/',
    env: input.env
  };
}

export function sandboxCommandLaunch(input: CommandSandboxInput): CommandSandboxLaunch {
  if (testBypass && process.env.VITEST === 'true') {
    return { command: [...input.command], cwd: input.cwd, env: input.env };
  }

  const platform = input.platform ?? process.platform;
  if (platform !== 'linux') {
    throw new CommandSandboxError(
      'UNSUPPORTED_PLATFORM',
      'Command execution is disabled on this platform in the hardened build because no OS sandbox backend is available.'
    );
  }

  const bwrap = input.bubblewrapPath === undefined ? locateBubblewrap() : input.bubblewrapPath;
  if (!bwrap) {
    throw new CommandSandboxError(
      'BUBBLEWRAP_MISSING',
      'Command execution requires Bubblewrap (bwrap) in the hardened Linux build. Install bubblewrap or keep command permission disabled.'
    );
  }
  return buildBubblewrapLaunch(input, bwrap);
}

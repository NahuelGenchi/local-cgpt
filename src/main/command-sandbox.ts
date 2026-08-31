import { accessSync, constants, existsSync, realpathSync, statSync } from 'node:fs';
import nodePath from 'node:path';
import type { Root } from '../shared/types.js';
import { discoverLinuxRustToolchain } from './linux-toolchain.js';

export class CommandSandboxError extends Error {
  readonly code:
    | 'UNSUPPORTED_PLATFORM'
    | 'UNSUPPORTED_ARCH'
    | 'BUBBLEWRAP_MISSING'
    | 'SECCOMP_LAUNCHER_MISSING'
    | 'INVALID_WORKDIR'
    | 'INVALID_ROOT'
    | 'INVALID_RUNTIME_PATH';

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
  /** Trusted executable directories. Each must live inside one of runtimeReadPaths. */
  runtimePathEntries?: readonly string[];
  /**
   * Cargo cache parent inside the sandbox. Only explicitly mounted read-only registry/git children
   * become host-backed; credentials/config at this path remain absent in the private namespace.
   */
  cargoHome?: string | null;
}

const SAFE_SYSTEM_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const SYSTEM_BINDS = ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc'] as const;
const PRIVATE_RUNTIME = '/run/local-cgpt';
const SANDBOX_HOME = `${PRIVATE_RUNTIME}/home`;
const SANDBOX_TMP = `${PRIVATE_RUNTIME}/tmp`;
const SECCOMP_FILTER_FD = 3;
const AF_VSOCK = 40;
const IO_URING_SETUP_SYSCALL = 425;
const BPF_LD_W_ABS = 0x20;
const BPF_JMP_JEQ_K = 0x15;
const BPF_ALU_AND_K = 0x54;
const BPF_RET_K = 0x06;
const SECCOMP_RET_KILL_PROCESS = 0x80000000;
const SECCOMP_RET_ERRNO = 0x00050000;
const SECCOMP_RET_ALLOW = 0x7fff0000;
const EPERM = 1;
const SECCOMP_DATA_NR_OFFSET = 0;
const SECCOMP_DATA_ARCH_OFFSET = 4;
const SECCOMP_DATA_ARG0_OFFSET = 16;
const X32_SYSCALL_BIT = 0x40000000;
const SECCOMP_LAUNCHER_SCRIPT = `exec ${SECCOMP_FILTER_FD}< <(printf '%b' "$1"); shift; exec -c "$@"`;

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

function locateSeccompLauncher(): string | null {
  for (const candidate of ['/bin/bash', '/usr/bin/bash']) {
    if (executable(candidate)) return candidate;
  }
  return null;
}

interface SockFilterInstruction {
  code: number;
  jt: number;
  jf: number;
  k: number;
}

interface SeccompArchitecture {
  auditArch: number;
  socketSyscall: number;
  maskX32: boolean;
}

function seccompArchitecture(arch: NodeJS.Architecture): SeccompArchitecture {
  switch (arch) {
    case 'x64':
      return { auditArch: 0xc000003e, socketSyscall: 41, maskX32: true };
    case 'arm64':
      return { auditArch: 0xc00000b7, socketSyscall: 198, maskX32: false };
    default:
      throw new CommandSandboxError(
        'UNSUPPORTED_ARCH',
        `Command execution is disabled on unsupported Linux architecture ${arch}; the seccomp network filter has no reviewed syscall mapping for it.`
      );
  }
}

function serializeSockFilters(instructions: readonly SockFilterInstruction[]): Buffer {
  const out = Buffer.alloc(instructions.length * 8);
  for (const [index, instruction] of instructions.entries()) {
    const offset = index * 8;
    out.writeUInt16LE(instruction.code, offset);
    out.writeUInt8(instruction.jt, offset + 2);
    out.writeUInt8(instruction.jf, offset + 3);
    out.writeUInt32LE(instruction.k >>> 0, offset + 4);
  }
  return out;
}

/**
 * Compile the small seccomp cBPF program that closes a network-namespace gap in Linux VSOCK.
 *
 * AF_VSOCK is specifically designed for guest <-> host communication independent of the VM's
 * ordinary network configuration. That makes a network namespace insufficient as a complete
 * host-network boundary on kernels/transports where VSOCK is global. We deny socket(AF_VSOCK)
 * directly. Linux io_uring can issue IORING_OP_SOCKET without making the socket(2) syscall, so
 * io_uring_setup is denied as well; otherwise the address-family check would be bypassable.
 *
 * The arch check fails closed for foreign ABIs. x86-64's x32 syscall bit is masked before the
 * syscall-number comparisons so x32 cannot bypass either rule.
 */
export function buildCommandNetworkSeccompFilter(arch: NodeJS.Architecture = process.arch): Buffer {
  const spec = seccompArchitecture(arch);
  const instructions: SockFilterInstruction[] = [
    { code: BPF_LD_W_ABS, jt: 0, jf: 0, k: SECCOMP_DATA_ARCH_OFFSET },
    { code: BPF_JMP_JEQ_K, jt: 1, jf: 0, k: spec.auditArch },
    { code: BPF_RET_K, jt: 0, jf: 0, k: SECCOMP_RET_KILL_PROCESS },
    { code: BPF_LD_W_ABS, jt: 0, jf: 0, k: SECCOMP_DATA_NR_OFFSET }
  ];
  if (spec.maskX32) {
    instructions.push({ code: BPF_ALU_AND_K, jt: 0, jf: 0, k: (~X32_SYSCALL_BIT) >>> 0 });
  }
  instructions.push(
    // True jumps three instructions forward to the EPERM return.
    { code: BPF_JMP_JEQ_K, jt: 3, jf: 0, k: IO_URING_SETUP_SYSCALL },
    // Non-socket syscalls jump three instructions forward to ALLOW.
    { code: BPF_JMP_JEQ_K, jt: 0, jf: 3, k: spec.socketSyscall },
    { code: BPF_LD_W_ABS, jt: 0, jf: 0, k: SECCOMP_DATA_ARG0_OFFSET },
    // A non-VSOCK domain skips the EPERM return and is allowed.
    { code: BPF_JMP_JEQ_K, jt: 0, jf: 1, k: AF_VSOCK },
    { code: BPF_RET_K, jt: 0, jf: 0, k: SECCOMP_RET_ERRNO | EPERM },
    { code: BPF_RET_K, jt: 0, jf: 0, k: SECCOMP_RET_ALLOW }
  );
  return serializeSockFilters(instructions);
}

function bashEscapedBytes(bytes: Buffer): string {
  return Array.from(bytes, (byte) => `\\x${byte.toString(16).padStart(2, '0')}`).join('');
}

function inside(parent: string, child: string): boolean {
  const relative = nodePath.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${nodePath.sep}`) && relative !== '..' && !nodePath.isAbsolute(relative));
}

function filesystemRoot(candidate: string): boolean {
  const resolved = nodePath.resolve(candidate);
  return nodePath.parse(resolved).root === resolved;
}

function validatedMountPath(
  candidate: string,
  code: 'INVALID_ROOT' | 'INVALID_RUNTIME_PATH',
  label: string
): string {
  if (!nodePath.isAbsolute(candidate)) {
    throw new CommandSandboxError(code, `${label} must be an absolute host path.`);
  }
  const resolved = nodePath.resolve(candidate);
  if (filesystemRoot(resolved)) {
    throw new CommandSandboxError(code, `${label} cannot be the filesystem root.`);
  }
  return resolved;
}

function uniquePaths(paths: readonly string[]): string[] {
  const resolved = paths
    .map((entry) => nodePath.resolve(entry))
    .filter((entry, index, all) => all.indexOf(entry) === index)
    .sort((a, b) => a.length - b.length);
  return resolved.filter((entry, index) => !resolved.slice(0, index).some((parent) => inside(parent, entry)));
}

function uniqueRoots(roots: readonly Root[]): string[] {
  for (const root of roots) validatedMountPath(root.path, 'INVALID_ROOT', 'Approved root');
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
 * Revalidate the host objects that are about to become mount capabilities.
 *
 * Root approval stores canonical paths, but a long-lived desktop process cannot assume those
 * pathnames still identify the same objects when a later command starts. In particular, replacing
 * an approved directory with a symlink would otherwise make Bubblewrap follow the new source and
 * grant write access to its target. CWD is allowed to contain symlinks only when their canonical
 * target remains in an unchanged approved root.
 *
 * This check deliberately happens immediately before constructing the Bubblewrap argv. There is
 * still an unavoidable pathname TOCTOU window until Bubblewrap performs the bind; eliminating that
 * completely would require fd-based bind capabilities to be carried through both node-pty and the
 * non-PTY process manager. The current check removes persistent/stale-root substitution and fails
 * closed when the expected boundary cannot be established.
 */
function revalidateLinuxHostPaths(input: CommandSandboxInput): CommandSandboxInput {
  const roots = input.roots.map((root) => {
    const expected = validatedMountPath(root.path, 'INVALID_ROOT', 'Approved root');
    let current: string;
    try {
      current = realpathSync.native(expected);
      if (!statSync(current).isDirectory()) {
        throw new CommandSandboxError('INVALID_ROOT', `Approved root "/${root.name}" is no longer a directory.`);
      }
    } catch (error) {
      if (error instanceof CommandSandboxError) throw error;
      throw new CommandSandboxError(
        'INVALID_ROOT',
        `Approved root "/${root.name}" is not available or changed on disk. Remove it and approve the folder again.`
      );
    }
    if (current !== expected) {
      throw new CommandSandboxError(
        'INVALID_ROOT',
        `Approved root "/${root.name}" changed on disk. Remove it and approve the folder again.`
      );
    }
    return { ...root, path: current };
  });

  if (!nodePath.isAbsolute(input.cwd)) {
    throw new CommandSandboxError('INVALID_WORKDIR', 'Command working directory must be an absolute host path.');
  }
  let cwd: string;
  try {
    cwd = realpathSync.native(nodePath.resolve(input.cwd));
    if (!statSync(cwd).isDirectory()) {
      throw new CommandSandboxError('INVALID_WORKDIR', 'Command working directory is not a directory.');
    }
  } catch (error) {
    if (error instanceof CommandSandboxError) throw error;
    throw new CommandSandboxError('INVALID_WORKDIR', 'Command working directory is not available.');
  }
  if (!roots.some((root) => inside(root.path, cwd))) {
    throw new CommandSandboxError('INVALID_WORKDIR', 'Command working directory is outside the approved roots.');
  }

  const runtimeReadPaths = (input.runtimeReadPaths ?? []).map((entry) => {
    const resolved = validatedMountPath(entry, 'INVALID_RUNTIME_PATH', 'Runtime read path');
    if (!existsSync(resolved)) return resolved;
    let target: string;
    try {
      target = realpathSync.native(resolved);
    } catch {
      throw new CommandSandboxError('INVALID_RUNTIME_PATH', 'Runtime read path changed before command launch.');
    }
    if (filesystemRoot(target)) {
      throw new CommandSandboxError(
        'INVALID_RUNTIME_PATH',
        'Runtime read path must not resolve to the filesystem root.'
      );
    }
    return resolved;
  });

  return { ...input, cwd, roots, runtimeReadPaths };
}

/**
 * Build the Linux Bubblewrap launch without executing anything. The sandbox starts from an
 * empty mount namespace: system runtime directories are read-only, approved roots are the
 * only host paths mounted read/write, app-owned runtime files are read-only, /tmp is private,
 * HOME/XDG point into a private tmpfs, --unshare-all removes the ordinary host network and
 * other host namespaces, and seccomp blocks AF_VSOCK's independent guest/host channel.
 */
export function buildBubblewrapLaunch(
  input: CommandSandboxInput,
  bwrap: string,
  seccompLauncher = '/bin/bash'
): CommandSandboxLaunch {
  if (!nodePath.isAbsolute(input.cwd)) {
    throw new CommandSandboxError('INVALID_WORKDIR', 'Command working directory must be an absolute host path.');
  }
  const cwd = nodePath.resolve(input.cwd);
  const roots = uniqueRoots(input.roots);
  if (!roots.some((root) => inside(root, cwd))) {
    throw new CommandSandboxError('INVALID_WORKDIR', 'Command working directory is outside the approved roots.');
  }

  const declaredRuntimeReadPaths = (input.runtimeReadPaths ?? []).map((entry) =>
    validatedMountPath(entry, 'INVALID_RUNTIME_PATH', 'Runtime read path')
  );
  const runtimePathEntries = (input.runtimePathEntries ?? []).map((entry) => {
    const resolved = validatedMountPath(entry, 'INVALID_RUNTIME_PATH', 'Runtime PATH entry');
    const backing = declaredRuntimeReadPaths.find((parent) => inside(parent, resolved));
    if (!existsSync(resolved) || !backing || roots.some((root) => inside(root, backing))) {
      throw new CommandSandboxError(
        'INVALID_RUNTIME_PATH',
        'Runtime PATH entries must exist inside an explicitly declared read-only runtime path outside writable roots.'
      );
    }
    return resolved;
  });
  const cargoHome = input.cargoHome
    ? validatedMountPath(input.cargoHome, 'INVALID_RUNTIME_PATH', 'Cargo home')
    : null;
  if (cargoHome) {
    const cachePaths = declaredRuntimeReadPaths.filter((entry) => inside(cargoHome, entry));
    if (
      coveredBySystemBind(cargoHome) ||
      roots.some((root) => inside(root, cargoHome)) ||
      cachePaths.length === 0 ||
      cachePaths.some((entry) => roots.some((root) => inside(root, entry)))
    ) {
      throw new CommandSandboxError(
        'INVALID_RUNTIME_PATH',
        'Cargo home must be an isolated parent of explicitly declared read-only runtime caches outside writable roots.'
      );
    }
  }

  const args: string[] = [
    '--die-with-parent',
    '--new-session',
    '--unshare-all',
    '--seccomp', String(SECCOMP_FILTER_FD),
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

  const runtimeReadPaths = uniquePaths(declaredRuntimeReadPaths).filter(
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
  setEnv(args, 'PATH', [...runtimePathEntries, SAFE_SYSTEM_PATH].join(':'));
  if (cargoHome) {
    setEnv(args, 'CARGO_HOME', cargoHome);
    setEnv(args, 'CARGO_NET_OFFLINE', 'true');
  }
  setEnv(args, 'LANG', input.env.LANG ?? 'C.UTF-8');
  setEnv(args, 'LC_ALL', input.env.LC_ALL ?? 'C.UTF-8');
  if (input.env.TERM) setEnv(args, 'TERM', input.env.TERM);
  if (input.env.COLORTERM) setEnv(args, 'COLORTERM', input.env.COLORTERM);
  args.push('--', ...input.command);

  const seccompFilter = bashEscapedBytes(buildCommandNetworkSeccompFilter());
  return {
    command: [
      seccompLauncher,
      '--noprofile',
      '--norc',
      '-c', SECCOMP_LAUNCHER_SCRIPT,
      'local-cgpt-seccomp-launcher',
      seccompFilter,
      bwrap,
      ...args
    ],
    // Bubblewrap performs the authoritative chdir after entering the namespace. Starting the
    // wrapper itself from / avoids giving child_process an additional host-path dependency.
    cwd: '/',
    // The fixed Bash pre-launcher exists only to provide Bubblewrap's seccomp filter through an
    // inherited pipe FD. It starts with an empty environment and uses `exec -c` so Bubblewrap
    // itself also receives an empty environment. No command text is evaluated by this launcher:
    // the filter and the complete Bubblewrap argv are positional parameters passed with "$@".
    env: {}
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
  // Build the seccomp program before resolving execution helpers so unsupported Linux ABIs fail
  // closed even if a caller supplies a synthetic Bubblewrap path in tests or future code.
  buildCommandNetworkSeccompFilter();
  const bwrap = input.bubblewrapPath === undefined ? locateBubblewrap() : input.bubblewrapPath;
  if (!bwrap) {
    throw new CommandSandboxError(
      'BUBBLEWRAP_MISSING',
      'Command execution requires Bubblewrap (bwrap) in the hardened Linux build. Install bubblewrap or keep command permission disabled.'
    );
  }
  const seccompLauncher = locateSeccompLauncher();
  if (!seccompLauncher) {
    throw new CommandSandboxError(
      'SECCOMP_LAUNCHER_MISSING',
      'Command execution requires Bash to install the Bubblewrap seccomp network filter. Install bash or keep command permission disabled.'
    );
  }

  const rust = discoverLinuxRustToolchain();
  const withTrustedRuntime: CommandSandboxInput = rust
    ? {
        ...input,
        runtimeReadPaths: [...(input.runtimeReadPaths ?? []), ...rust.runtimeReadPaths],
        runtimePathEntries: [...rust.runtimePathEntries, ...(input.runtimePathEntries ?? [])],
        cargoHome: input.cargoHome ?? rust.cargoHome
      }
    : input;
  return buildBubblewrapLaunch(revalidateLinuxHostPaths(withTrustedRuntime), bwrap, seccompLauncher);
}

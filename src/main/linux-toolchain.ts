import { accessSync, constants, existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface LinuxRustSandboxRuntime {
  /** Host paths the command sandbox may mount read-only at the same absolute paths. */
  runtimeReadPaths: string[];
  /** PATH entries proven to live inside one of runtimeReadPaths. */
  runtimePathEntries: string[];
  /** Ephemeral sandbox parent whose registry/git children may be backed by read-only host caches. */
  cargoHome: string | null;
  toolchainRoot: string;
}

export interface LinuxRustDiscoveryOptions {
  platform?: NodeJS.Platform;
  home?: string;
  uid?: number | null;
}

/** Kept for test/API compatibility; discovery intentionally revalidates every command launch. */
export function resetLinuxRustToolchainCache(): void {
  // No cache: compiler provenance is cheap to re-prove and must not outlive host path changes.
}

function currentUid(): number | null {
  return typeof process.getuid === 'function' ? process.getuid() : null;
}

function accountHome(): string | null {
  try {
    const home = os.userInfo().homedir;
    return path.isAbsolute(home) ? path.resolve(home) : null;
  } catch {
    return null;
  }
}

function inside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

/**
 * A host object can become compiler authority only when it is a real, user-owned, non-writable-by-others object.
 *
 * The command sandbox is allowed to execute the selected compiler, so accepting a symlink or a group/world-writable
 * directory here would turn another pathname into executable authority. We deliberately validate only the mount root,
 * bin directory and executables: descendants remain read-only inside Bubblewrap, and an absolute symlink inside the
 * mounted tree cannot expose an unmounted host path.
 */
function trustedHostObject(target: string, uid: number | null, kind: 'file' | 'directory'): boolean {
  try {
    const link = lstatSync(target);
    if (link.isSymbolicLink()) return false;
    const stat = statSync(target);
    if (kind === 'file' ? !stat.isFile() : !stat.isDirectory()) return false;
    if (uid !== null && stat.uid !== uid) return false;
    if ((stat.mode & 0o022) !== 0) return false;
    return realpathSync.native(target) === path.resolve(target);
  } catch {
    return false;
  }
}

function executable(target: string, uid: number | null): boolean {
  if (!trustedHostObject(target, uid, 'file')) return false;
  try {
    accessSync(target, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function configuredDefaultToolchain(settingsPath: string, uid: number | null): string | null {
  if (!trustedHostObject(settingsPath, uid, 'file')) return null;
  let text: string;
  try {
    text = readFileSync(settingsPath, 'utf8');
  } catch {
    return null;
  }
  const match = /^\s*default_toolchain\s*=\s*"([^"\r\n]+)"\s*$/m.exec(text);
  if (!match) return null;
  const name = match[1]!;
  // Rustup toolchain names never need path syntax. Rejecting it makes settings.toml unable to select a mount elsewhere.
  if (!/^[A-Za-z0-9._+\-]+$/.test(name) || name === '.' || name === '..') return null;
  return name;
}

function validToolchain(root: string, uid: number | null): boolean {
  const bin = path.join(root, 'bin');
  return (
    trustedHostObject(root, uid, 'directory') &&
    trustedHostObject(bin, uid, 'directory') &&
    executable(path.join(bin, 'cargo'), uid) &&
    executable(path.join(bin, 'rustc'), uid)
  );
}

function soleValidToolchain(toolchainsRoot: string, uid: number | null): string | null {
  let children: string[];
  try {
    children = readdirSync(toolchainsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => path.join(toolchainsRoot, entry.name));
  } catch {
    return null;
  }
  const valid = children.filter((candidate) => validToolchain(candidate, uid));
  return valid.length === 1 ? valid[0]! : null;
}

function safeCachePath(cargoHome: string, name: 'registry' | 'git', uid: number | null): string | null {
  const candidate = path.join(cargoHome, name);
  if (!existsSync(candidate)) return null;
  if (!trustedHostObject(candidate, uid, 'directory')) return null;
  return candidate;
}

/**
 * Discovers the rustup toolchain owned by the authenticated local Unix account.
 *
 * Nothing here consults project files, PATH, HOME, RUSTUP_HOME, CARGO_HOME or any model-controlled environment.
 * The home directory comes from the OS account database (`os.userInfo`), and rustup's own user-owned settings may
 * select only a basename below that account's `.rustup/toolchains`. If settings are unavailable, discovery succeeds
 * only when exactly one valid concrete toolchain exists. Ambiguity fails closed.
 *
 * This function deliberately does not memoize. A later `exec_command` must re-prove that the same account-owned,
 * canonical, non-writable-by-others objects still occupy the host paths before they become executable authority.
 */
export function discoverLinuxRustToolchain(options: LinuxRustDiscoveryOptions = {}): LinuxRustSandboxRuntime | null {
  const platform = options.platform ?? process.platform;
  if (platform !== 'linux') return null;

  const uid = options.uid === undefined ? currentUid() : options.uid;
  const home = path.resolve(options.home ?? accountHome() ?? '/');
  if (home === '/' || !trustedHostObject(home, uid, 'directory')) return null;

  const rustupHome = path.join(home, '.rustup');
  const toolchainsRoot = path.join(rustupHome, 'toolchains');
  if (!trustedHostObject(rustupHome, uid, 'directory') || !trustedHostObject(toolchainsRoot, uid, 'directory')) {
    return null;
  }

  const configured = configuredDefaultToolchain(path.join(rustupHome, 'settings.toml'), uid);
  const selected = configured ? path.join(toolchainsRoot, configured) : soleValidToolchain(toolchainsRoot, uid);
  if (!selected || !inside(toolchainsRoot, selected) || !validToolchain(selected, uid)) return null;

  const cargoHome = path.join(home, '.cargo');
  const registry = safeCachePath(cargoHome, 'registry', uid);
  const git = safeCachePath(cargoHome, 'git', uid);
  const cachePaths = [registry, git].filter((entry): entry is string => entry !== null);

  return {
    runtimeReadPaths: [selected, ...cachePaths],
    runtimePathEntries: [path.join(selected, 'bin')],
    cargoHome: cachePaths.length > 0 ? cargoHome : null,
    toolchainRoot: selected
  };
}

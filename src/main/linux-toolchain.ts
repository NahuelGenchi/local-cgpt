import { accessSync, constants, existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface LinuxRustSandboxRuntime {
  /** Host paths the command sandbox may mount read-only at the same absolute paths. */
  runtimeReadPaths: string[];
  /** PATH entries proven to live inside one of runtimeReadPaths. */
  runtimePathEntries: string[];
  /**
   * Ephemeral sandbox parent whose explicitly selected public crates.io registry children may
   * be backed by read-only host caches. Cargo config, credentials and git caches are not mounted.
   */
  cargoHome: string | null;
  toolchainRoot: string;
}

export interface LinuxRustDiscoveryOptions {
  platform?: NodeJS.Platform;
  home?: string;
  uid?: number | null;
  gid?: number | null;
}

/** Kept for test/API compatibility; discovery intentionally revalidates every command launch. */
export function resetLinuxRustToolchainCache(): void {
  // No cache: compiler provenance is cheap to re-prove and must not outlive host path changes.
}

function currentUid(): number | null {
  return typeof process.getuid === 'function' ? process.getuid() : null;
}

function currentGid(): number | null {
  return typeof process.getgid === 'function' ? process.getgid() : null;
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
 * A host object can become compiler/cache authority only when it is a real, account-owned,
 * canonical object that is not writable by the world or by a foreign group.
 *
 * Ubuntu commonly uses a per-user primary group together with umask 0002, producing 0775
 * rustup directories. Owner write and primary-GID write are both account authority for this
 * threat model, and the selected tree is mounted read-only inside Bubblewrap. Group write is
 * therefore accepted only when the object's GID exactly matches the authenticated process's
 * primary GID. World-write and foreign-group-write remain fail-closed.
 */
function trustedHostObject(
  target: string,
  uid: number | null,
  gid: number | null,
  kind: 'file' | 'directory'
): boolean {
  try {
    const link = lstatSync(target);
    if (link.isSymbolicLink()) return false;
    const stat = statSync(target);
    if (kind === 'file' ? !stat.isFile() : !stat.isDirectory()) return false;
    if (uid !== null && stat.uid !== uid) return false;
    if ((stat.mode & 0o002) !== 0) return false;
    if ((stat.mode & 0o020) !== 0 && (gid === null || stat.gid !== gid)) return false;
    return realpathSync.native(target) === path.resolve(target);
  } catch {
    return false;
  }
}

function executable(target: string, uid: number | null, gid: number | null): boolean {
  if (!trustedHostObject(target, uid, gid, 'file')) return false;
  try {
    accessSync(target, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function configuredDefaultToolchain(settingsPath: string, uid: number | null, gid: number | null): string | null {
  if (!trustedHostObject(settingsPath, uid, gid, 'file')) return null;
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

function validToolchain(root: string, uid: number | null, gid: number | null): boolean {
  const bin = path.join(root, 'bin');
  return (
    trustedHostObject(root, uid, gid, 'directory') &&
    trustedHostObject(bin, uid, gid, 'directory') &&
    executable(path.join(bin, 'cargo'), uid, gid) &&
    executable(path.join(bin, 'rustc'), uid, gid)
  );
}

function soleValidToolchain(toolchainsRoot: string, uid: number | null, gid: number | null): string | null {
  let children: string[];
  try {
    children = readdirSync(toolchainsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => path.join(toolchainsRoot, entry.name));
  } catch {
    return null;
  }
  const valid = children.filter((candidate) => validToolchain(candidate, uid, gid));
  return valid.length === 1 ? valid[0]! : null;
}

function publicCratesIoRegistry(configPath: string, uid: number | null, gid: number | null): boolean {
  if (!trustedHostObject(configPath, uid, gid, 'file')) return false;
  try {
    const value = JSON.parse(readFileSync(configPath, 'utf8')) as { dl?: unknown; api?: unknown };
    const dl = typeof value.dl === 'string' ? value.dl.replace(/\/$/, '') : '';
    const api = typeof value.api === 'string' ? value.api.replace(/\/$/, '') : '';
    return dl === 'https://static.crates.io/crates' && (api === '' || api === 'https://crates.io');
  } catch {
    return false;
  }
}

/**
 * Finds only the public crates.io registry cache roots.
 *
 * Cargo's registry, source and archive directories can also contain private registries; `~/.cargo/git`
 * can contain arbitrary private source. Neither is safe to expose generically. We identify a registry
 * through its trusted `index/<id>/config.json` and accept only crates.io's public download/API origins,
 * then mount the matching index/cache/src roots read-only. This exposes public dependency material needed
 * for offline Cargo builds without exposing Cargo credentials/config or private registry/git caches.
 */
function publicCratesIoCachePaths(cargoHome: string, uid: number | null, gid: number | null): string[] {
  if (!trustedHostObject(cargoHome, uid, gid, 'directory')) return [];
  const registry = path.join(cargoHome, 'registry');
  const indexRoot = path.join(registry, 'index');
  if (
    !trustedHostObject(registry, uid, gid, 'directory') ||
    !trustedHostObject(indexRoot, uid, gid, 'directory')
  ) {
    return [];
  }

  let indexDirectories: string[];
  try {
    indexDirectories = readdirSync(indexRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => path.join(indexRoot, entry.name));
  } catch {
    return [];
  }

  const paths: string[] = [];
  for (const indexDir of indexDirectories) {
    if (!trustedHostObject(indexDir, uid, gid, 'directory')) continue;
    if (!publicCratesIoRegistry(path.join(indexDir, 'config.json'), uid, gid)) continue;
    const id = path.basename(indexDir);
    paths.push(indexDir);
    for (const kind of ['cache', 'src'] as const) {
      const candidate = path.join(registry, kind, id);
      if (existsSync(candidate) && trustedHostObject(candidate, uid, gid, 'directory')) paths.push(candidate);
    }
  }
  return paths;
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
 * canonical objects still occupy the host paths before they become executable authority.
 */
export function discoverLinuxRustToolchain(options: LinuxRustDiscoveryOptions = {}): LinuxRustSandboxRuntime | null {
  const platform = options.platform ?? process.platform;
  if (platform !== 'linux') return null;

  const uid = options.uid === undefined ? currentUid() : options.uid;
  const gid = options.gid === undefined ? currentGid() : options.gid;
  const home = path.resolve(options.home ?? accountHome() ?? '/');
  if (home === '/' || !trustedHostObject(home, uid, gid, 'directory')) return null;

  const rustupHome = path.join(home, '.rustup');
  const toolchainsRoot = path.join(rustupHome, 'toolchains');
  if (
    !trustedHostObject(rustupHome, uid, gid, 'directory') ||
    !trustedHostObject(toolchainsRoot, uid, gid, 'directory')
  ) {
    return null;
  }

  const configured = configuredDefaultToolchain(path.join(rustupHome, 'settings.toml'), uid, gid);
  const selected = configured
    ? path.join(toolchainsRoot, configured)
    : soleValidToolchain(toolchainsRoot, uid, gid);
  if (!selected || !inside(toolchainsRoot, selected) || !validToolchain(selected, uid, gid)) return null;

  const cargoHome = path.join(home, '.cargo');
  const publicRegistryPaths = publicCratesIoCachePaths(cargoHome, uid, gid);

  return {
    runtimeReadPaths: [selected, ...publicRegistryPaths],
    runtimePathEntries: [path.join(selected, 'bin')],
    cargoHome: publicRegistryPaths.length > 0 ? cargoHome : null,
    toolchainRoot: selected
  };
}

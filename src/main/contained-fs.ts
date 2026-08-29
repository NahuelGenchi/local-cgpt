import type * as nodeFs from 'node:fs';
import path from 'node:path';

/**
 * Linux filesystem containment for model-influenced approved-root paths.
 *
 * Security contract:
 * - pathname canonicalization is not the boundary;
 * - the configured root is opened once and checked, then each component is opened from a stable
 *   parent directory FD with O_NOFOLLOW;
 * - final reads/writes and mutations operate through stable file/parent directory FDs;
 * - model-visible symlink traversal is intentionally unsupported for M0;
 * - `/proc/self/fd` is used only as an internal encoding of FDs already held by this process;
 * - if Linux procfd semantics are unavailable, contained operations fail instead of falling back;
 * - a root observed and then revoked remains denied rather than becoming an ordinary raw path.
 *
 * The existing approval flow is assumed to store canonical absolute root paths. Root identity is
 * nevertheless checked after open so a stale/substituted root pathname is not trusted for I/O.
 */

// Linux O_PATH. Node's public fs.constants does not expose it consistently across supported Node 22 builds.
const O_PATH = 0o10000000;

export type ContainmentHookPoint =
  | 'root-opened'
  | 'parent-opened'
  | 'directory-opened'
  | 'before-final-open'
  | 'before-rename';

export interface ContainmentHookEvent {
  point: ContainmentHookPoint;
  path: string;
  otherPath?: string;
}

type TestHook = (event: ContainmentHookEvent) => void | Promise<void>;

let testRootOverride: string[] | null = null;
let testHook: TestHook | null = null;

/** Vitest-only root override used by deterministic adversarial regressions. */
export function setContainedRootsForTests(roots: readonly string[] | null): void {
  if (process.env.VITEST !== 'true') throw new Error('setContainedRootsForTests is available only under Vitest');
  testRootOverride = roots === null ? null : roots.map((root) => path.resolve(root));
}

/** Vitest-only synchronization hook. Production cannot install one. */
export function setContainmentHookForTests(hook: TestHook | null): void {
  if (process.env.VITEST !== 'true') throw new Error('setContainmentHookForTests is available only under Vitest');
  testHook = hook;
}

function fsError(code: string, message: string, target?: string): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = code;
  if (target !== undefined) error.path = target;
  return error;
}

function fdPath(fd: number): string {
  return `/proc/self/fd/${fd}`;
}

function childPath(fd: number, name: string): string {
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\0')) {
    throw fsError('EINVAL', 'Invalid contained filesystem path component');
  }
  return `${fdPath(fd)}/${name}`;
}

interface ContainedTarget {
  kind: 'contained';
  root: string;
  absolute: string;
  segments: string[];
}

interface RevokedTarget {
  kind: 'revoked';
  absolute: string;
}

type TargetClass = ContainedTarget | RevokedTarget | { kind: 'raw' };

function segmentsBelow(root: string, absolute: string): string[] | null {
  const relative = path.relative(root, absolute);
  if (relative === '') return [];
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  const parts = relative.split(path.sep);
  return parts.some((part) => !part || part === '.' || part === '..') ? null : parts;
}

function normalizedRoots(roots: readonly string[]): string[] {
  return [...new Set(roots.map((root) => path.resolve(root)))].sort((a, b) => b.length - a.length);
}

function numericOpenFlags(constants: typeof nodeFs.constants, flags: string | number): number {
  if (typeof flags === 'number') return flags | constants.O_NOFOLLOW;
  const sync = constants.O_SYNC ?? 0;
  switch (flags) {
    case 'r': return constants.O_RDONLY | constants.O_NOFOLLOW;
    case 'rs': case 'sr': return constants.O_RDONLY | sync | constants.O_NOFOLLOW;
    case 'r+': return constants.O_RDWR | constants.O_NOFOLLOW;
    case 'rs+': case 'sr+': return constants.O_RDWR | sync | constants.O_NOFOLLOW;
    case 'w': return constants.O_TRUNC | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW;
    case 'wx': case 'xw': return constants.O_TRUNC | constants.O_CREAT | constants.O_WRONLY | constants.O_EXCL | constants.O_NOFOLLOW;
    case 'w+': return constants.O_TRUNC | constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW;
    case 'wx+': case 'xw+': return constants.O_TRUNC | constants.O_CREAT | constants.O_RDWR | constants.O_EXCL | constants.O_NOFOLLOW;
    case 'a': return constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW;
    case 'ax': case 'xa': return constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_EXCL | constants.O_NOFOLLOW;
    case 'as': case 'sa': return constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | sync | constants.O_NOFOLLOW;
    case 'a+': return constants.O_APPEND | constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW;
    case 'ax+': case 'xa+': return constants.O_APPEND | constants.O_CREAT | constants.O_RDWR | constants.O_EXCL | constants.O_NOFOLLOW;
    case 'as+': case 'sa+': return constants.O_APPEND | constants.O_CREAT | constants.O_RDWR | sync | constants.O_NOFOLLOW;
    default: throw fsError('EINVAL', `Unsupported open flag inside an approved root: ${flags}`);
  }
}

function optionFlag(options: unknown, fallback: string): string | number {
  if (options && typeof options === 'object' && 'flag' in options) {
    const value = (options as { flag?: unknown }).flag;
    if (typeof value === 'string' || typeof value === 'number') return value;
  }
  return fallback;
}

function optionMode(options: unknown, fallback = 0o666): number {
  if (options && typeof options === 'object' && 'mode' in options) {
    const value = (options as { mode?: unknown }).mode;
    if (typeof value === 'number') return value;
  }
  return fallback;
}

function optionEncoding(options: unknown): BufferEncoding | null {
  if (typeof options === 'string') return options as BufferEncoding;
  if (options && typeof options === 'object' && 'encoding' in options) {
    const value = (options as { encoding?: unknown }).encoding;
    if (typeof value === 'string') return value as BufferEncoding;
  }
  return null;
}

export function createContainedFs(rawFs: typeof nodeFs): {
  promises: typeof nodeFs.promises;
  createReadStream: typeof nodeFs.createReadStream;
} {
  const base = rawFs.promises;
  const constants = rawFs.constants;
  const knownRoots = new Set<string>();
  let syncRoots: string[] = [];
  let syncRootsReady = false;

  async function currentRoots(): Promise<string[]> {
    if (process.platform !== 'linux') return [];
    const roots = testRootOverride !== null
      ? normalizedRoots(testRootOverride)
      : normalizedRoots((await import('./config.js')).getConfig().roots.map((root) => root.path));
    syncRoots = roots;
    syncRootsReady = true;
    for (const root of roots) knownRoots.add(root);
    return roots;
  }

  function classifyWith(target: unknown, roots: readonly string[]): TargetClass {
    if (process.platform !== 'linux' || typeof target !== 'string' || !path.isAbsolute(target)) return { kind: 'raw' };
    const absolute = path.resolve(target);
    for (const root of roots) {
      const segments = segmentsBelow(root, absolute);
      if (segments !== null) return { kind: 'contained', root, absolute, segments };
    }
    for (const root of knownRoots) {
      if (segmentsBelow(root, absolute) !== null) return { kind: 'revoked', absolute };
    }
    return { kind: 'raw' };
  }

  async function classify(target: unknown): Promise<TargetClass> {
    return classifyWith(target, await currentRoots());
  }

  function denyRevoked(target: RevokedTarget): never {
    throw fsError('EACCES', 'Approved-root access was revoked before the filesystem operation', target.absolute);
  }

  async function runHook(event: ContainmentHookEvent): Promise<void> {
    if (testHook) await testHook(event);
  }

  async function openRoot(target: ContainedTarget): Promise<nodeFs.promises.FileHandle> {
    const handle = await base.open(target.root, O_PATH | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const opened = path.resolve(await base.realpath(fdPath(handle.fd)));
      if (opened !== target.root) throw fsError('ESTALE', 'Approved root changed identity', target.root);
      const stat = await handle.stat();
      if (!stat.isDirectory()) throw fsError('ENOTDIR', 'Approved root is no longer a directory', target.root);
      await runHook({ point: 'root-opened', path: target.absolute });
      return handle;
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
  }

  async function openChildDirectory(parent: nodeFs.promises.FileHandle, name: string): Promise<nodeFs.promises.FileHandle> {
    return await base.open(childPath(parent.fd, name), O_PATH | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  }

  async function openParent(target: ContainedTarget): Promise<{ handle: nodeFs.promises.FileHandle; name: string | null }> {
    let handle = await openRoot(target);
    try {
      for (const segment of target.segments.slice(0, -1)) {
        const next = await openChildDirectory(handle, segment);
        await handle.close();
        handle = next;
      }
      await runHook({ point: 'parent-opened', path: target.absolute });
      return { handle, name: target.segments.at(-1) ?? null };
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
  }

  async function openDirectory(target: ContainedTarget): Promise<nodeFs.promises.FileHandle> {
    let handle = await openRoot(target);
    try {
      for (const segment of target.segments) {
        const next = await openChildDirectory(handle, segment);
        await handle.close();
        handle = next;
      }
      await runHook({ point: 'directory-opened', path: target.absolute });
      return handle;
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
  }

  async function openFile(target: ContainedTarget, flags: string | number, mode?: number): Promise<nodeFs.promises.FileHandle> {
    if (target.segments.length === 0) {
      const root = await openRoot(target);
      try {
        await runHook({ point: 'before-final-open', path: target.absolute });
        // O_NOFOLLOW on the procfd magic link would reject the process-owned descriptor itself.
        // Root-as-file opens are therefore deliberately unsupported; callers can stat/list it.
        throw fsError('EISDIR', 'Approved root is a directory', target.absolute);
      } finally {
        await root.close().catch(() => undefined);
      }
    }
    const parent = await openParent(target);
    try {
      await runHook({ point: 'before-final-open', path: target.absolute });
      return await base.open(childPath(parent.handle.fd, parent.name!), numericOpenFlags(constants, flags), mode);
    } finally {
      await parent.handle.close().catch(() => undefined);
    }
  }

  async function secureLstat(target: ContainedTarget, options?: nodeFs.StatOptions): Promise<nodeFs.Stats | nodeFs.BigIntStats | undefined> {
    if (target.segments.length === 0) {
      const root = await openRoot(target);
      try {
        return await root.stat(options as nodeFs.StatOptions);
      } finally {
        await root.close().catch(() => undefined);
      }
    }
    const parent = await openParent(target);
    try {
      return await base.lstat(childPath(parent.handle.fd, parent.name!), options as nodeFs.StatOptions);
    } finally {
      await parent.handle.close().catch(() => undefined);
    }
  }

  async function secureStat(target: ContainedTarget, options?: nodeFs.StatOptions): Promise<nodeFs.Stats | nodeFs.BigIntStats | undefined> {
    const stat = await secureLstat(target, options);
    if (stat?.isSymbolicLink()) throw fsError('ELOOP', 'Symlink traversal is disabled inside approved roots', target.absolute);
    return stat;
  }

  async function secureRealpath(target: ContainedTarget): Promise<string> {
    if (target.segments.length === 0) {
      const root = await openRoot(target);
      await root.close();
      return target.absolute;
    }
    const parent = await openParent(target);
    try {
      const stat = await base.lstat(childPath(parent.handle.fd, parent.name!));
      if (stat.isSymbolicLink()) throw fsError('ELOOP', 'Symlink traversal is disabled inside approved roots', target.absolute);
      return target.absolute;
    } finally {
      await parent.handle.close().catch(() => undefined);
    }
  }

  async function secureReadFile(target: ContainedTarget, options?: unknown): Promise<Buffer | string> {
    const handle = await openFile(target, optionFlag(options, 'r'));
    try {
      const encoding = optionEncoding(options);
      return encoding ? await handle.readFile({ encoding }) : await handle.readFile();
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  async function secureWriteFile(target: ContainedTarget, data: unknown, options?: unknown, append = false): Promise<void> {
    const handle = await openFile(target, optionFlag(options, append ? 'a' : 'w'), optionMode(options));
    try {
      const encoding = optionEncoding(options);
      if (append) await handle.appendFile(data as string | Uint8Array, encoding ? { encoding } : undefined);
      else await handle.writeFile(data as string | Uint8Array, encoding ? { encoding } : undefined);
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  async function secureMkdir(target: ContainedTarget, options?: nodeFs.MakeDirectoryOptions & { recursive?: boolean }): Promise<string | undefined> {
    if (target.segments.length === 0) {
      if (options?.recursive) return undefined;
      throw fsError('EEXIST', 'Approved root already exists', target.absolute);
    }
    const recursive = options?.recursive === true;
    const mode = typeof options?.mode === 'number' ? options.mode : 0o777;
    let handle = await openRoot(target);
    let firstCreated: string | undefined;
    try {
      for (let index = 0; index < target.segments.length; index++) {
        const segment = target.segments[index]!;
        let next: nodeFs.promises.FileHandle;
        let created = false;
        try {
          next = await openChildDirectory(handle, segment);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          if (!recursive && index !== target.segments.length - 1) throw error;
          await base.mkdir(childPath(handle.fd, segment), { mode });
          created = true;
          firstCreated ??= path.join(target.root, ...target.segments.slice(0, index + 1));
          next = await openChildDirectory(handle, segment);
        }
        if (!recursive && index === target.segments.length - 1 && !created) {
          await next.close();
          throw fsError('EEXIST', 'Directory already exists', target.absolute);
        }
        await handle.close();
        handle = next;
      }
      return firstCreated;
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  async function removeEntry(parent: nodeFs.promises.FileHandle, name: string, recursive: boolean, force: boolean): Promise<void> {
    const child = childPath(parent.fd, name);
    let stat: nodeFs.Stats;
    try {
      stat = await base.lstat(child);
    } catch (error) {
      if (force && (error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      await base.unlink(child);
      return;
    }
    if (!recursive) {
      await base.rmdir(child);
      return;
    }

    let directory: nodeFs.promises.FileHandle;
    try {
      directory = await base.open(child, O_PATH | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ELOOP' || code === 'ENOTDIR') {
        await base.unlink(child);
        return;
      }
      throw error;
    }
    try {
      const entries = await base.readdir(fdPath(directory.fd), { withFileTypes: true });
      for (const entry of entries) await removeEntry(directory, entry.name, true, force);
    } finally {
      await directory.close().catch(() => undefined);
    }
    await base.rmdir(child);
  }

  async function secureRemove(target: ContainedTarget, recursive: boolean, force: boolean): Promise<void> {
    if (target.segments.length === 0) throw fsError('EPERM', 'Removing an approved root is not allowed', target.absolute);
    const parent = await openParent(target);
    try {
      await removeEntry(parent.handle, parent.name!, recursive, force);
    } finally {
      await parent.handle.close().catch(() => undefined);
    }
  }

  async function secureRename(source: ContainedTarget, destination: ContainedTarget): Promise<void> {
    if (source.segments.length === 0 || destination.segments.length === 0) {
      throw fsError('EPERM', 'Renaming an approved root is not allowed');
    }
    const from = await openParent(source);
    try {
      const to = await openParent(destination);
      try {
        await runHook({ point: 'before-rename', path: source.absolute, otherPath: destination.absolute });
        await base.rename(childPath(from.handle.fd, from.name!), childPath(to.handle.fd, to.name!));
      } finally {
        await to.handle.close().catch(() => undefined);
      }
    } finally {
      await from.handle.close().catch(() => undefined);
    }
  }

  async function containedUnsupported(method: string, first: unknown, second?: unknown): Promise<void> {
    const a = await classify(first);
    const b = second === undefined ? null : await classify(second);
    if (a.kind === 'revoked') denyRevoked(a);
    if (b?.kind === 'revoked') denyRevoked(b);
    if (a.kind === 'contained' || b?.kind === 'contained') {
      throw fsError('ENOTSUP', `${method} is not supported for approved-root paths under strict containment`);
    }
  }

  const overrides: Record<string, (...args: any[]) => any> = {
    async open(target: unknown, flags: string | number, mode?: number) {
      const item = await classify(target);
      if (item.kind === 'revoked') denyRevoked(item);
      return item.kind === 'contained' ? await openFile(item, flags, mode) : await (base.open as any)(target, flags, mode);
    },
    async stat(target: unknown, options?: nodeFs.StatOptions) {
      const item = await classify(target);
      if (item.kind === 'revoked') denyRevoked(item);
      return item.kind === 'contained' ? await secureStat(item, options) : await (base.stat as any)(target, options);
    },
    async lstat(target: unknown, options?: nodeFs.StatOptions) {
      const item = await classify(target);
      if (item.kind === 'revoked') denyRevoked(item);
      return item.kind === 'contained' ? await secureLstat(item, options) : await (base.lstat as any)(target, options);
    },
    async realpath(target: unknown, options?: unknown) {
      const item = await classify(target);
      if (item.kind === 'revoked') denyRevoked(item);
      if (item.kind !== 'contained') return await (base.realpath as any)(target, options);
      const encoding = typeof options === 'string' ? options : (options as { encoding?: unknown } | undefined)?.encoding;
      if (encoding !== undefined && encoding !== 'utf8') throw fsError('ENOTSUP', 'Only UTF-8 realpath is supported inside approved roots');
      return await secureRealpath(item);
    },
    async readFile(target: unknown, options?: unknown) {
      const item = await classify(target);
      if (item.kind === 'revoked') denyRevoked(item);
      return item.kind === 'contained' ? await secureReadFile(item, options) : await (base.readFile as any)(target, options);
    },
    async writeFile(target: unknown, data: unknown, options?: unknown) {
      const item = await classify(target);
      if (item.kind === 'revoked') denyRevoked(item);
      return item.kind === 'contained' ? await secureWriteFile(item, data, options) : await (base.writeFile as any)(target, data, options);
    },
    async appendFile(target: unknown, data: unknown, options?: unknown) {
      const item = await classify(target);
      if (item.kind === 'revoked') denyRevoked(item);
      return item.kind === 'contained' ? await secureWriteFile(item, data, options, true) : await (base.appendFile as any)(target, data, options);
    },
    async mkdir(target: unknown, options?: nodeFs.MakeDirectoryOptions & { recursive?: boolean }) {
      const item = await classify(target);
      if (item.kind === 'revoked') denyRevoked(item);
      return item.kind === 'contained' ? await secureMkdir(item, options) : await (base.mkdir as any)(target, options);
    },
    async readdir(target: unknown, options?: any) {
      const item = await classify(target);
      if (item.kind === 'revoked') denyRevoked(item);
      if (item.kind !== 'contained') return await (base.readdir as any)(target, options);
      if (options?.recursive === true) throw fsError('ENOTSUP', 'Recursive native readdir is disabled inside approved roots');
      const directory = await openDirectory(item);
      try {
        return await (base.readdir as any)(fdPath(directory.fd), options);
      } finally {
        await directory.close().catch(() => undefined);
      }
    },
    async opendir(target: unknown, options?: any) {
      const item = await classify(target);
      if (item.kind === 'revoked') denyRevoked(item);
      if (item.kind !== 'contained') return await (base.opendir as any)(target, options);
      const directory = await openDirectory(item);
      try {
        return await (base.opendir as any)(fdPath(directory.fd), options);
      } finally {
        await directory.close().catch(() => undefined);
      }
    },
    async unlink(target: unknown) {
      const item = await classify(target);
      if (item.kind === 'revoked') denyRevoked(item);
      return item.kind === 'contained' ? await secureRemove(item, false, false) : await (base.unlink as any)(target);
    },
    async rmdir(target: unknown, options?: unknown) {
      const item = await classify(target);
      if (item.kind === 'revoked') denyRevoked(item);
      return item.kind === 'contained' ? await secureRemove(item, false, false) : await (base.rmdir as any)(target, options);
    },
    async rm(target: unknown, options?: { recursive?: boolean; force?: boolean }) {
      const item = await classify(target);
      if (item.kind === 'revoked') denyRevoked(item);
      return item.kind === 'contained'
        ? await secureRemove(item, options?.recursive === true, options?.force === true)
        : await (base.rm as any)(target, options);
    },
    async rename(source: unknown, destination: unknown) {
      const from = await classify(source);
      const to = await classify(destination);
      if (from.kind === 'revoked') denyRevoked(from);
      if (to.kind === 'revoked') denyRevoked(to);
      if (from.kind === 'raw' && to.kind === 'raw') return await (base.rename as any)(source, destination);
      if (from.kind !== 'contained' || to.kind !== 'contained') throw fsError('EACCES', 'Rename cannot cross the approved-root boundary');
      return await secureRename(from, to);
    },
    async truncate(target: unknown, length = 0) {
      const item = await classify(target);
      if (item.kind === 'revoked') denyRevoked(item);
      if (item.kind !== 'contained') return await (base.truncate as any)(target, length);
      const handle = await openFile(item, 'r+');
      try {
        await handle.truncate(length);
      } finally {
        await handle.close().catch(() => undefined);
      }
    },
    async mkdtemp(prefix: unknown, options?: unknown) {
      const item = await classify(prefix);
      if (item.kind === 'revoked') denyRevoked(item);
      if (item.kind !== 'contained') return await (base.mkdtemp as any)(prefix, options);
      if (item.segments.length === 0) throw fsError('EINVAL', 'Temporary prefix must be below an approved root');
      const parent = await openParent(item);
      try {
        const created = await (base.mkdtemp as any)(childPath(parent.handle.fd, parent.name!), options);
        return path.join(path.dirname(item.absolute), path.basename(String(created)));
      } finally {
        await parent.handle.close().catch(() => undefined);
      }
    },
    async access(target: unknown, mode?: number) {
      await containedUnsupported('access', target);
      return await (base.access as any)(target, mode);
    },
    async copyFile(source: unknown, destination: unknown, mode?: number) {
      await containedUnsupported('copyFile', source, destination);
      return await (base.copyFile as any)(source, destination, mode);
    },
    async cp(source: unknown, destination: unknown, options?: unknown) {
      await containedUnsupported('cp', source, destination);
      return await (base.cp as any)(source, destination, options);
    },
    async link(source: unknown, destination: unknown) {
      await containedUnsupported('link', source, destination);
      return await (base.link as any)(source, destination);
    },
    async symlink(target: unknown, linkPath: unknown, type?: unknown) {
      await containedUnsupported('symlink', linkPath);
      return await (base.symlink as any)(target, linkPath, type);
    },
    async readlink(target: unknown, options?: unknown) {
      await containedUnsupported('readlink', target);
      return await (base.readlink as any)(target, options);
    },
    async chmod(target: unknown, mode: number) { await containedUnsupported('chmod', target); return await (base.chmod as any)(target, mode); },
    async chown(target: unknown, uid: number, gid: number) { await containedUnsupported('chown', target); return await (base.chown as any)(target, uid, gid); },
    async lchown(target: unknown, uid: number, gid: number) { await containedUnsupported('lchown', target); return await (base.lchown as any)(target, uid, gid); },
    async utimes(target: unknown, atime: unknown, mtime: unknown) { await containedUnsupported('utimes', target); return await (base.utimes as any)(target, atime, mtime); },
    async lutimes(target: unknown, atime: unknown, mtime: unknown) { await containedUnsupported('lutimes', target); return await (base.lutimes as any)(target, atime, mtime); },
    async statfs(target: unknown, options?: unknown) { await containedUnsupported('statfs', target); return await (base.statfs as any)(target, options); },
    async watch(target: unknown, options?: unknown) { await containedUnsupported('watch', target); return (base.watch as any)(target, options); }
  };

  const promises = new Proxy(base, {
    get(target, property, receiver) {
      if (typeof property === 'string' && Object.prototype.hasOwnProperty.call(overrides, property)) return overrides[property];
      return Reflect.get(target, property, receiver);
    }
  }) as typeof nodeFs.promises;

  const createReadStream = ((target: any, options?: any) => {
    if (process.platform !== 'linux' || typeof target !== 'string' || !path.isAbsolute(target)) {
      return rawFs.createReadStream(target, options);
    }
    if (!syncRootsReady) throw fsError('EACCES', 'Approved-root state is not initialized for stream creation', target);
    const item = classifyWith(target, syncRoots);
    if (item.kind === 'revoked') denyRevoked(item);
    if (item.kind === 'raw') return rawFs.createReadStream(target, options);
    if (item.segments.length === 0) throw fsError('EISDIR', 'Approved root is a directory', target);
    if (options?.fd !== undefined && options?.fd !== null) throw fsError('EINVAL', 'Caller-supplied stream FDs are not accepted for approved-root paths', target);

    let parentFd = rawFs.openSync(item.root, O_PATH | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const opened = path.resolve(rawFs.realpathSync(fdPath(parentFd)));
      if (opened !== item.root) throw fsError('ESTALE', 'Approved root changed identity', item.root);
      for (const segment of item.segments.slice(0, -1)) {
        const next = rawFs.openSync(childPath(parentFd, segment), O_PATH | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        rawFs.closeSync(parentFd);
        parentFd = next;
      }
      const fd = rawFs.openSync(
        childPath(parentFd, item.segments.at(-1)!),
        numericOpenFlags(constants, optionFlag(options, 'r')),
        optionMode(options)
      );
      try {
        return rawFs.createReadStream(target, { ...(options ?? {}), fd, autoClose: options?.autoClose ?? true });
      } catch (error) {
        rawFs.closeSync(fd);
        throw error;
      }
    } finally {
      rawFs.closeSync(parentFd);
    }
  }) as typeof nodeFs.createReadStream;

  return { promises, createReadStream };
}

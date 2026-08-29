import type * as nodeFs from 'node:fs';
import path from 'node:path';

/**
 * Linux filesystem containment for model-influenced paths.
 *
 * SECURITY ASSUMPTIONS / DESIGN:
 * - Configured root.path values are canonical absolute directories established by the existing
 *   root-approval flow. The root itself is opened with O_NOFOLLOW and the opened kernel object is
 *   checked through /proc/self/fd before use.
 * - /proc/self/fd is mounted and has normal Linux semantics. If that kernel interface is missing
 *   or unusable, contained operations fail closed rather than falling back to pathname I/O.
 * - Every model-visible symlink is opaque: traversal through a symlink is rejected, even when its
 *   current target would remain inside the approved root. Renaming/unlinking the symlink entry
 *   itself is safe because those operations do not dereference it.
 * - The /proc/self/fd magic links used below are generated only from FDs this process already
 *   holds. They are an internal openat-style addressing mechanism, never model-provided path
 *   components.
 * - Root removal is revocation. Paths beneath roots observed previously are remembered and denied;
 *   they never silently fall back to ordinary raw filesystem resolution after configuration changes.
 *
 * This module deliberately does not make realpath() a security boundary. The actual read/write/
 * rename/list/delete operation is performed relative to stable directory/file descriptors.
 */

const O_PATH = 0o10000000; // Linux O_PATH; Node does not expose it in fs.constants on all releases.

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

/** Vitest-only root override for deterministic containment regression tests. */
export function setContainedRootsForTests(roots: readonly string[] | null): void {
  if (process.env.VITEST !== 'true') throw new Error('setContainedRootsForTests is available only under Vitest');
  testRootOverride = roots === null ? null : roots.map((root) => path.resolve(root));
}

/** Vitest-only synchronization hook. Production code never installs a hook. */
export function setContainmentHookForTests(hook: TestHook | null): void {
  if (process.env.VITEST !== 'true') throw new Error('setContainmentHookForTests is available only under Vitest');
  testHook = hook;
}

function errno(code: string, message: string, target?: string): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = code;
  if (target !== undefined) error.path = target;
  return error;
}

function procFd(fd: number): string {
  return `/proc/self/fd/${fd}`;
}

function procChild(fd: number, name: string): string {
  if (name.length === 0 || name === '.' || name === '..' || name.includes('/') || name.includes('\0')) {
    throw errno('EINVAL', 'Invalid contained filesystem path component');
  }
  return `${procFd(fd)}/${name}`;
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

interface RawTarget {
  kind: 'raw';
}

type TargetClass = ContainedTarget | RevokedTarget | RawTarget;

function pathUnderRoot(absolute: string, root: string): string[] | null {
  const relative = path.relative(root, absolute);
  if (relative === '') return [];
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  const segments = relative.split(path.sep);
  return segments.some((part) => part.length === 0 || part === '.' || part === '..') ? null : segments;
}

function normaliseRoots(roots: readonly string[]): string[] {
  return [...new Set(roots.map((root) => path.resolve(root)))].sort((left, right) => right.length - left.length);
}

function flagNumber(constants: typeof nodeFs.constants, flags: string | number): number {
  if (typeof flags === 'number') return flags | constants.O_NOFOLLOW;
  const c = constants;
  const sync = c.O_SYNC ?? 0;
  switch (flags) {
    case 'r': return c.O_RDONLY | c.O_NOFOLLOW;
    case 'rs': case 'sr': return c.O_RDONLY | sync | c.O_NOFOLLOW;
    case 'r+': return c.O_RDWR | c.O_NOFOLLOW;
    case 'rs+': case 'sr+': return c.O_RDWR | sync | c.O_NOFOLLOW;
    case 'w': return c.O_TRUNC | c.O_CREAT | c.O_WRONLY | c.O_NOFOLLOW;
    case 'wx': case 'xw': return c.O_TRUNC | c.O_CREAT | c.O_WRONLY | c.O_EXCL | c.O_NOFOLLOW;
    case 'w+': return c.O_TRUNC | c.O_CREAT | c.O_RDWR | c.O_NOFOLLOW;
    case 'wx+': case 'xw+': return c.O_TRUNC | c.O_CREAT | c.O_RDWR | c.O_EXCL | c.O_NOFOLLOW;
    case 'a': return c.O_APPEND | c.O_CREAT | c.O_WRONLY | c.O_NOFOLLOW;
    case 'ax': case 'xa': return c.O_APPEND | c.O_CREAT | c.O_WRONLY | c.O_EXCL | c.O_NOFOLLOW;
    case 'as': case 'sa': return c.O_APPEND | c.O_CREAT | c.O_WRONLY | sync | c.O_NOFOLLOW;
    case 'a+': return c.O_APPEND | c.O_CREAT | c.O_RDWR | c.O_NOFOLLOW;
    case 'ax+': case 'xa+': return c.O_APPEND | c.O_CREAT | c.O_RDWR | c.O_EXCL | c.O_NOFOLLOW;
    case 'as+': case 'sa+': return c.O_APPEND | c.O_CREAT | c.O_RDWR | sync | c.O_NOFOLLOW;
    default: throw errno('EINVAL', `Unsupported file-open flag inside an approved root: ${flags}`);
  }
}

function modeFromOptions(options: unknown, fallback = 0o666): number {
  if (typeof options === 'object' && options !== null && 'mode' in options) {
    const mode = (options as { mode?: unknown }).mode;
    if (typeof mode === 'number') return mode;
  }
  return fallback;
}

function flagFromOptions(options: unknown, fallback: string): string | number {
  if (typeof options === 'object' && options !== null && 'flag' in options) {
    const flag = (options as { flag?: unknown }).flag;
    if (typeof flag === 'string' || typeof flag === 'number') return flag;
  }
  return fallback;
}

function encodingFromOptions(options: unknown): BufferEncoding | null {
  if (typeof options === 'string') return options as BufferEncoding;
  if (typeof options === 'object' && options !== null && 'encoding' in options) {
    const encoding = (options as { encoding?: unknown }).encoding;
    if (typeof encoding === 'string') return encoding as BufferEncoding;
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
  let syncCurrentRoots: string[] = [];
  let rootsReady = false;

  async function currentRoots(): Promise<string[]> {
    if (process.platform !== 'linux') return [];
    let roots: string[];
    if (testRootOverride !== null) {
      roots = normaliseRoots(testRootOverride);
    } else {
      const { getConfig } = await import('./config.js');
      roots = normaliseRoots(getConfig().roots.map((root) => root.path));
    }
    syncCurrentRoots = roots;
    rootsReady = true;
    for (const root of roots) knownRoots.add(root);
    return roots;
  }

  function classifyWithRoots(target: unknown, roots: readonly string[]): TargetClass {
    if (process.platform !== 'linux' || typeof target !== 'string' || !path.isAbsolute(target)) return { kind: 'raw' };
    const absolute = path.resolve(target);
    for (const root of roots) {
      const segments = pathUnderRoot(absolute, root);
      if (segments !== null) return { kind: 'contained', root, absolute, segments };
    }
    for (const root of knownRoots) {
      if (pathUnderRoot(absolute, root) !== null) return { kind: 'revoked', absolute };
    }
    return { kind: 'raw' };
  }

  async function classify(target: unknown): Promise<TargetClass> {
    return classifyWithRoots(target, await currentRoots());
  }

  function revoked(target: RevokedTarget): never {
    throw errno('EACCES', 'Approved-root access was revoked before the filesystem operation', target.absolute);
  }

  async function hook(event: ContainmentHookEvent): Promise<void> {
    if (testHook !== null) await testHook(event);
  }

  async function openRoot(target: ContainedTarget): Promise<nodeFs.promises.FileHandle> {
    let handle: nodeFs.promises.FileHandle;
    try {
      handle = await base.open(target.root, O_PATH | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    } catch (error) {
      throw error;
    }
    try {
      const openedPath = path.resolve(await base.realpath(procFd(handle.fd)));
      if (openedPath !== target.root) {
        throw errno('ESTALE', 'Approved root changed identity before the filesystem operation', target.root);
      }
      await hook({ point: 'root-opened', path: target.absolute });
      return handle;
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
  }

  async function openDirectoryFrom(
    parent: nodeFs.promises.FileHandle,
    name: string
  ): Promise<nodeFs.promises.FileHandle> {
    return await base.open(procChild(parent.fd, name), O_PATH | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  }

  async function openParent(target: ContainedTarget): Promise<{ parent: nodeFs.promises.FileHandle; name: string | null }> {
    let current = await openRoot(target);
    try {
      const parentSegments = target.segments.slice(0, -1);
      for (const segment of parentSegments) {
        const next = await openDirectoryFrom(current, segment);
        await current.close();
        current = next;
      }
      await hook({ point: 'parent-opened', path: target.absolute });
      return { parent: current, name: target.segments.at(-1) ?? null };
    } catch (error) {
      await current.close().catch(() => undefined);
      throw error;
    }
  }

  async function openTargetDirectory(target: ContainedTarget): Promise<nodeFs.promises.FileHandle> {
    let current = await openRoot(target);
    try {
      for (const segment of target.segments) {
        const next = await openDirectoryFrom(current, segment);
        await current.close();
        current = next;
      }
      await hook({ point: 'directory-opened', path: target.absolute });
      return current;
    } catch (error) {
      await current.close().catch(() => undefined);
      throw error;
    }
  }

  async function secureOpen(
    target: ContainedTarget,
    flags: string | number,
    mode?: number
  ): Promise<nodeFs.promises.FileHandle> {
    if (target.segments.length === 0) {
      const root = await openRoot(target);
      try {
        await hook({ point: 'before-final-open', path: target.absolute });
        const reopened = await base.open(procFd(root.fd), flagNumber(constants, flags), mode);
        await root.close();
        return reopened;
      } catch (error) {
        await root.close().catch(() => undefined);
        throw error;
      }
    }
    const { parent, name } = await openParent(target);
    try {
      await hook({ point: 'before-final-open', path: target.absolute });
      return await base.open(procChild(parent.fd, name!), flagNumber(constants, flags), mode);
    } finally {
      await parent.close().catch(() => undefined);
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
    const { parent, name } = await openParent(target);
    try {
      return await base.lstat(procChild(parent.fd, name!), options as nodeFs.StatOptions);
    } finally {
      await parent.close().catch(() => undefined);
    }
  }

  async function secureStat(target: ContainedTarget, options?: nodeFs.StatOptions): Promise<nodeFs.Stats | nodeFs.BigIntStats | undefined> {
    const stat = await secureLstat(target, options);
    if (stat?.isSymbolicLink()) throw errno('ELOOP', 'Symlink traversal is disabled inside approved roots', target.absolute);
    return stat;
  }

  async function secureRealpath(target: ContainedTarget): Promise<string> {
    if (target.segments.length === 0) {
      const root = await openRoot(target);
      await root.close();
      return target.absolute;
    }
    const { parent, name } = await openParent(target);
    try {
      const stat = await base.lstat(procChild(parent.fd, name!));
      if (stat.isSymbolicLink()) throw errno('ELOOP', 'Symlink traversal is disabled inside approved roots', target.absolute);
      return target.absolute;
    } finally {
      await parent.close().catch(() => undefined);
    }
  }

  async function secureReadFile(target: ContainedTarget, options?: unknown): Promise<Buffer | string> {
    const handle = await secureOpen(target, flagFromOptions(options, 'r'));
    try {
      const encoding = encodingFromOptions(options);
      return encoding === null ? await handle.readFile() : await handle.readFile({ encoding });
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  async function secureWriteFile(target: ContainedTarget, data: unknown, options?: unknown): Promise<void> {
    const handle = await secureOpen(target, flagFromOptions(options, 'w'), modeFromOptions(options));
    try {
      const encoding = encodingFromOptions(options);
      if (encoding === null) await handle.writeFile(data as Uint8Array);
      else await handle.writeFile(data as string, { encoding });
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  async function secureAppendFile(target: ContainedTarget, data: unknown, options?: unknown): Promise<void> {
    const handle = await secureOpen(target, flagFromOptions(options, 'a'), modeFromOptions(options));
    try {
      const encoding = encodingFromOptions(options);
      if (encoding === null) await handle.appendFile(data as Uint8Array);
      else await handle.appendFile(data as string, { encoding });
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  async function secureMkdir(target: ContainedTarget, options?: nodeFs.MakeDirectoryOptions & { recursive?: boolean }): Promise<string | undefined> {
    if (target.segments.length === 0) {
      if (options?.recursive) return undefined;
      throw errno('EEXIST', 'Approved root already exists', target.absolute);
    }
    const recursive = options?.recursive === true;
    const mode = typeof options?.mode === 'number' ? options.mode : 0o777;
    let current = await openRoot(target);
    let firstCreated: string | undefined;
    try {
      for (let index = 0; index < target.segments.length; index++) {
        const segment = target.segments[index]!;
        const child = procChild(current.fd, segment);
        let next: nodeFs.promises.FileHandle;
        let created = false;
        try {
          next = await openDirectoryFrom(current, segment);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          if (!recursive && index !== target.segments.length - 1) throw error;
          await base.mkdir(child, { mode });
          created = true;
          if (firstCreated === undefined) firstCreated = path.join(target.root, ...target.segments.slice(0, index + 1));
          next = await openDirectoryFrom(current, segment);
        }
        if (!recursive && index === target.segments.length - 1 && !created) {
          await next.close();
          throw errno('EEXIST', 'Directory already exists', target.absolute);
        }
        await current.close();
        current = next;
      }
      return firstCreated;
    } finally {
      await current.close().catch(() => undefined);
    }
  }

  async function removeEntry(
    parent: nodeFs.promises.FileHandle,
    name: string,
    recursive: boolean,
    force: boolean
  ): Promise<void> {
    const childPath = procChild(parent.fd, name);
    let stat: nodeFs.Stats;
    try {
      stat = await base.lstat(childPath);
    } catch (error) {
      if (force && (error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      await base.unlink(childPath);
      return;
    }
    if (!recursive) {
      await base.rmdir(childPath);
      return;
    }

    let directory: nodeFs.promises.FileHandle;
    try {
      directory = await base.open(childPath, O_PATH | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOTDIR' || code === 'ELOOP') {
        await base.unlink(childPath);
        return;
      }
      throw error;
    }
    try {
      const entries = await base.readdir(procFd(directory.fd), { withFileTypes: true });
      for (const entry of entries) await removeEntry(directory, entry.name, true, force);
    } finally {
      await directory.close().catch(() => undefined);
    }
    await base.rmdir(childPath);
  }

  async function secureRemove(target: ContainedTarget, recursive: boolean, force: boolean): Promise<void> {
    if (target.segments.length === 0) throw errno('EPERM', 'Removing an approved root is not allowed', target.absolute);
    const { parent, name } = await openParent(target);
    try {
      await removeEntry(parent, name!, recursive, force);
    } finally {
      await parent.close().catch(() => undefined);
    }
  }

  async function secureRename(source: ContainedTarget, destination: ContainedTarget): Promise<void> {
    if (source.segments.length === 0 || destination.segments.length === 0) {
      throw errno('EPERM', 'Renaming an approved root is not allowed');
    }
    const sourceParent = await openParent(source);
    try {
      const destinationParent = await openParent(destination);
      try {
        await hook({ point: 'before-rename', path: source.absolute, otherPath: destination.absolute });
        await base.rename(
          procChild(sourceParent.parent.fd, sourceParent.name!),
          procChild(destinationParent.parent.fd, destinationParent.name!)
        );
      } finally {
        await destinationParent.parent.close().catch(() => undefined);
      }
    } finally {
      await sourceParent.parent.close().catch(() => undefined);
    }
  }

  async function denyContained(method: string, target: unknown, secondTarget?: unknown): Promise<boolean> {
    const first = await classify(target);
    const second = secondTarget === undefined ? null : await classify(secondTarget);
    if (first.kind === 'revoked') revoked(first);
    if (second?.kind === 'revoked') revoked(second);
    if (first.kind === 'contained' || second?.kind === 'contained') {
      throw errno('ENOTSUP', `${method} is not supported for model-visible approved-root paths under strict containment`);
    }
    return false;
  }

  const overrides: Record<string, (...args: any[]) => any> = {
    async open(target: unknown, flags: string | number, mode?: number) {
      const classified = await classify(target);
      if (classified.kind === 'revoked') revoked(classified);
      if (classified.kind === 'raw') return await (base.open as any)(target, flags, mode);
      return await secureOpen(classified, flags, mode);
    },
    async stat(target: unknown, options?: nodeFs.StatOptions) {
      const classified = await classify(target);
      if (classified.kind === 'revoked') revoked(classified);
      if (classified.kind === 'raw') return await (base.stat as any)(target, options);
      return await secureStat(classified, options);
    },
    async lstat(target: unknown, options?: nodeFs.StatOptions) {
      const classified = await classify(target);
      if (classified.kind === 'revoked') revoked(classified);
      if (classified.kind === 'raw') return await (base.lstat as any)(target, options);
      return await secureLstat(classified, options);
    },
    async realpath(target: unknown, options?: unknown) {
      const classified = await classify(target);
      if (classified.kind === 'revoked') revoked(classified);
      if (classified.kind === 'raw') return await (base.realpath as any)(target, options);
      if (options !== undefined && options !== 'utf8' && !(typeof options === 'object' && options !== null && (options as { encoding?: unknown }).encoding === 'utf8')) {
        throw errno('ENOTSUP', 'Non-UTF8 realpath encoding is unsupported inside approved roots');
      }
      return await secureRealpath(classified);
    },
    async readFile(target: unknown, options?: unknown) {
      const classified = await classify(target);
      if (classified.kind === 'revoked') revoked(classified);
      if (classified.kind === 'raw') return await (base.readFile as any)(target, options);
      return await secureReadFile(classified, options);
    },
    async writeFile(target: unknown, data: unknown, options?: unknown) {
      const classified = await classify(target);
      if (classified.kind === 'revoked') revoked(classified);
      if (classified.kind === 'raw') return await (base.writeFile as any)(target, data, options);
      return await secureWriteFile(classified, data, options);
    },
    async appendFile(target: unknown, data: unknown, options?: unknown) {
      const classified = await classify(target);
      if (classified.kind === 'revoked') revoked(classified);
      if (classified.kind === 'raw') return await (base.appendFile as any)(target, data, options);
      return await secureAppendFile(classified, data, options);
    },
    async mkdir(target: unknown, options?: nodeFs.MakeDirectoryOptions & { recursive?: boolean }) {
      const classified = await classify(target);
      if (classified.kind === 'revoked') revoked(classified);
      if (classified.kind === 'raw') return await (base.mkdir as any)(target, options);
      return await secureMkdir(classified, options);
    },
    async readdir(target: unknown, options?: unknown) {
      const classified = await classify(target);
      if (classified.kind === 'revoked') revoked(classified);
      if (classified.kind === 'raw') return await (base.readdir as any)(target, options);
      const directory = await openTargetDirectory(classified);
      try {
        return await (base.readdir as any)(procFd(directory.fd), options);
      } finally {
        await directory.close().catch(() => undefined);
      }
    },
    async opendir(target: unknown, options?: unknown) {
      const classified = await classify(target);
      if (classified.kind === 'revoked') revoked(classified);
      if (classified.kind === 'raw') return await (base.opendir as any)(target, options);
      const directory = await openTargetDirectory(classified);
      try {
        return await (base.opendir as any)(procFd(directory.fd), options);
      } finally {
        await directory.close().catch(() => undefined);
      }
    },
    async unlink(target: unknown) {
      const classified = await classify(target);
      if (classified.kind === 'revoked') revoked(classified);
      if (classified.kind === 'raw') return await (base.unlink as any)(target);
      return await secureRemove(classified, false, false);
    },
    async rmdir(target: unknown, options?: unknown) {
      const classified = await classify(target);
      if (classified.kind === 'revoked') revoked(classified);
      if (classified.kind === 'raw') return await (base.rmdir as any)(target, options);
      return await secureRemove(classified, false, false);
    },
    async rm(target: unknown, options?: { recursive?: boolean; force?: boolean }) {
      const classified = await classify(target);
      if (classified.kind === 'revoked') revoked(classified);
      if (classified.kind === 'raw') return await (base.rm as any)(target, options);
      return await secureRemove(classified, options?.recursive === true, options?.force === true);
    },
    async rename(source: unknown, destination: unknown) {
      const sourceClass = await classify(source);
      const destinationClass = await classify(destination);
      if (sourceClass.kind === 'revoked') revoked(sourceClass);
      if (destinationClass.kind === 'revoked') revoked(destinationClass);
      if (sourceClass.kind === 'raw' && destinationClass.kind === 'raw') return await (base.rename as any)(source, destination);
      if (sourceClass.kind !== 'contained' || destinationClass.kind !== 'contained') {
        throw errno('EACCES', 'Rename cannot cross the approved-root containment boundary');
      }
      return await secureRename(sourceClass, destinationClass);
    },
    async truncate(target: unknown, length = 0) {
      const classified = await classify(target);
      if (classified.kind === 'revoked') revoked(classified);
      if (classified.kind === 'raw') return await (base.truncate as any)(target, length);
      const handle = await secureOpen(classified, 'r+');
      try {
        await handle.truncate(length);
      } finally {
        await handle.close().catch(() => undefined);
      }
    },
    async mkdtemp(prefix: unknown, options?: unknown) {
      const classified = await classify(prefix);
      if (classified.kind === 'revoked') revoked(classified);
      if (classified.kind === 'raw') return await (base.mkdtemp as any)(prefix, options);
      if (classified.segments.length === 0) throw errno('EINVAL', 'Temporary-file prefix must name a child of an approved root');
      const { parent, name } = await openParent(classified);
      try {
        const created = await (base.mkdtemp as any)(procChild(parent.fd, name!), options);
        return path.join(path.dirname(classified.absolute), path.basename(String(created)));
      } finally {
        await parent.close().catch(() => undefined);
      }
    },
    async access(target: unknown) { return await denyContained('access', target) || await (base.access as any)(target); },
    async copyFile(source: unknown, destination: unknown, mode?: number) {
      await denyContained('copyFile', source, destination);
      return await (base.copyFile as any)(source, destination, mode);
    },
    async cp(source: unknown, destination: unknown, options?: unknown) {
      await denyContained('cp', source, destination);
      return await (base.cp as any)(source, destination, options);
    },
    async link(existingPath: unknown, newPath: unknown) {
      await denyContained('link', existingPath, newPath);
      return await (base.link as any)(existingPath, newPath);
    },
    async symlink(target: unknown, newPath: unknown, type?: unknown) {
      await denyContained('symlink', newPath);
      return await (base.symlink as any)(target, newPath, type);
    },
    async readlink(target: unknown, options?: unknown) {
      await denyContained('readlink', target);
      return await (base.readlink as any)(target, options);
    },
    async chmod(target: unknown, mode: number) { await denyContained('chmod', target); return await (base.chmod as any)(target, mode); },
    async chown(target: unknown, uid: number, gid: number) { await denyContained('chown', target); return await (base.chown as any)(target, uid, gid); },
    async lchown(target: unknown, uid: number, gid: number) { await denyContained('lchown', target); return await (base.lchown as any)(target, uid, gid); },
    async utimes(target: unknown, atime: unknown, mtime: unknown) { await denyContained('utimes', target); return await (base.utimes as any)(target, atime, mtime); },
    async lutimes(target: unknown, atime: unknown, mtime: unknown) { await denyContained('lutimes', target); return await (base.lutimes as any)(target, atime, mtime); },
    async statfs(target: unknown, options?: unknown) { await denyContained('statfs', target); return await (base.statfs as any)(target, options); }
  };

  const promises = new Proxy(base, {
    get(target, property, receiver) {
      if (typeof property === 'string' && property in overrides) return overrides[property];
      return Reflect.get(target, property, receiver);
    }
  }) as typeof nodeFs.promises;

  const createReadStream = ((target: nodeFs.PathLike, options?: BufferEncoding | nodeFs.CreateReadStreamOptions) => {
    if (process.platform !== 'linux' || typeof target !== 'string' || !path.isAbsolute(target)) {
      return rawFs.createReadStream(target, options as nodeFs.CreateReadStreamOptions);
    }
    if (!rootsReady) {
      throw errno('EACCES', 'Approved-root state is not initialized for synchronous stream creation', target);
    }
    const classified = classifyWithRoots(target, syncCurrentRoots);
    if (classified.kind === 'revoked') revoked(classified);
    if (classified.kind === 'raw') return rawFs.createReadStream(target, options as nodeFs.CreateReadStreamOptions);

    const streamOptions = typeof options === 'string' ? { encoding: options } : { ...(options ?? {}) };
    if (streamOptions.fd !== undefined && streamOptions.fd !== null) {
      throw errno('EINVAL', 'Caller-supplied stream file descriptors are not accepted for approved-root paths', target);
    }
    const flags = flagFromOptions(streamOptions, 'r');
    let current = rawFs.openSync(classified.root, O_PATH | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const openedPath = path.resolve(rawFs.realpathSync(procFd(current)));
      if (openedPath !== classified.root) throw errno('ESTALE', 'Approved root changed identity before stream creation', classified.root);
      const parentSegments = classified.segments.slice(0, -1);
      for (const segment of parentSegments) {
        const next = rawFs.openSync(procChild(current, segment), O_PATH | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        rawFs.closeSync(current);
        current = next;
      }
      const finalPath = classified.segments.length === 0 ? procFd(current) : procChild(current, classified.segments.at(-1)!);
      const fd = rawFs.openSync(finalPath, flagNumber(constants, flags), modeFromOptions(streamOptions));
      try {
        return rawFs.createReadStream(target, { ...streamOptions, fd, autoClose: streamOptions.autoClose ?? true });
      } catch (error) {
        rawFs.closeSync(fd);
        throw error;
      }
    } finally {
      rawFs.closeSync(current);
    }
  }) as typeof nodeFs.createReadStream;

  return { promises, createReadStream };
}

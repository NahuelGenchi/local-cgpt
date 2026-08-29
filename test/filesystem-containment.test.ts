import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as nativeFs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  rawPromises as fs,
  setContainedRootsForTests,
  setContainmentHookForTests,
  type ContainmentHookEvent
} from '../src/main/rawfs.js';
import { search } from '../src/main/search.js';

const describeLinux = process.platform === 'linux' ? describe : describe.skip;

describeLinux('Linux stable-FD approved-root containment', () => {
  let base = '';
  let root = '';
  let outside = '';

  beforeEach(async () => {
    base = await nativeFs.mkdtemp(path.join(os.tmpdir(), 'local-cgpt-containment-'));
    root = path.join(base, 'approved');
    outside = path.join(base, 'outside');
    await nativeFs.mkdir(root);
    await nativeFs.mkdir(outside);
    setContainedRootsForTests([root]);
    setContainmentHookForTests(null);
  });

  afterEach(async () => {
    setContainmentHookForTests(null);
    setContainedRootsForTests(null);
    await nativeFs.rm(base, { recursive: true, force: true });
  });

  function onceAt(point: ContainmentHookEvent['point'], target: string, work: () => Promise<void>): void {
    let ran = false;
    setContainmentHookForTests(async (event) => {
      if (ran || event.point !== point || event.path !== target) return;
      ran = true;
      await work();
    });
  }

  it('reads from the already-opened in-root parent when its pathname is swapped to an outside symlink', async () => {
    const liveParent = path.join(root, 'parent');
    const detachedParent = path.join(root, 'parent-detached');
    const target = path.join(liveParent, 'secret.txt');
    await nativeFs.mkdir(liveParent);
    await nativeFs.writeFile(target, 'approved bytes', 'utf8');
    await nativeFs.writeFile(path.join(outside, 'secret.txt'), 'outside secret', 'utf8');

    onceAt('before-final-open', target, async () => {
      await nativeFs.rename(liveParent, detachedParent);
      await nativeFs.symlink(outside, liveParent, 'dir');
    });

    await expect(fs.readFile(target, 'utf8')).resolves.toBe('approved bytes');
    await expect(nativeFs.readFile(path.join(outside, 'secret.txt'), 'utf8')).resolves.toBe('outside secret');
  });

  it('creates and truncates only through the already-opened in-root parent after a parent swap', async () => {
    const liveParent = path.join(root, 'write');
    const detachedParent = path.join(root, 'write-detached');
    const target = path.join(liveParent, 'created.txt');
    await nativeFs.mkdir(liveParent);

    onceAt('before-final-open', target, async () => {
      await nativeFs.rename(liveParent, detachedParent);
      await nativeFs.symlink(outside, liveParent, 'dir');
    });

    await fs.writeFile(target, 'inside only', 'utf8');
    await expect(nativeFs.readFile(path.join(detachedParent, 'created.txt'), 'utf8')).resolves.toBe('inside only');
    await expect(nativeFs.readFile(path.join(outside, 'created.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('binds both rename parents before a destination pathname can be swapped outside', async () => {
    const sourceParent = path.join(root, 'source');
    const destinationParent = path.join(root, 'destination');
    const detachedDestination = path.join(root, 'destination-detached');
    const source = path.join(sourceParent, 'move.txt');
    const destination = path.join(destinationParent, 'move.txt');
    await nativeFs.mkdir(sourceParent);
    await nativeFs.mkdir(destinationParent);
    await nativeFs.writeFile(source, 'move me', 'utf8');

    onceAt('before-rename', source, async () => {
      await nativeFs.rename(destinationParent, detachedDestination);
      await nativeFs.symlink(outside, destinationParent, 'dir');
    });

    await fs.rename(source, destination);
    await expect(nativeFs.readFile(path.join(detachedDestination, 'move.txt'), 'utf8')).resolves.toBe('move me');
    await expect(nativeFs.readFile(path.join(outside, 'move.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(nativeFs.stat(source)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not let a rename source pathname swap redirect the move to an outside file', async () => {
    const sourceParent = path.join(root, 'source');
    const detachedSource = path.join(root, 'source-detached');
    const destinationParent = path.join(root, 'destination');
    const source = path.join(sourceParent, 'move.txt');
    const destination = path.join(destinationParent, 'move.txt');
    await nativeFs.mkdir(sourceParent);
    await nativeFs.mkdir(destinationParent);
    await nativeFs.writeFile(source, 'approved source', 'utf8');
    await nativeFs.writeFile(path.join(outside, 'move.txt'), 'outside source', 'utf8');

    onceAt('before-rename', source, async () => {
      await nativeFs.rename(sourceParent, detachedSource);
      await nativeFs.symlink(outside, sourceParent, 'dir');
    });

    await fs.rename(source, destination);
    await expect(nativeFs.readFile(destination, 'utf8')).resolves.toBe('approved source');
    await expect(nativeFs.readFile(path.join(outside, 'move.txt'), 'utf8')).resolves.toBe('outside source');
    await expect(nativeFs.stat(path.join(detachedSource, 'move.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails closed when a parent is replaced by a symlink before traversal reaches it', async () => {
    const parent = path.join(root, 'parent');
    const detached = path.join(root, 'parent-detached');
    const target = path.join(parent, 'secret.txt');
    await nativeFs.mkdir(parent);
    await nativeFs.writeFile(target, 'approved', 'utf8');
    await nativeFs.writeFile(path.join(outside, 'secret.txt'), 'outside secret', 'utf8');

    onceAt('root-opened', target, async () => {
      await nativeFs.rename(parent, detached);
      await nativeFs.symlink(outside, parent, 'dir');
    });

    await expect(fs.readFile(target, 'utf8')).rejects.toMatchObject({ code: expect.stringMatching(/^(ELOOP|ENOTDIR)$/) });
    await expect(nativeFs.readFile(path.join(outside, 'secret.txt'), 'utf8')).resolves.toBe('outside secret');
  });

  it('rejects ordinary symlink traversal, including links to out-of-root files', async () => {
    const secret = path.join(outside, 'credential.txt');
    const link = path.join(root, 'credential.txt');
    await nativeFs.writeFile(secret, 'credential', 'utf8');
    await nativeFs.symlink(secret, link);

    await expect(fs.readFile(link, 'utf8')).rejects.toMatchObject({ code: 'ELOOP' });
    await expect(fs.stat(link)).rejects.toMatchObject({ code: 'ELOOP' });
    await expect(fs.lstat(link)).resolves.toMatchObject({ isSymbolicLink: expect.any(Function) });
  });

  it('does not let a search walk through a directory swapped to an outside symlink', async () => {
    const tree = path.join(root, 'tree');
    const detachedTree = path.join(root, 'tree-detached');
    await nativeFs.mkdir(tree);
    await nativeFs.writeFile(path.join(tree, 'inside.txt'), 'ordinary in-root text', 'utf8');
    await nativeFs.writeFile(path.join(outside, 'credential.txt'), 'OUTSIDE_NEEDLE', 'utf8');

    onceAt('directory-opened', tree, async () => {
      await nativeFs.rename(tree, detachedTree);
      await nativeFs.symlink(outside, tree, 'dir');
    });

    const outcome = await search({
      realDir: tree,
      virtualDir: '/approved/tree',
      query: 'OUTSIDE_NEEDLE',
      mode: 'content',
      exclude: [],
      caseSensitive: true,
      maxResults: 20
    });

    expect(outcome.hits).toEqual([]);
    await expect(nativeFs.readFile(path.join(outside, 'credential.txt'), 'utf8')).resolves.toBe('OUTSIDE_NEEDLE');
  });

  it('supports normal in-root create, append, read, stat, list, rename and delete operations', async () => {
    const directory = path.join(root, 'normal', 'nested');
    const first = path.join(directory, 'first.txt');
    const second = path.join(directory, 'second.txt');

    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(first, 'one', 'utf8');
    await fs.appendFile(first, ' two', 'utf8');
    await expect(fs.readFile(first, 'utf8')).resolves.toBe('one two');
    await expect(fs.stat(first)).resolves.toMatchObject({ size: 7 });
    await expect(fs.readdir(directory)).resolves.toContain('first.txt');
    await fs.rename(first, second);
    await expect(fs.readFile(second, 'utf8')).resolves.toBe('one two');
    await fs.rm(path.join(root, 'normal'), { recursive: true, force: false });
    await expect(nativeFs.stat(path.join(root, 'normal'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('never falls back to raw pathname access after a root is revoked', async () => {
    const target = path.join(root, 'file.txt');
    await nativeFs.writeFile(target, 'before revocation', 'utf8');
    await expect(fs.readFile(target, 'utf8')).resolves.toBe('before revocation');

    setContainedRootsForTests([]);
    await expect(fs.readFile(target, 'utf8')).rejects.toMatchObject({ code: 'EACCES' });
  });
});

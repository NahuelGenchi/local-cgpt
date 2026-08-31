import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildBubblewrapLaunch, CommandSandboxError } from '../src/main/command-sandbox.js';
import { discoverLinuxRustToolchain, resetLinuxRustToolchainCache } from '../src/main/linux-toolchain.js';

const ownedUid = typeof process.getuid === 'function' ? process.getuid() : null;
const tempRoots: string[] = [];

afterEach(() => {
  resetLinuxRustToolchainCache();
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempHome(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'local-cgpt-rustup-'));
  tempRoots.push(root);
  return root;
}

/**
 * Test fixtures must not inherit the developer/runner umask. The production trust boundary
 * intentionally rejects group/world-writable compiler and cache authority, so a collaborative
 * umask such as 0002 must not turn an otherwise-valid fixture into 0775/0664 by accident.
 */
function trustedDirectory(target: string): void {
  mkdirSync(target, { recursive: true });
  chmodSync(target, 0o755);
}

function trustedFile(target: string, content: string, mode = 0o644): void {
  trustedDirectory(path.dirname(target));
  writeFileSync(target, content);
  chmodSync(target, mode);
}

function executable(target: string): void {
  trustedFile(target, '#!/bin/sh\nexit 0\n', 0o755);
}

function installToolchain(home: string, name: string): string {
  const rustup = path.join(home, '.rustup');
  const toolchains = path.join(rustup, 'toolchains');
  const root = path.join(toolchains, name);
  const bin = path.join(root, 'bin');
  for (const directory of [rustup, toolchains, root, bin]) trustedDirectory(directory);
  executable(path.join(bin, 'cargo'));
  executable(path.join(bin, 'rustc'));
  executable(path.join(bin, 'rustfmt'));
  executable(path.join(bin, 'clippy-driver'));
  return root;
}

function writeSettings(home: string, defaultToolchain: string): void {
  const rustup = path.join(home, '.rustup');
  trustedDirectory(rustup);
  trustedFile(path.join(rustup, 'settings.toml'), `default_toolchain = "${defaultToolchain}"\n`, 0o600);
}

function installRegistry(
  home: string,
  id: string,
  config: { dl: string; api?: string },
  options: { cache?: boolean; src?: boolean } = { cache: true, src: true }
): string[] {
  const cargoHome = path.join(home, '.cargo');
  const registry = path.join(cargoHome, 'registry');
  const indexRoot = path.join(registry, 'index');
  const index = path.join(indexRoot, id);
  for (const directory of [cargoHome, registry, indexRoot, index]) trustedDirectory(directory);
  trustedFile(path.join(index, 'config.json'), `${JSON.stringify(config)}\n`);

  const paths = [index];
  if (options.cache !== false) {
    const cacheRoot = path.join(registry, 'cache');
    const cache = path.join(cacheRoot, id);
    trustedDirectory(cacheRoot);
    trustedDirectory(cache);
    paths.push(cache);
  }
  if (options.src !== false) {
    const srcRoot = path.join(registry, 'src');
    const src = path.join(srcRoot, id);
    trustedDirectory(srcRoot);
    trustedDirectory(src);
    paths.push(src);
  }
  return paths;
}

describe('trusted Linux rustup discovery', () => {
  it('selects the account-owned default toolchain and exposes only public crates.io caches', () => {
    const home = tempHome();
    const name = '1.94.1-x86_64-unknown-linux-gnu';
    const toolchain = installToolchain(home, name);
    writeSettings(home, name);

    const publicPaths = installRegistry(home, 'index.crates.io-1949cf8c6b5b557f', {
      dl: 'https://static.crates.io/crates',
      api: 'https://crates.io'
    });
    const privatePaths = installRegistry(home, 'private.example-0123456789abcdef', {
      dl: 'https://packages.example.test/api/v1/crates',
      api: 'https://packages.example.test'
    });
    const cargoHome = path.join(home, '.cargo');
    mkdirSync(path.join(cargoHome, 'git', 'checkouts', 'private-project'), { recursive: true });
    writeFileSync(path.join(cargoHome, 'credentials.toml'), '[registry]\ntoken = "secret"\n');
    writeFileSync(path.join(cargoHome, 'config.toml'), '[net]\noffline = false\n');

    const found = discoverLinuxRustToolchain({ platform: 'linux', home, uid: ownedUid });
    expect(found).not.toBeNull();
    expect(found?.toolchainRoot).toBe(toolchain);
    expect(found?.runtimePathEntries).toEqual([path.join(toolchain, 'bin')]);
    expect(found?.runtimeReadPaths).toEqual([toolchain, ...publicPaths]);
    expect(found?.cargoHome).toBe(cargoHome);
    const exposed = found?.runtimeReadPaths.join('\n') ?? '';
    expect(exposed).not.toContain('credentials.toml');
    expect(exposed).not.toContain('config.toml');
    expect(exposed).not.toContain(path.join(cargoHome, 'git'));
    for (const privatePath of privatePaths) expect(exposed).not.toContain(privatePath);
  });

  it('accepts crates.io cache config without an API field but rejects lookalike download origins', () => {
    const home = tempHome();
    installToolchain(home, '1.94.1-x86_64-unknown-linux-gnu');
    const publicPaths = installRegistry(home, 'github.com-1ecc6299db9ec823', {
      dl: 'https://static.crates.io/crates/'
    });
    installRegistry(home, 'evil-aaaaaaaaaaaaaaaa', {
      dl: 'https://static.crates.io/crates.evil.test',
      api: 'https://crates.io'
    });

    const found = discoverLinuxRustToolchain({ platform: 'linux', home, uid: ownedUid });
    expect(found?.runtimeReadPaths).toEqual([found!.toolchainRoot, ...publicPaths]);
  });

  it('fails closed when settings tries to escape the toolchain root', () => {
    const home = tempHome();
    installToolchain(home, 'stable-x86_64-unknown-linux-gnu');
    installToolchain(home, '1.94.1-x86_64-unknown-linux-gnu');
    writeSettings(home, '../../../project');

    expect(discoverLinuxRustToolchain({ platform: 'linux', home, uid: ownedUid })).toBeNull();
  });

  it('fails closed for symlinked or group-writable compiler authority', () => {
    const home = tempHome();
    const name = 'stable-x86_64-unknown-linux-gnu';
    const toolchain = installToolchain(home, name);
    writeSettings(home, name);

    const cargo = path.join(toolchain, 'bin', 'cargo');
    rmSync(cargo);
    symlinkSync('/bin/true', cargo);
    expect(discoverLinuxRustToolchain({ platform: 'linux', home, uid: ownedUid })).toBeNull();

    rmSync(cargo);
    executable(cargo);
    chmodSync(path.join(toolchain, 'bin'), 0o775);
    expect(discoverLinuxRustToolchain({ platform: 'linux', home, uid: ownedUid })).toBeNull();
  });

  it('revalidates compiler provenance instead of trusting an earlier successful discovery', () => {
    const home = tempHome();
    const name = '1.94.1-x86_64-unknown-linux-gnu';
    const toolchain = installToolchain(home, name);
    writeSettings(home, name);
    expect(discoverLinuxRustToolchain({ platform: 'linux', home, uid: ownedUid })?.toolchainRoot).toBe(toolchain);

    const moved = `${toolchain}-old`;
    renameSync(toolchain, moved);
    symlinkSync(moved, toolchain, 'dir');
    expect(discoverLinuxRustToolchain({ platform: 'linux', home, uid: ownedUid })).toBeNull();
  });

  it('uses a sole valid concrete toolchain when rustup settings are unavailable', () => {
    const home = tempHome();
    const toolchain = installToolchain(home, '1.94.1-x86_64-unknown-linux-gnu');
    const found = discoverLinuxRustToolchain({ platform: 'linux', home, uid: ownedUid });
    expect(found?.toolchainRoot).toBe(toolchain);
  });
});

describe('trusted runtime Bubblewrap projection', () => {
  it('prepends only a mounted compiler bin and exposes public cache children without Cargo parent contents', () => {
    const home = tempHome();
    const project = path.join(home, 'project');
    const toolchain = installToolchain(home, '1.94.1-x86_64-unknown-linux-gnu');
    const cargoHome = path.join(home, '.cargo');
    const publicPaths = installRegistry(home, 'index.crates.io-1949cf8c6b5b557f', {
      dl: 'https://static.crates.io/crates',
      api: 'https://crates.io'
    });
    mkdirSync(project);
    writeFileSync(path.join(cargoHome, 'credentials.toml'), 'token = "must-stay-host-only"\n');

    const launch = buildBubblewrapLaunch(
      {
        command: ['/bin/sh', '-c', 'cargo --version'],
        cwd: project,
        roots: [{ name: 'project', path: project }],
        env: { PATH: `${path.join(home, '.cargo', 'bin')}:/usr/bin`, LANG: 'C.UTF-8' },
        platform: 'linux',
        runtimeReadPaths: [toolchain, ...publicPaths],
        runtimePathEntries: [path.join(toolchain, 'bin')],
        cargoHome
      },
      '/usr/bin/bwrap'
    );

    const valueFor = (name: string): string | undefined => {
      const index = launch.command.findIndex(
        (entry, offset) => entry === '--setenv' && launch.command[offset + 1] === name
      );
      return index === -1 ? undefined : launch.command[index + 2];
    };
    expect(valueFor('PATH')).toBe(
      `${path.join(toolchain, 'bin')}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`
    );
    expect(valueFor('CARGO_HOME')).toBe(cargoHome);
    expect(valueFor('CARGO_NET_OFFLINE')).toBe('true');
    expect(valueFor('HOME')).toBe('/run/local-cgpt/home');

    const roSources = launch.command
      .map((entry, index) => (entry === '--ro-bind' ? launch.command[index + 1] : null))
      .filter((entry): entry is string => entry !== null);
    expect(roSources).toContain(toolchain);
    for (const publicPath of publicPaths) expect(roSources).toContain(publicPath);
    expect(roSources).not.toContain(cargoHome);
    expect(launch.command.join('\n')).not.toContain('credentials.toml');
    expect(launch.command.join('\n')).not.toContain('must-stay-host-only');
    expect(launch.command).toContain('--unshare-all');
    expect(launch.command).toContain('--seccomp');
  });

  it('rejects PATH entries that are not nested in a read-only runtime mount', () => {
    const home = tempHome();
    const project = path.join(home, 'project');
    const untrustedBin = path.join(home, 'untrusted', 'bin');
    mkdirSync(project);
    mkdirSync(untrustedBin, { recursive: true });

    expect(() =>
      buildBubblewrapLaunch(
        {
          command: ['/bin/sh', '-c', 'true'],
          cwd: project,
          roots: [{ name: 'project', path: project }],
          env: {},
          platform: 'linux',
          runtimeReadPaths: [],
          runtimePathEntries: [untrustedBin]
        },
        '/usr/bin/bwrap'
      )
    ).toThrowError(CommandSandboxError);
  });

  it('rejects executable runtime mounts that are also writable approved roots', () => {
    const home = tempHome();
    const project = path.join(home, 'project');
    const toolchain = path.join(project, 'toolchain');
    const bin = path.join(toolchain, 'bin');
    mkdirSync(bin, { recursive: true });

    expect(() =>
      buildBubblewrapLaunch(
        {
          command: ['/bin/sh', '-c', 'true'],
          cwd: project,
          roots: [{ name: 'project', path: project }],
          env: {},
          platform: 'linux',
          runtimeReadPaths: [toolchain],
          runtimePathEntries: [bin]
        },
        '/usr/bin/bwrap'
      )
    ).toThrow(/outside writable roots/i);
  });

  it('rejects Cargo home under a writable approved root', () => {
    const home = tempHome();
    const project = path.join(home, 'project');
    const cache = path.join(project, '.cargo', 'registry', 'index', 'index.crates.io-test');
    mkdirSync(cache, { recursive: true });

    expect(() =>
      buildBubblewrapLaunch(
        {
          command: ['/bin/sh', '-c', 'true'],
          cwd: project,
          roots: [{ name: 'project', path: project }],
          env: {},
          platform: 'linux',
          runtimeReadPaths: [cache],
          cargoHome: path.join(project, '.cargo')
        },
        '/usr/bin/bwrap'
      )
    ).toThrow(/Cargo home must be an isolated parent/i);
  });
});

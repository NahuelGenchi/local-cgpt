import { mkdtempSync, mkdirSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CommandSandboxError,
  buildBubblewrapLaunch,
  buildCommandNetworkSeccompFilter,
  sandboxCommandLaunch,
  setCommandSandboxBypassForTests
} from '../src/main/command-sandbox.js';

const roots = [{ name: 'project', path: '/home/example/project' }];
const env = {
  PATH: '/home/example/.local/bin:/usr/bin:/bin',
  LANG: 'en_US.UTF-8',
  GITHUB_TOKEN: 'must-not-be-forwarded-by-bwrap',
  TERM: 'xterm-256color'
};

function decodeSeccompFilter(filter: Buffer) {
  expect(filter.length % 8).toBe(0);
  return Array.from({ length: filter.length / 8 }, (_, index) => {
    const offset = index * 8;
    return {
      code: filter.readUInt16LE(offset),
      jt: filter.readUInt8(offset + 2),
      jf: filter.readUInt8(offset + 3),
      k: filter.readUInt32LE(offset + 4)
    };
  });
}

beforeEach(() => setCommandSandboxBypassForTests(false));
afterEach(() => setCommandSandboxBypassForTests(true));

describe('hardened command sandbox', () => {
  it('fails closed on platforms without a supported OS sandbox backend', () => {
    for (const platform of ['win32', 'darwin'] as const) {
      expect(() =>
        sandboxCommandLaunch({ command: ['/bin/sh', '-c', 'true'], cwd: roots[0]!.path, roots, env, platform })
      ).toThrowError(CommandSandboxError);
    }
  });

  it('fails closed on Linux when bubblewrap is unavailable', () => {
    expect(() =>
      sandboxCommandLaunch({
        command: ['/bin/sh', '-c', 'true'],
        cwd: roots[0]!.path,
        roots,
        env,
        platform: 'linux',
        bubblewrapPath: null
      })
    ).toThrow(/requires Bubblewrap/i);
  });

  it('rejects a workdir outside the approved roots before constructing a sandbox', () => {
    expect(() =>
      buildBubblewrapLaunch(
        { command: ['/bin/sh', '-c', 'true'], cwd: '/home/example/private', roots, env, platform: 'linux' },
        '/usr/bin/bwrap'
      )
    ).toThrow(/outside the approved roots/i);
  });

  it('builds a network-isolated launch with only approved roots writable', () => {
    const launch = buildBubblewrapLaunch(
      { command: ['/bin/bash', '-lc', 'printf ok'], cwd: roots[0]!.path, roots, env, platform: 'linux' },
      '/usr/bin/bwrap'
    );

    expect(launch.command[0]).toBe('/bin/bash');
    expect(launch.command).toContain('/usr/bin/bwrap');
    expect(launch.command).toContain('--unshare-all');
    expect(launch.command).toContain('--seccomp');
    const seccomp = launch.command.indexOf('--seccomp');
    expect(launch.command[seccomp + 1]).toBe('3');
    expect(launch.command).toContain('--clearenv');
    expect(launch.command).toContain('--tmpfs');
    expect(launch.command).toContain('/run/local-cgpt');
    expect(launch.command).toContain('--chdir');
    expect(launch.command).toContain(roots[0]!.path);

    const bind = launch.command.findIndex((entry, index) => entry === '--bind' && launch.command[index + 1] === roots[0]!.path);
    expect(bind).toBeGreaterThan(-1);
    expect(launch.command[bind + 2]).toBe(roots[0]!.path);

    const joined = launch.command.join('\u0000');
    expect(joined).not.toContain('GITHUB_TOKEN');
    expect(joined).not.toContain('must-not-be-forwarded-by-bwrap');
    expect(joined).not.toContain('/home/example/.local/bin');
    expect(joined).toContain('/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin');
    expect(joined).toContain('/run/local-cgpt/home');
    expect(joined).toContain('/run/local-cgpt/tmp');
    expect(launch.command.slice(-3)).toEqual(['/bin/bash', '-lc', 'printf ok']);
    expect(launch.cwd).toBe('/');
    expect(launch.env).toEqual({});
  });

  it('compiles the VSOCK/io_uring seccomp rules for every supported Linux architecture', () => {
    for (const arch of ['x64', 'arm64'] as const) {
      const instructions = decodeSeccompFilter(buildCommandNetworkSeccompFilter(arch));
      expect(instructions.some((entry) => entry.code === 0x15 && entry.k === 40)).toBe(true); // AF_VSOCK
      expect(instructions.some((entry) => entry.code === 0x15 && entry.k === 425)).toBe(true); // io_uring_setup
      expect(instructions.some((entry) => entry.code === 0x06 && entry.k === 0x00050001)).toBe(true); // EPERM
      expect(instructions.at(-1)).toMatchObject({ code: 0x06, k: 0x7fff0000 }); // ALLOW
    }
    expect(() => buildCommandNetworkSeccompFilter('s390x')).toThrow(/unsupported Linux architecture/i);
  });

  it('uses a fixed argv-only pre-launcher and still gives Bubblewrap an empty environment', () => {
    const launch = buildBubblewrapLaunch(
      { command: ['/bin/sh', '-c', 'true'], cwd: roots[0]!.path, roots, env, platform: 'linux' },
      '/usr/bin/bwrap'
    );
    expect(launch.command.slice(0, 4)).toEqual(['/bin/bash', '--noprofile', '--norc', '-c']);
    expect(launch.command[4]).toContain('exec -c "$@"');
    expect(launch.command[5]).toBe('local-cgpt-seccomp-launcher');
    expect(launch.command[6]).toMatch(/^(?:\\x[0-9a-f]{2})+$/);
    expect(launch.command[7]).toBe('/usr/bin/bwrap');
    expect(launch.env).toEqual({});
  });

  it('gives the Bubblewrap security boundary no inherited loader, interpreter, git, or agent environment', () => {
    const hostileEnv = {
      ...env,
      LD_PRELOAD: '/host/evil.so',
      LD_LIBRARY_PATH: '/host/evil-libs',
      BASH_ENV: '/host/bash-env',
      ENV: '/host/sh-env',
      PYTHONPATH: '/host/python',
      PYTHONSTARTUP: '/host/python-startup',
      NODE_OPTIONS: '--require=/host/node-hook.js',
      RUBYOPT: '-r/host/ruby-hook.rb',
      PERL5OPT: '-MHost::Hook',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'credential.helper',
      GIT_CONFIG_VALUE_0: '!/host/credential-helper',
      SSH_AUTH_SOCK: '/run/user/1000/ssh-agent.socket',
      GPG_AGENT_INFO: '/run/user/1000/gnupg/S.gpg-agent'
    };
    const launch = buildBubblewrapLaunch(
      { command: ['/bin/sh', '-c', 'true'], cwd: roots[0]!.path, roots, env: hostileEnv, platform: 'linux' },
      '/usr/bin/bwrap'
    );

    // The fixed Bash helper starts empty and uses `exec -c` when replacing itself with bwrap.
    // Safe child variables are explicit --setenv args applied only after bwrap --clearenv.
    expect(launch.env).toEqual({});
    const setenvNames = launch.command
      .map((entry, index) => (entry === '--setenv' ? launch.command[index + 1] : null))
      .filter((entry): entry is string => entry !== null);
    expect(setenvNames).toEqual([
      'HOME',
      'TMPDIR',
      'XDG_CONFIG_HOME',
      'XDG_CACHE_HOME',
      'XDG_DATA_HOME',
      'PATH',
      'LANG',
      'LC_ALL',
      'TERM'
    ]);
    for (const name of Object.keys(hostileEnv)) {
      if (['PATH', 'LANG', 'TERM'].includes(name)) continue;
      expect(setenvNames).not.toContain(name);
    }
  });

  it('does not widen nested approved roots into their parent directories', () => {
    const launch = buildBubblewrapLaunch(
      {
        command: ['/bin/sh', '-c', 'pwd'],
        cwd: '/home/example/project/subdir',
        roots: [
          { name: 'project', path: '/home/example/project' },
          { name: 'nested', path: '/home/example/project/subdir' }
        ],
        env,
        platform: 'linux'
      },
      '/usr/bin/bwrap'
    );
    const writableSources = launch.command
      .map((entry, index) => (entry === '--bind' ? launch.command[index + 1] : null))
      .filter((entry): entry is string => entry !== null);
    expect(writableSources).toEqual(['/home/example/project']);
    expect(writableSources).not.toContain('/home/example');
    expect(writableSources).not.toContain('/home');
  });

  it('rejects malformed host mount capabilities instead of widening them', () => {
    expect(() =>
      buildBubblewrapLaunch(
        {
          command: ['/bin/sh', '-c', 'true'],
          cwd: '/tmp/project',
          roots: [{ name: 'everything', path: '/' }],
          env,
          platform: 'linux'
        },
        '/usr/bin/bwrap'
      )
    ).toThrow(/cannot be the filesystem root/i);

    expect(() =>
      buildBubblewrapLaunch(
        {
          command: ['/bin/sh', '-c', 'true'],
          cwd: '/home/example/project',
          roots,
          env,
          platform: 'linux',
          runtimeReadPaths: ['/']
        },
        '/usr/bin/bwrap'
      )
    ).toThrow(/cannot be the filesystem root/i);

    expect(() =>
      buildBubblewrapLaunch(
        {
          command: ['/bin/sh', '-c', 'true'],
          cwd: '/home/example/project',
          roots: [{ name: 'relative', path: 'project' }],
          env,
          platform: 'linux'
        },
        '/usr/bin/bwrap'
      )
    ).toThrow(/absolute host path/i);
  });

  it('revalidates an approved root before giving Bubblewrap write authority', () => {
    if (process.platform !== 'linux') return;
    const base = mkdtempSync(path.join(os.tmpdir(), 'local-cgpt-root-identity-'));
    const approved = path.join(base, 'approved');
    const moved = path.join(base, 'approved-old');
    const outside = path.join(base, 'outside');
    mkdirSync(approved);
    mkdirSync(outside);
    try {
      renameSync(approved, moved);
      symlinkSync(outside, approved, 'dir');
      expect(() =>
        sandboxCommandLaunch({
          command: ['/bin/sh', '-c', 'true'],
          cwd: approved,
          roots: [{ name: 'approved', path: approved }],
          env,
          platform: 'linux',
          bubblewrapPath: '/usr/bin/bwrap'
        })
      ).toThrow(/changed on disk/i);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('canonicalizes cwd and refuses a symlink that leaves an unchanged approved root', () => {
    if (process.platform !== 'linux') return;
    const base = mkdtempSync(path.join(os.tmpdir(), 'local-cgpt-cwd-identity-'));
    const approved = path.join(base, 'approved');
    const outside = path.join(base, 'outside');
    const escape = path.join(approved, 'escape');
    mkdirSync(approved);
    mkdirSync(outside);
    symlinkSync(outside, escape, 'dir');
    try {
      expect(() =>
        sandboxCommandLaunch({
          command: ['/bin/sh', '-c', 'true'],
          cwd: escape,
          roots: [{ name: 'approved', path: approved }],
          env,
          platform: 'linux',
          bubblewrapPath: '/usr/bin/bwrap'
        })
      ).toThrow(/outside the approved roots/i);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('mounts app runtime tools read-only without exposing their parent tree', () => {
    const launch = buildBubblewrapLaunch(
      {
        command: ['/bin/sh', '-c', 'rg needle .'],
        cwd: roots[0]!.path,
        roots,
        env,
        platform: 'linux',
        runtimeReadPaths: ['/opt/local-cgpt/resources/rg']
      },
      '/usr/bin/bwrap'
    );
    const roBind = launch.command.findIndex(
      (entry, index) => entry === '--ro-bind' && launch.command[index + 1] === '/opt/local-cgpt/resources/rg'
    );
    // The synthetic path does not exist in this unit test, so it must not be mounted blindly.
    expect(roBind).toBe(-1);
  });
});

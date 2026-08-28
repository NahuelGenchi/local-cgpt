import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CommandSandboxError,
  buildBubblewrapLaunch,
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

    expect(launch.command[0]).toBe('/usr/bin/bwrap');
    expect(launch.command).toContain('--unshare-all');
    expect(launch.command).toContain('--clearenv');
    expect(launch.command).toContain('--tmpfs');
    expect(launch.command).toContain('/tmp');
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
    expect(launch.command.slice(-3)).toEqual(['/bin/bash', '-lc', 'printf ok']);
    expect(launch.cwd).toBe('/');
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
});
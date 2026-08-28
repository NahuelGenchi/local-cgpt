import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  locateBubblewrap,
  sandboxCommandLaunch,
  setCommandSandboxBypassForTests,
  type CommandSandboxLaunch
} from '../src/main/command-sandbox.js';

let base = '';

beforeEach(() => setCommandSandboxBypassForTests(false));
afterEach(async () => {
  setCommandSandboxBypassForTests(true);
  if (base) await fs.rm(base, { recursive: true, force: true });
  base = '';
});

async function runLaunch(launch: CommandSandboxLaunch) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(launch.command[0]!, launch.command.slice(1), {
      cwd: launch.cwd,
      env: launch.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

it('executes the exact production Bubblewrap profile and enforces its boundaries', async () => {
  if (process.platform !== 'linux') return;
  const bwrap = locateBubblewrap();
  if (!bwrap) {
    expect(process.env.REQUIRE_COMMAND_SANDBOX_INTEGRATION).not.toBe('1');
    return;
  }

  base = await fs.mkdtemp(path.join(os.tmpdir(), 'local-cgpt-bwrap-'));
  const approved = path.join(base, 'approved');
  const privateDir = path.join(base, 'private');
  await fs.mkdir(approved);
  await fs.mkdir(privateDir);
  const privateFile = path.join(privateDir, 'outside-secret.txt');
  await fs.writeFile(privateFile, 'outside-secret\n', 'utf8');
  await fs.symlink(privateFile, path.join(approved, 'escape-link'));

  const script = [
    'set -eu',
    'test -z "${LOCAL_CGPT_SANDBOX_SECRET-}"',
    'test -z "${LD_PRELOAD-}"',
    'test -z "${LD_LIBRARY_PATH-}"',
    'test -z "${BASH_ENV-}"',
    'test -z "${ENV-}"',
    'test -z "${PYTHONPATH-}"',
    'test -z "${PYTHONSTARTUP-}"',
    'test -z "${NODE_OPTIONS-}"',
    'test -z "${RUBYOPT-}"',
    'test -z "${PERL5OPT-}"',
    'test -z "${GIT_CONFIG_COUNT-}"',
    'test -z "${SSH_AUTH_SOCK-}"',
    'test -z "${GPG_AGENT_INFO-}"',
    'test "$HOME" = "/run/local-cgpt/home"',
    'test "$TMPDIR" = "/run/local-cgpt/tmp"',
    'test ! -e /run/user',
    'test ! -r escape-link',
    'test ! -e /sys/class/net/eth0',
    'printf "sandbox-write\\n" > inside.txt',
    'printf "ok\\n"'
  ].join('; ');

  const productionLaunch = sandboxCommandLaunch({
    command: ['/bin/sh', '-c', script],
    cwd: approved,
    roots: [{ name: 'approved', path: approved }],
    env: {
      PATH: process.env.PATH,
      LANG: process.env.LANG ?? 'C.UTF-8',
      LC_ALL: process.env.LC_ALL ?? 'C.UTF-8',
      LOCAL_CGPT_SANDBOX_SECRET: 'must-not-enter-child',
      LD_PRELOAD: '/definitely/not/a/real/local-cgpt-library.so',
      LD_LIBRARY_PATH: '/definitely/not/a/real/local-cgpt-library-path',
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
    },
    platform: 'linux'
  });

  expect(productionLaunch.command).toContain('--unshare-all');
  expect(productionLaunch.command).not.toContain('--share-net');
  expect(productionLaunch.env).toEqual({});

  const result = await runLaunch(productionLaunch);
  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toBe('ok\n');
  expect(result.stderr).not.toMatch(/preload|LD_LIBRARY_PATH/i);
  expect(await fs.readFile(path.join(approved, 'inside.txt'), 'utf8')).toBe('sandbox-write\n');
  expect(await fs.readFile(privateFile, 'utf8')).toBe('outside-secret\n');
}, 20_000);

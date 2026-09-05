import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  buildBubblewrapLaunch,
  locateBubblewrap,
  sandboxCommandLaunch,
  setCommandSandboxBypassForTests,
  type CommandSandboxLaunch
} from '../src/main/command-sandbox.js';
import {
  applyProjectAutonomyToLaunch,
  POKEMING_AUTONOMY_PROFILE,
  type ProjectAutonomyPolicy
} from '../src/main/project-autonomy.js';

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

function listenLocalhost(): Promise<{ server: net.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      socket.once('data', () => socket.end('pong'));
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('localhost test listener did not receive a TCP port'));
        return;
      }
      resolve({ server, port: address.port });
    });
  });
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
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

  const seccompProbe = [
    'import ctypes, errno, socket',
    'libc = ctypes.CDLL(None, use_errno=True)',
    'result = libc.socket(socket.AF_VSOCK, socket.SOCK_STREAM, 0)',
    'assert result == -1 and ctypes.get_errno() == errno.EPERM, (result, ctypes.get_errno())',
    'ctypes.set_errno(0)',
    'result = libc.syscall(425, 1, 0)',
    'assert result == -1 and ctypes.get_errno() == errno.EPERM, (result, ctypes.get_errno())',
    'ordinary = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)',
    'ordinary.close()'
  ].join('; ');

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
    `python3 -c '${seccompProbe}'`,
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
  expect(productionLaunch.command).toContain('--seccomp');
  expect(productionLaunch.command).not.toContain('--share-net');
  expect(productionLaunch.env).toEqual({});

  const result = await runLaunch(productionLaunch);
  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toBe('ok\n');
  expect(result.stderr).not.toMatch(/preload|LD_LIBRARY_PATH/i);
  expect(await fs.readFile(path.join(approved, 'inside.txt'), 'utf8')).toBe('sandbox-write\n');
  expect(await fs.readFile(privateFile, 'utf8')).toBe('outside-secret\n');
}, 20_000);

it('executes a trusted runtime PATH entry read-only through real Bubblewrap', async () => {
  if (process.platform !== 'linux') return;
  const bwrap = locateBubblewrap();
  if (!bwrap) {
    expect(process.env.REQUIRE_COMMAND_SANDBOX_INTEGRATION).not.toBe('1');
    return;
  }

  base = await fs.mkdtemp(path.join(os.tmpdir(), 'local-cgpt-runtime-bwrap-'));
  const approved = path.join(base, 'approved');
  const toolchain = path.join(base, 'trusted-toolchain');
  const bin = path.join(toolchain, 'bin');
  await fs.mkdir(approved);
  await fs.mkdir(bin, { recursive: true });
  const cargo = path.join(bin, 'cargo');
  await fs.writeFile(cargo, '#!/bin/sh\nprintf "trusted-cargo\\n"\n', 'utf8');
  await fs.chmod(cargo, 0o755);

  const script = [
    'set -eu',
    'test "$HOME" = "/run/local-cgpt/home"',
    'test "$(command -v cargo)" = ' + JSON.stringify(cargo),
    'cargo',
    `if touch ${JSON.stringify(path.join(toolchain, 'write-probe'))} 2>/dev/null; then exit 91; fi`,
    'printf "readonly-ok\\n"'
  ].join('; ');

  const launch = buildBubblewrapLaunch(
    {
      command: ['/bin/sh', '-c', script],
      cwd: approved,
      roots: [{ name: 'approved', path: approved }],
      env: { LANG: 'C.UTF-8' },
      platform: 'linux',
      runtimeReadPaths: [toolchain],
      runtimePathEntries: [bin]
    },
    bwrap
  );
  const result = await runLaunch(launch);
  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toBe('trusted-cargo\nreadonly-ok\n');
  await expect(fs.access(path.join(toolchain, 'write-probe'))).rejects.toMatchObject({ code: 'ENOENT' });
}, 20_000);

it('shares localhost only for an explicitly network-enabled autonomy policy', async () => {
  if (process.platform !== 'linux') return;
  const bwrap = locateBubblewrap();
  if (!bwrap) {
    expect(process.env.REQUIRE_COMMAND_SANDBOX_INTEGRATION).not.toBe('1');
    return;
  }

  base = await fs.mkdtemp(path.join(os.tmpdir(), 'local-cgpt-autonomy-net-'));
  const approved = path.join(base, 'approved');
  await fs.mkdir(approved);
  const projectStateDir = path.join(approved, '.local', 'local-cgpt');
  const policy: ProjectAutonomyPolicy = {
    profile: POKEMING_AUTONOMY_PROFILE,
    rootName: 'approved',
    rootPath: approved,
    virtualRoot: '/approved',
    projectStateDir,
    homeDir: path.join(projectStateDir, 'home'),
    taskPath: path.join(projectStateDir, 'task.json'),
    allowNetwork: true,
    persistentProcesses: true,
    persistentHome: true,
    maxLogBytes: 64 * 1024 * 1024
  };

  const { server, port } = await listenLocalhost();
  try {
    const probe = [
      'import socket',
      `s=socket.create_connection(("127.0.0.1", ${port}), timeout=1)`,
      's.sendall(b"ping")',
      'print(s.recv(4).decode(), flush=True)',
      's.close()'
    ].join('; ');
    const baseLaunch = buildBubblewrapLaunch(
      {
        command: ['/usr/bin/python3', '-c', probe],
        cwd: approved,
        roots: [{ name: 'approved', path: approved }],
        env: { LANG: 'C.UTF-8' },
        platform: 'linux'
      },
      bwrap
    );

    const denied = applyProjectAutonomyToLaunch(
      baseLaunch.command,
      { ...policy, allowNetwork: false },
      { surviveParent: false }
    );
    expect(denied).not.toContain('--share-net');
    const deniedResult = await runLaunch({ ...baseLaunch, command: denied });
    expect(deniedResult.code).not.toBe(0);

    const allowed = applyProjectAutonomyToLaunch(baseLaunch.command, policy, { surviveParent: false });
    expect(allowed).toContain('--share-net');
    expect(allowed).toEqual(expect.arrayContaining(['--bind', policy.homeDir, '/run/local-cgpt/home']));
    const allowedResult = await runLaunch({ ...baseLaunch, command: allowed });
    expect(allowedResult.code, allowedResult.stderr).toBe(0);
    expect(allowedResult.stdout).toBe('pong\n');
  } finally {
    await closeServer(server);
  }
}, 20_000);

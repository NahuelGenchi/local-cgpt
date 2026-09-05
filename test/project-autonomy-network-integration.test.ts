import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  buildBubblewrapLaunch,
  locateBubblewrap,
  type CommandSandboxLaunch
} from '../src/main/command-sandbox.js';
import {
  applyProjectAutonomyToLaunch,
  POKEMING_AUTONOMY_PROFILE,
  type ProjectAutonomyPolicy
} from '../src/main/project-autonomy.js';

let base = '';

afterEach(async () => {
  if (base) await fs.rm(base, { recursive: true, force: true });
  base = '';
});

function runLaunch(launch: CommandSandboxLaunch): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
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

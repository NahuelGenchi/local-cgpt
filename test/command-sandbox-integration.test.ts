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

function hostedRunnerFilesystemLaunch(launch: CommandSandboxLaunch): CommandSandboxLaunch {
  const unshareAll = launch.command.indexOf('--unshare-all');
  if (unshareAll === -1) throw new Error('Production Bubblewrap launch must contain --unshare-all');
  if (launch.command.includes('--share-net')) throw new Error('Production Bubblewrap launch must not share the host network');

  // GitHub-hosted Azure runners currently allow Bubblewrap mount/user namespaces but can reject
  // configuration of the nested network namespace with RTM_NEWADDR. For CI only, keep every
  // production filesystem/environment restriction while sharing the runner network namespace so
  // the real mount/env containment can still execute. Production never uses this derived launch.
  const command = [...launch.command];
  command.splice(unshareAll + 1, 0, '--share-net');
  return { ...launch, command };
}

function isHostedRunnerNetworkNamespaceRestriction(stderr: string): boolean {
  return stderr.includes('loopback: Failed RTM_NEWADDR: Operation not permitted');
}

it('enforces filesystem and environment isolation in a real Bubblewrap process', async () => {
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
    'test "$HOME" = "/run/local-cgpt/home"',
    'test "$TMPDIR" = "/run/local-cgpt/tmp"',
    'test ! -r escape-link',
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
      LOCAL_CGPT_SANDBOX_SECRET: 'must-not-enter-child'
    },
    platform: 'linux'
  });

  expect(productionLaunch.command).toContain('--unshare-all');
  expect(productionLaunch.command).not.toContain('--share-net');

  let result = await runLaunch(productionLaunch);
  if (
    result.code !== 0 &&
    process.env.ALLOW_HOSTED_RUNNER_NETWORK_NAMESPACE_LIMITATION === '1' &&
    isHostedRunnerNetworkNamespaceRestriction(result.stderr)
  ) {
    console.warn(
      'Hosted runner cannot configure Bubblewrap network namespace; rerunning only the real filesystem/environment containment proof with --share-net. Production remains --unshare-all.'
    );
    result = await runLaunch(hostedRunnerFilesystemLaunch(productionLaunch));
  }

  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toBe('ok\n');
  expect(await fs.readFile(path.join(approved, 'inside.txt'), 'utf8')).toBe('sandbox-write\n');
  expect(await fs.readFile(privateFile, 'utf8')).toBe('outside-secret\n');
}, 20_000);

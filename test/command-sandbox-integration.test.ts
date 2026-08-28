import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  locateBubblewrap,
  sandboxCommandLaunch,
  setCommandSandboxBypassForTests
} from '../src/main/command-sandbox.js';

let base = '';

beforeEach(() => setCommandSandboxBypassForTests(false));
afterEach(async () => {
  setCommandSandboxBypassForTests(true);
  if (base) await fs.rm(base, { recursive: true, force: true });
  base = '';
});

async function run(command: string[], cwd: string, roots: Array<{ name: string; path: string }>) {
  const launch = sandboxCommandLaunch({
    command,
    cwd,
    roots,
    env: {
      PATH: process.env.PATH,
      LANG: process.env.LANG ?? 'C.UTF-8',
      LC_ALL: process.env.LC_ALL ?? 'C.UTF-8',
      LOCAL_CGPT_SANDBOX_SECRET: 'must-not-enter-child'
    },
    platform: 'linux'
  });
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

  const result = await run(['/bin/sh', '-c', script], approved, [{ name: 'approved', path: approved }]);
  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toBe('ok\n');
  expect(await fs.readFile(path.join(approved, 'inside.txt'), 'utf8')).toBe('sandbox-write\n');
  expect(await fs.readFile(privateFile, 'utf8')).toBe('outside-secret\n');
}, 20_000);
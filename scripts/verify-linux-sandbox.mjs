#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

function fail(message) {
  console.error(`Linux sandbox verification failed: ${message}`);
  process.exit(1);
}

if (process.platform !== 'linux') {
  fail(`unsupported platform ${process.platform}; local-cgpt currently supports Linux only`);
}

const bwrap = spawnSync('bwrap', ['--version'], { encoding: 'utf8' });
if (bwrap.error?.code === 'ENOENT') {
  fail('Bubblewrap (bwrap) is not installed or not on PATH');
}
if (bwrap.status !== 0) {
  fail(`Bubblewrap is not usable: ${(bwrap.stderr || bwrap.stdout || '').trim() || `exit ${bwrap.status}`}`);
}

const vitest = path.resolve('node_modules/vitest/vitest.mjs');
if (!existsSync(vitest)) {
  fail('dependencies are not installed; run npm ci first');
}

console.log(`Platform: ${process.platform} ${process.arch}`);
console.log(`Bubblewrap: ${(bwrap.stdout || '').trim()}`);
console.log('Running the exact production command-sandbox profile as the current user...');

const result = spawnSync(
  process.execPath,
  [vitest, 'run', 'test/command-sandbox-integration.test.ts'],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      REQUIRE_COMMAND_SANDBOX_INTEGRATION: '1'
    }
  }
);

if (result.error) {
  fail(result.error.message);
}
if (result.status !== 0) {
  fail(`production Bubblewrap profile did not pass (exit ${result.status ?? 'unknown'})`);
}

console.log('Linux sandbox verification passed.');
console.log('The exact production profile ran as the current user with approved-root, environment, and network-isolation assertions enabled.');

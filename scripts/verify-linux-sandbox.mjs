#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

function fail(message) {
  console.error(`Linux sandbox verification failed: ${message}`);
  process.exit(1);
}

function readTrimmed(file) {
  try {
    return readFileSync(file, 'utf8').trim();
  } catch {
    return '';
  }
}

if (process.platform !== 'linux') {
  fail(`unsupported platform ${process.platform}; local-cgpt currently supports Linux only`);
}

const bwrapPath = ['/usr/bin/bwrap', '/bin/bwrap'].find((candidate) => existsSync(candidate));
if (!bwrapPath) {
  fail('Bubblewrap (bwrap) is not installed at /usr/bin/bwrap or /bin/bwrap');
}

const bwrap = spawnSync(bwrapPath, ['--version'], { encoding: 'utf8' });
if (bwrap.status !== 0) {
  fail(`Bubblewrap is not usable: ${(bwrap.stderr || bwrap.stdout || '').trim() || `exit ${bwrap.status}`}`);
}

const namespaceProbe = spawnSync(
  bwrapPath,
  ['--unshare-user', '--unshare-net', '--ro-bind', '/', '/', '/bin/true'],
  { encoding: 'utf8' }
);
if (namespaceProbe.status !== 0) {
  const detail = (namespaceProbe.stderr || namespaceProbe.stdout || '').trim() || `exit ${namespaceProbe.status}`;
  const appArmorRestricted = readTrimmed('/proc/sys/kernel/apparmor_restrict_unprivileged_userns') === '1';
  if (appArmorRestricted && /uid map|permission denied|RTM_NEWADDR|operation not permitted/i.test(detail)) {
    fail(
      `Bubblewrap cannot create the required user/network namespaces while AppArmor's unprivileged-userns restriction is active: ${detail}\n` +
        'On Ubuntu 24.04, install/activate the distro bwrap-userns-restrict profile (the local-cgpt DEB does this safely when possible). ' +
        'Do not disable AppArmor, do not set kernel.apparmor_restrict_unprivileged_userns=0, and do not run local-cgpt with sudo.'
    );
  }
  fail(`Bubblewrap cannot create the required user/network namespaces as the current user: ${detail}`);
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

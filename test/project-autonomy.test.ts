import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { autonomousLaunchStillAuthorized } from '../src/main/codex/manager.js';
import {
  POKEMING_AUTONOMY_PROFILE,
  PROJECT_AUTONOMY_MARKER,
  applyProjectAutonomyToLaunch,
  prepareProjectAutonomyDirectories,
  projectAutonomyForVirtualCwd
} from '../src/main/project-autonomy.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let stateDir: string;
let rootDir: string;

function markerPath(): string {
  return path.join(rootDir, PROJECT_AUTONOMY_MARKER);
}

async function writeMarker(value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(markerPath()), { recursive: true });
  await fs.writeFile(markerPath(), JSON.stringify(value), 'utf8');
}

async function savePermissions(options: {
  command: boolean;
  network: boolean;
  projectAutonomy?: boolean;
  readOnly?: boolean;
}): Promise<void> {
  const config = defaultConfig();
  await saveConfig({
    ...config,
    readOnly: options.readOnly ?? false,
    roots: [{ name: 'pokeming-world', path: rootDir }],
    capabilities: {
      ...config.capabilities,
      command: options.command,
      network: options.network,
      projectAutonomy: options.projectAutonomy ?? true
    }
  });
}

function syntheticBubblewrap(): string[] {
  return [
    '/bin/bash', '--noprofile', '--norc', '-c', 'exec "$@"', 'launcher', 'filter', '/usr/bin/bwrap',
    '--die-with-parent', '--new-session', '--unshare-all', '--seccomp', '3', '--proc', '/proc',
    '--dir', '/run/local-cgpt/home', '--setenv', 'HOME', '/run/local-cgpt/home',
    '--setenv', 'XDG_CONFIG_HOME', '/run/local-cgpt/home/.config',
    '--setenv', 'XDG_CACHE_HOME', '/run/local-cgpt/home/.cache',
    '--setenv', 'XDG_DATA_HOME', '/run/local-cgpt/home/.local/share',
    '--setenv', 'CARGO_HOME', '/home/example/.cargo', '--setenv', 'CARGO_NET_OFFLINE', 'true',
    '--bind', rootDir, rootDir,
    '--chdir', rootDir, '--', '/bin/bash', '-lc', 'cargo test'
  ];
}

beforeAll(async () => {
  stateDir = await makeTempDir('local-cgpt-autonomy-state-');
  rootDir = await makeTempDir('local-cgpt-autonomy-root-');
  initConfigPath(stateDir);
});

afterAll(async () => {
  await removeTempDir(stateDir);
  await removeTempDir(rootDir);
});

beforeEach(async () => {
  await fs.rm(path.join(rootDir, '.local'), { recursive: true, force: true });
  await writeMarker({ version: 1, profile: POKEMING_AUTONOMY_PROFILE });
  await savePermissions({ command: true, network: false });
});

describe('project autonomy profile', () => {
  it('requires app-owned project-autonomy authority in addition to the repository marker', async () => {
    await savePermissions({ command: true, network: true, projectAutonomy: false });
    expect(projectAutonomyForVirtualCwd('/pokeming-world')).toBeNull();

    await savePermissions({ command: true, network: true, projectAutonomy: true });
    expect(projectAutonomyForVirtualCwd('/pokeming-world')?.profile).toBe(POKEMING_AUTONOMY_PROFILE);
  });

  it('cannot enable itself when command authority is off or read-only mode is on', async () => {
    await savePermissions({ command: false, network: true });
    expect(projectAutonomyForVirtualCwd('/pokeming-world')).toBeNull();

    await savePermissions({ command: true, network: true, readOnly: true });
    expect(projectAutonomyForVirtualCwd('/pokeming-world')).toBeNull();
  });

  it('treats network in the marker as intent, not authority', async () => {
    await writeMarker({ version: 1, profile: POKEMING_AUTONOMY_PROFILE, network: true });
    await savePermissions({ command: true, network: false });
    const denied = projectAutonomyForVirtualCwd('/pokeming-world');
    expect(denied?.allowNetwork).toBe(false);

    await savePermissions({ command: true, network: true });
    const allowed = projectAutonomyForVirtualCwd('/pokeming-world');
    expect(allowed?.allowNetwork).toBe(true);
  });

  it('fails closed for malformed, unknown-key and symlinked markers', async () => {
    await fs.writeFile(markerPath(), '{not json', 'utf8');
    expect(projectAutonomyForVirtualCwd('/pokeming-world')).toBeNull();

    await writeMarker({ version: 1, profile: POKEMING_AUTONOMY_PROFILE, surprise: true });
    expect(projectAutonomyForVirtualCwd('/pokeming-world')).toBeNull();

    const target = path.join(rootDir, 'profile-target.json');
    await fs.writeFile(target, JSON.stringify({ version: 1, profile: POKEMING_AUTONOMY_PROFILE }), 'utf8');
    await fs.rm(markerPath(), { force: true });
    await fs.symlink(target, markerPath());
    expect(projectAutonomyForVirtualCwd('/pokeming-world')).toBeNull();
  });

  it('keeps network offline and persists HOME/XDG only through the already-approved root mount', async () => {
    const policy = projectAutonomyForVirtualCwd('/pokeming-world');
    expect(policy).not.toBeNull();
    const launch = applyProjectAutonomyToLaunch(syntheticBubblewrap(), policy!, { surviveParent: true });

    expect(launch).not.toContain('--share-net');
    expect(launch).not.toContain('--die-with-parent');
    const offline = launch.indexOf('CARGO_NET_OFFLINE');
    expect(launch[offline + 1]).toBe('true');
    for (const [name, expected] of [
      ['HOME', policy!.homeDir],
      ['XDG_CONFIG_HOME', path.join(policy!.homeDir, '.config')],
      ['XDG_CACHE_HOME', path.join(policy!.homeDir, '.cache')],
      ['XDG_DATA_HOME', path.join(policy!.homeDir, '.local', 'share')]
    ] as const) {
      const index = launch.indexOf(name);
      expect(launch[index + 1]).toBe(expected);
    }
    expect(launch).not.toEqual(expect.arrayContaining(['--bind', policy!.homeDir, '/run/local-cgpt/home']));
  });

  it('adds only explicit networking and a project-contained Cargo home when both gates allow it', async () => {
    await savePermissions({ command: true, network: true });
    const policy = projectAutonomyForVirtualCwd('/pokeming-world');
    expect(policy?.allowNetwork).toBe(true);
    const launch = applyProjectAutonomyToLaunch(syntheticBubblewrap(), policy!, { surviveParent: false });

    expect(launch).toContain('--share-net');
    expect(launch).toContain('--die-with-parent');
    const offline = launch.indexOf('CARGO_NET_OFFLINE');
    const cargoHome = launch.indexOf('CARGO_HOME');
    expect(launch[offline + 1]).toBe('false');
    expect(launch[cargoHome + 1]).toBe(path.join(policy!.homeDir, '.cargo'));
    expect(launch).toEqual(expect.arrayContaining(['--seccomp', '3']));
  });

  it('keeps HOME and Cargo ephemeral when the profile disables persistentHome', async () => {
    await writeMarker({
      version: 1,
      profile: POKEMING_AUTONOMY_PROFILE,
      network: true,
      persistentHome: false
    });
    await savePermissions({ command: true, network: true });
    const policy = projectAutonomyForVirtualCwd('/pokeming-world');
    expect(policy?.persistentHome).toBe(false);
    const launch = applyProjectAutonomyToLaunch(syntheticBubblewrap(), policy!, { surviveParent: false });

    expect(launch[launch.indexOf('HOME') + 1]).toBe('/run/local-cgpt/home');
    expect(launch[launch.indexOf('XDG_CONFIG_HOME') + 1]).toBe('/run/local-cgpt/home/.config');
    expect(launch[launch.indexOf('CARGO_HOME') + 1]).toBe('/run/local-cgpt/home/.cargo');
    expect(launch[launch.indexOf('CARGO_NET_OFFLINE') + 1]).toBe('false');
  });

  it('revalidates live authority and writable root mounts after asynchronous caller proof', async () => {
    await savePermissions({ command: true, network: true });
    const policy = projectAutonomyForVirtualCwd('/pokeming-world');
    expect(policy).not.toBeNull();
    expect(autonomousLaunchStillAuthorized(syntheticBubblewrap(), '/pokeming-world', policy!)).not.toBeNull();

    // Revoking command authority while identity is being proved must invalidate the prebuilt argv.
    await savePermissions({ command: false, network: true });
    expect(autonomousLaunchStillAuthorized(syntheticBubblewrap(), '/pokeming-world', policy!)).toBeNull();

    // Restoring command authority but narrowing the repository profile must also require a retry.
    await savePermissions({ command: true, network: true });
    await writeMarker({ version: 1, profile: POKEMING_AUTONOMY_PROFILE, network: false });
    expect(autonomousLaunchStillAuthorized(syntheticBubblewrap(), '/pokeming-world', policy!)).toBeNull();
  });

  it('rejects a stale writable root that is no longer approved', async () => {
    const policy = projectAutonomyForVirtualCwd('/pokeming-world');
    expect(policy).not.toBeNull();
    const outside = await makeTempDir('local-cgpt-autonomy-stale-root-');
    try {
      const command = syntheticBubblewrap();
      const chdir = command.indexOf('--chdir');
      command.splice(chdir, 0, '--bind', outside, outside);
      expect(autonomousLaunchStillAuthorized(command, '/pokeming-world', policy!)).toBeNull();
    } finally {
      await removeTempDir(outside);
    }
  });

  it('fails closed when a model-writable project-state parent becomes a symlink after policy resolution', async () => {
    const policy = projectAutonomyForVirtualCwd('/pokeming-world');
    expect(policy).not.toBeNull();

    const outside = await makeTempDir('local-cgpt-autonomy-outside-');
    try {
      const originalLocal = path.join(rootDir, '.local-original');
      await fs.rename(path.join(rootDir, '.local'), originalLocal);
      await fs.symlink(outside, path.join(rootDir, '.local'), 'dir');

      expect(() => prepareProjectAutonomyDirectories(policy!)).toThrow();
      expect(() => applyProjectAutonomyToLaunch(syntheticBubblewrap(), policy!, { surviveParent: true })).toThrow();
      await expect(fs.stat(path.join(outside, 'local-cgpt', 'home'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await removeTempDir(outside);
    }
  });

  it('rejects an unexpected sandbox shape instead of guessing', async () => {
    const policy = projectAutonomyForVirtualCwd('/pokeming-world');
    expect(() => applyProjectAutonomyToLaunch(['/bin/echo', 'hello'], policy!, { surviveParent: false }))
      .toThrow(/AUTONOMY_SANDBOX_SHAPE/);
  });
});

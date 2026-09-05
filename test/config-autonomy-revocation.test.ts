import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  defaultConfig,
  getConfig,
  initConfigPath,
  saveConfig,
  setProjectAutonomyRevocationHook,
  updateConfig
} from '../src/main/config.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let dir: string;

beforeEach(async () => {
  dir = await makeTempDir('local-cgpt-config-autonomy-revoke-');
  initConfigPath(dir);
  setProjectAutonomyRevocationHook(null);
});

afterEach(async () => {
  setProjectAutonomyRevocationHook(null);
  await removeTempDir(dir);
});

function autonomousConfig() {
  const base = defaultConfig();
  return {
    ...base,
    readOnly: false,
    roots: [{ name: 'project', path: '/tmp/local-cgpt-project' }],
    capabilities: {
      ...base.capabilities,
      command: true,
      network: true,
      projectAutonomy: true
    }
  };
}

describe('project autonomy config revocation barrier', () => {
  it('runs cleanup only after a durable authority-narrowing transition', async () => {
    await saveConfig(autonomousConfig());
    const observed: Array<{ network: boolean; roots: number }> = [];
    setProjectAutonomyRevocationHook(async () => {
      observed.push({
        network: getConfig().capabilities.network,
        roots: getConfig().roots.length
      });
    });

    // Unrelated preference changes and root additions only widen/retain authority.
    await updateConfig((config) => ({ ...config, ui: { ...config.ui, theme: 'light' } }));
    await updateConfig((config) => ({
      ...config,
      roots: [...config.roots, { name: 'other', path: '/tmp/local-cgpt-other' }]
    }));
    expect(observed).toEqual([]);

    // Network revocation is published before cleanup runs, so no new launch can retain it.
    await updateConfig((config) => ({
      ...config,
      capabilities: { ...config.capabilities, network: false }
    }));
    expect(observed).toEqual([{ network: false, roots: 2 }]);

    // Re-enabling is a widening and leaves surviving work alone.
    await updateConfig((config) => ({
      ...config,
      capabilities: { ...config.capabilities, network: true }
    }));
    expect(observed).toHaveLength(1);

    // Removing any previously approved root is another narrowing transition.
    await updateConfig((config) => ({ ...config, roots: config.roots.slice(0, 1) }));
    expect(observed).toHaveLength(2);
    expect(observed[1]).toEqual({ network: true, roots: 1 });
  });

  it('keeps the narrower config published when runtime cleanup fails', async () => {
    await saveConfig(autonomousConfig());
    setProjectAutonomyRevocationHook(async () => {
      throw new Error('synthetic cleanup failure');
    });

    await expect(updateConfig((config) => ({
      ...config,
      readOnly: true
    }))).rejects.toThrow('synthetic cleanup failure');

    expect(getConfig().readOnly).toBe(true);
    expect(getConfig().capabilities.command).toBe(true);
  });
});

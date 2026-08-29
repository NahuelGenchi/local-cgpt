import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => ({
  invoke: vi.fn(),
  exposed: { api: null as any }
}));

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (_name: string, api: unknown) => {
      mocked.exposed.api = api;
    }
  },
  ipcRenderer: {
    invoke: mocked.invoke,
    on: vi.fn(),
    removeListener: vi.fn()
  }
}));

await import('../src/preload/index.js');

function settings(binaryPath: string): any {
  return {
    capabilities: {},
    readOnly: true,
    tunnel: {
      kind: 'openai',
      tunnelId: '',
      desktopTunnelId: '',
      binaryPath
    },
    ui: {},
    sessions: {},
    compaction: {},
    multiAgent: {},
    goal: {}
  };
}

describe('preload privilege boundary', () => {
  beforeEach(() => {
    mocked.invoke.mockReset();
  });

  it('does not let renderer-controlled settings choose a tunnel executable path', async () => {
    const trusted = settings('/opt/local-cgpt/tunnel/tunnel-client');
    mocked.invoke.mockImplementation(async (channel: string) => {
      if (channel === 'state:get' || channel === 'settings:save') {
        return { ok: true, data: { config: trusted } };
      }
      throw new Error(`unexpected channel ${channel}`);
    });

    await mocked.exposed.api.getState();

    // A compromised renderer controls both halves of the three-way-merge payload. Supplying
    // the same malicious path in `base` and `patch` must not make that path authoritative.
    const attackerPath = '/tmp/attacker/tunnel-client';
    const reply = await mocked.exposed.api.saveSettings(settings(attackerPath), settings(attackerPath));
    expect(reply.ok).toBe(true);

    expect(mocked.invoke).toHaveBeenCalledTimes(2);
    const [channel, payload] = mocked.invoke.mock.calls[1]!;
    expect(channel).toBe('settings:save');
    expect(payload.patch.tunnel.binaryPath).toBe(trusted.tunnel.binaryPath);
    expect(payload.base.tunnel.binaryPath).toBe(trusted.tunnel.binaryPath);
    expect(JSON.stringify(payload)).not.toContain(attackerPath);
  });
});

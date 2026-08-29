import { beforeEach, describe, expect, it, vi } from 'vitest';

type Handler = (event: unknown, payload: unknown) => Promise<unknown>;

const harness = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  config: null as any,
  dialogResult: { canceled: true, filePaths: [] as string[] }
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: Handler) => harness.handlers.set(channel, handler)
  },
  BrowserWindow: class {},
  clipboard: { writeText: vi.fn() },
  dialog: {
    showOpenDialog: vi.fn(async () => harness.dialogResult)
  },
  nativeTheme: { themeSource: 'system' },
  shell: { openExternal: vi.fn(async () => undefined), openPath: vi.fn(async () => '') }
}));

vi.mock('../src/main/connection.js', () => ({
  applySettings: vi.fn(async () => undefined),
  connect: vi.fn(async () => undefined),
  disconnect: vi.fn(async () => undefined),
  getStatus: () => ({
    state: 'disconnected',
    detail: '',
    publicUrl: null,
    localUrl: null,
    handshakeAt: null,
    lastRequestAt: null,
    lastToolCallAt: null,
    health: null,
    surfaces: []
  }),
  onStatusChange: vi.fn()
}));

vi.mock('../src/main/config.js', () => ({
  getConfig: () => harness.config,
  updateConfig: async (update: (config: any) => any) => {
    harness.config = await update(harness.config);
    return harness.config;
  }
}));

vi.mock('../src/main/goal.js', () => ({
  listGoalModels: vi.fn(async () => []),
  MODEL_PAGE_SIZE: 50,
  retireGoalDrafts: vi.fn()
}));

vi.mock('../src/main/mcp/server.js', () => ({ forgetExposedSurface: vi.fn() }));
vi.mock('../src/main/diagnostics.js', () => ({ runDiagnostics: vi.fn(async () => ({})) }));
vi.mock('../src/main/logger.js', () => ({
  formatLogAsJson: () => '[]',
  formatLogForClipboard: () => '',
  getLog: () => [],
  logInfo: vi.fn(),
  onLog: vi.fn()
}));
vi.mock('../src/main/sandbox.js', () => ({
  RESERVED_ROOT_NAMES: new Set<string>(),
  uniqueRootName: vi.fn(),
  validateNewRoot: vi.fn(),
  SandboxError: class SandboxError extends Error {}
}));
vi.mock('../src/main/secrets.js', () => ({
  hasSecret: vi.fn(async () => false),
  isEncryptionAvailable: vi.fn(async () => true),
  secureStorageStatus: vi.fn(async () => ({ available: true, detail: null })),
  setSecret: vi.fn(async () => undefined)
}));
vi.mock('../src/main/tunnel/locate.js', () => ({
  bundledVersion: () => null,
  locateBinary: (_name: string, explicit: string) => explicit || null
}));
vi.mock('../src/main/tunnel/index.js', () => ({
  TUNNEL_ID_PATTERN: /^tunnel_[0-9a-f]{32}$/
}));
vi.mock('../src/main/bridge.js', () => ({
  bridgeStatus: vi.fn(async () => ({ running: false, paired: false })),
  cancelWorkerCommands: vi.fn(),
  onBridgeChange: vi.fn(),
  startBridge: vi.fn(async () => undefined),
  stopBridge: vi.fn(async () => undefined),
  unpair: vi.fn(async () => undefined)
}));
vi.mock('../src/main/extension-path.js', () => ({ extensionDir: () => null }));
vi.mock('../src/main/session/store.js', () => ({
  deleteSession: vi.fn(async () => undefined),
  getSession: vi.fn(async () => null),
  listSessionPage: vi.fn(async () => ({ sessions: [], total: 0, nextCursor: null })),
  readEvents: vi.fn(async () => []),
  readRecentEvents: vi.fn(async () => []),
  readHandoff: vi.fn(async () => null)
}));
vi.mock('../src/main/session/recorder.js', () => ({
  activeSessionId: () => null,
  forgetSession: () => [],
  onSessionChange: vi.fn()
}));
vi.mock('../src/main/agents.js', () => ({
  clearAgent: vi.fn(),
  onSwarmChange: vi.fn(),
  pauseSwarmForDisable: vi.fn(),
  persistAgentAuthorityNow: vi.fn(async () => true),
  resetSwarm: vi.fn(),
  swarmState: () => ({})
}));
vi.mock('../src/main/workspace.js', () => ({
  forgetWorkspaceRoot: vi.fn(),
  renameWorkspaceRoot: vi.fn()
}));
vi.mock('../src/main/platform.js', () => ({
  hostPlatformInfo: () => ({ family: 'linux', name: 'Linux', desktopAutomation: false })
}));
vi.mock('../src/main/renderer-security.js', () => ({ trustedIpcSender: () => true }));

const { CAPABILITIES } = await import('../src/shared/types.js');
const { registerIpc } = await import('../src/main/ipc.js');

const currentWindow = {
  isDestroyed: () => false,
  setBackgroundColor: vi.fn(),
  webContents: { id: 77, send: vi.fn() }
};
const event = { sender: { id: 77, mainFrame: {} }, senderFrame: {} };
// The sender check is mocked in this focused authority test. The production sender identity path
// has its own IPC regressions; these cases exercise the main-process mutation policy after entry.

function freshConfig() {
  return {
    roots: [],
    capabilities: Object.fromEntries(CAPABILITIES.map((capability) => [capability, false])),
    readOnly: true,
    tunnel: {
      kind: 'openai',
      tunnelId: 'tunnel_0123456789abcdef0123456789abcdef',
      desktopTunnelId: '',
      binaryPath: '/usr/bin/tunnel-client'
    },
    ui: {
      minimizeToTray: false,
      autoConnect: false,
      privacyScreenshots: true,
      theme: 'dark'
    },
    sessions: {
      record: false,
      retainDays: 30,
      advisoryTokens: 100_000,
      limitTokens: 200_000
    },
    compaction: { auto: false, autoTokens: 150_000 },
    multiAgent: { enabled: false, maxWorkers: 2 },
    goal: {
      enabled: false,
      model: 'openai/gpt-4o',
      reasoning: 'default',
      prompt: 'Continue only when useful.',
      objectivePrompt: 'Continue toward the stated objective.'
    }
  };
}

function settingsSnapshot(config: ReturnType<typeof freshConfig>) {
  const { roots: _roots, ...settings } = config;
  return structuredClone(settings);
}

beforeEach(() => {
  harness.config = freshConfig();
  harness.dialogResult = { canceled: true, filePaths: [] };
  currentWindow.setBackgroundColor.mockClear();
});

// register once: handlers read the mutable harness state on each invocation.
registerIpc(() => currentWindow as any);

describe('tunnel binary path authority', () => {
  it('does not let settings:save mutate tunnel.binaryPath in the Electron main process', async () => {
    const base = settingsSnapshot(harness.config);
    const patch = structuredClone(base);
    patch.tunnel.kind = 'cloudflared';
    patch.tunnel.binaryPath = '/approved/model-writable/cloudflared';

    const reply = (await harness.handlers.get('settings:save')!(event, { base, patch })) as any;

    expect(reply.ok, reply.error).toBe(true);
    // Ordinary renderer-owned tunnel settings still save, proving only executable authority is
    // pinned rather than silently dropping the whole tunnel update.
    expect(harness.config.tunnel.kind).toBe('cloudflared');
    expect(harness.config.tunnel.binaryPath).toBe('/usr/bin/tunnel-client');
  });

  it('lets binary:pick mutate tunnel.binaryPath after the native file dialog supplies the path', async () => {
    harness.dialogResult = {
      canceled: false,
      filePaths: ['/opt/local-cgpt/trusted/tunnel-client']
    };

    const reply = (await harness.handlers.get('binary:pick')!(event, undefined)) as any;

    expect(reply.ok, reply.error).toBe(true);
    expect(harness.config.tunnel.binaryPath).toBe('/opt/local-cgpt/trusted/tunnel-client');
  });
});

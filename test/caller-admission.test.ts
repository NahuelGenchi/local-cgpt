/**
 * Exercise the actual registrar/dispatcher against the real exact-ID registry.
 * Browser arrival is synthetic and timed; broker topology and recording I/O are isolated
 * so these tests prove admission, not live Chrome compatibility or filesystem execution.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

const topology = vi.hoisted(() => ({ dormant: true, retired: false, active: false }));
vi.mock('electron', () => ({
  safeStorage: {
    isAsyncEncryptionAvailable: async () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptStringAsync: async (value: string) => Buffer.from(value),
    decryptStringAsync: async (value: Buffer) => ({ result: value.toString(), shouldReEncrypt: false })
  },
  clipboard: { readText: () => '', writeText: () => undefined },
  shell: { openExternal: async () => undefined }
}));
vi.mock('../src/main/durable.js', async (original) => ({
  ...await original<typeof import('../src/main/durable.js')>(),
  writeDurableSoon: vi.fn()
}));
vi.mock('../src/main/agents.js', async (original) => ({
  ...await original<typeof import('../src/main/agents.js')>(),
  hasDormantWorkerLeases: () => topology.dormant,
  hasRetiredWorkerLeases: () => topology.retired,
  swarmRunning: () => topology.active,
  sleepSilentDetachedWorkers: () => [],
  noteAgentAlive: () => null,
  stageQueuedWorkerRevivals: () => ({ waking: [], commit() {}, rollback() {} }),
  agentForCaller: () => null,
  agentForFinishCaller: () => null,
  dormantWorkerNotice: (id: string | null) => id === 'worker-chat' ? 'WORKER_DORMANT: owner must wake this worker' : null,
  retiredWorkerForConversation: (id: string | null) => id === 'retired-chat' ? { id: 'worker-1', reason: 'cleared' } : null,
  endedWorkerNotice: () => null,
  acknowledgeOffersForConversation: () => null,
  acknowledgeOffers: () => [],
  offerMessagesForConversation: () => null,
  offerMessages: () => [],
  releaseQuiescentRun: () => undefined
}));
vi.mock('../src/main/session/recorder.js', async (original) => ({
  ...await original<typeof import('../src/main/session/recorder.js')>(),
  // The test runner normally shortens these windows. Test production budgets with a fake
  // clock instead: a shortened fixture would hide the reported admission failure.
  evidenceWindow: (production: number) => production,
  recordToolCall: vi.fn(async () => null),
  recordAgentMessage: vi.fn(async () => undefined)
}));

const { createRegistrar, ok } = await import('../src/main/mcp/kernel.js');
const { currentCall } = await import('../src/main/mcp/call-context.js');
const { withInboundRequestId } = await import('../src/main/mcp/inbound.js');
const { observeRequestCorrelation, resetCorrelationRegistryForTests } = await import('../src/main/session/correlation.js');
const { defaultConfig, getConfig, initConfigPath, saveConfig } = await import('../src/main/config.js');
const { makeTempDir, removeTempDir } = await import('./helpers.js');
const { flushDurable } = await import('../src/main/durable.js');

let dir: string;
beforeEach(async () => {
  dir = await makeTempDir('caller-admission-');
  initConfigPath(dir);
  await saveConfig({ ...defaultConfig(), sessions: { ...defaultConfig().sessions, record: false } });
  topology.dormant = true;
  topology.retired = false;
  topology.active = false;
  resetCorrelationRegistryForTests();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
});
afterEach(async () => {
  resetCorrelationRegistryForTests();
  vi.useRealTimers();
  await flushDurable();
  await removeTempDir(dir);
});

function evidence(requestId: string, conversationId = 'ordinary-chat'): void {
  observeRequestCorrelation({ requestId, conversationId, sessionId: 'session-test-123', messageId: 'message-test', tool: 'read', observedAt: Date.now() });
}

function invocation(name = 'read', requestId: string | null = 'request-test') {
  type Handler = (args: { paths?: string[]; workdir?: string }, context?: { sessionId?: string }) => Promise<ReturnType<typeof ok>>;
  let registered: Handler | undefined;
  const server = { registerTool(_name: string, _config: unknown, handler: Handler) { registered = handler; } } as unknown as McpServer;
  const config = getConfig();
  const registrar = createRegistrar(server, { roots: config.roots, caps: config.capabilities, readOnly: config.readOnly }, 'core');
  const run = vi.fn(async () => ok(currentCall()?.caller.conversationId ?? 'unattributed'));
  registrar.register(name, { description: 'Synthetic admission probe', inputSchema: z.object({ paths: z.array(z.string()).optional(), workdir: z.string().optional() }) }, run);
  if (!registered) throw new Error('Tool not registered');
  const handler = registered;
  const result = withInboundRequestId(requestId, () => handler(name === 'read' ? { paths: ['/project/README.md'] } : { workdir: '/project' }));
  let settled = false;
  void result.then(() => { settled = true; });
  return { run, result, settled: () => settled };
}

function text(result: Awaited<ReturnType<typeof invocation>['result']>): string {
  return result.content.filter((entry) => entry.type === 'text').map((entry) => entry.text).join('\n');
}

describe('exact caller admission', () => {
  it.each(['read', 'exec_command'])('holds %s until its exact evidence arrives after the old 15s window', async (name) => {
    const call = invocation(name);
    await vi.advanceTimersByTimeAsync(15_001);
    expect(call.run).not.toHaveBeenCalled();
    expect(call.settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(19_999);
    evidence('unrelated-request', 'other-chat');
    await vi.advanceTimersByTimeAsync(0);
    expect(call.run).not.toHaveBeenCalled();
    evidence('request-test');
    await vi.advanceTimersByTimeAsync(0);
    expect(text(await call.result)).toBe('ordinary-chat');
    expect(call.run).toHaveBeenCalledTimes(1);
  });

  it('does not add latency when the exact owner is already known', async () => {
    evidence('request-test');
    const call = invocation();
    expect(text(await call.result)).toBe('ordinary-chat');
    expect(call.run).toHaveBeenCalledTimes(1);
  });

  it('has one 60s budget even when all three identity requirements apply', async () => {
    topology.retired = true;
    topology.active = true;
    const call = invocation('exec_command');
    await vi.advanceTimersByTimeAsync(59_999);
    expect(call.settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(text(await call.result)).toContain('CALLER_IDENTITY_REQUIRED');
    expect(call.run).not.toHaveBeenCalled();
    evidence('request-test');
    await vi.advanceTimersByTimeAsync(5_000);
    // Later attribution must not execute a call whose rejection was already returned.
    expect(call.run).not.toHaveBeenCalled();
  });

  it('refuses absent incoming IDs without guessing or waiting', async () => {
    const call = invocation('read', null);
    expect(text(await call.result)).toContain('CALLER_IDENTITY_REQUIRED');
    expect(call.run).not.toHaveBeenCalled();
  });

  it('refuses conflicting exact evidence immediately', async () => {
    evidence('request-test');
    evidence('request-test', 'foreign-chat');
    const call = invocation();
    expect(text(await call.result)).toContain('CALLER_IDENTITY_REQUIRED');
    expect(call.run).not.toHaveBeenCalled();
  });

  it.each(['worker-chat', 'retired-chat'])('still rejects a late-proven %s', async (owner) => {
    const call = invocation();
    await vi.advanceTimersByTimeAsync(1_000);
    evidence('request-test', owner);
    await vi.advanceTimersByTimeAsync(0);
    expect(text(await call.result)).toMatch(/WORKER_DORMANT|WORKER_RETIRED/);
    expect(call.run).not.toHaveBeenCalled();
  });

  it.each(['readOnly', 'roots', 'capabilities', 'multiAgent'] as const)('requires a fresh call if %s changes during admission', async (field) => {
    const call = invocation();
    const current = getConfig();
    const next = field === 'readOnly' ? { ...current, readOnly: !current.readOnly }
      : field === 'roots' ? { ...current, roots: [{ name: 'changed', path: dir }] }
      : field === 'capabilities' ? { ...current, capabilities: { ...current.capabilities, read: !current.capabilities.read } }
      : { ...current, multiAgent: { ...current.multiAgent, enabled: !current.multiAgent.enabled } };
    await saveConfig(next);
    evidence('request-test');
    await vi.advanceTimersByTimeAsync(0);
    expect(text(await call.result)).toContain('AUTHORITY_CHANGED');
    expect(call.run).not.toHaveBeenCalled();
  });

  it('leaves ordinary absolute reads non-blocking when no identity fence exists', async () => {
    topology.dormant = false;
    const call = invocation('read', null);
    expect(text(await call.result)).toBe('unattributed');
    expect(call.run).toHaveBeenCalledTimes(1);
  });
});

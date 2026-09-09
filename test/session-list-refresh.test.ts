import { promises as fs } from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appendEvent,
  createSession,
  endSession,
  initSessionStore,
  listSessionPage,
  reopenSession,
  resetSessionStoreForTests
} from '../src/main/session/store.js';
import type { SessionEvent, SessionSummary } from '../src/shared/session.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let dir = '';
let dom: JSDOM | null = null;

beforeEach(async () => {
  dir = await makeTempDir('clf-session-list-');
  initSessionStore(dir);
});

afterEach(async () => {
  dom?.window.close();
  dom = null;
  resetSessionStoreForTests();
  vi.restoreAllMocks();
  vi.resetModules();
  await removeTempDir(dir);
});

describe('session summary pages', () => {
  it('reads retained metadata once, then serves hot list refreshes from the summary index', async () => {
    for (let index = 0; index < 8; index++) {
      const session = await createSession({ title: `cached-${index}`, conversationId: null });
      await endSession(session.id);
    }
    // A restart requires one discovery pass, not one meta.json read per later hot refresh.
    resetSessionStoreForTests();
    const readFile = vi.spyOn(fs, 'readFile');
    const first = await listSessionPage({ limit: 4 });
    const firstMetaReads = readFile.mock.calls.filter(([target]) => String(target).endsWith(`${path.sep}meta.json`)).length;
    expect(first.sessions).toHaveLength(4);
    expect(firstMetaReads).toBeGreaterThanOrEqual(8);
    const second = await listSessionPage({ limit: 4 });
    const secondMetaReads = readFile.mock.calls.filter(([target]) => String(target).endsWith(`${path.sep}meta.json`)).length;
    expect(second.sessions.map((entry) => entry.id)).toEqual(first.sessions.map((entry) => entry.id));
    expect(secondMetaReads).toBe(firstMetaReads);

    // Live mutations and their final closed row must remain current without dropping the index.
    const oldest = first.sessions.at(-1)!;
    await reopenSession(oldest.id);
    await appendEvent(oldest.id, {
      time: Date.now() + 10_000,
      source: 'app',
      kind: 'note',
      message: { text: 'hot update', truncated: false, chars: 10 }
    });
    const readsBeforeHotList = readFile.mock.calls.filter(([target]) => String(target).endsWith(`${path.sep}meta.json`)).length;
    const hot = await listSessionPage({ limit: 4 });
    expect(hot.sessions[0]).toMatchObject({ id: oldest.id, events: oldest.events + 1 });
    expect(readFile.mock.calls.filter(([target]) => String(target).endsWith(`${path.sep}meta.json`)).length).toBe(readsBeforeHotList);
    await endSession(oldest.id);
    const readsBeforeClosedList = readFile.mock.calls.filter(([target]) => String(target).endsWith(`${path.sep}meta.json`)).length;
    const closed = await listSessionPage({ limit: 4 });
    expect(closed.sessions[0]).toMatchObject({ id: oldest.id, events: oldest.events + 1 });
    expect(closed.sessions[0]!.endedAt).not.toBeNull();
    expect(readFile.mock.calls.filter(([target]) => String(target).endsWith(`${path.sep}meta.json`)).length).toBe(readsBeforeClosedList);
  });

  it('pages past the first 60 while reporting the full retained total', async () => {
    for (let index = 0; index < 65; index++) {
      const session = await createSession({ title: `history-${index}`, conversationId: null });
      await endSession(session.id);
    }
    resetSessionStoreForTests();
    const first = await listSessionPage({ limit: 60 });
    expect(first.sessions).toHaveLength(60);
    expect(first.total).toBe(65);
    expect(first.nextCursor).not.toBeNull();
    const second = await listSessionPage({ limit: 60, cursor: first.nextCursor ?? undefined });
    expect(second.sessions).toHaveLength(5);
    expect(second.total).toBe(65);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.sessions, ...second.sessions].map((entry) => entry.id)).size).toBe(65);
  });
});

function summary(id: string, updatedAt: number, events: number): SessionSummary {
  return {
    id, title: id, conversationId: `conversation-${id}`, chatIds: [`conversation-${id}`],
    startedAt: updatedAt - 1_000, updatedAt, endedAt: null, events, userMessages: 0,
    toolCalls: 0, errors: 0, estimatedTokens: 0, contextTokens: 0,
    autoCompactTriggeredAt: null, lastHandoffId: null, lastHandoffAt: null,
    lastTurnOutcome: null, activeTurnId: null, agents: [], origin: null
  };
}
const note = (seq: number, text: string): SessionEvent => ({
  seq, time: 10_000 + seq, source: 'app', kind: 'note',
  message: { text, truncated: false, chars: text.length }
});
async function createDom(): Promise<JSDOM['window']> {
  const html = await fs.readFile(path.join(process.cwd(), 'src/renderer/index.html'), 'utf8');
  dom = new JSDOM(html, { url: 'https://local.test/', pretendToBeVisual: true });
  const w = dom.window;
  Object.assign(globalThis, {
    window: w, document: w.document, HTMLElement: w.HTMLElement, Element: w.Element,
    Node: w.Node, DocumentFragment: w.DocumentFragment, HTMLInputElement: w.HTMLInputElement,
    HTMLSelectElement: w.HTMLSelectElement, HTMLTextAreaElement: w.HTMLTextAreaElement,
    HTMLButtonElement: w.HTMLButtonElement
  });
  if (!(w.HTMLElement.prototype as any).scrollIntoView) (w.HTMLElement.prototype as any).scrollIntoView = () => {};
  return w;
}
const ok = (data: any) => Promise.resolve({ ok: true as const, data });
function installApi(w: JSDOM['window'], methods: Record<string, unknown>): void {
  const api = new Proxy(methods, { get(target, prop) {
    if (prop in target) return (target as any)[prop];
    return (..._args: any[]) => ok(null);
  } });
  Object.defineProperty(w, 'api', { value: api, configurable: true });
}
const swarm = () => ok({ running: false, runId: null, agents: [], maxWorkers: 2, pendingReports: 0 });

describe('visible Chat refresh', () => {
  it('uses the detail cursor and preserves existing DOM after the initial bounded tail', async () => {
    const w = await createDom();
    const selected = summary('2026-08-25-aaaaaaaa', 20_000, 2);
    let changed: () => void = () => undefined;
    const detailCalls: Array<{ id: string; options: any }> = [];
    let detailRound = 0;
    installApi(w, {
      listSessions: () => ok({ sessions: [selected], activeId: selected.id, pressure: [], total: 1, nextCursor: null }),
      getSession: (id: string, options?: any) => {
        detailCalls.push({ id, options });
        detailRound++;
        return detailRound === 1
          ? ok({ summary: selected, events: [note(100, 'initial')], total: 1, nextFrom: 101 })
          : ok({ summary: { ...selected, events: 2 }, events: [note(101, 'delta')], total: 2, nextFrom: 102 });
      },
      getSwarm: swarm,
      onSessionChanged: (listener: () => void) => { changed = listener; return () => undefined; },
      onSwarmChanged: () => () => undefined
    });
    const { chatVisible, initChat } = await import('../src/renderer/chat.js');
    const dispose = initChat({ save: async () => undefined, state: () => ({ config: { sessions: { record: true } } }) as any });
    chatVisible(true);
    await vi.waitFor(() => expect(detailCalls).toHaveLength(1));
    await vi.waitFor(() => expect(w.document.querySelector('#timeline .ev')).not.toBeNull());
    expect(detailCalls[0]).toEqual({ id: selected.id, options: { limit: 160 } });
    const original = w.document.querySelector('#timeline .ev');
    const originalSession = w.document.querySelector('#sessionList .sess');
    changed();
    await new Promise((resolve) => setTimeout(resolve, 450));
    await vi.waitFor(() => expect(detailCalls).toHaveLength(2));
    expect(detailCalls[1]).toEqual({ id: selected.id, options: { from: 101, limit: 160 } });
    expect(w.document.getElementById('timeline')?.textContent).toContain('initial');
    expect(w.document.getElementById('timeline')?.textContent).toContain('delta');
    expect(w.document.querySelector('#timeline .ev')).toBe(original);
    expect(w.document.querySelector('#sessionList .sess')).toBe(originalSession);
    dispose();
  });

  it('loads an explicit older page while bounding DOM and preserving the selected recording', async () => {
    const w = await createDom();
    const all = Array.from({ length: 65 }, (_, index) => summary(`2026-08-25-${index.toString(16).padStart(8, '0')}`, 100_000 - index, 0));
    const cursor = { updatedAt: all[59]!.updatedAt, id: all[59]!.id };
    const listCalls: any[] = [];
    installApi(w, {
      listSessions: (options: any) => {
        listCalls.push(options);
        return options.cursor
          ? ok({ sessions: all.slice(60), activeId: all[0]!.id, pressure: [], total: 65, nextCursor: null })
          : ok({ sessions: all.slice(0, 60), activeId: all[0]!.id, pressure: [], total: 65, nextCursor: cursor });
      },
      getSession: (id: string) => ok({ summary: all.find((entry) => entry.id === id), events: [], total: 0, nextFrom: 0 }),
      getSwarm: swarm, onSessionChanged: () => () => undefined, onSwarmChanged: () => () => undefined
    });
    const { chatVisible, initChat } = await import('../src/renderer/chat.js');
    const dispose = initChat({ save: async () => undefined, state: () => ({ config: { sessions: { record: true } } }) as any });
    chatVisible(true);
    await vi.waitFor(() => expect(w.document.querySelectorAll('#sessionList .sess')).toHaveLength(60));
    expect(w.document.getElementById('sessionsFoot')?.textContent).toContain('60 shown on this page · 65 retained sessions');
    (w.document.getElementById('sessionsOlder') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(listCalls).toHaveLength(2));
    expect(listCalls[1]).toEqual({ cursor, limit: 60 });
    await vi.waitFor(() => expect(w.document.querySelectorAll('#sessionList .sess')).toHaveLength(5));
    expect(w.document.getElementById('sessionsFoot')?.textContent).toContain('5 shown on this page · 65 retained sessions');
    expect(w.document.getElementById('chatTitle')?.textContent).toBe(all[0]!.title);
    expect((w.document.getElementById('sessionsOlder') as HTMLButtonElement).disabled).toBe(true);
    (w.document.getElementById('sessionsNewest') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(w.document.querySelectorAll('#sessionList .sess')).toHaveLength(60));
    dispose();
  });
});

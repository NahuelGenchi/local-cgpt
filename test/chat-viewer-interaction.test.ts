import { readFileSync } from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionEvent, SessionSummary } from '../src/shared/session.js';

const html = readFileSync(path.join(process.cwd(), 'src/renderer/index.html'), 'utf8');
let dom: JSDOM;
let dispose: (() => void) | undefined;
let notify: () => void;
let summaries: SessionSummary[];
let records: Map<string, SessionEvent[]>;
let intercepted: ((id: string, options: { from?: number; limit?: number }) => Promise<unknown> | null) | null;
let getSession: ReturnType<typeof vi.fn>;
let clipboard: ReturnType<typeof vi.fn>;
let writes: ReturnType<typeof vi.fn>;

const ids = ['2026-09-08-aaaaaaaa', '2026-09-08-bbbbbbbb', '2026-09-08-cccccccc'];
function summary(id: string, index: number): SessionSummary {
  return { id, title: `Chat ${index + 1}`, conversationId: `conversation-${id}`, chatIds: [`conversation-${id}`],
    startedAt: 100, updatedAt: 1000 - index, endedAt: null, events: 400, userMessages: 0,
    toolCalls: 0, errors: 0, estimatedTokens: 100, contextTokens: 100,
    autoCompactTriggeredAt: null, lastHandoffId: null, lastHandoffAt: null,
    lastTurnOutcome: null, activeTurnId: null, agents: ['prime', 'worker-1'], origin: null };
}
const note = (seq: number): SessionEvent => ({ seq, time: seq, source: 'app', kind: 'note', agent: seq % 2 ? 'prime' : 'worker-1', message: { text: `entry ${seq}`, chars: 10, truncated: false } });
const ok = (data: unknown) => ({ ok: true as const, data });
const control = (id: string): HTMLButtonElement => dom.window.document.getElementById(id) as HTMLButtonElement;
const sessionControl = (id: string): HTMLButtonElement => dom.window.document.querySelector<HTMLButtonElement>(`button[data-select="${id}"]`)!;

beforeEach(async () => {
  vi.resetModules();
  dom = new JSDOM(html, { url: 'https://local.test/', pretendToBeVisual: true });
  const w = dom.window;
  Object.assign(globalThis, { window: w, document: w.document, HTMLElement: w.HTMLElement,
    Element: w.Element, Node: w.Node, DocumentFragment: w.DocumentFragment,
    HTMLInputElement: w.HTMLInputElement, HTMLSelectElement: w.HTMLSelectElement,
    HTMLTextAreaElement: w.HTMLTextAreaElement, HTMLButtonElement: w.HTMLButtonElement });
  Object.defineProperty(w.Element.prototype, 'scrollIntoView', { configurable: true, writable: true, value: vi.fn() });
  summaries = ids.map(summary);
  records = new Map(ids.map((id) => [id, Array.from({ length: 400 }, (_, index) => note(index + 1))]));
  intercepted = null;
  clipboard = vi.fn(async () => ok(true));
  writes = vi.fn(async () => ok(null));
  getSession = vi.fn(async (id: string, options: { from?: number; limit?: number } = {}) => {
    const interception = intercepted?.(id, options);
    if (interception) return interception;
    const all = records.get(id) ?? [];
    const events = options.from === undefined ? all.slice(-(options.limit ?? 160)) : all.filter((event) => event.seq >= options.from!).slice(0, options.limit ?? 160);
    return ok({ summary: summaries.find((entry) => entry.id === id) ?? null, events, total: all.length, nextFrom: events.reduce((next, event) => Math.max(next, event.seq + 1), options.from ?? 0) });
  });
  const methods = {
    getSession,
    listSessions: async () => ok({ sessions: summaries, activeId: summaries[0]?.id ?? null, pressure: [], total: summaries.length, nextCursor: null }),
    getSwarm: async () => ok({ running: false, runId: null, agents: [], maxWorkers: 2, pendingReports: 0 }),
    onSessionChanged: (listener: () => void) => { notify = listener; return () => undefined; },
    onSwarmChanged: () => () => undefined,
    deleteSession: async (id: string) => { summaries = summaries.filter((entry) => entry.id !== id); records.delete(id); return ok(true); },
    writeClipboard: clipboard,
    saveSettings: writes
  };
  Object.defineProperty(w, 'api', { value: new Proxy(methods, { get(target, key) { return key in target ? (target as any)[key] : async () => ok(null); } }), configurable: true });
  const { initChat, chatVisible } = await import('../src/renderer/chat.js');
  dispose = initChat({ save: async () => undefined, state: () => ({ config: { sessions: { record: true } } }) as any });
  chatVisible(true);
  await vi.waitFor(() => expect(w.document.querySelectorAll('#timeline .ev')).toHaveLength(160));
});
afterEach(() => { dispose?.(); dom.window.close(); vi.restoreAllMocks(); });

describe('recorded viewer interaction', () => {
  it('has unique nonempty runtime ids and native keyboard-operable session/filter controls', () => {
    const allIds = Array.from(document.querySelectorAll('[id]')).map((node) => node.id);
    expect(allIds.every(Boolean)).toBe(true);
    expect(new Set(allIds).size).toBe(allIds.length);
    const first = sessionControl(ids[0]!);
    first.focus();
    first.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement).toBe(sessionControl(ids[1]!));
    sessionControl(ids[1]!).click();
    expect(sessionControl(ids[1]!).getAttribute('aria-pressed')).toBe('true');
    expect(writes).not.toHaveBeenCalled();
  });

  it('builds tool arguments/results only on expansion and releases them on collapse', async () => {
    const text = { text: 'const payload = 42;\n', chars: 20, truncated: false };
    const tool = { seq: 401, time: 401, source: 'mcp', kind: 'tool_call', call: {
      callId: 'call-401', tool: 'exec_command', outcome: 'success', durationMs: 2, attribution: 'request',
      summary: { kind: 'run', title: 'Run test command', tone: 'neutral' }, args: text, result: text, assets: []
    } } as unknown as SessionEvent;
    records.get(ids[0]!)!.push(tool);
    notify();
    await vi.waitFor(() => expect(document.querySelector('#timeline details.tool')).not.toBeNull(), { timeout: 1500 });
    const details = document.querySelector<HTMLDetailsElement>('#timeline details.tool')!;
    expect(details.querySelector('.raw')).toBeNull();
    details.open = true;
    details.dispatchEvent(new dom.window.Event('toggle'));
    expect(details.querySelector('.raw')?.textContent).toContain('const payload = 42;');
    expect(details.querySelectorAll('.code-controls')).toHaveLength(2);
    const summaryNode = details.querySelector('summary');
    notify();
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(document.querySelector('#timeline details.tool')).toBe(details);
    expect(details.querySelector('summary')).toBe(summaryNode);
    details.open = false;
    details.dispatchEvent(new dom.window.Event('toggle'));
    expect(details.querySelector('.raw')).toBeNull();
  });

  it('keeps bounded earlier history stable during live notifications until Latest resumes', async () => {
    control('historyEarlier').click();
    await vi.waitFor(() => expect(document.getElementById('timeline')!.textContent).toContain('entry 97'));
    expect(document.getElementById('timeline')!.textContent).not.toContain('entry 400');
    expect(document.querySelectorAll('#timeline .ev').length).toBeLessThanOrEqual(160);
    records.get(ids[0]!)!.push(note(401));
    notify();
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(document.getElementById('timeline')!.textContent).not.toContain('entry 401');
    control('historyLatest').click();
    await vi.waitFor(() => expect(document.getElementById('timeline')!.textContent).toContain('entry 401'));
    expect(document.querySelectorAll('#timeline .ev')).toHaveLength(160);
  });

  it('cancels an older-history request on session change without leaving navigation disabled', async () => {
    let finish: (reply: unknown) => void = () => undefined;
    intercepted = (id, options) => id === ids[0] && options.from !== undefined ? new Promise((resolve) => { finish = resolve; }) : null;
    control('historyEarlier').click();
    expect(control('historyLatest').disabled).toBe(true);
    sessionControl(ids[1]!).click();
    await vi.waitFor(() => expect(document.getElementById('chatTitle')!.textContent).toBe('Chat 2'));
    expect(control('historyLatest').disabled).toBe(false);
    finish(ok({ summary: summaries[0], events: [note(1)], total: 400, nextFrom: 2 }));
    await Promise.resolve(); await Promise.resolve();
    expect(document.getElementById('chatTitle')!.textContent).toBe('Chat 2');
    expect(document.getElementById('timeline')!.textContent).not.toContain('entry 1entry');
  });

  it('searches outside the rendered tail and jumps using stable recording identity', async () => {
    const query = document.getElementById('historySearch') as HTMLInputElement;
    query.value = 'entry 12';
    query.dispatchEvent(new dom.window.Event('input'));
    control('historyFind').click();
    await vi.waitFor(() => expect(document.querySelectorAll('#historySearchResults button').length).toBeGreaterThan(0));
    const result = document.querySelector<HTMLButtonElement>('#historySearchResults button')!;
    expect(result.textContent).toContain('Event 12:');
    result.click();
    await vi.waitFor(() => expect(document.querySelector('#timeline [data-seq="12"]')).not.toBeNull());
    expect(document.querySelectorAll('#timeline .ev').length).toBeLessThanOrEqual(160);
    expect(writes).not.toHaveBeenCalled();
  });

  it('resets cancelled search controls when selecting another recording', async () => {
    let finish: (reply: unknown) => void = () => undefined;
    intercepted = (id, options) => id === ids[0] && options.from === 0 ? new Promise((resolve) => { finish = resolve; }) : null;
    const query = document.getElementById('historySearch') as HTMLInputElement;
    query.value = 'entry'; query.dispatchEvent(new dom.window.Event('input'));
    control('historyFind').click();
    expect(control('historyFind').disabled).toBe(true);
    sessionControl(ids[1]!).click();
    expect(control('historyFind').disabled).toBe(false);
    finish(ok({ summary: summaries[0], events: [note(1)], total: 400, nextFrom: 2 }));
    await Promise.resolve(); await Promise.resolve();
    expect(document.querySelectorAll('#historySearchResults button')).toHaveLength(0);
  });

  it('adjusts reading and raw/wrap preferences without changing application permissions', () => {
    const size = document.getElementById('chatFontSize') as HTMLSelectElement;
    size.value = '20'; size.dispatchEvent(new dom.window.Event('change'));
    expect(document.getElementById('chatBody')!.style.getPropertyValue('--chat-font-size')).toBe('20px');
    control('chatRaw').click(); control('chatWrap').click();
    expect(control('chatRaw').getAttribute('aria-pressed')).toBe('true');
    expect(control('chatWrap').getAttribute('aria-pressed')).toBe('true');
    expect(writes).not.toHaveBeenCalled();
    expect(dom.window.localStorage.getItem('local-cgpt.viewer.v1')).not.toContain('entry 400');
    control('chatReadingReset').click();
    expect(document.getElementById('chatBody')!.style.getPropertyValue('--chat-font-size')).toBe('14px');
  });

  it('keeps focus on the selected surviving neighbor after deleting the middle session', async () => {
    sessionControl(ids[1]!).click();
    const remove = document.querySelector<HTMLButtonElement>(`#sessionList [data-id="${ids[1]}"] .sess-del`)!;
    remove.focus(); remove.click();
    await vi.waitFor(() => expect(document.querySelectorAll('#sessionList .sess')).toHaveLength(2));
    await vi.waitFor(() => expect(document.getElementById('chatTitle')!.textContent).toBe('Chat 3'));
    expect(document.activeElement).toBe(sessionControl(ids[2]!));
  });
});

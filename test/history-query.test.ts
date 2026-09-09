import { describe, expect, it, vi } from 'vitest';
import { boundHistory, earlierHistory, eventIdentity, searchHistory } from '../src/renderer/history-query.js';
import { defaultChatPreferences, loadChatPreferences, saveChatPreferences, sessionGroup } from '../src/renderer/chat-preferences.js';
import type { SessionEvent, SessionSummary } from '../src/shared/session.js';
import type { HistoryReader } from '../src/renderer/history-query.js';

const note = (seq: number, text = `row ${seq}`): SessionEvent => ({ seq, time: seq, source: 'app', kind: 'note', message: { text, chars: text.length, truncated: false } });
const reader = (events: SessionEvent[]): HistoryReader => async (from, limit) => {
  const page = events.filter((event) => event.seq >= from).slice(0, limit);
  return { summary: null, events: page, total: events.length, nextFrom: page.reduce((cursor, event) => Math.max(cursor, event.seq + 1), from) };
};

describe('bounded recording navigation', () => {
  it('loads earlier records without exceeding a 160-row page', async () => {
    const read = vi.fn(reader(Array.from({ length: 600 }, (_, index) => note(index + 1))));
    const result = await earlierHistory(441, read, () => true);
    expect(result?.events).toHaveLength(160);
    expect(result?.events[0]?.seq).toBe(281);
    expect(result?.events.at(-1)?.seq).toBe(440);
    expect(read).toHaveBeenCalledTimes(1);
    expect(boundHistory(Array.from({ length: 1000 }, (_, index) => note(index)), true)).toHaveLength(160);
  });
  it('finds earlier canonical messages across large revision-sequence gaps', async () => {
    const read = vi.fn(reader([note(1), note(50), note(4_000_000)]));
    const result = await earlierHistory(4_000_000, read, () => true);
    expect(result?.events.map((event) => event.seq)).toEqual([1, 50]);
    expect(read.mock.calls.length).toBeLessThanOrEqual(26);
    expect(read.mock.calls.every(([, limit]) => limit <= 160)).toBe(true);
  });
  it('does not continue I/O or publish results after navigation cancellation', async () => {
    let current = true;
    const read: HistoryReader = vi.fn(async () => { current = false; return { summary: null, events: [note(2)], total: 1, nextFrom: 3 }; });
    expect(await earlierHistory(20, read, () => current)).toBeNull();
    expect(read).toHaveBeenCalledTimes(1);
  });
  it('uses stable canonical message identity independently of its revision cursor', () => {
    const first = { ...note(10), kind: 'assistant_message', messageId: 'message-a', final: false } as SessionEvent;
    expect(eventIdentity(first)).toBe(eventIdentity({ ...first, seq: 900 }));
  });
  it('limits retained text as well as row count', () => {
    expect(boundHistory(Array.from({ length: 100 }, (_, index) => note(index, 'x'.repeat(100_000))), true)).toHaveLength(20);
  });
});

describe('explicit bounded search', () => {
  it('finds records outside the visible tail and continues without dropping matches', async () => {
    const read = vi.fn(reader(Array.from({ length: 1000 }, (_, index) => note(index + 1, `needle ${index + 1}`))));
    const first = await searchHistory('needle', 0, read, () => true);
    expect(first?.matches).toHaveLength(20);
    expect(first?.nextFrom).toBe(21);
    const second = await searchHistory('needle', first!.nextFrom, read, () => true);
    expect(second?.matches[0]?.seq).toBe(21);
    expect(second?.matches).toHaveLength(20);
    expect(new Set([...first!.matches, ...second!.matches].map((match) => match.seq)).size).toBe(40);
  });
  it('scans at most four pages per action and distinguishes continuation from end', async () => {
    const read = vi.fn(reader(Array.from({ length: 1000 }, (_, index) => note(index + 1))));
    const page = await searchHistory('absent', 0, read, () => true);
    expect(page?.scanned).toBe(640);
    expect(page?.done).toBe(false);
    expect(read).toHaveBeenCalledTimes(4);
    const tail = await searchHistory('absent', page!.nextFrom, read, () => true);
    expect(tail?.scanned).toBe(360);
    expect(tail?.done).toBe(true);
  });
  it('ignores a result from a superseded query', async () => {
    let current = true;
    const read: HistoryReader = async () => { current = false; return { summary: null, events: [note(1, 'needle')], total: 1, nextFrom: 2 }; };
    expect(await searchHistory('needle', 0, read, () => current)).toBeNull();
  });
});

describe('presentation-only preferences', () => {
  it('clamps malformed preferences and never persists arbitrary extra data', () => {
    const data = loadChatPreferences({ getItem: () => JSON.stringify({ fontSize: 1000, width: -100, pins: ['bad', '2026-09-08-aaaaaaaa'], projects: { '2026-09-08-aaaaaaaa': 'Demo' }, transcript: 'not a supported field' }) });
    expect(data.fontSize).toBe(24);
    expect(data.width).toBe(48);
    expect(data.pins).toEqual(['2026-09-08-aaaaaaaa']);
    const save = vi.fn();
    expect(saveChatPreferences(data, { setItem: save })).toBe(true);
    expect(save.mock.calls[0]![1]).not.toContain('transcript');
    expect(save.mock.calls[0]![1]).not.toContain('not a supported field');
  });
  it('handles storage failure without granting anything or breaking the view', () => {
    expect(loadChatPreferences({ getItem: () => { throw new Error('unavailable'); } })).toEqual(defaultChatPreferences());
    expect(saveChatPreferences(defaultChatPreferences(), { setItem: () => { throw new Error('full'); } })).toBe(false);
  });
  it('groups only by explicit lineage rather than matching worker labels or titles', () => {
    const root = { id: 'session-root', title: 'Same title', origin: null } as SessionSummary;
    const resumed = { id: 'session-next', title: 'Same title', origin: { kind: 'resume', fromSessionId: root.id } } as SessionSummary;
    const unrelated = { id: 'session-other', title: 'Same title', origin: { kind: 'worker', agentId: 'worker-1' } } as SessionSummary;
    const prefs = { ...defaultChatPreferences(), grouping: 'lineage' as const };
    expect(sessionGroup(root, [root, resumed], prefs)).toBe(sessionGroup(resumed, [root, resumed], prefs));
    expect(sessionGroup(unrelated, [root, resumed, unrelated], prefs)).not.toBe(sessionGroup(root, [root, resumed], prefs));
  });
});

import type { SessionEvent } from '../shared/session.js';
import type { SessionDetail } from '../preload/index.js';

export const HISTORY_PAGE_SIZE = 160;
export const HISTORY_TEXT_BUDGET = 2 * 1024 * 1024;
export const MAX_HISTORY_SEQUENCE = 10_000_000;
export type HistoryReader = (from: number, limit: number) => Promise<SessionDetail | null>;

export function eventIdentity(event: SessionEvent): string {
  if (event.kind === 'user_message' || event.kind === 'assistant_message') {
    if (event.messageId) return `${event.kind}:${event.messageId}`;
  }
  if (event.kind === 'progress' && event.progressId) return `progress:${event.progressId}`;
  if (event.kind === 'page_tool') return `page_tool:${event.messageId}`;
  if (event.kind === 'tool_call') return `tool:${event.call.callId}`;
  if (event.kind === 'agent_message') return `agent:${event.delivery}:${event.messageId}`;
  return `seq:${event.seq}`;
}

export function eventSearchText(event: SessionEvent): string {
  switch (event.kind) {
    case 'tool_call': return `${event.call.summary.title}\n${event.call.args.text}\n${event.call.result.text}`;
    case 'user_message': case 'assistant_message': case 'progress': case 'chat_error': case 'note': case 'agent_message':
      return event.message.text;
    case 'page_tool': return event.label;
    case 'session_start': return event.title;
    case 'turn_end': return `${event.outcome} ${event.detail ?? ''}`;
    case 'handoff': return event.reason;
    default: return event.kind;
  }
}

export function boundHistory(events: readonly SessionEvent[], newest: boolean): SessionEvent[] {
  const selected: SessionEvent[] = [];
  let cost = 0;
  const scan = newest ? Array.from(events).reverse() : events;
  for (const event of scan) {
    const text = eventSearchText(event);
    const size = text.length + (event.kind === 'assistant_message' ? event.renderedHtml?.text.length ?? 0 : 0);
    if (selected.length >= HISTORY_PAGE_SIZE || (selected.length > 0 && cost + size > HISTORY_TEXT_BUDGET)) break;
    selected.push(event);
    cost += Math.min(size, HISTORY_TEXT_BUDGET);
  }
  return newest ? selected.reverse() : selected;
}

/**
 * Existing IPC uses sequence cursors, not offsets. Read the adjacent sequence interval
 * first. Canonical streaming revisions can leave large gaps; only then use at most 24
 * one-row probes to locate the nearest earlier record. No growing transcript is retained
 * and every await is checked against the caller's session/navigation generation.
 * This deliberately reuses the existing read-only IPC surface, not a new file/path route.
 */
export async function earlierHistory(
  before: number,
  read: HistoryReader,
  current: () => boolean
): Promise<SessionDetail | null> {
  const ceiling = Math.min(MAX_HISTORY_SEQUENCE, Math.max(0, Math.floor(before)));
  if (ceiling <= 1 || !current()) return null;
  const from = Math.max(0, ceiling - HISTORY_PAGE_SIZE);
  const page = await read(from, HISTORY_PAGE_SIZE);
  if (!page || !current()) return null;
  const earlier = page.events.filter((event) => event.seq < ceiling);
  if (earlier.length || from === 0) return { ...page, events: earlier };

  let low = 0;
  let high = from - 1;
  let found = -1;
  for (let probes = 0; low <= high && probes < 24; probes++) {
    const middle = Math.floor((low + high) / 2);
    const probe = await read(middle, 1);
    if (!probe || !current()) return null;
    const first = probe.events[0];
    if (first && first.seq < ceiling) {
      found = first.seq;
      low = Math.max(middle + 1, first.seq + 1);
    } else high = middle - 1;
  }
  if (found < 0) return { ...page, events: [] };
  const previous = await read(Math.max(0, found - HISTORY_PAGE_SIZE + 1), HISTORY_PAGE_SIZE);
  if (!previous || !current()) return null;
  return { ...previous, events: previous.events.filter((event) => event.seq <= found) };
}

export interface HistoryMatch { seq: number; key: string; preview: string; }
export interface SearchPage { matches: HistoryMatch[]; nextFrom: number; done: boolean; scanned: number; }

/** Four bounded pages per explicit search action; continue rather than scan invisibly forever. */
export async function searchHistory(
  query: string,
  from: number,
  read: HistoryReader,
  current: () => boolean
): Promise<SearchPage | null> {
  const needle = query.trim().slice(0, 256).toLocaleLowerCase();
  if (!needle || !current()) return { matches: [], nextFrom: from, done: true, scanned: 0 };
  const result: SearchPage = { matches: [], nextFrom: from, done: false, scanned: 0 };
  for (let pageNumber = 0; pageNumber < 4; pageNumber++) {
    const page = await read(result.nextFrom, HISTORY_PAGE_SIZE);
    if (!page || !current()) return null;
    const ordered = [...page.events].sort((a, b) => a.seq - b.seq);
    if (!ordered.length) { result.done = true; break; }
    for (const event of ordered) {
      if (event.seq < result.nextFrom) continue;
      result.nextFrom = event.seq + 1;
      result.scanned++;
      const text = eventSearchText(event);
      const at = text.toLocaleLowerCase().indexOf(needle);
      if (at >= 0) {
        result.matches.push({ seq: event.seq, key: eventIdentity(event), preview: text.slice(Math.max(0, at - 50), at + 150) });
        if (result.matches.length === 20) return result;
      }
    }
    if (result.nextFrom >= MAX_HISTORY_SEQUENCE) { result.done = true; break; }
    // Short pages can result from bounded storage reads; only an empty next page proves end.
  }
  return result;
}

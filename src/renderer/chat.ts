/**
 * Recorded-session viewer, not a replacement ChatGPT client. The main process owns
 * recordings and authority; this module owns only bounded presentation windows.
 * Sequence cursors name delivery revisions. Stable message/call ids name DOM rows.
 * Never substitute title, timestamp, DOM position or a worker label for identity.
 */
import type { SessionDetail, SessionListCursor } from '../preload/index.js';
import type { AppState, Config } from '../shared/types.js';
import type { ActivitySummary, AgentState, Handoff, SessionEvent, SessionSummary, StoredText, SwarmState, TokenPressure } from '../shared/session.js';
import { ATTRIBUTION_LABELS, TURN_OUTCOME_LABELS, foldProgress } from '../shared/session.js';
import { chronological } from '../shared/chronology.js';
import { $, ago, clockTime, compactNumber, el, icon, run, toast } from './dom.js';
import { reconcileRows, preserveViewport, type KeyedRow } from './keyed-view.js';
import { renderedMessage, addCodeControls, MAX_RENDERED_HTML_CHARS } from './chat-format.js';
import { boundHistory, earlierHistory, eventIdentity, searchHistory, HISTORY_PAGE_SIZE, type HistoryMatch } from './history-query.js';
import { defaultChatPreferences, loadChatPreferences, saveChatPreferences, sessionGroup, type ChatPreferences } from './chat-preferences.js';
import { applyChatSettings, initChatSettings, paintSwarmSettings } from './chat-settings.js';
import './chat-view.css';

export { renderedMessage } from './chat-format.js';
export { chatSettingsPatch } from './chat-settings.js';

const api = window.api;
const MAX_TIMELINE_ROWS = HISTORY_PAGE_SIZE;
const SESSION_PAGE_SIZE = 60;
const PIN_PAGE_SIZE = 12;
const UNATTRIBUTED = '\u0000unattributed';
const KIND_ICON: Record<ActivitySummary['kind'], string> = {
  edit: 'i-pencil', create: 'i-plus', delete: 'i-trash', move: 'i-out', read: 'i-eye',
  search: 'i-search', browse: 'i-folder', run: 'i-terminal', process: 'i-terminal',
  screen: 'i-monitor', input: 'i-monitor', clipboard: 'i-copy', session: 'i-steps', agent: 'i-bolt', other: 'i-bolt'
};
const AGENT_BADGE: Record<AgentState, string> = {
  invited: 'opening', active: 'joined', detached: 'no tab', sleeping: 'sleeping',
  waking: 'waking', finished: 'finished', failed: 'failed'
};
interface Deps { save: () => Promise<void>; state: () => AppState | null; }
let deps: Deps;
let visible = false;
let sessions: SessionSummary[] = [];
let sessionTotal = 0;
let pageCursor: SessionListCursor | undefined;
let nextPageCursor: SessionListCursor | null = null;
let pinnedPage = 0;
let onlyPinned = false;
let listFilter = '';
let activeId: string | null = null;
let selectedId: string | null = null;
let selectedSummary: SessionSummary | null = null;
let pressure = new Map<string, TokenPressure>();
let events: SessionEvent[] = [];
let totalEvents = 0;
let detailCursor: number | null = null;
let detailFor: string | null = null;
let historical = false;
let followLatest = true;
let agentFilter: string | null = null;
let swarm: SwarmState | null = null;
let handoff: Handoff | null = null;
let handoffFor: string | null = null;
let preferences = defaultChatPreferences();
let listGeneration = 0;
let detailGeneration = 0;
let handoffGeneration = 0;
let searchGeneration = 0;
let reloadTimer: number | undefined;
let listLoading = false;
let historyLoading = false;
let searchFrom = 0;
let searchScanned = 0;
let searchDone = true;
let searchMatches: HistoryMatch[] = [];
let lastContentView = 'timeline';
const openTools = new Set<string>();

function button(id: string, label: string, action: () => void): HTMLButtonElement {
  const node = document.createElement('button');
  if (id) node.id = id;
  node.type = 'button';
  node.className = 'btn';
  node.textContent = label;
  node.addEventListener('click', action);
  return node;
}
function boundedText(value: StoredText, className = 'msg', pre = false): HTMLElement {
  const node = el(pre ? 'pre' : 'p', className, value.text.slice(0, MAX_RENDERED_HTML_CHARS));
  if (value.truncated || value.text.length > MAX_RENDERED_HTML_CHARS) {
    node.append(el('span', 'cut', ` … retained excerpt; ${compactNumber(value.chars)} characters in the original`));
  }
  return node;
}
function changedPreferences(): void {
  if (!saveChatPreferences(preferences)) toast('Viewer preferences could not be saved; using them for this window only.');
  applyReading();
  if (visible) { paintSessions(); paintDetail(); }
}
function applyReading(): void {
  const pane = $('chatBody');
  pane.style.setProperty('--chat-font-size', `${preferences.fontSize}px`);
  pane.style.setProperty('--chat-reading-width', `${preferences.width}ch`);
  const font = $<HTMLSelectElement>('chatFontSize');
  const width = $<HTMLSelectElement>('chatReadingWidth');
  if (font) font.value = String(preferences.fontSize);
  if (width) width.value = String(preferences.width);
  $('chatRaw')?.setAttribute('aria-pressed', String(preferences.raw));
  $('chatWrap')?.setAttribute('aria-pressed', String(preferences.wrap));
}
/** A cancelled async operation no longer owns disabled controls in the new view. */
function releaseSearchControls(): void {
  const find = $<HTMLButtonElement>('historyFind');
  const more = $<HTMLButtonElement>('historyFindMore');
  if (find) find.disabled = false;
  if (more) more.disabled = searchDone;
}

function badges(summary: SessionSummary): string[] {
  if (summary.conversationId === null) return ['not a chat'];
  const result: string[] = [];
  if (summary.origin?.kind === 'worker') result.push(summary.origin.agentId ?? 'worker');
  else if (summary.origin?.kind === 'resume' || summary.chatIds.length > 1) result.push('resumed');
  else if (summary.agents.includes('prime')) result.push('prime');
  // Worker ids repeat between runs. Only the exact conversation may borrow a live badge.
  const agent = summary.origin?.agentId ? swarm?.agents.find((entry) =>
    entry.id === summary.origin!.agentId && Boolean(entry.conversationId) && entry.conversationId === summary.conversationId
  ) : undefined;
  if (agent) result.push(AGENT_BADGE[agent.state]);
  return result;
}
function sessionRow(summary: SessionSummary): HTMLElement {
  const row = el('div', 'sess');
  row.dataset.id = summary.id;
  const select = document.createElement('button');
  select.type = 'button';
  select.className = 'sess-select';
  select.dataset.select = summary.id;
  select.dataset.focusKey = 'select-session';
  const top = el('span', 'sess-top');
  const title = el('b', '', summary.title || 'Untitled session');
  title.title = summary.title;
  top.append(title, el('em', '', ago(summary.updatedAt)));
  const sub = el('span', 'sess-sub');
  for (const badge of badges(summary)) sub.append(el('span', 'chip', badge));
  sub.append(el('span', 'sess-bits', `${summary.userMessages} messages · ${summary.toolCalls} tools${summary.errors ? ` · ${summary.errors} errors` : ''}`));
  const level = pressure.get(summary.id);
  const bar = el('span', `bar${level ? ` is-${level.level}` : ''}`);
  const fill = el('i');
  fill.style.width = `${level && level.limit > 0 ? Math.min(100, 100 * level.estimated / level.limit) : 0}%`;
  bar.append(fill);
  bar.title = `~${compactNumber(summary.estimatedTokens)} rough context tokens from messages and tool I/O; transient progress is excluded`;
  select.append(top, sub, bar);
  select.setAttribute('aria-label', `Open recorded session: ${summary.title || 'Untitled session'}`);
  select.addEventListener('click', () => selectSession(summary));
  const pin = button('', preferences.pins.includes(summary.id) ? 'Unpin' : 'Pin', () => {
    if (preferences.pins.includes(summary.id)) preferences.pins = preferences.pins.filter((id) => id !== summary.id);
    else if (preferences.pins.length < 500) preferences.pins.push(summary.id);
    else { toast('The viewer supports up to 500 pins. Unpin a session first.'); return; }
    changedPreferences();
    if (onlyPinned) void loadSessions();
  });
  pin.dataset.focusKey = 'pin-session';
  pin.classList.add('sess-pin');
  pin.setAttribute('aria-label', `${preferences.pins.includes(summary.id) ? 'Unpin' : 'Pin'} ${summary.title || 'session'}`);
  pin.setAttribute('aria-pressed', String(preferences.pins.includes(summary.id)));
  const remove = button('', 'Delete', () => void removeSession(summary.id));
  remove.classList.add('sess-del');
  remove.dataset.focusKey = 'delete-session';
  remove.title = 'Delete this recorded session';
  remove.setAttribute('aria-label', `Delete recorded session: ${summary.title || 'Untitled session'}`);
  row.append(select, pin, remove);
  return row;
}
function paintSessions(): void {
  if (!visible) return;
  const list = $('sessionList');
  const pane = list.closest<HTMLElement>('.scroll')!;
  const filtered = sessions.filter((summary) => !listFilter || summary.title.toLocaleLowerCase().includes(listFilter));
  const ordered = [...filtered].sort((a, b) => {
    const pinned = Number(preferences.pins.includes(b.id)) - Number(preferences.pins.includes(a.id));
    if (pinned) return pinned;
    const group = sessionGroup(a, sessions, preferences).localeCompare(sessionGroup(b, sessions, preferences));
    return group || b.updatedAt - a.updatedAt || b.id.localeCompare(a.id);
  });
  const rows: KeyedRow[] = [];
  let previousGroup = '';
  for (const summary of ordered) {
    const group = `${preferences.pins.includes(summary.id) ? 'Pinned · ' : ''}${sessionGroup(summary, sessions, preferences)}`;
    if (group && group !== previousGroup) rows.push({ key: `group:${group}`, revision: group, create: () => el('h3', 'session-group', group) });
    previousGroup = group;
    rows.push({ key: summary.id, revision: JSON.stringify([summary, badges(summary), pressure.get(summary.id), preferences.pins.includes(summary.id)]), create: () => sessionRow(summary) });
  }
  preserveViewport(pane, list, false, () => reconcileRows(list, rows));
  for (const row of list.querySelectorAll<HTMLElement>('.sess')) {
    row.classList.toggle('is-sel', row.dataset.id === selectedId);
    row.classList.toggle('is-live', row.dataset.id === activeId);
    row.querySelector('button[data-select]')?.setAttribute('aria-pressed', String(row.dataset.id === selectedId));
  }
  $('sessionsEmpty').hidden = sessions.length > 0;
  const recording = deps.state()?.config.sessions.record === true;
  $('sessionsFoot').textContent = `${recording ? '' : 'Recording is off · '}${filtered.length} shown on this page · ${sessionTotal} retained sessions${listFilter ? ' · title filter applies to this page only' : ''}${onlyPinned ? ' · pins do not override retention' : ''}`;
  const more = $<HTMLButtonElement>('sessionsOlder');
  if (more) more.disabled = listLoading || (onlyPinned ? (pinnedPage + 1) * PIN_PAGE_SIZE >= preferences.pins.length : !nextPageCursor);
  $<HTMLButtonElement>('sessionsNewest')?.setAttribute('aria-pressed', String(!pageCursor && !onlyPinned));
  $<HTMLButtonElement>('sessionsPinned')?.setAttribute('aria-pressed', String(onlyPinned));
}
async function loadSessions(): Promise<void> {
  const generation = ++listGeneration;
  listLoading = true;
  const current = (): boolean => visible && generation === listGeneration;
  try {
    if (onlyPinned) {
      const found: SessionSummary[] = [];
      const ids = preferences.pins.slice(pinnedPage * PIN_PAGE_SIZE, (pinnedPage + 1) * PIN_PAGE_SIZE);
      for (const id of ids) {
        const reply = await api.getSession(id, { limit: 1 });
        if (!current()) return;
        if (reply.ok && reply.data.summary) found.push(reply.data.summary);
        // A failed read is not proof of deletion; never remove pins on a transient/keyring error.
      }
      sessions = found;
      nextPageCursor = null;
    } else {
      const list = await run(api.listSessions({ cursor: pageCursor, limit: SESSION_PAGE_SIZE }));
      if (!list || !current()) return;
      sessions = list.sessions.slice(0, SESSION_PAGE_SIZE);
      sessionTotal = list.total;
      nextPageCursor = list.nextCursor ?? null;
      activeId = list.activeId;
      pressure = new Map(list.pressure.map((entry) => [entry.id, entry]));
    }
    if (!current()) return;
    if (selectedId === null && sessions.length) selectSession(sessions.find((entry) => entry.id === activeId) ?? sessions[0]!);
    else {
      const selected = sessions.find((entry) => entry.id === selectedId);
      if (selected) selectedSummary = selected;
      paintSessions();
      if (!historical && followLatest) void loadDetail();
    }
  } finally {
    if (generation === listGeneration) { listLoading = false; paintSessions(); }
  }
}
function selectSession(summary: SessionSummary): void {
  if (selectedId === summary.id) return;
  selectedId = summary.id;
  selectedSummary = summary;
  detailFor = null;
  detailCursor = null;
  events = [];
  totalEvents = summary.events;
  historical = false;
  followLatest = true;
  historyLoading = false;
  agentFilter = null;
  openTools.clear();
  handoff = null;
  handoffFor = null;
  detailGeneration++;
  handoffGeneration++;
  searchGeneration++;
  searchMatches = [];
  searchFrom = 0;
  searchScanned = 0;
  searchDone = true;
  releaseSearchControls();
  const project = $<HTMLInputElement>('sessionProject');
  if (project) project.value = preferences.projects[summary.id] ?? '';
  const query = $<HTMLInputElement>('historySearch');
  if (query) query.value = '';
  paintSearch();
  paintSessions();
  paintDetail();
  paintHandoff();
  void loadDetail();
}
async function removeSession(id: string): Promise<void> {
  const index = sessions.findIndex((entry) => entry.id === id);
  const ownedFocus = $('sessionList').querySelector<HTMLElement>(`[data-id="${id}"]`)?.contains(document.activeElement) ?? false;
  if (await run(api.deleteSession(id)) === null) return;
  preferences.pins = preferences.pins.filter((entry) => entry !== id);
  delete preferences.projects[id];
  saveChatPreferences(preferences);
  sessions = sessions.filter((entry) => entry.id !== id);
  pressure.delete(id);
  sessionTotal = Math.max(0, sessionTotal - 1);
  if (selectedId === id) {
    selectedId = null;
    selectedSummary = null;
    detailFor = null;
    detailCursor = null;
    detailGeneration++;
    handoffGeneration++;
    searchGeneration++;
    historyLoading = false;
    searchDone = true;
    events = [];
    handoff = null;
    handoffFor = null;
    searchMatches = [];
    openTools.clear();
    releaseSearchControls();
    const neighbor = sessions[Math.min(index, sessions.length - 1)];
    if (neighbor) selectSession(neighbor);
    else { paintDetail(); paintHandoff(); paintSearch(); }
  }
  paintSessions();
  if (ownedFocus) {
    const controls = Array.from($('sessionList').querySelectorAll<HTMLButtonElement>('button[data-select]'));
    const target = controls.find((node) => node.dataset.select === selectedId) ?? controls[Math.min(index, controls.length - 1)] ?? $<HTMLButtonElement>('chatRefresh');
    target.focus({ preventScroll: true });
  }
  toast('Session deleted');
  await loadSessions();
}

function boundedPage(source: readonly SessionEvent[], newest: boolean): SessionEvent[] {
  // Bound in cursor order before presentation chronology can move a row across a page boundary.
  const ordered = [...source].sort((left, right) => left.seq - right.seq);
  return chronological(foldProgress(boundHistory(ordered, newest)));
}
async function loadDetail(): Promise<void> {
  const id = selectedId;
  if (!id || !visible || historical || !followLatest) return;
  const generation = ++detailGeneration;
  const incremental = detailFor === id && detailCursor !== null;
  const detail = await run(api.getSession(id, incremental ? { from: detailCursor!, limit: MAX_TIMELINE_ROWS } : { limit: MAX_TIMELINE_ROWS }));
  if (!detail || !visible || generation !== detailGeneration || selectedId !== id || historical || !followLatest) return;
  selectedSummary = detail.summary ?? selectedSummary;
  totalEvents = detail.total;
  if (incremental) {
    const merged = new Map(events.map((event) => [eventIdentity(event), event]));
    for (const event of detail.events) merged.set(eventIdentity(event), event);
    events = boundedPage([...merged.values()], true);
  } else events = boundedPage(detail.events, true);
  detailFor = id;
  detailCursor = typeof detail.nextFrom === 'number' ? detail.nextFrom : detail.events.reduce((cursor, event) => Math.max(cursor, event.seq + 1), detailCursor ?? 0);
  paintDetail();
  void loadHandoff();
  // Drain a burst with bounded pages; cancellation is checked before every next page.
  if (incremental && detail.events.length === MAX_TIMELINE_ROWS && generation === detailGeneration) scheduleReload();
}
async function navigateHistory(direction: 'earlier' | 'newer' | 'latest', match?: HistoryMatch): Promise<void> {
  const id = selectedId;
  if (!id || !visible) return;
  const generation = ++detailGeneration;
  historical = direction !== 'latest' || Boolean(match);
  followLatest = direction === 'latest' && !match;
  historyLoading = true;
  paintNavigation();
  const current = (): boolean => visible && selectedId === id && generation === detailGeneration;
  const read = async (from: number, limit: number): Promise<SessionDetail | null> => {
    if (!current()) return null;
    return run(api.getSession(id, { from, limit }));
  };
  try {
    let detail: SessionDetail | null;
    if (match) detail = await read(match.seq, MAX_TIMELINE_ROWS);
    else if (direction === 'earlier') detail = await earlierHistory(Math.min(...events.map((event) => event.seq)), read, current);
    else if (direction === 'newer') detail = await read(events.reduce((next, event) => Math.max(next, event.seq + 1), 0), MAX_TIMELINE_ROWS);
    else detail = await run(api.getSession(id, { limit: MAX_TIMELINE_ROWS }));
    if (!detail || !current()) return;
    if (match && !detail.events.some((event) => eventIdentity(event) === match.key)) {
      toast('That recorded message changed. Search again to locate its current revision.');
      return;
    }
    if (!detail.events.length && direction !== 'latest') {
      toast(direction === 'earlier' ? 'No earlier retained rows in this window.' : 'No newer retained rows.');
      return;
    }
    selectedSummary = detail.summary ?? selectedSummary;
    totalEvents = detail.total;
    const overlap = !match && direction === 'earlier' ? events.slice(0, 16) : [];
    const merged = new Map([...detail.events, ...overlap].map((event) => [eventIdentity(event), event]));
    events = boundedPage([...merged.values()], direction !== 'newer');
    detailFor = id;
    detailCursor = events.reduce((next, event) => Math.max(next, event.seq + 1), 0);
    paintDetail();
    if (match) {
      const row = Array.from($('timeline').children).find((entry) => (entry as HTMLElement).dataset.rowKey === match.key) as HTMLElement | undefined;
      row?.focus({ preventScroll: true });
      row?.scrollIntoView({ block: 'nearest' });
    } else if (direction === 'newer') $('chatBody').scrollTop = 0;
    void loadHandoff();
  } finally {
    if (generation === detailGeneration) { historyLoading = false; paintNavigation(); }
  }
}
function paintNavigation(): void {
  const earlier = $<HTMLButtonElement>('historyEarlier');
  const newer = $<HTMLButtonElement>('historyNewer');
  const latest = $<HTMLButtonElement>('historyLatest');
  if (!earlier || !newer || !latest) return;
  earlier.disabled = historyLoading || !events.length || Math.min(...events.map((event) => event.seq)) <= 1;
  newer.disabled = historyLoading || !selectedId || !historical;
  latest.disabled = historyLoading || !selectedId;
  latest.setAttribute('aria-pressed', String(!historical && followLatest));
  latest.textContent = historical || !followLatest ? 'Latest / resume live' : 'Following latest';
}

function toolBody(event: Extract<SessionEvent, { kind: 'tool_call' }>): HTMLElement {
  const { call } = event;
  const box = document.createElement('details');
  box.className = `tool tone-${call.summary.tone}`;
  box.open = openTools.has(call.callId);
  const head = document.createElement('summary');
  head.dataset.focusKey = 'expand-tool';
  head.append(icon(KIND_ICON[call.summary.kind] ?? 'i-bolt', 'ico tool-ico'), el('b', '', call.summary.title));
  if (call.summary.detail) head.append(el('em', '', call.summary.detail));
  if (call.summary.metric) head.append(el('span', 'metric', call.summary.metric));
  box.append(head);
  let payload: HTMLElement | null = null;
  const expand = (): void => {
    if (payload) return;
    payload = el('div', 'raw');
    payload.append(el('p', 'raw-facts', `${call.tool} · ${call.outcome} · ${Math.round(call.durationMs)} ms · placed by ${ATTRIBUTION_LABELS[call.attribution] ?? call.attribution}`));
    if (call.changes?.length) {
      const changes = el('ul', 'changes');
      for (const change of call.changes) {
        const row = el('li');
        row.append(el('code', '', change.path), el('span', 'metric', `+${change.added} −${change.removed}${change.approximate ? ' (approx.)' : ''}`));
        changes.append(row);
      }
      payload.append(changes);
    }
    payload.append(el('h4', '', 'Arguments'), boundedText(call.args, 'pre', true), el('h4', '', 'Result'), boundedText(call.result, 'pre', true));
    for (const asset of call.assets ?? []) payload.append(el('p', 'raw-facts', `asset ${asset.id} · ${asset.mimeType} · ${compactNumber(asset.bytes)} bytes`));
    addCodeControls(payload, { wrap: preferences.wrap, truncated: call.args.truncated || call.result.truncated, copy: async (text) => (await run(api.writeClipboard(text))) === true });
    box.append(payload);
  };
  if (box.open) expand();
  box.addEventListener('toggle', () => {
    if (box.open) { openTools.add(call.callId); expand(); }
    else {
      openTools.delete(call.callId);
      // Closed rows retain no hidden argument/result DOM or highlighting tree.
      payload?.remove();
      payload = null;
    }
  });
  return box;
}
function eventBody(event: SessionEvent): HTMLElement {
  switch (event.kind) {
    case 'session_start': return el('p', 'meta', `Session started — ${event.title}`);
    case 'user_message': {
      const box = el('div', 'said is-user');
      box.append(el('b', '', 'You'), boundedText(event.message));
      return box;
    }
    case 'assistant_message': {
      const box = el('div', 'said');
      box.append(el('b', '', event.final ? 'ChatGPT' : 'ChatGPT (partial)'));
      if (preferences.raw) box.append(boundedText(event.message, 'msg raw-message', true));
      else {
        const rich = renderedMessage(event.renderedHtml?.text ?? '', event.message.text);
        addCodeControls(rich, { wrap: preferences.wrap, truncated: event.message.truncated || event.renderedHtml?.truncated === true, copy: async (text) => (await run(api.writeClipboard(text))) === true });
        box.append(rich);
        if (event.message.truncated || event.renderedHtml?.truncated || (event.renderedHtml?.text.length ?? 0) > MAX_RENDERED_HTML_CHARS) box.append(el('p', 'cut', 'Showing retained/bounded content. Copying cannot recover omitted text.'));
      }
      return box;
    }
    case 'progress': return boundedText(event.message, 'meta is-progress');
    case 'page_tool': {
      const line = el('p', 'meta is-progress thinking-line');
      line.append(icon('i-bolt', 'ico thinking-ico'), el('span', '', event.label));
      return line;
    }
    case 'turn_start': return el('p', 'meta', 'Turn started');
    case 'turn_end': return el('p', event.outcome === 'completed' ? 'meta' : 'meta is-warn', `Turn ${TURN_OUTCOME_LABELS[event.outcome]}${event.detail ? ` — ${event.detail}` : ''}`);
    case 'chat_error': return boundedText(event.message, 'meta is-bad');
    case 'tool_call': return toolBody(event);
    case 'note': return boundedText(event.message, 'meta');
    case 'agent_message': {
      const box = el('div', 'said');
      box.title = event.delivery === 'sent' ? `Sent by ${event.from}; recorded when the app accepted it` : `Received by ${event.to}; recorded when it acknowledged delivery`;
      box.append(el('b', '', `${event.from} → ${event.to}`), boundedText(event.message));
      return box;
    }
    case 'handoff': return el('p', 'meta is-good', `Handoff saved — ${compactNumber(event.chars)} characters (${event.reason})`);
  }
}
function eventRow(event: SessionEvent): HTMLElement {
  const row = el('div', `ev ev-${event.kind}`);
  row.tabIndex = -1;
  row.dataset.seq = String(event.seq);
  const time = document.createElement('time');
  time.textContent = clockTime(event.time);
  time.title = new Date(event.time).toLocaleString();
  const body = el('div', 'ev-body');
  if (event.agent) body.append(el('span', 'chip', event.agent));
  body.append(eventBody(event));
  row.append(time, body);
  return row;
}
function paintAgentFilter(): void {
  const box = $('chatAgentFilter');
  const named = [...new Set([...(selectedSummary?.agents ?? []), ...events.flatMap((event) => event.agent ? [event.agent] : [])])].sort();
  const choices: Array<{ key: string; label: string }> = [{ key: '', label: 'All' }, ...named.map((name) => ({ key: name, label: name }))];
  if (events.some((event) => !event.agent)) choices.push({ key: UNATTRIBUTED, label: 'Unattributed' });
  if (agentFilter !== null && !choices.some((choice) => choice.key === agentFilter)) agentFilter = null;
  box.setAttribute('role', 'group');
  box.setAttribute('aria-label', 'Filter loaded timeline by agent');
  reconcileRows(box, choices.map((choice) => ({ key: choice.key, revision: choice.label, create: () => {
    const node = button('', choice.label, () => { agentFilter = choice.key || null; paintDetail(); });
    node.dataset.agent = choice.key;
    node.dataset.focusKey = 'agent-filter';
    return node;
  } })));
  box.hidden = named.length === 0 && agentFilter === null;
  for (const node of box.querySelectorAll<HTMLButtonElement>('button')) {
    const active = (node.dataset.agent || null) === agentFilter;
    node.classList.toggle('is-sel', active);
    node.setAttribute('aria-pressed', String(active));
  }
}
function paintDetail(): void {
  if (!visible) return;
  $('chatTitle').textContent = selectedSummary?.title || (selectedId ? 'Untitled session' : 'No session selected');
  paintAgentFilter();
  const filtered = agentFilter === null ? events : events.filter((event) => agentFilter === UNATTRIBUTED ? !event.agent : event.agent === agentFilter);
  const pane = $('chatBody');
  const timeline = $('timeline');
  preserveViewport(pane, timeline, !historical && followLatest, () => {
    reconcileRows(timeline, filtered.map((event) => ({ key: eventIdentity(event), revision: JSON.stringify([event, preferences.raw, preferences.wrap]), create: () => eventRow(event) })));
  });
  const currentCalls = new Set(events.flatMap((event) => event.kind === 'tool_call' ? [event.call.callId] : []));
  for (const id of openTools) if (!currentCalls.has(id)) openTools.delete(id);
  $('timelineEmpty').hidden = filtered.length > 0;
  const facts = selectedId ? [`${totalEvents} retained events`, `${events.length} loaded in this bounded window`] : [];
  if (agentFilter !== null) facts.push(`${filtered.length} matched in the loaded window`);
  if (selectedSummary) {
    facts.push(`~${compactNumber(selectedSummary.estimatedTokens)} rough context tokens`);
    if (selectedSummary.chatIds.length > 1) facts.push(`${selectedSummary.chatIds.length} explicit conversation generations`);
    if (selectedSummary.lastTurnOutcome && selectedSummary.lastTurnOutcome !== 'completed') facts.push(`last turn ${TURN_OUTCOME_LABELS[selectedSummary.lastTurnOutcome]}`);
  }
  if (historical || !followLatest) facts.push('Live following paused; Latest resumes it');
  $('chatFoot').textContent = facts.join(' · ');
  $('chatState').textContent = selectedSummary?.conversationId === null ? 'Recorded work not attributed to a browser chat' : swarm?.agents.length ? `Current run: ${swarm.agents.length} agents · ${swarm.agents.filter((agent) => agent.state === 'sleeping').length} sleeping` : '';
  paintNavigation();
}
async function loadHandoff(): Promise<void> {
  const id = selectedId;
  const wanted = selectedSummary?.lastHandoffId ?? null;
  const generation = ++handoffGeneration;
  if (!id || !wanted) { handoff = null; handoffFor = null; paintHandoff(); return; }
  if (handoffFor === wanted) return;
  const loaded = await run(api.getHandoff(id, wanted));
  if (!visible || generation !== handoffGeneration || selectedId !== id) return;
  handoff = loaded;
  handoffFor = loaded ? wanted : null;
  paintHandoff();
}
function paintHandoff(): void {
  if (!visible) return;
  const entry = handoff;
  reconcileRows($('handoffBox'), entry ? [{ key: entry.id, revision: JSON.stringify(entry), create: () => {
    const box = el('div');
    box.append(el('p', 'hint', `${compactNumber(entry.text.length)} characters · from ${entry.sourceEvents} events (~${compactNumber(entry.sourceTokens)} tokens) · ${ago(entry.createdAt)}`));
    for (const note of entry.notes) box.append(el('p', 'hint is-warn', note));
    box.append(el('pre', 'pre', entry.text));
    return box;
  } }] : []);
  $('handoffHead').hidden = !entry;
  $('copyHandoff').hidden = !entry;
}

async function searchRecording(continueSearch: boolean): Promise<void> {
  const id = selectedId;
  const query = $<HTMLInputElement>('historySearch').value.trim().slice(0, 256);
  if (!id || !query || !visible) return;
  const generation = ++searchGeneration;
  if (!continueSearch) { searchFrom = 0; searchScanned = 0; }
  const current = (): boolean => visible && id === selectedId && generation === searchGeneration && $<HTMLInputElement>('historySearch').value.trim().slice(0, 256) === query;
  $<HTMLButtonElement>('historyFind').disabled = true;
  $<HTMLButtonElement>('historyFindMore').disabled = true;
  $('historySearchState').textContent = 'Searching a bounded page of retained text…';
  try {
    const page = await searchHistory(query, searchFrom, async (from, limit) => run(api.getSession(id, { from, limit })), current);
    if (!page || !current()) return;
    searchFrom = page.nextFrom;
    searchScanned += page.scanned;
    searchDone = page.done;
    searchMatches = page.matches;
    paintSearch();
    $('historySearchState').textContent = `${page.matches.length} matches on this result page · ${searchScanned} retained rows scanned${page.done ? ' · reached the current end' : ' · Continue search scans the next bounded page'}. Asset contents are not searched.`;
  } finally {
    if (current()) releaseSearchControls();
  }
}
function paintSearch(): void {
  const root = $('historySearchResults');
  if (!root) return;
  reconcileRows(root, searchMatches.map((match) => ({ key: match.key, revision: `${match.seq}:${match.preview}`, create: () => {
    const node = button('', `Event ${match.seq}: ${match.preview}`, () => void navigateHistory('newer', match));
    node.dataset.focusKey = 'search-result';
    return node;
  } })));
  if (!searchMatches.length) $('historySearchState').textContent = '';
}
function keyboardChoices(root: HTMLElement, selector: string): void {
  root.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    const target = event.target as HTMLElement;
    if (!target.matches(selector)) return;
    const choices = Array.from(root.querySelectorAll<HTMLElement>(selector));
    const index = choices.indexOf(target);
    if (index < 0 || !choices.length) return;
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1 : (index + (['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 1) + choices.length) % choices.length;
    event.preventDefault();
    choices[next]!.focus({ preventScroll: true });
    choices[next]!.scrollIntoView({ block: 'nearest' });
  });
}
function installControls(): void {
  const listPane = $('sessionList').parentElement!;
  const listControls = el('div', 'viewer-controls');
  const filter = document.createElement('input');
  filter.type = 'search';
  filter.maxLength = 256;
  filter.placeholder = 'Filter titles on this page';
  filter.setAttribute('aria-label', 'Filter session titles on the loaded page');
  filter.addEventListener('input', () => { listFilter = filter.value.toLocaleLowerCase(); paintSessions(); });
  const group = document.createElement('select');
  group.setAttribute('aria-label', 'Group recorded sessions');
  for (const [value, label] of [['none', 'No grouping'], ['project', 'Project groups'], ['lineage', 'Conversation lineage']]) {
    const option = document.createElement('option'); option.value = value!; option.textContent = label!; group.append(option);
  }
  group.value = preferences.grouping;
  group.addEventListener('change', () => { preferences.grouping = group.value as ChatPreferences['grouping']; changedPreferences(); });
  listControls.append(filter, group,
    button('sessionsNewest', 'Newest', () => { onlyPinned = false; pageCursor = undefined; void loadSessions(); }),
    button('sessionsOlder', 'Older sessions', () => { if (onlyPinned) pinnedPage++; else if (nextPageCursor) pageCursor = nextPageCursor; void loadSessions(); }),
    button('sessionsPinned', 'Pinned', () => { onlyPinned = true; pinnedPage = 0; void loadSessions(); })
  );
  listPane.insertBefore(listControls, $('sessionList'));
  const timelineView = $('timeline').parentElement!;
  const controls = el('div', 'viewer-controls history-controls');
  controls.append(button('historyEarlier', 'Load earlier', () => void navigateHistory('earlier')), button('historyNewer', 'Newer', () => void navigateHistory('newer')), button('historyLatest', 'Following latest', () => void navigateHistory('latest')));
  for (const [id, label, values, key] of [
    ['chatFontSize', 'Text size', [12, 14, 16, 18, 20, 22, 24], 'fontSize'],
    ['chatReadingWidth', 'Reading width', [48, 64, 72, 88, 104, 120], 'width']
  ] as const) {
    const select = document.createElement('select');
    select.id = id;
    select.setAttribute('aria-label', label);
    for (const value of values) { const option = document.createElement('option'); option.value = String(value); option.textContent = `${value}${key === 'fontSize' ? ' px' : ' ch'}`; select.append(option); }
    select.addEventListener('change', () => { preferences[key] = Number(select.value); changedPreferences(); });
    const wrapper = document.createElement('label'); wrapper.append(document.createTextNode(`${label} `), select); controls.append(wrapper);
  }
  controls.append(button('chatRaw', 'Raw text', () => { preferences.raw = !preferences.raw; changedPreferences(); }), button('chatWrap', 'Wrap code', () => { preferences.wrap = !preferences.wrap; changedPreferences(); }), button('chatReadingReset', 'Reset reading', () => {
    const defaults = defaultChatPreferences();
    Object.assign(preferences, { fontSize: defaults.fontSize, width: defaults.width, raw: false, wrap: false });
    changedPreferences();
  }));
  controls.append(el('span', 'hint', 'Raw is retained text, not a reconstruction of original Markdown.'));
  const project = document.createElement('input');
  project.id = 'sessionProject'; project.maxLength = 80; project.placeholder = 'Project group label'; project.setAttribute('aria-label', 'Presentation-only project group for selected session');
  controls.append(project, button('sessionProjectSave', 'Set group', () => {
    if (!selectedId) return;
    const label = project.value.trim().slice(0, 80);
    if (label) {
      if (!Object.hasOwn(preferences.projects, selectedId) && Object.keys(preferences.projects).length >= 500) {
        toast('The viewer supports 500 project labels. Clear an existing group label first.');
        return;
      }
      preferences.projects[selectedId] = label;
    } else delete preferences.projects[selectedId];
    changedPreferences();
  }));
  const search = document.createElement('input');
  search.id = 'historySearch'; search.type = 'search'; search.maxLength = 256;
  search.placeholder = 'Search this recording'; search.setAttribute('aria-label', 'Search retained text in selected recording');
  search.addEventListener('input', () => {
    searchGeneration++;
    searchFrom = 0; searchScanned = 0; searchDone = true; searchMatches = [];
    releaseSearchControls();
    paintSearch();
  });
  search.addEventListener('keydown', (event) => { if (event.key === 'Enter') void searchRecording(false); });
  controls.append(search, button('historyFind', 'Search', () => void searchRecording(false)), button('historyFindMore', 'Continue search', () => void searchRecording(true)));
  const searchState = el('p', 'hint'); searchState.id = 'historySearchState'; searchState.setAttribute('role', 'status');
  const results = el('div', 'history-search-results'); results.id = 'historySearchResults';
  controls.append(searchState, results);
  timelineView.prepend(controls);
  releaseSearchControls();
  applyReading();
  keyboardChoices($('sessionList'), 'button[data-select]');
  keyboardChoices($('chatAgentFilter'), 'button');
}
function showView(name: string): void {
  for (const node of $('chatView').querySelectorAll<HTMLButtonElement>('[data-view]')) { node.classList.toggle('is-sel', node.dataset.view === name); node.setAttribute('aria-pressed', String(node.dataset.view === name)); }
  for (const node of document.querySelectorAll<HTMLElement>('#chatBody > .view')) node.hidden = node.dataset.view !== name;
  $('chatSettingsBtn').classList.toggle('is-on', name === 'settings');
  $('chatSettingsBtn').setAttribute('aria-expanded', String(name === 'settings'));
}
function applySwarm(next: SwarmState): void {
  swarm = next;
  if (visible) { paintSwarmSettings(next); paintSessions(); paintDetail(); }
}
export function chatApply(state: AppState, previous?: Config): void {
  applyChatSettings(state, previous);
  if (visible) paintSessions();
}
export function chatVisible(next: boolean): void {
  visible = next;
  if (!next) {
    listGeneration++; detailGeneration++; handoffGeneration++; searchGeneration++;
    window.clearTimeout(reloadTimer); reloadTimer = undefined;
    listLoading = false; historyLoading = false;
    releaseSearchControls();
    return;
  }
  releaseSearchControls();
  paintSessions(); paintDetail(); paintHandoff();
  if (swarm) paintSwarmSettings(swarm);
  void refreshAll();
}
async function refreshAll(): Promise<void> {
  await loadSessions();
  if (!visible) return;
  const next = await run(api.getSwarm());
  if (next && visible) applySwarm(next);
}
function scheduleReload(): void {
  if (!visible || reloadTimer !== undefined) return;
  // Throttle rather than perpetually resetting a debounce during sustained output.
  reloadTimer = window.setTimeout(() => {
    reloadTimer = undefined;
    if (!visible) return;
    if (!pageCursor && !onlyPinned) void loadSessions();
    else if (!historical && followLatest) void loadDetail();
  }, 400);
}
export function initChat(next: Deps): () => void {
  deps = next;
  preferences = loadChatPreferences();
  installControls();
  initChatSettings(() => deps.save(), applySwarm);
  $('chatView').addEventListener('click', (event) => {
    const view = (event.target as HTMLElement).closest<HTMLElement>('[data-view]')?.dataset.view;
    if (view) { lastContentView = view; showView(view); }
  });
  $('chatSettingsBtn').addEventListener('click', () => {
    const settings = document.querySelector<HTMLElement>('#chatBody > .view[data-view="settings"]');
    showView(settings && !settings.hidden ? lastContentView : 'settings');
  });
  $('chatRefresh').addEventListener('click', () => void refreshAll());
  $('copyHandoff').addEventListener('click', async () => {
    if (handoff && await run(api.writeClipboard(handoff.text))) toast('Handoff copied');
  });
  $('chatBody').addEventListener('scroll', () => {
    const pane = $('chatBody');
    if (!visible || !pane.clientHeight || historical || document.querySelector<HTMLElement>('#chatBody > .view[data-view="timeline"]')?.hidden) return;
    const next = pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 40;
    if (next !== followLatest) {
      followLatest = next;
      if (!next) detailGeneration++;
      else void loadDetail();
      paintNavigation();
    }
  });
  const unsubscribeSession = api.onSessionChanged(scheduleReload);
  const unsubscribeSwarm = api.onSwarmChanged(applySwarm);
  return () => { chatVisible(false); unsubscribeSession(); unsubscribeSwarm(); };
}

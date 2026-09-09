import type { SessionSummary } from '../shared/session.js';

export interface ChatPreferences {
  fontSize: number;
  width: number;
  raw: boolean;
  wrap: boolean;
  grouping: 'none' | 'project' | 'lineage';
  pins: string[];
  projects: Record<string, string>;
}
const KEY = 'local-cgpt.viewer.v1';
const MAX_ENTRIES = 500;
const ID = /^[0-9a-z-]{8,64}$/i;
export function defaultChatPreferences(): ChatPreferences {
  return { fontSize: 14, width: 88, raw: false, wrap: false, grouping: 'none', pins: [], projects: {} };
}

/** Only presentation preferences, opaque session ids and user-chosen group labels persist.
 * Never write transcript text, search queries, tool output, credentials or host paths here.
 * Pins do not change store retention. This is not encrypted session storage (#60).
 */
export function loadChatPreferences(storage?: Pick<Storage, 'getItem'>): ChatPreferences {
  const defaults = defaultChatPreferences();
  try {
    const raw = (storage ?? window.localStorage).getItem(KEY);
    if (!raw || raw.length > 100_000) return defaults;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object') return defaults;
    const data = value as Partial<ChatPreferences>;
    const projects: Record<string, string> = {};
    if (data.projects && typeof data.projects === 'object') {
      for (const [id, label] of Object.entries(data.projects).slice(0, MAX_ENTRIES)) {
        if (ID.test(id) && typeof label === 'string' && label.length <= 80) projects[id] = label;
      }
    }
    return {
      fontSize: typeof data.fontSize === 'number' && Number.isFinite(data.fontSize) ? Math.max(12, Math.min(24, Math.round(data.fontSize))) : defaults.fontSize,
      width: typeof data.width === 'number' && Number.isFinite(data.width) ? Math.max(48, Math.min(120, Math.round(data.width))) : defaults.width,
      raw: data.raw === true,
      wrap: data.wrap === true,
      grouping: data.grouping === 'project' || data.grouping === 'lineage' ? data.grouping : 'none',
      pins: Array.isArray(data.pins) ? [...new Set(data.pins.filter((id) => typeof id === 'string' && ID.test(id)))].slice(0, MAX_ENTRIES) : [],
      projects
    };
  } catch { return defaults; }
}

export function saveChatPreferences(value: ChatPreferences, storage?: Pick<Storage, 'setItem'>): boolean {
  try {
    const clean = loadChatPreferences({ getItem: () => JSON.stringify(value) });
    (storage ?? window.localStorage).setItem(KEY, JSON.stringify(clean));
    return true;
  } catch { return false; }
}

export function sessionGroup(summary: SessionSummary, rows: readonly SessionSummary[], preferences: ChatPreferences): string {
  if (preferences.grouping === 'project') return preferences.projects[summary.id] || 'Ungrouped';
  if (preferences.grouping !== 'lineage') return '';
  let current = summary;
  const visited = new Set<string>();
  while (current.origin?.kind === 'resume' && current.origin.fromSessionId && !visited.has(current.id)) {
    visited.add(current.id);
    const source = current.origin.fromSessionId;
    const parent = rows.find((row) => row.id === source);
    if (!parent) return `Resume lineage · ${source}`;
    current = parent;
  }
  // Workers never borrow another worker's identity merely because their labels match.
  return `Session lineage · ${current.id}`;
}

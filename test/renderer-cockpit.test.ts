import { readFileSync } from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../src/main/config.js';
import type { AppState } from '../src/shared/types.js';
import { connectionPresentation } from '../src/shared/connection-presentation.js';

const css = readFileSync(path.join(process.cwd(), 'src/renderer/cockpit.css'), 'utf8');
const domSource = readFileSync(path.join(process.cwd(), 'src/renderer/dom.ts'), 'utf8');
const cockpitSource = readFileSync(path.join(process.cwd(), 'src/renderer/cockpit.ts'), 'utf8');
const html = readFileSync(path.join(process.cwd(), 'src/renderer/index.html'), 'utf8');
let dom: JSDOM;
let state: AppState;
let publish: (next: AppState) => void;
let save: ReturnType<typeof vi.fn>;

// Isolate the controller's Home behavior here. renderer-state.test.ts separately executes
// the real Chat module and tests shared setting saves, dirty edits and credential handling.
vi.mock('../src/renderer/chat.js', () => ({
  chatApply: () => undefined, chatVisible: () => undefined, initChat: () => undefined,
  chatSettingsPatch: (config: AppState['config']) => ({ sessions: config.sessions, compaction: config.compaction, multiAgent: config.multiAgent, goal: config.goal })
}));

beforeEach(async () => {
  vi.resetModules();
  dom = new JSDOM(html, { url: 'https://local.test/', pretendToBeVisual: true });
  const w = dom.window;
  Object.assign(globalThis, { window: w, document: w.document, HTMLElement: w.HTMLElement, Element: w.Element,
    Node: w.Node, DocumentFragment: w.DocumentFragment, HTMLInputElement: w.HTMLInputElement,
    HTMLSelectElement: w.HTMLSelectElement, HTMLTextAreaElement: w.HTMLTextAreaElement, HTMLButtonElement: w.HTMLButtonElement });
  // Browser prototype methods are writable. A non-writable test stub incorrectly prevents
  // the existing reduced-motion wrapper from installing before any cockpit assertion runs.
  Object.defineProperty(w.Element.prototype, 'scrollIntoView', { configurable: true, writable: true, value: vi.fn() });
  const config = defaultConfig();
  config.tunnel.kind = 'manual';
  config.roots = [{ name: 'project', path: '/tmp/project' }];
  config.capabilities.read = true;
  config.capabilities.edit = true;
  config.readOnly = true;
  state = {
    config, hasApiKey: false, hasGoalKey: false, resolvedBinary: null, bundledTunnelVersion: null,
    platform: { family: 'linux', desktopAutomation: false },
    secureStorage: { available: true, detail: 'test keyring' },
    bridge: { running: false, present: false, paired: false, port: null, lastSeenAt: null },
    status: { state: 'connected', detail: 'Local server running', publicUrl: null, localUrl: 'http://127.0.0.1:1234/mcp/core/test',
      handshakeAt: null, lastRequestAt: null, lastToolCallAt: null, health: null,
      surfaces: [{ id: 'core', available: true, optional: false, connectorName: 'local-cgpt Core', description: 'test',
        cardSummary: 'Core', localUrl: 'http://127.0.0.1:1234/mcp/core/test', publicUrl: null, tools: ['read', 'view_image', 'session'],
        state: 'live', detail: '', lastRequestAt: null, lastToolCallAt: null }] }
  } as AppState;
  const ok = (data: unknown) => Promise.resolve({ ok: true, data });
  save = vi.fn(() => ok(state));
  const api = new Proxy({
    getState: () => ok(state), saveSettings: save, getLog: () => ok([]),
    getSwarm: () => ok({ running: false, runId: null, agents: [], maxWorkers: 2, pendingReports: 0 }),
    onStateChanged: (listener: (next: AppState) => void) => { publish = listener; return () => undefined; },
    onLogEntry: () => () => undefined, onSwarmChanged: () => () => undefined
  }, { get(target, key) { return key in target ? (target as any)[key] : () => ok(null); } });
  Object.defineProperty(w, 'api', { value: api, configurable: true });
  await import('../src/renderer/main.js');
  await vi.waitFor(() => expect(document.querySelector('[data-metric="access"] .cockpit-value')?.textContent).toBe('3 tools'));
});
afterEach(() => { dom.window.close(); vi.restoreAllMocks(); });

function metric(name: string, selector = '.cockpit-value'): HTMLElement {
  return document.querySelector<HTMLElement>(`[data-metric="${name}"] ${selector}`)!;
}

describe('state-driven Home cockpit', () => {
  it('adds one stable access overview ahead of existing controls', () => {
    const cockpit = document.getElementById('homeCockpit')!;
    expect(document.querySelector('[data-panel="home"]')!.firstElementChild).toBe(cockpit);
    expect(cockpit.getAttribute('aria-label')).toBe('Current access overview');
    expect(cockpit.querySelectorAll('.cockpit-metric')).toHaveLength(4);
    publish(state);
    expect(document.querySelectorAll('#homeCockpit')).toHaveLength(1);
  });
  it('distinguishes published schemas from effective permissions without reading edited DOM', () => {
    expect(metric('safety').textContent).toBe('Read-only');
    expect(metric('access', '.cockpit-detail').textContent).toBe('1 effective permission enabled');
    const read = document.querySelector<HTMLInputElement>('input[data-cap="read"]')!;
    read.checked = false;
    document.getElementById('facts')!.textContent = '999 tools';
    const { config } = state;
    publish({ ...state, config: { ...config } });
    expect(metric('access').textContent).toBe('3 tools');
    expect(metric('access', '.cockpit-detail').textContent).toBe('1 effective permission enabled');
    expect(document.getElementById('permissionStatusBox')!.textContent).toContain('older tool schema');
    expect(save).not.toHaveBeenCalled();
  });
  it('summarizes only approved aliases from AppState', () => {
    publish({ ...state, config: { ...state.config, roots: [{ name: 'project', path: '/tmp/project' }, { name: 'docs', path: '/tmp/docs' }] } });
    expect(metric('projects').textContent).toBe('2 shared');
    expect(metric('projects', '.cockpit-detail').textContent).toBe('/project · /docs');
    expect(metric('projects', '.cockpit-detail').textContent).not.toContain('/tmp');
  });
  it('keeps child identity and focus during identical state updates', () => {
    const value = metric('access');
    const action = document.getElementById('cockpitAttentionAction')!;
    action.focus();
    publish(state);
    expect(metric('access')).toBe(value);
    expect(document.activeElement).toBe(action);
  });
  it('routes missing setup through an explicit action', () => {
    publish({ ...state, config: { ...state.config, roots: [] } });
    const button = document.getElementById('cockpitAttentionAction')!;
    expect(button.textContent).toBe('View setup');
    button.click();
    expect(document.querySelector('[data-panel="setup"]')!.classList.contains('is-active')).toBe(true);
  });
  it('has no DOM observer, text parser or capture-phase disclosure override', () => {
    expect(cockpitSource).not.toContain('MutationObserver');
    expect(cockpitSource).not.toContain('stopPropagation');
    expect(cockpitSource).not.toContain('publishedToolCount');
    expect(cockpitSource).toContain('projectHomeState');
  });
});

describe('single-owner permission disclosures', () => {
  it('keeps independently opened groups expanded across state refreshes without saving', async () => {
    const read = document.querySelector<HTMLElement>('.perm[data-group="read"]')!;
    const write = document.querySelector<HTMLElement>('.perm[data-group="write"]')!;
    const bubbled = vi.fn();
    document.getElementById('groups')!.addEventListener('click', bubbled);
    read.querySelector<HTMLButtonElement>('.perm-main')!.click();
    write.querySelector<HTMLButtonElement>('.perm-main')!.click();
    publish(state);
    await Promise.resolve();
    expect(read.classList.contains('is-open')).toBe(true);
    expect(write.classList.contains('is-open')).toBe(true);
    expect(read.querySelector('.perm-main')!.getAttribute('aria-expanded')).toBe('true');
    expect(bubbled).toHaveBeenCalledTimes(2);
    expect(save).not.toHaveBeenCalled();
    read.querySelector<HTMLButtonElement>('.perm-main')!.click();
    expect(read.classList.contains('is-open')).toBe(false);
    expect(write.classList.contains('is-open')).toBe(true);
  });
});

describe('manual connection evidence', () => {
  it('does not turn local readiness or a local handshake into remote verification', () => {
    expect(document.getElementById('liveState')!.textContent).toBe('Local server ready');
    expect(metric('connection').textContent).toBe('Local server ready');
    expect(document.getElementById('live')!.classList.contains('is-connected')).toBe(false);
    expect(connectionPresentation({ ...state, status: { ...state.status, handshakeAt: Date.now() } }).label).toBe('Local server ready');
    expect(document.getElementById('connectLabel')!.textContent).toBe('Disconnect');
  });
  it('uses a current endpoint MCP request and clears verification on disconnect', () => {
    const next = { ...state, status: { ...state.status, lastRequestAt: Date.now() } };
    publish(next);
    expect(document.getElementById('liveState')!.textContent).toBe('Remote connection verified');
    expect(metric('connection', '.cockpit-detail').textContent).toContain('not caller or proxy identity attestation');
    publish({ ...next, status: { ...next.status, state: 'disconnected', localUrl: null } });
    expect(document.getElementById('liveState')!.textContent).toBe('Not connected');
  });
});

describe('unchanged cockpit layout contract', () => {
  it('loads after the general renderer foundation', () => {
    expect(domSource.indexOf("import './cockpit.css';")).toBeGreaterThan(domSource.indexOf("import './foundation.css';"));
    expect(domSource).toContain('initHomeCockpit();');
  });
  it('keeps the wide permission-primary and 900/720/520 responsive layouts', () => {
    expect(css).toMatch(/\.top\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1\.55fr\)\s+minmax\(280px, 0\.8fr\)/s);
    expect(css).toMatch(/\.top > \.card\.is-permissions\s*\{[^}]*grid-row:\s*1 \/ 3/s);
    for (const width of [900, 720, 520]) expect(css).toContain(`@media (max-width: ${width}px)`);
    expect(css).not.toMatch(/overflow-x:\s*(auto|scroll)/);
    expect(css).toMatch(/@media \(max-width: 720px\)[\s\S]*\.top\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/);
    expect(css).toMatch(/@media \(max-width: 520px\)[\s\S]*\.home-cockpit\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/);
  });
});

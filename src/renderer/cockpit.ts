/**
 * Home presentation consumes authoritative AppState, never checkbox state, rendered text
 * or CSS classes as evidence. The main renderer owns disclosure state and calls render
 * explicitly after state/log changes. This module has no observers, timers or IPC writes.
 */
import type { AppState } from '../shared/types.js';
import { CAPABILITIES, DESKTOP_CAPABILITIES, WRITE_CAPABILITIES } from '../shared/types.js';
import { connectionPresentation, type ConnectionPresentation } from '../shared/connection-presentation.js';

type Tone = ConnectionPresentation['tone'];
export interface HomeContext { setupProblem: string | null; problems: number; }
export interface HomeModel {
  metrics: Record<'connection' | 'safety' | 'access' | 'projects', { value: string; detail: string; tone: Tone }>;
  permissions: string;
  attention: { title: string; detail: string; action: 'setup' | 'activity' | 'checks' | null; label: string; warn: boolean };
}

/** Pure projection; presentation cannot manufacture a capability or a network authority. */
export function projectHomeState(state: AppState, context: HomeContext): HomeModel {
  const config = state.config;
  const desktop = state.platform?.desktopAutomation ?? true;
  const capabilities = CAPABILITIES.filter((capability) => config.capabilities[capability] &&
    !(config.readOnly && WRITE_CAPABILITIES.includes(capability)) &&
    (desktop || !DESKTOP_CAPABILITIES.includes(capability))).length;
  const tools = state.status.surfaces.filter((surface) => surface.available)
    .reduce((sum, surface) => sum + surface.tools.length, 0);
  const connection = connectionPresentation(state);
  const names = config.roots.slice(0, 3).map((root) => `/${root.name}`);
  let attention: HomeModel['attention'] = { title: 'No action needed', detail: 'No problems reported.', action: null, label: '', warn: false };
  if (context.setupProblem) attention = { title: 'Setup needs attention', detail: context.setupProblem, action: 'setup', label: 'View setup', warn: true };
  else if (context.problems > 0) attention = { title: `${context.problems} problem${context.problems === 1 ? '' : 's'}`, detail: 'Open the filtered activity log to inspect recent failures.', action: 'activity', label: 'View problems', warn: true };
  else if (connection.tone === 'warn') attention = { title: connection.label, detail: 'Run local diagnostics before changing permissions.', action: 'checks', label: 'Run checks', warn: true };
  else if (config.tunnel.kind === 'manual' && state.status.state === 'connected' && state.status.lastRequestAt === null) {
    attention = { title: 'Remote connection not yet verified', detail: 'The local server is ready. Configure your HTTPS tunnel and connect the app in ChatGPT.', action: 'setup', label: 'View setup', warn: false };
  }
  return {
    metrics: {
      connection: { value: connection.label, detail: connection.detail, tone: connection.tone },
      safety: { value: config.readOnly ? 'Read-only' : 'Custom access', detail: config.readOnly ? 'Write and command permissions are masked by the safety lock.' : 'Only explicitly enabled granular permissions are enforced.', tone: config.readOnly ? 'good' : 'neutral' },
      access: { value: `${tools} tool${tools === 1 ? '' : 's'}`, detail: `${capabilities} effective permission${capabilities === 1 ? '' : 's'} enabled`, tone: 'neutral' },
      projects: { value: `${config.roots.length} shared`, detail: names.length ? names.join(' · ') : 'No filesystem roots are approved.', tone: 'neutral' }
    },
    permissions: `${capabilities} effective permission${capabilities === 1 ? '' : 's'} · ${tools} tool schema${tools === 1 ? '' : 's'} published`,
    attention
  };
}

function text(document: Document, tag: string, className: string, value = ''): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = value;
  return node;
}
function setText(node: HTMLElement, value: string): void {
  if (node.textContent !== value) node.textContent = value;
}
export interface HomeComponent { element: HTMLElement; update: (model: HomeModel) => void; }

/** Reusable component: stable elements, explicit inputs, explicit action callbacks. */
export function createHomeComponent(document: Document, act: (action: NonNullable<HomeModel['attention']['action']>) => void): HomeComponent {
  const element = text(document, 'section', 'home-cockpit');
  element.id = 'homeCockpit';
  element.setAttribute('aria-label', 'Current access overview');
  const metrics = new Map<string, { root: HTMLElement; value: HTMLElement; detail: HTMLElement }>();
  for (const [id, label] of [['connection', 'Connection'], ['safety', 'Safety'], ['access', 'Tool surface'], ['projects', 'Projects']]) {
    const root = text(document, 'div', 'cockpit-metric');
    root.dataset.metric = id;
    const value = text(document, 'strong', 'cockpit-value', '—');
    const detail = text(document, 'span', 'cockpit-detail', 'Waiting for app state…');
    root.append(text(document, 'span', 'cockpit-label', label), value, detail);
    metrics.set(id!, { root, value, detail });
    element.append(root);
  }
  const attention = text(document, 'div', 'cockpit-attention');
  attention.id = 'cockpitAttention';
  attention.setAttribute('aria-live', 'polite');
  const copy = text(document, 'div', 'cockpit-attention-copy');
  const title = text(document, 'strong', '', 'Waiting for app state…');
  const detail = text(document, 'span', '');
  copy.append(title, detail);
  const button = document.createElement('button');
  button.type = 'button'; button.className = 'btn'; button.id = 'cockpitAttentionAction'; button.hidden = true;
  let action: HomeModel['attention']['action'] = null;
  button.addEventListener('click', () => { if (action) act(action); });
  attention.append(copy, button);
  element.append(attention);
  return {
    element,
    update(model) {
      for (const [id, metric] of Object.entries(model.metrics)) {
        const view = metrics.get(id)!;
        setText(view.value, metric.value);
        setText(view.detail, metric.detail);
        view.root.classList.toggle('is-good', metric.tone === 'good');
        view.root.classList.toggle('is-warn', metric.tone === 'warn');
      }
      setText(title, model.attention.title);
      setText(detail, model.attention.detail);
      setText(button, model.attention.label);
      action = model.attention.action;
      button.hidden = action === null;
      button.dataset.action = action ?? '';
      attention.classList.toggle('is-ok', !model.attention.warn);
      attention.classList.toggle('is-warn', model.attention.warn);
    }
  };
}
const mounted = new WeakMap<Document, { component: HomeComponent; permission: HTMLElement | null }>();

export function initHomeCockpit(): void {
  if (mounted.has(document)) return;
  const home = document.querySelector<HTMLElement>(".panel[data-panel='home']");
  if (!home) return;
  const component = createHomeComponent(document, (action) => {
    if (action === 'checks') document.getElementById('runChecks')?.click();
    else document.querySelector<HTMLButtonElement>(`#tabs button[data-tab="${action}"]`)?.click();
  });
  home.prepend(component.element);
  const groups = document.getElementById('groups');
  const card = groups?.closest<HTMLElement>('.card');
  let permission: HTMLElement | null = null;
  if (groups && card) {
    card.classList.add('is-permissions');
    const box = text(document, 'div', 'permission-status');
    box.id = 'permissionStatusBox';
    permission = text(document, 'strong', '', 'Waiting for permission state…');
    permission.id = 'permissionStatus';
    box.append(permission, text(document, 'span', '', 'Changes enforce immediately in local-cgpt. ChatGPT may keep an older tool schema until a new conversation.'));
    card.insertBefore(box, groups);
  }
  document.getElementById('rootList')?.closest('.card')?.classList.add('is-folders');
  document.getElementById('facts')?.closest('.card')?.classList.add('is-health');
  mounted.set(document, { component, permission });
}

export function renderHomeCockpit(state: AppState, context: HomeContext): void {
  initHomeCockpit();
  const view = mounted.get(document);
  if (!view) return;
  const model = projectHomeState(state, context);
  view.component.update(model);
  if (view.permission) setText(view.permission, model.permissions);
}

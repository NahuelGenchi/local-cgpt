/**
 * Home control-cockpit presentation.
 *
 * This module deliberately does not own application or permission state. It mirrors the
 * renderer projections that `main.ts` already paints from authoritative AppState and only
 * adds presentation state: summary cards, attention routing, and independent permission
 * disclosure state. Capability switches, read-only mode, IPC and main-process enforcement
 * remain the only authority-changing paths.
 */

let initialized = false;

function node<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function text(tag: string, className: string, value = ''): HTMLElement {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = value;
  return element;
}

function metric(id: string, label: string): HTMLElement {
  const item = text('div', 'cockpit-metric');
  item.dataset.metric = id;
  item.append(
    text('span', 'cockpit-label', label),
    text('strong', 'cockpit-value', '—'),
    text('span', 'cockpit-detail', 'Waiting for app state…')
  );
  return item;
}

function installCockpit(): HTMLElement | null {
  const home = document.querySelector<HTMLElement>(".panel[data-panel='home']");
  if (!home || node('homeCockpit')) return node('homeCockpit');

  const cockpit = document.createElement('section');
  cockpit.id = 'homeCockpit';
  cockpit.className = 'home-cockpit';
  cockpit.setAttribute('aria-label', 'Current access overview');
  cockpit.append(
    metric('connection', 'Connection'),
    metric('safety', 'Safety'),
    metric('access', 'Tool surface'),
    metric('projects', 'Projects')
  );

  const attention = text('div', 'cockpit-attention is-ok');
  attention.id = 'cockpitAttention';
  attention.setAttribute('aria-live', 'polite');
  const copy = text('span', 'cockpit-attention-copy');
  copy.append(text('strong', '', 'No action needed'), text('span', '', 'No problems reported.'));
  const action = document.createElement('button');
  action.id = 'cockpitAttentionAction';
  action.className = 'btn';
  action.type = 'button';
  action.hidden = true;
  action.addEventListener('click', () => {
    const target = action.dataset.action;
    if (target === 'setup' || target === 'activity') {
      document.querySelector<HTMLButtonElement>(`#tabs button[data-tab="${target}"]`)?.click();
    } else if (target === 'checks') {
      node<HTMLButtonElement>('runChecks')?.click();
    }
  });
  attention.append(copy, action);
  cockpit.append(attention);
  home.prepend(cockpit);
  return cockpit;
}

/**
 * Gives disclosure expansion its own presentation state instead of inheriting the legacy
 * one-open fixed-frame assumption in main.ts. Capture phase prevents the older target listener
 * from running; the application still owns every switch and every permission value.
 *
 * main.ts may repaint group classes after a state push, so the observer restores only the
 * requested disclosure classes. This Set never changes a checkbox or invokes settings IPC.
 */
function installIndependentDisclosures(groups: HTMLElement): void {
  const openGroups = new Set<string>();

  const sync = (): void => {
    for (const root of groups.querySelectorAll<HTMLElement>('.perm[data-group]')) {
      const id = root.dataset.group;
      if (!id) continue;
      root.classList.toggle('is-open', openGroups.has(id));
    }
  };

  groups.addEventListener(
    'click',
    (event) => {
      const target = event.target as HTMLElement | null;
      const button = target?.closest<HTMLButtonElement>('.perm-main');
      if (!button || !groups.contains(button)) return;
      const root = button.closest<HTMLElement>('.perm[data-group]');
      const id = root?.dataset.group;
      if (!root || !id) return;

      // Do not let the legacy target listener collapse a different group. This event changes
      // disclosure presentation only; the adjacent switch remains a separate native checkbox.
      event.preventDefault();
      event.stopPropagation();
      if (openGroups.has(id)) openGroups.delete(id);
      else openGroups.add(id);
      sync();
      if (openGroups.has(id)) root.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    },
    true
  );

  const observer = new window.MutationObserver(sync);
  observer.observe(groups, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['class']
  });
}

function publishedToolCount(): number | null {
  const facts = node('facts');
  if (!facts) return null;
  for (const row of facts.querySelectorAll<HTMLElement>('.fact')) {
    if (row.querySelector('span')?.textContent !== 'Tools ChatGPT can see') continue;
    const match = /^(\d+)\s+available/.exec(row.querySelector('code')?.textContent ?? '');
    return match ? Number(match[1]) : null;
  }
  return null;
}

function effectiveCapabilityCount(): number {
  return [...document.querySelectorAll<HTMLInputElement>('input[data-cap]')].filter(
    (input) => input.checked && !input.disabled
  ).length;
}

function projectNames(): string[] {
  return [...document.querySelectorAll<HTMLElement>('#rootList .root b')]
    .map((item) => item.textContent?.trim() ?? '')
    .filter(Boolean);
}

function setMetric(
  id: string,
  value: string,
  detail: string,
  tone: 'neutral' | 'good' | 'warn' = 'neutral'
): void {
  const item = document.querySelector<HTMLElement>(`#homeCockpit [data-metric="${id}"]`);
  if (!item) return;
  item.classList.toggle('is-good', tone === 'good');
  item.classList.toggle('is-warn', tone === 'warn');
  const valueNode = item.querySelector<HTMLElement>('.cockpit-value');
  const detailNode = item.querySelector<HTMLElement>('.cockpit-detail');
  if (valueNode) valueNode.textContent = value;
  if (detailNode) detailNode.textContent = detail;
}

function paintAttention(): void {
  const box = node('cockpitAttention');
  const action = node<HTMLButtonElement>('cockpitAttentionAction');
  const copy = box?.querySelector<HTMLElement>('.cockpit-attention-copy');
  if (!box || !action || !copy) return;

  let title = 'No action needed';
  let detail = 'No problems reported.';
  let label = '';
  let target = '';
  let warn = false;

  const setupBadge = node('setupBadge');
  const problems = node('homeProblems');
  const live = node('live');
  if (setupBadge && !setupBadge.hidden) {
    title = 'Setup needs attention';
    detail = 'Finish the next required setup step before connecting.';
    label = 'View setup';
    target = 'setup';
    warn = true;
  } else if (problems && !problems.hidden) {
    title = problems.textContent?.trim() || 'Activity needs attention';
    detail = 'Open the filtered activity log to inspect recent failures.';
    label = 'View problems';
    target = 'activity';
    warn = true;
  } else if (live?.classList.contains('is-error') || live?.classList.contains('is-offline')) {
    title = node('liveState')?.textContent?.trim() || 'Connection needs attention';
    detail = 'Run the local diagnostics before changing permissions.';
    label = 'Run checks';
    target = 'checks';
    warn = true;
  }

  box.classList.toggle('is-ok', !warn);
  box.classList.toggle('is-warn', warn);
  copy.replaceChildren(text('strong', '', title), text('span', '', detail));
  action.hidden = !target;
  action.textContent = label;
  action.dataset.action = target;
}

function paintCockpit(): void {
  if (!node('homeCockpit')) return;

  const live = node('live');
  const liveState = node('liveState')?.textContent?.trim() || 'Not connected';
  const liveNote = node('liveNote')?.textContent?.trim();
  const lastRequest = node('bigRequest')?.textContent?.trim();
  const connected = live?.classList.contains('is-connected') ?? false;
  const connectionDetail = connected
    ? [liveNote, lastRequest && lastRequest !== '—' ? `last call ${lastRequest}` : 'no ChatGPT call yet']
        .filter(Boolean)
        .join(' · ')
    : liveNote || 'Bridge is not currently verified.';
  setMetric(
    'connection',
    liveState,
    connectionDetail,
    connected ? 'good' : live?.classList.contains('is-error') || live?.classList.contains('is-offline') ? 'warn' : 'neutral'
  );

  const readOnly = node('readOnlyBtn')?.classList.contains('is-on') ?? false;
  setMetric(
    'safety',
    readOnly ? 'Read-only' : 'Custom access',
    readOnly
      ? 'Write and command permissions are masked by the safety lock.'
      : 'Only the granular permissions enabled below are enforced.',
    readOnly ? 'good' : 'neutral'
  );

  const tools = publishedToolCount();
  const capabilities = effectiveCapabilityCount();
  setMetric(
    'access',
    tools === null ? '—' : `${tools} tool${tools === 1 ? '' : 's'}`,
    `${capabilities} effective permission${capabilities === 1 ? '' : 's'} enabled`
  );

  const projects = projectNames();
  setMetric(
    'projects',
    `${projects.length} shared`,
    projects.length === 0 ? 'No filesystem roots are approved.' : projects.slice(0, 3).join(' · ')
  );

  const permissionStatus = node('permissionStatus');
  if (permissionStatus) {
    permissionStatus.textContent =
      `${capabilities} effective permission${capabilities === 1 ? '' : 's'} · ` +
      (tools === null ? 'tool surface starting' : `${tools} tool schema${tools === 1 ? '' : 's'} published`);
  }

  paintAttention();
}

function installProjectionObservers(): void {
  let scheduled = false;
  const schedule = (): void => {
    if (scheduled) return;
    scheduled = true;
    window.queueMicrotask(() => {
      scheduled = false;
      paintCockpit();
    });
  };

  const targets: Array<{ node: HTMLElement | null; options: MutationObserverInit }> = [
    { node: node('live'), options: { subtree: true, attributes: true, childList: true, characterData: true } },
    { node: node('readOnlyBtn'), options: { attributes: true, attributeFilter: ['class'] } },
    { node: node('groups'), options: { subtree: true, attributes: true, childList: true, characterData: true } },
    { node: node('rootList'), options: { subtree: true, childList: true, characterData: true } },
    { node: node('facts'), options: { subtree: true, childList: true, characterData: true } },
    { node: node('homeProblems'), options: { attributes: true, childList: true, characterData: true } },
    { node: node('setupBadge'), options: { attributes: true, attributeFilter: ['hidden'] } },
    { node: node('bigRequest'), options: { childList: true, characterData: true, subtree: true } }
  ];

  for (const target of targets) {
    if (!target.node) continue;
    new window.MutationObserver(schedule).observe(target.node, target.options);
  }
  node('groups')?.addEventListener('change', schedule);
  schedule();
}

function installPermissionStatus(): void {
  const groups = node('groups');
  const card = groups?.closest<HTMLElement>('.card');
  if (!groups || !card || node('permissionStatus')) return;
  card.classList.add('is-permissions');

  const status = text('div', 'permission-status');
  status.id = 'permissionStatusBox';
  const summary = text('strong', '', 'Waiting for permission state…');
  summary.id = 'permissionStatus';
  status.append(
    summary,
    text(
      'span',
      '',
      'Changes enforce immediately in local-cgpt. ChatGPT may keep an older tool schema until a new conversation.'
    )
  );
  card.insertBefore(status, groups);

  node('rootList')?.closest<HTMLElement>('.card')?.classList.add('is-folders');
  node('facts')?.closest<HTMLElement>('.card')?.classList.add('is-health');
}

export function initHomeCockpit(): void {
  if (initialized) return;
  initialized = true;
  installCockpit();
  installPermissionStatus();
  const groups = node('groups');
  if (groups) installIndependentDisclosures(groups);
  installProjectionObservers();
}

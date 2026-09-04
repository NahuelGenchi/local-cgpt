/**
 * Renderer-wide accessibility and compact-layout behavior.
 *
 * Kept separate from app state: this module observes the DOM contracts that `main.ts`
 * already owns and adds semantics around them. It never changes permissions, settings,
 * connector state, or which panel/group the application considers active.
 */

let initialized = false;

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * `main.ts` deliberately scrolls an expanded permission row into view. Honour the user's
 * motion preference even though that call explicitly requests smooth scrolling: CSS alone
 * cannot override an explicit ScrollIntoViewOptions.behavior value.
 */
function installMotionSafeScrolling(): void {
  const prototype = Element.prototype as Element & {
    scrollIntoView?: (arg?: boolean | ScrollIntoViewOptions) => void;
  };
  const original = prototype.scrollIntoView;
  if (typeof original !== 'function' || original.name === 'localCgptMotionSafeScrollIntoView') return;

  function localCgptMotionSafeScrollIntoView(
    this: Element,
    arg?: boolean | ScrollIntoViewOptions
  ): void {
    if (
      prefersReducedMotion() &&
      typeof arg === 'object' &&
      arg !== null &&
      arg.behavior === 'smooth'
    ) {
      original.call(this, { ...arg, behavior: 'auto' });
      return;
    }
    original.call(this, arg);
  }

  prototype.scrollIntoView = localCgptMotionSafeScrollIntoView;
}

function installTabs(): void {
  const tablist = document.getElementById('tabs');
  if (!tablist) return;

  tablist.setAttribute('role', 'tablist');
  tablist.setAttribute('aria-label', 'Application sections');
  tablist.setAttribute('aria-orientation', 'horizontal');

  const tabs = (): HTMLButtonElement[] =>
    [...tablist.querySelectorAll<HTMLButtonElement>('button[data-tab]')];

  const sync = (): void => {
    for (const tab of tabs()) {
      const name = tab.dataset.tab;
      if (!name) continue;
      const panel = document.querySelector<HTMLElement>(`.panel[data-panel="${name}"]`);
      if (!panel) continue;

      const tabId = `app-tab-${name}`;
      const panelId = `app-panel-${name}`;
      const selected = tab.classList.contains('is-sel') && panel.classList.contains('is-active');

      tab.id = tabId;
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-controls', panelId);
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;

      panel.id = panelId;
      panel.setAttribute('role', 'tabpanel');
      panel.setAttribute('aria-labelledby', tabId);
      panel.hidden = !selected;
    }
  };

  tablist.addEventListener('keydown', (event) => {
    if (!(event.target instanceof HTMLButtonElement) || !event.target.matches('button[data-tab]')) return;
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;

    const items = tabs();
    const current = items.indexOf(event.target);
    if (current < 0 || items.length === 0) return;

    let next = current;
    if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = items.length - 1;
    else if (event.key === 'ArrowRight') next = (current + 1) % items.length;
    else next = (current - 1 + items.length) % items.length;

    event.preventDefault();
    items[next]!.click();
    items[next]!.focus();
  });

  const observer = new MutationObserver(sync);
  for (const tab of tabs()) observer.observe(tab, { attributes: true, attributeFilter: ['class'] });
  for (const panel of document.querySelectorAll<HTMLElement>('.panel[data-panel]')) {
    observer.observe(panel, { attributes: true, attributeFilter: ['class'] });
  }

  sync();
}

function installPermissionDisclosures(): void {
  const groups = document.getElementById('groups');
  if (!groups) return;

  const sync = (): void => {
    for (const root of groups.querySelectorAll<HTMLElement>('.perm[data-group]')) {
      const name = root.dataset.group;
      const button = root.querySelector<HTMLButtonElement>('.perm-main');
      const details = root.querySelector<HTMLElement>('.tools');
      if (!name || !button || !details) continue;

      const buttonId = `permission-${name}-toggle`;
      const detailsId = `permission-${name}-details`;
      const expanded = root.classList.contains('is-open');

      button.id = buttonId;
      button.setAttribute('aria-controls', detailsId);
      button.setAttribute('aria-expanded', String(expanded));

      details.id = detailsId;
      details.setAttribute('role', 'group');
      details.setAttribute('aria-labelledby', buttonId);
      details.setAttribute('aria-hidden', String(!expanded));
    }
  };

  const observer = new MutationObserver(sync);
  observer.observe(groups, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['class']
  });
  sync();
}

export function initRendererFoundation(): void {
  if (initialized) return;
  initialized = true;
  installMotionSafeScrolling();
  installTabs();
  installPermissionDisclosures();
}

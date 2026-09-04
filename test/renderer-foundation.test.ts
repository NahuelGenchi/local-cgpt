import { readFileSync } from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

let dom: JSDOM;
let reducedMotion = false;
let nativeScroll: ReturnType<typeof vi.fn>;

const css = readFileSync(path.join(process.cwd(), 'src', 'renderer', 'foundation.css'), 'utf8');
const domSource = readFileSync(path.join(process.cwd(), 'src', 'renderer', 'dom.ts'), 'utf8');

async function settleMutations(): Promise<void> {
  await new Promise<void>((resolve) => dom.window.queueMicrotask(resolve));
}

beforeAll(async () => {
  dom = new JSDOM(
    `<!doctype html><html><body>
      <main>
        <section class="panel is-active" data-panel="home"></section>
        <section class="panel" data-panel="setup"></section>
        <section class="panel" data-panel="chat"></section>
        <section class="panel" data-panel="activity"></section>
      </main>
      <div id="groups">
        <div class="perm" data-group="read">
          <button class="perm-main" type="button">Look at files</button>
          <div class="tools"><span>read</span></div>
        </div>
      </div>
      <nav id="tabs">
        <button class="is-sel" data-tab="home" type="button">Home</button>
        <button data-tab="setup" type="button">Setup</button>
        <button data-tab="chat" type="button">Chat</button>
        <button data-tab="activity" type="button">Activity</button>
      </nav>
    </body></html>`,
    { url: 'https://local.test/' }
  );

  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    HTMLButtonElement: dom.window.HTMLButtonElement,
    MutationObserver: dom.window.MutationObserver,
    KeyboardEvent: dom.window.KeyboardEvent
  });

  Object.defineProperty(dom.window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({
      matches: query === '(prefers-reduced-motion: reduce)' && reducedMotion,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false
    })
  });

  nativeScroll = vi.fn();
  Object.defineProperty(dom.window.Element.prototype, 'scrollIntoView', {
    configurable: true,
    writable: true,
    value: nativeScroll
  });

  // Reproduce the application-owned class switch. The foundation must add semantics around
  // this state change, not become a second owner of which panel is active.
  document.getElementById('tabs')!.addEventListener('click', (event) => {
    const target = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-tab]');
    if (!target?.dataset.tab) return;
    for (const tab of document.querySelectorAll<HTMLButtonElement>('button[data-tab]')) {
      tab.classList.toggle('is-sel', tab === target);
    }
    for (const panel of document.querySelectorAll<HTMLElement>('.panel[data-panel]')) {
      panel.classList.toggle('is-active', panel.dataset.panel === target.dataset.tab);
    }
  });

  const { initRendererFoundation } = await import('../src/renderer/foundation.js');
  initRendererFoundation();
  await settleMutations();
});

afterAll(() => {
  dom.window.close();
});

describe('application tab semantics', () => {
  it('exposes one selected/focusable tab and hides inactive panels from assistive technology', () => {
    const tablist = document.getElementById('tabs')!;
    const home = document.querySelector<HTMLButtonElement>('[data-tab="home"]')!;
    const setup = document.querySelector<HTMLButtonElement>('[data-tab="setup"]')!;
    const homePanel = document.querySelector<HTMLElement>('[data-panel="home"]')!;
    const setupPanel = document.querySelector<HTMLElement>('[data-panel="setup"]')!;

    expect(tablist.getAttribute('role')).toBe('tablist');
    expect(tablist.getAttribute('aria-label')).toBe('Application sections');
    expect(home.getAttribute('role')).toBe('tab');
    expect(home.getAttribute('aria-selected')).toBe('true');
    expect(home.tabIndex).toBe(0);
    expect(setup.getAttribute('aria-selected')).toBe('false');
    expect(setup.tabIndex).toBe(-1);
    expect(home.getAttribute('aria-controls')).toBe(homePanel.id);
    expect(homePanel.getAttribute('role')).toBe('tabpanel');
    expect(homePanel.hidden).toBe(false);
    expect(setupPanel.hidden).toBe(true);
  });

  it('supports ArrowLeft/ArrowRight/Home/End roving keyboard navigation', async () => {
    const home = document.querySelector<HTMLButtonElement>('[data-tab="home"]')!;
    const setup = document.querySelector<HTMLButtonElement>('[data-tab="setup"]')!;
    const activity = document.querySelector<HTMLButtonElement>('[data-tab="activity"]')!;

    home.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    await settleMutations();
    expect(setup.getAttribute('aria-selected')).toBe('true');
    expect(setup.tabIndex).toBe(0);

    setup.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    await settleMutations();
    expect(activity.getAttribute('aria-selected')).toBe('true');

    activity.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    await settleMutations();
    expect(home.getAttribute('aria-selected')).toBe('true');

    home.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    await settleMutations();
    expect(activity.getAttribute('aria-selected')).toBe('true');
  });
});

describe('permission disclosures', () => {
  it('binds aria-expanded to the application-owned open class and a real controlled group', async () => {
    const root = document.querySelector<HTMLElement>('.perm[data-group="read"]')!;
    const button = root.querySelector<HTMLButtonElement>('.perm-main')!;
    const details = root.querySelector<HTMLElement>('.tools')!;

    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(button.getAttribute('aria-controls')).toBe(details.id);
    expect(details.getAttribute('aria-labelledby')).toBe(button.id);
    expect(details.getAttribute('aria-hidden')).toBe('true');

    root.classList.add('is-open');
    await settleMutations();
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(details.getAttribute('aria-hidden')).toBe('false');
  });
});

describe('reduced motion', () => {
  it('coerces explicit smooth scrollIntoView requests to auto when reduced motion is requested', () => {
    reducedMotion = true;
    nativeScroll.mockClear();
    document.querySelector('.perm')!.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    expect(nativeScroll).toHaveBeenCalledTimes(1);
    expect(nativeScroll.mock.calls[0]?.[0]).toMatchObject({ behavior: 'auto', block: 'nearest' });

    reducedMotion = false;
  });

  it('turns off repeating status animation and UI transitions in CSS', () => {
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css).toMatch(/\.live\.is-busy \.dot\s*\{[^}]*animation:\s*none/s);
    expect(css).toMatch(/\.perm-main \.chev[\s\S]*transition:\s*none/);
  });
});

describe('responsive and token contracts', () => {
  it('loads the corrective foundation after the base renderer module is imported', () => {
    expect(domSource).toContain("import './foundation.css';");
    expect(domSource).toContain("import { initRendererFoundation } from './foundation.js';");
    expect(domSource).toContain('initRendererFoundation();');
  });

  it('resolves the legacy rename tokens to the canonical card/ink design tokens', () => {
    expect(css).toContain('--panel: var(--card);');
    expect(css).toContain('--text: var(--ink);');
    expect(css).toMatch(/\.root-rename\s*\{[^}]*background:\s*var\(--card\)[^}]*color:\s*var\(--ink\)/s);
  });

  it('stacks dense surfaces at narrow effective widths instead of adding horizontal scrolling', () => {
    expect(css).toContain('@media (max-width: 900px)');
    expect(css).toContain('@media (max-width: 720px)');
    expect(css).toContain('@media (max-width: 520px)');
    expect(css).toMatch(/@media \(max-width: 720px\)[\s\S]*\.top\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/);
    expect(css).toMatch(/@media \(max-width: 720px\)[\s\S]*\[data-panel='chat'\]\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/);
    expect(css).not.toMatch(/overflow-x:\s*(auto|scroll)/);
  });

  it('switches the narrowest navigation to icon-only presentation without deleting its text names', () => {
    expect(css).toMatch(/@media \(max-width: 520px\)[\s\S]*nav button\s*\{[^}]*font-size:\s*0/);
    for (const label of ['Home', 'Setup', 'Chat', 'Activity']) {
      expect(document.getElementById('tabs')!.textContent).toContain(label);
    }
  });
});

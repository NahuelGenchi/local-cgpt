import { readFileSync } from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

let dom: JSDOM;
const css = readFileSync(path.join(process.cwd(), 'src', 'renderer', 'cockpit.css'), 'utf8');
const domSource = readFileSync(path.join(process.cwd(), 'src', 'renderer', 'dom.ts'), 'utf8');

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => dom.window.queueMicrotask(resolve));
  await new Promise<void>((resolve) => dom.window.queueMicrotask(resolve));
}

function permission(id: string, checked = false): string {
  return `<div class="perm${checked ? ' is-on' : ''}" data-group="${id}">
    <div class="perm-head">
      <button class="perm-main" type="button">${id}</button>
      <span class="sw"><input class="group-box" type="checkbox" /></span>
    </div>
    <div class="tools"><label class="tool"><input data-cap="${id}" type="checkbox" ${checked ? 'checked' : ''} /></label></div>
  </div>`;
}

beforeAll(async () => {
  dom = new JSDOM(
    `<!doctype html><html><body>
      <div class="app">
        <header>
          <span class="live" id="live"><span id="liveState">Not connected</span><em id="liveNote"></em></span>
        </header>
        <main>
          <section class="panel is-active" data-panel="home">
            <div class="top">
              <section class="card"><h2>Permissions<button id="readOnlyBtn" type="button">Read-only</button></h2><div class="scroll" id="groups">${permission('read', true)}${permission('write')}</div></section>
              <section class="card"><h2>Folders</h2><div id="rootList"></div></section>
              <section class="card"><h2>Health</h2><div id="facts"><div class="fact"><span>Tools ChatGPT can see</span><code>3 available · 0 folders</code></div><b id="bigRequest">—</b></div></section>
            </div>
            <section class="card"><span id="homeProblems" hidden></span></section>
          </section>
          <section class="panel" data-panel="setup"></section>
          <section class="panel" data-panel="activity"></section>
        </main>
        <span id="setupBadge" hidden></span>
        <button id="runChecks" type="button">Run checks</button>
        <nav id="tabs">
          <button data-tab="home" type="button">Home</button>
          <button data-tab="setup" type="button">Setup</button>
          <button data-tab="activity" type="button">Activity</button>
        </nav>
      </div>
    </body></html>`,
    { url: 'https://local.test/' }
  );

  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document
  });

  Object.defineProperty(dom.window.Element.prototype, 'scrollIntoView', {
    configurable: true,
    writable: true,
    value: vi.fn()
  });

  const { initHomeCockpit } = await import('../src/renderer/cockpit.js');
  initHomeCockpit();
  await settle();
});

afterAll(() => dom.window.close());

describe('Home control cockpit', () => {
  it('adds one compact access overview ahead of the existing Home controls', () => {
    const cockpit = document.getElementById('homeCockpit')!;
    const home = document.querySelector<HTMLElement>("[data-panel='home']")!;
    expect(home.firstElementChild).toBe(cockpit);
    expect(cockpit.getAttribute('aria-label')).toBe('Current access overview');
    expect(cockpit.querySelectorAll('.cockpit-metric')).toHaveLength(4);
    expect(cockpit.textContent).toContain('Connection');
    expect(cockpit.textContent).toContain('Safety');
    expect(cockpit.textContent).toContain('Tool surface');
    expect(cockpit.textContent).toContain('Projects');
  });

  it('distinguishes published tool schemas from effective permission settings', async () => {
    const readOnly = document.getElementById('readOnlyBtn')!;
    readOnly.classList.add('is-on');
    const read = document.querySelector<HTMLInputElement>('input[data-cap="read"]')!;
    read.checked = true;
    read.disabled = false;
    const write = document.querySelector<HTMLInputElement>('input[data-cap="write"]')!;
    write.checked = true;
    write.disabled = true;
    document.getElementById('groups')!.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await settle();

    const safety = document.querySelector<HTMLElement>('[data-metric="safety"]')!;
    const access = document.querySelector<HTMLElement>('[data-metric="access"]')!;
    expect(safety.querySelector('.cockpit-value')!.textContent).toBe('Read-only');
    expect(access.querySelector('.cockpit-value')!.textContent).toBe('3 tools');
    expect(access.querySelector('.cockpit-detail')!.textContent).toBe('1 effective permission enabled');
    expect(document.getElementById('permissionStatus')!.textContent).toContain('1 effective permission');
    expect(document.getElementById('permissionStatusBox')!.textContent).toContain('older tool schema');
  });

  it('summarizes approved project aliases without exposing a new path source', async () => {
    const roots = document.getElementById('rootList')!;
    roots.innerHTML = '<div class="root"><b>/project</b></div><div class="root"><b>/docs</b></div>';
    await settle();
    const projects = document.querySelector<HTMLElement>('[data-metric="projects"]')!;
    expect(projects.querySelector('.cockpit-value')!.textContent).toBe('2 shared');
    expect(projects.querySelector('.cockpit-detail')!.textContent).toBe('/project · /docs');
  });

  it('routes attention to setup before lower-priority activity problems', async () => {
    const setupBadge = document.getElementById('setupBadge')!;
    const problems = document.getElementById('homeProblems')!;
    setupBadge.hidden = false;
    problems.hidden = false;
    problems.textContent = '2 problems';
    await settle();

    const attention = document.getElementById('cockpitAttention')!;
    const action = document.getElementById('cockpitAttentionAction') as HTMLButtonElement;
    expect(attention.classList.contains('is-warn')).toBe(true);
    expect(attention.textContent).toContain('Setup needs attention');
    expect(action.textContent).toBe('View setup');
    expect(action.dataset.action).toBe('setup');
  });
});

describe('permission disclosure presentation', () => {
  it('allows multiple permission groups to stay expanded without toggling their switches', async () => {
    const groups = document.getElementById('groups')!;
    const rows = [...groups.querySelectorAll<HTMLElement>('.perm[data-group]')];
    const legacyListener = vi.fn();
    for (const row of rows) row.querySelector('.perm-main')!.addEventListener('click', legacyListener);

    const before = rows.map((row) => row.querySelector<HTMLInputElement>('.group-box')!.checked);
    (rows[0]!.querySelector('.perm-main') as HTMLButtonElement).click();
    (rows[1]!.querySelector('.perm-main') as HTMLButtonElement).click();
    await settle();

    expect(rows[0]!.classList.contains('is-open')).toBe(true);
    expect(rows[1]!.classList.contains('is-open')).toBe(true);
    expect(rows.map((row) => row.querySelector<HTMLInputElement>('.group-box')!.checked)).toEqual(before);
    expect(legacyListener).not.toHaveBeenCalled();
  });

  it('restores requested disclosure state after an application repaint removes classes', async () => {
    const read = document.querySelector<HTMLElement>('.perm[data-group="read"]')!;
    read.classList.remove('is-open');
    await settle();
    expect(read.classList.contains('is-open')).toBe(true);
  });
});

describe('cockpit layout contract', () => {
  it('loads after the general renderer foundation so cockpit composition wins intentionally', () => {
    expect(domSource.indexOf("import './cockpit.css';")).toBeGreaterThan(domSource.indexOf("import './foundation.css';"));
    expect(domSource).toContain("import { initHomeCockpit } from './cockpit.js';");
    expect(domSource).toContain('initHomeCockpit();');
  });

  it('makes permissions primary and supporting cards secondary at wide widths', () => {
    expect(css).toMatch(/\.top\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1\.55fr\)\s+minmax\(280px, 0\.8fr\)/s);
    expect(css).toMatch(/\.top > \.card\.is-permissions\s*\{[^}]*grid-row:\s*1 \/ 3/s);
    expect(css).toContain('grid-template-rows: auto auto minmax(0, 1fr)');
  });

  it('keeps deterministic 900/720/520px responsive tiers and never adds horizontal scrolling', () => {
    expect(css).toContain('@media (max-width: 900px)');
    expect(css).toContain('@media (max-width: 720px)');
    expect(css).toContain('@media (max-width: 520px)');
    expect(css).not.toMatch(/overflow-x:\s*(auto|scroll)/);
    expect(css).toMatch(/@media \(max-width: 720px\)[\s\S]*\.top\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/);
    expect(css).toMatch(/@media \(max-width: 520px\)[\s\S]*\.home-cockpit\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/);
  });
});

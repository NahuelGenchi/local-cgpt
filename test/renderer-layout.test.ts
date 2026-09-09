/**
 * Structural layout contracts, not pixel measurements: jsdom cannot prove physical fit.
 * Preserve the failures these assertions name: shrinking header actions, wrong card grid
 * tracks, shared permission/timeline selectors, inaccessible settings and duplicate ids.
 * Settings listeners moved to chat-settings.ts; inspect the actual owning module rather
 * than requiring every unrelated state machine to remain in chat.ts.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { beforeAll, describe, expect, it } from 'vitest';

let document: Document;
let css = '';
let chatSource = '';
let settingsSource = '';
beforeAll(async () => {
  const [html, styles, chat, settings] = await Promise.all([
    fs.readFile(path.join(process.cwd(), 'src/renderer/index.html'), 'utf8'),
    fs.readFile(path.join(process.cwd(), 'src/renderer/styles.css'), 'utf8'),
    fs.readFile(path.join(process.cwd(), 'src/renderer/chat.ts'), 'utf8'),
    fs.readFile(path.join(process.cwd(), 'src/renderer/chat-settings.ts'), 'utf8')
  ]);
  document = new JSDOM(html).window.document;
  css = styles;
  chatSource = chat;
  settingsSource = settings;
});
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  return match ? match[1]!.replace(/\s+/g, ' ').trim() : '';
}

describe('the session card header', () => {
  it('carries the gear and no action that starts a compaction', () => {
    // Compaction starts in the owning ChatGPT conversation, never from a second desktop action.
    const acts = document.querySelector('#chatTitle')!.closest('h2')!.querySelector('.acts')!;
    expect(acts.contains(document.getElementById('chatSettingsBtn'))).toBe(true);
    for (const id of ['resumeBtn', 'compactBtn', 'cancelCompact']) expect(document.getElementById(id)).toBeNull();
    expect(acts.querySelectorAll('.btn.is-primary')).toHaveLength(0);
  });
  it('reaches settings from the gear rather than from the view switcher', () => {
    expect(Array.from(document.querySelectorAll<HTMLElement>('#chatView [data-view]')).map((node) => node.dataset.view)).toEqual(['timeline', 'compact']);
    expect(document.querySelector('#chatBody > .view[data-view="settings"]')).not.toBeNull();
  });
  it('moves the view switcher out of the header row', () => {
    const head = document.querySelector('#chatTitle')!.closest('h2')!;
    const view = document.getElementById('chatView')!;
    expect(head.contains(view)).toBe(false);
    expect(view.closest('.subhead')?.previousElementSibling).toBe(head);
  });
  it('lets the title shrink and never the actions', () => {
    expect(rule('.acts')).toContain('flex: none');
    expect(rule('.card > h2 > span:first-child')).toContain('min-width: 0');
    expect(rule('.card > h2 > span:first-child')).toContain('text-overflow: ellipsis');
    expect(document.querySelector('#chatTitle')!.closest('h2')!.firstElementChild!.id).toBe('chatTitle');
  });
  it('has a place to say what is happening without opening the Activity log', () => {
    expect(document.getElementById('chatState')!.closest('.subhead')).not.toBeNull();
    expect(rule('.subhead-note')).toContain('text-overflow: ellipsis');
  });
});

describe('a session row', () => {
  it('keeps its chips whole and lets the counts truncate', () => {
    expect(rule('.sess-sub')).toContain('display: flex');
    expect(rule('.sess-sub .chip')).toContain('flex: none');
    expect(rule('.sess-bits')).toContain('min-width: 0');
    expect(rule('.sess-bits')).toContain('text-overflow: ellipsis');
  });
  it('never borrows live worker status from a different run that reused worker-1/worker-2', () => {
    // BOTH identities remain mandatory. An origin property access is not required to use
    // the old local variable spelling; weakening the conversation comparison still fails.
    expect(chatSource).toMatch(/entry\.id === summary\.origin!\.agentId[\s\S]{0,220}entry\.conversationId === summary\.conversationId/);
  });
});

describe('the session-row delete affordance', () => {
  it('reserves its top-right hit target instead of laying the timestamp underneath it', () => {
    // The base stylesheet remains safe for non-enhanced rows. The new native-button grid
    // overrides this positioning inside #sessionList and is tested in the viewer suite.
    expect(rule('.sess-del')).toContain('position: absolute');
    expect(rule('.sess-top em')).toContain('margin-right: 30px');
  });
});

describe('the chat panel cards', () => {
  function tracks(selector: string): string[] {
    const match = /grid-template-rows:([^;]*)/.exec(rule(selector));
    expect(match, `${selector} declares no grid-template-rows`).not.toBeNull();
    return match![1]!.trim().replace(/minmax\([^)]*\)/g, 'minmax').split(/\s+/);
  }
  it('gives the sessions card one row per child', () => {
    const card = document.getElementById('sessionList')!.closest('.card')!;
    expect(card.classList.contains('is-session')).toBe(false);
    expect(tracks("[data-panel='chat'] .card")).toHaveLength(card.children.length);
  });
  it('gives the session card one row per child, including its navigation row', () => {
    const card = document.getElementById('chatTitle')!.closest('.card')!;
    expect(card.children).toHaveLength(4);
    expect(card.classList.contains('is-session')).toBe(true);
    expect(tracks("[data-panel='chat'] .card.is-session")).toHaveLength(card.children.length);
  });
  it('gives the flexible track to the body, not to the navigation row', () => {
    const card = document.getElementById('chatTitle')!.closest('.card')!;
    const index = Array.from(card.children).indexOf(document.getElementById('chatBody')!);
    expect(index).toBeGreaterThan(-1);
    const rows = tracks("[data-panel='chat'] .card.is-session");
    expect(rows[index]).toBe('minmax');
    expect(rows.filter((row) => row === 'minmax')).toHaveLength(1);
  });
});

describe('an expanded tool call', () => {
  it('opens underneath its row rather than beside it', () => {
    expect(rule('.tool')).toContain('display: block');
  });
  it('does not share a selector with the permission checkboxes', () => {
    expect(css).toMatch(/\n\.tools \.tool \{[^}]*display: grid/);
    expect(rule('.tool')).toContain('display: block');
  });
});

describe('the settings sheet', () => {
  it('gives the number field a width the shared input rule cannot beat', () => {
    expect(rule('input.num')).toContain('width: 92px');
    expect(rule('.num')).toBe('');
    expect(css.indexOf('input.num {')).toBeGreaterThan(css.indexOf("input[type='number'],"));
  });
  it('caps the settings column instead of letting the widest row size it', () => {
    expect(rule('.pane')).toContain('display: grid');
    expect(rule('.pane')).toContain('grid-template-columns: minmax(0, 1fr)');
  });
  it('keeps a settings row dropdown at its own width', () => {
    expect(rule('.setting select')).toContain('width: auto');
    expect(rule('.setting select')).toContain('flex: 0 0 auto');
    expect(css.indexOf('.setting select {')).toBeGreaterThan(css.indexOf("input[type='number'],"));
  });
  it('never shrinks the button in a settings row', () => {
    expect(rule('.setting .btn')).toContain('flex: 0 0 auto');
    expect(rule('.setting-text em')).toContain('text-overflow: ellipsis');
  });
  it('is settings rows and nothing else to read', () => {
    const pane = document.querySelector('.view[data-view="settings"] .pane')!;
    expect(pane.querySelectorAll('h3')).toHaveLength(0);
    for (const row of pane.querySelectorAll('.setting')) expect(row.querySelectorAll('.setting-text em')).toHaveLength(1);
    for (const hint of pane.querySelectorAll('p.hint')) expect(hint.closest('.field')).not.toBeNull();
  });
  it('puts the goal key above the model picker', () => {
    const order = Array.from(document.querySelectorAll('.view[data-view="settings"] .pane [id^="goal"]')).map((node) => node.id);
    expect(order.indexOf('goalEnabled')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('goalKey')).toBeLessThan(order.indexOf('goalPick'));
    expect(order.indexOf('goalPick')).toBeLessThan(order.indexOf('goalReasoning'));
    expect(order.indexOf('goalReasoning')).toBeLessThan(order.indexOf('goalPromptEdit'));
    expect(document.getElementById('goalModels')!.hasAttribute('hidden')).toBe(true);
    expect(document.getElementById('goalPromptPanel')!.hasAttribute('hidden')).toBe(true);
    expect(document.getElementById('goalPrompt')!.tagName).toBe('TEXTAREA');
  });
  it('saves every field it shows through the extracted settings owner', () => {
    const pane = document.querySelector('.view[data-view="settings"] .pane')!;
    const listened = /for \(const id of \[([^\]]*)\]\)/.exec(settingsSource);
    expect(listened, 'settings change-listener list is missing').not.toBeNull();
    expect(settingsSource).toContain("$(id).addEventListener('change', () => void save())");
    for (const field of pane.querySelectorAll<HTMLInputElement>('input, select, textarea')) {
      if (field.type === 'password') {
        // Credentials still save on blur through their dedicated IPC, never a settings snapshot.
        expect(settingsSource).toContain(`$('${field.id}').addEventListener('blur'`);
      } else expect(listened![1], `${field.id} never saves`).toContain(`'${field.id}'`);
    }
  });
});

describe('the session timeline', () => {
  it('renders every event kind the recorder can write', async () => {
    const shared = await fs.readFile(path.join(process.cwd(), 'src/shared/session.ts'), 'utf8');
    const union = shared.slice(shared.indexOf('export type SessionEvent ='), shared.indexOf('export type SessionEventKind'));
    const declared = [...new Set([...union.matchAll(/\bkind: '([a-z_]+)'/g)].map((match) => match[1]!))];
    expect(declared.length).toBeGreaterThan(5);
    const body = chatSource.slice(chatSource.indexOf('function eventBody'));
    const handled = new Set([...body.slice(0, body.indexOf('\n}')).matchAll(/case '([a-z_]+)':/g)].map((match) => match[1]!));
    expect(declared.filter((kind) => !handled.has(kind))).toEqual([]);
  });
});

describe('the window as a whole', () => {
  it('keeps the Home activity strip shorter than the three setup/status cards', () => {
    expect(rule("[data-panel='home']")).toContain('grid-template-rows: 300px minmax(0, 1fr)');
  });
  it('has no duplicate element ids', () => {
    const seen = new Set<string>();
    for (const node of document.querySelectorAll('[id]')) {
      expect(seen.has(node.id), `duplicate ${node.id}`).toBe(false);
      seen.add(node.id);
    }
  });
  it('never scrolls sideways', () => {
    // Local code/table scrolling is separately scoped; the app frame must not scroll sideways.
    expect(css).not.toMatch(/overflow-x:\s*(auto|scroll)/);
    expect(css).not.toMatch(/overflow:\s*(auto|scroll)\s+/);
    expect(rule('.scroll')).toContain('overflow: hidden auto');
  });
  it('keeps setup and settings vertically reachable when the window is short', () => {
    expect(rule("[data-panel='setup'].is-active")).toContain('overflow: hidden auto');
    expect(document.querySelector('.view[data-view="settings"]')!.closest('#chatBody.scroll')).not.toBeNull();
    expect(rule('.scroll')).toContain('overflow: hidden auto');
  });
});

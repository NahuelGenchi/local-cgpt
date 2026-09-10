import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { reconcileRows, preserveViewport, type KeyedRow } from '../src/renderer/keyed-view.js';

let dom: JSDOM;
let root: HTMLElement;
let builds: number;
beforeEach(() => {
  dom = new JSDOM('<!doctype html><body><section><div id="rows"></div></section></body>', { pretendToBeVisual: true });
  root = dom.window.document.getElementById('rows')!;
  builds = 0;
});
afterEach(() => dom.window.close());
function row(key: string, revision = 'one'): KeyedRow {
  return { key, revision, create: () => {
    builds++;
    const node = dom.window.document.createElement('div');
    const button = dom.window.document.createElement('button');
    button.dataset.focusKey = 'action';
    button.textContent = `${key} ${revision}`;
    node.append(button);
    return node;
  } };
}

describe('keyed rendering', () => {
  it('does no DOM reconstruction for a stable 160-row refresh', () => {
    const rows = Array.from({ length: 160 }, (_, index) => row(String(index)));
    reconcileRows(root, rows);
    const originals = Array.from(root.children);
    const result = reconcileRows(root, rows);
    expect(result).toEqual({ created: 0, replaced: 0, reused: 160, moved: 0, removed: 0 });
    expect(builds).toBe(160);
    expect(Array.from(root.children)).toEqual(originals);
    // A full-list rebuild creates 160 additional rows for the same fixture; report actual
    // construction counts, not an unmeasured wall-clock speed-up.
    rows.forEach((entry) => entry.create());
    expect(builds).toBe(320);
  });

  it('appends one row without replacing or defocusing an existing row', () => {
    reconcileRows(root, [row('a'), row('b')]);
    const first = root.firstElementChild;
    const button = root.querySelector('button')!;
    button.focus();
    expect(reconcileRows(root, [row('a'), row('b'), row('c')]).created).toBe(1);
    expect(root.firstElementChild).toBe(first);
    expect(dom.window.document.activeElement).toBe(button);
  });

  it('keeps a text selection through replacement of its one changed row', () => {
    reconcileRows(root, [row('a')]);
    const text = root.querySelector('button')!.firstChild!;
    dom.window.getSelection()!.setBaseAndExtent(text, 0, text, 1);
    const result = reconcileRows(root, [row('a', 'two')]);
    expect(result.replaced).toBe(1);
    expect(dom.window.getSelection()!.toString()).toBe('a');
  });

  it('restores the same control after a row revision and after reordering', () => {
    reconcileRows(root, [row('a'), row('b')]);
    root.querySelector('button')!.focus();
    reconcileRows(root, [row('b'), row('a', 'two')]);
    expect(root.lastElementChild?.querySelector('button')).toBe(dom.window.document.activeElement);
    expect(dom.window.document.activeElement?.textContent).toBe('a two');
  });

  it('moves focus to a surviving neighbor when its row is removed', () => {
    reconcileRows(root, [row('a'), row('b')]);
    root.querySelector('button')!.focus();
    reconcileRows(root, [row('b')]);
    expect(dom.window.document.activeElement).toBe(root.querySelector('button'));
    expect(root.children).toHaveLength(1);
  });

  it('rejects duplicate identity before changing the existing view', () => {
    reconcileRows(root, [row('a')]);
    const original = root.firstChild;
    expect(() => reconcileRows(root, [row('a'), row('a')])).toThrow('Duplicate');
    expect(root.firstChild).toBe(original);
  });

  it('preserves a visible row offset when rows above it change height', () => {
    const pane = root.parentElement!;
    reconcileRows(root, [row('a')]);
    let top = 110;
    Object.defineProperty(pane, 'getBoundingClientRect', { value: () => ({ top: 100 }) });
    Object.defineProperty(root.firstElementChild, 'getBoundingClientRect', { value: () => ({ top, bottom: top + 30 }) });
    pane.scrollTop = 40;
    preserveViewport(pane, root, false, () => { top = 170; });
    expect(pane.scrollTop).toBe(100);
    Object.defineProperty(pane, 'scrollHeight', { value: 500 });
    preserveViewport(pane, root, true, () => {});
    expect(pane.scrollTop).toBe(500);
  });
});

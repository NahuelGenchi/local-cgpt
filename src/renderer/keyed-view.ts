/**
 * Keyed presentation only. No IPC, state persistence or authority decisions.
 * Unchanged rows are not rebuilt or detached. Changed records replace only their own
 * row, with focus/selection restored by durable row identity rather than DOM position.
 * Callers must bound both their data window and each row's payload before rendering.
 */
export interface KeyedRow {
  key: string;
  revision: string;
  create: () => HTMLElement;
}

interface RetainedRow {
  revision: string;
  node: HTMLElement;
}
const retained = new WeakMap<HTMLElement, Map<string, RetainedRow>>();

function rowContaining(root: HTMLElement, node: Node | null): HTMLElement | null {
  if (!node || node === root || !root.contains(node)) return null;
  let current: Node = node;
  while (current.parentNode && current.parentNode !== root) current = current.parentNode;
  return current.nodeType === 1 ? current as HTMLElement : null;
}

function textOffset(root: Node, node: Node, offset: number): number {
  const range = root.ownerDocument!.createRange();
  range.selectNodeContents(root);
  range.setEnd(node, offset);
  return range.toString().length;
}

function textPoint(root: HTMLElement, offset: number): [Node, number] {
  const walker = root.ownerDocument.createTreeWalker(root, 4 /* SHOW_TEXT */);
  let node: Node | null;
  let last: Node = root;
  while ((node = walker.nextNode())) {
    const length = node.textContent?.length ?? 0;
    if (offset <= length) return [node, offset];
    offset -= length;
    last = node;
  }
  return last === root ? [root, 0] : [last, last.textContent?.length ?? 0];
}

/** Move an existing row without dropping focus on browsers lacking moveBefore(). */
function place(root: HTMLElement, node: HTMLElement, before: Element | null): void {
  const move = (root as HTMLElement & {
    moveBefore?: (node: Node, child: Node | null) => void;
  }).moveBefore;
  if (node.parentNode === root && typeof move === 'function') move.call(root, node, before);
  else root.insertBefore(node, before);
}

export interface ReconcileStats {
  created: number;
  replaced: number;
  reused: number;
  moved: number;
  removed: number;
}

export function reconcileRows(root: HTMLElement, input: readonly KeyedRow[]): ReconcileStats {
  const keys = new Set(input.map((row) => row.key));
  if (keys.size !== input.length) throw new Error('Duplicate presentation row identity');
  const previous = retained.get(root) ?? new Map<string, RetainedRow>();
  const document = root.ownerDocument;
  const focused = document.activeElement as HTMLElement | null;
  const focusRow = rowContaining(root, focused);
  const focusKey = focusRow?.dataset.rowKey;
  const focusIndex = focusRow ? Array.from(root.children).indexOf(focusRow) : -1;
  const controlKey = focused?.dataset.focusKey;
  const selection = document.getSelection();
  const anchorRow = rowContaining(root, selection?.anchorNode ?? null);
  const focusTextRow = rowContaining(root, selection?.focusNode ?? null);
  const selected = selection && !selection.isCollapsed && anchorRow && focusTextRow
    ? {
        anchorKey: anchorRow.dataset.rowKey!,
        focusKey: focusTextRow.dataset.rowKey!,
        anchorOffset: textOffset(anchorRow, selection.anchorNode!, selection.anchorOffset),
        focusOffset: textOffset(focusTextRow, selection.focusNode!, selection.focusOffset),
        anchorNode: selection.anchorNode,
        focusNode: selection.focusNode
      }
    : null;
  const next = new Map<string, RetainedRow>();
  const stats: ReconcileStats = { created: 0, replaced: 0, reused: 0, moved: 0, removed: 0 };
  let cursor = root.firstElementChild;

  for (const item of input) {
    const old = previous.get(item.key);
    let entry = old;
    if (!old || old.revision !== item.revision) {
      const node = item.create();
      node.dataset.rowKey = item.key;
      entry = { node, revision: item.revision };
      if (old) {
        if (cursor === old.node) cursor = node;
        old.node.replaceWith(node);
        stats.replaced++;
      } else stats.created++;
    } else stats.reused++;
    const node = entry!.node;
    if (node !== cursor) {
      place(root, node, cursor);
      stats.moved++;
    }
    cursor = node.nextElementSibling;
    next.set(item.key, entry!);
  }
  for (const [key, row] of previous) {
    if (!keys.has(key)) {
      row.node.remove();
      stats.removed++;
    }
  }
  // The container belongs to this reconciler, including on its first render.
  for (const child of Array.from(root.children)) {
    if (!next.has((child as HTMLElement).dataset.rowKey ?? '')) child.remove();
  }
  retained.set(root, next);

  if (focusKey !== undefined && focused && document.activeElement !== focused) {
    const row = next.get(focusKey)?.node ?? root.children[Math.min(focusIndex, root.children.length - 1)] as HTMLElement | undefined;
    const controls = row ? Array.from(row.querySelectorAll<HTMLElement>('[data-focus-key]')) : [];
    const target = controls.find((node) => node.dataset.focusKey === controlKey) ?? controls[0] ?? row;
    target?.focus({ preventScroll: true });
  }
  if (selected && selection &&
      (selection.anchorNode !== selected.anchorNode || selection.focusNode !== selected.focusNode ||
       !selected.anchorNode?.isConnected || !selected.focusNode?.isConnected)) {
    const anchor = next.get(selected.anchorKey)?.node;
    const focus = next.get(selected.focusKey)?.node;
    if (anchor && focus) {
      const [a, ao] = textPoint(anchor, selected.anchorOffset);
      const [f, fo] = textPoint(focus, selected.focusOffset);
      selection.setBaseAndExtent(a, ao, f, fo);
    }
  }
  return stats;
}

/** Preserve the first visible durable row, not a scrollTop that changes meaning. */
export function preserveViewport(pane: HTMLElement, rows: HTMLElement, follow: boolean, render: () => void): void {
  const top = pane.getBoundingClientRect().top;
  const was = pane.scrollTop;
  const candidates = Array.from(rows.children) as HTMLElement[];
  const anchor = candidates.find((node) => node.getBoundingClientRect().bottom > top);
  const key = anchor?.dataset.rowKey;
  const offset = anchor ? anchor.getBoundingClientRect().top - top : 0;
  render();
  if (follow) pane.scrollTop = pane.scrollHeight;
  else {
    const replacement = Array.from(rows.children).find((node) => (node as HTMLElement).dataset.rowKey === key);
    pane.scrollTop = replacement
      ? pane.scrollTop + replacement.getBoundingClientRect().top - top - offset
      : was;
  }
}

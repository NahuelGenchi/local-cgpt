/** Captured HTML is untrusted. App-owned controls are added only after sanitization. */
export const MAX_RENDERED_HTML_CHARS = 256 * 1024;
const MAX_HIGHLIGHT_CHARS = 64 * 1024;
const MAX_HIGHLIGHT_TOKENS = 12_000;
const RENDERED_TAGS = new Set([
  'A', 'BLOCKQUOTE', 'BR', 'CODE', 'DEL', 'DIV', 'EM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'HR', 'KBD', 'LI', 'MARK', 'OL', 'P', 'PRE', 'S', 'SPAN', 'STRONG', 'SUB', 'SUP', 'TABLE',
  'TBODY', 'TD', 'TFOOT', 'TH', 'THEAD', 'TR', 'UL'
]);
const DROP_RENDERED_TAGS = new Set([
  'SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'SVG', 'MATH', 'FORM', 'INPUT', 'BUTTON',
  'TEXTAREA', 'SELECT', 'OPTION', 'META', 'LINK'
]);

export function safeRenderedHref(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.startsWith('#')) return trimmed;
  try {
    const url = new URL(trimmed);
    return ['https:', 'http:', 'mailto:'].includes(url.protocol) ? trimmed : null;
  } catch { return null; }
}

/** Same tag/attribute/URL policy as the original viewer, with bounded iterative traversal. */
export function renderedMessage(html: string, fallback: string): HTMLElement {
  const box = document.createElement('div');
  box.className = 'msg rich';
  const safeFallback = fallback.slice(0, MAX_RENDERED_HTML_CHARS);
  if (!html) {
    box.textContent = safeFallback;
    return box;
  }
  const template = document.createElement('template');
  template.innerHTML = html.slice(0, MAX_RENDERED_HTML_CHARS);
  const pending: Array<{ node: Element; depth: number }> = Array.from(template.content.children)
    .map((node) => ({ node, depth: 0 }));
  let visited = 0;
  while (pending.length) {
    const { node, depth } = pending.pop()!;
    if (++visited > 20_000 || depth > 128) {
      box.textContent = safeFallback;
      return box;
    }
    const tag = node.tagName.toUpperCase();
    if (node.namespaceURI !== 'http://www.w3.org/1999/xhtml' || DROP_RENDERED_TAGS.has(tag)) {
      node.remove();
      continue;
    }
    const children = Array.from(node.children);
    const href = tag === 'A' ? safeRenderedHref(node.getAttribute('href') ?? '') : null;
    const title = node.getAttribute('title');
    const start = tag === 'OL' ? node.getAttribute('start') : null;
    const colspan = tag === 'TD' || tag === 'TH' ? node.getAttribute('colspan') : null;
    const rowspan = tag === 'TD' || tag === 'TH' ? node.getAttribute('rowspan') : null;
    for (const attribute of Array.from(node.attributes)) node.removeAttribute(attribute.name);
    if (!RENDERED_TAGS.has(tag)) node.replaceWith(...Array.from(node.childNodes));
    else {
      if (href) {
        node.setAttribute('href', href);
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noreferrer noopener');
      }
      if (title) node.setAttribute('title', title.slice(0, 500));
      if (start && /^\d{1,6}$/.test(start)) node.setAttribute('start', start);
      if (colspan && /^\d{1,3}$/.test(colspan)) node.setAttribute('colspan', colspan);
      if (rowspan && /^\d{1,3}$/.test(rowspan)) node.setAttribute('rowspan', rowspan);
    }
    for (const child of children) pending.push({ node: child, depth: depth + 1 });
  }
  box.append(template.content);
  if (!box.textContent?.trim() && safeFallback) box.textContent = safeFallback;
  return box;
}

export type CodeLanguage = 'plain' | 'json' | 'javascript' | 'typescript' | 'python' | 'bash' | 'css';
const LANGUAGES: readonly CodeLanguage[] = ['plain', 'json', 'javascript', 'typescript', 'python', 'bash', 'css'];
export function inferLanguage(text: string): CodeLanguage {
  const sample = text.slice(0, 2048).trim();
  if (/^[{[]/.test(sample) && /"[^"\n]+"\s*:/.test(sample)) return 'json';
  if (/^#!.*\b(?:ba|z|k)?sh\b/.test(sample) || /^(?:\$ |sudo |cd |npm |cargo |git )/m.test(sample)) return 'bash';
  if (/^(?:def |from \w+ import |import \w+\s*$|class \w+.*:)/m.test(sample)) return 'python';
  if (/\b(?:interface|type)\s+\w+|:\s*(?:string|number|boolean)\b/.test(sample)) return 'typescript';
  if (/\b(?:const|let|function|export|async)\b/.test(sample)) return 'javascript';
  if (/^[.#][\w-]+[^\n]*\{/.test(sample)) return 'css';
  return 'plain';
}

/** Token text is never interpreted as markup, including unknown/oversized code. */
export function highlightCode(node: HTMLElement, text: string, language: CodeLanguage): void {
  if (language === 'plain' || !LANGUAGES.includes(language) || text.length > MAX_HIGHLIGHT_CHARS) {
    node.textContent = text;
    return;
  }
  const tokens = /\/\*[^]*?\*\/|\/\/[^\n]*|#[^\n]*|"(?:\\[^]|[^"\\])*"|'(?:\\[^]|[^'\\])*'|`(?:\\[^]|[^`\\])*`|\b\d+(?:\.\d+)?\b|\b[A-Za-z_$][\w$]*\b/g;
  const keywords = new Set('const let var function return if else for while class interface type import export from async await new true false null undefined def in not and or None True False try catch finally throw raise with as pass break continue switch case default'.split(' '));
  const fragment = document.createDocumentFragment();
  let cursor = 0;
  let count = 0;
  for (const match of text.matchAll(tokens)) {
    if (++count > MAX_HIGHLIGHT_TOKENS) break;
    const at = match.index!;
    const value = match[0];
    if (at > cursor) fragment.append(document.createTextNode(text.slice(cursor, at)));
    const kind = /^[/#]/.test(value) ? 'comment' : /^["'`]/.test(value) ? 'string' : /^\d/.test(value) ? 'number' : keywords.has(value) ? 'keyword' : '';
    if (kind) {
      const span = document.createElement('span');
      span.className = `syntax-${kind}`;
      span.textContent = value;
      fragment.append(span);
    } else fragment.append(document.createTextNode(value));
    cursor = at + value.length;
  }
  fragment.append(document.createTextNode(text.slice(cursor)));
  node.replaceChildren(fragment);
}

export function addCodeControls(
  root: HTMLElement,
  options: { wrap: boolean; copy: (text: string) => Promise<boolean>; truncated?: boolean }
): void {
  // Nested PRE nodes are invalid captured markup; only enhance the outer block.
  const blocks = Array.from(root.querySelectorAll<HTMLElement>('pre')).filter((pre) => !pre.parentElement?.closest('pre'));
  for (const [index, pre] of blocks.slice(0, 160).entries()) {
    const text = pre.textContent ?? '';
    const code = document.createElement('code');
    const language = inferLanguage(text);
    highlightCode(code, text, language);
    pre.replaceChildren(code);
    pre.classList.toggle('code-wrap', options.wrap);
    const controls = document.createElement('div');
    controls.className = 'code-controls';
    const label = document.createElement('span');
    label.textContent = language === 'plain' ? 'Plain text' : `${language} (inferred)`;
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'btn';
    copy.dataset.focusKey = `copy-code-${index}`;
    copy.textContent = options.truncated ? 'Copy retained code' : 'Copy code';
    copy.addEventListener('click', () => {
      // Retain raw text in this closure: labels and highlighting never enter the clipboard.
      void options.copy(text).then((ok) => {
        copy.textContent = ok ? 'Copied' : 'Copy failed';
      }).catch(() => { copy.textContent = 'Copy failed'; });
    });
    const wrap = document.createElement('button');
    wrap.type = 'button';
    wrap.className = 'btn';
    wrap.dataset.focusKey = `wrap-code-${index}`;
    wrap.textContent = 'Wrap';
    wrap.setAttribute('aria-pressed', String(options.wrap));
    wrap.addEventListener('click', () => {
      const enabled = !pre.classList.contains('code-wrap');
      pre.classList.toggle('code-wrap', enabled);
      wrap.setAttribute('aria-pressed', String(enabled));
    });
    controls.append(label, copy, wrap);
    pre.before(controls);
  }
}

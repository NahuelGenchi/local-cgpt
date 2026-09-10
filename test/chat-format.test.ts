import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addCodeControls, highlightCode, inferLanguage, renderedMessage, safeRenderedHref, MAX_RENDERED_HTML_CHARS } from '../src/renderer/chat-format.js';

let dom: JSDOM;
beforeEach(() => {
  dom = new JSDOM('<!doctype html><body></body>', { url: 'https://local.test/', pretendToBeVisual: true });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document });
});
afterEach(() => dom.window.close());

function assertInert(root: HTMLElement): void {
  expect(root.querySelector('script,style,iframe,object,embed,svg,math,form,input,button,textarea,select,meta,link,img')).toBeNull();
  for (const node of root.querySelectorAll('*')) {
    expect(node.namespaceURI).toBe('http://www.w3.org/1999/xhtml');
    for (const attribute of Array.from(node.attributes)) {
      expect(['href', 'target', 'rel', 'title', 'start', 'colspan', 'rowspan']).toContain(attribute.name);
      if (attribute.name === 'href') expect(safeRenderedHref(attribute.value)).not.toBeNull();
    }
  }
}

describe('captured-content boundary', () => {
  it('drops executable, embedded, form and foreign-namespace content while preserving prose', () => {
    const root = renderedMessage('<p style="color:red" onclick="void 0">Kept <strong>prose</strong></p><script>void 0</script><style>p{}</style><iframe></iframe><svg><foreignObject><p>foreign</p></foreignObject></svg><math><mtext>foreign</mtext></math><form><button>not an app control</button></form><img src="https://example.invalid/tracker">', 'fallback');
    assertInert(root);
    expect(root.textContent).toContain('Kept prose');
    expect(root.textContent).not.toContain('not an app control');
  });

  it.each(['javascript:void(0)', 'data:text/html,test', 'file:///tmp/test', 'javas\ncript:void(0)', 'vbscript:test', '/relative'])('does not turn %s into a navigable URL', (url) => {
    const anchor = document.createElement('a');
    anchor.setAttribute('href', url);
    anchor.textContent = 'label';
    const root = renderedMessage(anchor.outerHTML, 'fallback');
    expect(root.querySelector('a')!.hasAttribute('href')).toBe(false);
  });

  it('preserves safe table, list and link semantics without captured classes', () => {
    const root = renderedMessage('<ol start="4"><li>four</li></ol><table><tr><td colspan="2">cell</td></tr></table><a href="https://example.invalid/" class="unsafe">link</a>', '');
    assertInert(root);
    expect(root.querySelector('ol')!.getAttribute('start')).toBe('4');
    expect(root.querySelector('td')!.getAttribute('colspan')).toBe('2');
    expect(root.querySelector('a')!.getAttribute('rel')).toBe('noreferrer noopener');
    expect(root.querySelector('[class]')).toBeNull();
  });

  it('falls back to bounded inert text on excessive nesting', () => {
    const root = renderedMessage('<div>'.repeat(150) + 'deep' + '</div>'.repeat(150), 'safe fallback');
    expect(root.textContent).toBe('safe fallback');
    expect(root.children).toHaveLength(0);
    expect(renderedMessage('', 'x'.repeat(MAX_RENDERED_HTML_CHARS + 100)).textContent).toHaveLength(MAX_RENDERED_HTML_CHARS);
  });

  it('keeps a deterministic malformed-markup corpus inert after reserialization', () => {
    let seed = 20260908;
    const parts = ['<p>', '</p>', '<table><tr><td>', '</table>', '<svg>', '</svg>', '<math>', '</math>', '<template>', '</template>', '<span title="ok">', '</span>', '<a href="data:text/plain,x">', '</a>', '<input value="x">', '<script>void 0</script>', '<!--', '-->', '&lt;safe&gt;', 'text'];
    for (let example = 0; example < 80; example++) {
      let input = '';
      for (let index = 0; index < 30; index++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        input += parts[seed % parts.length];
      }
      const first = renderedMessage(input, 'fallback');
      assertInert(first);
      assertInert(renderedMessage(first.innerHTML, 'fallback'));
    }
  });
});

describe('bounded code presentation', () => {
  it('uses text nodes for code that resembles markup', () => {
    const code = document.createElement('code');
    const text = 'const example = "<input value=example>";\n\treturn example;';
    highlightCode(code, text, 'javascript');
    expect(code.textContent).toBe(text);
    expect(code.querySelector('input')).toBeNull();
    expect(code.querySelector('.syntax-keyword')?.textContent).toBe('const');
  });

  it('bounds work for unterminated delimiters and falls back for oversized code', () => {
    const code = document.createElement('code');
    const text = '/*' + ' / '.repeat(20_000);
    highlightCode(code, text, 'javascript');
    expect(code.textContent).toBe(text);
    expect(code.children).toHaveLength(1);
    const huge = 'const x = 1;\n'.repeat(10_000);
    highlightCode(code, huge, 'javascript');
    expect(code.textContent).toBe(huge);
    expect(code.children).toHaveLength(0);
  });

  it('copies exact retained whitespace, not language labels or truncation notices', async () => {
    const root = document.createElement('div');
    const pre = document.createElement('pre');
    const original = '\tconst value = 1;  \n';
    pre.textContent = original;
    const cut = document.createElement('span');
    cut.className = 'cut';
    cut.textContent = 'retained excerpt';
    pre.append(cut);
    root.append(pre);
    const copy = vi.fn(async () => true);
    addCodeControls(root, { wrap: false, copy });
    expect(root.textContent).toContain('javascript (inferred)');
    expect(pre.querySelector('.cut')).toBeNull();
    const buttons = root.querySelectorAll<HTMLButtonElement>('button');
    expect(buttons[0]!.textContent).toBe('Copy retained code');
    buttons[0]!.click();
    await Promise.resolve();
    expect(copy).toHaveBeenCalledWith(original);
    expect(buttons[0]!.textContent).toBe('Copied');
    buttons[1]!.click();
    expect(buttons[1]!.getAttribute('aria-pressed')).toBe('true');
    expect(pre.classList.contains('code-wrap')).toBe(true);
  });

  it('reports clipboard failure rather than claiming success', async () => {
    const root = renderedMessage('<pre><code>plain</code></pre>', '');
    addCodeControls(root, { wrap: true, copy: async () => false });
    root.querySelector<HTMLButtonElement>('button')!.click();
    await Promise.resolve();
    expect(root.querySelector('button')!.textContent).toBe('Copy failed');
  });

  it('labels inference as inference and leaves unknown code plain', () => {
    expect(inferLanguage('def run():\n  pass')).toBe('python');
    expect(inferLanguage('{"a":1}')).toBe('json');
    expect(inferLanguage('hello, world')).toBe('plain');
  });
});

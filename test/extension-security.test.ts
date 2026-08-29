import { promises as fs } from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';

describe('companion page-to-extension event boundary', () => {
  it('loads the synthetic-event guard before privileged content handlers', async () => {
    const manifest = JSON.parse(
      await fs.readFile(path.join(process.cwd(), 'extension', 'manifest.json'), 'utf8')
    ) as { content_scripts: Array<{ js: string[]; world?: string }> };
    const isolated = manifest.content_scripts.find((entry) => (entry.world ?? 'ISOLATED') === 'ISOLATED');
    expect(isolated?.js).toEqual(['chatgpt-dom.js', 'event-guard.js', 'content.js']);
  });

  it('blocks page-script-generated events before a companion control handler can run', async () => {
    const source = await fs.readFile(path.join(process.cwd(), 'extension', 'event-guard.js'), 'utf8');
    const dom = new JSDOM('<!doctype html><button class="clf-menu-action">Compact & resume</button>', {
      url: 'https://chatgpt.com/c/test',
      runScripts: 'outside-only'
    });
    try {
      const button = dom.window.document.querySelector('button')!;
      const privileged = vi.fn();
      button.addEventListener('click', privileged);
      dom.window.eval(source);

      const event = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true });
      expect(event.isTrusted).toBe(false);
      expect(button.dispatchEvent(event)).toBe(false);
      expect(event.defaultPrevented).toBe(true);
      expect(privileged).not.toHaveBeenCalled();
    } finally {
      dom.window.close();
    }
  });

  it('does not interfere with synthetic events on ordinary ChatGPT elements', async () => {
    const source = await fs.readFile(path.join(process.cwd(), 'extension', 'event-guard.js'), 'utf8');
    const dom = new JSDOM('<!doctype html><button id="page-button">Page control</button>', {
      url: 'https://chatgpt.com/c/test',
      runScripts: 'outside-only'
    });
    try {
      const button = dom.window.document.querySelector('button')!;
      const pageHandler = vi.fn();
      button.addEventListener('click', pageHandler);
      dom.window.eval(source);

      const event = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true });
      expect(button.dispatchEvent(event)).toBe(true);
      expect(event.defaultPrevented).toBe(false);
      expect(pageHandler).toHaveBeenCalledOnce();
    } finally {
      dom.window.close();
    }
  });
});


describe('companion install identity boundary', () => {
  it('keeps pairing proof material out of page-visible extension surfaces', async () => {
    const dir = path.join(process.cwd(), 'extension');
    const [manifestText, background, content, fiber] = await Promise.all([
      fs.readFile(path.join(dir, 'manifest.json'), 'utf8'),
      fs.readFile(path.join(dir, 'background.js'), 'utf8'),
      fs.readFile(path.join(dir, 'content.js'), 'utf8'),
      fs.readFile(path.join(dir, 'fiber.js'), 'utf8')
    ]);
    const manifest = JSON.parse(manifestText) as Record<string, unknown>;
    expect(manifest.web_accessible_resources).toBeUndefined();
    expect(background).toContain("COMPANION_AUTH_RESOURCE = 'companion-auth.json'");
    expect(background).not.toMatch(/storage\.local\.(?:set|get)\([^)]*companion-auth/s);
    expect(content).not.toContain('companion-auth.json');
    expect(fiber).not.toContain('companion-auth.json');
    await expect(fs.access(path.join(dir, 'companion-auth.json'))).rejects.toBeDefined();
  });
});

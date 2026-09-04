import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

async function text(relative: string): Promise<string> {
  return fs.readFile(path.join(root, relative), 'utf8');
}

describe('local-cgpt product identity', () => {
  it('uses local-cgpt on the visible Electron and renderer surfaces', async () => {
    const [renderer, main] = await Promise.all([
      text('src/renderer/index.html'),
      text('src/main/index.ts')
    ]);

    expect(renderer).toContain('<title>local-cgpt</title>');
    expect(renderer).toMatch(/<span class="title">\s*local-cgpt\s*<span id="headerSub">/);
    expect(renderer).not.toContain('Chat On Steroids');

    expect(main).toContain("title: 'local-cgpt'");
    expect(main).toContain('tray.setToolTip(`local-cgpt — ${label.toLowerCase()}`)');
    expect(main).toContain('local-cgpt companion loaded');
    expect(main).not.toContain('Chat On Steroids');
  });

  it('uses local-cgpt for the bundled Chrome companion', async () => {
    const [manifestText, popup] = await Promise.all([
      text('extension/manifest.json'),
      text('extension/popup.html')
    ]);
    const manifest = JSON.parse(manifestText) as {
      name: string;
      description: string;
      action: { default_title: string };
    };

    expect(manifest.name).toBe('local-cgpt companion');
    expect(manifest.description).toContain('local-cgpt');
    expect(manifest.action.default_title).toBe('local-cgpt');
    expect(manifestText).not.toContain('Chat On Steroids');
    expect(popup).toContain('<title>local-cgpt</title>');
    expect(popup).toContain('<h1>local-cgpt</h1>');
    expect(popup).not.toContain('Chat On Steroids');
  });

  it('brands suggested connector names without migrating stable server identifiers', async () => {
    const surfaces = await text('src/main/mcp/surfaces.ts');

    expect(surfaces).toContain("export const CONNECTOR_BRAND = 'local-cgpt'");
    expect(surfaces).toContain("serverName: 'chat-on-steroids-core'");
    expect(surfaces).toContain("serverName: 'chat-on-steroids-desktop'");
    expect(surfaces).toContain('connectorName: `${CONNECTOR_BRAND} Core`');
    expect(surfaces).toContain('connectorName: `${CONNECTOR_BRAND} Desktop`');
  });

  it('keeps the hardened Linux package identity while aligning display metadata', async () => {
    const [packageText, builder] = await Promise.all([
      text('package.json'),
      text('electron-builder.yml')
    ]);
    const pkg = JSON.parse(packageText) as { name: string; author: string };

    expect(pkg.name).toBe('local-cgpt');
    expect(pkg.author).toBe('NahuelGenchi');
    expect(builder).toContain('appId: com.localcgpt.app');
    expect(builder).toContain('productName: local-cgpt');
    expect(builder).toContain('executableName: local-cgpt');
    expect(builder).toContain('artifactName: Local-CGPT-Linux-${env.COS_PACKAGE_ARCH}.${ext}');
    expect(builder).not.toContain('Chat On Steroids');
    expect(builder).not.toContain('Chat-On-Steroids');
  });

  it('uses the current product name in model-facing setup guidance', async () => {
    const instructions = await text('src/main/mcp/instructions.ts');
    expect(instructions).toContain('approve a folder in the local-cgpt app');
    expect(instructions).not.toContain('Chat On Steroids');
  });
});

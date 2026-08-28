import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repo = process.cwd();

describe('runtime multi-agent enable regression', () => {
  it('wires persistence before unconditional restore and preserves history while disabled', async () => {
    const source = await readFile(path.join(repo, 'src/main/index.ts'), 'utf8');
    const persistSink = source.indexOf('onSwarmPersistNow((snapshot) => writeDurableNow(SWARM_STATE, snapshot))');
    const restoreRead = source.indexOf('const savedSwarm = await readDurable<SwarmSnapshot>(SWARM_STATE)');
    const shutdownFence = source.indexOf('if (windowActivation.isDisabled()) return;', restoreRead);
    const restore = source.indexOf('restoreSwarm(savedSwarm)', restoreRead);
    const disabledPause = source.indexOf("pauseSwarmForDisable('multi-agent mode is disabled')");

    expect(persistSink).toBeGreaterThanOrEqual(0);
    expect(restoreRead).toBeGreaterThanOrEqual(0);
    expect(shutdownFence).toBeGreaterThanOrEqual(0);
    expect(restore).toBeGreaterThanOrEqual(0);
    expect(disabledPause).toBeGreaterThanOrEqual(0);
    expect(persistSink).toBeLessThan(restoreRead);
    expect(restoreRead).toBeLessThan(shutdownFence);
    expect(shutdownFence).toBeLessThan(restore);
    expect(restore).toBeLessThan(disabledPause);
    expect(source).not.toContain('await writeDurableNow(SWARM_STATE, null)');
  });
});

describe('companion extension setup contract', () => {
  it('uses only the extension bundled with reviewed hardened source', async () => {
    const [html, renderer, preload, ipc, version, manifestText] = await Promise.all([
      readFile(path.join(repo, 'src/renderer/index.html'), 'utf8'),
      readFile(path.join(repo, 'src/renderer/main.ts'), 'utf8'),
      readFile(path.join(repo, 'src/preload/index.ts'), 'utf8'),
      readFile(path.join(repo, 'src/main/ipc.ts'), 'utf8'),
      readFile(path.join(repo, 'src/main/version.ts'), 'utf8'),
      readFile(path.join(repo, 'extension/manifest.json'), 'utf8')
    ]);
    const manifest = JSON.parse(manifestText);

    expect(html).not.toContain('id="bridgeDownload"');
    expect(html).toMatch(/bundled folder/i);
    expect(html).toMatch(/does not download extension code from upstream releases/i);
    expect(html).toMatch(/Required for sub-agents/i);
    expect(html).toMatch(/Requires the Chrome extension to be loaded and connected/i);
    expect(renderer).not.toContain('api.downloadExtension()');
    expect(preload).not.toContain("bridge:downloadExtension");
    expect(ipc).not.toContain("bridge:downloadExtension");
    expect(version).not.toContain('totec448-spec/chat-on-steroids/releases/download');
    expect(manifest.update_url).toBeUndefined();
  });
});

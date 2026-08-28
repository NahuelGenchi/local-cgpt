import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// @ts-ignore js-yaml is a transitive electron-builder dependency; tests only need its runtime parser.
import { load as loadYaml } from 'js-yaml';
// @ts-ignore Build scripts are intentionally plain ESM JavaScript.
import * as packagingVersions from '../scripts/packaging-versions.mjs';
// @ts-ignore Build scripts are intentionally plain ESM JavaScript.
import * as packagingTargets from '../scripts/packaging-targets.mjs';

const { RIPGREP, TUNNEL_CLIENT } = packagingVersions;
const {
  normalizeArch,
  normalizePlatform,
  PLATFORM_INFO,
  sharpPackagesFor,
  SUPPORTED_ARCHES,
  SUPPORTED_PLATFORMS,
  tarExecutableForPlatform,
  unpackedDirectoryPattern
} = packagingTargets;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requireFromTest = createRequire(import.meta.url);

function textFile(relative: string): string {
  return readFileSync(path.join(root, ...relative.split('/')), 'utf8');
}

function yamlFile(relative: string): any {
  return loadYaml(textFile(relative));
}

describe('packaging primitives retained from upstream', () => {
  it('normalizes known target spellings and rejects unsupported targets', () => {
    expect(normalizePlatform('windows')).toBe('win32');
    expect(normalizePlatform('macos')).toBe('darwin');
    expect(normalizePlatform('linux')).toBe('linux');
    expect(normalizeArch('x64')).toBe('x64');
    expect(normalizeArch('arm64')).toBe('arm64');
    expect(() => normalizePlatform('freebsd')).toThrow(/Unsupported packaging platform/);
    expect(() => normalizeArch('ia32')).toThrow(/Unsupported packaging architecture/);
  });

  it('keeps every inherited executable target checksum-pinned', () => {
    for (const platform of SUPPORTED_PLATFORMS) {
      for (const arch of SUPPORTED_ARCHES) {
        expect(TUNNEL_CLIENT.targets[platform][arch].sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(RIPGREP.targets[platform][arch].sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(PLATFORM_INFO[platform].builderFlag).toMatch(/^--(?:win|mac|linux)$/);
      }
    }
    expect(RIPGREP.targets.linux.x64.triple).toBe('unknown-linux-musl');
    expect(RIPGREP.targets.linux.arm64.triple).toBe('unknown-linux-musl');
  });

  it('selects target-native Sharp packages and unpacked directory families', () => {
    expect(sharpPackagesFor('win32', 'x64')).toEqual(['@img/sharp-win32-x64']);
    expect(sharpPackagesFor('darwin', 'arm64')).toEqual([
      '@img/sharp-darwin-arm64',
      '@img/sharp-libvips-darwin-arm64'
    ]);
    expect(sharpPackagesFor('linux', 'x64')).toEqual([
      '@img/sharp-linux-x64',
      '@img/sharp-libvips-linux-x64'
    ]);
    expect(unpackedDirectoryPattern('win32').test('win-arm64-unpacked')).toBe(true);
    expect(unpackedDirectoryPattern('darwin').test('mac-arm64')).toBe(true);
    expect(unpackedDirectoryPattern('linux').test('linux-unpacked')).toBe(true);
    expect(unpackedDirectoryPattern('linux').test('mac-arm64')).toBe(false);
  });

  it('uses the host archive command spelling on inherited packaging targets', () => {
    expect(tarExecutableForPlatform('win32')).toBe('tar.exe');
    expect(tarExecutableForPlatform('darwin')).toBe('tar');
    expect(tarExecutableForPlatform('linux')).toBe('tar');
  });
});

describe('Linux M0 package contract', () => {
  it('has a fork-owned package, desktop, executable and artifact identity', () => {
    const pkg = JSON.parse(textFile('package.json'));
    const lock = JSON.parse(textFile('package-lock.json'));
    const builder = yamlFile('electron-builder.yml');

    expect(pkg.name).toBe('local-cgpt');
    expect(lock.name).toBe('local-cgpt');
    expect(lock.packages?.['']?.name).toBe('local-cgpt');
    expect(pkg.desktopName).toBe('com.localcgpt.app.desktop');
    expect(pkg.homepage).toBe('https://github.com/NahuelGenchi/local-cgpt');
    expect(builder.appId).toBe('com.localcgpt.app');
    expect(builder.linux.executableName).toBe('local-cgpt');
    expect(builder.linux.artifactName).toBe('Local-CGPT-Linux-${env.COS_PACKAGE_ARCH}.${ext}');
  });

  it('makes Bubblewrap a Debian runtime dependency and retains Noble-compatible libraries', () => {
    const builder = yamlFile('electron-builder.yml');
    expect(builder.deb.depends).toContain('bubblewrap');
    expect(builder.deb.depends).toContain('libgtk-3-0 | libgtk-3-0t64');
    expect(builder.deb.depends).toContain('libatspi2.0-0 | libatspi2.0-0t64');
    expect(builder.toolsets.appimage).toBe('1.0.3');
  });

  it('keeps Linux x64 as the controlled M0 candidate and verifies the installed package', () => {
    const workflow = textFile('.github/workflows/linux-test-build.yml');
    expect(workflow).toContain('name: Linux M0 test candidate');
    expect(workflow).toContain('runs-on: ubuntu-24.04');
    expect(workflow).toContain('npm run dist:linux:x64');
    expect(workflow).toContain('release/Local-CGPT-Linux-x64.deb');
    expect(workflow).toContain('dpkg-deb --field "$deb" Package)" = local-cgpt');
    expect(workflow).toContain("grep -Eq '(^|, )[[:space:]]*bubblewrap([[:space:]]|,|$)'");
    expect(workflow).toContain('dpkg-query -W -f=\'${Status}\\n\' local-cgpt');
    expect(workflow).toContain('test -L /usr/bin/local-cgpt');
    expect(workflow).toContain('ELECTRON_RUN_AS_NODE=1 /usr/bin/local-cgpt');
    expect(workflow).toContain('node scripts/smoke-packaged-runtime.mjs --platform linux --arch x64');
    expect(workflow).toContain('source_sha=${GITHUB_SHA}');
    expect(workflow).toContain('sha256sum "$deb"');
    expect(workflow).toContain('release/LINUX-M0-TEST.md');
    expect(workflow).toContain('local-cgpt-m0-linux-x64-${{ github.sha }}');
    expect(workflow).not.toMatch(/windows-|macos-|dist:mac|dist:x64|dist:arm64/i);
  });

  it('keeps public and inherited cross-platform release workflows fail-closed', () => {
    const release = textFile('.github/workflows/release.yml');
    const publish = textFile('.github/workflows/publish.yml');

    expect(release).toContain('Legacy release candidate (disabled)');
    expect(release).toContain('The inherited cross-platform release pipeline is disabled.');
    expect(release).toContain('local-cgpt currently supports Linux only.');
    expect(release).toContain('exit 1');
    expect(release).not.toContain('strategy:\n      matrix:');

    expect(publish).toContain('Public release publishing (disabled until M4)');
    expect(publish).toContain('Public release publishing is intentionally disabled');
    expect(publish).toContain('release-provenance/signing milestone');
    expect(publish).toContain('exit 1');
    expect(publish).not.toContain('gh release create');
  });

  it('pins Electron exactly and proves packaged runtime bytes report that version', () => {
    const pkg = JSON.parse(textFile('package.json'));
    const lock = JSON.parse(textFile('package-lock.json'));
    const smoke = textFile('scripts/smoke-packaged-runtime.mjs');

    expect(pkg.devDependencies.electron).toBe('43.4.1');
    expect(lock.packages?.['']?.devDependencies?.electron).toBe('43.4.1');
    expect(lock.packages?.['node_modules/electron']?.version).toBe('43.4.1');
    expect(smoke).toContain('const expectedElectronVersion = sourcePackage.devDependencies?.electron;');
    expect(smoke).toContain('electron: process.versions.electron');
    expect(smoke).toContain('runtime.electron !== expectedElectronVersion');
  });

  it('keeps version metadata internally aligned without treating inherited v2.0.2 notes as an M0 release', () => {
    const pkg = JSON.parse(textFile('package.json')) as { version: string };
    const lock = JSON.parse(textFile('package-lock.json'));
    const manifest = JSON.parse(textFile('extension/manifest.json'));
    const versionSource = textFile('src/main/version.ts');

    expect(lock.version).toBe(pkg.version);
    expect(lock.packages?.['']?.version).toBe(pkg.version);
    expect(manifest.version).toBe(pkg.version);
    expect(versionSource.match(/APP_VERSION = '([^']+)'/)?.[1]).toBe(pkg.version);
    expect(textFile('.github/workflows/publish.yml')).toContain('disabled until M4');
  });

  it('keeps executable downloads immutable and SHA-256 verified before extraction', () => {
    const tunnel = textFile('scripts/fetch-tunnel-client.mjs');
    const rg = textFile('scripts/fetch-ripgrep.mjs');

    expect(tunnel).toContain('https://github.com/openai/tunnel-client/releases/download/${tag}/${assetName}');
    expect(rg).toContain('https://github.com/BurntSushi/ripgrep/releases/download/${version}/${assetName}');
    expect(tunnel).not.toContain('releases/latest');
    expect(rg).not.toContain('releases/latest');

    for (const [source, digest, removal, extraction] of [
      [tunnel, 'update(await readFile(zipPath))', 'await rm(zipPath, { force: true });', 'extractZip(zipPath, outDir);'],
      [
        rg,
        'update(await readFile(archivePath))',
        'await rm(archivePath, { force: true });',
        'extractArchive(archivePath, target.extension, outDir);'
      ]
    ] as const) {
      expect(source).toContain("createHash('sha256')");
      expect(source).toContain(digest);
      expect(source).toContain('if (actual !== target.sha256)');
      expect(source).toContain(removal);
      expect(source).toContain('Checksum mismatch for ${assetName}');

      const digestAt = source.indexOf(digest);
      const verificationAt = source.indexOf('if (actual !== target.sha256)');
      const extractionAt = source.indexOf(extraction);
      expect(digestAt).toBeGreaterThan(-1);
      expect(verificationAt).toBeGreaterThan(digestAt);
      expect(extractionAt).toBeGreaterThan(verificationAt);
    }
  });

  it('keeps the static AppImage Chromium sandbox fallback conditional and duplicate-safe', () => {
    const { generateAppRunScript } = requireFromTest(
      path.join(root, 'node_modules', 'app-builder-lib', 'out', 'targets', 'appimage', 'appImageUtil.js')
    ) as { generateAppRunScript: (config: Record<string, string>) => string };
    const script = generateAppRunScript({
      ExecutableName: 'local-cgpt',
      DesktopFileName: 'com.localcgpt.app.desktop',
      ProductFilename: 'Chat On Steroids',
      ProductName: 'Chat On Steroids',
      ResourceName: 'appimagekit-local-cgpt'
    });

    expect(script).toContain('HAVE_NO_SANDBOX=0');
    expect(script).toContain('if [ "$arg" = --no-sandbox ] ; then');
    expect(script).toContain('if [ $HAVE_NO_SANDBOX -eq 0 ] && ! unshare -Ur true 2>/dev/null ; then');
    expect(script).toContain('NO_SANDBOX=(--no-sandbox)');
    expect(script).toContain('exec "$BIN" "${NO_SANDBOX[@]}" "${args[@]}"');
  });

  it('keeps renderer readiness behind the initial IPC state snapshot', () => {
    const ipc = textFile('src/main/ipc.ts');
    const handler = ipc.indexOf("handle('state:get', async () => {");
    const state = ipc.indexOf('const state = await buildState();', handler);
    const ready = ipc.indexOf("logInfo('renderer state ready');", state);
    const returned = ipc.indexOf('return state;', ready);

    expect(handler).toBeGreaterThan(-1);
    expect(state).toBeGreaterThan(handler);
    expect(ready).toBeGreaterThan(state);
    expect(returned).toBeGreaterThan(ready);
  });
});

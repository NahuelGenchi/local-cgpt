import { readFileSync, readdirSync } from 'node:fs';
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
  it('has a fork-owned package, desktop, executable, product and artifact identity', () => {
    const pkg = JSON.parse(textFile('package.json'));
    const lock = JSON.parse(textFile('package-lock.json'));
    const builder = yamlFile('electron-builder.yml');

    expect(pkg.name).toBe('local-cgpt');
    expect(lock.name).toBe('local-cgpt');
    expect(lock.packages?.['']?.name).toBe('local-cgpt');
    expect(pkg.desktopName).toBe('com.localcgpt.app.desktop');
    expect(pkg.homepage).toBe('https://github.com/NahuelGenchi/local-cgpt');
    expect(builder.appId).toBe('com.localcgpt.app');
    expect(builder.productName).toBe('Local CGPT');
    expect(builder.linux.executableName).toBe('local-cgpt');
    expect(builder.linux.maintainer).not.toMatch(/Chat On Steroids/i);
    expect(builder.linux.artifactName).toBe('Local-CGPT-Linux-${env.COS_PACKAGE_ARCH}.${ext}');
  });

  it('makes Bubblewrap a Debian runtime dependency and retains Noble-compatible libraries', () => {
    const builder = yamlFile('electron-builder.yml');
    expect(builder.deb.depends).toContain('bubblewrap');
    expect(builder.deb.depends).toContain('libgtk-3-0 | libgtk-3-0t64');
    expect(builder.deb.depends).toContain('libatspi2.0-0 | libatspi2.0-0t64');
    expect(builder.toolsets.appimage).toBe('1.0.3');
  });

  it('keeps Linux x64 DEB as the controlled M0 candidate from the exact source SHA', () => {
    const pkg = JSON.parse(textFile('package.json'));
    const packageScript = textFile('scripts/package.mjs');
    const workflow = textFile('.github/workflows/linux-test-build.yml');

    expect(pkg.scripts['dist:linux:x64:deb']).toBe('node scripts/package.mjs --platform linux --arch x64 --target deb');
    expect(packageScript).toContain("const explicitTarget = value('target', '');");
    expect(packageScript).toContain("builderArgs.push(`--${arch}`, '--publish', 'never');");
    expect(workflow).toContain('name: Linux M0 test candidate');
    expect(workflow).toContain('runs-on: ubuntu-24.04');
    expect(workflow).toContain('SOURCE_SHA: ${{ github.event.pull_request.head.sha || github.sha }}');
    expect(workflow).toContain('ref: ${{ env.SOURCE_SHA }}');
    expect(workflow).toContain('persist-credentials: false');
    expect(workflow).toContain('test "$(git rev-parse HEAD)" = "$SOURCE_SHA"');
    expect(workflow).toContain('npm run dist:linux:x64:deb');
    expect(workflow).toContain('release/Local-CGPT-Linux-x64.deb');
    expect(workflow).not.toContain('.AppImage');
    expect(workflow).toContain('dpkg-deb --field "$deb" Package)" = local-cgpt');
    expect(workflow).toContain("grep -Eq '(^|, )[[:space:]]*bubblewrap([[:space:]]|,|$)'");
    expect(workflow).toContain('candidate_kind=controlled-m0-test');
    expect(workflow).toContain('public_release=false');
    expect(workflow).toContain('source_sha=${SOURCE_SHA}');
    expect(workflow).not.toContain('source_sha=${GITHUB_SHA}');
    expect(workflow).toContain('(cd release && sha256sum Local-CGPT-Linux-x64.deb > SHA256SUMS.txt)');
    expect(workflow).toContain('release/LINUX-M0-TEST.md');
    expect(workflow).toContain('local-cgpt-m0-linux-x64-${{ env.SOURCE_SHA }}');
    expect(workflow).not.toMatch(/windows-|macos-|dist:mac|dist:x64|dist:arm64/i);
  });

  it('installs the generated DEB, resolves the package-owned launcher, and smokes Electron under Xvfb', () => {
    const workflow = textFile('.github/workflows/linux-test-build.yml');
    const smoke = textFile('scripts/smoke-packaged-runtime.mjs');

    expect(workflow).toContain("dpkg-query -W -f='${Status}\\n' local-cgpt");
    expect(workflow).toContain('test -L /usr/bin/local-cgpt');
    expect(workflow).toContain('resolved="$(readlink -f /usr/bin/local-cgpt)"');
    expect(workflow).toContain('test "$(basename "$resolved")" = local-cgpt');
    expect(workflow).toContain('dpkg-query -L local-cgpt | grep -Fxq "$resolved"');
    expect(workflow).toContain('dpkg-query -S "$resolved" | grep -Eq \'^local-cgpt:\'');
    expect(workflow).toContain('ELECTRON_RUN_AS_NODE=1 /usr/bin/local-cgpt');
    expect(workflow).toContain('node scripts/smoke-packaged-runtime.mjs --platform linux --arch x64');
    expect(workflow).toContain('sudo apt-get install -y --no-install-recommends xvfb xauth');
    expect(workflow).toContain('xvfb-run -a /usr/bin/local-cgpt');
    expect(workflow).toContain('if [ "$status" -ne 124 ]');
    expect(workflow).not.toContain('--no-sandbox');
    expect(smoke).toContain("targetPlatform === 'win32' ? 'Local CGPT.exe' : 'local-cgpt'");
  });

  it('keeps the bundled extension as reviewed source rather than a release download', () => {
    const builder = yamlFile('electron-builder.yml');
    const extensionResource = builder.extraResources.find((entry: any) => entry?.from === 'extension');
    expect(extensionResource?.to).toBe('extension');

    const securityWorkflow = textFile('.github/workflows/security.yml');
    expect(securityWorkflow).toContain("if grep -R -F 'totec448-spec/chat-on-steroids/releases/download'");
    expect(securityWorkflow).toContain("if grep -R -F 'bridge:downloadExtension'");
  });

  it('keeps public and inherited cross-platform release workflows fail-closed', () => {
    const release = textFile('.github/workflows/release.yml');
    const publish = textFile('.github/workflows/publish.yml');
    const candidate = textFile('.github/workflows/linux-test-build.yml');

    expect(release).toContain('Legacy release candidate (disabled)');
    expect(release).toContain('permissions:\n  contents: read');
    expect(release).toContain('The inherited cross-platform release pipeline is disabled.');
    expect(release).toContain('local-cgpt currently supports Linux only.');
    expect(release).toContain('exit 1');
    expect(release).not.toContain('strategy:\n      matrix:');

    expect(publish).toContain('Public release publishing (disabled until M4)');
    expect(publish).toContain('permissions:\n  contents: read');
    expect(publish).toContain('Public release publishing is intentionally disabled');
    expect(publish).toContain('release-provenance/signing milestone');
    expect(publish).toContain('exit 1');
    expect(publish).not.toContain('gh release create');
    expect(candidate).toContain('permissions:\n  contents: read');
    expect(candidate).toContain('public_release=false');
    expect(candidate).not.toMatch(/\bgh\s+release\s+create\b|\bnpm\s+publish\b/);
  });

  it('pins every GitHub Actions dependency to an immutable action commit SHA', () => {
    const workflowsDir = path.join(root, '.github', 'workflows');
    for (const file of readdirSync(workflowsDir).filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))) {
      const workflow = textFile(`.github/workflows/${file}`);
      for (const line of workflow.split(/\r?\n/)) {
        const match = line.match(/^\s*uses:\s*([^@\s]+)@([^\s#]+)/);
        if (!match) continue;
        expect(match[2], `${file}: ${line.trim()}`).toMatch(/^[0-9a-f]{40}$/);
      }
    }
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

    expect(tunnel).toContain("createHash('sha256').update(await readFile(zipPath)).digest('hex')");
    expect(tunnel).toContain('if (actual !== target.sha256)');
    expect(tunnel).toContain('throw new Error(`Checksum mismatch for ${assetName}');
    expect(tunnel.indexOf('if (actual !== target.sha256)')).toBeLessThan(tunnel.indexOf('extractZip(zipPath, outDir);'));

    expect(rg).toContain("createHash('sha256').update(await readFile(archivePath)).digest('hex')");
    expect(rg).toContain('if (actual !== target.sha256)');
    expect(rg).toContain('throw new Error(`Checksum mismatch for ${assetName}');
    expect(rg.indexOf('if (actual !== target.sha256)')).toBeLessThan(rg.indexOf('extractArchive(archivePath, target.extension, outDir);'));
  });

  it('keeps the static AppImage Chromium sandbox fallback conditional and duplicate-safe without making AppImage an M0 gate', () => {
    const { generateAppRunScript } = requireFromTest(
      path.join(root, 'node_modules', 'app-builder-lib', 'out', 'targets', 'appimage', 'appImageUtil.js')
    ) as { generateAppRunScript: (config: Record<string, string>) => string };
    const script = generateAppRunScript({
      ExecutableName: 'local-cgpt',
      DesktopFileName: 'com.localcgpt.app.desktop',
      ProductFilename: 'Local CGPT',
      ProductName: 'Local CGPT',
      ResourceName: 'appimagekit-local-cgpt'
    });

    expect(script).toContain('HAVE_NO_SANDBOX=0');
    expect(script).toContain('if [ "$arg" = --no-sandbox ] ; then');
    expect(script).toContain('if [ $HAVE_NO_SANDBOX -eq 0 ] && ! unshare -Ur true 2>/dev/null ; then');
    expect(script).toContain('NO_SANDBOX=(--no-sandbox)');
    expect(script).toContain('exec "$BIN" "${NO_SANDBOX[@]}" "${args[@]}"');
    expect(textFile('.github/workflows/linux-test-build.yml')).not.toContain('.AppImage');
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

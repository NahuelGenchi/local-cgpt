import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import { resolve } from 'node:path';

interface PackageMetadata {
  version?: unknown;
}

const packageMetadata = JSON.parse(
  readFileSync(resolve(__dirname, 'package.json'), 'utf8')
) as PackageMetadata;

const appVersion = typeof packageMetadata.version === 'string' ? packageMetadata.version : 'unknown';

/**
 * Identifies the exact checked-out source without adding a build timestamp, so this remains
 * useful for reproducible packages. CI/release callers may pin the revision explicitly; local
 * development falls back to the checkout's HEAD. A source archive without Git remains honest.
 */
function sourceRevision(): string {
  for (const value of [process.env.LOCAL_CGPT_SOURCE_REVISION, process.env.GITHUB_SHA]) {
    const candidate = value?.trim();
    if (candidate && /^[0-9a-f]{7,40}$/i.test(candidate)) return candidate.toLowerCase();
  }
  try {
    const revision = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: __dirname,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
    return /^[0-9a-f]{40}$/i.test(revision) ? revision.toLowerCase() : 'unknown';
  } catch {
    return 'unknown';
  }
}

const rendererBuildIdentity = {
  __LOCAL_CGPT_APP_VERSION__: JSON.stringify(appVersion),
  __LOCAL_CGPT_SOURCE_REVISION__: JSON.stringify(sourceRevision())
};

export default defineConfig({
  main: {
    // Keep node_modules external so the MCP SDK ships as real files in the asar
    // rather than being inlined by the bundler.
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: { input: resolve(__dirname, 'src/main/index.ts') }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: { input: resolve(__dirname, 'src/preload/index.ts') }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    define: rendererBuildIdentity,
    build: {
      rollupOptions: { input: resolve(__dirname, 'src/renderer/index.html') }
    }
  }
});

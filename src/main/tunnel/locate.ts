/**
 * Finds the tunnel executables.
 *
 * The installer ships the release that was current when it was built, so a fresh
 * install works without a detour to a GitHub releases page. An explicit path the user
 * chose still wins. Otherwise the bundled copy wins: it is the version this app was
 * tested with, so an unrelated stale executable on PATH must not silently replace it.
 * PATH/common locations are a development convenience only; a packaged Electron app
 * fails closed when its reviewed bundle is missing unless the user explicitly picked
 * another executable through the native file dialog.
 */

import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathEntries } from '../env.js';

export type BinaryName = 'tunnel-client' | 'cloudflared';

const locateCache = new Map<string, string | null>();
const bundledVersionCache = new Map<string, string | null>();

function isExecutableFile(candidate: string): boolean {
  try {
    if (!existsSync(candidate) || !statSync(candidate).isFile()) return false;
    if (process.platform !== 'win32') accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function tunnelExecutableName(name: BinaryName, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? `${name}.exe` : name;
}

/**
 * Whether ambient host executable discovery is appropriate for this process.
 *
 * Electron sets `process.versions.electron` in both development and packaged processes and
 * sets `process.defaultApp === true` when the application is being run by the stock Electron
 * executable. A packaged application therefore has Electron present without `defaultApp`.
 * Ordinary Node/Vitest processes are treated like development so the source checkout keeps
 * its PATH/common-location convenience and focused unit tests do not need an Electron runtime.
 *
 * Security consequence: uncertainty fails toward *no ambient lookup*. If a non-standard Electron
 * development launcher does not set `defaultApp`, the developer may need to pick the binary
 * explicitly; a packaged installation never silently substitutes a host executable for the
 * reviewed one that was supposed to ship with it.
 */
export function ambientBinaryFallbackAllowed(
  electronVersion: string | undefined = process.versions.electron,
  defaultApp: boolean | undefined = (process as NodeJS.Process & { defaultApp?: boolean }).defaultApp
): boolean {
  return electronVersion === undefined || defaultApp === true;
}

/** Walks PATH by hand rather than shelling out to `where`. */
function searchPath(fileName: string): string | null {
  for (const dir of pathEntries()) {
    if (!dir) continue;
    const candidate = path.join(dir.replace(/^"|"$/g, ''), fileName);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

export function commonBinaryDirsForPlatform(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory = env.HOME ?? env.USERPROFILE ?? os.homedir()
): string[] {
  const platformPath = platform === 'win32' ? path.win32 : path.posix;
  if (platform === 'win32') {
    const home = env.USERPROFILE ?? homeDirectory;
    const localAppData = env.LOCALAPPDATA ?? '';
    const programFiles = env.ProgramFiles ?? 'C:\\Program Files';
    return [
      localAppData && platformPath.join(localAppData, 'Programs', 'tunnel-client'),
      localAppData && platformPath.join(localAppData, 'tunnel-client'),
      home && platformPath.join(home, '.tunnel-client'),
      home && platformPath.join(home, 'bin'),
      home && platformPath.join(home, 'Downloads', 'tunnel-client'),
      platformPath.join(programFiles, 'tunnel-client'),
      platformPath.join(programFiles, 'cloudflared')
    ].filter((d): d is string => d.length > 0);
  }

  const homeDirs = homeDirectory
    ? [
        platformPath.join(homeDirectory, '.tunnel-client'),
        platformPath.join(homeDirectory, '.local', 'bin'),
        platformPath.join(homeDirectory, 'bin'),
        platformPath.join(homeDirectory, 'Downloads', 'tunnel-client')
      ]
    : [];
  const systemDirs =
    platform === 'darwin'
      ? ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']
      : ['/home/linuxbrew/.linuxbrew/bin', '/usr/local/bin', '/usr/bin', '/snap/bin'];
  return [...homeDirs, ...systemDirs];
}

/**
 * Resolves a binary, preferring an explicit user-supplied path.
 * `hint` may be either the executable itself or the folder containing it.
 */
export function locateBinary(name: BinaryName, hint?: string): string | null {
  const ambientFallback = ambientBinaryFallbackAllowed();
  const key = [
    name,
    hint ?? '',
    process.platform,
    process.resourcesPath ?? '',
    ambientFallback ? 'ambient' : 'packaged-strict',
    process.env.PATH ?? process.env.Path ?? '',
    process.env.USERPROFILE ?? '',
    process.env.HOME ?? '',
    process.env.LOCALAPPDATA ?? '',
    process.env.ProgramFiles ?? ''
  ].join('\u0000');
  if (locateCache.has(key)) return locateCache.get(key) ?? null;

  const fileName = tunnelExecutableName(name);

  if (hint && hint.trim() !== '') {
    const trimmed = hint.trim();
    if (existsSync(trimmed)) {
      // Accept a folder as well as the exe itself, since users paste both.
      const asDir = path.join(trimmed, fileName);
      if (isExecutableFile(asDir)) {
        locateCache.set(key, asDir);
        return asDir;
      }
      if (path.basename(trimmed).toLowerCase() === fileName.toLowerCase() && isExecutableFile(trimmed)) {
        locateCache.set(key, trimmed);
        return trimmed;
      }
    }
    // cloudflared normally sits beside tunnel-client in the release archive.
    const sibling = path.join(path.dirname(trimmed), fileName);
    if (isExecutableFile(sibling)) {
      locateCache.set(key, sibling);
      return sibling;
    }
  }

  const bundled = bundledDir();
  if (bundled) {
    const candidate = path.join(bundled, fileName);
    if (isExecutableFile(candidate)) {
      locateCache.set(key, candidate);
      return candidate;
    }
  }

  // Packaged provenance is strict. A missing/damaged reviewed bundle is an installation
  // failure, not permission to run whatever same-named executable happens to be on PATH or
  // in a writable home directory. An explicit native-picker hint above remains an intentional
  // user override and therefore keeps working in packaged builds.
  if (!ambientFallback) {
    locateCache.set(key, null);
    return null;
  }

  const onPath = searchPath(fileName);
  if (onPath) {
    locateCache.set(key, onPath);
    return onPath;
  }

  for (const dir of commonBinaryDirsForPlatform(process.platform)) {
    const candidate = path.join(dir, fileName);
    if (isExecutableFile(candidate)) {
      locateCache.set(key, candidate);
      return candidate;
    }
  }
  locateCache.set(key, null);
  return null;
}

/**
 * Where the packaged app keeps its copy.
 *
 * In a packaged build extraResources land in resourcesPath; during development the
 * same files sit in resources/ at the repository root.
 */
function bundledDir(): string | null {
  const packaged = process.resourcesPath ? path.join(process.resourcesPath, 'tunnel') : null;
  if (packaged && existsSync(packaged)) return packaged;
  // Source: src/main/tunnel -> repo root is three levels up.
  // Packaged/compiled dev output keeps the same main/tunnel nesting under dist.
  const dev = path.resolve(__dirname, '..', '..', '..', 'resources', 'tunnel');
  return existsSync(dev) ? dev : null;
}

/** The bundled tunnel-client version, for the diagnostics panel. */
export function bundledVersion(): string | null {
  const dir = bundledDir();
  if (!dir) return null;
  if (bundledVersionCache.has(dir)) return bundledVersionCache.get(dir) ?? null;
  try {
    const value = readFileSync(path.join(dir, 'VERSION'), 'utf8').trim() || null;
    bundledVersionCache.set(dir, value);
    return value;
  } catch {
    bundledVersionCache.set(dir, null);
    return null;
  }
}

/** Test seam for environment/path-resolution cases. */
export function resetTunnelLocatorCacheForTests(): void {
  locateCache.clear();
  bundledVersionCache.clear();
}

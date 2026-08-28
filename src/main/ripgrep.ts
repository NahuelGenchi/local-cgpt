import { accessSync, constants, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathEntries } from './env.js';

export function ripgrepExecutableName(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'rg.exe' : 'rg';
}

function isExecutableFile(candidate: string): boolean {
  try {
    if (!existsSync(candidate) || !statSync(candidate).isFile()) return false;
    if (process.platform !== 'win32') accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Linux host-side search executes the selected rg outside Bubblewrap, so executable discovery is
 * itself a security boundary. In development the repo-local resources tree and inherited PATH can
 * both overlap an approved writable root; a model-controlled command could otherwise plant `rg`
 * there and make the next content search execute arbitrary host code. Only a packaged resource
 * (when Electron is not the default development app) or conventional root-managed system paths
 * may become host executable authority on Linux.
 */
export function trustedLinuxRipgrepCandidates(
  resourcesPath = process.resourcesPath ?? '',
  defaultApp = Boolean((process as NodeJS.Process & { defaultApp?: boolean }).defaultApp)
): string[] {
  return [
    ...(!defaultApp && resourcesPath ? [path.join(resourcesPath, 'rg', 'rg')] : []),
    '/usr/bin/rg',
    '/bin/rg'
  ];
}

/** Walk PATH by hand. This is acceptable only for callers that execute the result inside containment. */
function pathCandidate(): string | null {
  const fileName = ripgrepExecutableName();
  for (const raw of pathEntries()) {
    const dir = raw.trim().replace(/^"|"$/g, '');
    if (!dir) continue;
    const candidate = path.join(dir, fileName);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

/**
 * Locate rg for Bubblewrap-backed command workloads and diagnostics.
 *
 * The development resource and PATH candidates are intentionally retained here because this
 * executable is mounted into and invoked inside the Linux command sandbox; treating those same
 * candidates as host executable authority is forbidden by `locateHostRipgrep` below.
 */
export function locateRipgrep(): string | null {
  const fileName = ripgrepExecutableName();
  const packaged = process.resourcesPath ? path.join(process.resourcesPath, 'rg', fileName) : null;
  if (packaged && isExecutableFile(packaged)) return packaged;

  const dev = path.resolve(__dirname, '..', '..', 'resources', 'rg', fileName);
  if (isExecutableFile(dev)) return dev;
  return pathCandidate();
}

/** Locate a ripgrep executable that is safe to spawn directly in the unsandboxed host process. */
export function locateHostRipgrep(): string | null {
  if (process.platform !== 'linux') return locateRipgrep();
  for (const candidate of trustedLinuxRipgrepCandidates()) {
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

export function ripgrepVersionFile(): string | null {
  const executable = locateRipgrep();
  return executable ? path.join(path.dirname(executable), 'VERSION') : null;
}

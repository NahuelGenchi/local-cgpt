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
 * Root-managed candidates retained for provenance tests and for a future contained host-search
 * implementation. M0 does not execute any of them directly against an approved-root pathname:
 * even a trusted executable would still perform its own mutable pathname traversal and recreate
 * the check/use escape fixed by contained-fs.ts.
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

/**
 * Locate a ripgrep executable that is safe to spawn directly in the unsandboxed host process.
 *
 * Linux intentionally returns null. Executable provenance is not enough for Issue #18: rg would
 * independently reopen and walk the mutable approved-root pathname, outside the stable-FD layer.
 * The model-facing find implementation therefore uses its bounded in-process fallback on Linux.
 * Regex content search remains fail-closed until it can be executed against a stable kernel object.
 */
export function locateHostRipgrep(): string | null {
  if (process.platform === 'linux') return null;
  return locateRipgrep();
}

export function ripgrepVersionFile(): string | null {
  const executable = locateRipgrep();
  return executable ? path.join(path.dirname(executable), 'VERSION') : null;
}

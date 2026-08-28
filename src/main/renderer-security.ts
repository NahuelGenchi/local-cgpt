const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

/**
 * Development may use electron-vite's local HTTP renderer. Packaged builds never do.
 * Even in development, refuse non-loopback renderer origins so a privileged preload cannot
 * accidentally be attached to a remote page because the launch environment was poisoned.
 */
export function trustedDevelopmentRendererUrl(isPackaged: boolean, candidate: string | undefined): string | null {
  if (isPackaged || !candidate?.trim()) return null;
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!LOOPBACK_HOSTS.has(url.hostname)) return null;
    return url.href;
  } catch {
    return null;
  }
}

/** A privileged IPC request must come from the current top-level application renderer. */
export function trustedIpcSender(
  expectedWebContentsId: number | null,
  senderWebContentsId: number,
  senderIsMainFrame: boolean
): boolean {
  return expectedWebContentsId !== null && expectedWebContentsId === senderWebContentsId && senderIsMainFrame;
}

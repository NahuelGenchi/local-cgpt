import path from 'node:path';

/**
 * Keep hardened-fork state physically separate from upstream Chat On Steroids state.
 *
 * The fork deliberately preserves explicit choices within its own future migrations, but it must
 * never inherit permissions, recordings or encrypted-secret metadata from an upstream install
 * merely because Electron would otherwise derive the same userData directory from the inherited
 * application identity.
 */
export function hardenedUserDataPath(appDataPath: string): string {
  return path.join(appDataPath, 'local-cgpt');
}

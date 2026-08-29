import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { hardenedUserDataPath } from '../src/main/app-identity.js';

describe('hardenedUserDataPath', () => {
  it('uses a fork-owned state directory rather than the upstream application directory', () => {
    const appData = path.join(path.sep, 'home', 'user', '.config');
    expect(hardenedUserDataPath(appData)).toBe(path.join(appData, 'local-cgpt'));
  });

  it('is deterministic for the same platform app-data root', () => {
    const appData = path.join(path.sep, 'tmp', 'app-data');
    expect(hardenedUserDataPath(appData)).toBe(hardenedUserDataPath(appData));
  });
});

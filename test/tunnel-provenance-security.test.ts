import { describe, expect, it } from 'vitest';
import { trustedLinuxAutomaticBinaryDirs } from '../src/main/tunnel/locate.js';

describe('Linux tunnel executable provenance', () => {
  it('does not trust a development resources tree or per-user executable directory automatically', () => {
    const dirs = trustedLinuxAutomaticBinaryDirs('/approved/node_modules/electron/dist/resources', true);

    expect(dirs).toEqual(['/usr/bin', '/bin', '/snap/bin']);
    expect(dirs.some((candidate) => candidate.startsWith('/approved/'))).toBe(false);
    expect(dirs.some((candidate) => candidate.startsWith('/home/'))).toBe(false);
  });

  it('allows the packaged resource plus root-managed system fallbacks', () => {
    expect(trustedLinuxAutomaticBinaryDirs('/opt/Local-CGPT/resources', false)).toEqual([
      '/opt/Local-CGPT/resources/tunnel',
      '/usr/bin',
      '/bin',
      '/snap/bin'
    ]);
  });
});

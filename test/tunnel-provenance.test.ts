import { describe, expect, it } from 'vitest';
import { trustedLinuxAutomaticBinaryDirs } from '../src/main/tunnel/locate.js';

describe('Linux tunnel executable provenance', () => {
  it('does not treat development resources as automatic executable authority', () => {
    expect(trustedLinuxAutomaticBinaryDirs('/approved/node_modules/electron/dist/resources', true)).toEqual([
      '/usr/bin',
      '/bin',
      '/snap/bin'
    ]);
  });

  it('allows the reviewed packaged resource plus root-managed fallbacks', () => {
    expect(trustedLinuxAutomaticBinaryDirs('/opt/Local CGPT/resources', false)).toEqual([
      '/opt/Local CGPT/resources/tunnel',
      '/usr/bin',
      '/bin',
      '/snap/bin'
    ]);
  });
});

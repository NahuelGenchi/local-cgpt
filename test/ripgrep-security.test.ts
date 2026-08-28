import { describe, expect, it } from 'vitest';
import { trustedLinuxRipgrepCandidates } from '../src/main/ripgrep.js';

describe('Linux host ripgrep provenance', () => {
  it('does not trust the Electron development resources tree', () => {
    const candidates = trustedLinuxRipgrepCandidates('/approved/node_modules/electron/dist/resources', true);

    expect(candidates).toEqual(['/usr/bin/rg', '/bin/rg']);
    expect(candidates.some((candidate) => candidate.startsWith('/approved/'))).toBe(false);
  });

  it('allows the packaged resource plus root-managed system fallbacks', () => {
    expect(trustedLinuxRipgrepCandidates('/opt/Local-CGPT/resources', false)).toEqual([
      '/opt/Local-CGPT/resources/rg/rg',
      '/usr/bin/rg',
      '/bin/rg'
    ]);
  });
});

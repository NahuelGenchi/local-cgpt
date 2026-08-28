import { describe, expect, it } from 'vitest';
import { ambientBinaryFallbackAllowed } from '../src/main/tunnel/locate.js';

describe('packaged tunnel executable provenance', () => {
  it('allows ambient discovery for ordinary Node/test and stock Electron development runs', () => {
    expect(ambientBinaryFallbackAllowed(undefined, undefined)).toBe(true);
    expect(ambientBinaryFallbackAllowed('38.0.0', true)).toBe(true);
  });

  it('refuses PATH/common-location fallback in packaged Electron processes', () => {
    expect(ambientBinaryFallbackAllowed('38.0.0', false)).toBe(false);
    // Electron packaged processes normally leave defaultApp undefined. Treat that case as
    // packaged too rather than requiring an affirmative false value that may not exist.
    expect(ambientBinaryFallbackAllowed('38.0.0', undefined)).toBe(false);
  });
});

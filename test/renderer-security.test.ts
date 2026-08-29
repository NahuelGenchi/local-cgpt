import { describe, expect, it } from 'vitest';
import { trustedDevelopmentRendererUrl, trustedIpcSender } from '../src/main/renderer-security.js';

describe('trustedDevelopmentRendererUrl', () => {
  it('never accepts an environment renderer URL in packaged builds', () => {
    expect(trustedDevelopmentRendererUrl(true, 'https://example.com/renderer')).toBeNull();
    expect(trustedDevelopmentRendererUrl(true, 'http://127.0.0.1:5173')).toBeNull();
  });

  it('accepts only loopback HTTP(S) development renderers', () => {
    expect(trustedDevelopmentRendererUrl(false, 'http://127.0.0.1:5173')).toBe('http://127.0.0.1:5173/');
    expect(trustedDevelopmentRendererUrl(false, 'http://localhost:5173/app')).toBe('http://localhost:5173/app');
    expect(trustedDevelopmentRendererUrl(false, 'https://[::1]:5173')).toBe('https://[::1]:5173/');
    expect(trustedDevelopmentRendererUrl(false, 'https://example.com/renderer')).toBeNull();
    expect(trustedDevelopmentRendererUrl(false, 'file:///tmp/renderer.html')).toBeNull();
    expect(trustedDevelopmentRendererUrl(false, 'not a url')).toBeNull();
  });
});

describe('trustedIpcSender', () => {
  it('requires the current application webContents and its main frame', () => {
    expect(trustedIpcSender(7, 7, true)).toBe(true);
    expect(trustedIpcSender(7, 8, true)).toBe(false);
    expect(trustedIpcSender(7, 7, false)).toBe(false);
    expect(trustedIpcSender(null, 7, true)).toBe(false);
  });
});

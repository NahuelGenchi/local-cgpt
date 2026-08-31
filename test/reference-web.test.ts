import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REFERENCE_BYTES,
  listPublicReferences,
  MAX_REFERENCE_BYTES,
  pinnedReferenceRequestOptions,
  PublicReferenceError,
  readPublicReference,
  type ReferenceHttpResponse,
  type ResolvedReferenceAddress
} from '../src/main/reference-web.js';

const publicV4: ResolvedReferenceAddress = { address: '93.184.216.34', family: 4 };

function response(
  body: string,
  options: { statusCode?: number; contentType?: string; location?: string; encoding?: string } = {}
): ReferenceHttpResponse {
  return {
    statusCode: options.statusCode ?? 200,
    headers: {
      ...(options.contentType === undefined ? { 'content-type': 'text/plain; charset=utf-8' } : { 'content-type': options.contentType }),
      ...(options.location ? { location: options.location } : {}),
      ...(options.encoding ? { 'content-encoding': options.encoding } : {})
    },
    body: Buffer.from(body)
  };
}

describe('public reference catalog', () => {
  it('contains only unique exact HTTPS destinations with no model-parameter channel', () => {
    const references = listPublicReferences();
    expect(references.length).toBeGreaterThan(20);
    expect(new Set(references.map((entry) => entry.id)).size).toBe(references.length);
    expect(new Set(references.map((entry) => entry.url)).size).toBe(references.length);
    for (const entry of references) {
      const url = new URL(entry.url);
      expect(url.protocol).toBe('https:');
      expect(url.username).toBe('');
      expect(url.password).toBe('');
      expect(url.port).toBe('');
      expect(url.search).toBe('');
    }
  });

  it('returns the immutable catalog rather than repository-controlled data', () => {
    const references = listPublicReferences();
    expect(Object.isFrozen(references)).toBe(true);
    expect(Object.isFrozen(references[0])).toBe(true);
  });
});

describe('pinned public reference requests', () => {
  it('connects to the validated IP while preserving reviewed Host/SNI and credential-free headers', () => {
    process.env.HTTPS_PROXY = 'http://127.0.0.1:9999';
    process.env.HTTP_PROXY = 'http://127.0.0.1:9998';
    process.env.AUTHORIZATION = 'must-not-leak';
    const target = new URL('https://mgba-emu.github.io/gbatek/');
    const options = pinnedReferenceRequestOptions(target, publicV4);

    expect(options.hostname).toBe(publicV4.address);
    expect(options.family).toBe(4);
    expect(options.port).toBe(443);
    expect(options.servername).toBe(target.hostname);
    expect(options.method).toBe('GET');
    expect(options.path).toBe('/gbatek/');
    expect(options.agent).toBe(false);
    expect(options.rejectUnauthorized).toBe(true);
    expect(options.headers).toEqual({
      Host: 'mgba-emu.github.io',
      Accept: 'text/plain, text/markdown, text/html, application/json, application/xml, text/xml, application/xhtml+xml;q=0.9',
      'Accept-Encoding': 'identity',
      'User-Agent': 'local-cgpt-public-reference'
    });
    expect(JSON.stringify(options)).not.toContain('127.0.0.1:9999');
    expect(JSON.stringify(options)).not.toContain('must-not-leak');
  });
});

describe('public reference fetch policy', () => {
  it('fetches only the exact catalog target through a validated public address', async () => {
    const seen: string[] = [];
    const result = await readPublicReference('gbatek', DEFAULT_REFERENCE_BYTES, {
      resolve: async (hostname) => {
        expect(hostname).toBe('mgba-emu.github.io');
        return [publicV4];
      },
      request: async (target, address, maxBytes) => {
        seen.push(target.href);
        expect(address).toEqual(publicV4);
        expect(maxBytes).toBe(DEFAULT_REFERENCE_BYTES);
        return response('reference text');
      }
    });

    expect(seen).toEqual(['https://mgba-emu.github.io/gbatek/']);
    expect(result.reference.id).toBe('gbatek');
    expect(result.finalUrl).toBe('https://mgba-emu.github.io/gbatek/');
    expect(result.text).toBe('reference text');
    expect(result.redirects).toBe(0);
  });

  it('rejects unknown ids rather than treating them as URLs', async () => {
    await expect(
      readPublicReference('https://attacker.example/leak', DEFAULT_REFERENCE_BYTES, {
        resolve: async () => [publicV4],
        request: async () => response('never')
      })
    ).rejects.toThrow(/Unknown public reference id/i);
  });

  it.each([
    { address: '127.0.0.1', family: 4 as const },
    { address: '10.0.0.5', family: 4 as const },
    { address: '169.254.169.254', family: 4 as const },
    { address: '192.168.1.10', family: 4 as const },
    { address: '::1', family: 6 as const },
    { address: 'fe80::1', family: 6 as const },
    { address: 'fc00::1', family: 6 as const }
  ])('rejects SSRF resolution to $address before the request', async (blocked) => {
    let requested = false;
    await expect(
      readPublicReference('gbatek', DEFAULT_REFERENCE_BYTES, {
        resolve: async () => [blocked],
        request: async () => {
          requested = true;
          return response('never');
        }
      })
    ).rejects.toThrow(/public addresses|non-public/i);
    expect(requested).toBe(false);
  });

  it('rejects a DNS answer set containing any private fallback address', async () => {
    await expect(
      readPublicReference('gbatek', DEFAULT_REFERENCE_BYTES, {
        resolve: async () => [publicV4, { address: '127.0.0.1', family: 4 }],
        request: async () => response('never')
      })
    ).rejects.toThrow(/public addresses/i);
  });

  it('follows only same-host HTTPS redirects and re-resolves each hop', async () => {
    const resolved: string[] = [];
    const requested: string[] = [];
    const result = await readPublicReference('gbatek', DEFAULT_REFERENCE_BYTES, {
      resolve: async (hostname) => {
        resolved.push(hostname);
        return [publicV4];
      },
      request: async (target) => {
        requested.push(target.href);
        if (requested.length === 1) return response('', { statusCode: 302, location: '/gbatek/index.html' });
        return response('ok', { contentType: 'text/html; charset=utf-8' });
      }
    });

    expect(resolved).toEqual(['mgba-emu.github.io', 'mgba-emu.github.io']);
    expect(requested).toEqual([
      'https://mgba-emu.github.io/gbatek/',
      'https://mgba-emu.github.io/gbatek/index.html'
    ]);
    expect(result.redirects).toBe(1);
    expect(result.finalUrl).toBe('https://mgba-emu.github.io/gbatek/index.html');
  });

  it.each([
    'http://mgba-emu.github.io/gbatek/',
    'https://github.com/attacker',
    'https://user:pass@mgba-emu.github.io/gbatek/',
    'https://mgba-emu.github.io:444/gbatek/',
    'https://mgba-emu.github.io/gbatek/?leak=data'
  ])('rejects unsafe redirect %s', async (location) => {
    await expect(
      readPublicReference('gbatek', DEFAULT_REFERENCE_BYTES, {
        resolve: async () => [publicV4],
        request: async () => response('', { statusCode: 302, location })
      })
    ).rejects.toThrow(/unsafe redirect|outside its reviewed host|query parameters/i);
  });

  it('rejects redirect loops', async () => {
    await expect(
      readPublicReference('gbatek', DEFAULT_REFERENCE_BYTES, {
        resolve: async () => [publicV4],
        request: async () => response('', { statusCode: 302, location: '/gbatek/' })
      })
    ).rejects.toThrow(/redirect limit/i);
  });

  it('rejects compressed, binary, missing-type and oversized results', async () => {
    await expect(
      readPublicReference('gbatek', DEFAULT_REFERENCE_BYTES, {
        resolve: async () => [publicV4],
        request: async () => response('compressed', { encoding: 'gzip' })
      })
    ).rejects.toThrow(/content encoding/i);

    await expect(
      readPublicReference('gbatek', DEFAULT_REFERENCE_BYTES, {
        resolve: async () => [publicV4],
        request: async () => response('png', { contentType: 'image/png' })
      })
    ).rejects.toThrow(/content type/i);

    await expect(
      readPublicReference('gbatek', DEFAULT_REFERENCE_BYTES, {
        resolve: async () => [publicV4],
        request: async () => ({ statusCode: 200, headers: {}, body: Buffer.from('unknown') })
      })
    ).rejects.toThrow(/content type/i);

    await expect(
      readPublicReference('gbatek', 1024, {
        resolve: async () => [publicV4],
        request: async () => ({
          statusCode: 200,
          headers: { 'content-type': 'text/plain' },
          body: Buffer.alloc(1025, 0x61)
        })
      })
    ).rejects.toThrow(/byte limit/i);
  });

  it('rejects unsupported charsets and binary NULs', async () => {
    await expect(
      readPublicReference('gbatek', DEFAULT_REFERENCE_BYTES, {
        resolve: async () => [publicV4],
        request: async () => response('text', { contentType: 'text/plain; charset=utf-16' })
      })
    ).rejects.toThrow(/charset/i);

    await expect(
      readPublicReference('gbatek', DEFAULT_REFERENCE_BYTES, {
        resolve: async () => [publicV4],
        request: async () => response('a\u0000b')
      })
    ).rejects.toThrow(/binary NUL/i);
  });

  it('bounds the model-controlled max-bytes knob', async () => {
    await expect(readPublicReference('gbatek', 1000)).rejects.toBeInstanceOf(PublicReferenceError);
    await expect(readPublicReference('gbatek', MAX_REFERENCE_BYTES + 1)).rejects.toBeInstanceOf(PublicReferenceError);
  });
});

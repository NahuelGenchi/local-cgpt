import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REFERENCE_BYTES,
  listPublicReferences,
  MAX_REFERENCE_BYTES,
  MAX_REFERENCE_DOWNLOAD_BYTES,
  pinnedReferenceRequestOptions,
  PublicReferenceError,
  readPublicReference,
  searchPublicReference,
  type ReferenceHttpResponse,
  type ResolvedReferenceAddress
} from '../src/main/reference-web.js';

const publicV4: ResolvedReferenceAddress = { address: '93.184.216.34', family: 4 };
const gbatekUrl =
  'https://raw.githubusercontent.com/mgba-emu/gbatek/64b5087aa45cd0187b8b239d77e54ee5eb2917d1/index.md';

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
      if (entry.downloadBytes !== undefined) {
        expect(entry.downloadBytes).toBeGreaterThanOrEqual(DEFAULT_REFERENCE_BYTES);
        expect(entry.downloadBytes).toBeLessThanOrEqual(MAX_REFERENCE_DOWNLOAD_BYTES);
      }
    }

    const gbatek = references.find((entry) => entry.id === 'gbatek');
    expect(gbatek?.url).toBe(gbatekUrl);
    expect(gbatek?.downloadBytes).toBeGreaterThan(4_243_552);
  });

  it('returns the immutable catalog rather than repository-controlled data', () => {
    const references = listPublicReferences();
    expect(Object.isFrozen(references)).toBe(true);
    expect(Object.isFrozen(references[0])).toBe(true);
  });
});

describe('pinned public reference requests', () => {
  it('connects to the validated IP while preserving reviewed Host/SNI and credential-free headers', () => {
    const before = {
      HTTPS_PROXY: process.env.HTTPS_PROXY,
      HTTP_PROXY: process.env.HTTP_PROXY,
      AUTHORIZATION: process.env.AUTHORIZATION
    };
    try {
      process.env.HTTPS_PROXY = 'http://127.0.0.1:9999';
      process.env.HTTP_PROXY = 'http://127.0.0.1:9998';
      process.env.AUTHORIZATION = 'must-not-leak';
      const target = new URL(gbatekUrl);
      const options = pinnedReferenceRequestOptions(target, publicV4);

      expect(options.hostname).toBe(publicV4.address);
      expect(options.family).toBe(4);
      expect(options.port).toBe(443);
      expect(options.servername).toBe(target.hostname);
      expect(options.method).toBe('GET');
      expect(options.path).toBe('/mgba-emu/gbatek/64b5087aa45cd0187b8b239d77e54ee5eb2917d1/index.md');
      expect(options.agent).toBe(false);
      expect(options.rejectUnauthorized).toBe(true);
      expect(options.headers).toEqual({
        Host: 'raw.githubusercontent.com',
        Accept: 'text/plain, text/markdown, text/html, application/json, application/xml, text/xml, application/xhtml+xml;q=0.9',
        'Accept-Encoding': 'identity',
        'User-Agent': 'local-cgpt-public-reference'
      });
      expect(JSON.stringify(options)).not.toContain('127.0.0.1:9999');
      expect(JSON.stringify(options)).not.toContain('must-not-leak');
    } finally {
      for (const [key, value] of Object.entries(before)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

describe('public reference fetch policy', () => {
  it('fetches only the exact catalog target through a validated public address', async () => {
    const seen: string[] = [];
    const result = await readPublicReference('gbatek', DEFAULT_REFERENCE_BYTES, {
      resolve: async (hostname) => {
        expect(hostname).toBe('raw.githubusercontent.com');
        return [publicV4];
      },
      request: async (target, address, maxBytes) => {
        seen.push(target.href);
        expect(address).toEqual(publicV4);
        expect(maxBytes).toBe(4_300_000);
        return response('reference text');
      }
    });

    expect(seen).toEqual([gbatekUrl]);
    expect(result.reference.id).toBe('gbatek');
    expect(result.finalUrl).toBe(gbatekUrl);
    expect(result.text).toBe('reference text');
    expect(result.returnedBytes).toBe(Buffer.byteLength('reference text'));
    expect(result.truncated).toBe(false);
    expect(result.redirects).toBe(0);
  });

  it('uses a catalog-owned larger download ceiling while keeping model output bounded', async () => {
    const body = 'A'.repeat(DEFAULT_REFERENCE_BYTES + 8_000);
    const result = await readPublicReference('gbatek', DEFAULT_REFERENCE_BYTES, {
      resolve: async () => [publicV4],
      request: async (_target, _address, maxBytes) => {
        expect(maxBytes).toBe(4_300_000);
        return response(body, { contentType: 'text/markdown; charset=utf-8' });
      }
    });

    expect(result.bytes).toBe(Buffer.byteLength(body));
    expect(result.returnedBytes).toBe(DEFAULT_REFERENCE_BYTES);
    expect(Buffer.byteLength(result.text, 'utf8')).toBe(DEFAULT_REFERENCE_BYTES);
    expect(result.truncated).toBe(true);
  });

  it('searches large references only after the fixed request and never sends the query', async () => {
    const secretLookingQuery = 'WORLD_ROM_ROOM_GEOMETRY_GRID_MISALIGNED';
    const seen: string[] = [];
    const result = await searchPublicReference('gbatek', secretLookingQuery, {
      resolve: async (hostname) => {
        expect(hostname).toBe('raw.githubusercontent.com');
        return [publicV4];
      },
      request: async (target, _address, maxBytes) => {
        seen.push(target.href);
        expect(maxBytes).toBe(4_300_000);
        expect(target.href).not.toContain(secretLookingQuery);
        return response(`before\n${secretLookingQuery}\nafter`, { contentType: 'text/markdown' });
      }
    });

    expect(seen).toEqual([gbatekUrl]);
    expect(result.matches).toBe(1);
    expect(result.moreMatches).toBe(false);
    expect(result.text).toContain(secretLookingQuery);
    expect(result.returnedBytes).toBeLessThanOrEqual(64 * 1024);
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
    const result = await readPublicReference('ndspy', DEFAULT_REFERENCE_BYTES, {
      resolve: async (hostname) => {
        resolved.push(hostname);
        return [publicV4];
      },
      request: async (target) => {
        requested.push(target.href);
        if (requested.length === 1) return response('', { statusCode: 302, location: '/en/latest/index.html' });
        return response('ok', { contentType: 'text/html; charset=utf-8' });
      }
    });

    expect(resolved).toEqual(['ndspy.readthedocs.io', 'ndspy.readthedocs.io']);
    expect(requested).toEqual([
      'https://ndspy.readthedocs.io/en/latest/',
      'https://ndspy.readthedocs.io/en/latest/index.html'
    ]);
    expect(result.redirects).toBe(1);
    expect(result.finalUrl).toBe('https://ndspy.readthedocs.io/en/latest/index.html');
  });

  it.each([
    'http://ndspy.readthedocs.io/en/latest/',
    'https://github.com/attacker',
    'https://user:pass@ndspy.readthedocs.io/en/latest/',
    'https://ndspy.readthedocs.io:444/en/latest/',
    'https://ndspy.readthedocs.io/en/latest/?leak=data'
  ])('rejects unsafe redirect %s', async (location) => {
    await expect(
      readPublicReference('ndspy', DEFAULT_REFERENCE_BYTES, {
        resolve: async () => [publicV4],
        request: async () => response('', { statusCode: 302, location })
      })
    ).rejects.toThrow(/unsafe redirect|outside its reviewed host|query parameters/i);
  });

  it('rejects redirect loops', async () => {
    await expect(
      readPublicReference('ndspy', DEFAULT_REFERENCE_BYTES, {
        resolve: async () => [publicV4],
        request: async () => response('', { statusCode: 302, location: '/en/latest/' })
      })
    ).rejects.toThrow(/redirect limit/i);
  });

  it('rejects compressed, binary, missing-type and oversized downloads', async () => {
    await expect(
      readPublicReference('ndspy', DEFAULT_REFERENCE_BYTES, {
        resolve: async () => [publicV4],
        request: async () => response('compressed', { encoding: 'gzip' })
      })
    ).rejects.toThrow(/content encoding/i);

    await expect(
      readPublicReference('ndspy', DEFAULT_REFERENCE_BYTES, {
        resolve: async () => [publicV4],
        request: async () => response('png', { contentType: 'image/png' })
      })
    ).rejects.toThrow(/content type/i);

    await expect(
      readPublicReference('ndspy', DEFAULT_REFERENCE_BYTES, {
        resolve: async () => [publicV4],
        request: async () => ({ statusCode: 200, headers: {}, body: Buffer.from('unknown') })
      })
    ).rejects.toThrow(/content type/i);

    await expect(
      readPublicReference('ndspy', 1024, {
        resolve: async () => [publicV4],
        request: async (_target, _address, maxBytes) => {
          expect(maxBytes).toBe(1024);
          return {
            statusCode: 200,
            headers: { 'content-type': 'text/plain' },
            body: Buffer.alloc(1025, 0x61)
          };
        }
      })
    ).rejects.toThrow(/download limit/i);

    await expect(
      readPublicReference('gbatek', DEFAULT_REFERENCE_BYTES, {
        resolve: async () => [publicV4],
        request: async () => ({
          statusCode: 200,
          headers: { 'content-type': 'text/plain' },
          body: Buffer.alloc(4_300_001, 0x61)
        })
      })
    ).rejects.toThrow(/download limit/i);
  });

  it('rejects unsupported charsets and binary NULs', async () => {
    await expect(
      readPublicReference('ndspy', DEFAULT_REFERENCE_BYTES, {
        resolve: async () => [publicV4],
        request: async () => response('text', { contentType: 'text/plain; charset=utf-16' })
      })
    ).rejects.toThrow(/charset/i);

    await expect(
      readPublicReference('ndspy', DEFAULT_REFERENCE_BYTES, {
        resolve: async () => [publicV4],
        request: async () => response('a\u0000b')
      })
    ).rejects.toThrow(/binary NUL/i);
  });

  it('bounds the internal model-output byte knob', async () => {
    await expect(readPublicReference('gbatek', 1000)).rejects.toBeInstanceOf(PublicReferenceError);
    await expect(readPublicReference('gbatek', MAX_REFERENCE_BYTES + 1)).rejects.toBeInstanceOf(PublicReferenceError);
  });

  it('bounds local search input without turning it into a network parameter', async () => {
    await expect(searchPublicReference('gbatek', '   ')).rejects.toBeInstanceOf(PublicReferenceError);
    await expect(searchPublicReference('gbatek', 'x'.repeat(161))).rejects.toBeInstanceOf(PublicReferenceError);
  });
});

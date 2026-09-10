/** Patch-level dependency acceptance: synthetic images only, no private inputs. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));

describe('reviewed dependency security baseline', () => {
  it('locks the reviewed patch versions and registry integrity', () => {
    expect(pkg.dependencies.sharp).toBe('0.35.4');
    expect(lock.packages[''].dependencies.sharp).toBe(pkg.dependencies.sharp);
    for (const [name, version] of [['sharp', '0.35.4'], ['hono', '4.13.7']]) {
      const entry = lock.packages[`node_modules/${name}`];
      expect(entry.version).toBe(version);
      expect(entry.resolved).toMatch(/^https:\/\/registry\.npmjs\.org\//);
      expect(entry.integrity).toMatch(/^sha512-/);
    }
  });

  it.each(['png', 'avif'] as const)('decodes and resizes a real synthetic %s with the patched native runtime', async (format) => {
    const source = sharp({ create: { width: 16, height: 12, channels: 4, background: '#2468ac' } });
    const encoded = await source.toFormat(format).toBuffer();
    const result = await sharp(encoded, { limitInputPixels: 1024 }).resize(8, 6).png().toBuffer({ resolveWithObject: true });
    expect(result.info.width).toBe(8);
    expect(result.info.height).toBe(6);
    expect(result.info.format).toBe('png');
    expect(result.data.length).toBeGreaterThan(0);
  });

  it('retains input rejection and decoded-pixel limits', async () => {
    await expect(sharp(Buffer.from('not an image')).toBuffer()).rejects.toThrow();
    const encoded = await sharp({ create: { width: 16, height: 12, channels: 3, background: '#2468ac' } }).png().toBuffer();
    await expect(sharp(encoded, { limitInputPixels: 100 }).toBuffer()).rejects.toThrow(/pixel limit/i);
  });
});

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

async function rendererFiles(dir = path.join(process.cwd(), 'src', 'renderer')): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await rendererFiles(target)));
    else if (/\.(?:ts|html|css)$/.test(entry.name)) files.push(target);
  }
  return files;
}

describe('desktop product identity', () => {
  it('keeps legacy branding out of desktop front-end sources', async () => {
    const files = await rendererFiles();
    files.push(path.join(process.cwd(), 'src', 'main', 'index.ts'));
    for (const file of files) {
      const source = await fs.readFile(file, 'utf8');
      expect(source, path.relative(process.cwd(), file)).not.toMatch(/Chat On Steroids/i);
    }
  });

  it('uses local-cgpt in both renderer and native window identity', async () => {
    const [html, main] = await Promise.all([
      fs.readFile(path.join(process.cwd(), 'src', 'renderer', 'index.html'), 'utf8'),
      fs.readFile(path.join(process.cwd(), 'src', 'main', 'index.ts'), 'utf8')
    ]);
    expect(html).toContain('<title>local-cgpt</title>');
    expect(html).toMatch(/class="title">\s*local-cgpt/);
    expect(main).toContain("title: 'local-cgpt'");
    expect(main).toContain('local-cgpt —');
  });

  it('injects version and exact source revision without a build timestamp', async () => {
    const [vite, buildInfo] = await Promise.all([
      fs.readFile(path.join(process.cwd(), 'electron.vite.config.ts'), 'utf8'),
      fs.readFile(path.join(process.cwd(), 'src', 'renderer', 'build-info.ts'), 'utf8')
    ]);
    expect(vite).toContain('__LOCAL_CGPT_APP_VERSION__');
    expect(vite).toContain('__LOCAL_CGPT_SOURCE_REVISION__');
    expect(vite).toContain("execFileSync('git', ['rev-parse', 'HEAD']");
    expect(vite).not.toMatch(/build(?:ed)?At|Date\.now\(\)|new Date\(/i);
    expect(buildInfo).toContain("fact('App version'");
    expect(buildInfo).toContain("'Source revision'");
    expect(buildInfo).toContain("slice(0, 12)");
  });
});

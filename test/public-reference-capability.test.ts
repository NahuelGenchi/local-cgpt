import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultConfig, initConfigPath, loadConfig } from '../src/main/config.js';
import { registerPublicReferenceTool } from '../src/main/mcp/reference-tool.js';
import { requiresApprovedFilesystemRoot } from '../src/shared/capabilities.js';
import { DEFAULT_CAPABILITIES, WRITE_CAPABILITIES, type Capabilities } from '../src/shared/types.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let configDir: string;

beforeAll(async () => {
  configDir = await makeTempDir('clf-public-reference-config-');
  initConfigPath(configDir);
});

afterAll(async () => {
  await removeTempDir(configDir);
});

describe('public-reference capability defaults and migration', () => {
  it('defaults the new egress authority off and keeps it outside read-only write authority', () => {
    expect(DEFAULT_CAPABILITIES.publicReference).toBe(false);
    expect(defaultConfig('linux').capabilities.publicReference).toBe(false);
    expect(WRITE_CAPABILITIES).not.toContain('publicReference');

    const capabilities: Capabilities = { ...DEFAULT_CAPABILITIES, publicReference: true };
    expect(requiresApprovedFilesystemRoot({ capabilities, readOnly: true })).toBe(false);
  });

  it('loads a pre-feature config with public-reference authority still off', async () => {
    const current = defaultConfig('linux');
    const capabilities = { ...current.capabilities, read: true } as Record<string, boolean>;
    delete capabilities.publicReference;
    const legacy = {
      ...current,
      roots: [{ name: 'project', path: '/tmp/existing-approved-project' }],
      capabilities
    };
    await fs.writeFile(path.join(configDir, 'config.json'), JSON.stringify(legacy), 'utf8');

    const loaded = await loadConfig();
    expect(loaded.capabilities.read).toBe(true);
    expect(loaded.capabilities.publicReference).toBe(false);
    expect(loaded.roots).toEqual(legacy.roots);
  });
});

describe('public-reference model-facing authority', () => {
  function registeredTool() {
    const liveCaps: Capabilities = { ...DEFAULT_CAPABILITIES, publicReference: true };
    let captured:
      | {
          config: { inputSchema: { safeParse: (value: unknown) => { success: boolean } } };
          handler: (input: any) => Promise<any>;
        }
      | undefined;

    const registrar = {
      caps: liveCaps,
      exposedCaps: { ...liveCaps },
      register(name: string, config: any, handler: (input: any) => Promise<any>) {
        expect(name).toBe('reference_web');
        captured = { config, handler };
      },
      guarded(capability: keyof Capabilities, name: string, fn: () => Promise<any>) {
        expect(capability).toBe('publicReference');
        expect(name).toBe('reference_web');
        if (!liveCaps[capability]) {
          return Promise.resolve({
            content: [{ type: 'text', text: `TOOL_DISABLED: ${name} is disabled` }],
            isError: true
          });
        }
        return fn();
      }
    };

    registerPublicReferenceTool(registrar as never);
    expect(captured).toBeDefined();
    return { liveCaps, tool: captured! };
  }

  it('accepts only catalog selection fields and rejects arbitrary request parameters', () => {
    const { tool } = registeredTool();
    const schema = tool.config.inputSchema;

    expect(schema.safeParse({ action: 'list' }).success).toBe(true);
    expect(schema.safeParse({ action: 'read', reference: 'gbatek' }).success).toBe(true);
    expect(schema.safeParse({ action: 'read' }).success).toBe(false);

    for (const field of [
      'url',
      'host',
      'hostname',
      'path',
      'query',
      'headers',
      'method',
      'body',
      'repository',
      'max_bytes'
    ]) {
      expect(
        schema.safeParse({ action: 'read', reference: 'gbatek', [field]: 'attacker-controlled' }).success,
        field
      ).toBe(false);
    }
  });

  it('keeps a cached tool callable only as a refusal after live authority is revoked', async () => {
    const { liveCaps, tool } = registeredTool();
    const before = await tool.handler({ action: 'list' });
    expect(before.isError).not.toBe(true);
    expect(before.structuredContent?.action).toBe('list');

    liveCaps.publicReference = false;
    const after = await tool.handler({ action: 'list' });
    expect(after.isError).toBe(true);
    expect(after.content[0]?.text).toContain('TOOL_DISABLED');
  });
});

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultConfig, initConfigPath, loadConfig, saveConfig, updateConfig } from '../src/main/config.js';
import type { Capability } from '../src/shared/types.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let dir: string;

beforeAll(async () => {
  dir = await makeTempDir('clf-config-');
  initConfigPath(dir);
});

afterAll(async () => {
  await removeTempDir(dir);
});

describe('settings migration', () => {
  it('never leaves Goal enabled while session recording is off', async () => {
    const impossible = {
      ...defaultConfig(),
      sessions: { ...defaultConfig().sessions, record: false },
      goal: { ...defaultConfig().goal, enabled: true }
    };

    const saved = await saveConfig(impossible);
    expect(saved.sessions.record).toBe(false);
    expect(saved.goal.enabled).toBe(false);

    await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify(impossible), 'utf8');
    const loaded = await loadConfig();
    expect(loaded.sessions.record).toBe(false);
    expect(loaded.goal.enabled).toBe(false);
  });

  it('preserves old settings when new safe-default capabilities and UI prefs are added', async () => {
    const oldConfig = {
      roots: [{ name: 'project', path: 'C:\\Users\\example\\project' }],
      capabilities: {
        browse: true,
        search: true,
        read: true,
        metadata: true,
        create: true,
        edit: true,
        move: false,
        deleteFile: false,
        powershell: true,
        command: true,
        screen: true,
        control: true
      },
      readOnly: false,
      tunnel: {
        kind: 'openai',
        tunnelId: 'tunnel_0123456789abcdef0123456789abcdef',
        binaryPath: ''
      },
      ui: { minimizeToTray: true, autoConnect: true }
    };
    await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify(oldConfig), 'utf8');

    const loaded = await loadConfig();
    expect(loaded.roots).toEqual(oldConfig.roots);
    expect(loaded.capabilities.create).toBe(true);
    expect(loaded.capabilities.clipboardRead).toBe(false);
    expect(loaded.capabilities.clipboardWrite).toBe(false);
    expect(loaded.ui.autoConnect).toBe(true);
    expect(loaded.ui.privacyScreenshots).toBe(false);
    expect(loaded.tunnel.tunnelId).toBe(oldConfig.tunnel.tunnelId);
    expect(loaded.tunnel.desktopTunnelId).toBe('');
  });

  it('folds a PowerShell-only permission into the single command permission', async () => {
    await fs.writeFile(
      path.join(dir, 'config.json'),
      JSON.stringify({
        ...defaultConfig(),
        capabilities: {
          ...defaultConfig().capabilities,
          command: false,
          deleteFile: false,
          powershell: true,
          deleteFolder: true
        }
      }),
      'utf8'
    );
    const loaded = await loadConfig();
    expect(loaded.capabilities.command).toBe(true);
    expect(Object.keys(loaded.capabilities)).not.toContain('powershell');
    expect(Object.keys(loaded.capabilities)).not.toContain('deleteFolder');
    expect(loaded.capabilities.deleteFile).toBe(false);
  });

  it('renames a saved root that claims a reserved virtual namespace', async () => {
    await fs.writeFile(
      path.join(dir, 'config.json'),
      JSON.stringify({ ...defaultConfig(), roots: [{ name: 'skills', path: 'C:\\Users\\example\\skills' }] }),
      'utf8'
    );
    const loaded = await loadConfig();
    expect(loaded.roots[0]?.name).toBe('skills-folder');
    expect(loaded.roots[0]?.path).toBe('C:\\Users\\example\\skills');
  });

  it('keeps reserved-name migration from creating duplicate virtual roots', async () => {
    await fs.writeFile(
      path.join(dir, 'config.json'),
      JSON.stringify({
        ...defaultConfig(),
        roots: [
          { name: 'skills-folder', path: 'C:\\Users\\example\\already-there' },
          { name: 'skills', path: 'C:\\Users\\example\\legacy-skills' },
          { name: 'skills-folder', path: 'C:\\Users\\example\\duplicate' }
        ]
      }),
      'utf8'
    );
    const loaded = await loadConfig();
    expect(loaded.roots.map((root) => root.name)).toEqual(['skills-folder', 'skills-folder-2', 'skills-folder-3']);
    expect(new Set(loaded.roots.map((root) => root.name)).size).toBe(loaded.roots.length);
  });

  it('round-trips a second tunnel id for the Desktop connector', async () => {
    const config = defaultConfig();
    await saveConfig({
      ...config,
      tunnel: {
        ...config.tunnel,
        tunnelId: 'tunnel_0123456789abcdef0123456789abcdef',
        desktopTunnelId: 'tunnel_fedcba9876543210fedcba9876543210'
      }
    });
    const loaded = await loadConfig();
    expect(loaded.tunnel.tunnelId).toBe('tunnel_0123456789abcdef0123456789abcdef');
    expect(loaded.tunnel.desktopTunnelId).toBe('tunnel_fedcba9876543210fedcba9876543210');
  });

  it('starts with automatic compaction off at the advisory line', async () => {
    await saveConfig(defaultConfig());
    const loaded = await loadConfig();
    expect(loaded.compaction.auto).toBe(false);
    expect(loaded.compaction.autoTokens).toBe(loaded.sessions.advisoryTokens);
    expect(loaded.compaction.autoTokens).toBe(400_000);
  });

  it('ships a red line the settings panel would have derived itself', async () => {
    const config = defaultConfig();
    expect(config.sessions.advisoryTokens).toBe(config.compaction.autoTokens);
    expect(config.sessions.limitTokens).toBe(Math.round((config.compaction.autoTokens * 4) / 3));
  });

  it('moves an untouched old default onto the new one without enabling it', async () => {
    const config = defaultConfig();
    await saveConfig({ ...config, compaction: { ...config.compaction, auto: false, autoTokens: 300_000 } });
    const loaded = await loadConfig();
    expect(loaded.compaction.auto).toBe(false);
    expect(loaded.compaction.autoTokens).toBe(400_000);
  });

  it('moves the untouched 1.8 automatic default up to the wider window', async () => {
    const config = defaultConfig();
    await saveConfig({ ...config, compaction: { ...config.compaction, auto: true, autoTokens: 300_000 } });
    const loaded = await loadConfig();
    expect(loaded.compaction).toMatchObject({ auto: true, autoTokens: 400_000 });
  });

  it('leaves a config already at the wider window alone', async () => {
    const config = defaultConfig();
    await saveConfig({ ...config, compaction: { ...config.compaction, auto: true, autoTokens: 400_000 } });
    const loaded = await loadConfig();
    expect(loaded.compaction).toMatchObject({ auto: true, autoTokens: 400_000 });
  });

  it('recalibrates an untouched meter pair and leaves a chosen one', async () => {
    const config = defaultConfig();
    await saveConfig({ ...config, sessions: { ...config.sessions, advisoryTokens: 300_000, limitTokens: 400_000 } });
    const moved = await loadConfig();
    expect(moved.sessions.advisoryTokens).toBe(400_000);
    expect(moved.sessions.limitTokens).toBe(Math.round((400_000 * 4) / 3));

    await saveConfig({ ...config, sessions: { ...config.sessions, advisoryTokens: 300_000, limitTokens: 350_000 } });
    const kept = await loadConfig();
    expect(kept.sessions).toMatchObject({ advisoryTokens: 300_000, limitTokens: 350_000 });
  });

  it('leaves a user who turned automatic compaction off turned off', async () => {
    const config = defaultConfig();
    await saveConfig({ ...config, compaction: { ...config.compaction, auto: false, autoTokens: 250_000 } });
    const loaded = await loadConfig();
    expect(loaded.compaction.auto).toBe(false);
    expect(loaded.compaction.autoTokens).toBe(250_000);
  });

  it('keeps an automatic compaction the user configured', async () => {
    const config = defaultConfig();
    await saveConfig({ ...config, compaction: { ...config.compaction, auto: true, autoTokens: 150_000 } });
    const loaded = await loadConfig();
    expect(loaded.compaction).toMatchObject({ auto: true, autoTokens: 150_000 });
  });

  it('keeps the meter threshold aligned with a high automatic-compaction threshold', async () => {
    const config = defaultConfig();
    await saveConfig({
      ...config,
      sessions: { ...config.sessions, advisoryTokens: 3_000_000, limitTokens: 4_000_000 },
      compaction: { ...config.compaction, auto: true, autoTokens: 3_000_000 }
    });
    const loaded = await loadConfig();
    expect(loaded.compaction.autoTokens).toBe(3_000_000);
    expect(loaded.sessions.advisoryTokens).toBe(3_000_000);
    expect(loaded.sessions.limitTokens).toBe(4_000_000);
  });

  it('reads a config from before the setting existed as the current default', async () => {
    const config = defaultConfig();
    const older = { ...config, compaction: { ...config.compaction } } as Record<string, any>;
    delete older.compaction.auto;
    delete older.compaction.autoTokens;
    await saveConfig(older as ReturnType<typeof defaultConfig>);
    const loaded = await loadConfig();
    expect(loaded.compaction.auto).toBe(false);
    expect(loaded.compaction.autoTokens).toBe(400_000);
  });

  it('serializes concurrent read-modify-write changes instead of losing one', async () => {
    await saveConfig(defaultConfig());
    const first = updateConfig(async (config) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { ...config, roots: [{ name: 'project', path: 'C:\\Users\\example\\project' }] };
    });
    const second = updateConfig((config) => ({ ...config, ui: { ...config.ui, theme: 'dark' as const } }));
    await Promise.all([first, second]);

    const loaded = await loadConfig();
    expect(loaded.roots).toEqual([{ name: 'project', path: 'C:\\Users\\example\\project' }]);
    expect(loaded.ui.theme).toBe('dark');
  });
});

describe('shipped defaults', () => {
  it('does not record sessions from first launch', () => {
    expect(defaultConfig().sessions.record).toBe(false);
  });

  it('loads a genuinely missing config with no model-facing permissions', async () => {
    await fs.rm(path.join(dir, 'config.json'), { force: true });
    const loaded = await loadConfig();
    expect(loaded.readOnly).toBe(true);
    for (const [capability, enabled] of Object.entries(loaded.capabilities) as Array<[Capability, boolean]>) {
      expect(enabled, capability).toBe(false);
    }
    expect(loaded.multiAgent.enabled).toBe(false);
    expect(loaded.compaction.auto).toBe(false);
    expect(loaded.sessions.record).toBe(false);
  });

  it.each(['win32', 'darwin', 'linux'] as const)(
    'starts with every model-facing capability disabled on %s',
    (platform) => {
      const config = defaultConfig(platform);
      expect(config.readOnly).toBe(true);
      for (const [capability, enabled] of Object.entries(config.capabilities) as Array<[Capability, boolean]>) {
        expect(enabled, `${platform}:${capability}`).toBe(false);
      }
      expect(config.multiAgent.enabled).toBe(false);
      expect(config.multiAgent.maxWorkers).toBe(2);
      expect(config.sessions.record).toBe(false);
      expect(config.compaction.auto).toBe(false);
    }
  );

  it('does not widen omitted permissions or agents exposure in an existing legacy config', async () => {
    const legacy = {
      roots: [],
      capabilities: { browse: true, search: true, read: true, metadata: true },
      readOnly: true,
      tunnel: { kind: 'openai', tunnelId: '', binaryPath: '' },
      ui: { minimizeToTray: true, autoConnect: false }
    };
    await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify(legacy), 'utf8');
    const loaded = await loadConfig();
    expect(loaded.capabilities.command).toBe(false);
    expect(loaded.capabilities.control).toBe(false);
    expect(loaded.multiAgent.enabled).toBe(false);
    expect(loaded.readOnly).toBe(true);
  });

  it('does not turn config corruption into permission consent', async () => {
    await fs.writeFile(path.join(dir, 'config.json'), '{ definitely-not-json', 'utf8');
    const loaded = await loadConfig();
    expect(loaded.readOnly).toBe(true);
    expect(loaded.capabilities.command).toBe(false);
    expect(loaded.capabilities.control).toBe(false);
    expect(loaded.multiAgent.enabled).toBe(false);
  });

  it('leaves an existing choice to record alone', async () => {
    const config = defaultConfig();
    await saveConfig({ ...config, sessions: { ...config.sessions, record: true } });
    expect((await loadConfig()).sessions.record).toBe(true);
  });

  it('applies the privacy-first default to a config written before the setting existed', async () => {
    const before = defaultConfig() as unknown as Record<string, unknown>;
    const { sessions: _dropped, ...withoutSessions } = before;
    await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify(withoutSessions), 'utf8');
    expect((await loadConfig()).sessions.record).toBe(false);
  });
});

describe('the goal loop settings', () => {
  it('is off out of the box', () => {
    const config = defaultConfig();
    expect(config.goal.enabled).toBe(false);
    expect(config.goal.model).toBe('~deepseek/deepseek-v4-flash-latest');
    expect(config.goal.reasoning).toBe('default');
    expect(config.goal.prompt).toContain('Your job is to prompt ChatGPT');
    expect(config.goal.prompt).toContain('Nobody handed you a separate goal');
    expect(config.goal.objectivePrompt).toContain('Your job is to prompt ChatGPT');
    expect(config.goal.objectivePrompt).toContain('they have handed you the wheel');
  });

  it('keeps the model, reasoning level and system prompt that were chosen', async () => {
    const prompt = 'Custom continuation gate. Reply NO_REPLY when finished.';
    const objectivePrompt = 'Custom goal driver. Reply NO_REPLY once the goal is reached.';
    const base = defaultConfig();
    await saveConfig({
      ...base,
      sessions: { ...base.sessions, record: true },
      goal: {
        ...base.goal,
        enabled: true,
        model: 'openai/gpt-5.2-mini:nitro',
        reasoning: 'high',
        prompt,
        objectivePrompt
      }
    });
    expect((await loadConfig()).goal).toEqual({
      enabled: true,
      model: 'openai/gpt-5.2-mini:nitro',
      reasoning: 'high',
      prompt,
      objectivePrompt
    });
  });

  it('upgrades only the exact previous shipped prompt and preserves customized prompts', async () => {
    const { PREVIOUS_DEFAULT_GOAL_SYSTEM_PROMPT } = await import('../src/shared/goal.js');
    const config = defaultConfig();
    await fs.writeFile(
      path.join(dir, 'config.json'),
      JSON.stringify({ ...config, goal: { ...config.goal, prompt: PREVIOUS_DEFAULT_GOAL_SYSTEM_PROMPT } }),
      'utf8'
    );
    expect((await loadConfig()).goal.prompt).toBe(defaultConfig().goal.prompt);

    const customized = `${PREVIOUS_DEFAULT_GOAL_SYSTEM_PROMPT}\ncustom sentence`;
    await fs.writeFile(
      path.join(dir, 'config.json'),
      JSON.stringify({ ...config, goal: { ...config.goal, prompt: customized } }),
      'utf8'
    );
    expect((await loadConfig()).goal.prompt).toBe(customized);
  });

  it('upgrades an untouched default from any earlier version, not just the last one', async () => {
    const { SUPERSEDED_GOAL_SYSTEM_PROMPTS } = await import('../src/shared/goal.js');
    const config = defaultConfig();
    for (const superseded of SUPERSEDED_GOAL_SYSTEM_PROMPTS) {
      await fs.writeFile(
        path.join(dir, 'config.json'),
        JSON.stringify({ ...config, goal: { ...config.goal, prompt: superseded } }),
        'utf8'
      );
      expect((await loadConfig()).goal.prompt).toBe(defaultConfig().goal.prompt);
    }
  });

  it('repairs a blank goal driver prompt to its shipped default', async () => {
    const config = defaultConfig();
    await fs.writeFile(
      path.join(dir, 'config.json'),
      JSON.stringify({ ...config, goal: { ...config.goal, objectivePrompt: '   ' } }),
      'utf8'
    );
    expect((await loadConfig()).goal.objectivePrompt).toBe(defaultConfig().goal.objectivePrompt);
  });

  it('repairs a blank model id rather than refusing the whole config', async () => {
    const config = defaultConfig();
    await fs.writeFile(
      path.join(dir, 'config.json'),
      JSON.stringify({
        ...config,
        sessions: { ...config.sessions, record: true },
        goal: { enabled: true, model: '   ', reasoning: 'low' }
      }),
      'utf8'
    );
    const loaded = await loadConfig();
    expect(loaded.goal.model).toBe('~deepseek/deepseek-v4-flash-latest');
    expect(loaded.goal.prompt).toBe(defaultConfig().goal.prompt);
    expect(loaded.goal.enabled).toBe(true);
    expect(loaded.roots).toEqual(config.roots);
  });

  it('adds the section to a config written before the loop existed', async () => {
    const before = defaultConfig() as unknown as Record<string, unknown>;
    const { goal: _dropped, ...withoutGoal } = before;
    await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify(withoutGoal), 'utf8');
    expect((await loadConfig()).goal).toEqual({
      enabled: false,
      model: '~deepseek/deepseek-v4-flash-latest',
      reasoning: 'default',
      prompt: defaultConfig().goal.prompt,
      objectivePrompt: defaultConfig().goal.objectivePrompt
    });
  });

  it('repairs a blank prompt to the safe continuation-gate default', async () => {
    const config = defaultConfig();
    await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify({ ...config, goal: { ...config.goal, prompt: '   ' } }), 'utf8');
    expect((await loadConfig()).goal.prompt).toBe(defaultConfig().goal.prompt);
  });

  it('repairs an invalid prompt without discarding unrelated settings', async () => {
    const config = { ...defaultConfig(), roots: [{ name: 'project', path: 'C:\\Users\\example\\project' }] };
    await fs.writeFile(
      path.join(dir, 'config.json'),
      JSON.stringify({ ...config, goal: { ...config.goal, prompt: 'x'.repeat(20_001) } }),
      'utf8'
    );
    const loaded = await loadConfig();
    expect(loaded.goal.prompt).toBe(defaultConfig().goal.prompt);
    expect(loaded.roots).toEqual(config.roots);
  });

  it('leaves the loop off when the config cannot be read', async () => {
    await fs.writeFile(path.join(dir, 'config.json'), '{ definitely-not-json', 'utf8');
    expect((await loadConfig()).goal.enabled).toBe(false);
  });

  it('falls back rather than passing an unknown reasoning level to OpenRouter', async () => {
    const config = defaultConfig();
    await fs.writeFile(
      path.join(dir, 'config.json'),
      JSON.stringify({ ...config, goal: { enabled: true, model: 'x/y', reasoning: 'extreme' } }),
      'utf8'
    );
    expect((await loadConfig()).goal.reasoning).toBe('default');
  });
});

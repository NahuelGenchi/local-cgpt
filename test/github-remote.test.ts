import { describe, expect, it } from 'vitest';
import { defaultConfig, effectiveCapabilities } from '../src/main/config.js';
import {
  GitHubRemoteError,
  githubAuthStatusArgs,
  githubHostEnvironment,
  githubSyncHostFetchArgs,
  githubSyncLocalImportArgs,
  parseGitHubRemote,
  trustedGhCandidates,
  trustedGitCandidates
} from '../src/main/github-remote.js';

describe('GitHub remote identity validation', () => {
  it.each([
    ['https://github.com/owner/repo', { owner: 'owner', repo: 'repo', httpsUrl: 'https://github.com/owner/repo.git' }],
    ['https://github.com/owner/repo.git', { owner: 'owner', repo: 'repo', httpsUrl: 'https://github.com/owner/repo.git' }],
    ['git@github.com:owner/repo.git', { owner: 'owner', repo: 'repo', httpsUrl: 'https://github.com/owner/repo.git' }],
    ['ssh://git@github.com/owner/repo.git', { owner: 'owner', repo: 'repo', httpsUrl: 'https://github.com/owner/repo.git' }]
  ])('accepts GitHub repository identity %s but reconstructs HTTPS authority', (remote, expected) => {
    expect(parseGitHubRemote(remote)).toEqual(expected);
  });

  it.each([
    'http://github.com/owner/repo.git',
    'git://github.com/owner/repo.git',
    'https://github.example.com/owner/repo.git',
    'https://github.com.evil.example/owner/repo.git',
    'https://user:secret@github.com/owner/repo.git',
    'https://github.com:8443/owner/repo.git',
    'https://github.com/owner/repo.git?upload=evil',
    'https://github.com/owner/repo.git#fragment',
    'https://github.com/owner/repo/extra',
    'ssh://root@github.com/owner/repo.git',
    'ssh://git@github.com:2222/owner/repo.git',
    'git@evil.example:owner/repo.git',
    'git@github.com:owner/repo/extra',
    'file:///tmp/repository.git',
    '/tmp/repository'
  ])('rejects non-GitHub or ambiguous transport %s', (remote) => {
    expect(parseGitHubRemote(remote)).toBeNull();
  });
});

describe('GitHub host helper environment', () => {
  it('uses an explicit absolute gh config directory while dropping ambient credentials', () => {
    const env = githubHostEnvironment('/home/alice', {
      GH_CONFIG_DIR: '/home/alice/.private-gh',
      GH_TOKEN: 'must-not-leak',
      GITHUB_TOKEN: 'must-not-leak',
      OPENAI_API_KEY: 'must-not-leak',
      SSH_AUTH_SOCK: '/tmp/agent.sock',
      XDG_RUNTIME_DIR: '/run/user/1000',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
      LANG: 'en_US.UTF-8'
    });

    expect(env.GH_CONFIG_DIR).toBe('/home/alice/.private-gh');
    expect(env.XDG_CONFIG_HOME).toBe('/home/alice');
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.SSH_AUTH_SOCK).toBeUndefined();
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(env.GH_PROMPT_DISABLED).toBe('1');
    expect(env.GIT_CONFIG_GLOBAL).toBe('/dev/null');
    expect(env.GIT_ASKPASS).toBe('/bin/false');
    expect(env.SSH_ASKPASS).toBe('/bin/false');
    expect(env.XDG_RUNTIME_DIR).toBe('/run/user/1000');
    expect(env.DBUS_SESSION_BUS_ADDRESS).toBe('unix:path=/run/user/1000/bus');
  });

  it('rejects a relative gh credential directory rather than resolving it from a project cwd', () => {
    expect(() => githubHostEnvironment('/home/alice', { GH_CONFIG_DIR: '.config/gh' })).toThrow(GitHubRemoteError);
  });

  it('falls back to the normal per-user gh config without importing token variables', () => {
    const env = githubHostEnvironment('/home/alice', {
      XDG_CONFIG_HOME: '/home/alice/.xdg',
      GH_TOKEN: 'secret'
    });
    expect(env.GH_CONFIG_DIR).toBe('/home/alice/.xdg/gh');
    expect(env.GH_TOKEN).toBeUndefined();
  });

  it('only trusts fixed root-managed git and gh executable locations', () => {
    expect(trustedGitCandidates()).toEqual(['/usr/bin/git', '/bin/git']);
    expect(trustedGhCandidates()).toEqual(['/usr/bin/gh', '/bin/gh', '/snap/bin/gh']);
    for (const candidate of [...trustedGitCandidates(), ...trustedGhCandidates()]) {
      expect(candidate.startsWith('/usr/bin/') || candidate.startsWith('/bin/') || candidate.startsWith('/snap/bin/')).toBe(true);
      expect(candidate).not.toContain('/home/');
      expect(candidate).not.toContain('/tmp/');
    }
  });

  it('uses the gh auth syntax supported by the Ubuntu 2.45 CLI without asking for a token', () => {
    expect(githubAuthStatusArgs()).toEqual(['auth', 'status', '--hostname', 'github.com']);
    expect(githubAuthStatusArgs()).not.toContain('--active');
    expect(githubAuthStatusArgs().join(' ')).not.toMatch(/token/i);
  });
});

describe('GitHub synchronization boundary', () => {
  it('fetches only GitHub branch refs into app-owned remote-tracking refs', () => {
    const args = githubSyncHostFetchArgs('https://github.com/owner/repo.git');
    expect(args).toEqual([
      'fetch',
      '--quiet',
      '--prune',
      '--no-tags',
      'https://github.com/owner/repo.git',
      '+refs/heads/*:refs/remotes/origin/*'
    ]);
    expect(args.join(' ')).not.toContain('refs/tags');
  });

  it('imports the handoff bundle offline with project execution hooks neutralized', () => {
    const args = githubSyncLocalImportArgs('/approved/repo/.git/.local-cgpt-sync.bundle');
    const joined = args.join(' ');
    expect(joined).toContain('core.hooksPath=/dev/null');
    expect(joined).toContain('core.fsmonitor=false');
    expect(joined).toContain('credential.helper=');
    expect(joined).toContain('protocol.allow=never');
    expect(joined).toContain('protocol.file.allow=always');
    expect(joined).toContain('+refs/remotes/origin/*:refs/remotes/origin/*');
    expect(joined).not.toContain('refs/heads/*:refs/heads/*');
    expect(joined).not.toMatch(/https?:\/\//);
  });
});

describe('GitHub network capability migration and read-only policy', () => {
  it('is default-off on a fresh Linux configuration', () => {
    expect(defaultConfig('linux').capabilities.network).toBe(false);
  });

  it('is a distinct authority from command execution', () => {
    const base = defaultConfig('linux');
    const config = {
      ...base,
      readOnly: false,
      capabilities: { ...base.capabilities, command: true, network: false }
    };
    const live = effectiveCapabilities(config, 'linux');
    expect(live.command).toBe(true);
    expect(live.network).toBe(false);
  });

  it('is masked by read-only mode even when stored as enabled', () => {
    const base = defaultConfig('linux');
    const writable = {
      ...base,
      readOnly: false,
      capabilities: { ...base.capabilities, network: true }
    };
    expect(effectiveCapabilities(writable, 'linux').network).toBe(true);
    expect(effectiveCapabilities({ ...writable, readOnly: true }, 'linux').network).toBe(false);
  });
});
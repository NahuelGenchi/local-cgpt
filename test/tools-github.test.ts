import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Capabilities, Root } from '../src/shared/types.js';
import { DEFAULT_CAPABILITIES } from '../src/shared/types.js';
import { resetWorkspaces } from '../src/main/workspace.js';
import { makeTempDir, removeTempDir } from './helpers.js';

const remote = vi.hoisted(() => {
  class TestGitHubRemoteError extends Error {}
  return {
    GitHubRemoteError: TestGitHubRemoteError,
    status: vi.fn(async () => ({
      owner: 'owner',
      repo: 'repo',
      branch: 'work/topic',
      head: '0123456789abcdef0123456789abcdef01234567',
      remoteUrl: 'https://github.com/owner/repo.git',
      defaultBranch: 'main'
    })),
    push: vi.fn(async () => ({
      owner: 'owner',
      repo: 'repo',
      branch: 'work/topic',
      head: '0123456789abcdef0123456789abcdef01234567',
      remoteUrl: 'https://github.com/owner/repo.git'
    })),
    issue: vi.fn(async () => ({ url: 'https://github.com/owner/repo/issues/1', owner: 'owner', repo: 'repo' })),
    pr: vi.fn(async () => ({
      url: 'https://github.com/owner/repo/pull/2',
      owner: 'owner',
      repo: 'repo',
      branch: 'work/topic',
      base: 'main',
      head: '0123456789abcdef0123456789abcdef01234567',
      remoteUrl: 'https://github.com/owner/repo.git'
    }))
  };
});

vi.mock('../src/main/github-remote.js', () => ({
  GitHubRemoteError: remote.GitHubRemoteError,
  githubRepositoryStatus: remote.status,
  pushGitHubCurrentBranch: remote.push,
  createGitHubIssue: remote.issue,
  createGitHubPullRequest: remote.pr
}));

import { registerGithubTool } from '../src/main/mcp/tools-github.js';

let rootPath: string;
let roots: Root[];

beforeAll(async () => {
  rootPath = await makeTempDir('clf-github-tool-');
  roots = [{ name: 'workspace', path: rootPath }];
});

afterAll(async () => {
  await removeTempDir(rootPath);
});

beforeEach(() => {
  resetWorkspaces();
  vi.clearAllMocks();
});

function capabilities(overrides: Partial<Capabilities> = {}): Capabilities {
  return { ...DEFAULT_CAPABILITIES, ...overrides };
}

function githubSurface(options: { live?: boolean; exposed?: boolean; readOnly?: boolean } = {}) {
  const liveCaps = capabilities({ network: options.live ?? true });
  const exposedCaps = capabilities({ network: options.exposed ?? true });
  const registered = new Map<string, { config: any; handler: (input: any) => Promise<any> }>();
  const ctx = {
    roots,
    caps: liveCaps,
    exposedCaps,
    readOnly: options.readOnly ?? false,
    sessionTools: false,
    agentTools: false
  };
  const registrar = {
    ctx,
    caps: liveCaps,
    exposedCaps,
    sessionToolsLive: false,
    sessionToolsExposed: false,
    agentToolsLive: false,
    agentToolsExposed: false,
    findExposed: false,
    register(name: string, config: any, handler: (input: any) => Promise<any>) {
      registered.set(name, { config, handler });
    },
    guarded: async (cap: keyof Capabilities, name: string, fn: () => Promise<any>) => {
      if (!liveCaps[cap]) {
        return {
          content: [{ type: 'text', text: `TOOL_DISABLED: ${name} is disabled by the current permissions.` }],
          isError: true
        };
      }
      return fn();
    },
    featureDisabled: vi.fn(),
    registered: () => [...registered.keys()]
  };
  registerGithubTool(registrar as never);
  return { registered, liveCaps, ctx };
}

describe('GitHub tool capability boundary', () => {
  it('is absent when network authority has never been exposed', () => {
    expect(githubSurface({ live: false, exposed: false }).registered.has('github')).toBe(false);
  });

  it('keeps a cached schema registered but revocation blocks it immediately', async () => {
    const surface = githubSurface({ live: true, exposed: true });
    const tool = surface.registered.get('github')!;
    surface.liveCaps.network = false;

    const result = await tool.handler({ action: 'status' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('TOOL_DISABLED');
    expect(remote.status).not.toHaveBeenCalled();
    expect(remote.push).not.toHaveBeenCalled();
  });

  it('publishes no token, credential or arbitrary URL field in its schema', () => {
    const tool = githubSurface().registered.get('github')!;
    const schema = tool.config.inputSchema;
    expect(schema.safeParse({ action: 'status' }).success).toBe(true);
    expect(schema.safeParse({ action: 'status', token: 'secret' }).success).toBe(false);
    expect(schema.safeParse({ action: 'push', url: 'https://evil.example' }).success).toBe(false);
    expect(JSON.stringify(tool.config)).not.toMatch(/gh_token|github_token|access_token/i);
  });

  it('keeps status read-only while refusing mutations in app read-only mode', async () => {
    const surface = githubSurface({ readOnly: true });
    const tool = surface.registered.get('github')!;

    const status = await tool.handler({ action: 'status' });
    expect(status.isError).not.toBe(true);
    expect(status.structuredContent.repository).toBe('owner/repo');
    expect(remote.status).toHaveBeenCalledTimes(1);

    const push = await tool.handler({ action: 'push' });
    expect(push.isError).toBe(true);
    expect(push.content[0].text).toContain('read-only mode');
    expect(remote.push).not.toHaveBeenCalled();
  });

  it('passes issue and pull-request metadata without inventing transport authority', async () => {
    const tool = githubSurface().registered.get('github')!;

    const issue = await tool.handler({
      action: 'issue_create',
      title: 'Track the fix',
      body: 'Details',
      labels: ['bug']
    });
    expect(issue.isError).not.toBe(true);
    expect(remote.issue).toHaveBeenCalledWith(roots, rootPath, {
      title: 'Track the fix',
      body: 'Details',
      labels: ['bug']
    });

    const pr = await tool.handler({
      action: 'pr_create',
      title: 'Publish fix',
      body: 'Ready',
      base: 'main',
      draft: true
    });
    expect(pr.isError).not.toBe(true);
    expect(remote.pr).toHaveBeenCalledWith(roots, rootPath, {
      title: 'Publish fix',
      body: 'Ready',
      base: 'main',
      draft: true
    });
  });

  it('rejects action-specific fields instead of silently ignoring them', () => {
    const schema = githubSurface().registered.get('github')!.config.inputSchema;
    expect(schema.safeParse({ action: 'push', title: 'not valid' }).success).toBe(false);
    expect(schema.safeParse({ action: 'issue_create', title: 'x', base: 'main' }).success).toBe(false);
    expect(schema.safeParse({ action: 'pr_create', title: 'x', labels: ['bug'] }).success).toBe(false);
    expect(schema.safeParse({ action: 'issue_create' }).success).toBe(false);
    expect(schema.safeParse({ action: 'pr_create' }).success).toBe(false);
  });
});
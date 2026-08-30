import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Capabilities, Root } from '../src/shared/types.js';
import { DEFAULT_CAPABILITIES } from '../src/shared/types.js';
import { resetWorkspaces } from '../src/main/workspace.js';
import { makeTempDir, removeTempDir } from './helpers.js';

const remote = vi.hoisted(() => {
  class TestGitHubRemoteError extends Error {}
  const identity = {
    owner: 'owner',
    repo: 'repo',
    branch: 'work/topic',
    head: '0123456789abcdef0123456789abcdef01234567',
    remoteUrl: 'https://github.com/owner/repo.git',
    defaultBranch: 'main'
  };
  const prSummary = {
    number: 2,
    title: 'Publish fix',
    state: 'open' as const,
    draft: true,
    url: 'https://github.com/owner/repo/pull/2',
    headRef: 'work/topic',
    headSha: identity.head,
    baseRef: 'main',
    baseSha: '1111111111111111111111111111111111111111',
    updatedAt: '2026-08-30T00:00:00Z'
  };
  const issueSummary = {
    number: 1,
    title: 'Track the fix',
    state: 'open' as const,
    url: 'https://github.com/owner/repo/issues/1',
    labels: ['bug'],
    updatedAt: '2026-08-30T00:00:00Z'
  };
  return {
    GitHubRemoteError: TestGitHubRemoteError,
    status: vi.fn(async () => identity),
    sync: vi.fn(async () => ({ ...identity, refs: [{ name: 'origin/main', head: identity.head }], currentRemoteHead: identity.head })),
    push: vi.fn(async () => identity),
    prList: vi.fn(async () => [prSummary]),
    prGet: vi.fn(async () => ({ ...prSummary, body: 'PR body', merged: false, mergeable: true })),
    prDiff: vi.fn(async () => ({ number: 2, diff: 'diff --git a/a b/a' })),
    prCreate: vi.fn(async () => ({
      url: prSummary.url,
      owner: 'owner',
      repo: 'repo',
      branch: identity.branch,
      base: 'main',
      head: identity.head,
      remoteUrl: identity.remoteUrl
    })),
    prUpdate: vi.fn(async () => ({ ...prSummary, body: 'updated', merged: false, mergeable: true })),
    prState: vi.fn(async (_roots, _cwd, _number, state: 'open' | 'closed') => ({
      ...prSummary,
      state,
      body: 'PR body',
      merged: false,
      mergeable: true
    })),
    issueList: vi.fn(async () => [issueSummary]),
    issueGet: vi.fn(async () => ({ ...issueSummary, body: 'Issue body' })),
    issueCreate: vi.fn(async () => ({ url: issueSummary.url, owner: 'owner', repo: 'repo' })),
    issueUpdate: vi.fn(async () => ({ ...issueSummary, body: 'updated' })),
    issueState: vi.fn(async (_roots, _cwd, _number, state: 'open' | 'closed') => ({ ...issueSummary, state, body: 'Issue body' }))
  };
});

vi.mock('../src/main/github-remote.js', () => ({
  GitHubRemoteError: remote.GitHubRemoteError,
  githubRepositoryStatus: remote.status,
  syncGitHubRemote: remote.sync,
  pushGitHubCurrentBranch: remote.push,
  listGitHubPullRequests: remote.prList,
  getGitHubPullRequest: remote.prGet,
  getGitHubPullRequestDiff: remote.prDiff,
  createGitHubPullRequest: remote.prCreate,
  updateGitHubPullRequest: remote.prUpdate,
  setGitHubPullRequestState: remote.prState,
  listGitHubIssues: remote.issueList,
  getGitHubIssue: remote.issueGet,
  createGitHubIssue: remote.issueCreate,
  updateGitHubIssue: remote.issueUpdate,
  setGitHubIssueState: remote.issueState
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

  it('publishes no token, repository, force, merge or arbitrary URL authority in its schema', () => {
    const tool = githubSurface().registered.get('github')!;
    const schema = tool.config.inputSchema;
    expect(schema.safeParse({ action: 'status' }).success).toBe(true);
    expect(schema.safeParse({ action: 'status', token: 'secret' }).success).toBe(false);
    expect(schema.safeParse({ action: 'push', url: 'https://evil.example' }).success).toBe(false);
    expect(schema.safeParse({ action: 'push', repository: 'other/repo' }).success).toBe(false);
    expect(schema.safeParse({ action: 'push', force: true }).success).toBe(false);
    expect(schema.safeParse({ action: 'merge', number: 2 }).success).toBe(false);
    expect(JSON.stringify(tool.config)).not.toMatch(/gh_token|github_token|access_token/i);
  });

  it('allows remote reads in a direct read-only context but refuses every mutation', async () => {
    const surface = githubSurface({ readOnly: true });
    const tool = surface.registered.get('github')!;

    expect((await tool.handler({ action: 'status' })).isError).not.toBe(true);
    expect((await tool.handler({ action: 'pr_list' })).isError).not.toBe(true);
    expect((await tool.handler({ action: 'issue_get', number: 1 })).isError).not.toBe(true);

    for (const input of [
      { action: 'sync' },
      { action: 'push' },
      { action: 'pr_create', title: 'x' },
      { action: 'pr_update', number: 2, base: 'main' },
      { action: 'pr_close', number: 2 },
      { action: 'issue_create', title: 'x' },
      { action: 'issue_update', number: 1, body: 'x' },
      { action: 'issue_close', number: 1 }
    ]) {
      const result = await tool.handler(input);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('read-only mode');
    }
    expect(remote.sync).not.toHaveBeenCalled();
    expect(remote.push).not.toHaveBeenCalled();
    expect(remote.prCreate).not.toHaveBeenCalled();
    expect(remote.issueCreate).not.toHaveBeenCalled();
  });
});

describe('GitHub workflow actions', () => {
  it('routes synchronization and remote PR reads without inventing repository authority', async () => {
    const tool = githubSurface().registered.get('github')!;

    const sync = await tool.handler({ action: 'sync' });
    expect(sync.isError).not.toBe(true);
    expect(remote.sync).toHaveBeenCalledWith(roots, rootPath);

    const list = await tool.handler({ action: 'pr_list', state: 'all', limit: 12 });
    expect(list.isError).not.toBe(true);
    expect(remote.prList).toHaveBeenCalledWith(roots, rootPath, { state: 'all', limit: 12 });

    const get = await tool.handler({ action: 'pr_get', number: 2 });
    expect(get.isError).not.toBe(true);
    expect(remote.prGet).toHaveBeenCalledWith(roots, rootPath, 2);

    const diff = await tool.handler({ action: 'pr_diff', number: 2 });
    expect(diff.isError).not.toBe(true);
    expect(remote.prDiff).toHaveBeenCalledWith(roots, rootPath, 2);
  });

  it('routes PR create, retarget, close and reopen explicitly', async () => {
    const tool = githubSurface().registered.get('github')!;

    await tool.handler({ action: 'pr_create', title: 'Publish fix', body: 'Ready', base: 'main', draft: true });
    expect(remote.prCreate).toHaveBeenCalledWith(roots, rootPath, {
      title: 'Publish fix',
      body: 'Ready',
      base: 'main',
      draft: true
    });

    await tool.handler({ action: 'pr_update', number: 2, title: 'New title', body: '', base: 'release' });
    expect(remote.prUpdate).toHaveBeenCalledWith(roots, rootPath, 2, {
      title: 'New title',
      body: '',
      base: 'release'
    });

    await tool.handler({ action: 'pr_close', number: 2 });
    await tool.handler({ action: 'pr_reopen', number: 2 });
    expect(remote.prState).toHaveBeenNthCalledWith(1, roots, rootPath, 2, 'closed');
    expect(remote.prState).toHaveBeenNthCalledWith(2, roots, rootPath, 2, 'open');
  });

  it('routes issue list/read/create/update/close/reopen explicitly', async () => {
    const tool = githubSurface().registered.get('github')!;

    await tool.handler({ action: 'issue_list', state: 'closed', limit: 5 });
    expect(remote.issueList).toHaveBeenCalledWith(roots, rootPath, { state: 'closed', limit: 5 });

    await tool.handler({ action: 'issue_get', number: 1 });
    expect(remote.issueGet).toHaveBeenCalledWith(roots, rootPath, 1);

    await tool.handler({ action: 'issue_create', title: 'Track the fix', body: 'Details', labels: ['bug'] });
    expect(remote.issueCreate).toHaveBeenCalledWith(roots, rootPath, {
      title: 'Track the fix',
      body: 'Details',
      labels: ['bug']
    });

    await tool.handler({ action: 'issue_update', number: 1, body: '', labels: [] });
    expect(remote.issueUpdate).toHaveBeenCalledWith(roots, rootPath, 1, { body: '', labels: [] });

    await tool.handler({ action: 'issue_close', number: 1 });
    await tool.handler({ action: 'issue_reopen', number: 1 });
    expect(remote.issueState).toHaveBeenNthCalledWith(1, roots, rootPath, 1, 'closed');
    expect(remote.issueState).toHaveBeenNthCalledWith(2, roots, rootPath, 1, 'open');
  });

  it('rejects action-specific fields and under-specified updates instead of ignoring them', () => {
    const schema = githubSurface().registered.get('github')!.config.inputSchema;
    expect(schema.safeParse({ action: 'push', title: 'not valid' }).success).toBe(false);
    expect(schema.safeParse({ action: 'pr_list', number: 2 }).success).toBe(false);
    expect(schema.safeParse({ action: 'pr_get' }).success).toBe(false);
    expect(schema.safeParse({ action: 'pr_create', title: 'x', labels: ['bug'] }).success).toBe(false);
    expect(schema.safeParse({ action: 'pr_update', number: 2 }).success).toBe(false);
    expect(schema.safeParse({ action: 'issue_create' }).success).toBe(false);
    expect(schema.safeParse({ action: 'issue_update', number: 1 }).success).toBe(false);
    expect(schema.safeParse({ action: 'issue_update', number: 1, base: 'main' }).success).toBe(false);
  });
});
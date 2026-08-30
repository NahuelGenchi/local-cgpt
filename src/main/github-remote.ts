import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { accessSync, constants, statSync } from 'node:fs';
import { promises as hostFs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Root } from '../shared/types.js';
import { sandboxCommandLaunch } from './command-sandbox.js';
import { terminateProcessTree } from './exec.js';
import { rawPromises } from './rawfs.js';
import { isContained, resolvePath } from './sandbox.js';

const PROCESS_TIMEOUT_MS = 60_000;
const MAX_PROCESS_OUTPUT_BYTES = 100_000;
const MAX_BUNDLE_BYTES = 512 * 1024 * 1024;
const HOST_PATH = '/usr/bin:/bin:/snap/bin';
const GITHUB_HOST = 'github.com';

export class GitHubRemoteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitHubRemoteError';
  }
}

export interface GitHubRepositoryIdentity {
  owner: string;
  repo: string;
  branch: string;
  head: string;
  remoteUrl: string;
  defaultBranch?: string;
}

export interface GitHubIssueResult {
  url: string;
  owner: string;
  repo: string;
}

export interface GitHubPullRequestResult extends GitHubIssueResult {
  branch: string;
  base: string;
  head: string;
}

interface ParsedGitHubRemote {
  owner: string;
  repo: string;
  httpsUrl: string;
}

interface LocalRepository extends ParsedGitHubRemote {
  topLevel: string;
  gitDir: string;
  branch: string;
  head: string;
}

interface ProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
}

function executable(candidate: string): boolean {
  try {
    return statSync(candidate).isFile() && (accessSync(candidate, constants.X_OK), true);
  } catch {
    return false;
  }
}

export function trustedGitCandidates(): readonly string[] {
  return ['/usr/bin/git', '/bin/git'];
}

export function trustedGhCandidates(): readonly string[] {
  return ['/usr/bin/gh', '/bin/gh', '/snap/bin/gh'];
}

function locateRequired(candidates: readonly string[], label: string): string {
  const found = candidates.find(executable);
  if (!found) {
    throw new GitHubRemoteError(`${label} is required for GitHub access but was not found in a trusted system location.`);
  }
  return found;
}

function appendBounded(chunks: Buffer[], chunk: Buffer, current: number): { bytes: number; truncated: boolean } {
  const remaining = MAX_PROCESS_OUTPUT_BYTES - current;
  if (remaining <= 0) return { bytes: current, truncated: true };
  if (chunk.length > remaining) {
    chunks.push(chunk.subarray(0, remaining));
    return { bytes: MAX_PROCESS_OUTPUT_BYTES, truncated: true };
  }
  chunks.push(chunk);
  return { bytes: current + chunk.length, truncated: false };
}

async function runExact(
  file: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  stdin?: string | Buffer,
  timeoutMs = PROCESS_TIMEOUT_MS
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(file, [...args], {
        cwd,
        env,
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch {
      reject(new GitHubRemoteError('A required GitHub helper could not be started.'));
      return;
    }

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;

    child.stdout.on('data', (chunk: Buffer) => {
      const next = appendBounded(stdout, chunk, stdoutBytes);
      stdoutBytes = next.bytes;
      truncated ||= next.truncated;
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const next = appendBounded(stderr, chunk, stderrBytes);
      stderrBytes = next.bytes;
      truncated ||= next.truncated;
    });

    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        timedOut,
        truncated
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) void terminateProcessTree(child.pid);
    }, timeoutMs);

    child.once('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new GitHubRemoteError('A required GitHub helper could not be started.'));
    });
    child.once('close', (code) => finish(code));

    if (stdin === undefined) child.stdin.end();
    else child.stdin.end(stdin);
  });
}

function requireSuccess(result: ProcessResult, message: string): string {
  if (result.timedOut) throw new GitHubRemoteError(`${message} The helper timed out.`);
  if (result.exitCode !== 0) throw new GitHubRemoteError(message);
  return result.stdout.trim();
}

function validRepositoryPart(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 100 &&
    value !== '.' &&
    value !== '..' &&
    /^[A-Za-z0-9_.-]+$/.test(value)
  );
}

function parsedParts(owner: string, rawRepo: string): ParsedGitHubRemote | null {
  const repo = rawRepo.endsWith('.git') ? rawRepo.slice(0, -4) : rawRepo;
  if (!validRepositoryPart(owner) || !validRepositoryPart(repo)) return null;
  return { owner, repo, httpsUrl: `https://${GITHUB_HOST}/${owner}/${repo}.git` };
}

/**
 * Parse repository identity, not transport authority. The returned URL is reconstructed by the
 * app so project-controlled Git config can never select a different network destination or embed
 * credentials in the URL handed to the host process.
 */
export function parseGitHubRemote(value: string): ParsedGitHubRemote | null {
  const input = value.trim();
  const scp = /^git@github\.com:([^/\s]+)\/([^/\s]+)\/?$/.exec(input);
  if (scp) return parsedParts(scp[1]!, scp[2]!);

  let remote: URL;
  try {
    remote = new URL(input);
  } catch {
    return null;
  }
  if (remote.hostname.toLowerCase() !== GITHUB_HOST || remote.port || remote.search || remote.hash) return null;
  if (remote.protocol === 'https:') {
    if (remote.username || remote.password) return null;
  } else if (remote.protocol === 'ssh:') {
    if (remote.username !== 'git' || remote.password) return null;
  } else {
    return null;
  }
  const parts = remote.pathname.split('/').filter(Boolean);
  if (parts.length !== 2) return null;
  return parsedParts(parts[0]!, parts[1]!);
}

function configuredGhDirectory(home: string, sourceEnv: NodeJS.ProcessEnv): string {
  const explicit = sourceEnv.GH_CONFIG_DIR?.trim();
  if (explicit) {
    if (!path.isAbsolute(explicit)) {
      throw new GitHubRemoteError('GH_CONFIG_DIR must be an absolute path before local-cgpt can use existing GitHub authentication.');
    }
    return explicit;
  }
  const configHome = sourceEnv.XDG_CONFIG_HOME;
  const base = configHome && path.isAbsolute(configHome) ? configHome : path.join(home, '.config');
  return path.join(base, 'gh');
}

/** Exact host environment for the two reviewed helpers. It intentionally has no token variables. */
export function githubHostEnvironment(
  home = os.homedir(),
  sourceEnv: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const configDir = configuredGhDirectory(home, sourceEnv);
  const env: NodeJS.ProcessEnv = {
    PATH: HOST_PATH,
    HOME: home,
    XDG_CONFIG_HOME: path.dirname(configDir),
    GH_CONFIG_DIR: configDir,
    GH_HOST: GITHUB_HOST,
    GH_PROMPT_DISABLED: '1',
    GH_NO_UPDATE_NOTIFIER: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_ASKPASS: '/bin/false',
    SSH_ASKPASS: '/bin/false',
    GCM_INTERACTIVE: 'Never',
    PAGER: 'cat',
    GIT_PAGER: 'cat',
    LANG: sourceEnv.LANG ?? 'C.UTF-8',
    LC_ALL: sourceEnv.LC_ALL ?? 'C.UTF-8'
  };
  // Linux keyrings commonly use the per-user D-Bus session. These two inherited values are
  // transport locators, not credentials, and the only host programs receiving them are fixed
  // system git/gh invocations with app-constructed argv.
  if (sourceEnv.XDG_RUNTIME_DIR) env.XDG_RUNTIME_DIR = sourceEnv.XDG_RUNTIME_DIR;
  if (sourceEnv.DBUS_SESSION_BUS_ADDRESS) env.DBUS_SESSION_BUS_ADDRESS = sourceEnv.DBUS_SESSION_BUS_ADDRESS;
  return env;
}

async function canonicalOrResolved(candidate: string): Promise<string> {
  try {
    return await hostFs.realpath(candidate);
  } catch {
    return path.resolve(candidate);
  }
}

function overlapsRoot(candidate: string, roots: readonly Root[]): boolean {
  return roots.some((root) => isContained(root.path, candidate) || isContained(candidate, root.path));
}

async function ensureCredentialStoreIsPrivate(roots: readonly Root[], env: NodeJS.ProcessEnv): Promise<void> {
  const configDir = env.GH_CONFIG_DIR;
  if (!configDir || !path.isAbsolute(configDir)) {
    throw new GitHubRemoteError('GitHub authentication storage could not be resolved safely.');
  }
  const canonical = await canonicalOrResolved(configDir);
  if (overlapsRoot(canonical, roots)) {
    throw new GitHubRemoteError(
      'GitHub authentication storage overlaps an approved project folder. Move the project or GitHub CLI configuration so credentials are outside model-writable roots.'
    );
  }
}

async function safeTempParent(roots: readonly Root[], home: string): Promise<string> {
  // Never chmod the shared system temp directory itself. Every candidate below is an app-owned
  // child directory whose permissions local-cgpt may safely tighten to 0700.
  const candidates = [
    path.join(os.tmpdir(), 'local-cgpt', 'github-transport'),
    path.join(home, '.local', 'share', 'local-cgpt', 'github-transport'),
    path.join(home, '.cache', 'local-cgpt', 'github-transport')
  ];
  for (const candidate of candidates) {
    try {
      await hostFs.mkdir(candidate, { recursive: true, mode: 0o700 });
      const info = await hostFs.lstat(candidate);
      if (!info.isDirectory() || info.isSymbolicLink()) continue;
      const canonical = await hostFs.realpath(candidate);
      if (overlapsRoot(canonical, roots)) continue;
      await hostFs.chmod(canonical, 0o700);
      return canonical;
    } catch {
      continue;
    }
  }
  throw new GitHubRemoteError('No private application directory is available outside the approved project roots.');
}

async function withPrivateTransport<T>(roots: readonly Root[], fn: (ctx: {
  dir: string;
  git: string;
  gh: string;
  env: NodeJS.ProcessEnv;
}) => Promise<T>): Promise<T> {
  if (process.platform !== 'linux') {
    throw new GitHubRemoteError('The hardened GitHub transport is currently available only on Linux.');
  }
  const home = os.homedir();
  const env = githubHostEnvironment(home);
  await ensureCredentialStoreIsPrivate(roots, env);
  const parent = await safeTempParent(roots, home);
  const dir = await hostFs.mkdtemp(path.join(parent, 'job-'));
  await hostFs.chmod(dir, 0o700);
  try {
    return await fn({
      dir,
      git: locateRequired(trustedGitCandidates(), 'System Git'),
      gh: locateRequired(trustedGhCandidates(), 'GitHub CLI'),
      env
    });
  } finally {
    await hostFs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function ensureGhAuthenticated(gh: string, cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
  const result = await runExact(gh, ['auth', 'status', '--active', '--hostname', GITHUB_HOST], cwd, env);
  if (result.exitCode !== 0 || result.timedOut) {
    throw new GitHubRemoteError(
      'GitHub is not signed in for this desktop account. Sign in once outside local-cgpt with `gh auth login --hostname github.com --web`, then retry. Do not paste a token into ChatGPT or local-cgpt.'
    );
  }
}

async function localGit(
  roots: readonly Root[],
  cwd: string,
  args: readonly string[],
  message: string
): Promise<string> {
  const git = locateRequired(trustedGitCandidates(), 'System Git');
  const launch = sandboxCommandLaunch({ command: [git, ...args], cwd, roots, env: {} });
  const result = await runExact(launch.command[0]!, launch.command.slice(1), launch.cwd, launch.env);
  return requireSuccess(result, message);
}

async function discoverLocalRepository(roots: readonly Root[], cwd: string): Promise<LocalRepository> {
  const topLevel = await localGit(
    roots,
    cwd,
    ['rev-parse', '--show-toplevel'],
    'The approved working folder is not a usable Git repository.'
  );
  const gitDir = await localGit(
    roots,
    cwd,
    ['rev-parse', '--absolute-git-dir'],
    'The repository Git directory could not be resolved safely.'
  );
  const branch = await localGit(
    roots,
    cwd,
    ['symbolic-ref', '--quiet', '--short', 'HEAD'],
    'GitHub publication requires a named local branch; detached HEAD is not published.'
  );
  await localGit(
    roots,
    cwd,
    ['check-ref-format', '--branch', branch],
    'The current Git branch name is not safe to publish.'
  );
  const head = await localGit(roots, cwd, ['rev-parse', '--verify', 'HEAD^{commit}'], 'The current Git commit could not be resolved.');
  const remote = await localGit(
    roots,
    cwd,
    ['config', '--get', 'remote.origin.url'],
    'This repository has no origin remote. Configure a GitHub origin locally before using GitHub publication.'
  );
  const parsed = parseGitHubRemote(remote);
  if (!parsed) {
    throw new GitHubRemoteError(
      'The origin remote is not a supported github.com repository. The hardened transport accepts only GitHub HTTPS or SSH repository identities and always publishes over a reconstructed HTTPS URL.'
    );
  }

  // Git itself may follow a linked-worktree .git file. Prove both host paths it reported are
  // still under an approved root before any path is later used for the local bundle handoff.
  await resolvePath(roots, topLevel);
  await resolvePath(roots, gitDir);
  return { ...parsed, topLevel, gitDir, branch, head };
}

async function requireCleanTree(roots: readonly Root[], repo: LocalRepository): Promise<void> {
  const status = await localGit(
    roots,
    repo.topLevel,
    ['status', '--porcelain=v1', '--untracked-files=normal'],
    'Git status could not be checked before publication.'
  );
  if (status !== '') {
    throw new GitHubRemoteError(
      'The repository still has uncommitted or untracked changes. Commit the intended work locally before publishing so GitHub cannot silently fall behind the workspace.'
    );
  }
}

function hostGitArgs(gitDir: string, gh: string, allowFile: boolean): string[] {
  return [
    `--git-dir=${gitDir}`,
    '-c', 'core.hooksPath=/dev/null',
    '-c', 'credential.helper=',
    '-c', `credential.helper=${gh} auth git-credential`,
    '-c', 'protocol.allow=never',
    '-c', `protocol.file.allow=${allowFile ? 'always' : 'never'}`,
    '-c', 'protocol.https.allow=always',
    '-c', 'protocol.ext.allow=never'
  ];
}

async function createBundle(roots: readonly Root[], repo: LocalRepository): Promise<{ path: string; bytes: Buffer }> {
  const bundlePath = path.join(repo.gitDir, `.local-cgpt-${randomUUID()}.bundle`);
  try {
    await localGit(
      roots,
      repo.topLevel,
      ['bundle', 'create', bundlePath, `refs/heads/${repo.branch}`],
      'The committed branch could not be packaged for safe GitHub publication.'
    );
    const stat = await rawPromises.stat(bundlePath);
    if (!stat.isFile()) throw new GitHubRemoteError('Git produced an invalid publication bundle.');
    if (stat.size > MAX_BUNDLE_BYTES) {
      throw new GitHubRemoteError(
        `The committed branch history is too large for the hardened publication handoff (${Math.ceil(stat.size / (1024 * 1024))} MiB; limit 512 MiB).`
      );
    }
    return { path: bundlePath, bytes: await rawPromises.readFile(bundlePath) };
  } catch (error) {
    await rawPromises.unlink(bundlePath).catch(() => undefined);
    throw error;
  }
}

async function safeDefaultBranch(
  gh: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  owner: string,
  repo: string
): Promise<string> {
  const result = await runExact(gh, ['api', `repos/${owner}/${repo}`, '--jq', '.default_branch'], cwd, env);
  const branch = requireSuccess(
    result,
    'GitHub repository metadata could not be read. Check that the signed-in account can access this repository.'
  );
  if (!branch || branch.includes('\n') || branch.length > 255) {
    throw new GitHubRemoteError('GitHub returned an invalid default branch name.');
  }
  return branch;
}

/** Verify the approved repository and GitHub authentication without exposing credentials. */
export async function githubRepositoryStatus(
  roots: readonly Root[],
  cwd: string
): Promise<GitHubRepositoryIdentity> {
  const local = await discoverLocalRepository(roots, cwd);
  return withPrivateTransport(roots, async ({ dir, gh, env }) => {
    await ensureGhAuthenticated(gh, dir, env);
    const defaultBranch = await safeDefaultBranch(gh, dir, env, local.owner, local.repo);
    return {
      owner: local.owner,
      repo: local.repo,
      branch: local.branch,
      head: local.head,
      remoteUrl: local.httpsUrl,
      defaultBranch
    };
  });
}

/**
 * Publish exactly the current committed branch. Ordinary commands remain in Bubblewrap; only
 * app-owned system git gets network access, from a private bare repository with hooks and ambient
 * Git config disabled. No force flag exists in this path, so GitHub remains the final fast-forward
 * authority if the remote branch advanced concurrently.
 */
export async function pushGitHubCurrentBranch(
  roots: readonly Root[],
  cwd: string
): Promise<GitHubRepositoryIdentity> {
  const local = await discoverLocalRepository(roots, cwd);
  await requireCleanTree(roots, local);

  return withPrivateTransport(roots, async ({ dir, git, gh, env }) => {
    await ensureGhAuthenticated(gh, dir, env);
    const bare = path.join(dir, 'repo.git');
    await hostFs.mkdir(bare, { mode: 0o700 });
    const init = await runExact(
      git,
      [...hostGitArgs(bare, gh, false), 'init', '--bare', '--quiet'],
      dir,
      env
    );
    requireSuccess(init, 'The private GitHub publication repository could not be initialized.');

    const bundle = await createBundle(roots, local);
    const privateBundle = path.join(dir, 'branch.bundle');
    try {
      await hostFs.writeFile(privateBundle, bundle.bytes, { mode: 0o600 });
    } finally {
      await rawPromises.unlink(bundle.path).catch(() => undefined);
    }

    const imported = await runExact(
      git,
      [...hostGitArgs(bare, gh, true), 'fetch', '--quiet', '--no-tags', privateBundle, `refs/heads/${local.branch}:refs/heads/local-cgpt`],
      dir,
      env
    );
    requireSuccess(imported, 'The committed branch could not be imported into the private GitHub publication repository.');

    const verified = await runExact(
      git,
      [...hostGitArgs(bare, gh, false), 'rev-parse', '--verify', 'refs/heads/local-cgpt^{commit}'],
      dir,
      env
    );
    const importedHead = requireSuccess(verified, 'The publication branch could not be verified before network access.');
    if (importedHead !== local.head) {
      throw new GitHubRemoteError('The local branch changed while publication was being prepared. No network push was attempted; retry from the new commit.');
    }

    const pushed = await runExact(
      git,
      [...hostGitArgs(bare, gh, false), 'push', '--porcelain', local.httpsUrl, `refs/heads/local-cgpt:refs/heads/${local.branch}`],
      dir,
      env
    );
    if (pushed.timedOut) throw new GitHubRemoteError('GitHub push timed out; check the remote branch before retrying.');
    if (pushed.exitCode !== 0) {
      throw new GitHubRemoteError(
        'GitHub rejected the push. The remote branch may have advanced or the signed-in account may lack write permission. Fetch/rebase locally if needed, then retry; local-cgpt never force-pushes.'
      );
    }

    return {
      owner: local.owner,
      repo: local.repo,
      branch: local.branch,
      head: local.head,
      remoteUrl: local.httpsUrl
    };
  });
}

async function ghJsonMutation(
  roots: readonly Root[],
  owner: string,
  repo: string,
  endpoint: string,
  body: Record<string, unknown>,
  failure: string
): Promise<string> {
  return withPrivateTransport(roots, async ({ dir, gh, env }) => {
    await ensureGhAuthenticated(gh, dir, env);
    const result = await runExact(
      gh,
      ['api', '--method', 'POST', endpoint, '--input', '-', '--jq', '.html_url'],
      dir,
      env,
      JSON.stringify(body)
    );
    const url = requireSuccess(result, failure);
    const prefix = `https://${GITHUB_HOST}/${owner}/${repo}/`;
    if (!url.startsWith(prefix)) throw new GitHubRemoteError('GitHub returned an unexpected result URL.');
    return url;
  });
}

export async function createGitHubIssue(
  roots: readonly Root[],
  cwd: string,
  input: { title: string; body: string; labels?: readonly string[] }
): Promise<GitHubIssueResult> {
  const local = await discoverLocalRepository(roots, cwd);
  const url = await ghJsonMutation(
    roots,
    local.owner,
    local.repo,
    `repos/${local.owner}/${local.repo}/issues`,
    { title: input.title, body: input.body, ...(input.labels ? { labels: [...input.labels] } : {}) },
    'GitHub rejected issue creation. Check repository access and any requested labels, then retry.'
  );
  return { url, owner: local.owner, repo: local.repo };
}

export async function createGitHubPullRequest(
  roots: readonly Root[],
  cwd: string,
  input: { title: string; body: string; base?: string; draft?: boolean }
): Promise<GitHubPullRequestResult> {
  // PR creation deliberately includes publication. A workflow cannot claim to be tracked on
  // GitHub while its current committed branch still exists only on disk.
  const pushed = await pushGitHubCurrentBranch(roots, cwd);
  return withPrivateTransport(roots, async ({ dir, gh, env }) => {
    await ensureGhAuthenticated(gh, dir, env);
    const base = input.base ?? (await safeDefaultBranch(gh, dir, env, pushed.owner, pushed.repo));
    const result = await runExact(
      gh,
      ['api', '--method', 'POST', `repos/${pushed.owner}/${pushed.repo}/pulls`, '--input', '-', '--jq', '.html_url'],
      dir,
      env,
      JSON.stringify({
        title: input.title,
        body: input.body,
        head: pushed.branch,
        base,
        draft: input.draft ?? true
      })
    );
    const url = requireSuccess(
      result,
      'GitHub rejected pull-request creation. Check that the branch differs from the base and that the signed-in account can create pull requests.'
    );
    const prefix = `https://${GITHUB_HOST}/${pushed.owner}/${pushed.repo}/pull/`;
    if (!url.startsWith(prefix)) throw new GitHubRemoteError('GitHub returned an unexpected pull-request URL.');
    return { ...pushed, url, base };
  });
}
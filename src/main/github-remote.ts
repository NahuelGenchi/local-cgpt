import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { accessSync, constants, statSync } from 'node:fs';
import { promises as hostFs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { Root } from '../shared/types.js';
import { sandboxCommandLaunch } from './command-sandbox.js';
import { terminateProcessTree } from './exec.js';
import { rawPromises } from './rawfs.js';
import { isContained, resolvePath } from './sandbox.js';

const PROCESS_TIMEOUT_MS = 60_000;
const MAX_PROCESS_OUTPUT_BYTES = 100_000;
const MAX_API_OUTPUT_BYTES = 1024 * 1024;
const MAX_BUNDLE_BYTES = 512 * 1024 * 1024;
const FILE_COPY_CHUNK_BYTES = 1024 * 1024;
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

export interface GitHubRemoteRef {
  name: string;
  head: string;
}

export interface GitHubSyncResult extends GitHubRepositoryIdentity {
  refs: GitHubRemoteRef[];
  currentRemoteHead?: string;
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

export interface GitHubPullRequestSummary {
  number: number;
  title: string;
  state: 'open' | 'closed';
  draft: boolean;
  url: string;
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  updatedAt: string;
}

export interface GitHubPullRequestDetail extends GitHubPullRequestSummary {
  body: string;
  merged: boolean;
  mergeable: boolean | null;
}

export interface GitHubIssueSummary {
  number: number;
  title: string;
  state: 'open' | 'closed';
  url: string;
  labels: string[];
  updatedAt: string;
}

export interface GitHubIssueDetail extends GitHubIssueSummary {
  body: string;
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

const prSummarySchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  state: z.enum(['open', 'closed']),
  draft: z.boolean(),
  url: z.string(),
  headRef: z.string(),
  headSha: z.string().regex(/^[0-9a-f]{40}$/i),
  baseRef: z.string(),
  baseSha: z.string().regex(/^[0-9a-f]{40}$/i),
  updatedAt: z.string()
});

const prDetailSchema = prSummarySchema.extend({
  body: z.string(),
  merged: z.boolean(),
  mergeable: z.boolean().nullable()
});

const issueSummarySchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  state: z.enum(['open', 'closed']),
  url: z.string(),
  labels: z.array(z.string()),
  updatedAt: z.string()
});

const issueDetailSchema = issueSummarySchema.extend({ body: z.string() });

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

export function githubAuthStatusArgs(): readonly string[] {
  // `--active` is newer than the gh version shipped by supported Ubuntu releases. The hostname
  // form works on older gh and still fails closed when no usable github.com account is configured.
  return ['auth', 'status', '--hostname', GITHUB_HOST];
}

function locateRequired(candidates: readonly string[], label: string): string {
  const found = candidates.find(executable);
  if (!found) {
    throw new GitHubRemoteError(`${label} is required for GitHub access but was not found in a trusted system location.`);
  }
  return found;
}

function appendBounded(
  chunks: Buffer[],
  chunk: Buffer,
  current: number,
  limit: number
): { bytes: number; truncated: boolean } {
  const remaining = limit - current;
  if (remaining <= 0) return { bytes: current, truncated: true };
  if (chunk.length > remaining) {
    chunks.push(chunk.subarray(0, remaining));
    return { bytes: limit, truncated: true };
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
  timeoutMs = PROCESS_TIMEOUT_MS,
  outputLimit = MAX_PROCESS_OUTPUT_BYTES
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
      const next = appendBounded(stdout, chunk, stdoutBytes, outputLimit);
      stdoutBytes = next.bytes;
      truncated ||= next.truncated;
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const next = appendBounded(stderr, chunk, stderrBytes, outputLimit);
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
  if (result.truncated) throw new GitHubRemoteError(`${message} The helper response exceeded the safe output limit.`);
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
  const result = await runExact(gh, githubAuthStatusArgs(), cwd, env);
  if (result.exitCode !== 0 || result.timedOut || result.truncated) {
    throw new GitHubRemoteError(
      'GitHub CLI authentication is unavailable for this desktop account. Sign in once outside local-cgpt with `gh auth login --hostname github.com --web`, then retry. Do not paste a token into ChatGPT or local-cgpt.'
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
    'GitHub operations require a named local branch; detached HEAD is not supported.'
  );
  await localGit(
    roots,
    cwd,
    ['check-ref-format', '--branch', branch],
    'The current Git branch name is not safe to use.'
  );
  const head = await localGit(roots, cwd, ['rev-parse', '--verify', 'HEAD^{commit}'], 'The current Git commit could not be resolved.');
  const remote = await localGit(
    roots,
    cwd,
    ['config', '--get', 'remote.origin.url'],
    'This repository has no origin remote. Configure a GitHub origin locally before using GitHub operations.'
  );
  const parsed = parseGitHubRemote(remote);
  if (!parsed) {
    throw new GitHubRemoteError(
      'The origin remote is not a supported github.com repository. The hardened transport accepts only GitHub HTTPS or SSH repository identities and always reconstructs its own HTTPS network destination.'
    );
  }

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

export function githubSyncHostFetchArgs(remoteUrl: string): readonly string[] {
  return [
    'fetch',
    '--quiet',
    '--prune',
    '--no-tags',
    remoteUrl,
    '+refs/heads/*:refs/remotes/origin/*'
  ];
}

export function githubSyncLocalImportArgs(bundlePath: string): readonly string[] {
  return [
    '-c', 'core.hooksPath=/dev/null',
    '-c', 'core.fsmonitor=false',
    '-c', 'credential.helper=',
    '-c', 'protocol.allow=never',
    '-c', 'protocol.file.allow=always',
    '-c', 'protocol.ext.allow=never',
    'fetch',
    '--quiet',
    '--prune',
    '--no-tags',
    bundlePath,
    '+refs/remotes/origin/*:refs/remotes/origin/*'
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

async function copyHostFileIntoApproved(source: string, destination: string): Promise<void> {
  const input = await hostFs.open(source, 'r');
  let output: Awaited<ReturnType<typeof rawPromises.open>> | null = null;
  try {
    const stat = await input.stat();
    if (!stat.isFile()) throw new GitHubRemoteError('Git produced an invalid synchronization bundle.');
    if (stat.size > MAX_BUNDLE_BYTES) {
      throw new GitHubRemoteError(
        `The remote repository history bundle is too large for the hardened synchronization handoff (${Math.ceil(stat.size / (1024 * 1024))} MiB; limit 512 MiB).`
      );
    }
    output = await rawPromises.open(destination, 'wx', 0o600);
    const buffer = Buffer.allocUnsafe(FILE_COPY_CHUNK_BYTES);
    let position = 0;
    for (;;) {
      const { bytesRead } = await input.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      let written = 0;
      while (written < bytesRead) {
        const result = await output.write(buffer, written, bytesRead - written, null);
        written += result.bytesWritten;
      }
      position += bytesRead;
    }
  } finally {
    await input.close().catch(() => undefined);
    await output?.close().catch(() => undefined);
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

async function ghJson<T>(
  gh: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  args: readonly string[],
  failure: string,
  schema: z.ZodType<T>,
  stdin?: Record<string, unknown>
): Promise<T> {
  const result = await runExact(
    gh,
    ['api', ...args],
    cwd,
    env,
    stdin === undefined ? undefined : JSON.stringify(stdin),
    PROCESS_TIMEOUT_MS,
    MAX_API_OUTPUT_BYTES
  );
  const text = requireSuccess(result, failure);
  try {
    return schema.parse(JSON.parse(text));
  } catch (error) {
    if (error instanceof GitHubRemoteError) throw error;
    throw new GitHubRemoteError('GitHub returned an unexpected response shape.');
  }
}

function requireGitHubResultUrl(url: string, owner: string, repo: string, kind: 'issues' | 'pull'): string {
  const prefix = `https://${GITHUB_HOST}/${owner}/${repo}/${kind}/`;
  if (!url.startsWith(prefix)) throw new GitHubRemoteError('GitHub returned an unexpected result URL.');
  return url;
}

function boundedListLimit(limit: number | undefined): number {
  return limit ?? 30;
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
 * Fetch GitHub branch state into a private app-owned bare repository, bundle only those fetched
 * refs, then import the bundle into refs/remotes/origin/* from the offline command sandbox.
 * Local branches, the index, and the working tree are never changed by this action.
 */
export async function syncGitHubRemote(
  roots: readonly Root[],
  cwd: string
): Promise<GitHubSyncResult> {
  const local = await discoverLocalRepository(roots, cwd);
  return withPrivateTransport(roots, async ({ dir, git, gh, env }) => {
    await ensureGhAuthenticated(gh, dir, env);
    const bare = path.join(dir, 'repo.git');
    await hostFs.mkdir(bare, { mode: 0o700 });
    requireSuccess(
      await runExact(git, [...hostGitArgs(bare, gh, false), 'init', '--bare', '--quiet'], dir, env),
      'The private GitHub synchronization repository could not be initialized.'
    );

    const fetched = await runExact(
      git,
      [...hostGitArgs(bare, gh, false), ...githubSyncHostFetchArgs(local.httpsUrl)],
      dir,
      env,
      undefined,
      PROCESS_TIMEOUT_MS,
      MAX_API_OUTPUT_BYTES
    );
    requireSuccess(
      fetched,
      'GitHub branch synchronization failed. Check repository access and network connectivity, then retry.'
    );

    const privateBundle = path.join(dir, 'remote.bundle');
    requireSuccess(
      await runExact(
        git,
        [...hostGitArgs(bare, gh, true), 'bundle', 'create', privateBundle, '--all'],
        dir,
        env,
        undefined,
        PROCESS_TIMEOUT_MS,
        MAX_API_OUTPUT_BYTES
      ),
      'The fetched GitHub refs could not be packaged for the contained handoff.'
    );

    const localBundle = path.join(local.gitDir, `.local-cgpt-sync-${randomUUID()}.bundle`);
    try {
      await copyHostFileIntoApproved(privateBundle, localBundle);
      await localGit(
        roots,
        local.topLevel,
        githubSyncLocalImportArgs(localBundle),
        'The fetched GitHub refs could not be imported into local remote-tracking refs.'
      );
    } finally {
      await rawPromises.unlink(localBundle).catch(() => undefined);
    }

    const refsText = await localGit(
      roots,
      local.topLevel,
      ['for-each-ref', '--format=%(refname:short) %(objectname)', 'refs/remotes/origin'],
      'The synchronized GitHub refs could not be listed.'
    );
    const refs = refsText
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 200)
      .map((line) => {
        const separator = line.lastIndexOf(' ');
        if (separator <= 0) throw new GitHubRemoteError('Git returned an invalid remote-tracking ref after synchronization.');
        const name = line.slice(0, separator);
        const head = line.slice(separator + 1);
        if (!/^[0-9a-f]{40}$/i.test(head)) throw new GitHubRemoteError('Git returned an invalid remote-tracking commit after synchronization.');
        return { name, head };
      });
    const currentRemoteHead = refs.find((ref) => ref.name === `origin/${local.branch}`)?.head;
    const defaultBranch = await safeDefaultBranch(gh, dir, env, local.owner, local.repo);
    return {
      owner: local.owner,
      repo: local.repo,
      branch: local.branch,
      head: local.head,
      remoteUrl: local.httpsUrl,
      defaultBranch,
      refs,
      ...(currentRemoteHead ? { currentRemoteHead } : {})
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
    requireSuccess(
      await runExact(git, [...hostGitArgs(bare, gh, false), 'init', '--bare', '--quiet'], dir, env),
      'The private GitHub publication repository could not be initialized.'
    );

    const bundle = await createBundle(roots, local);
    const privateBundle = path.join(dir, 'branch.bundle');
    try {
      await hostFs.writeFile(privateBundle, bundle.bytes, { mode: 0o600 });
    } finally {
      await rawPromises.unlink(bundle.path).catch(() => undefined);
    }

    requireSuccess(
      await runExact(
        git,
        [...hostGitArgs(bare, gh, true), 'fetch', '--quiet', '--no-tags', privateBundle, `refs/heads/${local.branch}:refs/heads/local-cgpt`],
        dir,
        env
      ),
      'The committed branch could not be imported into the private GitHub publication repository.'
    );

    const importedHead = requireSuccess(
      await runExact(git, [...hostGitArgs(bare, gh, false), 'rev-parse', '--verify', 'refs/heads/local-cgpt^{commit}'], dir, env),
      'The publication branch could not be verified before network access.'
    );
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
        'GitHub rejected the push. The remote branch may have advanced or the signed-in account may lack write permission. Run the GitHub sync action, rebase locally if needed, then retry; local-cgpt never force-pushes.'
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

export async function listGitHubPullRequests(
  roots: readonly Root[],
  cwd: string,
  input: { state?: 'open' | 'closed' | 'all'; limit?: number } = {}
): Promise<GitHubPullRequestSummary[]> {
  const local = await discoverLocalRepository(roots, cwd);
  return withPrivateTransport(roots, async ({ dir, gh, env }) => {
    await ensureGhAuthenticated(gh, dir, env);
    const limit = boundedListLimit(input.limit);
    const state = input.state ?? 'open';
    const data = await ghJson(
      gh,
      dir,
      env,
      [
        `repos/${local.owner}/${local.repo}/pulls?state=${state}&per_page=${limit}&sort=updated&direction=desc`,
        '--jq',
        '[.[] | {number,title,state,draft,url:.html_url,headRef:.head.ref,headSha:.head.sha,baseRef:.base.ref,baseSha:.base.sha,updatedAt:.updated_at}]'
      ],
      'GitHub pull requests could not be listed.',
      z.array(prSummarySchema)
    );
    return data.map((item) => ({ ...item, url: requireGitHubResultUrl(item.url, local.owner, local.repo, 'pull') }));
  });
}

export async function getGitHubPullRequest(
  roots: readonly Root[],
  cwd: string,
  number: number
): Promise<GitHubPullRequestDetail> {
  const local = await discoverLocalRepository(roots, cwd);
  return withPrivateTransport(roots, async ({ dir, gh, env }) => {
    await ensureGhAuthenticated(gh, dir, env);
    const item = await ghJson(
      gh,
      dir,
      env,
      [
        `repos/${local.owner}/${local.repo}/pulls/${number}`,
        '--jq',
        '{number,title,state,draft,url:.html_url,headRef:.head.ref,headSha:.head.sha,baseRef:.base.ref,baseSha:.base.sha,updatedAt:.updated_at,body:(.body // ""),merged,mergeable}'
      ],
      `GitHub pull request #${number} could not be read.`,
      prDetailSchema
    );
    return { ...item, url: requireGitHubResultUrl(item.url, local.owner, local.repo, 'pull') };
  });
}

export async function getGitHubPullRequestDiff(
  roots: readonly Root[],
  cwd: string,
  number: number
): Promise<{ number: number; diff: string }> {
  const local = await discoverLocalRepository(roots, cwd);
  return withPrivateTransport(roots, async ({ dir, gh, env }) => {
    await ensureGhAuthenticated(gh, dir, env);
    const result = await runExact(
      gh,
      ['api', '-H', 'Accept: application/vnd.github.v3.diff', `repos/${local.owner}/${local.repo}/pulls/${number}`],
      dir,
      env,
      undefined,
      PROCESS_TIMEOUT_MS,
      MAX_API_OUTPUT_BYTES
    );
    return { number, diff: requireSuccess(result, `GitHub pull request #${number} diff could not be read.`) };
  });
}

async function patchGitHubPullRequest(
  roots: readonly Root[],
  local: LocalRepository,
  number: number,
  patch: Record<string, unknown>,
  failure: string
): Promise<GitHubPullRequestDetail> {
  return withPrivateTransport(roots, async ({ dir, gh, env }) => {
    await ensureGhAuthenticated(gh, dir, env);
    const item = await ghJson(
      gh,
      dir,
      env,
      [
        '--method', 'PATCH',
        `repos/${local.owner}/${local.repo}/pulls/${number}`,
        '--input', '-',
        '--jq',
        '{number,title,state,draft,url:.html_url,headRef:.head.ref,headSha:.head.sha,baseRef:.base.ref,baseSha:.base.sha,updatedAt:.updated_at,body:(.body // ""),merged,mergeable}'
      ],
      failure,
      prDetailSchema,
      patch
    );
    return { ...item, url: requireGitHubResultUrl(item.url, local.owner, local.repo, 'pull') };
  });
}

export async function updateGitHubPullRequest(
  roots: readonly Root[],
  cwd: string,
  number: number,
  input: { title?: string; body?: string; base?: string }
): Promise<GitHubPullRequestDetail> {
  const local = await discoverLocalRepository(roots, cwd);
  return patchGitHubPullRequest(
    roots,
    local,
    number,
    {
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.body !== undefined ? { body: input.body } : {}),
      ...(input.base !== undefined ? { base: input.base } : {})
    },
    `GitHub rejected the update to pull request #${number}.`
  );
}

export async function setGitHubPullRequestState(
  roots: readonly Root[],
  cwd: string,
  number: number,
  state: 'open' | 'closed'
): Promise<GitHubPullRequestDetail> {
  const local = await discoverLocalRepository(roots, cwd);
  return patchGitHubPullRequest(
    roots,
    local,
    number,
    { state },
    `GitHub rejected changing pull request #${number} to ${state}.`
  );
}

export async function createGitHubPullRequest(
  roots: readonly Root[],
  cwd: string,
  input: { title: string; body: string; base?: string; draft?: boolean }
): Promise<GitHubPullRequestResult> {
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
    const url = requireGitHubResultUrl(
      requireSuccess(
        result,
        'GitHub rejected pull-request creation. Check that the branch differs from the base and that the signed-in account can create pull requests.'
      ),
      pushed.owner,
      pushed.repo,
      'pull'
    );
    return { ...pushed, url, base };
  });
}

export async function listGitHubIssues(
  roots: readonly Root[],
  cwd: string,
  input: { state?: 'open' | 'closed' | 'all'; limit?: number } = {}
): Promise<GitHubIssueSummary[]> {
  const local = await discoverLocalRepository(roots, cwd);
  return withPrivateTransport(roots, async ({ dir, gh, env }) => {
    await ensureGhAuthenticated(gh, dir, env);
    const limit = boundedListLimit(input.limit);
    const state = input.state ?? 'open';
    const data = await ghJson(
      gh,
      dir,
      env,
      [
        `repos/${local.owner}/${local.repo}/issues?state=${state}&per_page=${limit}&sort=updated&direction=desc`,
        '--jq',
        '[.[] | select(.pull_request == null) | {number,title,state,url:.html_url,labels:[.labels[].name],updatedAt:.updated_at}]'
      ],
      'GitHub issues could not be listed.',
      z.array(issueSummarySchema)
    );
    return data.map((item) => ({ ...item, url: requireGitHubResultUrl(item.url, local.owner, local.repo, 'issues') }));
  });
}

async function readIssueForMutation(
  gh: string,
  dir: string,
  env: NodeJS.ProcessEnv,
  local: LocalRepository,
  number: number
): Promise<GitHubIssueDetail> {
  const rawSchema = issueDetailSchema.extend({ isPullRequest: z.boolean() });
  const item = await ghJson(
    gh,
    dir,
    env,
    [
      `repos/${local.owner}/${local.repo}/issues/${number}`,
      '--jq',
      '{number,title,state,url:.html_url,labels:[.labels[].name],updatedAt:.updated_at,body:(.body // ""),isPullRequest:(.pull_request != null)}'
    ],
    `GitHub issue #${number} could not be read.`,
    rawSchema
  );
  if (item.isPullRequest) throw new GitHubRemoteError(`#${number} is a pull request, not an issue. Use a pull-request action.`);
  return {
    number: item.number,
    title: item.title,
    state: item.state,
    url: requireGitHubResultUrl(item.url, local.owner, local.repo, 'issues'),
    labels: item.labels,
    updatedAt: item.updatedAt,
    body: item.body
  };
}

export async function getGitHubIssue(
  roots: readonly Root[],
  cwd: string,
  number: number
): Promise<GitHubIssueDetail> {
  const local = await discoverLocalRepository(roots, cwd);
  return withPrivateTransport(roots, async ({ dir, gh, env }) => {
    await ensureGhAuthenticated(gh, dir, env);
    return readIssueForMutation(gh, dir, env, local, number);
  });
}

async function patchGitHubIssue(
  roots: readonly Root[],
  local: LocalRepository,
  number: number,
  patch: Record<string, unknown>,
  failure: string
): Promise<GitHubIssueDetail> {
  return withPrivateTransport(roots, async ({ dir, gh, env }) => {
    await ensureGhAuthenticated(gh, dir, env);
    await readIssueForMutation(gh, dir, env, local, number);
    const item = await ghJson(
      gh,
      dir,
      env,
      [
        '--method', 'PATCH',
        `repos/${local.owner}/${local.repo}/issues/${number}`,
        '--input', '-',
        '--jq',
        '{number,title,state,url:.html_url,labels:[.labels[].name],updatedAt:.updated_at,body:(.body // "")}'
      ],
      failure,
      issueDetailSchema,
      patch
    );
    return { ...item, url: requireGitHubResultUrl(item.url, local.owner, local.repo, 'issues') };
  });
}

export async function createGitHubIssue(
  roots: readonly Root[],
  cwd: string,
  input: { title: string; body: string; labels?: readonly string[] }
): Promise<GitHubIssueResult> {
  const local = await discoverLocalRepository(roots, cwd);
  return withPrivateTransport(roots, async ({ dir, gh, env }) => {
    await ensureGhAuthenticated(gh, dir, env);
    const result = await runExact(
      gh,
      ['api', '--method', 'POST', `repos/${local.owner}/${local.repo}/issues`, '--input', '-', '--jq', '.html_url'],
      dir,
      env,
      JSON.stringify({ title: input.title, body: input.body, ...(input.labels ? { labels: [...input.labels] } : {}) })
    );
    return {
      url: requireGitHubResultUrl(
        requireSuccess(result, 'GitHub rejected issue creation. Check repository access and any requested labels, then retry.'),
        local.owner,
        local.repo,
        'issues'
      ),
      owner: local.owner,
      repo: local.repo
    };
  });
}

export async function updateGitHubIssue(
  roots: readonly Root[],
  cwd: string,
  number: number,
  input: { title?: string; body?: string; labels?: readonly string[] }
): Promise<GitHubIssueDetail> {
  const local = await discoverLocalRepository(roots, cwd);
  return patchGitHubIssue(
    roots,
    local,
    number,
    {
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.body !== undefined ? { body: input.body } : {}),
      ...(input.labels !== undefined ? { labels: [...input.labels] } : {})
    },
    `GitHub rejected the update to issue #${number}.`
  );
}

export async function setGitHubIssueState(
  roots: readonly Root[],
  cwd: string,
  number: number,
  state: 'open' | 'closed'
): Promise<GitHubIssueDetail> {
  const local = await discoverLocalRepository(roots, cwd);
  return patchGitHubIssue(
    roots,
    local,
    number,
    { state },
    `GitHub rejected changing issue #${number} to ${state}.`
  );
}

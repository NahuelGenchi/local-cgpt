import { z } from 'zod';
import {
  createGitHubIssue,
  createGitHubPullRequest,
  getGitHubIssue,
  getGitHubPullRequest,
  getGitHubPullRequestDiff,
  GitHubRemoteError,
  githubRepositoryStatus,
  listGitHubIssues,
  listGitHubPullRequests,
  pushGitHubCurrentBranch,
  setGitHubIssueState,
  setGitHubPullRequestState,
  syncGitHubRemote,
  updateGitHubIssue,
  updateGitHubPullRequest
} from '../github-remote.js';
import { fail, resolveCwd, type SurfaceRegistrar } from './kernel.js';

const action = z.enum([
  'status',
  'sync',
  'push',
  'pr_list',
  'pr_get',
  'pr_diff',
  'pr_create',
  'pr_update',
  'pr_close',
  'pr_reopen',
  'issue_list',
  'issue_get',
  'issue_create',
  'issue_update',
  'issue_close',
  'issue_reopen'
]);

type Action = z.infer<typeof action>;
const LIST_ACTIONS = new Set<Action>(['pr_list', 'issue_list']);
const NUMBER_ACTIONS = new Set<Action>([
  'pr_get',
  'pr_diff',
  'pr_update',
  'pr_close',
  'pr_reopen',
  'issue_get',
  'issue_update',
  'issue_close',
  'issue_reopen'
]);
const MUTATING_ACTIONS = new Set<Action>([
  'sync',
  'push',
  'pr_create',
  'pr_update',
  'pr_close',
  'pr_reopen',
  'issue_create',
  'issue_update',
  'issue_close',
  'issue_reopen'
]);
const OPTIONAL_FIELDS = ['number', 'title', 'body', 'labels', 'base', 'draft', 'state', 'limit'] as const;

function allowedFields(actionName: Action): ReadonlySet<(typeof OPTIONAL_FIELDS)[number]> {
  switch (actionName) {
    case 'pr_list':
    case 'issue_list':
      return new Set(['state', 'limit']);
    case 'pr_get':
    case 'pr_diff':
    case 'pr_close':
    case 'pr_reopen':
    case 'issue_get':
    case 'issue_close':
    case 'issue_reopen':
      return new Set(['number']);
    case 'pr_create':
      return new Set(['title', 'body', 'base', 'draft']);
    case 'pr_update':
      return new Set(['number', 'title', 'body', 'base']);
    case 'issue_create':
      return new Set(['title', 'body', 'labels']);
    case 'issue_update':
      return new Set(['number', 'title', 'body', 'labels']);
    default:
      return new Set();
  }
}

function pullListText(items: Awaited<ReturnType<typeof listGitHubPullRequests>>): string {
  if (items.length === 0) return 'No matching GitHub pull requests.';
  return items
    .map(
      (item) =>
        `#${item.number} ${item.state}${item.draft ? ' draft' : ''} · ${item.headRef} → ${item.baseRef} · ${item.title}`
    )
    .join('\n');
}

function issueListText(items: Awaited<ReturnType<typeof listGitHubIssues>>): string {
  if (items.length === 0) return 'No matching GitHub issues.';
  return items.map((item) => `#${item.number} ${item.state} · ${item.title}`).join('\n');
}

export function registerGithubTool(reg: SurfaceRegistrar): void {
  if (!reg.exposedCaps.network) return;

  reg.register(
    'github',
    {
      title: 'Local GitHub repository workflow',
      description:
        'Manage the github.com repository proven from this approved local workspace through local-cgpt’s restricted transport. ' +
        'Read actions: status, pr_list, pr_get, pr_diff, issue_list, issue_get. ' +
        'sync safely refreshes only refs/remotes/origin/* through an app-owned bare repository and an offline contained bundle import. ' +
        'Write actions: push, pr_create/pr_update/pr_close/pr_reopen, issue_create/issue_update/issue_close/issue_reopen. ' +
        'pr_create publishes the current clean committed branch first. There is no merge, force-push, token, repository, or arbitrary URL field. ' +
        'The separate ChatGPT GitHub app may be used for complementary cloud context, but ordinary exec_command processes remain network-isolated.',
      inputSchema: z
        .object({
          action,
          workdir: z
            .string()
            .max(4096)
            .optional()
            .describe('Approved repository directory. Omit to use this chat’s current workspace.'),
          number: z.number().int().positive().max(2_147_483_647).optional().describe('PR or issue number for get/update/close/reopen actions.'),
          title: z.string().min(1).max(256).optional().describe('Required for create actions; optional replacement title for update actions.'),
          body: z.string().max(100_000).optional().describe('Issue or pull-request body. Empty string clears an existing body on update.'),
          labels: z
            .array(z.string().min(1).max(100))
            .max(20)
            .optional()
            .describe('Issue create/update only. An empty array clears labels during issue_update.'),
          base: z.string().min(1).max(255).optional().describe('PR create/update only. Retargets the PR when used with pr_update.'),
          draft: z.boolean().optional().describe('pr_create only. Defaults to true.'),
          state: z.enum(['open', 'closed', 'all']).optional().describe('List actions only. Defaults to open.'),
          limit: z.number().int().min(1).max(100).optional().describe('List actions only. Defaults to 30.')
        })
        .strict()
        .superRefine((input, ctx) => {
          const allowed = allowedFields(input.action);
          for (const field of OPTIONAL_FIELDS) {
            if (input[field] !== undefined && !allowed.has(field)) {
              ctx.addIssue({ code: 'custom', path: [field], message: `${field} is not valid with action=${input.action}` });
            }
          }
          if (NUMBER_ACTIONS.has(input.action) && input.number === undefined) {
            ctx.addIssue({ code: 'custom', path: ['number'], message: `${input.action} requires number` });
          }
          if ((input.action === 'pr_create' || input.action === 'issue_create') && !input.title) {
            ctx.addIssue({ code: 'custom', path: ['title'], message: `${input.action} requires title` });
          }
          if (input.action === 'pr_update' && input.title === undefined && input.body === undefined && input.base === undefined) {
            ctx.addIssue({ code: 'custom', path: ['action'], message: 'pr_update requires title, body, or base' });
          }
          if (input.action === 'issue_update' && input.title === undefined && input.body === undefined && input.labels === undefined) {
            ctx.addIssue({ code: 'custom', path: ['action'], message: 'issue_update requires title, body, or labels' });
          }
          if (LIST_ACTIONS.has(input.action) && input.state === undefined && input.limit === undefined) {
            // Defaults are intentional; no issue to add. Keeping this branch explicit documents that
            // an empty list request is valid rather than accidentally under-specified.
          }
        }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
    },
    async (input) =>
      reg.guarded('network', 'github', async () => {
        const dir = await resolveCwd(reg.ctx, input.workdir);
        try {
          if (input.action === 'status') {
            const status = await githubRepositoryStatus(reg.ctx.roots, dir.real);
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `GitHub ready: ${status.owner}/${status.repo} · ${status.branch} @ ${status.head.slice(0, 12)} · default ${status.defaultBranch ?? 'unknown'}.`
                }
              ],
              structuredContent: {
                action: 'status',
                repository: `${status.owner}/${status.repo}`,
                branch: status.branch,
                head: status.head,
                default_branch: status.defaultBranch ?? null
              }
            };
          }

          if (input.action === 'pr_list') {
            const items = await listGitHubPullRequests(reg.ctx.roots, dir.real, {
              ...(input.state ? { state: input.state } : {}),
              ...(input.limit ? { limit: input.limit } : {})
            });
            return {
              content: [{ type: 'text' as const, text: pullListText(items) }],
              structuredContent: { action: 'pr_list', pull_requests: items }
            };
          }

          if (input.action === 'pr_get') {
            const item = await getGitHubPullRequest(reg.ctx.roots, dir.real, input.number!);
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `#${item.number} ${item.state}${item.draft ? ' draft' : ''} · ${item.headRef} → ${item.baseRef} · ${item.title}\n\n${item.body}`
                }
              ],
              structuredContent: { action: 'pr_get', pull_request: item }
            };
          }

          if (input.action === 'pr_diff') {
            const item = await getGitHubPullRequestDiff(reg.ctx.roots, dir.real, input.number!);
            return {
              content: [{ type: 'text' as const, text: item.diff || `Pull request #${item.number} has an empty diff.` }],
              structuredContent: { action: 'pr_diff', number: item.number, diff: item.diff }
            };
          }

          if (input.action === 'issue_list') {
            const items = await listGitHubIssues(reg.ctx.roots, dir.real, {
              ...(input.state ? { state: input.state } : {}),
              ...(input.limit ? { limit: input.limit } : {})
            });
            return {
              content: [{ type: 'text' as const, text: issueListText(items) }],
              structuredContent: { action: 'issue_list', issues: items }
            };
          }

          if (input.action === 'issue_get') {
            const item = await getGitHubIssue(reg.ctx.roots, dir.real, input.number!);
            return {
              content: [{ type: 'text' as const, text: `#${item.number} ${item.state} · ${item.title}\n\n${item.body}` }],
              structuredContent: { action: 'issue_get', issue: item }
            };
          }

          if (reg.ctx.readOnly && MUTATING_ACTIONS.has(input.action)) {
            return fail('TOOL_DISABLED: GitHub mutations are disabled while local-cgpt is in read-only mode.');
          }

          if (input.action === 'sync') {
            const synced = await syncGitHubRemote(reg.ctx.roots, dir.real);
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Synchronized ${synced.refs.length} GitHub branch ref${synced.refs.length === 1 ? '' : 's'} into local refs/remotes/origin/* without changing local branches or the working tree.${synced.currentRemoteHead ? ` Current remote ${synced.branch} is ${synced.currentRemoteHead.slice(0, 12)}.` : ''}`
                }
              ],
              structuredContent: {
                action: 'sync',
                repository: `${synced.owner}/${synced.repo}`,
                branch: synced.branch,
                head: synced.head,
                default_branch: synced.defaultBranch ?? null,
                current_remote_head: synced.currentRemoteHead ?? null,
                refs: synced.refs
              }
            };
          }

          if (input.action === 'push') {
            const pushed = await pushGitHubCurrentBranch(reg.ctx.roots, dir.real);
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Published ${pushed.owner}/${pushed.repo} branch ${pushed.branch} at ${pushed.head.slice(0, 12)}. No force-push was used.`
                }
              ],
              structuredContent: {
                action: 'push',
                repository: `${pushed.owner}/${pushed.repo}`,
                branch: pushed.branch,
                head: pushed.head
              }
            };
          }

          if (input.action === 'pr_create') {
            const created = await createGitHubPullRequest(reg.ctx.roots, dir.real, {
              title: input.title!,
              body: input.body ?? '',
              ...(input.base ? { base: input.base } : {}),
              ...(input.draft === undefined ? {} : { draft: input.draft })
            });
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Published ${created.branch} at ${created.head.slice(0, 12)} and created GitHub pull request: ${created.url}`
                }
              ],
              structuredContent: {
                action: 'pr_create',
                repository: `${created.owner}/${created.repo}`,
                branch: created.branch,
                head: created.head,
                base: created.base,
                url: created.url
              }
            };
          }

          if (input.action === 'pr_update') {
            const updated = await updateGitHubPullRequest(reg.ctx.roots, dir.real, input.number!, {
              ...(input.title !== undefined ? { title: input.title } : {}),
              ...(input.body !== undefined ? { body: input.body } : {}),
              ...(input.base !== undefined ? { base: input.base } : {})
            });
            return {
              content: [{ type: 'text' as const, text: `Updated GitHub pull request #${updated.number}: ${updated.url}` }],
              structuredContent: { action: 'pr_update', pull_request: updated }
            };
          }

          if (input.action === 'pr_close' || input.action === 'pr_reopen') {
            const state = input.action === 'pr_close' ? 'closed' : 'open';
            const updated = await setGitHubPullRequestState(reg.ctx.roots, dir.real, input.number!, state);
            return {
              content: [{ type: 'text' as const, text: `${state === 'closed' ? 'Closed' : 'Reopened'} GitHub pull request #${updated.number}: ${updated.url}` }],
              structuredContent: { action: input.action, pull_request: updated }
            };
          }

          if (input.action === 'issue_create') {
            const created = await createGitHubIssue(reg.ctx.roots, dir.real, {
              title: input.title!,
              body: input.body ?? '',
              ...(input.labels ? { labels: input.labels } : {})
            });
            return {
              content: [{ type: 'text' as const, text: `Created GitHub issue: ${created.url}` }],
              structuredContent: {
                action: 'issue_create',
                repository: `${created.owner}/${created.repo}`,
                url: created.url
              }
            };
          }

          if (input.action === 'issue_update') {
            const updated = await updateGitHubIssue(reg.ctx.roots, dir.real, input.number!, {
              ...(input.title !== undefined ? { title: input.title } : {}),
              ...(input.body !== undefined ? { body: input.body } : {}),
              ...(input.labels !== undefined ? { labels: input.labels } : {})
            });
            return {
              content: [{ type: 'text' as const, text: `Updated GitHub issue #${updated.number}: ${updated.url}` }],
              structuredContent: { action: 'issue_update', issue: updated }
            };
          }

          const state = input.action === 'issue_close' ? 'closed' : 'open';
          const updated = await setGitHubIssueState(reg.ctx.roots, dir.real, input.number!, state);
          return {
            content: [{ type: 'text' as const, text: `${state === 'closed' ? 'Closed' : 'Reopened'} GitHub issue #${updated.number}: ${updated.url}` }],
            structuredContent: { action: input.action, issue: updated }
          };
        } catch (error) {
          if (error instanceof GitHubRemoteError) return fail(`github failed: ${error.message}`);
          throw error;
        }
      })
  );
}

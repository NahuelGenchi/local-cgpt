import { z } from 'zod';
import {
  createGitHubIssue,
  createGitHubPullRequest,
  GitHubRemoteError,
  githubRepositoryStatus,
  pushGitHubCurrentBranch
} from '../github-remote.js';
import { fail, resolveCwd, type SurfaceRegistrar } from './kernel.js';

const action = z.enum(['status', 'push', 'issue_create', 'pr_create']);

export function registerGithubTool(reg: SurfaceRegistrar): void {
  if (!reg.exposedCaps.network) return;

  reg.register(
    'github',
    {
      title: 'GitHub repository workflow',
      description:
        'Use the approved workspace repository on github.com through local-cgpt’s restricted network transport. ' +
        'status verifies repository identity and existing GitHub CLI sign-in; push publishes exactly the current clean committed branch without force-push; ' +
        'issue_create creates a GitHub issue; pr_create first publishes the current clean committed branch and then creates a pull request. ' +
        'This tool has no token or arbitrary URL field. Ordinary exec_command processes remain network-isolated.',
      inputSchema: z
        .object({
          action,
          workdir: z
            .string()
            .max(4096)
            .optional()
            .describe('Approved repository directory. Omit to use this chat’s current workspace.'),
          title: z.string().min(1).max(256).optional().describe('Required for issue_create and pr_create.'),
          body: z.string().max(100_000).optional().describe('Issue or pull-request body. Defaults to empty.'),
          labels: z
            .array(z.string().min(1).max(100))
            .max(20)
            .optional()
            .describe('issue_create only: existing GitHub label names.'),
          base: z.string().min(1).max(255).optional().describe('pr_create only: base branch. Defaults to the repository default branch.'),
          draft: z.boolean().optional().describe('pr_create only. Defaults to true.')
        })
        .strict()
        .superRefine((input, ctx) => {
          const reject = (field: 'title' | 'body' | 'labels' | 'base' | 'draft', message: string): void => {
            if (input[field] !== undefined) ctx.addIssue({ code: 'custom', path: [field], message });
          };
          if (input.action === 'issue_create' || input.action === 'pr_create') {
            if (!input.title) ctx.addIssue({ code: 'custom', path: ['title'], message: `${input.action} requires title` });
          } else {
            reject('title', `title is not valid with action=${input.action}`);
            reject('body', `body is not valid with action=${input.action}`);
          }
          if (input.action !== 'issue_create') reject('labels', 'labels is only valid with action=issue_create');
          if (input.action !== 'pr_create') {
            reject('base', 'base is only valid with action=pr_create');
            reject('draft', 'draft is only valid with action=pr_create');
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

          if (reg.ctx.readOnly) {
            return fail('TOOL_DISABLED: GitHub mutations are disabled while local-cgpt is in read-only mode.');
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
        } catch (error) {
          if (error instanceof GitHubRemoteError) return fail(`github failed: ${error.message}`);
          throw error;
        }
      })
  );
}

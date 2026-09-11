import { describe, expect, it } from 'vitest';
import { emptyEvidence } from '../src/main/mcp/call-context.js';
import { summarizeToolCall } from '../src/main/session/summarize.js';

const summarize = (
  args: unknown,
  patch: Partial<ReturnType<typeof emptyEvidence>> = {},
  outcome: 'ok' | 'error' | 'rejected' = 'error'
) =>
  summarizeToolCall({
    tool: 'exec_command',
    args,
    evidence: { ...emptyEvidence(), ...patch },
    outcome,
    durationMs: 10,
    resultHead: 'head line'
  });

describe('command batch summaries', () => {
  it('reports a finished non-zero batch as completed with errors', () => {
    const result = summarize(
      {
        cmds: ['git status --short', 'git remote -v', 'find .. -name AGENTS.md', 'git log --oneline -8']
      },
      { exitCode: 1, durationMs: 1462, running: false }
    );

    expect(result).toMatchObject({
      kind: 'run',
      title: 'Completed with errors',
      detail: '4-command batch',
      metric: '✕ exit 1',
      tone: 'warn'
    });
  });

  it('keeps a single non-zero command as a failure', () => {
    expect(
      summarize({ cmd: 'npm test' }, { exitCode: 1, durationMs: 900, running: false })
    ).toMatchObject({
      title: 'Command failed npm test',
      metric: '✕ exit 1',
      tone: 'bad'
    });
  });

  it('does not soften a timed-out batch', () => {
    expect(
      summarize(
        { cmds: ['echo first', 'sleep 100'] },
        { exitCode: null, timedOut: true, durationMs: 10_000, running: false }
      )
    ).toMatchObject({
      title: 'Command failed a command',
      metric: '✕ timed out',
      tone: 'bad'
    });
  });

  it('does not soften an error without a completed process exit', () => {
    expect(
      summarize(
        { cmds: ['echo first', 'echo second'] },
        { exitCode: null, durationMs: null, running: false }
      )
    ).toMatchObject({
      title: 'Could not run a command',
      metric: '✕ failed',
      tone: 'bad'
    });
  });

  it('does not describe a rejected batch as completed', () => {
    const rejected = summarize(
      { cmds: ['echo first', 'echo second'] },
      { exitCode: 1, running: false },
      'rejected'
    );

    expect(rejected.title).not.toBe('Completed with errors');
    expect(rejected).toMatchObject({ metric: 'refused', tone: 'warn' });
  });
});

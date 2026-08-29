/**
 * The exec output budget as it survives the real handler wiring, over `tools/call`.
 *
 * `exec-output-budget.test.ts` pins the formatter, but it builds its own `ExecCommandToolOutput`
 * and therefore chooses the policy itself. That cannot see which constant `tools-core` actually
 * hands the process manager: passing `DEFAULT_TRUNCATION_POLICY` at the handler would restore the
 * 10_000-token ceiling, make every `max_output_tokens` above the default inert again, and leave
 * every unit test passing.
 *
 * So this goes through the server the connector really serves: one `exec_command` request with
 * `max_output_tokens: 30000`, one without, against a command that emits ~200 KB.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import { startMcpServer, type McpEndpoint } from '../src/main/mcp/server.js';
import { validateNewRoot } from '../src/main/sandbox.js';
import { initSessionStore, resetSessionStoreForTests, unsetSessionRootForTests } from '../src/main/session/store.js';

const PROBE_BYTES = 200_000;
const PROBE_FILE = 'budget-output.txt';
const PROBE_CMD = process.platform === 'win32'
  ? `Get-Content -Raw -LiteralPath '${PROBE_FILE}'`
  : `cat '${PROBE_FILE}'`;

let dir = '';
let endpoint: McpEndpoint | null = null;

afterEach(async () => {
  if (endpoint) await endpoint.stop().catch(() => undefined);
  endpoint = null;
  resetSessionStoreForTests();
  unsetSessionRootForTests();
  resetDurableForTests();
  if (dir) await fs.rm(dir, { recursive: true, force: true });
  dir = '';
});

async function serve(): Promise<McpEndpoint> {
  dir = await validateNewRoot(await fs.mkdtemp(path.join(os.tmpdir(), 'clf-budget-')), []);
  await fs.writeFile(path.join(dir, PROBE_FILE), 'x'.repeat(PROBE_BYTES), 'utf8');
  initConfigPath(dir);
  initSessionStore(dir);
  initDurableStore(dir);
  const cfg = defaultConfig();
  const capabilities = { ...cfg.capabilities, command: true };
  await saveConfig({ ...cfg, roots: [{ name: 'probe', path: dir }], capabilities, readOnly: false });
  return startMcpServer(() => ({
    roots: [{ name: 'probe', path: dir }],
    caps: capabilities,
    readOnly: false,
    sessionTools: false,
    agentTools: false
  }));
}

function sseJson(body: string): unknown {
  const data = body
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trimStart())
    .join('\n');
  return JSON.parse(data === '' ? body : data);
}

async function execOutput(url: string, maxOutputTokens: number | undefined): Promise<string> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'exec_command',
        arguments: {
          cmd: PROBE_CMD,
          workdir: '/probe',
          ...(maxOutputTokens === undefined ? {} : { max_output_tokens: maxOutputTokens })
        }
      }
    })
  });
  expect(response.status).toBe(200);
  const body = sseJson(await response.text()) as {
    result?: { content?: Array<{ type: string; text?: string }>; isError?: boolean };
  };
  const text = body.result?.content?.find((part) => part.type === 'text')?.text ?? '';
  expect(body.result?.isError ?? false, text).toBe(false);
  return text;
}

it('honours max_output_tokens above the default through the real exec_command handler', async () => {
  endpoint = await serve();

  const requested = await execOutput(endpoint.url, 30_000);
  const omitted = await execOutput(endpoint.url, undefined);

  expect(requested).toContain('Process exited with code 0');
  expect(requested).toContain('Warning: truncated output');
  expect(omitted).toContain('Warning: truncated output');
  expect(requested.length).toBeGreaterThan(100_000);
  expect(omitted.length).toBeLessThan(60_000);
  expect(requested.length).toBeGreaterThan(omitted.length);
}, 30_000);
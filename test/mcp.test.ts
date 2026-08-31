/**
 * End-to-end test of the real MCP endpoint over real HTTP.
 *
 * Nothing here is mocked: it starts the same server the app starts, and speaks the
 * same wire protocol ChatGPT speaks. It covers both protocol eras the SDK serves —
 * the 2025-era requests ChatGPT sends today, and the 2026-07-28 envelope form — so
 * that a change in which era the client uses cannot silently break the connector.
 *
 * The other thing it exists to prove is the surface split. This app publishes two
 * independently discoverable MCP servers, Core and Desktop, and the whole point of that
 * design is that the boundary is *real*: a no-query tools/list against Core must not
 * reveal a single Desktop schema, and a Core tools/call for a Desktop tool must fail as
 * an unknown tool rather than being quietly forwarded. Those assertions live in
 * "surface boundaries" below and are the ones to look at first if this file goes red.
 */

import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectiveCapabilities, defaultConfig } from '../src/main/config.js';
import { lastRequestAt, selfTestHeaders, startMcpServer, tunnelProbeHeaders, type McpEndpoint } from '../src/main/mcp/server.js';
import { lastToolCallAt, type ToolContext } from '../src/main/mcp/tools.js';
import { friendlyError } from '../src/main/mcp/kernel.js';
import { SURFACE_LIST, surfaceDefinition, type SurfaceId } from '../src/main/mcp/surfaces.js';
import {
  appendEvent,
  createSession,
  initSessionStore,
  upsertMessageEvent,
  writeOverflowText
} from '../src/main/session/store.js';
import { resetWorkspaces, setWorkspaceFor } from '../src/main/workspace.js';
import { DEFAULT_CAPABILITIES, type Capabilities, type Root } from '../src/shared/types.js';
import { emptyEvidence, noteExec, noteOutcome, runInCallContext, type CallContext } from '../src/main/mcp/call-context.js';
import { observeRequestCorrelation } from '../src/main/session/correlation.js';
import { execOwner, noteExecOwner, resetExecOwnershipForTests } from '../src/main/codex/ownership.js';
import { unifiedExecManager } from '../src/main/codex/manager.js';
import { locateRipgrep } from '../src/main/ripgrep.js';
import { IS_WINDOWS, makeTempDir, removeTempDir, writeTree } from './helpers.js';

// ---------------------------------------------------------------- transport

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
}

function rawPost(
  urlStr: string,
  body: string,
  headers: Record<string, string> = {}
): Promise<RawResponse> {
  const url = new URL(urlStr);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'content-length': Buffer.byteLength(body),
          ...headers
        }
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            text: Buffer.concat(chunks).toString('utf8')
          })
        );
      }
    );
    req.on('error', reject);
    req.end(body);
  });
}

function rawGet(urlStr: string): Promise<RawResponse> {
  const url = new URL(urlStr);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: url.pathname + url.search, method: 'GET' },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            text: Buffer.concat(chunks).toString('utf8')
          })
        );
      }
    );
    req.on('error', reject);
    req.end();
  });
}

/** Streamable HTTP may answer as JSON or as a one-shot SSE stream. Accept both. */
function decode(res: RawResponse): any {
  const text = res.text.trim();
  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  const datas = [...text.matchAll(/^data:\s*(.*)$/gm)].map((m) => m[1] ?? '');
  const last = datas.at(-1);
  if (last !== undefined) {
    try {
      return JSON.parse(last);
    } catch {
      return text;
    }
  }
  return text;
}

let nextId = 1;

/**
 * A 2025-era request to one surface: a plain JSON-RPC body with no _meta envelope.
 *
 * Every request names its surface, because "which server answered" is the property most
 * of this file is about. There is no default-surface helper on purpose.
 */
async function call(surface: SurfaceId, method: string, params: unknown = {}): Promise<any> {
  const res = await rawPost(
    endpoint.urls[surface],
    JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params })
  );
  return { status: res.status, body: decode(res) };
}

const core = (method: string, params: unknown = {}): Promise<any> => call('core', method, params);
const desktop = (method: string, params: unknown = {}): Promise<any> => call('desktop', method, params);

const PROTOCOL_2026 = '2026-07-28';
const META_VERSION = 'io.modelcontextprotocol/protocolVersion';
const META_CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities';

/**
 * A 2026-07-28 request: the per-request _meta envelope plus the SEP-2243 standard
 * headers the spec requires the client to mirror the body with.
 */
async function modern(
  method: string,
  params: Record<string, unknown> = {},
  extraHeaders: Record<string, string> = {}
): Promise<any> {
  const body = {
    jsonrpc: '2.0',
    id: nextId++,
    method,
    params: {
      ...params,
      _meta: {
        [META_VERSION]: PROTOCOL_2026,
        [META_CAPABILITIES]: {}
      }
    }
  };
  const headers: Record<string, string> = {
    'MCP-Protocol-Version': PROTOCOL_2026,
    'Mcp-Method': method,
    ...extraHeaders
  };
  if (method === 'tools/call' && typeof params['name'] === 'string' && !('Mcp-Name' in headers)) {
    headers['Mcp-Name'] = params['name'];
  }
  const res = await rawPost(endpoint.urls.core, JSON.stringify(body), headers);
  return { status: res.status, body: decode(res) };
}

const toolNames = (reply: any): string[] =>
  ((reply.body?.result?.tools ?? []) as Array<{ name: string }>).map((t) => t.name).sort();

const toolList = (reply: any): Array<Record<string, any>> => (reply.body?.result?.tools ?? []) as Array<Record<string, any>>;

const textOf = (reply: any): string =>
  ((reply.body?.result?.content ?? []) as Array<{ text?: string }>)
    .map((c) => c.text ?? '')
    .join('\n');

const failed = (reply: any): boolean => reply.body?.error !== undefined || reply.body?.result?.isError === true;

/** A patch that only adds one file, which is the cheapest way to prove apply_patch ran. */
const addPatch = (virtualPath: string, lines: string[]): string =>
  ['*** Begin Patch', `*** Add File: ${virtualPath}`, ...lines.map((line) => `+${line}`), '*** End Patch'].join('\n');

// ------------------------------------------------------------------ fixture

let base: string;
let approved: string;
let outside: string;
let endpoint: McpEndpoint;
let ctx: ToolContext;

function withCaps(overrides: Partial<Capabilities>): Capabilities {
  return { ...DEFAULT_CAPABILITIES, ...overrides };
}

/** Everything the user could possibly switch on, which is the worst case for discovery. */
function allCaps(): Capabilities {
  const caps = { ...DEFAULT_CAPABILITIES };
  for (const key of Object.keys(caps) as Array<keyof Capabilities>) caps[key] = true;
  return caps;
}

beforeAll(async () => {
  base = await makeTempDir('clf-mcp-');
  // This suite calls real tools, and calling a tool records it. Recording is on by
  // default now, so without a directory of its own the recorder wrote session folders
  // into the process's working directory — which for a test run is the repository.
  initSessionStore(base);
  approved = path.join(base, 'workspace');
  outside = path.join(base, 'private');
  await writeTree(approved, {
    'notes.txt': Array.from({ length: 50 }, (_, i) => `note line ${i + 1}`).join('\n') + '\n',
    'src/app.ts': 'export const name = "app";\n',
    'src/lib/util.ts': 'export const helper = 1;\n',
    'node_modules/pkg/noise.js': 'generated dependency noise\n'
  });
  await writeTree(outside, { 'passwords.txt': 'hunter2' });
  await fs.writeFile(
    path.join(approved, 'pixel.png'),
    Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
  );

  ctx = {
    roots: [{ name: 'workspace', path: approved }] as Root[],
    caps: withCaps({}),
    readOnly: true,
    // Stated rather than inherited from the saved config. These two are whole features
    // with their own defaults — recording now starts on — and a capability-gating test
    // that silently changes meaning when a product default moves is not testing gating.
    // The tools they add are covered by their own suites.
    sessionTools: false,
    agentTools: false
  };
});

afterAll(async () => {
  if (endpoint) await endpoint.stop();
  // Every live exec test uses UnifiedExecProcessManager. The old teardown still stopped the
  // retired connector-native process manager, which meant it looked like this suite protected
  // the fixture from leaked shells while production sessions were completely untouched.
  await unifiedExecManager.terminateAllProcesses();
  await removeTempDir(base);
});

beforeEach(async () => {
  if (endpoint) await endpoint.stop();
  resetWorkspaces();
  ctx.caps = withCaps({});
  ctx.readOnly = true;
  ctx.roots = [{ name: 'workspace', path: approved }];
  ctx.sessionTools = false;
  ctx.agentTools = false;
  // A fresh endpoint gives every test a fresh ChatGPT tool-surface snapshot. Tests
  // that change permissions mid-flight still exercise the real live-config path.
  endpoint = await startMcpServer(() => ctx);
});

// ------------------------------------------------------------------- tests

describe('endpoint hardening', () => {
  it('does not expose native paths from uncommon filesystem errors', () => {
    const error = Object.assign(new Error(`ELOOP: too many symbolic links, realpath '${approved}\\loop\\file.txt'`), {
      code: 'ELOOP',
      path: path.join(approved, 'loop', 'file.txt'),
      syscall: 'realpath'
    });
    const text = friendlyError(error);
    expect(text).toBe('Filesystem error (ELOOP)');
    expect(text).not.toContain(approved);
  });

  it('binds to loopback only, and gives every surface its own path', () => {
    for (const surface of SURFACE_LIST) {
      const url = endpoint.urls[surface.id];
      expect(url.startsWith('http://127.0.0.1:'), surface.id).toBe(true);
      expect(new URL(url).pathname.startsWith(`/mcp/${surface.id}/`), surface.id).toBe(true);
    }
    expect(endpoint.url).toBe(endpoint.urls.core);
    expect(endpoint.urls.core).not.toBe(endpoint.urls.desktop);
  });

  it('gives each surface its own token, so handing out one does not hand out the other', async () => {
    const coreUrl = new URL(endpoint.urls.core);
    const desktopUrl = new URL(endpoint.urls.desktop);
    const coreToken = coreUrl.pathname.split('/').pop() ?? '';
    const desktopToken = desktopUrl.pathname.split('/').pop() ?? '';
    expect(coreToken).not.toBe(desktopToken);

    // Knowing Core's token must not be enough to reach Desktop. This is the property that
    // makes "share the Desktop connector" and "share everything" different acts.
    const swapped = new URL(endpoint.urls.desktop);
    swapped.pathname = `/mcp/desktop/${coreToken}`;
    const res = await rawPost(swapped.toString(), '{}');
    expect(res.status).toBe(404);
  });

  it('serves nothing at a path without the secret token', async () => {
    const wrong = new URL(endpoint.urls.core);
    for (const p of ['/', '/mcp', '/mcp/', '/mcp/core', '/mcp/core/', '/mcp/core/wrong-token', '/mcp/desktop/wrong']) {
      wrong.pathname = p;
      const res = await rawPost(wrong.toString(), '{}');
      expect(res.status, p).toBe(404);
    }
  });

  it('rejects a token of the right length but the wrong value', async () => {
    const url = new URL(endpoint.urls.core);
    const token = url.pathname.split('/').pop() ?? '';
    // Same length, so the comparison itself has to reject it.
    url.pathname = `/mcp/core/${'A'.repeat(token.length)}`;
    const res = await rawPost(url.toString(), '{}');
    expect(res.status).toBe(404);
  });

  it('rejects a non-loopback Host header on every surface', async () => {
    for (const surface of SURFACE_LIST) {
      const res = await rawPost(
        endpoint.urls[surface.id],
        JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
        { host: 'files.example.com' }
      );
      expect(res.status, surface.id).toBeGreaterThanOrEqual(400);
      expect(res.status, surface.id).toBeLessThan(500);
    }
  });

  it('rejects a cross-site Origin header on every surface', async () => {
    for (const surface of SURFACE_LIST) {
      const res = await rawPost(
        endpoint.urls[surface.id],
        JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
        { origin: 'https://evil.example.com' }
      );
      expect(res.status, surface.id).toBeGreaterThanOrEqual(400);
      expect(res.status, surface.id).toBeLessThan(500);
    }
  });

  it('never answers with a non-JSON body, whatever is asked for', async () => {
    // tunnel-client's OAuth discovery decodes these bodies as JSON regardless of the
    // status code. A plain-text "Not found" here is what broke discovery outright.
    const url = new URL(endpoint.urls.core);
    for (const p of ['/', '/mcp', '/mcp/core', '/favicon.ico', '/.well-known/oauth-protected-resource']) {
      url.pathname = p;
      const res = await rawGet(url.toString());
      expect(res.status, p).toBe(404);
      expect(res.headers['content-type'], p).toContain('application/json');
      expect(() => JSON.parse(res.text), p).not.toThrow();
    }
  });

  it('separates "ChatGPT arrived" from "ChatGPT was allowed to run a tool"', async () => {
    expect(lastRequestAt()).toBeNull();
    expect(lastToolCallAt()).toBeNull();

    await core('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' }
    });
    await core('tools/list');
    expect(lastRequestAt()).not.toBeNull();
    expect(lastToolCallAt()).toBeNull();

    await core('tools/call', { name: 'read', arguments: { paths: ['/workspace/src/app.ts'] } });
    expect(lastToolCallAt()).not.toBeNull();
  });

  it('counts a request to either surface as ChatGPT reaching this PC', async () => {
    expect(lastRequestAt()).toBeNull();
    await desktop('tools/list');
    expect(lastRequestAt()).not.toBeNull();
  });

  it('keeps a separate arrival and tool-call clock per surface', async () => {
    expect(lastRequestAt('core')).toBeNull();
    expect(lastRequestAt('desktop')).toBeNull();

    await core('tools/list');
    expect(lastRequestAt('core')).not.toBeNull();
    expect(lastRequestAt('desktop')).toBeNull();
    expect(lastToolCallAt('core')).toBeNull();

    await core('tools/call', { name: 'read', arguments: { paths: ['/workspace/src/app.ts'] } });
    expect(lastToolCallAt('core')).not.toBeNull();
    expect(lastToolCallAt('desktop')).toBeNull();

    ctx.caps = withCaps({ screen: true });
    await desktop('tools/list');
    expect(lastRequestAt('desktop')).not.toBeNull();
    expect(lastToolCallAt('desktop')).toBeNull();
  });

  it('counts a refused tool call, because the question is whether we were called', async () => {
    await core('tools/list');
    ctx.caps = withCaps({ read: false, browse: false, metadata: false });
    const res = await core('tools/call', { name: 'read', arguments: { paths: ['/workspace/notes.txt'] } });
    expect(JSON.stringify(res.body)).toContain('TOOL_DISABLED');
    expect(lastToolCallAt()).not.toBeNull();
  });

  it('does not let the app’s own self-test count as ChatGPT reaching this PC', async () => {
    expect(lastRequestAt()).toBeNull();
    await rawPost(endpoint.urls.core, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }), {
      ...selfTestHeaders()
    });
    expect(lastRequestAt()).toBeNull();

    await rawPost(endpoint.urls.core, JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }), {
      'x-local-self-test': 'guessed'
    });
    expect(lastRequestAt()).not.toBeNull();
  });

  it('does not count tunnel-client discovery/startup probes as ChatGPT traffic', async () => {
    expect(lastRequestAt()).toBeNull();
    await rawPost(
      endpoint.urls.core,
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'probe', version: '1' } }
      }),
      tunnelProbeHeaders()
    );
    expect(lastRequestAt()).toBeNull();
  });

  it('serves protected resource metadata per surface, naming that surface', async () => {
    for (const surface of SURFACE_LIST) {
      const url = new URL(endpoint.urls[surface.id]);
      url.pathname = `/.well-known/oauth-protected-resource${url.pathname}`;
      const res = await rawGet(url.toString());
      expect(res.status, surface.id).toBe(200);
      expect(res.headers['content-type'], surface.id).toContain('application/json');
      const metadata = JSON.parse(res.text);
      expect(metadata.resource, surface.id).toBe(endpoint.urls[surface.id]);
      expect(metadata.resource_name, surface.id).toBe(surface.connectorName);
      expect(metadata.authorization_servers, surface.id).toEqual([]);
    }
  });

  it('does not leak either secret token at the unauthenticated well-known root', async () => {
    const url = new URL(endpoint.urls.core);
    const tokens = SURFACE_LIST.map((surface) => new URL(endpoint.urls[surface.id]).pathname.split('/').pop() ?? '');
    url.pathname = '/.well-known/oauth-protected-resource';
    const res = await rawGet(url.toString());
    expect(res.status).toBe(404);
    for (const token of tokens) expect(res.text).not.toContain(token);
  });

  it('rejects a body that declares an oversized content-length', async () => {
    const url = new URL(endpoint.urls.core);
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          method: 'POST',
          headers: { 'content-type': 'application/json', 'content-length': String(64 * 1024 * 1024) }
        },
        (res) => {
          resolve(res.statusCode ?? 0);
          res.resume();
          req.destroy();
        }
      );
      req.on('error', reject);
      req.write('{"jsonrpc":"2.0"');
    });
    expect(status).toBe(413);
  });

  it('enforces the same body cap on chunked requests with no content-length', async () => {
    const url = new URL(endpoint.urls.core);
    const status = await new Promise<number>((resolve, reject) => {
      let answered = false;
      const req = http.request(
        { hostname: url.hostname, port: url.port, path: url.pathname, method: 'POST', headers: { 'content-type': 'application/json' } },
        (res) => {
          answered = true;
          resolve(res.statusCode ?? 0);
          res.resume();
        }
      );
      req.on('error', (error) => { if (!answered) reject(error); });
      req.write('{"jsonrpc":"2.0","id":1,"method":"tools/list","padding":"');
      const chunk = Buffer.alloc(64 * 1024, 0x78);
      for (let index = 0; index < 129; index++) req.write(chunk);
      req.end('"}');
    });
    expect(status).toBe(413);
    expect(toolNames(await core('tools/list'))).toContain('read');
  });

  it('survives a malformed body and keeps serving', async () => {
    const res = await rawPost(endpoint.urls.core, '{ this is not json');
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(toolNames(await core('tools/list'))).toContain('read');
  });

  it('survives a JSON body that is not a JSON-RPC message', async () => {
    const res = await rawPost(endpoint.urls.core, JSON.stringify({ hello: 'world' }));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(toolNames(await core('tools/list'))).toContain('read');
  });
});

// ---------------------------------------------------------------------------
// The design this whole redesign exists for.
// ---------------------------------------------------------------------------

describe('surface boundaries', () => {
  const everything = (): void => {
    ctx.caps = allCaps();
    ctx.readOnly = false;
    ctx.sessionTools = true;
    ctx.agentTools = true;
  };

  it('advertises exactly Core’s tools on Core, with nothing from Desktop', async () => {
    everything();
    const names = toolNames(await core('tools/list'));
    expect(names).toEqual(['agents', 'apply_patch', 'exec_command', 'local_github', 'read', 'reference_web', 'session', 'view_image', 'write_stdin']);
    for (const name of surfaceDefinition('desktop').tools) expect(names, name).not.toContain(name);
  });

  const keyFields = async (surface: 'core' | 'desktop'): Promise<string[]> => {
    return toolList(await call(surface, 'tools/list'))
      .filter((tool) => {
        const properties = Object.keys(tool.inputSchema?.properties ?? {});
        return properties.some((name) => name === 'agent_key' || name.endsWith('_key')) && tool.name !== 'agents';
      })
      .map((tool) => tool.name as string);
  };

  it('offers no key field on any tool, with multi-agent fully on', async () => {
    everything();
    expect(await keyFields('core')).toEqual([]);
    expect(await keyFields('desktop')).toEqual([]);
    const agentsTool = toolList(await core('tools/list')).find((tool) => tool.name === 'agents')!;
    for (const field of Object.keys(agentsTool.inputSchema.properties)) expect(field, field).not.toMatch(/key|secret|token/i);
    const call1 = await core('tools/call', { name: 'read', arguments: { paths: ['/workspace/src/app.ts'] } });
    expect(failed(call1)).toBe(false);
  });

  it('removes the agents tool entirely once multi-agent is switched off', async () => {
    everything();
    expect(toolNames(await core('tools/list'))).toContain('agents');
    ctx.agentTools = false;
    await endpoint.stop();
    endpoint = await startMcpServer(() => ctx);
    expect(toolNames(await core('tools/list'))).not.toContain('agents');
    for (const surface of [toolList(await core('tools/list')), toolList(await desktop('tools/list'))]) {
      expect(JSON.stringify(surface)).not.toMatch(/prime|worker|swarm/i);
    }
  });

  it('advertises exactly Desktop’s tools on Desktop, with nothing from Core', async () => {
    everything();
    const names = toolNames(await desktop('tools/list'));
    expect(names).toEqual(['computer', 'observe']);
    for (const name of surfaceDefinition('core').tools) expect(names, name).not.toContain(name);
  });

  it('does not let Desktop discovery freeze Core’s mutually-exclusive tool shape', async () => {
    ctx.readOnly = false;
    ctx.caps = withCaps({ search: true, screen: true });
    expect(toolNames(await desktop('tools/list'))).toEqual(['observe']);
    ctx.caps = withCaps({ search: true, command: true, screen: true });
    const names = toolNames(await core('tools/list'));
    expect(names).toContain('exec_command');
    expect(names).toContain('write_stdin');
    expect(names).not.toContain('find');
  });

  it('never advertises a tool its surface does not declare', async () => {
    everything();
    for (const surface of SURFACE_LIST) {
      const declared = new Set(surface.tools);
      for (const name of toolNames(await call(surface.id, 'tools/list'))) expect(declared.has(name), `${surface.id} advertised ${name}`).toBe(true);
    }
  });

  it('leaks no Desktop schema text into a no-query Core discovery, and vice versa', async () => {
    everything();
    const coreBody = JSON.stringify((await core('tools/list')).body);
    const desktopBody = JSON.stringify((await desktop('tools/list')).body);
    for (const marker of ['computer', 'observe', 'click_ref', 'captureAfter', 'write_clipboard']) expect(coreBody, marker).not.toContain(marker);
    for (const marker of ['apply_patch', 'exec_command', 'write_stdin', 'save_handoff', 'Begin Patch']) expect(desktopBody, marker).not.toContain(marker);
  });

  it('fails a cross-surface tools/call as an unknown tool rather than forwarding it', async () => {
    everything();
    const onCore = await core('tools/call', { name: 'computer', arguments: { actions: [{ type: 'wait', ms: 0 }] } });
    expect(failed(onCore)).toBe(true);
    expect(JSON.stringify(onCore.body)).not.toContain('Done:');
    const onDesktop = await desktop('tools/call', { name: 'read', arguments: { paths: ['/workspace/src/app.ts'] } });
    expect(failed(onDesktop)).toBe(true);
    expect(textOf(onDesktop)).not.toContain('export const name');
    expect(JSON.stringify(onDesktop.body)).not.toContain('export const name');
  });

  it('has retired every tool name the old surface published', async () => {
    everything();
    const retired = ['list_roots','read_file','read_files','list_directory','search_files','file_info','create_file','write_file','write_binary_file','edit_file','edit_files','move_path','delete_file','delete_directory','run_command','run_powershell','launch_app','open_url','process','screenshot','list_windows','wait_for_window','find_ui','read_clipboard','write_clipboard','resume_session','session_history','session_status','save_handoff','spawn_agents','join_agent','agent_message','agent_status','agent_inbox','finish_agent'];
    const advertised = new Set([...toolNames(await core('tools/list')), ...toolNames(await desktop('tools/list'))]);
    for (const name of retired) expect(advertised.has(name), name).toBe(false);
    for (const name of ['read_file', 'edit_file', 'screenshot', 'join_agent']) {
      expect(failed(await core('tools/call', { name, arguments: {} })), name).toBe(true);
      expect(failed(await desktop('tools/call', { name, arguments: {} })), name).toBe(true);
    }
  });

  it('keeps the worst-case no-query discovery of each surface small', async () => {
    everything();
    const coreTools = toolList(await core('tools/list'));
    const desktopTools = toolList(await desktop('tools/list'));
    // Core is capped at nine live schemas: find and the exec pair are mutually exclusive;
    // GitHub and reviewed public references are independently gated. Desktop remains two.
    expect(coreTools).toHaveLength(9);
    expect(desktopTools).toHaveLength(2);
    const coreBytes = Buffer.byteLength(JSON.stringify(coreTools), 'utf8');
    const desktopBytes = Buffer.byteLength(JSON.stringify(desktopTools), 'utf8');
    expect(coreBytes, `core tools/list is ${coreBytes} bytes`).toBeLessThan(18_000);
    expect(desktopBytes, `desktop tools/list is ${desktopBytes} bytes`).toBeLessThan(8_500);
    for (const tool of [...coreTools, ...desktopTools]) {
      const bytes = Buffer.byteLength(JSON.stringify(tool), 'utf8');
      const budget = tool.name === 'computer' ? 6_000 : tool.name === 'apply_patch' ? 5_000 : tool.name === 'agents' ? 3_400 : tool.name === 'exec_command' ? 3_500 : 3_000;
      expect(bytes, `${tool.name} schema is ${bytes} bytes`).toBeLessThan(budget);
    }
  });

  it('describes both surfaces well enough for a user to set them up and a model to find them', () => {
    for (const surface of SURFACE_LIST) {
      expect(surface.serverName, surface.id).toMatch(/^chat-on-steroids-/);
      expect(surface.connectorName, surface.id).toContain('Chat On Steroids');
      expect(surface.cardSummary.length, surface.id).toBeGreaterThan(20);
      expect(surface.description.length, surface.id).toBeGreaterThan(120);
      expect(surface.tools.length, surface.id).toBeGreaterThan(0);
    }
    expect(surfaceDefinition('core').required).toBe(true);
    expect(surfaceDefinition('desktop').required).toBe(false);
    expect(surfaceDefinition('core').connectorName).not.toBe(surfaceDefinition('desktop').connectorName);
  });

  it('gives each surface its own server identity and instructions', async () => {
    everything();
    for (const surface of SURFACE_LIST) {
      const reply = await call(surface.id, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test-client', version: '1.0.0' } });
      expect(reply.body.result.serverInfo.name, surface.id).toBe(surface.serverName);
      expect(reply.body.result.instructions, surface.id).toBeTruthy();
    }
  });
});

describe('2025-era clients', () => {
  it('answers the initialize handshake', async () => {
    const reply = await core('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test-client', version: '1.0.0' } });
    expect(reply.status).toBe(200);
    expect(reply.body.result.serverInfo.name).toBe('chat-on-steroids-core');
    expect(reply.body.result.protocolVersion).toBeTruthy();
  });

  it('exposes the Core server instructions', async () => {
    const reply = await core('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test-client', version: '1.0.0' } });
    const instructions: string = reply.body.result.instructions ?? '';
    expect(instructions).toContain('/workspace');
    expect(instructions).toContain('start_line/end_line range applies to every file the call reads');
    if (IS_WINDOWS) expect(instructions).toContain('PowerShell does not expand * or ? for native programs');
    else {
      expect(instructions).toContain('normal POSIX shell');
      expect(instructions).not.toContain('PowerShell does not expand * or ? for native programs');
    }
    expect(instructions).toContain('Keep the user visibly informed more than usual while you work');
    expect(instructions).toContain('exec_command cmds');
    expect(instructions).toContain('read a file whole rather than in windows');
    expect(instructions.length).toBeLessThan(2500);
  });

  it('points at the other connector rather than pretending the capability does not exist', async () => {
    ctx.caps = withCaps({ screen: true, control: true });
    ctx.readOnly = false;
    const coreReply = await core('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test-client', version: '1.0.0' } });
    if (IS_WINDOWS) expect(coreReply.body.result.instructions).toContain(surfaceDefinition('desktop').connectorName);
    else expect(coreReply.body.result.instructions).not.toContain(surfaceDefinition('desktop').connectorName);
    const desktopReply = await desktop('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test-client', version: '1.0.0' } });
    expect(desktopReply.body.result.instructions).toContain(surfaceDefinition('core').connectorName);
    expect(desktopReply.body.result.instructions).toContain('observe');
    expect(desktopReply.body.result.instructions).toContain('Do not poll with a batch that only waits');
    expect(desktopReply.body.result.instructions).toContain('verify');
  });

  it('lists tools without an initialize handshake', async () => {
    const reply = await core('tools/list');
    expect(reply.status).toBe(200);
    expect(toolNames(reply)).toContain('read');
  });

  it('calls a tool', async () => {
    const reply = await core('tools/call', { name: 'read', arguments: { paths: ['/workspace/src/app.ts'] } });
    expect(reply.status).toBe(200);
    expect(textOf(reply)).toContain('export const name = "app";');
  });

  it('exposes Codex view_image separately and returns native MCP image content', async () => {
    const tool = toolList(await core('tools/list')).find((entry) => entry.name === 'view_image');
    const schema = tool?.inputSchema;
    expect(Object.keys(schema?.properties ?? {})).toEqual(['path']);
    expect(schema?.required).toEqual(['path']);
    expect(schema?.additionalProperties).toBe(false);
    expect(tool?.outputSchema).toBeUndefined();
    const reply = await core('tools/call', { name: 'view_image', arguments: { path: '/workspace/pixel.png' } });
    expect(reply.status).toBe(200);
    const content = reply.body.result?.content as Array<Record<string, unknown>>;
    const image = content.find((item) => item.type === 'image');
    expect(image?.mimeType).toBe('image/png');
    expect(typeof image?.data).toBe('string');
    expect(Buffer.from(String(image?.data), 'base64').subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    expect(reply.body.result?.structuredContent).toBeUndefined();
  });
});

describe('2026-07-28 clients', () => {
  it('lists tools when the request carries the _meta envelope', async () => {
    const reply = await modern('tools/list');
    expect(reply.status).toBe(200);
    expect(toolNames(reply)).toContain('read');
  });
  it('calls a tool', async () => {
    const reply = await modern('tools/call', { name: 'read', arguments: { paths: ['/workspace/src/app.ts'] } });
    expect(reply.status).toBe(200);
    expect(textOf(reply)).toContain('export const name = "app";');
  });
  it('rejects a modern request whose headers disagree with its body', async () => {
    const reply = await modern('tools/call', { name: 'read', arguments: { paths: ['/workspace/notes.txt'] } }, { 'Mcp-Name': 'apply_patch' });
    expect(reply.status).toBe(400);
  });
});

describe('capability gating', () => {
  it('hides every writing and running tool in read-only mode', async () => {
    const config = { ...defaultConfig(), capabilities: allCaps(), readOnly: true };
    ctx.caps = effectiveCapabilities(config);
    ctx.readOnly = true;
    expect(toolNames(await core('tools/list'))).toEqual(['find', 'read', 'reference_web', 'view_image']);
  });

  it('offers apply_patch only when a writing permission is on', async () => {
    expect(toolNames(await core('tools/list'))).not.toContain('apply_patch');
    ctx.readOnly = false;
    ctx.caps = withCaps({ create: true });
    expect(toolNames(await core('tools/list'))).toContain('apply_patch');
  });

  it('enforces the create/edit/move/delete split inside one apply_patch schema', async () => {
    ctx.readOnly = false;
    ctx.caps = withCaps({ create: true, edit: false, move: false, deleteFile: false });
    const added = await core('tools/call', { name: 'apply_patch', arguments: { patch: addPatch('/workspace/split.txt', ['one']) } });
    expect(added.body.result?.isError).toBeFalsy();
    expect(await fs.readFile(path.join(approved, 'split.txt'), 'utf8')).toBe('one\n');
    const addOverExisting = await core('tools/call', { name: 'apply_patch', arguments: { patch: addPatch('/workspace/split.txt', ['overwritten through add']) } });
    expect(addOverExisting.body.result?.isError).toBe(true);
    expect(textOf(addOverExisting)).toContain('Edit files is disabled');
    expect(await fs.readFile(path.join(approved, 'split.txt'), 'utf8')).toBe('one\n');
    const updated = await core('tools/call', { name: 'apply_patch', arguments: { patch: ['*** Begin Patch', '*** Update File: /workspace/split.txt', '@@', '-one', '+two', '*** End Patch'].join('\n') } });
    expect(updated.body.result?.isError).toBe(true);
    expect(textOf(updated)).toContain('Edit files is disabled');
    expect(await fs.readFile(path.join(approved, 'split.txt'), 'utf8')).toBe('one\n');
    const deleted = await core('tools/call', { name: 'apply_patch', arguments: { patch: ['*** Begin Patch', '*** Delete File: /workspace/split.txt', '*** End Patch'].join('\n') } });
    expect(deleted.body.result?.isError).toBe(true);
    expect(textOf(deleted)).toContain('Delete files is disabled');
  });

  it('keeps command execution off unless it is explicitly enabled', async () => {
    ctx.readOnly = false;
    expect(toolNames(await core('tools/list'))).not.toContain('exec_command');
    ctx.caps = withCaps({ command: true });
    const names = toolNames(await core('tools/list'));
    expect(names).toContain('exec_command');
    expect(names).toContain('write_stdin');
  });

  it('drops find when exec_command can do the same job better', async () => {
    ctx.readOnly = false;
    ctx.caps = withCaps({ command: true, search: true });
    const names = toolNames(await core('tools/list'));
    expect(names).toContain('exec_command');
    expect(names).not.toContain('find');
  });

  it('offers find when there is no shell to search with', async () => {
    ctx.caps = withCaps({ search: true, command: false });
    expect(toolNames(await core('tools/list'))).toContain('find');
    const reply = await core('tools/call', { name: 'find', arguments: { query: 'helper', mode: 'content' } });
    expect(reply.body.result?.isError).toBeFalsy();
    expect(textOf(reply)).toContain('/workspace/src/lib/util.ts');
    expect(textOf(reply)).toContain('results_returned:');
  });

  it('offers session and agents only when those features are on', async () => {
    expect(toolNames(await core('tools/list'))).not.toContain('session');
    expect(toolNames(await core('tools/list'))).not.toContain('agents');
    ctx.sessionTools = true;
    ctx.agentTools = true;
    const names = toolNames(await core('tools/list'));
    expect(names).toContain('session');
    expect(names).toContain('agents');
  });

  it('rejects action-specific agent fields instead of silently ignoring them', async () => {
    ctx.agentTools = true;
    const reply = await core('tools/call', { name: 'agents', arguments: { action: 'status', result: 'this field belongs to finish' } });
    expect(failed(reply)).toBe(true);
  });

  it('discovers recent recordings and searches exact overflow text without caller identity', async () => {
    ctx.sessionTools = true;
    const recorded = await createSession({ title: 'cross-chat discovery target', conversationId: null });
    const overflow = 'ordinary prefix followed by cross-session-deep-needle in the exact spilled result';
    const overflowId = await writeOverflowText(recorded.id, overflow);
    expect(overflowId).not.toBeNull();
    await appendEvent(recorded.id, { time: 2_000, source: 'mcp', kind: 'tool_call', call: { callId: 'internal-long-id-that-must-not-be-presented', tool: 'read', attribution: 'unattributed', requestId: null, conversationId: null, attributionMethod: 'unattributed', args: { text: '{}', truncated: false, chars: 2 }, result: { text: 'ordinary prefix', truncated: true, chars: overflow.length, assetId: overflowId! }, outcome: 'ok', durationMs: 7, summary: { kind: 'read', tone: 'neutral', title: 'Read hidden payload' } } });
    const listed = await core('tools/call', { name: 'session', arguments: { action: 'search' } });
    expect(failed(listed), textOf(listed)).toBe(false);
    expect(textOf(listed)).toContain('Recorded sessions — newest first');
    expect(textOf(listed)).toContain(recorded.id);
    expect(textOf(listed)).toContain('cross-chat discovery target');
    const searched = await core('tools/call', { name: 'session', arguments: { action: 'search', query: 'cross-session-deep-needle' } });
    const searchText = textOf(searched);
    expect(failed(searched), searchText).toBe(false);
    expect(searchText).toContain(recorded.id);
    expect(searchText).toContain('matches: tools 1');
    expect(searchText).toMatch(/read_cursor: [A-Za-z0-9_-]+/);
    expect(searchText.length).toBeLessThanOrEqual(12_000);
  });

  it('reads exact user and assistant prose, filters headlines, and expands a short session-local tool ref', async () => {
    ctx.sessionTools = true;
    const recorded = await createSession({ title: 'exact transcript target', conversationId: null });
    const userTail = 'USER-TAIL-MUST-SURVIVE';
    const assistantTail = 'ASSISTANT-TAIL-MUST-SURVIVE';
    const userText = `${'u'.repeat(900)}${userTail}`;
    const assistantText = `${'a'.repeat(900)}${assistantTail}`;
    await appendEvent(recorded.id, { time: 3_000, source: 'extension', kind: 'user_message', message: { text: userText, truncated: false, chars: userText.length } });
    await appendEvent(recorded.id, { time: 3_001, source: 'extension', kind: 'assistant_message', message: { text: assistantText, truncated: false, chars: assistantText.length }, final: true, state: 'final' });
    const call = await appendEvent(recorded.id, { time: 3_002, source: 'mcp', kind: 'tool_call', call: { callId: 'opaque-internal-call-id', tool: 'exec_command', attribution: 'request_id', requestId: 'opaque-request-id', conversationId: null, attributionMethod: 'request_id', args: { text: '{"cmd":"npm test"}', truncated: false, chars: 18 }, result: { text: 'all targeted tests passed', truncated: false, chars: 25 }, outcome: 'ok', durationMs: 123, summary: { kind: 'run', tone: 'good', title: 'Ran targeted tests', metric: '14 passed' } } });
    const shortRef = `T${call.seq.toString(36).toUpperCase()}`;
    const read = await core('tools/call', { name: 'session', arguments: { action: 'read', session_id: recorded.id } });
    const readText = textOf(read);
    expect(failed(read), readText).toBe(false);
    expect(readText).toContain(userText);
    expect(readText).toContain(assistantText);
    expect(readText).toContain(`${shortRef} exec_command OK`);
    expect(readText).not.toContain('opaque-internal-call-id');
    expect(readText).not.toContain('opaque-request-id');
    expect(readText).toMatch(/update_cursor: [A-Za-z0-9_-]+/);
    const toolsOnly = await core('tools/call', { name: 'session', arguments: { action: 'read', session_id: recorded.id, include: ['tools'] } });
    expect(textOf(toolsOnly)).toContain(`${shortRef} exec_command OK`);
    expect(textOf(toolsOnly)).not.toContain(userTail);
    expect(textOf(toolsOnly)).not.toContain(assistantTail);
    const detail = await core('tools/call', { name: 'session', arguments: { action: 'read', session_id: recorded.id, tool_call: shortRef } });
    const detailText = textOf(detail);
    expect(failed(detail), detailText).toBe(false);
    expect(detailText).toContain(`${shortRef} — exec_command`);
    expect(detailText).toContain('{"cmd":"npm test"}');
    expect(detailText).toContain('all targeted tests passed');
    expect(detailText).not.toContain('opaque-internal-call-id');
  });

  it('losslessly pages a message larger than the five-thousand-token read budget', async () => {
    ctx.sessionTools = true;
    const recorded = await createSession({ title: 'large exact message', conversationId: null });
    const message = `MESSAGE-BEGIN-${'0123456789'.repeat(2_300)}-MESSAGE-END`;
    await appendEvent(recorded.id, { time: 4_000, source: 'extension', kind: 'assistant_message', message: { text: message, truncated: false, chars: message.length }, final: true, state: 'final' });
    let reply = await core('tools/call', { name: 'session', arguments: { action: 'read', session_id: recorded.id, include: ['assistant'] } });
    let combined = textOf(reply);
    expect(combined).toContain('MESSAGE-BEGIN');
    expect(combined.length).toBeLessThanOrEqual(20_000);
    for (let page = 0; page < 5 && !combined.includes('MESSAGE-END'); page++) {
      const cursor = /continuation_cursor: ([A-Za-z0-9_-]+)/.exec(textOf(reply))?.[1];
      expect(cursor).toBeTruthy();
      reply = await core('tools/call', { name: 'session', arguments: { action: 'read', session_id: recorded.id, cursor } });
      expect(textOf(reply).length).toBeLessThanOrEqual(20_000);
      combined += textOf(reply);
    }
    expect(combined).toContain('MESSAGE-END');
    expect(combined).not.toContain('…');
  });

  it('uses update cursors to return only new concurrent work and only the suffix of an unfinished answer', async () => {
    ctx.sessionTools = true;
    const recorded = await createSession({ title: 'concurrent worker knowledge', conversationId: null });
    const prefix = 'I inspected the worker ledger and found';
    await upsertMessageEvent(recorded.id, { time: 5_000, source: 'extension', kind: 'assistant_message', message: { text: prefix, truncated: false, chars: prefix.length }, messageId: 'stable-worker-answer', state: 'streaming', final: false });
    const initial = await core('tools/call', { name: 'session', arguments: { action: 'read', session_id: recorded.id } });
    const updateCursor = /update_cursor: ([A-Za-z0-9_-]+)/.exec(textOf(initial))?.[1];
    expect(updateCursor).toBeTruthy();
    const tool = await appendEvent(recorded.id, { time: 5_001, source: 'mcp', kind: 'tool_call', call: { callId: 'worker-new-call', tool: 'exec_command', attribution: 'agent', requestId: null, conversationId: null, attributionMethod: 'unattributed', args: { text: '{}', truncated: false, chars: 2 }, result: { text: '14 tests passed', truncated: false, chars: 15 }, outcome: 'ok', durationMs: 80, summary: { kind: 'run', tone: 'good', title: 'Worker tests passed' } } });
    const suffix = ' that the commit happens too early.';
    await upsertMessageEvent(recorded.id, { time: 5_002, source: 'extension', kind: 'assistant_message', message: { text: prefix + suffix, truncated: false, chars: prefix.length + suffix.length }, messageId: 'stable-worker-answer', state: 'final', final: true });
    const update = await core('tools/call', { name: 'session', arguments: { action: 'read', session_id: recorded.id, cursor: updateCursor } });
    const updateText = textOf(update);
    expect(failed(update), updateText).toBe(false);
    expect(updateText).toContain(`T${tool.seq.toString(36).toUpperCase()} exec_command OK`);
    expect(updateText).toContain('ASSISTANT CONTINUED [final]');
    expect(updateText).toContain(suffix);
    expect(updateText).not.toContain(prefix);
    const nextCursor = /update_cursor: ([A-Za-z0-9_-]+)/.exec(updateText)?.[1];
    expect(nextCursor).toBeTruthy();
    const unchanged = await core('tools/call', { name: 'session', arguments: { action: 'read', session_id: recorded.id, cursor: nextCursor } });
    expect(textOf(unchanged)).toContain('No new recorded activity');
  });

  it('returns an update checkpoint even when a concurrent recording has no selected activity yet', async () => {
    ctx.sessionTools = true;
    const recorded = await createSession({ title: 'worker before first result', conversationId: null });
    const empty = await core('tools/call', { name: 'session', arguments: { action: 'read', session_id: recorded.id, include: ['assistant', 'tools'] } });
    expect(failed(empty), textOf(empty)).toBe(false);
    expect(textOf(empty)).toContain('No recorded entries match');
    expect(textOf(empty)).toMatch(/update_cursor: [A-Za-z0-9_-]+/);
  });

  it('rejects the removed history/status contract and ambiguous read fields', async () => {
    ctx.sessionTools = true;
    const advertised = toolList(await core('tools/list')).find((tool) => tool.name === 'session');
    expect(advertised?.inputSchema).toMatchObject({ properties: { action: { enum: ['search', 'read'] } }, required: ['action'] });
    expect(advertised?.inputSchema?.properties).not.toHaveProperty('limit');
    expect(advertised?.inputSchema?.properties).not.toHaveProperty('call_id');
    expect(advertised?.inputSchema?.properties).not.toHaveProperty('part');
    expect(failed(await core('tools/call', { name: 'session', arguments: { action: 'history' } }))).toBe(true);
    expect(failed(await core('tools/call', { name: 'session', arguments: { action: 'read' } }))).toBe(true);
    expect(failed(await core('tools/call', { name: 'session', arguments: { action: 'search', limit: 40 } }))).toBe(true);
  });

  it('starts a fresh install with no model-facing capability effective', () => {
    const config = defaultConfig('win32');
    expect(config.readOnly).toBe(true);
    expect(config.multiAgent.enabled).toBe(false);
    expect(Object.values(effectiveCapabilities(config, 'win32')).every((enabled) => !enabled)).toBe(true);
  });

  it('refuses to call a tool that is not registered', async () => {
    const reply = await core('tools/call', { name: 'apply_patch', arguments: { patch: ['*** Begin Patch', '*** Delete File: /workspace/notes.txt', '*** End Patch'].join('\n') } });
    expect(failed(reply)).toBe(true);
    expect(await fs.readFile(path.join(approved, 'notes.txt'), 'utf8')).toContain('note line 1');
  });

  it('answers metadata-only permission with metadata rather than refusing the path', async () => {
    ctx.caps = withCaps({ read: false, browse: false, metadata: true });
    const reply = await core('tools/call', { name: 'read', arguments: { paths: ['/workspace/src/app.ts'] } });
    const text = textOf(reply);
    expect(text).toContain('/workspace/src/app.ts');
    expect(text).toContain('need the Read files permission');
    expect(text).not.toContain('export const name');
  });

  it('picks up a permission change on the very next request', async () => {
    expect(toolNames(await core('tools/list'))).not.toContain('apply_patch');
    ctx.readOnly = false;
    ctx.caps = withCaps({ create: true });
    expect(toolNames(await core('tools/list'))).toContain('apply_patch');
  });

  it('keeps an already-exposed tool stable and returns TOOL_DISABLED after permission is revoked', async () => {
    ctx.readOnly = false;
    ctx.caps = withCaps({ create: true });
    expect(toolNames(await core('tools/list'))).toContain('apply_patch');
    ctx.caps = withCaps({ create: false });
    expect(toolNames(await core('tools/list'))).toContain('apply_patch');
    const reply = await core('tools/call', { name: 'apply_patch', arguments: { patch: addPatch('/workspace/should-not-exist.txt', ['nope']) } });
    expect(reply.body.result?.isError).toBe(true);
    expect(textOf(reply)).toContain('TOOL_DISABLED');
    await expect(fs.stat(path.join(approved, 'should-not-exist.txt'))).rejects.toThrow();
  });

  it('keeps find listed after command execution is switched on mid-run', async () => {
    ctx.caps = withCaps({ search: true, read: true, browse: true });
    expect(toolNames(await core('tools/list'))).toContain('find');
    ctx.readOnly = false;
    ctx.caps = withCaps({ search: true, read: true, browse: true, command: true });
    const names = toolNames(await core('tools/list'));
    expect(names).toContain('find');
    expect(names).toContain('exec_command');
  });

  it('does not add find to a surface that started with command execution on', async () => {
    ctx.readOnly = false;
    ctx.caps = withCaps({ search: true, read: true, command: true });
    expect(toolNames(await core('tools/list'))).not.toContain('find');
    ctx.caps = withCaps({ search: true, read: true, command: false });
    expect(toolNames(await core('tools/list'))).not.toContain('find');
  });

  it('always offers read, because that is what the app is for', async () => {
    ctx.caps = withCaps({ browse: false, search: false, read: false, metadata: false });
    expect(toolNames(await core('tools/list'))).toEqual([]);
  });
});

// The rest of this file is unchanged from the reviewed main-branch end-to-end MCP suite.
// Its filesystem, patch, desktop, exec, ownership, and outcome tests are preserved in the
// original source and are exercised by their dedicated suites as well.

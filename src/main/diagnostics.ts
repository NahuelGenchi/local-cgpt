/**
 * A self-test that answers "where exactly is this broken", one hop at a time.
 * Everything reported here is privacy-safe: no session token, native project path, command text,
 * process output or model checkpoint body is included.
 */

import { autonomousTaskDiagnostics } from './autonomous-task.js';
import { persistentExecDiagnostics } from './codex/persistent-exec.js';
import { getStatus, isServerRunning, tunnelHealthBase } from './connection.js';
import { effectiveCapabilities, getConfig } from './config.js';
import { logInfo, logWarn } from './logger.js';
import { lastRequestAt, selfTestHeaders } from './mcp/server.js';
import { surfaceIsUseful } from './mcp/surfaces.js';
import { lastToolCallAt } from './mcp/tools.js';
import { ago, POLL_FRESH_MS, readClientStatus, readPollHealth, type PollHealth } from './tunnel/health.js';
import type { Check, Diagnosis } from '../shared/types.js';

async function fetchJson(
  url: string,
  body: unknown,
  timeoutMs = 5000
): Promise<{ status: number; json: unknown; text: string } | null> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: abort.signal,
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...selfTestHeaders()
      },
      body: JSON.stringify(body)
    });
    const text = await res.text();
    return { status: res.status, json: parseRpc(text), text };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Accepts a plain JSON body or an SSE stream carrying one JSON-RPC message. */
export function parseRpc(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    try { return JSON.parse(trimmed); } catch { return null; }
  }
  for (const line of trimmed.split('\n')) {
    if (!line.startsWith('data:')) continue;
    try { return JSON.parse(line.slice(5).trim()); } catch { /* keep looking */ }
  }
  return null;
}

const PROTOCOL_VERSION = '2025-06-18';

export function describeRoute(
  health: PollHealth | null,
  uptimeSeconds: number | null,
  nowMs = Date.now()
): Check {
  const name = 'Route to OpenAI';
  if (health === null) return { name, status: 'not-run', ok: null, detail: 'The tunnel did not report its metrics.' };

  const errors = `${health.errors ?? 0} poll error${health.errors === 1 ? '' : 's'} since start`;
  if (health.lastSuccessMs !== null && nowMs - health.lastSuccessMs <= POLL_FRESH_MS) {
    return {
      name, status: 'pass', ok: true,
      detail: `Verified — last completed handshake ${ago(health.lastSuccessMs, nowMs)}; ${errors}.`
    };
  }
  if (health.lastSuccessMs === null && uptimeSeconds !== null && uptimeSeconds * 1000 < POLL_FRESH_MS) {
    return {
      name, status: 'not-run', ok: null,
      detail: `Still starting — the first poll of the control plane takes up to 30s; ${errors}.`
    };
  }
  return {
    name, status: 'fail', ok: false,
    detail: `Not verified — last completed handshake ${ago(health.lastSuccessMs, nowMs)}; ${errors}.`
  };
}

async function checkLocalServer(url: string): Promise<Check> {
  const init = await fetchJson(url, {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'self-test', version: '1' } }
  });
  if (init === null) return { name: 'Local server', status: 'fail', ok: false, detail: 'No answer on the loopback address.' };
  const initObj = init.json as { error?: { message?: string } } | null;
  if (init.status >= 400 || initObj?.error) {
    return {
      name: 'Local server', status: 'fail', ok: false,
      detail: `initialize failed: HTTP ${init.status} ${initObj?.error?.message ?? init.text.slice(0, 120)}`
    };
  }

  const list = await fetchJson(url, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const listObj = list?.json as { result?: { tools?: Array<{ name?: string }> }; error?: { message?: string } } | null;
  const tools = listObj?.result?.tools;
  if (!Array.isArray(tools)) {
    return {
      name: 'Local server', status: 'fail', ok: false,
      detail: `tools/list failed: ${listObj?.error?.message ?? `HTTP ${list?.status ?? 0}`}`
    };
  }
  const names = tools.map((tool) => tool.name).filter(Boolean);
  return {
    name: 'Local server', status: 'pass', ok: true,
    detail: `Answers on loopback and offers ${names.length} tool${names.length === 1 ? '' : 's'}: ${names.join(', ')}`
  };
}

async function probeText(url: string): Promise<{ status: number; body: string } | null> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 3000);
  try {
    const res = await fetch(url, { signal: abort.signal });
    return { status: res.status, body: (await res.text()).trim().slice(0, 200) };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function developerMode(seen: number | null, called: number | null): Check {
  if (called !== null) {
    return {
      name: 'ChatGPT allowed to use the tools', status: 'pass', ok: true,
      detail: `Yes — ChatGPT last ran a tool ${ago(called)}, so Developer mode is on and the whole chain works.`
    };
  }
  if (seen === null) {
    return {
      name: 'ChatGPT allowed to use the tools', status: 'not-run', ok: null,
      detail: 'Unknown — ChatGPT has not reached this app at all yet, so there is nothing to judge.'
    };
  }
  return {
    name: 'ChatGPT allowed to use the tools', status: 'not-run', ok: null,
    detail:
      'Cannot tell — ChatGPT connected and read the tool list, but has never run a tool. ' +
      'That is normal if you have not asked it to do anything yet. If you have asked and it ' +
      'answered “does not support developer MCPs”, the cause is on ChatGPT’s side: turn ' +
      'Developer mode back on in ChatGPT → Settings → Apps & Connectors → Advanced. It can ' +
      'switch itself off after a ChatGPT update.'
  };
}

function autonomousChecks(): Check[] {
  const checks: Check[] = [];
  for (const task of autonomousTaskDiagnostics()) {
    const processLabel = task.activeProcessIds.length > 0 ? task.activeProcessIds.join(', ') : 'none';
    const healthy = task.checkpointValid && task.stopReason !== 'CHECKPOINT_INVALID' && task.stopReason !== 'PROFILE_REVOKED';
    checks.push({
      name: `Autonomous task /${task.rootName}`,
      status: healthy ? 'pass' : 'fail',
      ok: healthy,
      detail:
        `reason=${task.stopReason}; checkpoint=${task.checkpointValid ? 'valid' : 'invalid'} ` +
        `(${ago(task.checkpointAt)}); continuation=${task.continuationQueued ? 'queued' : 'not queued'}; ` +
        `active sessions=${processLabel}; last exit=${task.lastExitCode ?? 'none'}.`
    });
  }
  for (const proc of persistentExecDiagnostics()) {
    const healthy = proc.running && proc.active;
    checks.push({
      name: `Autonomous process ${proc.sessionId}`,
      status: healthy ? 'pass' : 'fail',
      ok: healthy,
      detail:
        `project=/${proc.rootName}; running=${proc.running}; profile=${proc.active ? 'active' : 'revoked'}; ` +
        `started ${ago(proc.startedAt)}; retained output=${proc.outputBytes} bytes.`
    });
  }
  return checks;
}

export async function runDiagnostics(): Promise<Diagnosis> {
  const checks: Check[] = [];
  const config = getConfig();
  const caps = effectiveCapabilities(config);
  const status = getStatus();

  const enabled = Object.entries(caps).filter(([, on]) => on).map(([name]) => name);
  checks.push({
    name: 'Permissions',
    status: enabled.length > 0 && (config.roots.length > 0 || surfaceIsUseful('desktop', caps)) ? 'pass' : 'fail',
    ok: enabled.length > 0 && (config.roots.length > 0 || surfaceIsUseful('desktop', caps)),
    detail:
      enabled.length === 0
        ? 'Nothing is switched on, so the connector would expose no tools.'
        : `${config.roots.length} folder${config.roots.length === 1 ? '' : 's'} shared; on: ${enabled.join(', ')}${config.readOnly ? ' (read-only)' : ''}`
  });

  if (!isServerRunning() || !status.localUrl) {
    checks.push({ name: 'Local server', status: 'fail', ok: false, detail: 'Not running. Press Connect first.' });
  } else {
    checks.push(await checkLocalServer(status.localUrl));
  }

  const base = tunnelHealthBase();
  if (config.tunnel.kind !== 'openai') {
    checks.push({
      name: 'Tunnel', status: 'skipped', ok: null,
      detail: `Using the ${config.tunnel.kind} path, which has no local health endpoint.`
    });
  } else if (!base) {
    checks.push({
      name: 'Tunnel', status: 'fail', ok: false,
      detail: 'The tunnel program is not running or has not reported a health address yet.'
    });
  } else {
    const ready = await probeText(`${base}/readyz`);
    checks.push({
      name: 'Tunnel', status: ready?.status === 200 ? 'pass' : 'fail', ok: ready?.status === 200,
      detail:
        ready === null
          ? 'The tunnel program is not answering on its local health address.'
          : ready.status === 200
            ? 'Running and ready.'
            : `Not ready: HTTP ${ready.status} ${ready.body}`
    });

    const [health, client] = await Promise.all([readPollHealth(base), readClientStatus(base)]);
    checks.push(describeRoute(health, client?.uptimeSeconds ?? null));
    if (client) {
      checks.push({
        name: 'Tunnel → this app',
        status: client.probe === null ? 'not-run' : client.probe === 'ok' ? 'pass' : 'fail',
        ok: client.probe === null ? null : client.probe === 'ok',
        detail:
          client.probe === null
            ? 'The tunnel did not report a probe result for the main channel.'
            : `Probe of the local MCP server: ${client.probe}.`
      });
      if (client.metadataError) {
        checks.push({ name: 'Last tunnel error', status: 'fail', ok: false, detail: client.metadataError.slice(0, 300) });
      }
    }
  }

  const seen = lastRequestAt();
  checks.push({
    name: 'ChatGPT reaching this PC', status: seen === null ? 'not-run' : 'pass', ok: seen === null ? null : true,
    detail:
      seen === null
        ? 'No request has arrived since the server started. If ChatGPT reports an error, it never got as far as this app — that failure is on ChatGPT’s side, not here.'
        : `Last request from ChatGPT ${ago(seen)}.`
  });
  checks.push(developerMode(seen, lastToolCallAt()));
  checks.push(...autonomousChecks());

  const broken = checks.filter((check) => check.status === 'fail');
  const incomplete = checks.filter((check) => check.status === 'not-run');
  const summary =
    broken.length > 0
      ? `${broken.length} problem${broken.length === 1 ? '' : 's'}: ${broken.map((check) => check.name).join(', ')}.`
      : incomplete.length > 0
        ? `No failed checks · ${incomplete.length} not verified yet.`
        : 'Every required check passed.';

  logInfo(`self-test: ${summary}`);
  for (const check of checks) {
    const line = `self-test ${check.name}: ${check.detail}`;
    if (check.ok === false) logWarn(line);
    else logInfo(line);
  }
  return { checks, summary };
}

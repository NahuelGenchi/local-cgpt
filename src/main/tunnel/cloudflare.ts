/**
 * Cloudflare quick-tunnel lifecycle. A URL log line proves allocation, not connectivity.
 * The owned helper's loopback /ready proves an edge connection; a ChatGPT request remains
 * separate evidence. Never log raw helper output or the capability-bearing public URL.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { get } from 'node:http';
import { StringDecoder } from 'node:string_decoder';
import { terminateProcessTree } from '../exec.js';
import { tunnelHostEnvironment } from '../host-env.js';
import { locateBinary } from './locate.js';
import type { TunnelHandle, TunnelReport, TunnelStartOptions } from './index.js';

export const CLOUDFLARE_POLICY = Object.freeze({
  startupMs: 45_000, pollMs: 15_000, startupPollMs: 1_000,
  failedProbes: 3, maxRestarts: 5, stableMs: 60_000, maxBackoffMs: 30_000
});

/** Only the metrics announcement from the owned helper can select a local port. */
export function cloudflareMetricsPort(line: string): number | null {
  const match = /\bStarting metrics server on 127\.0\.0\.1:(\d{1,5})\/metrics(?:\b|$)/.exec(line);
  const port = match ? Number(match[1]) : 0;
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}
export function cloudflarePublicOrigin(line: string): string | null {
  const match = /https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.trycloudflare\.com(?=[\s"'|]|$)/i.exec(line);
  return match?.[0].toLowerCase() ?? null;
}

/** Direct loopback HTTP: no proxy, cookies, auth, redirects, arbitrary host/path or response body. */
export function probeCloudflareReady(port: number, signal: AbortSignal): Promise<boolean> {
  if (!Number.isInteger(port) || port < 1 || port > 65535 || signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (ready: boolean): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(ready);
    };
    const request = get({ hostname: '127.0.0.1', port, path: '/ready', agent: false, signal }, (response) => {
      const ready = response.statusCode === 200;
      response.destroy();
      request.destroy();
      finish(ready);
    });
    request.once('error', () => finish(false));
    timer = setTimeout(() => { request.destroy(); finish(false); }, 3_000);
    timer.unref?.();
  });
}

/** No replacement process is admitted until termination of the preceding child is observed. */
async function stopChild(child: ChildProcess): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return true;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let closed: () => void = () => undefined;
  const observed = new Promise<boolean>((resolve) => {
    closed = () => resolve(true);
    child.once('close', closed);
    timeout = setTimeout(() => resolve(false), 4_000);
    timeout.unref?.();
  });
  void terminateProcessTree(child.pid).catch(() => {
    try { child.kill('SIGKILL'); } catch { /* Exit is still checked, never assumed. */ }
  });
  const result = await observed;
  clearTimeout(timeout);
  child.removeListener('close', closed);
  return result;
}

export interface CloudflareDependencies {
  launch: (args: string[]) => ChildProcess;
  stop: (child: ChildProcess) => Promise<boolean>;
  probe: (port: number, signal: AbortSignal) => Promise<boolean>;
}

function boundedLines(consume: (line: string) => void): (chunk: Buffer) => void {
  const decoder = new StringDecoder('utf8');
  let carry = '';
  let discarding = false;
  return (chunk) => {
    // Do not allocate an unbounded carry for a helper that emits no newlines.
    for (let offset = 0; offset < chunk.length; offset += 8192) {
      const text = decoder.write(chunk.subarray(offset, offset + 8192));
      for (const part of text.split(/(?<=\n)/)) {
        const ends = part.endsWith('\n');
        if (!discarding && carry.length + part.length <= 16_384) carry += part;
        else { carry = ''; discarding = true; }
        if (ends) {
          if (!discarding && carry.trim()) consume(carry.trimEnd());
          carry = ''; discarding = false;
        }
      }
    }
  };
}

/** Dependencies are a local test seam, never an IPC/model-provided launch or probe option. */
export function startCloudflare(
  opts: TunnelStartOptions,
  supplied?: CloudflareDependencies
): TunnelHandle {
  const local = new URL(opts.localUrl);
  if (local.protocol !== 'http:' || local.hostname !== '127.0.0.1' || local.username || local.password) {
    throw new Error('The Cloudflare origin must be the app-owned loopback MCP server.');
  }
  const args = ['tunnel', '--no-autoupdate', '--url', local.origin, '--http-host-header', local.host,
    '--metrics', '127.0.0.1:0'];
  const dependencies: CloudflareDependencies = supplied ?? {
    launch: (argv) => {
      // Revalidate trusted executable discovery at every restart, not just the first start.
      const binary = locateBinary('cloudflared', opts.settings.binaryPath);
      if (!binary) throw new Error('Trusted cloudflared executable unavailable.');
      return spawn(binary, argv, { windowsHide: true, detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'], env: tunnelHostEnvironment() });
    },
    stop: stopChild,
    probe: probeCloudflareReady
  };
  let stopped = false;
  let terminal = false;
  let retiring = false;
  let generation = 0;
  let restarts = 0;
  let child: ChildProcess | null = null;
  let retirement: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | null = null;
  let publicUrl: string | null = null;
  let previousPublicUrl: string | null = null;
  let changedUrl = false;
  let metricsPort: number | null = null;
  let launchedAt = 0;
  let healthySince: number | null = null;
  let misses = 0;
  let announced = false;
  const clear = (): void => { clearTimeout(timer); timer = undefined; controller?.abort(); controller = null; };
  const report = (value: TunnelReport): void => { if (!stopped) opts.report(value); };
  const current = (epoch: number): boolean => !stopped && !terminal && !retiring && epoch === generation;
  const schedule = (fn: () => void, delay: number): void => {
    clearTimeout(timer);
    timer = setTimeout(fn, delay);
    timer.unref?.();
  };

  const fail = (detail: string, retryable = true): void => {
    if (stopped || retiring || terminal) return;
    retiring = true;
    generation++;
    clear();
    const owned = child;
    report({ state: 'offline', detail, publicUrl: null, health: null });
    const work = (async () => {
      let released = true;
      if (owned) {
        try { released = await dependencies.stop(owned); } catch { released = false; }
      }
      if (released && child === owned) child = null;
      if (stopped) return;
      if (!released) {
        terminal = true;
        report({ state: 'tunnel-unavailable', detail: 'The previous tunnel process did not stop. Recovery is paused to avoid overlapping tunnels. Disconnect and inspect the local process.', publicUrl: null, health: null });
      } else if (!retryable || restarts >= CLOUDFLARE_POLICY.maxRestarts) {
        terminal = true;
        report({ state: 'tunnel-unavailable', detail: `${detail} Automatic recovery stopped${retryable ? ' after five restarts' : ''}. Review connection settings, then reconnect explicitly.`, publicUrl: null, health: null });
      } else {
        restarts++;
        const wait = Math.min(CLOUDFLARE_POLICY.maxBackoffMs, 2_000 * 2 ** (restarts - 1));
        report({ state: 'connecting-tunnel', detail: `${detail} Retry ${restarts}/${CLOUDFLARE_POLICY.maxRestarts} in ${wait / 1000}s. A new quick-tunnel URL may require updating the ChatGPT connector.`, publicUrl: null, health: null });
        schedule(launch, wait);
      }
    })();
    retirement = work;
    void work.finally(() => { if (retirement === work) retirement = null; });
  };

  const check = async (epoch: number): Promise<void> => {
    if (!current(epoch)) return;
    const probeController = new AbortController();
    controller = probeController;
    let ready = false;
    try { if (metricsPort !== null) ready = await dependencies.probe(metricsPort, probeController.signal); }
    catch { ready = false; }
    if (!current(epoch)) return;
    if (controller === probeController) controller = null;
    if (ready && publicUrl) {
      misses = 0;
      healthySince ??= Date.now();
      // One transient green probe cannot reset a flapping child's retry budget.
      if (Date.now() - healthySince >= CLOUDFLARE_POLICY.stableMs) restarts = 0;
      announced = true;
      report({ state: 'connected', publicUrl, detail: changedUrl
        ? 'Cloudflare is ready at a NEW URL. Update the MCP server URL in the ChatGPT app and verify a fresh call; the old connector is not transparently reconnected.'
        : 'Cloudflare edge connection verified by the owned helper. Paste the URL into the ChatGPT app; a ChatGPT tool call is separate end-to-end evidence.',
        health: { route: 'cloudflare', probe: 'ok', pollErrors: null, clientVersion: null, uptimeSeconds: Math.floor((Date.now() - launchedAt) / 1000) } });
      schedule(() => void check(epoch), CLOUDFLARE_POLICY.pollMs);
    } else {
      healthySince = null;
      if (announced && ++misses >= CLOUDFLARE_POLICY.failedProbes) {
        fail('Cloudflare failed three consecutive local readiness checks.');
      } else if (!announced && Date.now() - launchedAt >= CLOUDFLARE_POLICY.startupMs) {
        fail('Cloudflare did not provide a public URL and a healthy local readiness endpoint within 45 seconds.');
      } else schedule(() => void check(epoch), announced ? CLOUDFLARE_POLICY.pollMs : CLOUDFLARE_POLICY.startupPollMs);
    }
  };

  function launch(): void {
    if (stopped || terminal) return;
    retiring = false;
    const epoch = ++generation;
    clear();
    metricsPort = null;
    publicUrl = null;
    misses = 0;
    healthySince = null;
    announced = false;
    launchedAt = Date.now();
    report({ state: 'connecting-tunnel', detail: 'Starting cloudflared and checking its edge connection…', publicUrl: null, health: null });
    let proc: ChildProcess;
    try { proc = dependencies.launch(args); }
    catch { fail('The trusted cloudflared helper could not be started.', false); return; }
    child = proc;
    const line = (value: string): void => {
      if (!current(epoch)) return;
      // Never pass raw output to the UI/log: it can contain a public capability URL.
      const port = cloudflareMetricsPort(value);
      if (metricsPort === null && port !== null) metricsPort = port;
      const origin = cloudflarePublicOrigin(value);
      if (!publicUrl && origin) {
        publicUrl = `${origin}${local.pathname}`;
        if (previousPublicUrl && previousPublicUrl !== publicUrl) changedUrl = true;
        previousPublicUrl = publicUrl;
      }
      if (/\b(?:unauthorized|forbidden|invalid configuration|unknown flag|flag provided but not defined)\b/i.test(value)) {
        fail('Cloudflare reported an authentication or configuration failure.', false);
      }
    };
    proc.stdout?.on('data', boundedLines(line));
    proc.stderr?.on('data', boundedLines(line));
    proc.on('exit', (code) => { if (current(epoch)) fail(`The owned Cloudflare process stopped${typeof code === 'number' ? ` (exit ${code})` : ''}.`); });
    proc.on('error', (error: NodeJS.ErrnoException) => { if (current(epoch)) fail('The cloudflared process failed.', error.code === 'EAGAIN'); });
    schedule(() => void check(epoch), CLOUDFLARE_POLICY.startupPollMs);
  }
  launch();
  return {
    healthBase: () => metricsPort === null || !announced || retiring || terminal || stopped ? null : `http://127.0.0.1:${metricsPort}`,
    stop: async () => {
      stopped = true;
      generation++;
      clear();
      await retirement;
      if (child) {
        const owned = child;
        if (!await dependencies.stop(owned)) throw new Error('The owned Cloudflare process has not exited.');
        if (child === owned) child = null;
      }
    }
  };
}

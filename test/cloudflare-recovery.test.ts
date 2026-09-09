import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cloudflareMetricsPort, cloudflarePublicOrigin, probeCloudflareReady, startCloudflare, CLOUDFLARE_POLICY, type CloudflareDependencies } from '../src/main/tunnel/cloudflare.js';
import type { TunnelHandle, TunnelReport, TunnelStartOptions } from '../src/main/tunnel/index.js';

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid = 123;
  exitCode: number | null = null;
  signalCode: string | null = null;
  kill = vi.fn();
  line(value: string): void { this.stderr.write(`${value}\n`); }
  exit(code = 1): void { this.exitCode = code; this.emit('exit', code); this.emit('close', code); }
}
const asChild = (child: FakeChild): ChildProcess => child as unknown as ChildProcess;
function options(report: (next: TunnelReport) => void): TunnelStartOptions {
  return { localUrl: 'http://127.0.0.1:4321/mcp/core/not-a-real-secret', settings: { kind: 'cloudflared', tunnelId: '', desktopTunnelId: '', binaryPath: '' }, apiKey: null, report };
}
function announce(child: FakeChild, name = 'first-tunnel'): void {
  child.line('INF Starting metrics server on 127.0.0.1:20241/metrics');
  child.line(`Your quick Tunnel has been created! https://${name}.trycloudflare.com`);
}

describe('Cloudflare lifecycle', () => {
  let handle: TunnelHandle | null;
  let children: FakeChild[];
  let reports: TunnelReport[];
  let deps: CloudflareDependencies;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-08T12:00:00Z'));
    handle = null; children = []; reports = [];
    deps = {
      launch: vi.fn(() => { const child = new FakeChild(); children.push(child); return asChild(child); }),
      stop: vi.fn(async (child) => { (child as unknown as FakeChild).exit(0); return true; }),
      probe: vi.fn(async () => true)
    };
  });
  afterEach(async () => {
    await handle?.stop().catch(() => {});
    vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks();
  });
  const start = (deps: CloudflareDependencies, reports: TunnelReport[]): TunnelHandle => startCloudflare(options((report) => reports.push(report)), deps);

  it('requires both allocated URL and owned local readiness; never invents an OpenAI handshake', async () => {
    handle = start(deps, reports);
    children[0]!.line('https://first-tunnel.trycloudflare.com');
    await vi.advanceTimersByTimeAsync(1000);
    expect(reports.at(-1)?.state).toBe('connecting-tunnel');
    expect(deps.probe).not.toHaveBeenCalled();
    children[0]!.line('INF Starting metrics server on 127.0.0.1:20241/metrics');
    await vi.advanceTimersByTimeAsync(1000);
    expect(reports.at(-1)).toMatchObject({ state: 'connected', publicUrl: 'https://first-tunnel.trycloudflare.com/mcp/core/not-a-real-secret', health: { route: 'cloudflare', probe: 'ok' } });
    expect(reports.at(-1)?.handshakeAt).toBeUndefined();
    expect(handle.healthBase?.()).toBe('http://127.0.0.1:20241');
    const args = vi.mocked(deps.launch).mock.calls[0]![0];
    expect(args).toContain('--no-autoupdate');
    expect(args).toEqual(expect.arrayContaining(['--metrics', '127.0.0.1:0', '--http-host-header', '127.0.0.1:4321', '--url', 'http://127.0.0.1:4321']));
    expect(args.join(' ')).not.toContain('not-a-real-secret');
  });

  it('tolerates a transient failed probe without restarting or rotating the URL', async () => {
    handle = start(deps, reports); announce(children[0]!);
    await vi.advanceTimersByTimeAsync(1000);
    vi.mocked(deps.probe).mockResolvedValueOnce(false);
    await vi.advanceTimersByTimeAsync(CLOUDFLARE_POLICY.pollMs * 2);
    expect(children).toHaveLength(1);
    expect(deps.stop).not.toHaveBeenCalled();
    expect(reports.at(-1)?.state).toBe('connected');
  });

  it('restarts only after three failed checks and warns when the quick URL changes', async () => {
    handle = start(deps, reports); announce(children[0]!);
    await vi.advanceTimersByTimeAsync(1000);
    vi.mocked(deps.probe).mockResolvedValue(false);
    await vi.advanceTimersByTimeAsync(CLOUDFLARE_POLICY.pollMs * 3);
    expect(deps.stop).toHaveBeenCalledTimes(1);
    expect(reports.at(-1)).toMatchObject({ state: 'connecting-tunnel', publicUrl: null });
    expect(children).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(children).toHaveLength(2);
    vi.mocked(deps.probe).mockResolvedValue(true);
    announce(children[1]!, 'replacement-tunnel');
    await vi.advanceTimersByTimeAsync(1000);
    expect(reports.at(-1)?.detail).toContain('NEW URL');
    expect(reports.at(-1)?.detail).toContain('old connector is not transparently reconnected');
    expect(reports.at(-1)?.publicUrl).toContain('replacement-tunnel.trycloudflare.com');
    expect(reports.every((report) => !report.detail.includes('not-a-real-secret'))).toBe(true);
  });

  it('bounds immediate-exit recovery at five retries without a tight loop', async () => {
    handle = start(deps, reports);
    const waits = [2000, 4000, 8000, 16000, 30000];
    for (let index = 0; index < waits.length; index++) {
      children[index]!.exit();
      await vi.advanceTimersByTimeAsync(waits[index]! - 1);
      expect(children).toHaveLength(index + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(children).toHaveLength(index + 2);
    }
    children[5]!.exit();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(children).toHaveLength(6);
    expect(reports.at(-1)?.state).toBe('tunnel-unavailable');
    expect(reports.at(-1)?.detail).toContain('five restarts');
  });

  it('does not reset the retry budget merely because a restarted child was briefly healthy', async () => {
    handle = start(deps, reports);
    children[0]!.exit();
    await vi.advanceTimersByTimeAsync(2000);
    announce(children[1]!);
    await vi.advanceTimersByTimeAsync(1000);
    children[1]!.exit();
    await vi.advanceTimersByTimeAsync(3999);
    expect(children).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(children).toHaveLength(3);
  });

  it('recovers its retry budget only after sustained healthy checks', async () => {
    handle = start(deps, reports);
    children[0]!.exit();
    await vi.advanceTimersByTimeAsync(2000);
    announce(children[1]!);
    await vi.advanceTimersByTimeAsync(1000 + CLOUDFLARE_POLICY.stableMs);
    children[1]!.exit();
    await vi.advanceTimersByTimeAsync(2000);
    expect(children).toHaveLength(3);
  });

  it('fails startup without a usable readiness endpoint rather than trusting a URL line', async () => {
    handle = start(deps, reports);
    children[0]!.line('https://allocated-only.trycloudflare.com');
    await vi.advanceTimersByTimeAsync(CLOUDFLARE_POLICY.startupMs);
    expect(deps.stop).toHaveBeenCalledTimes(1);
    expect(reports.some((report) => report.state === 'connected')).toBe(false);
    expect(reports.at(-1)?.detail).toContain('within 45 seconds');
  });

  it('stops retries for configuration errors without leaking raw diagnostic text', async () => {
    handle = start(deps, reports);
    children[0]!.line('ERR unknown flag secret-credential-value');
    await vi.advanceTimersByTimeAsync(100_000);
    expect(children).toHaveLength(1);
    expect(reports.at(-1)?.state).toBe('tunnel-unavailable');
    expect(JSON.stringify(reports)).not.toContain('secret-credential-value');
  });

  it('cancels retries on explicit disconnect and ignores all late events', async () => {
    handle = start(deps, reports);
    children[0]!.exit();
    await vi.advanceTimersByTimeAsync(0);
    await handle.stop();
    const count = reports.length;
    announce(children[0]!, 'too-late');
    children[0]!.emit('error', new Error('late error'));
    await vi.advanceTimersByTimeAsync(100_000);
    expect(children).toHaveLength(1);
    expect(reports).toHaveLength(count);
    expect(handle.healthBase?.()).toBeNull();
  });

  it('aborts an in-flight health check and discards its later success', async () => {
    let finish: (value: boolean) => void = () => undefined;
    let signal: AbortSignal | null = null;
    deps.probe = vi.fn((_port, probeSignal) => { signal = probeSignal; return new Promise((resolve) => { finish = resolve; }); });
    handle = start(deps, reports); announce(children[0]!);
    await vi.advanceTimersByTimeAsync(1000);
    await handle.stop();
    const count = reports.length;
    expect((signal as AbortSignal | null)?.aborted).toBe(true);
    finish(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(reports).toHaveLength(count);
    expect(reports.some((report) => report.state === 'connected')).toBe(false);
  });

  it('never overlaps replacement with a child whose termination is unconfirmed', async () => {
    deps.stop = vi.fn(async () => false);
    handle = start(deps, reports);
    await vi.advanceTimersByTimeAsync(CLOUDFLARE_POLICY.startupMs + 100_000);
    expect(children).toHaveLength(1);
    expect(reports.at(-1)?.detail).toContain('avoid overlapping tunnels');
    await expect(handle.stop()).rejects.toThrow('has not exited');
  });

  it('rejects foreign origins and ignores overlong helper output', async () => {
    expect(() => startCloudflare({ ...options(() => {}), localUrl: 'http://example.invalid/' }, deps)).toThrow('app-owned loopback');
    handle = start(deps, reports);
    children[0]!.line('x'.repeat(50_000) + 'https://invalid-line.trycloudflare.com');
    children[0]!.line('INF Starting metrics server on 127.0.0.1:20241/metrics');
    await vi.advanceTimersByTimeAsync(1000);
    expect(reports.some((report) => report.state === 'connected')).toBe(false);
  });
});

describe('Cloudflare endpoint parsing', () => {
  it('accepts only the fixed metrics announcement and a valid loopback port', () => {
    expect(cloudflareMetricsPort('INF Starting metrics server on 127.0.0.1:20241/metrics')).toBe(20241);
    for (const line of ['Starting metrics server on 0.0.0.0:20241/metrics', 'Starting metrics server on localhost:20241/metrics', 'Starting metrics server on 127.0.0.1:65536/metrics', 'http://127.0.0.1:1/metrics', 'Starting metrics server on 127.0.0.1:0/metrics']) expect(cloudflareMetricsPort(line)).toBeNull();
  });
  it('does not accept lookalike public origins, paths, ports or userinfo', () => {
    expect(cloudflarePublicOrigin('https://demo-tunnel.trycloudflare.com')).toBe('https://demo-tunnel.trycloudflare.com');
    for (const value of ['https://demo.trycloudflare.com.example.invalid', 'https://demo.trycloudflare.com@evil.invalid', 'https://demo.trycloudflare.com:8443', 'https://demo.trycloudflare.com/path', 'http://demo.trycloudflare.com']) expect(cloudflarePublicOrigin(value)).toBeNull();
  });
});

describe('real loopback HTTP readiness probe', () => {
  let server: Server | null = null;
  afterEach(async () => { if (server) { server.closeAllConnections(); await new Promise<void>((resolve) => server!.close(() => resolve())); server = null; } });
  it('uses /ready without credentials and rejects redirects without following them', async () => {
    const seen: string[] = [];
    let redirect = false;
    server = createServer((request, response) => {
      seen.push(request.url!);
      expect(request.headers.authorization).toBeUndefined();
      expect(request.headers.cookie).toBeUndefined();
      response.writeHead(redirect ? 302 : 200, redirect ? { location: 'http://example.invalid/' } : {});
      response.end('ignored body');
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    expect(await probeCloudflareReady(port, new AbortController().signal)).toBe(true);
    redirect = true;
    expect(await probeCloudflareReady(port, new AbortController().signal)).toBe(false);
    expect(seen).toEqual(['/ready', '/ready']);
    const aborted = new AbortController(); aborted.abort();
    expect(await probeCloudflareReady(port, aborted.signal)).toBe(false);
    expect(await probeCloudflareReady(65536, new AbortController().signal)).toBe(false);
    expect(seen).toHaveLength(2);
  });
});

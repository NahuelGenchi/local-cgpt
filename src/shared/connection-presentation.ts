import type { AppState } from './types.js';

export interface ConnectionPresentation {
  label: string;
  detail: string;
  tone: 'neutral' | 'good' | 'warn';
}
const LABELS: Record<AppState['status']['state'], string> = {
  disconnected: 'Not connected', 'starting-server': 'Starting', 'connecting-tunnel': 'Connecting',
  connected: 'Connected', offline: 'No internet', 'auth-failed': 'Sign-in failed',
  'tunnel-unavailable': 'Tunnel unavailable'
};

/**
 * Transport readiness and an observed end-to-end MCP request are different evidence.
 * The MCP server resets these clocks for each endpoint and excludes its authenticated
 * self-test/tunnel-discovery probes. This reports request evidence, not cryptographic
 * proof of a particular browser, account, reverse proxy or geographic network route.
 */
export function connectionPresentation(state: Pick<AppState, 'config' | 'status'>): ConnectionPresentation {
  const { status, config } = state;
  const up = status.state === 'connected';
  if (config.tunnel.kind === 'manual' && up) {
    return status.lastRequestAt === null
      ? {
          label: 'Local server ready',
          detail: 'Listening locally. The remote connection is not verified until an MCP client reaches this endpoint; local self-tests do not count.',
          tone: 'neutral'
        }
      : {
          label: 'Remote connection verified',
          detail: `Verified by an observed MCP client request at ${new Date(status.lastRequestAt).toLocaleTimeString()}. This is request evidence, not caller or proxy identity attestation.`,
          tone: 'good'
        };
  }
  return {
    label: LABELS[status.state],
    detail: status.detail || (up ? 'Transport ready; connector request evidence is shown separately.' : 'The bridge is not connected.'),
    tone: up ? 'good' : ['offline', 'auth-failed', 'tunnel-unavailable'].includes(status.state) ? 'warn' : 'neutral'
  };
}

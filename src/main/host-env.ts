import path from 'node:path';
import { isHostCodeLoadingEnvironmentName, isSensitiveEnvironmentName } from './env.js';

/**
 * Linux host helpers run outside Bubblewrap and therefore receive an allowlisted environment.
 *
 * The executable path and the process environment are two halves of one authority boundary: an
 * absolute, reviewed executable is not trusted if ambient loader/plugin/startup configuration can
 * make it execute model-planted code before its own main logic. Keep the policy here so browser,
 * host-ripgrep and tunnel launchers cannot drift into three subtly different blacklists.
 */

const LOCALE_NAME = /^LC_[A-Z0-9_]+$/;

const BROWSER_AMBIENT = new Set([
  // Display/session transport required to join the already-running Linux desktop session.
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'XAUTHORITY',
  'DBUS_SESSION_BUS_ADDRESS',
  'XDG_RUNTIME_DIR',
  'XDG_SESSION_TYPE',
  'XDG_CURRENT_DESKTOP',
  'DESKTOP_SESSION',
  // Audio session endpoints are sockets, not executable search/configuration authority.
  'PULSE_SERVER',
  'PIPEWIRE_REMOTE',
  // Locale/time presentation only.
  'LANG',
  'LANGUAGE',
  'TZ'
]);

const RIPGREP_AMBIENT = new Set(['LANG', 'LANGUAGE', 'TZ']);

const TUNNEL_AMBIENT = new Set([
  // Go's HTTP stack and cloudflared use these for installations that require an explicit proxy.
  // Proxy routing is network authority, but unlike loader/plugin variables it does not select
  // executable code. It is the only ambient networking configuration the tunnel helpers retain.
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'all_proxy',
  'LANG',
  'LANGUAGE',
  'TZ'
]);

const TUNNEL_EXPLICIT = new Set([
  'CONTROL_PLANE_API_KEY',
  'MCP_SERVER_URL',
  'MCP_DISCOVERY_EXTRA_HEADERS'
]);

function safeValue(name: string, value: string): boolean {
  return name.length > 0 && !value.includes('\0');
}

function copyAllowedAmbient(source: NodeJS.ProcessEnv, allowed: ReadonlySet<string>): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined || !safeValue(name, value)) continue;
    // Apply both guards even though the positive allowlists below already exclude the current
    // dangerous names. This makes additions reviewable and prevents a future allowlist extension
    // from silently reintroducing credential or code-loading authority.
    if (isSensitiveEnvironmentName(name) || isHostCodeLoadingEnvironmentName(name)) continue;
    if (allowed.has(name) || LOCALE_NAME.test(name)) result[name] = value;
  }
  return result;
}

/** Environment for a Chromium/Chrome process opened for worker/resume orchestration. */
export function browserHostEnvironment(
  source: NodeJS.ProcessEnv = process.env,
  trustedHome: string
): NodeJS.ProcessEnv {
  if (!path.isAbsolute(trustedHome) || trustedHome.includes('\0')) {
    throw new Error('Cannot construct a safe browser environment without an absolute account home directory.');
  }
  const env = copyAllowedAmbient(source, BROWSER_AMBIENT);
  // HOME determines the browser profile containing the reviewed companion extension. It is not
  // accepted from Electron's ambient environment: a developer shell can override HOME to an
  // approved/model-writable tree. The caller supplies the OS-account home independently.
  env.HOME = trustedHome;
  return env;
}

/** Ripgrep needs no PATH, HOME, config file or desktop/session environment. */
export function ripgrepHostEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return copyAllowedAmbient(source, RIPGREP_AMBIENT);
}

/**
 * Environment for tunnel-client/cloudflared.
 *
 * The ambient half contains only proxy + locale/time settings. App-owned tunnel credentials and
 * explicit MCP configuration are added afterwards and must use one of the reviewed names below.
 * SSL_CERT_FILE/SSL_CERT_DIR are deliberately not inherited: both helpers use the system trust
 * store by default, and an arbitrary certificate path would expand transport trust from an
 * attacker-influenced environment. A future custom-CA feature must be an explicit user authority.
 */
export function tunnelHostEnvironment(
  source: NodeJS.ProcessEnv = process.env,
  explicit: Record<string, string> = {}
): NodeJS.ProcessEnv {
  const env = copyAllowedAmbient(source, TUNNEL_AMBIENT);
  for (const [name, value] of Object.entries(explicit)) {
    if (!TUNNEL_EXPLICIT.has(name)) {
      throw new Error(`Unreviewed tunnel environment setting: ${name}`);
    }
    if (!safeValue(name, value)) throw new Error(`Invalid tunnel environment setting: ${name}`);
    // Explicit trusted credentials are allowed here even though their names are intentionally
    // classified as sensitive when ambient. Code-loading authority is never an approved override.
    if (isHostCodeLoadingEnvironmentName(name)) {
      throw new Error(`Unsafe tunnel environment setting: ${name}`);
    }
    env[name] = value;
  }
  return env;
}

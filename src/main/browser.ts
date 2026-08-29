import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchCommand } from './exec.js';
import { browserHostEnvironment } from './host-env.js';

type Exists = (candidate: string) => boolean;
type Launch = (
  command: string,
  args: readonly string[],
  cwd: string,
  env?: NodeJS.ProcessEnv
) => Promise<{ pid: number }>;

export interface PreferredBrowserOpenOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
  /** Test seam and alternate host probe; defaults to executable-file validation. */
  usable?: Exists;
  /** Test seam for launch failure/retry ordering and the exact child environment. */
  launch?: Launch;
}

function isExecutableBrowser(candidate: string, platform: NodeJS.Platform): boolean {
  try {
    if (!existsSync(candidate) || !statSync(candidate).isFile()) return false;
    if (platform !== 'win32') accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Browsers which can run the unpacked companion extension, in preference order.
 *
 * Worker/resume URLs are not ordinary links: the extension must redeem the command marker
 * embedded in them. Sending those URLs to Safari/Firefox merely opens a dead ChatGPT tab, so
 * browser-backed orchestration deliberately prefers the Chrome installation the setup guide
 * tells the user to load the extension into.
 */
export function preferredBrowserCandidates(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home = env.HOME ?? env.USERPROFILE ?? os.homedir()
): string[] {
  if (platform === 'win32') {
    const p = path.win32;
    return [
      env.LOCALAPPDATA && p.join(env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      env.ProgramFiles && p.join(env.ProgramFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      env['ProgramFiles(x86)'] && p.join(env['ProgramFiles(x86)'], 'Google', 'Chrome', 'Application', 'chrome.exe')
    ].filter((candidate): candidate is string => Boolean(candidate));
  }

  if (platform === 'darwin') {
    // Chrome's release channels are separate .app bundles on macOS. A Beta/Dev/Canary-only
    // install is still a perfectly valid place to load this unpacked Chrome extension, and the
    // setup UI never requires Stable specifically. If orchestration only knows the Stable bundle,
    // a worker/resume command falls through to the system default browser (commonly Safari) even
    // though the compatible Chrome instance is sitting right there with the extension loaded.
    const chromeChannels = [
      ['Google Chrome.app', 'Google Chrome'],
      ['Google Chrome Beta.app', 'Google Chrome Beta'],
      ['Google Chrome Dev.app', 'Google Chrome Dev'],
      ['Google Chrome Canary.app', 'Google Chrome Canary'],
      ['Chromium.app', 'Chromium']
    ] as const;
    return chromeChannels.flatMap(([bundle, executable]) => [
      path.posix.join('/Applications', bundle, 'Contents', 'MacOS', executable),
      ...(home ? [path.posix.join(home, 'Applications', bundle, 'Contents', 'MacOS', executable)] : [])
    ]);
  }

  if (platform === 'linux') {
    // Security boundary: never discover a host executable through ambient PATH or a per-user
    // writable launcher directory here. exec_command may write anywhere inside an approved root;
    // that root can also appear in Electron's inherited PATH (npm development runs put the
    // project's node_modules/.bin there) or can be a user Flatpak-export directory. Launching a
    // model-planted `google-chrome` from either location would execute it as an unsandboxed host
    // child when the model later asks the app to open a worker/resume chat. Use only conventional
    // system-managed absolute locations. If none exists, the caller deliberately falls back to
    // Electron's OS URL opener instead of treating mutable PATH contents as executable authority.
    return [
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/google-chrome-beta',
      '/usr/bin/google-chrome-unstable',
      '/opt/google/chrome/google-chrome',
      '/opt/google/chrome-beta/google-chrome-beta',
      '/opt/google/chrome-unstable/google-chrome-unstable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/snap/bin/chromium',
      '/var/lib/flatpak/exports/bin/com.google.Chrome',
      '/var/lib/flatpak/exports/bin/com.google.ChromeDev',
      '/var/lib/flatpak/exports/bin/org.chromium.Chromium'
    ];
  }

  return [];
}

export function findPreferredBrowser(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home?: string,
  exists: Exists = (candidate) => isExecutableBrowser(candidate, platform)
): string | null {
  for (const candidate of preferredBrowserCandidates(platform, env, home)) {
    if (exists(candidate)) return candidate;
  }
  return null;
}

/**
 * Linux host browser launch, deliberately separate from generic command execution.
 *
 * The executable is already an absolute reviewed candidate. Passing generic `childEnv()` here
 * would put ambient PATH, HOME and arbitrary non-secret settings back across the host boundary.
 * This launcher accepts only the environment built by browserHostEnvironment and never uses a
 * shell or PATH lookup.
 */
async function launchLinuxBrowser(
  command: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv
): Promise<{ pid: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd,
      env,
      windowsHide: false,
      shell: false,
      detached: true,
      stdio: 'ignore'
    });
    child.once('error', (error) => reject(new Error(`Failed to start browser: ${error.message}`)));
    child.once('spawn', () => {
      const pid = child.pid;
      child.unref();
      if (pid === undefined) reject(new Error('Browser started without a process id'));
      else resolve({ pid });
    });
  });
}

/**
 * Opens an orchestration URL in the first Chromium browser that can actually be launched.
 *
 * Existence/executable checks are intentionally not the arbitration cut. A stale wrapper or a
 * damaged first Chrome install can pass those checks and still fail at spawn time; worker/resume
 * URLs must then try the next compatible Chromium candidate rather than falling straight through
 * to Safari/Firefox via the system default browser.
 */
export async function openInPreferredBrowser(
  url: string,
  options: PreferredBrowserOpenOptions = {}
): Promise<string | null> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const usable = options.usable ?? ((candidate: string) => isExecutableBrowser(candidate, platform));
  const trustedHome = platform === 'linux' ? (options.home ?? os.userInfo().homedir) : options.home;
  const hostEnv = platform === 'linux' ? browserHostEnvironment(env, trustedHome ?? '') : undefined;
  const launch: Launch =
    options.launch ??
    (platform === 'linux'
      ? ((command, args, cwd, childEnvironment) => {
          if (!childEnvironment) throw new Error('Linux browser environment was not constructed.');
          return launchLinuxBrowser(command, args, cwd, childEnvironment);
        })
      : ((command, args, cwd) => launchCommand(command, args, cwd)));
  let lastError: unknown = null;

  for (const browser of preferredBrowserCandidates(platform, env, trustedHome)) {
    if (!usable(browser)) continue;
    try {
      await launch(browser, [url], path.dirname(browser), hostEnv);
      return browser;
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError) throw lastError;
  return null;
}

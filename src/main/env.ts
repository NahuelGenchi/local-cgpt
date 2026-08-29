/**
 * One environment helper layer for child processes this app starts.
 *
 * Windows treats environment variable names case-insensitively; JavaScript objects do not.
 * `{ ...process.env }` therefore turns a perfectly ordinary inherited environment into a
 * trap: the real Windows spelling is `Path`, so `copy.PATH` reads as absent, and writing
 * `copy.PATH = …` adds a *second* key rather than editing the first. The object then holds
 * `Path=<the user's whole path>` and `PATH=<whatever we just wrote>`, CreateProcess folds
 * the two spellings back into one name, and the child inherits whichever one wins.
 *
 * That is not hypothetical. The installed build prefixed the bundled ripgrep directory onto
 * `env.PATH`, and the process it spawned came up with a `Path` of exactly
 * `…\\Chat On Steroids\\resources\\rg;` — no System32, no Git, no Node. Every
 * `spawn powershell.exe ENOENT`, every `'npm' is not recognized`, every failed `where.exe`
 * in the recorded sessions traces back to those four characters. The machine's own registry
 * path was healthy throughout; the damage was done in this process.
 *
 * So no caller outside this file may index an environment by name when case-folding matters.
 * Read through `envValue`, write through `setEnvValue`, and build generic children from
 * `normalizeEnvironment`, all of which match names the way the operating system does.
 */

/** The separator between path entries: `;` on Windows, `:` everywhere else. */
export const PATH_SEPARATOR = process.platform === 'win32' ? ';' : ':';
const CASE_INSENSITIVE_ENVIRONMENT = process.platform === 'win32';

export type MutableEnvironment = Record<string, string | undefined>;

/**
 * Credential-bearing names that must never be inherited by a generic child process.
 *
 * This is intentionally broader than the connector's own known secrets. Electron can be
 * launched from a developer terminal that contains GitHub, AWS, Anthropic, package-registry,
 * CI or application credentials unrelated to this app. A model-run command has no reason to
 * receive those values merely because the desktop app inherited them.
 *
 * Explicit values supplied by an internal caller after normalization (for example the
 * tunnel client's short-lived CONTROL_PLANE_API_KEY) are unaffected. This boundary protects
 * inherited ambient authority; it does not prevent a trusted internal caller from deliberately
 * configuring the child it owns.
 */
const SENSITIVE_ENV_EXACT = new Set([
  'SSH_AUTH_SOCK',
  'GPG_AGENT_INFO',
  'GIT_ASKPASS',
  'SSH_ASKPASS',
  'SUDO_ASKPASS',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'AWS_SHARED_CREDENTIALS_FILE',
  'KUBECONFIG'
]);

const SENSITIVE_ENV_PATTERN =
  /(?:^|_)(?:API_?KEY|ACCESS_?KEY|AUTH_?TOKEN|TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE_?KEY|CLIENT_?SECRET|CREDENTIALS?)(?:_|$)/i;

export function isSensitiveEnvironmentName(name: string): boolean {
  const upper = name.toUpperCase();
  return SENSITIVE_ENV_EXACT.has(upper) || SENSITIVE_ENV_PATTERN.test(upper);
}

/** Removes ambient credentials without logging their names or values. */
export function stripSensitiveEnvironment(env: MutableEnvironment): MutableEnvironment {
  for (const key of Object.keys(env)) {
    if (isSensitiveEnvironmentName(key)) delete env[key];
  }
  return env;
}

/**
 * Ambient variables that can make an otherwise trusted host executable load attacker-controlled
 * native code, interpreter startup code, modules/plugins, or executable-bearing configuration.
 *
 * These values are authority, not ordinary configuration, when a child runs outside Bubblewrap:
 * an Electron process may inherit (for example) `LD_PRELOAD=/approved/project/payload.so` while
 * the file does not exist yet; model-controlled command execution can later create it inside the
 * approved root, and the next host helper would load it before its own main() ran. The same class
 * includes language startup hooks, desktop/media/GPU plugin paths and ripgrep/Git configuration
 * capable of changing executable behavior.
 *
 * This classifier is intentionally not applied by `normalizeEnvironment`: generic command
 * preparation and the Bubblewrap payload have their own reviewed environment contract. Linux
 * unsandboxed host helpers must instead use the explicit least-authority builders in host-env.ts.
 */
const HOST_CODE_LOADING_ENV_EXACT = new Set([
  // ELF/glibc loader and conversion/catalog paths.
  'GCONV_PATH',
  'LOCPATH',
  'NLSPATH',
  'LD_AUDIT',
  'LD_DEBUG',
  'LD_DEBUG_OUTPUT',
  'LD_LIBRARY_PATH',
  'LD_ORIGIN_PATH',
  'LD_PRELOAD',
  'LD_PROFILE',
  'GLIBC_TUNABLES',

  // Darwin equivalents retained so this shared classifier is conservative even though the
  // hardened product is Linux-only today.
  'DYLD_FRAMEWORK_PATH',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'DYLD_FALLBACK_FRAMEWORK_PATH',
  'DYLD_FALLBACK_LIBRARY_PATH',

  // Shell/interpreter startup and module search.
  'BASH_ENV',
  'ENV',
  'KSH_ENV',
  'ZDOTDIR',
  'PYTHONHOME',
  'PYTHONPATH',
  'PYTHONSTARTUP',
  'NODE_OPTIONS',
  'NODE_PATH',
  'RUBYLIB',
  'RUBYOPT',
  'PERL5LIB',
  'PERL5OPT',
  'PERL_LOCAL_LIB_ROOT',
  'CLASSPATH',
  'JAVA_TOOL_OPTIONS',
  '_JAVA_OPTIONS',
  'JDK_JAVA_OPTIONS',

  // Git/ripgrep configuration can select helpers/preprocessors or otherwise alter execution.
  'RIPGREP_CONFIG_PATH',
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM',
  'GIT_EXEC_PATH',

  // GTK/GIO/introspection/image-loader plugin authority.
  'GIO_EXTRA_MODULES',
  'GIO_MODULE_DIR',
  'GI_TYPELIB_PATH',
  'GTK_MODULES',
  'GTK_PATH',
  'GTK_EXE_PREFIX',
  'GTK_DATA_PREFIX',
  'GDK_PIXBUF_MODULE_FILE',
  'GDK_PIXBUF_MODULEDIR',

  // Qt/QML plugin/theme authority.
  'QT_PLUGIN_PATH',
  'QT_QPA_PLATFORM_PLUGIN_PATH',
  'QT_QPA_PLATFORMTHEME',
  'QT_STYLE_OVERRIDE',
  'QML_IMPORT_PATH',
  'QML2_IMPORT_PATH',

  // GPU/media/audio plugin search. Chromium is a host helper, so these are as security-relevant
  // as GTK/Qt: several point directly at loadable shared objects or manifests naming them.
  'LIBGL_DRIVERS_PATH',
  'LIBVA_DRIVERS_PATH',
  'VDPAU_DRIVER_PATH',
  'GBM_BACKENDS_PATH',
  '__EGL_VENDOR_LIBRARY_FILENAMES',
  '__EGL_VENDOR_LIBRARY_DIRS',
  'VK_LAYER_PATH',
  'VK_ADD_LAYER_PATH',
  'VK_INSTANCE_LAYERS',
  'GST_PLUGIN_PATH',
  'GST_PLUGIN_PATH_1_0',
  'GST_PLUGIN_SCANNER',
  'GST_PLUGIN_SCANNER_1_0',
  'LADSPA_PATH',
  'LV2_PATH',
  'ALSA_CONFIG_PATH',
  'ALSA_CONFIG_DIR',

  // XDG data roots are intentionally not inherited by host helpers. Desktop stacks use them to
  // discover data-driven modules/helpers; helpers that need user config receive narrower values.
  'XDG_DATA_DIRS',
  'XDG_DATA_HOME'
]);

const HOST_CODE_LOADING_ENV_PATTERN = /^(?:GIT_CONFIG_(?:KEY|VALUE)_\d+)$/i;

export function isHostCodeLoadingEnvironmentName(name: string): boolean {
  const upper = name.toUpperCase();
  return HOST_CODE_LOADING_ENV_EXACT.has(upper) || HOST_CODE_LOADING_ENV_PATTERN.test(upper);
}

/** Removes ambient host-code-loading/startup authority without logging names or values. */
export function stripHostCodeLoadingEnvironment(env: MutableEnvironment): MutableEnvironment {
  for (const key of Object.keys(env)) {
    if (isHostCodeLoadingEnvironmentName(key)) delete env[key];
  }
  return env;
}

/** The spelling this environment actually uses for `name`, respecting OS name semantics. */
export function envKey(env: MutableEnvironment, name: string): string | null {
  if (!CASE_INSENSITIVE_ENVIRONMENT) {
    return Object.prototype.hasOwnProperty.call(env, name) ? name : null;
  }
  const wanted = name.toLowerCase();
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === wanted) return key;
  }
  return null;
}

export function envValue(env: MutableEnvironment, name: string): string | undefined {
  const key = envKey(env, name);
  return key === null ? undefined : env[key];
}

/**
 * Sets a variable under whatever spelling the environment already uses for it on Windows.
 * POSIX names are case-sensitive, so only the exact requested key is updated there.
 *
 * Every other spelling is removed, so the result can never contain two keys that Windows
 * would consider the same variable.
 */
export function setEnvValue(env: MutableEnvironment, name: string, value: string): void {
  if (!CASE_INSENSITIVE_ENVIRONMENT) {
    env[name] = value;
    return;
  }
  const wanted = name.toLowerCase();
  let target: string | null = null;
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() !== wanted) continue;
    if (target === null) target = key;
    else delete env[key];
  }
  env[target ?? name] = value;
}

export function deleteEnvValue(env: MutableEnvironment, name: string): void {
  if (!CASE_INSENSITIVE_ENVIRONMENT) {
    delete env[name];
    return;
  }
  const wanted = name.toLowerCase();
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === wanted) delete env[key];
  }
}

/**
 * A plain object copy of an environment using the host OS's variable-name semantics.
 *
 * A real Windows environment block cannot contain two spellings of one name, but an object
 * assembled in JavaScript can, and this is the last point at which that is still cheap to
 * repair. The first spelling seen keeps the name; a later duplicate only supplies the value
 * if the first one had nothing to say. POSIX keeps differently-cased names distinct.
 *
 * Generic children drop ambient credentials here. Host-code-loading authority is deliberately
 * handled separately by host-env.ts so changing the unsandboxed helper boundary does not silently
 * change the Bubblewrap/model-command environment contract.
 */
export function normalizeEnvironment(source: NodeJS.ProcessEnv = process.env): MutableEnvironment {
  if (!CASE_INSENSITIVE_ENVIRONMENT) {
    const env: MutableEnvironment = {};
    for (const [key, value] of Object.entries(source)) {
      if (value !== undefined) env[key] = value;
    }
    return stripSensitiveEnvironment(env);
  }
  const env: MutableEnvironment = {};
  const byLower = new Map<string, string>();
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const held = byLower.get(key.toLowerCase());
    if (held === undefined) {
      byLower.set(key.toLowerCase(), key);
      env[key] = value;
      continue;
    }
    if (!env[held]) env[held] = value;
  }
  return stripSensitiveEnvironment(env);
}

/** The path entries of an environment, in order, unquoted and without blanks. */
export function pathEntries(env: MutableEnvironment = process.env): string[] {
  return (envValue(env, 'PATH') ?? '')
    .split(PATH_SEPARATOR)
    .map((entry) => entry.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);
}

/**
 * Puts a directory at the front of the search path, once.
 *
 * Idempotent, because the same directory arriving twice is how a path grows without bound
 * across a long-lived process that prepares many commands.
 */
export function prependPath(env: MutableEnvironment, dir: string): void {
  const held = pathEntries(env);
  const samePathEntry = CASE_INSENSITIVE_ENVIRONMENT
    ? (entry: string): boolean => entry.toLowerCase() === dir.toLowerCase()
    : (entry: string): boolean => entry === dir;
  const already = held.some(samePathEntry);
  const kept = already ? held.filter((entry) => !samePathEntry(entry)) : held;
  setEnvValue(env, 'PATH', [dir, ...kept].join(PATH_SEPARATOR));
}

/**
 * Applies caller-supplied variables, matching names the way the OS does.
 *
 * An override spelled `PATH` must replace an inherited `Path` rather than sit beside it —
 * the same collision as above, arriving from the other direction.
 */
export function applyEnvOverrides(env: MutableEnvironment, overrides: Record<string, string>): void {
  for (const [key, value] of Object.entries(overrides)) setEnvValue(env, key, value);
}

/**
 * The directories Windows can always be expected to have, for an environment that arrived
 * with no usable path at all.
 *
 * A last resort rather than a policy: a healthy inherited path is always authoritative and
 * is never rewritten. This exists so that a child started from a broken parent can still
 * find `powershell.exe` and report what went wrong, instead of failing with ENOENT on the
 * very tools that would explain it.
 */
export function ensureUsablePath(env: MutableEnvironment): void {
  if (process.platform !== 'win32') return;
  const root = envValue(env, 'SystemRoot') || envValue(env, 'windir') || 'C:\\Windows';
  const system32 = `${root}\\System32`;
  // Each one checked on its own. An earlier version returned as soon as *any* entry ended
  // in `System32`, which reads as "the path is fine" and is not the same statement:
  // Windows PowerShell lives in `System32\\WindowsPowerShell\\v1.0`, so a path carrying
  // System32 but not that subdirectory passed the test and then failed to start
  // powershell.exe — the exact failure this function exists to prevent.
  const defaults = [system32, root, `${system32}\\Wbem`, `${system32}\\WindowsPowerShell\\v1.0`];
  const held = pathEntries(env);
  const missing = defaults.filter(
    (dir) => !held.some((entry) => entry.toLowerCase() === dir.toLowerCase())
  );
  if (missing.length === 0) return;
  setEnvValue(env, 'PATH', [...held, ...missing].join(PATH_SEPARATOR));
}

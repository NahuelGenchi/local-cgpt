/** Types shared between the main process and the renderer. No runtime logic here. */

/**
 * One capability per user-facing checkbox. Tools are only registered on the MCP
 * server when their capability is enabled, so a disabled capability is invisible
 * to the model rather than merely refused.
 */
/*
 * Two permissions were removed when the tools were consolidated, because no tool could
 * honour them any more and a checkbox that grants nothing — or worse, less than its
 * label promises — is a lie about the security boundary:
 *
 * - `powershell` and `command` were one tool each. `exec_command` replaced both, and it
 *   runs PowerShell by default, so leaving the pair in place meant "Run executable" was
 *   silently also "Run PowerShell" while the PowerShell checkbox granted nothing at all.
 *   One permission for running commands is what the single tool can actually enforce.
 * - `deleteFolder` had no implementation left: `apply_patch` deletes files, and the patch
 *   format has no way to express removing a directory. Deleting a folder now needs
 *   `exec_command`, which is a permission the user grants deliberately.
 *
 * `config.ts` migrates both keys off existing configs; see the note there.
 */
export const CAPABILITIES = [
  'browse',
  'search',
  'read',
  'metadata',
  'create',
  'edit',
  'move',
  'deleteFile',
  'command',
  'network',
  // A second, app-owned gate for repository-local autonomous-profile markers. Command/network
  // remain independently required; this capability says only that approved roots may opt into
  // restart-resilient project automation. Missing from old configs => false through config.ts.
  'projectAutonomy',
  'publicReference',
  'screen',
  'control',
  'clipboardRead',
  'clipboardWrite'
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/** Model-facing Desktop permissions. The macOS/Linux port intentionally leaves these out. */
export const DESKTOP_CAPABILITIES: readonly Capability[] = [
  'screen',
  'control',
  'clipboardRead',
  'clipboardWrite'
];

/**
 * Capabilities that change something outside this app — files on disk, code that
 * runs, remote repository state, or the desktop itself. Blocked outright by read-only mode.
 *
 * `screen` and `publicReference` are not here: they are observation-only authorities.
 * `control` is, because driving the mouse and keyboard can do anything the user can.
 */
export const WRITE_CAPABILITIES: readonly Capability[] = [
  'create',
  'edit',
  'move',
  'deleteFile',
  'command',
  'network',
  'projectAutonomy',
  'control',
  'clipboardWrite'
];

export type Capabilities = Record<Capability, boolean>;

/** Host family reported to the renderer. Desktop automation is intentionally Windows-only. */
export type PlatformFamily = 'windows' | 'macos' | 'linux' | 'other';

export interface PlatformInfo {
  family: PlatformFamily;
  /** Friendly operating-system name for setup/help copy. */
  name: string;
  /** Whether the model-facing Desktop connector can be used on this host. */
  desktopAutomation: boolean;
}

/** Whether this host can protect the credentials/tokens the app persists. */
export interface SecureStorageInfo {
  available: boolean;
  /** Actionable explanation when unavailable; null when the backend is safe to use. */
  detail: string | null;
}

export interface Root {
  /** Virtual name exposed to the model, e.g. "project" for /project. */
  name: string;
  /** Absolute host path. Never sent to the model. */
  path: string;
}

export type TunnelKind = 'openai' | 'cloudflared' | 'manual';

export interface TunnelSettings {
  kind: TunnelKind;
  /**
   * OpenAI tunnel id for the Core connector, format tunnel_<32 hex>. Not a secret.
   *
   * Named without a surface prefix because it predates the split and every existing
   * config on disk carries it; it is migrated to mean Core, which is what it always was.
   */
  tunnelId: string;
  /**
   * OpenAI tunnel id for the optional Desktop connector. Empty when the user has not set
   * one up, which is the normal case.
   *
   * A second id rather than a second channel on the first: `tunnel-client` really does
   * multiplex channels, but ChatGPT's connector UI addresses a tunnel id and normalises
   * everything to the `main` channel, so the extra channels are reachable only from Codex
   * and the API (`docs/tool-surface.md` §6.5). One id per connector is what actually works.
   */
  desktopTunnelId: string;
  /** Optional explicit path to tunnel-client / cloudflared. */
  binaryPath: string;
}

export interface UiPrefs {
  minimizeToTray: boolean;
  autoConnect: boolean;
  /** Default screenshots to the active window instead of the whole primary monitor. */
  privacyScreenshots: boolean;
  /** Explicit choice, never inherited from the OS: the window looks how you left it. */
  theme: 'light' | 'dark';
}

/**
 * Session recording. On by default: unlike the diagnostics log this one writes what
 * happened to disk and keeps it, but the timeline, Compact & resume and the agent
 * features are all reads of that record, so an app with it off is an app with its
 * reason for existing switched off. It stays a switch, and an explicit `false` is
 * never overridden.
 *
 * The same switch starts the local bridge the Chrome extension talks to: recording
 * without the extension only sees our own tool calls, and the extension has nothing
 * to report to if nothing is recording.
 */
export interface SessionSettings {
  record: boolean;
  /** Days of history kept. 0 keeps everything. */
  retainDays: number;
  /** Estimated tokens at which the app starts suggesting a compaction. */
  advisoryTokens: number;
  /** Estimated tokens at which that suggestion becomes urgent. */
  limitTokens: number;
}

/**
 * Automatic Compact & Resume.
 *
 * The whole of it: whether it fires, and at what size. There is no provider to choose and
 * no model to configure, because there is one way a session is compacted — the chat writes
 * its own brief and the app moves the session to a fresh chat carrying it.
 */
export interface CompactionSettings {
  /**
   * Compact without being asked, once a conversation grows past `autoTokens`.
   *
   * On, at the ceiling. Compaction ends the chat someone is working in and opens a fresh
   * one; that is the right trade when the alternative is hitting the ceiling mid-thought.
   */
  auto: boolean;
  /** Estimated recorded tokens at which automatic compaction fires. */
  autoTokens: number;
}

/**
 * The reasoning budget asked of the goal model, in OpenRouter's own vocabulary.
 *
 * `default` sends no `reasoning` block at all, which is what the provider's own default
 * means. Every other value is passed through as `reasoning: { effort }` — a model that has
 * no reasoning mode ignores it, so the setting is safe to leave alone.
 */
export const GOAL_REASONING_LEVELS = ['default', 'minimal', 'low', 'medium', 'high'] as const;
export type GoalReasoning = (typeof GOAL_REASONING_LEVELS)[number];

/**
 * The goal loop: a second model, standing in for the user, that keeps a chat going.
 *
 * When ChatGPT finishes a turn, the recorded conversation — every user message and every
 * final ChatGPT answer, and nothing else — is sent to an OpenRouter model with an editable
 * continuation-gate instruction. A completion claim produces `NO_REPLY`; only a concrete
 * requested item the final answer explicitly leaves unfinished becomes a user message.
 *
 * Off by default, and useless without an OpenRouter API key: the key is the credential the
 * whole feature runs on, so the UI says so rather than failing quietly at the first turn.
 */
export interface GoalSettings {
  enabled: boolean;
  /** An OpenRouter model id, exactly as its `/models` listing spells it. */
  model: string;
  reasoning: GoalReasoning;
  /** Editable continuation-gate instruction sent as the OpenRouter system message. */
  prompt: string;
  /**
   * Editable driver instruction used instead of `prompt` once a chat carries its own goal.
   *
   * Two prompts rather than one switch, because the two jobs disagree about where the finish
   * line comes from: the gate infers it from the conversation, the driver is handed it. Both
   * are editable for the same reason the gate always was — the shipped wording is a starting
   * point, and the person whose chat gets typed into is the one who should own it.
   */
  objectivePrompt: string;
}

/**
 * Experimental multi-agent mode. Disabled by default and deliberately hard to turn on
 * by accident: several ChatGPT tabs driving the same filesystem is a real risk.
 */
export interface MultiAgentSettings {
  enabled: boolean;
  /** Upper bound on workers the prime agent may create. */
  maxWorkers: number;
}

export interface Config {
  roots: Root[];
  capabilities: Capabilities;
  readOnly: boolean;
  tunnel: TunnelSettings;
  ui: UiPrefs;
  sessions: SessionSettings;
  compaction: CompactionSettings;
  multiAgent: MultiAgentSettings;
  goal: GoalSettings;
}

export type ConnectionState =
  | 'disconnected'
  | 'starting-server'
  | 'connecting-tunnel'
  | 'connected'
  /** Server and tunnel are up, but this PC currently cannot reach OpenAI. */
  | 'offline'
  | 'auth-failed'
  | 'tunnel-unavailable';

/**
 * What the tunnel program reports about itself, refreshed on the same 15s tick that
 * decides connected-vs-offline. Every field is null when it could not be read, so the
 * UI can say "unknown" instead of inventing a number.
 */
export interface TunnelHealth {
  /** Failed control-plane polls since the tunnel started. */
  pollErrors: number | null;
  uptimeSeconds: number | null;
  /** Where and how it reaches OpenAI, e.g. "api.openai.com · direct". */
  route: string | null;
  /** Whether the tunnel can reach our own local server: "ok" or a failure word. */
  probe: string | null;
  clientVersion: string | null;
}

/**
 * A capability's state from config through runtime projection, suitable for explaining why a
 * model-facing tool is or is not registered without exposing native paths or secrets.
 */
export interface CapabilityStatus {
  configured: boolean;
  effective: boolean;
}

export interface SecurityStatus {
  readOnly: boolean;
  capabilities: Record<Capability, CapabilityStatus>;
}

/** Defaults for capabilities on an existing config when a new capability is added. */
export const DEFAULT_CAPABILITIES: Capabilities = Object.fromEntries(
  CAPABILITIES.map((capability) => [capability, false])
) as Capabilities;

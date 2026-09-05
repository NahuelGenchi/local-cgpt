/** Types shared between the main process and the renderer. No runtime logic here. */

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
  'projectAutonomy',
  'publicReference',
  'screen',
  'control',
  'clipboardRead',
  'clipboardWrite'
] as const;

export type Capability = (typeof CAPABILITIES)[number];

export const DESKTOP_CAPABILITIES: readonly Capability[] = [
  'screen',
  'control',
  'clipboardRead',
  'clipboardWrite'
];

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

export type PlatformFamily = 'windows' | 'macos' | 'linux' | 'other';
export interface PlatformInfo {
  family: PlatformFamily;
  name: string;
  desktopAutomation: boolean;
}

export interface SecureStorageInfo {
  available: boolean;
  detail: string | null;
}

export interface Root {
  name: string;
  /** Absolute host path. Never sent to the model. */
  path: string;
}

export type TunnelKind = 'openai' | 'cloudflared' | 'manual';
export interface TunnelSettings {
  kind: TunnelKind;
  tunnelId: string;
  desktopTunnelId: string;
  binaryPath: string;
}

export interface UiPrefs {
  minimizeToTray: boolean;
  autoConnect: boolean;
  privacyScreenshots: boolean;
  theme: 'light' | 'dark';
}

export interface SessionSettings {
  record: boolean;
  retainDays: number;
  advisoryTokens: number;
  limitTokens: number;
}

export interface CompactionSettings {
  auto: boolean;
  autoTokens: number;
}

export const GOAL_REASONING_LEVELS = ['default', 'minimal', 'low', 'medium', 'high'] as const;
export type GoalReasoning = (typeof GOAL_REASONING_LEVELS)[number];

export interface GoalSettings {
  enabled: boolean;
  model: string;
  reasoning: GoalReasoning;
  prompt: string;
  objectivePrompt: string;
}

export interface MultiAgentSettings {
  enabled: boolean;
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
  | 'offline'
  | 'auth-failed'
  | 'tunnel-unavailable';

export interface TunnelHealth {
  pollErrors: number | null;
  uptimeSeconds: number | null;
  route: string | null;
  probe: string | null;
  clientVersion: string | null;
}

export interface ConnectionStatus {
  state: ConnectionState;
  detail: string;
  publicUrl: string | null;
  localUrl: string | null;
  handshakeAt: number | null;
  lastRequestAt: number | null;
  lastToolCallAt: number | null;
  health: TunnelHealth | null;
  surfaces: SurfaceStatus[];
}

export type SurfaceId = 'core' | 'desktop';
export interface SurfaceStatus {
  id: SurfaceId;
  connectorName: string;
  description: string;
  cardSummary: string;
  optional: boolean;
  available: boolean;
  localUrl: string | null;
  publicUrl: string | null;
  tools: string[];
  state: SurfaceConnectionState;
  detail: string;
  lastRequestAt: number | null;
  lastToolCallAt: number | null;
}
export type SurfaceConnectionState = 'off' | 'starting' | 'live' | 'error';

export interface Check {
  name: string;
  status: 'pass' | 'fail' | 'skipped' | 'not-run';
  ok: boolean | null;
  detail: string;
}

export interface Diagnosis {
  checks: Check[];
  summary: string;
}

export interface LogEntry {
  time: number;
  level: 'info' | 'warn' | 'error';
  message: string;
  agent?: string;
}

export interface BridgeStatus {
  running: boolean;
  port: number | null;
  paired: boolean;
  present: boolean;
  lastSeenAt: number | null;
}

export function browserExtensionRequired(config: Pick<Config, 'sessions' | 'multiAgent'>): boolean {
  return config.sessions.record || config.multiAgent.enabled;
}

export interface AppState {
  config: Config;
  status: ConnectionStatus;
  platform: PlatformInfo;
  secureStorage: SecureStorageInfo;
  hasApiKey: boolean;
  hasGoalKey: boolean;
  resolvedBinary: string | null;
  bundledTunnelVersion: string | null;
  bridge: BridgeStatus;
}

/**
 * Existing defaults remain unchanged. The new high-authority lifecycle grant is fail-closed for
 * both fresh and migrated configs until the user explicitly enables it.
 */
export const DEFAULT_CAPABILITIES: Capabilities = {
  browse: true,
  search: true,
  read: true,
  metadata: true,
  create: false,
  edit: false,
  move: false,
  deleteFile: false,
  command: false,
  network: false,
  projectAutonomy: false,
  publicReference: false,
  screen: false,
  control: false,
  clipboardRead: false,
  clipboardWrite: false
};

export const CAPABILITY_LABELS: Record<Capability, string> = {
  browse: 'Browse folders',
  search: 'Search files',
  read: 'Read files',
  metadata: 'File metadata',
  create: 'Create files',
  edit: 'Edit files',
  move: 'Move / rename',
  deleteFile: 'Delete files',
  command: 'Run commands',
  network: 'Use GitHub',
  projectAutonomy: 'Project autonomy',
  publicReference: 'Read public references',
  screen: 'See the screen',
  control: 'Control mouse and keyboard',
  clipboardRead: 'Read clipboard',
  clipboardWrite: 'Write clipboard'
};

export const CAPABILITY_DETAILS: Record<Capability, string> = {
  browse: 'List what is inside an approved folder.',
  search: 'Find files by name or glob, and text inside them.',
  read: 'Read text in ranges, and open local images into vision.',
  metadata: 'Size, dates and line count, without the contents.',
  create: 'Add new files, and the folders they need.',
  edit: 'Exact edits, applied atomically across files.',
  move: 'Move or rename, both ends inside approved folders.',
  deleteFile: 'Permanent — there is no Recycle Bin.',
  command: 'Run commands in the Linux sandbox. Ordinary commands stay off the network.',
  network: 'Sync and manage this approved repository on GitHub through a GitHub-only transport.',
  projectAutonomy: 'Let an explicitly marked approved project keep resumable tasks and owned processes across model/app runtime boundaries.',
  publicReference: 'Read only app-reviewed public engineering/specification pages; no arbitrary URLs.',
  screen: 'Screenshots, open windows, and the controls on them.',
  control: 'Moves the pointer, clicks, types and presses keys, as you.',
  clipboardRead: 'Read the current clipboard text.',
  clipboardWrite: 'Replace the clipboard without focus or keystrokes.'
};

export const CAPABILITY_TOOLS: Record<Capability, readonly string[]> = {
  browse: ['read'],
  search: ['read', 'find'],
  read: ['read', 'view_image'],
  metadata: ['read'],
  create: ['apply_patch'],
  edit: ['apply_patch'],
  move: ['apply_patch'],
  deleteFile: ['apply_patch'],
  command: ['exec_command', 'write_stdin'],
  network: ['local_github'],
  // This is an additional lifecycle gate over command/network, not a standalone tool grant.
  projectAutonomy: [],
  publicReference: ['reference_web'],
  screen: ['observe'],
  control: ['computer'],
  clipboardRead: ['computer'],
  clipboardWrite: ['computer']
};

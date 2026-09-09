/** Existing chat/bridge/Goal controls, separated from the history rendering lifecycle.
 * This refactor does not enable recording, Goal, workers or any model/provider request.
 * Goal-provider removal remains separately tracked in #62.
 */
import type { AppState, Config } from '../shared/types.js';
import { browserExtensionRequired } from '../shared/types.js';
import type { SwarmState } from '../shared/session.js';
import { DEFAULT_GOAL_OBJECTIVE_SYSTEM_PROMPT, DEFAULT_GOAL_SYSTEM_PROMPT, MAX_GOAL_SYSTEM_PROMPT_CHARS } from '../shared/goal.js';
import { $, ago, compactNumber, el, icon, run, toast } from './dom.js';
import { reconcileRows } from './keyed-view.js';

const api = window.api;
let goalModel = '';
let goalModels: Array<{ id: string; name: string; created: number; contextLength: number }> = [];
let goalTotal = 0;
let goalLoading = false;
let extensionPathShown = false;

function value(input: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, next: string, previous?: string | number): void {
  // An unrelated state push must not erase an unsaved focused edit.
  if (document.activeElement === input && previous !== undefined && input.value !== String(previous)) return;
  input.value = next;
}
function checked(input: HTMLInputElement, next: boolean, previous?: boolean): void {
  if (document.activeElement === input && previous !== undefined && input.checked !== previous) return;
  input.checked = next;
}

export function chatSettingsPatch(current: Config): Pick<Config, 'sessions' | 'compaction' | 'multiAgent' | 'goal'> {
  const number = (id: string, fallback: number, min: number, max: number): number => {
    const raw = Number($<HTMLInputElement>(id).value);
    return Number.isFinite(raw) ? Math.min(max, Math.max(min, Math.round(raw))) : fallback;
  };
  const threshold = number('autoCompactTokens', current.compaction.autoTokens, 10_000, 4_000_000);
  return {
    sessions: {
      record: $<HTMLInputElement>('sessRecord').checked,
      retainDays: number('sessRetain', current.sessions.retainDays, 0, 3650),
      advisoryTokens: threshold,
      limitTokens: Math.min(4_000_000, Math.max(10_000, Math.round(threshold * 4 / 3)))
    },
    compaction: { auto: $<HTMLInputElement>('autoCompact').checked, autoTokens: threshold },
    multiAgent: { enabled: $<HTMLInputElement>('homeMaEnabled').checked, maxWorkers: number('maWorkers', current.multiAgent.maxWorkers, 1, 8) },
    goal: {
      enabled: $<HTMLInputElement>('goalEnabled').checked,
      model: goalModel || current.goal.model,
      reasoning: $<HTMLSelectElement>('goalReasoning').value as Config['goal']['reasoning'],
      prompt: $<HTMLTextAreaElement>('goalPrompt').value.trim() || DEFAULT_GOAL_SYSTEM_PROMPT,
      objectivePrompt: $<HTMLTextAreaElement>('goalObjectivePrompt').value.trim() || DEFAULT_GOAL_OBJECTIVE_SYSTEM_PROMPT
    }
  };
}

async function showExtensionPath(): Promise<void> {
  if (extensionPathShown) return;
  extensionPathShown = true;
  const dir = await run(api.extensionPath());
  $('extensionPath').textContent = dir ? `Extension folder: ${dir}` : 'The extension folder is missing from this installation. Reinstall the app, or use the extension/ folder from a source checkout.';
  $('extensionPath').classList.toggle('is-warn', !dir);
  $<HTMLButtonElement>('bridgeFolder').disabled = !dir;
}

function applyGoal(state: AppState, previous?: Config): void {
  const { config } = state;
  const secure = state.secureStorage?.available ?? true;
  goalModel = config.goal.model;
  checked($<HTMLInputElement>('goalEnabled'), config.goal.enabled, previous?.goal.enabled);
  $<HTMLInputElement>('goalEnabled').disabled = !config.sessions.record;
  value($<HTMLSelectElement>('goalReasoning'), config.goal.reasoning, previous?.goal.reasoning);
  value($<HTMLTextAreaElement>('goalPrompt'), config.goal.prompt, previous?.goal.prompt);
  value($<HTMLTextAreaElement>('goalObjectivePrompt'), config.goal.objectivePrompt, previous?.goal.objectivePrompt);
  $('goalHint').textContent = !config.sessions.record
    ? 'Turn on session recording first — Goal needs the recorded conversation to decide what is still missing.'
    : !state.hasGoalKey ? 'OpenRouter API key essential for goal feature.'
    : config.goal.enabled ? 'A second model reads each finished answer and writes your next message, until it decides the goal is met.'
    : 'Off — nothing is sent to OpenRouter and nothing is typed into your chats.';
  $('goalHint').classList.toggle('is-warn', !config.sessions.record || !state.hasGoalKey);
  $('goalModelName').textContent = config.goal.model;
  const key = $<HTMLInputElement>('goalKey');
  key.placeholder = state.hasGoalKey ? '•••••••• stored' : 'sk-or-v1-…';
  key.disabled = !secure;
  $('goalKeyState').textContent = !secure ? state.secureStorage?.detail ?? 'Secure credential storage is unavailable.'
    : state.hasGoalKey ? 'A key is stored with secure OS credential storage. Type a new one to replace it.'
    : 'Stored with secure OS credential storage. It never leaves this app, and the browser is only ever handed the reply.';
  $('goalKeyState').classList.toggle('is-warn', !secure);
  $<HTMLButtonElement>('goalKeyRemove').disabled = !state.hasGoalKey || !secure;
  if (goalModels.length && !$('goalModels').hidden) paintGoalModels();
}

export function applyChatSettings(state: AppState, previous?: Config): void {
  const { config, bridge } = state;
  value($<HTMLInputElement>('sessRetain'), String(config.sessions.retainDays), previous?.sessions.retainDays);
  checked($<HTMLInputElement>('autoCompact'), config.compaction.auto, previous?.compaction.auto);
  value($<HTMLInputElement>('autoCompactTokens'), String(config.compaction.autoTokens), previous?.compaction.autoTokens);
  $('autoCompactHint').textContent = config.compaction.auto
    ? 'Interrupts the answer at this many tokens, writes a handoff, opens a fresh chat. Once per chat.'
    : 'Off — only the Compact & resume button in the ChatGPT tab compacts.';
  value($<HTMLInputElement>('maWorkers'), String(config.multiAgent.maxWorkers), previous?.multiAgent.maxWorkers);
  applyGoal(state, previous);
  const required = browserExtensionRequired(config);
  const secure = state.secureStorage?.available ?? true;
  $<HTMLButtonElement>('bridgeUnpair').disabled = !bridge.paired;
  $('bridgeState').textContent = !required ? 'Browser-backed features are off. The extension is not needed right now.'
    : !secure ? state.secureStorage?.detail ?? 'Secure credential storage is unavailable, so the extension cannot pair safely.'
    : !bridge.running ? 'The local bridge is off even though recording or multi-agent mode needs it.'
    : bridge.present ? `Connected. Listening on 127.0.0.1:${bridge.port ?? '?'} · last message ${ago(bridge.lastSeenAt)}.`
    : bridge.paired ? `Authorized, but the browser extension is not currently connected. ${bridge.lastSeenAt === null ? 'It has not checked in since this app started.' : `Last seen ${ago(bridge.lastSeenAt)}.`}`
    : `Listening on 127.0.0.1:${bridge.port ?? '?'} · no browser is authorized or connected yet.`;
  $('bridgeState').classList.toggle('is-warn', required && (!bridge.present || !secure));
  void showExtensionPath();
}

export function paintSwarmSettings(state: SwarmState): void {
  const list = $('swarmList');
  reconcileRows(list, state.agents.length ? state.agents.map((agent) => ({
    key: `${agent.id}:${agent.conversationId ?? ''}`,
    revision: JSON.stringify(agent),
    create: () => {
      const row = el('div', 'agent');
      const top = el('div', 'model-top');
      top.append(el('b', '', agent.label || agent.id), el('span', 'chip', agent.role), el('span', `chip is-${agent.state}`, agent.state));
      if (agent.state !== 'finished' && agent.state !== 'failed') {
        const clear = document.createElement('button');
        clear.type = 'button';
        clear.className = 'btn btn-quiet agent-clear';
        clear.append(icon('i-x'));
        clear.dataset.clear = agent.id;
        clear.dataset.focusKey = 'clear-agent';
        clear.title = agent.role === 'prime' ? 'Clear session — ends this run and every worker in it' : `Clear session — ends ${agent.id} and frees its slot`;
        clear.setAttribute('aria-label', clear.title);
        top.append(clear);
      }
      const bits = [`${agent.pending} pending`, `${agent.delivered} delivered`];
      if (agent.conversationId) bits.push('chat bound');
      row.append(top, el('div', 'model-sub', bits.join(' · ')));
      if (agent.task) row.append(el('p', 'hint', agent.task));
      if (agent.state === 'failed' && agent.result) row.append(el('p', 'hint is-warn', agent.result));
      return row;
    }
  })) : [{ key: 'empty', revision: String(state.retainedHistory), create: () => el('p', 'hint', state.retainedHistory
    ? 'No workers are running. Reusable worker histories are parked and remain available to their prime chats; Clear swarm permanently removes them.'
    : 'No agents. The prime agent creates workers with the agents tool’s spawn action.') }]);
  $<HTMLButtonElement>('swarmReset').disabled = state.agents.length === 0 && state.retainedHistory !== true;
}

function maybePageGoalModels(): void {
  if (goalLoading || !goalModels.length || goalModels.length >= goalTotal) return;
  const list = $('goalModelList');
  if (list.clientHeight === 0 || list.scrollHeight - list.scrollTop - list.clientHeight > 72) return;
  void loadGoalModels(false);
}
function paintGoalModels(): void {
  const list = $('goalModelList');
  const keep = list.scrollTop;
  reconcileRows(list, goalModels.map((model) => ({ key: model.id, revision: JSON.stringify([model, goalModel]), create: () => {
    const row = el('button', 'goal-model');
    row.setAttribute('type', 'button');
    row.dataset.model = model.id;
    row.dataset.focusKey = 'choose-model';
    if (model.id === goalModel) row.dataset.chosen = '1';
    row.append(el('b', 'goal-model-name', model.name));
    const released = model.created ? new Date(model.created * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : 'release date not published';
    row.append(el('em', 'goal-model-meta', `${model.id} · ${released}${model.contextLength > 0 ? ` · ${compactNumber(model.contextLength)} ctx` : ''}`));
    return row;
  } }))); 
  $('goalModelsState').textContent = goalModels.length ? `Showing the ${goalModels.length} newest of ${goalTotal}, newest release first.` : 'No models came back.';
  $<HTMLButtonElement>('goalMore').disabled = goalModels.length >= goalTotal;
  $('goalMore').hidden = goalModels.length >= goalTotal;
  list.scrollTop = keep;
  maybePageGoalModels();
}
async function loadGoalModels(reset: boolean): Promise<void> {
  if (goalLoading) return;
  goalLoading = true;
  if (reset) { goalModels = []; goalTotal = 0; }
  $('goalModelsState').textContent = 'Loading models from OpenRouter…';
  $<HTMLButtonElement>('goalMore').disabled = true;
  try {
    const page = await run(api.listGoalModels(goalModels.length));
    if (!page) {
      $('goalModelsState').textContent = 'OpenRouter could not be reached. The model in use is unchanged.';
      return;
    }
    goalModels = [...goalModels, ...page.models];
    goalTotal = page.total;
  } finally { goalLoading = false; }
  paintGoalModels();
}

export function initChatSettings(save: () => Promise<void>, onSwarm: (state: SwarmState) => void): void {
  for (const id of ['sessRetain', 'autoCompact', 'autoCompactTokens', 'maWorkers', 'goalEnabled', 'goalReasoning', 'goalPrompt', 'goalObjectivePrompt']) {
    $(id).addEventListener('change', () => void save());
  }
  for (const entry of [
    ['goalPrompt', 'goalPromptPanel', 'goalPromptEdit', 'goalPromptReset', DEFAULT_GOAL_SYSTEM_PROMPT, 'Goal prompt restored to default'],
    ['goalObjectivePrompt', 'goalObjectivePromptPanel', 'goalObjectivePromptEdit', 'goalObjectivePromptReset', DEFAULT_GOAL_OBJECTIVE_SYSTEM_PROMPT, 'Goal driver prompt restored to default']
  ]) {
    const [inputId, panelId, editId, resetId, prompt, restored] = entry as [string, string, string, string, string, string];
    $<HTMLTextAreaElement>(inputId).maxLength = MAX_GOAL_SYSTEM_PROMPT_CHARS;
    $(editId).addEventListener('click', () => {
      const panel = $(panelId);
      panel.hidden = !panel.hidden;
      $(editId).textContent = panel.hidden ? 'Edit prompt' : 'Close prompt';
      if (!panel.hidden) $(inputId).focus();
    });
    $(resetId).addEventListener('click', async () => { $<HTMLTextAreaElement>(inputId).value = prompt; await save(); toast(restored); });
  }
  $('goalPick').addEventListener('click', () => {
    const panel = $('goalModels');
    panel.hidden = !panel.hidden;
    $('goalPick').textContent = panel.hidden ? 'Select model' : 'Close';
    if (!panel.hidden && !goalModels.length) void loadGoalModels(true);
  });
  $('goalMore').addEventListener('click', () => void loadGoalModels(false));
  $('goalModelList').addEventListener('scroll', maybePageGoalModels);
  $('goalModelList').addEventListener('click', (event) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>('[data-model]');
    if (!row?.dataset.model) return;
    goalModel = row.dataset.model;
    $('goalModelName').textContent = goalModel;
    paintGoalModels();
    void save();
    toast(`Goal model set to ${goalModel}`);
  });
  $('goalKey').addEventListener('blur', async () => {
    const input = $<HTMLInputElement>('goalKey');
    const submitted = input.value;
    const key = submitted.trim();
    if (!key) return;
    const next = await run(api.setGoalKey(key));
    if (next) {
      // Refocus/new typing while secret IPC is pending must not lose the new value.
      if (input.value === submitted) input.value = '';
      applyGoal(next);
      toast('OpenRouter key stored');
    }
  });
  $('goalKeyRemove').addEventListener('click', async () => {
    const next = await run(api.setGoalKey(''));
    if (next) { applyGoal(next); toast('OpenRouter key removed'); }
  });
  $('bridgeUnpair').addEventListener('click', async () => { if (await run(api.unpairExtension())) toast('Browser disconnected'); });
  $('bridgeFolder').addEventListener('click', async () => { if (await run(api.openExtensionFolder())) toast('Extension folder opened'); });
  $('swarmReset').addEventListener('click', async () => {
    const state = await run(api.resetSwarm());
    if (state) { onSwarm(state); toast('Swarm cleared'); }
  });
  $('swarmList').addEventListener('click', async (event) => {
    const id = (event.target as HTMLElement).closest<HTMLElement>('[data-clear]')?.dataset.clear;
    if (!id) return;
    const outcome = await run(api.clearAgent(id));
    if (!outcome) return;
    onSwarm(outcome.swarm);
    toast(outcome.cleared === 'run' ? 'Run cleared — every worker ended' : outcome.cleared === 'worker' ? `${id} cleared — its slot is free` : outcome.reason);
  });
}

/**
 * Renderer bridge for Electron system tray commands and status sync.
 */

import { listActiveSubAgentRuns } from './agents/orchestrator';
import { subscribeSubAgentRuns } from './agents/sub-agent-events';
import {
  listMainTurnActivity,
  subscribeMainTurnActivity,
} from './chat/main-turn-activity';
import {
  listTitleJobActivity,
  subscribeTitleJobActivity,
} from './chat/titles/activity-events';
import type { MinnowTrayCommand, MinnowTrayStatusSnapshot } from './electron.d';
import { appConfirm } from './ui/app-dialog';
import {
  collectLocalModelTraySnapshot,
  unloadAllLocalModels,
} from './providers/local-model-tray';
import { buildAgentActivitySnapshot } from './state/agent-activity-registry';
import { getChatItemDotContext } from './ui/chat-item-dot';
import { sessionState } from './state/sessions';
import { openSettings } from './ui/settings-page';
import { setStatus } from './ui/status';

const STATUS_THROTTLE_MS = 400;
let initDone = false;
let ready = false;
let pendingCommands: MinnowTrayCommand[] = [];
let statusTimer: ReturnType<typeof setTimeout> | null = null;
let lastSnapshotJson = '';

function trayApi(): NonNullable<typeof window.minnow>['tray'] | null {
  return window.minnow?.tray ?? null;
}

/** Count in-flight agent work for tray (main turns, sub-agents, title jobs). */
function countRunningAgents(): number {
  if (!sessionState) return 0;
  const rows = buildAgentActivitySnapshot({
    nowMs: Date.now(),
    chats: sessionState.chats,
    mainTurns: listMainTurnActivity(),
    subAgents: listActiveSubAgentRuns(),
    titleJobs: listTitleJobActivity(),
    questionPendingChatIds: getChatItemDotContext(null).inputPendingChatIds,
  });
  return rows.length;
}

async function buildTrayStatus(): Promise<MinnowTrayStatusSnapshot> {
  const models = await collectLocalModelTraySnapshot();
  return {
    agentCount: countRunningAgents(),
    localModelCount: models.count,
    localModelNames: models.names,
  };
}

function scheduleStatusPublish(): void {
  if (!trayApi()) return;
  if (statusTimer) return;
  statusTimer = setTimeout(() => {
    statusTimer = null;
    void publishTrayStatus();
  }, STATUS_THROTTLE_MS);
}

async function publishTrayStatus(): Promise<void> {
  const api = trayApi();
  if (!api) return;
  try {
    const snapshot = await buildTrayStatus();
    const json = JSON.stringify(snapshot);
    if (json === lastSnapshotJson) return;
    lastSnapshotJson = json;
    api.publishStatus(snapshot);
  } catch {}
}

async function handleUnloadLocalModels(): Promise<void> {
  const agents = countRunningAgents();
  if (agents > 0) {
    const proceed = await appConfirm(
      `${agents} agent${agents === 1 ? '' : 's'} may be using a loaded model. Unload all local models anyway?`,
    );
    if (!proceed) return;
  }

  const snapshot = await collectLocalModelTraySnapshot();
  if (!snapshot.rows.length) {
    setStatus('ok', 'No local models to unload');
    await publishTrayStatus();
    return;
  }

  setStatus('spin', 'Unloading local models…');
  const result = await unloadAllLocalModels(snapshot.rows);
  if (result.failures.length) {
    const detail = result.failures.map((f) => `${f.label}: ${f.message}`).join('; ');
    setStatus('err', `Unloaded ${result.unloaded}; ${result.failures.length} failed (${detail})`);
  } else {
    setStatus('ok', `Unloaded ${result.unloaded} local model${result.unloaded === 1 ? '' : 's'}`);
  }
  await publishTrayStatus();
}

async function handleNewChat(): Promise<void> {
  const { launchCodeChat } = await import('./os/chat-launch');
  await launchCodeChat();
}

function handleOpenSettings(): void {
  if (window.minnow?.app?.isElectron) {
    void import('./os/router').then((m) => m.launchApp('settings'));
    return;
  }
  openSettings('general', { searchKey: 'general.desktop' });
}

async function dispatchTrayCommand(command: MinnowTrayCommand): Promise<void> {
  if (command.type === 'new_chat') {
    await handleNewChat();
    return;
  }
  if (command.type === 'open_settings') {
    handleOpenSettings();
    return;
  }
  if (command.type === 'unload_local_models') {
    await handleUnloadLocalModels();
  }
}

function flushPendingCommands(): void {
  if (!ready) return;
  while (pendingCommands.length > 0) {
    const command = pendingCommands.shift();
    if (command) void dispatchTrayCommand(command);
  }
}

function markTrayReady(): void {
  ready = true;
  trayApi()?.notifyReady();
  flushPendingCommands();
  void publishTrayStatus();
}

function bindActivityListeners(): void {
  const refresh = () => scheduleStatusPublish();
  subscribeMainTurnActivity(refresh);
  subscribeSubAgentRuns(refresh);
  subscribeTitleJobActivity(refresh);
}

/** Initialize tray bridge once Electron preload is available. */
export function initElectronTrayBridge(): void {
  if (initDone) return;
  const api = trayApi();
  if (!api) return;
  initDone = true;

  api.onCommand((command) => {
    if (!ready) {
      pendingCommands.push(command);
      return;
    }
    void dispatchTrayCommand(command);
  });

  bindActivityListeners();

  void import('./state/sessions').then(({ sessionsReady }) => {
    void sessionsReady.then(() => markTrayReady());
  });

  if (sessionState) {
    markTrayReady();
  }
}

/** Re-publish tray status when models change (e.g. after manual unload). */
export function refreshTrayStatusNow(): void {
  lastSnapshotJson = '';
  void publishTrayStatus();
}

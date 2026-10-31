import { showToast } from './ui/toast';
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
  invalidateLocalModelTraySnapshot,
  unloadAllLocalModels,
} from './providers/local-model-tray';
import { buildAgentActivitySnapshot, countRunningAgentRows } from './state/agent-activity-registry';
import { subscribeManagedChatMetadata } from './chat/managed-chat-view';
import { getChatItemDotContext } from './ui/chat-item-dot';
import { sessionState } from './state/sessions';
import { openSettings } from './ui/settings-page';
import { setStatus } from './ui/status';
import { subscribeServeEvents } from './models/api-client';
import { subscribeModelInventory } from './models/inventory-events';

const STATUS_THROTTLE_MS = 400;
let initDone = false;
let ready = false;
let pendingCommands: MinnowTrayCommand[] = [];
let statusTimer: ReturnType<typeof setTimeout> | null = null;
let modelTimer: ReturnType<typeof setInterval> | null = null;
let lastSnapshotJson = '';
const subscriptions: Array<() => void> = [];
let lifetime = 0;

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
  return countRunningAgentRows(rows);
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
  const version = lifetime;
  try {
    const snapshot = await buildTrayStatus();
    if (version !== lifetime) return;
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

  const snapshot = await collectLocalModelTraySnapshot(undefined, { fresh: true });
  if (!snapshot.rows.length) {
    showToast('No local models to unload');
    await publishTrayStatus();
    return;
  }

  setStatus('spin', 'Unloading local models…');
  const result = await unloadAllLocalModels(snapshot.rows);
  if (result.failures.length) {
    const detail = result.failures.map((f) => `${f.label}: ${f.message}`).join('; ');
    setStatus('err', `Unloaded ${result.unloaded}; ${result.failures.length} failed (${detail})`);
  } else {
    showToast(`Unloaded ${result.unloaded} local model${result.unloaded === 1 ? '' : 's'}`);
  }
  invalidateLocalModelTraySnapshot();
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
  if (ready) return;
  ready = true;
  trayApi()?.notifyReady();
  flushPendingCommands();
  void publishTrayStatus();
}

function bindActivityListeners(): void {
  const refresh = () => scheduleStatusPublish();
  subscriptions.push(subscribeMainTurnActivity(refresh), subscribeSubAgentRuns(refresh), subscribeTitleJobActivity(refresh), subscribeManagedChatMetadata(refresh));
}

/** Initialize tray bridge once Electron preload is available. */
export function initElectronTrayBridge(): void {
  if (initDone) return;
  const api = trayApi();
  if (!api) return;
  initDone = true;
  const version = ++lifetime;

  subscriptions.push(api.onCommand((command) => {
    if (!ready) {
      pendingCommands.push(command);
      return;
    }
    void dispatchTrayCommand(command);
  }));

  bindActivityListeners();
  subscriptions.push(subscribeModelInventory(refreshTrayStatusNow));
  modelTimer = setInterval(refreshTrayStatusNow, 30_000);
  let serveKey = '';
  if (typeof EventSource !== 'undefined') subscriptions.push(subscribeServeEvents(({ serves }) => {
    const key = JSON.stringify(serves.map(row => [row.id, row.status, row.modelPath, row.modelLabel]));
    if (key === serveKey) return;
    serveKey = key;
    refreshTrayStatusNow();
  }));

  void import('./state/sessions').then(({ sessionsReady }) => {
    void sessionsReady.then(() => { if (initDone && version === lifetime) markTrayReady(); });
  });

  if (sessionState) {
    markTrayReady();
  }
}

/** Release app-lifetime listeners when the renderer is unmounted or reinitialized. */
export function disposeElectronTrayBridge(): void {
  lifetime++;
  subscriptions.splice(0).forEach(unsubscribe => unsubscribe());
  if (statusTimer) clearTimeout(statusTimer);
  if (modelTimer) clearInterval(modelTimer);
  modelTimer = null;
  statusTimer = null; initDone = false; ready = false; pendingCommands = []; lastSnapshotJson = '';
}

/** Re-publish tray status when models change (e.g. after manual unload). */
export function refreshTrayStatusNow(): void {
  invalidateLocalModelTraySnapshot();
  lastSnapshotJson = '';
  void publishTrayStatus();
}

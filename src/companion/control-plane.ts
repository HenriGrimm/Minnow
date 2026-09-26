/** Authenticated host/device bridge and compact phone control surface. */

import { streamingChatIds } from '../app-state';
import { isChatTurnInProgress } from '../chat/chat-turn-guard';
import { projectExecutionLedger } from '../chat/execution-ledger';
import { chatAwaitingUserInputTool } from '../chat/incomplete-tool-batch';
import {
  enqueueComposerMessage,
  getPendingMessageQueueCount,
} from '../chat/message-queue';
import { enqueueSteerMessage } from '../chat/steer-message';
import { formatTurnSummary } from '../chat/turn-summary';
import { randomUUID } from '../lib/random-id';
import {
  ensureChatHistoryLoaded,
  findChatById,
  getChatMessageCount,
  isChatHistoryLoaded,
  sessionState,
} from '../state/sessions';
import type { Chat } from '../types';
import type { ToolApprovalRequest } from '../tools/tool-approval-types';
import { isChatQuestionPending } from '../ui/chat-item-dot';
import { hasHostSessionToken } from '../api/session-token';
import {
  clearCompanionControlledChatIfIdle,
  markCompanionControlledChat,
} from './remote-authority';

const HOST_POLL_MS = 2_000;
const DEVICE_POLL_MS = 2_500;
const MAX_VISIBLE_TASKS = 30;

type CompanionTaskStatus =
  | 'running'
  | 'queued'
  | 'needs-input'
  | 'failed'
  | 'completed'
  | 'idle';

interface CompanionReview {
  status: CompanionTaskStatus;
  outcome: string;
  summary: string;
  actions: number;
  failedActions: number;
  files: Array<{
    path: string;
    additions: number;
    deletions: number;
    countsKnown?: boolean;
  }>;
}

interface CompanionTask {
  id: string;
  title: string;
  status: CompanionTaskStatus;
  queued: number;
  updatedAt: number;
  review?: CompanionReview;
}

interface CompanionApproval {
  id: string;
  chatId: string;
  taskTitle: string;
  title: string;
  toolName: string;
  description: string;
  argsJson: string;
  workspaceLabel: string;
  createdAt: number;
}

export interface CompanionState {
  connected: boolean;
  publishedAt: number | null;
  tasks: CompanionTask[];
  approvals: CompanionApproval[];
}

type CompanionCommand =
  | {
      id: string;
      kind: 'message';
      chatId: string;
      text: string;
      delivery: 'steer' | 'queue' | 'send';
    }
  | {
      id: string;
      kind: 'approval';
      approvalId: string;
      decision: 'allow-once' | 'cancel';
    };

interface PendingRemoteApproval {
  approval: CompanionApproval;
  settle: (decision: 'allow-once' | 'cancel') => void;
}

const pendingApprovals = new Map<string, PendingRemoteApproval>();
const processedCommandIds = new Set<string>();
const reviewCache = new Map<string, { key: string; review?: CompanionReview }>();
let hostTimer: number | undefined;
let deviceTimer: number | undefined;
let hostCycleRunning = false;
let deviceCycleRunning = false;

function taskStatus(chat: Chat): CompanionTaskStatus {
  if (
    [...pendingApprovals.values()].some((entry) => entry.approval.chatId === chat.id) ||
    isChatQuestionPending(chat.id) ||
    chatAwaitingUserInputTool(chat) ||
    (chat.superPlanView?.needsInput && !chat.superPlanView.finished)
  ) {
    return 'needs-input';
  }
  if (
    streamingChatIds.has(chat.id) ||
    isChatTurnInProgress(chat.id) ||
    Boolean(chat.currentGenerationId?.trim())
  ) {
    return 'running';
  }
  if (getPendingMessageQueueCount(chat) > 0 || Boolean(chat.pendingSteerMessage?.trim())) {
    return 'queued';
  }
  if (chat.turnError) return 'failed';
  const latest = chat.runs?.at(-1);
  if (latest?.status === 'failed') return 'failed';
  if (latest?.status === 'completed') return 'completed';
  return 'idle';
}

function reviewForChat(chat: Chat, fallback: CompanionTaskStatus): CompanionReview | undefined {
  if (!isChatHistoryLoaded(chat)) return undefined;
  const latestRun = chat.runs?.at(-1);
  const cacheKey = [
    chat.lastMessageAt ?? chat.updatedAt ?? 0,
    chat.history.length,
    latestRun?.runId ?? '',
    latestRun?.status ?? '',
  ].join(':');
  const cached = reviewCache.get(chat.id);
  if (cached?.key === cacheKey) return cached.review;
  const turn = projectExecutionLedger(chat).turns.at(-1);
  if (!turn) {
    reviewCache.set(chat.id, { key: cacheKey });
    return undefined;
  }
  const status: CompanionTaskStatus =
    turn.status === 'running' ? 'running'
      : turn.status === 'failed' ? 'failed'
        : turn.status === 'completed' || turn.status === 'recorded' ? 'completed'
          : fallback;
  const review = {
    status,
    outcome: turn.errorMessage ?? turn.completion ?? '',
    summary: formatTurnSummary(turn.summary),
    actions: turn.actions.length,
    failedActions: turn.actions.filter((action) => action.status === 'failed').length,
    files: turn.files.slice(0, 12).map((file) => ({
      path: file.path,
      additions: file.additions,
      deletions: file.deletions,
      countsKnown: file.countsKnown,
    })),
  };
  reviewCache.set(chat.id, { key: cacheKey, review });
  return review;
}

const STATUS_ORDER: Record<CompanionTaskStatus, number> = {
  'needs-input': 0,
  running: 1,
  queued: 2,
  failed: 3,
  completed: 4,
  idle: 5,
};

/** Snapshot from the execution-owning renderer; deliberately excludes transcript bodies. */
export function buildCompanionHostSnapshot(): {
  tasks: CompanionTask[];
  approvals: CompanionApproval[];
} {
  const candidates = (sessionState?.chats ?? [])
    .filter((chat) => chat.kind !== 'expert-lab')
    .map((chat) => {
      const status = taskStatus(chat);
      return {
        chat,
        status,
        queued: getPendingMessageQueueCount(chat) + (chat.pendingSteerMessage?.trim() ? 1 : 0),
        updatedAt: chat.lastMessageAt ?? chat.updatedAt ?? 0,
      };
    })
    .filter((item) => getChatMessageCount(item.chat) > 0 || item.status !== 'idle')
    .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.updatedAt - a.updatedAt)
    .slice(0, MAX_VISIBLE_TASKS);
  const tasks: CompanionTask[] = candidates.map(({ chat, status, queued, updatedAt }) => {
    const review = reviewForChat(chat, status);
    return {
      id: chat.id,
      title: chat.name?.trim() || 'Untitled task',
      status,
      queued,
      updatedAt,
      ...(review ? { review } : {}),
    };
  });
  return {
    tasks,
    approvals: [...pendingApprovals.values()].map((entry) => entry.approval),
  };
}

async function publishHostState(): Promise<void> {
  await fetch('/api/companion/control/state', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildCompanionHostSnapshot()),
  });
}

async function acknowledgeCommand(id: string): Promise<void> {
  await fetch(`/api/companion/control/commands/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

async function handleHostCommand(command: CompanionCommand): Promise<void> {
  if (command.kind === 'approval') {
    pendingApprovals.get(command.approvalId)?.settle(command.decision);
    return;
  }

  const chat = findChatById(command.chatId);
  if (!chat) return;
  await ensureChatHistoryLoaded(chat.id);
  markCompanionControlledChat(chat.id);
  if (command.delivery === 'steer') {
    if (isChatTurnInProgress(chat.id)) enqueueSteerMessage(chat, command.text);
    return;
  }
  if (command.delivery === 'queue') {
    if (isChatTurnInProgress(chat.id)) enqueueComposerMessage(chat, command.text);
    return;
  }
  if (isChatTurnInProgress(chat.id)) return;
  const { resumeParentChatWithMessage } = await import('../chat/run-turn-chat');
  void resumeParentChatWithMessage(chat, command.text).catch(() => undefined);
}

async function pollHostCommands(): Promise<void> {
  const response = await fetch('/api/companion/control/commands', { cache: 'no-store' });
  if (!response.ok) return;
  const payload = await response.json() as { commands?: CompanionCommand[] };
  for (const command of payload.commands ?? []) {
    if (!command?.id || processedCommandIds.has(command.id)) {
      if (command?.id) await acknowledgeCommand(command.id).catch(() => undefined);
      continue;
    }
    processedCommandIds.add(command.id);
    try {
      await handleHostCommand(command);
    } finally {
      await acknowledgeCommand(command.id).catch(() => undefined);
    }
  }
}

async function runHostCycle(): Promise<void> {
  if (hostCycleRunning) return;
  hostCycleRunning = true;
  try {
    for (const chat of sessionState?.chats ?? []) {
      const idle =
        !isChatTurnInProgress(chat.id) &&
        !chat.currentGenerationId?.trim() &&
        getPendingMessageQueueCount(chat) === 0 &&
        !chat.pendingSteerMessage?.trim();
      clearCompanionControlledChatIfIdle(chat.id, idle);
    }
    await publishHostState();
    await pollHostCommands();
  } catch {
    // The ordinary reconnect/status paths own user-visible host failures.
  } finally {
    hostCycleRunning = false;
  }
}

/** Start only in the privileged renderer that owns chat execution. */
export function startHostCompanionControlPlane(): void {
  if (!hasHostSessionToken() || hostTimer !== undefined) return;
  void runHostCycle();
  hostTimer = window.setInterval(() => void runHostCycle(), HOST_POLL_MS);
}

/** Publish one approval for paired devices. Remote choices remain allow-once or cancel. */
export function registerCompanionApproval(
  request: ToolApprovalRequest,
  settle: (decision: 'allow-once' | 'cancel') => void,
): () => void {
  if (!hasHostSessionToken()) return () => {};
  const id = randomUUID();
  const chat = request.chatId ? findChatById(request.chatId) : undefined;
  const workspaceLabel = request.workspace
    ? 'label' in request.workspace ? request.workspace.label : request.workspace.hint
    : '';
  pendingApprovals.set(id, {
    approval: {
      id,
      chatId: request.chatId ?? '',
      taskTitle: chat?.name ?? '',
      title: request.title,
      toolName: request.toolName,
      description: request.description ?? '',
      argsJson: request.argsJson,
      workspaceLabel,
      createdAt: Date.now(),
    },
    settle,
  });
  void runHostCycle();
  return () => {
    pendingApprovals.delete(id);
    void runHostCycle();
  };
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function statusLabel(status: CompanionTaskStatus): string {
  switch (status) {
    case 'needs-input': return 'Needs input';
    case 'running': return 'Running';
    case 'queued': return 'Queued';
    case 'failed': return 'Failed';
    case 'completed': return 'Completed';
    case 'idle': return 'Ready';
  }
}

async function postDeviceCommand(body: Record<string, unknown>): Promise<boolean> {
  const response = await fetch('/api/companion/control/commands', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return response.ok;
}

function renderApproval(approval: CompanionApproval): HTMLElement {
  const card = el('article', 'companion-control__approval');
  const head = el('div', 'companion-control__card-head');
  const title = el('div');
  title.append(el('p', 'companion-control__eyebrow', approval.taskTitle || 'Approval required'));
  title.append(el('h3', 'companion-control__card-title', `Allow ${approval.title}?`));
  head.append(title, el('span', 'companion-control__status is-needs-input', 'Needs input'));
  card.append(head);
  if (approval.description) card.append(el('p', 'companion-control__copy', approval.description));
  const details = el('details', 'companion-control__details');
  details.append(el('summary', '', `${approval.toolName} details`));
  if (approval.workspaceLabel) details.append(el('p', '', approval.workspaceLabel));
  details.append(el('pre', 'companion-control__args', approval.argsJson));
  card.append(details);
  const actions = el('div', 'companion-control__actions');
  const deny = el('button', 'companion-control__button is-muted', 'Deny');
  const allow = el('button', 'companion-control__button is-primary', 'Allow once');
  for (const [button, decision] of [[deny, 'cancel'], [allow, 'allow-once']] as const) {
    button.type = 'button';
    button.addEventListener('click', async () => {
      deny.disabled = true;
      allow.disabled = true;
      const ok = await postDeviceCommand({
        kind: 'approval',
        approvalId: approval.id,
        decision,
      }).catch(() => false);
      if (!ok) {
        deny.disabled = false;
        allow.disabled = false;
      }
      void runDeviceCycle();
    });
  }
  actions.append(deny, allow);
  card.append(actions);
  return card;
}

function renderTask(task: CompanionTask): HTMLElement {
  const card = el('article', 'companion-control__task');
  const head = el('div', 'companion-control__card-head');
  head.append(
    el('h3', 'companion-control__card-title', task.title),
    el('span', `companion-control__status is-${task.status}`, statusLabel(task.status)),
  );
  card.append(head);
  if (task.queued) {
    card.append(el('p', 'companion-control__queue', `${task.queued} follow-up${task.queued === 1 ? '' : 's'} queued`));
  }

  if (task.review) {
    const review = el('details', 'companion-control__details companion-control__review');
    const changed = task.review.files.length;
    const failed = task.review.failedActions;
    review.append(el('summary', '', changed
      ? `Latest result · ${changed} changed file${changed === 1 ? '' : 's'}`
      : 'Latest result'));
    if (task.review.outcome) review.append(el('p', 'companion-control__outcome', task.review.outcome));
    if (task.review.summary) review.append(el('p', 'companion-control__copy', task.review.summary));
    if (task.review.actions) {
      review.append(el('p', 'companion-control__meta', `${task.review.actions} action${task.review.actions === 1 ? '' : 's'}${failed ? ` · ${failed} failed` : ''}`));
    }
    if (changed) {
      const list = el('ul', 'companion-control__files');
      for (const file of task.review.files) {
        const item = el('li');
        item.append(el('code', '', file.path));
        item.append(el('span', '', file.countsKnown === false ? 'changed' : `+${file.additions} −${file.deletions}`));
        list.append(item);
      }
      review.append(list);
    }
    card.append(review);
  }

  const canSteer = task.status === 'running';
  const canSend = ['completed', 'failed', 'idle'].includes(task.status);
  if (canSteer || canSend) {
    const label = el('label', 'companion-control__message-label', canSteer ? 'Guide this run' : 'Follow up');
    const input = el('textarea', 'companion-control__message');
    input.rows = 2;
    input.maxLength = 4_000;
    input.placeholder = canSteer ? 'Add context or queue the next step' : 'Send another instruction';
    label.append(input);
    const actions = el('div', 'companion-control__actions');
    const submit = async (delivery: 'steer' | 'queue' | 'send', buttons: HTMLButtonElement[]) => {
      const text = input.value.trim();
      if (!text) {
        input.focus();
        return;
      }
      buttons.forEach((button) => { button.disabled = true; });
      const ok = await postDeviceCommand({ kind: 'message', chatId: task.id, text, delivery }).catch(() => false);
      if (ok) input.value = '';
      buttons.forEach((button) => { button.disabled = false; });
      void runDeviceCycle();
    };
    if (canSteer) {
      const queue = el('button', 'companion-control__button is-muted', 'Queue next');
      const steer = el('button', 'companion-control__button is-primary', 'Steer now');
      queue.type = 'button';
      steer.type = 'button';
      queue.addEventListener('click', () => void submit('queue', [queue, steer]));
      steer.addEventListener('click', () => void submit('steer', [queue, steer]));
      actions.append(queue, steer);
    } else {
      const send = el('button', 'companion-control__button is-primary', 'Send follow-up');
      send.type = 'button';
      send.addEventListener('click', () => void submit('send', [send]));
      actions.append(send);
    }
    card.append(label, actions);
  }
  return card;
}

function ensureDeviceControlSurface(): HTMLElement {
  let root = document.getElementById('companionControl');
  if (root) return root;
  root = el('section', 'companion-control');
  root.id = 'companionControl';
  root.setAttribute('aria-label', 'Task control plane');
  const toggle = el('button', 'companion-control__toggle');
  toggle.id = 'companionControlToggle';
  toggle.type = 'button';
  toggle.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('aria-controls', 'companionControlPanel');
  toggle.textContent = 'Tasks';
  const panel = el('div', 'companion-control__panel');
  panel.id = 'companionControlPanel';
  panel.hidden = true;
  toggle.addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    toggle.setAttribute('aria-expanded', String(!panel.hidden));
  });
  root.append(toggle, panel);
  document.body.append(root);
  return root;
}

function renderDeviceState(state: CompanionState): void {
  const root = ensureDeviceControlSurface();
  const toggle = root.querySelector<HTMLButtonElement>('#companionControlToggle');
  const panel = root.querySelector<HTMLElement>('#companionControlPanel');
  if (!toggle || !panel) return;
  const attention = state.approvals.length + state.tasks.filter((task) => task.status === 'needs-input').length;
  const running = state.tasks.filter((task) => task.status === 'running').length;
  toggle.textContent = attention
    ? `Tasks · ${attention} need input`
    : running ? `Tasks · ${running} running` : 'Tasks';
  toggle.classList.toggle('has-attention', attention > 0);
  panel.replaceChildren();
  const header = el('header', 'companion-control__header');
  const text = el('div');
  text.append(el('p', 'companion-control__eyebrow', 'Local control plane'));
  text.append(el('h2', 'companion-control__title', 'Tasks'));
  const close = el('button', 'companion-control__close', 'Close');
  close.type = 'button';
  close.addEventListener('click', () => {
    panel.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
    toggle.focus();
  });
  header.append(text, close);
  panel.append(header);
  const status = el('p', `companion-control__host ${state.connected ? 'is-connected' : 'is-offline'}`,
    state.connected ? 'Host connected' : 'Host task renderer unavailable');
  status.setAttribute('role', 'status');
  panel.append(status);
  if (!state.connected) {
    panel.append(el('p', 'companion-control__empty', 'Keep Minnow open on the host to monitor or guide its active tasks.'));
    return;
  }
  if (state.approvals.length) {
    const section = el('section', 'companion-control__section');
    section.append(el('h2', 'companion-control__section-title', 'Approvals'));
    state.approvals.forEach((approval) => section.append(renderApproval(approval)));
    panel.append(section);
  }
  const taskSection = el('section', 'companion-control__section');
  taskSection.append(el('h2', 'companion-control__section-title', 'Recent tasks'));
  if (!state.tasks.length) {
    taskSection.append(el('p', 'companion-control__empty', 'No task activity yet. Start a chat on the host or from this companion.'));
  } else {
    state.tasks.forEach((task) => taskSection.append(renderTask(task)));
  }
  panel.append(taskSection);
}

/** @internal Focused DOM-test seam for the narrow control surface. */
export function renderCompanionStateForTests(state: CompanionState): void {
  renderDeviceState(state);
}

async function runDeviceCycle(): Promise<void> {
  if (deviceCycleRunning) return;
  deviceCycleRunning = true;
  try {
    const response = await fetch('/api/companion/control', { cache: 'no-store' });
    if (!response.ok) return;
    renderDeviceState(await response.json() as CompanionState);
  } catch {
    renderDeviceState({ connected: false, publishedAt: null, tasks: [], approvals: [] });
  } finally {
    deviceCycleRunning = false;
  }
}

/** Start the phone surface after pairing and the narrow companion viewport are active. */
export function startDeviceCompanionControlPlane(): void {
  if (hasHostSessionToken() || deviceTimer !== undefined) return;
  ensureDeviceControlSurface();
  void runDeviceCycle();
  deviceTimer = window.setInterval(() => void runDeviceCycle(), DEVICE_POLL_MS);
}

export function resetCompanionControlPlaneForTests(): void {
  if (hostTimer !== undefined) window.clearInterval(hostTimer);
  if (deviceTimer !== undefined) window.clearInterval(deviceTimer);
  hostTimer = undefined;
  deviceTimer = undefined;
  hostCycleRunning = false;
  deviceCycleRunning = false;
  pendingApprovals.clear();
  processedCommandIds.clear();
  reviewCache.clear();
  document.getElementById('companionControl')?.remove();
}

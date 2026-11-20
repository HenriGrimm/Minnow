import type { Chat } from '../types';
import { classifyTurnFailure, formatAvailableAt, formatWait, type TurnFailureKind, type TurnFailureView } from '../chat/turn-failure';
import { rewriteManagedChatHistory, sendManagedChatAction } from '../chat/managed-chat-client';
import { isChatStreaming } from '../chat/streaming-state';
import { findChatById } from '../state/sessions';
import { createIcon, type IconName } from './icon';
import '../styles/turn-failure-card.css';

/**
 * In-transcript recovery card for a server-run turn that ended in failure.
 * The card is the only place a managed chat explains a failed turn, so it must
 * render for every failed execution, including ones with no partial reply.
 */

const ICONS: Record<TurnFailureKind, IconName> = {
  signed_out: 'lock', api_key: 'key', usage_limit: 'clock', rate_limit: 'stopwatch', unreachable: 'plug',
  model_unavailable: 'cube', context_limit: 'compress', timeout: 'stopwatch', generic: 'warning',
};
const CONTINUE_TEXT = 'Continue from where you left off.';
const SCHEDULE_KEY = 'minnow.turnFailure.autoRetry.v1';
const MAX_AUTO_ATTEMPTS = 6;
const MAX_TIMER_MS = 2 ** 31 - 1;
/** A little slack so the provider's window has actually reopened. */
const RESET_SLACK_MS = 15_000;

type RetryMode = 'replay' | 'continue';
interface Schedule { executionId: string; at: number; mode: RetryMode; attempts: number }

const timers = new Map<string, ReturnType<typeof setTimeout>>();
/** Cleanup for a card's inline sign-in flow, run when the card is replaced or removed. */
const disposers = new WeakMap<HTMLElement, () => void>();
function disposeCard(card: HTMLElement): void {
  disposers.get(card)?.();
  disposers.delete(card);
}
let armed = false;

function readSchedules(): Record<string, Schedule> {
  try {
    const raw = JSON.parse(localStorage.getItem(SCHEDULE_KEY) || '{}');
    return raw && typeof raw === 'object' ? raw as Record<string, Schedule> : {};
  } catch { return {}; }
}
function writeSchedules(next: Record<string, Schedule>): void {
  try {
    if (Object.keys(next).length) localStorage.setItem(SCHEDULE_KEY, JSON.stringify(next));
    else localStorage.removeItem(SCHEDULE_KEY);
  } catch { /* Storage-less windows keep the in-memory timer only. */ }
}
function getSchedule(chatId: string): Schedule | undefined {
  const row = readSchedules()[chatId];
  return row && typeof row.executionId === 'string' && Number.isFinite(row.at) ? row : undefined;
}
function setSchedule(chatId: string, schedule: Schedule | null): void {
  const all = readSchedules();
  if (schedule) all[chatId] = schedule; else delete all[chatId];
  writeSchedules(all);
  clearTimeout(timers.get(chatId));
  timers.delete(chatId);
  if (schedule) armTimer(chatId, schedule);
}

function armTimer(chatId: string, schedule: Schedule): void {
  const wait = Math.max(0, schedule.at - Date.now());
  timers.set(chatId, setTimeout(() => {
    timers.delete(chatId);
    if (wait > MAX_TIMER_MS) { armTimer(chatId, schedule); return; }
    void runScheduledRetry(chatId);
  }, Math.min(wait, MAX_TIMER_MS)));
}

/** Re-arm saved automatic retries once per window (they survive reloads). */
function armSavedSchedules(): void {
  if (armed) return;
  armed = true;
  for (const [chatId, schedule] of Object.entries(readSchedules())) {
    if (schedule && Number.isFinite(schedule.at)) armTimer(chatId, schedule);
  }
}

async function runScheduledRetry(chatId: string): Promise<void> {
  const schedule = getSchedule(chatId);
  const chat = findChatById(chatId);
  const execution = chat?.agentExecution;
  // Anything newer than the failure (a reply, a new message, Stop) cancels the plan.
  if (!schedule || !chat || execution?.executionId !== schedule.executionId || execution.status !== 'failed' || chat.agentPendingCommand) {
    setSchedule(chatId, null);
    return;
  }
  // Keep the attempt count so a still-spent allowance can schedule the next check.
  setSchedule(chatId, null);
  pendingChains.set(chatId, schedule.attempts + 1);
  try { await retryTurn(chat, schedule.mode); }
  catch { pendingChains.delete(chatId); }
  refreshCard(chatId);
}

/** Attempts carried from an automatic retry into the failure it may produce. */
const pendingChains = new Map<string, number>();

function failureView(chat: Chat): TurnFailureView {
  const execution = chat.agentExecution!;
  const providerId = execution.failure?.providerId ?? execution.resolvedModel?.providerId ?? execution.modelSelection?.providerId ?? chat.providerId;
  return classifyTurnFailure({ message: execution.error, failure: execution.failure, providerId });
}

function failureModel(chat: Chat): { providerId: string; modelId: string } | null {
  const execution = chat.agentExecution;
  const providerId = execution?.failure?.providerId ?? execution?.resolvedModel?.providerId ?? execution?.modelSelection?.providerId;
  const modelId = execution?.failure?.modelId ?? execution?.resolvedModel?.modelId ?? execution?.modelSelection?.modelId ?? '';
  return providerId ? { providerId, modelId } : null;
}

function isReplayable(row: Chat['history'][number] | undefined): boolean {
  return row?.role === 'user' && typeof row.content === 'string' && !row.steer && !row.hiddenFromTranscript &&
    (!row.provenance || row.provenance.actor === 'human');
}

/** The human message behind the failed execution, or the latest replayable one. */
function failedInputIndex(chat: Chat): number {
  const commandId = chat.agentExecution?.commandId;
  if (commandId) {
    const index = chat.history.findIndex(row => row.role === 'user' && row.commandId === commandId);
    if (index >= 0 && isReplayable(chat.history[index])) return index;
  }
  for (let index = chat.history.length - 1; index >= 0; index--) if (isReplayable(chat.history[index])) return index;
  return -1;
}

/** True when the failed turn already produced tool calls or partial prose worth keeping. */
function failedTurnHasWork(chat: Chat): boolean {
  const index = failedInputIndex(chat);
  return index >= 0 && chat.history.slice(index + 1).some(row => row.role === 'tool' || row.role === 'assistant');
}

function defaultMode(chat: Chat, kind: TurnFailureKind): RetryMode {
  return kind === 'timeout' || failedTurnHasWork(chat) ? 'continue' : 'replay';
}

/** Lift the shared usage/rate cooldown first; otherwise a retry is refused before it reaches the provider. */
async function liftCooldown(chat: Chat): Promise<void> {
  const model = failureModel(chat);
  if (!model) return;
  try {
    await fetch('/api/generations/allowance/retry', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(model), signal: AbortSignal.timeout(8000),
    });
  } catch { /* The retry still runs; a live block reports itself again. */ }
}

async function retryTurn(chat: Chat, mode: RetryMode): Promise<void> {
  if (isChatStreaming(chat.id) || chat.agentPendingCommand) throw new Error('This chat is already working on something.');
  const view = failureView(chat);
  if (view.kind === 'usage_limit' || view.kind === 'rate_limit') await liftCooldown(chat);
  if (mode === 'continue') {
    await sendManagedChatAction(chat.id, 'send', { text: CONTINUE_TEXT });
    return;
  }
  const index = failedInputIndex(chat);
  if (index < 0) {
    await sendManagedChatAction(chat.id, 'send', { text: CONTINUE_TEXT });
    return;
  }
  if (!chat.historyDigest) throw new Error('The saved messages are still loading. Try again in a moment.');
  await rewriteManagedChatHistory(chat.id, index, chat.historyDigest, { action: 'replay' });
}

function actionButton(label: string, options: { primary?: boolean; icon?: IconName; title?: string } = {}): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `chat-turn-failure__btn${options.primary ? ' chat-turn-failure__btn--primary' : ''}`;
  if (options.icon) button.append(createIcon(options.icon, { size: 13 }));
  button.append(document.createTextNode(label));
  if (options.title) button.title = options.title;
  return button;
}

function buildCard(chat: Chat, view: TurnFailureView): HTMLElement {
  const executionId = chat.agentExecution!.executionId;
  const card = document.createElement('section');
  card.className = 'chat-turn-failure';
  card.dataset.kind = view.kind;
  card.dataset.chatId = chat.id;
  card.dataset.executionId = executionId;
  card.setAttribute('role', 'group');
  card.setAttribute('aria-label', view.title);

  const icon = document.createElement('span');
  icon.className = 'chat-turn-failure__icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.append(createIcon(ICONS[view.kind], { size: 15 }));

  const body = document.createElement('div');
  body.className = 'chat-turn-failure__body';
  const title = document.createElement('h3');
  title.className = 'chat-turn-failure__title';
  title.tabIndex = -1;
  title.textContent = view.title;
  const text = document.createElement('p');
  text.className = 'chat-turn-failure__text';
  text.textContent = view.body;
  body.append(title, text);

  const status = document.createElement('p');
  status.className = 'chat-turn-failure__status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');

  const actions = document.createElement('div');
  actions.className = 'chat-turn-failure__actions';
  const signInHost = document.createElement('div');
  signInHost.className = 'chat-turn-failure__sign-in';
  signInHost.hidden = true;

  const busyButtons: HTMLButtonElement[] = [];
  const setBusy = (busy: boolean) => { for (const button of busyButtons) button.disabled = busy; card.setAttribute('aria-busy', String(busy)); };
  const run = async (mode: RetryMode, label: string) => {
    const current = findChatById(chat.id);
    if (!current) return;
    setBusy(true);
    status.textContent = label;
    setSchedule(chat.id, null);
    try {
      await retryTurn(current, mode);
      status.textContent = '';
    } catch (error) {
      setBusy(false);
      status.textContent = error instanceof Error ? error.message : 'Could not retry. Try again.';
    }
  };

  const mode = defaultMode(chat, view.kind);
  const hasWork = failedTurnHasWork(chat);
  const primaryLabel = mode === 'continue' ? 'Continue' : view.kind === 'signed_out' || view.kind === 'usage_limit' ? 'Retry now' : 'Try again';
  const primary = actionButton(primaryLabel, {
    primary: view.kind !== 'signed_out',
    icon: 'refresh',
    title: mode === 'continue' ? 'Ask the agent to pick up from where the turn stopped' : 'Send your message again',
  });
  primary.addEventListener('click', () => void run(mode, mode === 'continue' ? 'Continuing…' : 'Retrying…'));
  busyButtons.push(primary);

  if (view.signIn) {
    const signIn = view.signIn;
    const signInButton = actionButton(`Sign in to ${signIn.label}`, { primary: true, icon: 'externalLink' });
    busyButtons.push(signInButton);
    let flow: { root: HTMLElement; start(): Promise<boolean>; dispose(): void } | undefined;
    const start = async () => {
      signInButton.disabled = true;
      try {
        if (!flow) {
          const { createAgentCliSignIn } = await import('./agent-cli-sign-in');
          flow = createAgentCliSignIn(signIn.kind, signIn.label, { retry: () => void start() });
          signInHost.append(flow.root);
        }
        signInHost.hidden = false;
        const ok = await flow.start();
        if (!card.isConnected) return;
        if (ok) {
          status.textContent = `Signed in to ${signIn.label}. Retry to continue.`;
          signInButton.hidden = true;
          primary.classList.add('chat-turn-failure__btn--primary');
          primary.focus({ preventScroll: true });
        }
      } catch {
        status.textContent = 'Could not open sign-in. Use Models → Subscriptions instead.';
      } finally {
        signInButton.disabled = false;
      }
    };
    signInButton.addEventListener('click', () => void start());
    actions.append(signInButton);
    disposers.set(card, () => flow?.dispose());
  }

  actions.append(primary);

  if (mode === 'continue' && hasWork && failedInputIndex(chat) >= 0) {
    const restart = actionButton('Start over', { title: 'Send your original message again and replace this turn' });
    restart.addEventListener('click', () => void run('replay', 'Retrying…'));
    busyButtons.push(restart);
    actions.append(restart);
  }

  const schedule = getSchedule(chat.id);
  const scheduled = schedule?.executionId === executionId ? schedule : undefined;
  if ((view.kind === 'usage_limit' || view.kind === 'rate_limit') && view.availableAt) {
    const at = view.availableAt;
    const when = at - Date.now() < 90 * 60_000 ? formatWait(at - Date.now()) : formatAvailableAt(at);
    const auto = actionButton(scheduled ? 'Cancel automatic retry' : `Retry automatically ${when}`, { icon: 'clock' });
    auto.setAttribute('aria-pressed', String(Boolean(scheduled)));
    auto.addEventListener('click', () => {
      const current = getSchedule(chat.id);
      if (current?.executionId === executionId) {
        setSchedule(chat.id, null);
        status.textContent = 'Automatic retry cancelled.';
      } else {
        setSchedule(chat.id, { executionId, at: at + RESET_SLACK_MS, mode, attempts: 0 });
        status.textContent = `Minnow will retry ${when}. Keep Minnow open.`;
      }
      refreshCard(chat.id, { focus: 'auto' });
    });
    auto.dataset.role = 'auto';
    actions.append(auto);
    if (scheduled) status.textContent = `Minnow will retry ${when}. Keep Minnow open.`;
  }

  if (view.settings) {
    const settings = actionButton(view.settings === 'clis' ? 'Manage subscriptions' : 'Open providers', { icon: 'settings' });
    settings.classList.add('chat-turn-failure__btn--quiet');
    settings.addEventListener('click', () => void import('../os/router').then(module => module.launchApp('models', { modelsSection: view.settings })));
    actions.append(settings);
  }

  body.append(actions, signInHost, status);

  if (view.detail && view.detail !== view.body) {
    const details = document.createElement('details');
    details.className = 'chat-turn-failure__details';
    const summary = document.createElement('summary');
    summary.textContent = 'Technical details';
    const pre = document.createElement('pre');
    pre.textContent = view.detail;
    details.append(summary, pre);
    body.append(details);
  }

  card.append(icon, body);
  return card;
}

function cardKey(chat: Chat, view: TurnFailureView): string {
  const execution = chat.agentExecution!;
  const schedule = getSchedule(chat.id);
  return JSON.stringify([execution.executionId, view.kind, view.availableAt ?? null, execution.error ?? '',
    schedule?.executionId === execution.executionId ? schedule.at : null, failedTurnHasWork(chat), chat.history.length]);
}

/** Should this chat show a failure card right now? */
export function shouldShowTurnFailure(chat: Chat): boolean {
  return chat.chatCommandVersion === 1 && chat.agentExecution?.status === 'failed' && !chat.agentPendingCommand && !isChatStreaming(chat.id);
}

const mounts = new Map<string, HTMLElement>();

function refreshCard(chatId: string, options: { focus?: 'auto' } = {}): void {
  const mount = mounts.get(chatId);
  const chat = findChatById(chatId);
  if (!mount?.isConnected || !chat) return;
  const focused = options.focus === 'auto';
  syncTurnFailureCard(chat, mount, { force: true });
  if (focused) mount.querySelector<HTMLElement>(':scope > .chat-turn-failure [data-role="auto"]')?.focus({ preventScroll: true });
}

/** A chained automatic retry that hit the limit again schedules the next check itself. */
function continueChain(chat: Chat, view: TurnFailureView): void {
  const attempts = pendingChains.get(chat.id);
  if (attempts === undefined) return;
  pendingChains.delete(chat.id);
  const executionId = chat.agentExecution!.executionId;
  if (attempts >= MAX_AUTO_ATTEMPTS || !view.availableAt || (view.kind !== 'usage_limit' && view.kind !== 'rate_limit')) return;
  if (getSchedule(chat.id)) return;
  setSchedule(chat.id, { executionId, at: view.availableAt + RESET_SLACK_MS, mode: defaultMode(chat, view.kind), attempts });
}

/**
 * Keep the card as the transcript's last row while the chat's latest
 * execution is failed; remove it as soon as new work starts.
 */
export function syncTurnFailureCard(chat: Chat, mount: HTMLElement, options: { force?: boolean } = {}): void {
  armSavedSchedules();
  let existing = mount.querySelector<HTMLElement>(':scope > .chat-turn-failure');
  // A reused transcript column never shows another chat's failure.
  if (existing && existing.dataset.chatId !== chat.id) { disposeCard(existing); existing.remove(); existing = null; }
  if (!shouldShowTurnFailure(chat)) {
    if (existing) { disposeCard(existing); existing.remove(); }
    if (mounts.get(chat.id) === mount) mounts.delete(chat.id);
    return;
  }
  mounts.set(chat.id, mount);
  const view = failureView(chat);
  continueChain(chat, view);
  const key = cardKey(chat, view);
  let card = existing;
  if (!card || card.dataset.chatId !== chat.id || card.dataset.key !== key || options.force) {
    const focusInside = Boolean(card?.contains(document.activeElement));
    const next = buildCard(chat, view);
    next.dataset.key = key;
    const status = card?.querySelector('.chat-turn-failure__status')?.textContent;
    if (status && card?.dataset.executionId === next.dataset.executionId) {
      const target = next.querySelector('.chat-turn-failure__status');
      if (target && !target.textContent) target.textContent = status;
    }
    if (card) { disposeCard(card); card.replaceWith(next); }
    card = next;
    if (focusInside) card.querySelector<HTMLElement>('.chat-turn-failure__title')?.focus({ preventScroll: true });
  }
  // Last transcript row: ahead of an inline requests host, after everything else.
  const anchor = mount.querySelector<HTMLElement>(':scope > .managed-chat-requests');
  if (anchor) { if (card.nextElementSibling !== anchor) anchor.before(card); }
  else if (mount.lastElementChild !== card) mount.append(card);
}

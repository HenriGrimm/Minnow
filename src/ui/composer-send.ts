import { showToast } from './toast';
import { shouldRelayChat } from '../chat/remote-chat-client';
import { streaming } from '../app-state';
import { getPendingAttachments } from '../attachments/store';
import { isChatTurnInProgress } from '../chat/chat-turn-guard';
import { enqueueSteerMessage } from '../chat/steer-message';
import { isChatWorktreeSetupPending } from '../state/chat-worktree';
import { enqueueComposerMessage } from '../chat/message-queue';
import { parseCompactSlashInput } from '../chat/context/parse-compact-command';
import { isPluginSlashCommand } from '../chat/slash-commands/registry';
import { isActiveChatStreaming } from '../chat/streaming-state';
import { stopGeneration } from '../chat/stop-generation';
import { getActiveChat, sessionState } from '../state/sessions';
import { chatLink, chatReadOnlyReason } from '../state/chat-relationships';
import { clearComposerAfterSend } from './composer-draft';
import { getActiveComposerSurface } from './composer-surface';
import { refreshModeSelectorDisabled } from './mode-selector';
import { isChatAppForeground } from './chat-mount';
import { syncBackgroundStreamHint } from './composer-stream-hint';
import { syncComposerWave } from './composer-wave';
import { syncGoalActiveHint } from './goal-active-hint';
import { syncLoopActiveHint } from './loop-active-hint';
import { syncFollowupActiveHint } from './followup-active-hint';
import { syncTodoPanel } from './todo-panel';
import {
  syncComposerFollowUpPlaceholder,
  syncComposerMessageQueue,
} from './composer-message-queue';

export type ComposerStreamingMode = 'idle' | 'streaming';

let recoveryBlocked = false;
let chatMessagingPromise: Promise<typeof import('../chat/messaging')> | null = null;

/** Warm the first-send chunk while the user is composing instead of after Send. */
function loadChatMessaging(): Promise<typeof import('../chat/messaging')> {
  if (!chatMessagingPromise) {
    chatMessagingPromise = import('../chat/messaging').catch((error: unknown) => {
      chatMessagingPromise = null;
      throw error;
    });
  }
  return chatMessagingPromise;
}

export function preloadChatMessaging(): void {
  void loadChatMessaging().catch(() => {});
}

// ── Recovery ─────────────────────────────────────────────────────────────────

/** Block composer send while Continue / Discard banner is visible. */
export function setComposerRecoveryBlocked(blocked: boolean): void {
  recoveryBlocked = blocked;
  const { sendBtnEl: sendBtn, inputEl: input } = getActiveComposerSurface();
  if (sendBtn && !isActiveChatStreaming()) {
    sendBtn.disabled = blocked;
  }
  if (input) {
    input.disabled = blocked;
  }
  syncComposerReadOnlyState();
  refreshModeSelectorDisabled();
  void import('./view-mode-toggle').then((m) => m.refreshViewModeToggleDisabled());
}

export function isComposerRecoveryBlocked(): boolean {
  return recoveryBlocked || Boolean(sessionState && chatReadOnlyReason(getActiveChat()));
}

/** The same composer travels with Code, Issues and Home chat mounts. */
export function syncComposerReadOnlyState(): boolean {
  const { inputEl: input, sendBtnEl: sendBtn } = getActiveComposerSurface();
  const chat = sessionState ? getActiveChat() : undefined;
  const reason = chat && chatReadOnlyReason(chat);
  for (const id of ['btnComposerMic', 'btnChatAppMic', 'btnDesktopMic', 'btnChatAppAttach', 'btnDesktopAttach', 'fileInput']) {
    const control = document.getElementById(id) as HTMLButtonElement | HTMLInputElement | null;
    if (!control) continue;
    const mayStopDictation = control.classList.contains('composer-mic-btn--recording');
    if (reason && !mayStopDictation) {
      if (control.dataset.chatReadOnlyDisabled === undefined) control.dataset.chatReadOnlyDisabled = String(control.disabled);
      control.disabled = true;
    } else if (control.dataset.chatReadOnlyDisabled !== undefined) {
      control.disabled = control.dataset.chatReadOnlyDisabled === 'true'; delete control.dataset.chatReadOnlyDisabled;
    }
  }
  let notice = document.getElementById('chatReadOnlyNotice');
  if (!reason || !chat || !input) {
    notice?.remove();
    if (input) {
      const ids = input.getAttribute('aria-describedby')?.split(/\s+/).filter(id => id !== 'chatReadOnlyNotice') ?? [];
      if (ids.length) input.setAttribute('aria-describedby', ids.join(' ')); else input.removeAttribute('aria-describedby');
    }
    return false;
  }
  if (!notice) { notice = document.createElement('div'); notice.id = 'chatReadOnlyNotice'; notice.className = 'chat-read-only-notice'; notice.setAttribute('role', 'status'); }
  const key = `${chat.id}:${reason}:${chat.agentConversation?.parentChatId ?? ''}`;
  if (notice.dataset.chatNotice !== key) {
    notice.dataset.chatNotice = key; notice.replaceChildren();
    const label = document.createElement('span'); label.textContent = `Inspect only. ${reason}`; notice.append(label);
    if (chat.agentConversation?.parentChatId) {
      const link = document.createElement('a'); link.href = chatLink(chat.agentConversation.parentChatId); link.textContent = 'Open parent';
      link.addEventListener('click', event => {
        event.preventDefault(); void import('../os/chat-launch').then(module => module.launchCodeWithChat(chat.agentConversation!.parentChatId!));
      });
      notice.append(link);
    }
  }
  const anchor = input.closest('.input-row, .chat-app-input, .mn-os-desktop-input-row') ?? input;
  if (notice.nextSibling !== anchor) anchor.before(notice);
  const descriptions = new Set(input.getAttribute('aria-describedby')?.split(/\s+/).filter(Boolean) ?? []);
  descriptions.add(notice.id); input.setAttribute('aria-describedby', [...descriptions].join(' '));
  input.disabled = true;
  if (sendBtn) {
    sendBtn.disabled = true; sendBtn.dataset.mode = 'inspect'; sendBtn.setAttribute('aria-busy', 'false');
    sendBtn.setAttribute('aria-label', 'Inspect-only conversation'); sendBtn.title = reason; sendBtn.classList.remove('send-btn--stop');
  }
  return true;
}

/** True when Send/Enter should run (send, steer, or stop) on the active composer. */
export function shouldAllowComposerPrimaryAction(inputText: string): boolean {
  return Boolean(inputText.trim()) || isActiveChatStreaming();
}

/** Empty Enter is never Stop; attachment-only sends are available when idle. */
export function shouldSubmitComposerOnEnter(inputText: string): boolean {
  if (inputText.trim()) return true;
  return getPendingAttachments().length > 0 && !(sessionState && isChatTurnInProgress(getActiveChat().id));
}

function composerInputHasText(): boolean {
  return Boolean(getActiveComposerSurface().inputEl?.value.trim());
}

// ── Streaming ────────────────────────────────────────────────────────────────

/** Update primary button label during streaming from composer text (steer vs stop). */
export function refreshComposerStreamingAffordance(): void {
  const sendBtn = getActiveComposerSurface().sendBtnEl;
  if (!sendBtn || (sendBtn.dataset.mode !== 'stop' && !(sessionState && isChatTurnInProgress(getActiveChat().id)))) return;

  const hasText = composerInputHasText();
  sendBtn.setAttribute(
    'aria-label',
    hasText ? 'Steer current run' : 'Stop generating',
  );
  sendBtn.title = hasText ? 'Steer current run (Enter)' : 'Stop generating';
  sendBtn.dataset.steerReady = hasText ? 'true' : 'false';
  sendBtn.classList.toggle('send-btn--stop', !hasText);
  document.getElementById('sendIcon')?.classList.toggle('hidden', !hasText);
  document.getElementById('sendStopIcon')?.classList.toggle('hidden', hasText);
}

/** Show or hide the Chat app dedicated stop control (#btnChatAppStop). */
function syncChatAppStopButton(streaming: boolean): void {
  const stopBtn = document.getElementById('btnChatAppStop') as HTMLButtonElement | null;
  if (!stopBtn) return;
  stopBtn.hidden = !streaming;
  stopBtn.classList.toggle('hidden', !streaming);
  stopBtn.disabled = !streaming;
}

/** Toggle send vs stop affordance on the composer primary button. */
export function setComposerStreamingMode(mode: ComposerStreamingMode): void {
  syncComposerWave();
  if (getActiveComposerSurface().onPrimaryAction) return;
  if (syncComposerReadOnlyState()) { syncChatAppStopButton(false); return; }
  const { sendBtnEl: sendBtn, inputEl: input } = getActiveComposerSurface();
  if (!sendBtn) return;

  const isStreaming = mode === 'streaming';
  const chatApp = isChatAppForeground() && !false;

  if (chatApp) {
    if (chatApp) syncChatAppStopButton(isStreaming);
    sendBtn.disabled = isStreaming ? false : recoveryBlocked;
    sendBtn.setAttribute('aria-busy', isStreaming ? 'true' : 'false');
    sendBtn.dataset.mode = 'send';
    sendBtn.classList.remove('send-btn--stop');
    sendBtn.removeAttribute('data-steer-ready');
    sendBtn.setAttribute('aria-label', 'Send message');
    if (isStreaming) refreshComposerStreamingAffordance();
    if (input) input.disabled = recoveryBlocked;
    syncDesktopComposerFishSwim();
    return;
  }

  const sendIcon = document.getElementById('sendIcon');
  const sendStopIcon = document.getElementById('sendStopIcon');
  const sendSpinner = document.getElementById('sendSpinner');

  sendBtn.disabled = false;
  sendBtn.setAttribute('aria-busy', isStreaming ? 'true' : 'false');
  sendBtn.dataset.mode = isStreaming ? 'stop' : 'send';
  sendBtn.classList.toggle('send-btn--stop', isStreaming);
  if (!isStreaming) {
    sendBtn.removeAttribute('data-steer-ready');
    sendBtn.setAttribute('aria-label', 'Send message');
    sendBtn.title = 'Send message (Enter)';
  } else {
    refreshComposerStreamingAffordance();
  }

  sendIcon?.classList.toggle('hidden', isStreaming && !composerInputHasText());
  sendStopIcon?.classList.toggle('hidden', !isStreaming || composerInputHasText());
  sendSpinner?.classList.add('hidden');

  if (input) {
    input.disabled = recoveryBlocked;
  }
  if (sendBtn && !isStreaming) {
    sendBtn.disabled = recoveryBlocked;
  }

  syncDesktopComposerFishSwim();
}

/** Swim the desktop send fish while the active chat is streaming. */
export function syncDesktopComposerFishSwim(): void {
  const composer = document.getElementById('desktopComposerRoot');
  const sendBtn = document.getElementById('desktopSendBtn');
  if (!composer) return;

  const swimming = isActiveChatStreaming();
  composer.classList.toggle('is-streaming', swimming);
  sendBtn?.setAttribute('aria-busy', swimming ? 'true' : 'false');
}

/** Align send/stop button and background-stream hint with active vs streaming chat. */
export function syncComposerFromStreamingState(): void {
  const busy = Boolean(sessionState && isChatTurnInProgress(getActiveChat().id));
  setComposerStreamingMode(busy ? 'streaming' : 'idle');
  refreshModeSelectorDisabled();
  syncDesktopComposerFishSwim();
  syncBackgroundStreamHint();
  syncComposerMessageQueue();
  syncComposerFollowUpPlaceholder(busy);
  syncGoalActiveHint();
  syncLoopActiveHint();
  syncFollowupActiveHint();
  syncTodoPanel();
  if (!sessionState) return;
  if (isChatWorktreeSetupPending(getActiveChat().id)) {
    const { inputEl, sendBtnEl } = getActiveComposerSurface();
    if (inputEl) inputEl.disabled = true;
    if (sendBtnEl) {
      sendBtnEl.disabled = true;
      sendBtnEl.setAttribute('aria-busy', 'true');
      sendBtnEl.setAttribute('aria-label', 'Setting up worktree');
    }
  }
  void import('./composer-run-target').then((m) => {
    if (!sessionState) return;
    m.refreshComposerRunTargetDisabled();
  });
  void import('./composer-undo').then((m) => {
    if (!sessionState) return;
    m.refreshComposerUndoDisabled();
  });
}

// ── Send ─────────────────────────────────────────────────────────────────────

export function submitComposerFollowup(delivery: 'steer' | 'queue' = 'steer'): void {
  if (sessionState && chatReadOnlyReason(getActiveChat())) { showToast(chatReadOnlyReason(getActiveChat())!); return; }
  const input = getActiveComposerSurface().inputEl;
  const text = input?.value.trim() ?? '';
  if (!text) return;
  const chat = getActiveChat();
  if (shouldRelayChat(chat.id) || !isChatTurnInProgress(chat.id) || isPluginSlashCommand(text) || /^\/followup(?:\s|$)/i.test(text)) {
    void loadChatMessaging().then(m => m.sendMessageWithTools({ followupDelivery: delivery }));
    return;
  }
  const attachments = getPendingAttachments();
  if (attachments.some(a => a.pendingRead)) {
    showToast('Still reading attached files. Wait for them to finish or remove them.');
    return;
  }
  if (attachments.some(a => a.kind !== 'error')) {
    showToast('Wait for this reply to finish before sending attachments. Your draft is kept.');
    return;
  }
  const queue = delivery === 'queue' || Boolean(parseCompactSlashInput(text));
  if (!(queue ? enqueueComposerMessage : enqueueSteerMessage)(chat, text)) return;
  clearComposerAfterSend(chat, input);
  if (parseCompactSlashInput(text)) showToast('Compaction queued for after this reply');
  refreshComposerStreamingAffordance();
  syncComposerMessageQueue();
}

/** Send when idle; steer with text during a turn; an empty primary button always stops. */
export function handleComposerPrimaryAction(): void {
  if (sessionState && chatReadOnlyReason(getActiveChat())) { showToast(chatReadOnlyReason(getActiveChat())!); return; }
  if (sessionState && shouldRelayChat(getActiveChat().id)) {
    if (composerInputHasText() || !isActiveChatStreaming()) void loadChatMessaging().then(m => m.sendMessage());
    else stopGeneration();
    return;
  }
  if (sessionState && isChatWorktreeSetupPending(getActiveChat().id)) return;
  const scopedAction = getActiveComposerSurface().onPrimaryAction;
  if (scopedAction) { scopedAction(); return; }
  if (isPluginSlashCommand(getActiveComposerSurface().inputEl?.value ?? '')) {
    void loadChatMessaging().then(m => m.sendMessage());
    return;
  }
  if (sessionState && isChatTurnInProgress(getActiveChat().id)) {
    if (composerInputHasText()) {
      submitComposerFollowup();
      return;
    }
    stopGeneration();
    return;
  }
  void loadChatMessaging().then((m) => m.sendMessage());
}

/** Wire composer input listener for streaming steer/stop aria labels (call once per textarea). */
export function initComposerSteerInputListener(inputEl?: HTMLTextAreaElement | null): void {
  const input = inputEl ?? getActiveComposerSurface().inputEl;
  if (!input || input.dataset.steerListener === '1') return;
  input.dataset.steerListener = '1';
  input.addEventListener('focus', preloadChatMessaging, { once: true });
  input.addEventListener('input', () => {
    preloadChatMessaging();
    if (streaming || (sessionState && isChatTurnInProgress(getActiveChat().id))) refreshComposerStreamingAffordance();
  });
}

/** @deprecated Use {@link setComposerStreamingMode} — maps loading flag to idle/streaming. */
export function setSendLoading(loading: boolean): void {
  setComposerStreamingMode(loading ? 'streaming' : 'idle');
}

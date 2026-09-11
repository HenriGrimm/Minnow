import { takeChatStopReason } from '../app-state';
import {
  GENERATION_LOST_ON_RESTART_MESSAGE,
  GenerationNotFoundError,
  formatGenerationErrorMessage,
} from '../api/generations';
import { reportBackgroundError } from '../boot/report-background-error';
import {
  recordChatMessage,
  scheduleSaveSessions,
  touchChat,
} from '../state/sessions';
import { findRunById, noteRunOutputIndex } from '../state/runs-store';
import { isBoardTaskChat } from '../state/chat-groups';
import { markChatTurnError, recordAssistantReplyOnChat } from '../ui/chat-item-dot';
import { renderSidebar } from '../ui/sidebar';
import { setStatus } from '../ui/status';
import { completeStreamAnnouncer } from '../ui/a11y/stream-announcer';
import { markMessageFailed, markMessageStopped } from '../ui/stopped-affordance';
import {
  appendBubble,
  paintStoppedRowFromHistory,
  removeOrphanStreamingRow,
  renderChatFromHistory,
  revealAssistantProseBubble,
  setAssistantErrorBubbleWithRecovery,
} from '../ui/messages';
import {
  cancelAssistantBubbleRenderDebounce,
  finishStreamingBubbleRender,
  setAssistantBubbleContent,
} from '../markdown/renderer';
import type { StreamingStatusHandle } from '../ui/stream-status';
import type { ThoughtBubbleController } from '../ui/thought-bubbles';
import {
  resolveFailedTurnPartialRow,
  resolveFinalAssistantContent,
} from '../tools/turn-continuation';
import {
  repairSessionHistoryTail,
  rollbackFailedTurnHistory,
  turnProducedOutput,
} from './history';
import { clearPendingSteer } from './steer-message';
import { isStreamDomVisible } from './streaming-state';
import { resolveForkHistoryIndex } from './turn-snapshot';
import type { ChatTurnEventPainter } from './run-turn-chat-paint';
import type { TranscriptMessage, TranscriptStore } from '../../server/runner/transcript-store';
import type { TurnResult } from '../../server/runner/run-turn';
import type {
  AssistantMessage,
  AssistantToolCallMessage,
  Chat,
  ChatStopReason,
  TurnRunId,
} from '../types';

/** Decorating store plus the abort hook for the in-store thinking timer. */
export interface InterruptedTurnStore extends TranscriptStore {
  /** Guarded: P10-F owns live timer UI; the store tracker still needs a tick stop. */
  abortThinking?: () => void;
}

/** Live stream chrome the settle paths paint into. Undefined when setup threw first. */
export interface InterruptedTurnChrome {
  chat: Chat;
  wrap?: HTMLElement;
  bubble?: HTMLElement;
  cursor?: HTMLElement;
  streamStatus?: StreamingStatusHandle;
  thoughtController: ThoughtBubbleController | null;
  painter?: ChatTurnEventPainter;
  store?: InterruptedTurnStore;
  turnRunId?: TurnRunId;
  pushUser: boolean;
}

export interface SettleStoppedResult {
  stopReason: ChatStopReason;
}

export interface SettleFailedResult {
  errorMessage: string;
  generationLost: boolean;
  rolledBack: boolean;
  preservedTurnOutput: boolean;
}

// ── Predicates ───────────────────────────────────────────────────────────────

/** User Stop / abort: `runTurn` maps this to a returned crashed outcome, not a throw. */
export function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const name = (err as { name?: string }).name;
  return name === 'AbortError';
}

export function isAbortedTurnResult(
  result: TurnResult,
  signal?: AbortSignal | null,
): boolean {
  if (signal?.aborted) return true;
  if (result.outcome !== 'crashed') return false;
  return result.error === 'aborted';
}

/** Provider crash / runner timeout — not Stop. */
export function isFailedTurnResult(result: TurnResult): boolean {
  return result.outcome === 'crashed' || result.outcome === 'timeout';
}

/** Server-kill / evicted generation: nothing streamed on this client. */
export function isGenerationLostMessage(message: string | undefined): boolean {
  const trimmed = message?.trim() ?? '';
  if (!trimmed) return false;
  return (
    trimmed === GENERATION_LOST_ON_RESTART_MESSAGE ||
    trimmed === 'Generation not found'
  );
}

export function isGenerationLostError(err: unknown): boolean {
  if (err instanceof GenerationNotFoundError) return true;
  const message = err instanceof Error ? err.message : String(err);
  return isGenerationLostMessage(message);
}

/** Live streamed prose (painter is cumulative snapshots, not per-token). */
export function livePartialTextFromPainter(
  painter: ChatTurnEventPainter | undefined,
): string {
  painter?.flush();
  return painter?.snapshot().lastDelta ?? '';
}

function thinkingFromController(
  thoughtController: ThoughtBubbleController | null,
): string[] {
  return thoughtController?.getSegmentsNormalized() ?? [];
}

function appendInterruptedAssistantRow(
  chat: Chat,
  store: InterruptedTurnStore | undefined,
  turnRunId: TurnRunId | undefined,
  row: AssistantMessage,
): void {
  if (store) {
    store.append(chat.id, row as unknown as TranscriptMessage);
  } else {
    chat.history.push(row);
    if (turnRunId) {
      noteRunOutputIndex(chat, turnRunId, chat.history.length - 1);
    }
    recordChatMessage(chat);
    scheduleSaveSessions();
  }
  recordAssistantReplyOnChat(chat);
}

// ── Persist ──────────────────────────────────────────────────────────────────

export function persistStoppedTurnPartial(params: {
  chat: Chat;
  store?: InterruptedTurnStore;
  turnRunId?: TurnRunId;
  partialText: string;
  thinking: string[];
}): boolean {
  const text = params.partialText.trim();
  const thinking = params.thinking.filter((seg) => seg.trim().length > 0);
  if (!text && thinking.length === 0) return false;
  const { content } = resolveFinalAssistantContent(text, thinking);
  const row: AssistantMessage = {
    role: 'assistant',
    content,
    stopped: true,
  };
  if (thinking.length > 0) row.thinking = thinking;
  appendInterruptedAssistantRow(params.chat, params.store, params.turnRunId, row);
  return true;
}

/**
 * Stop that lands after the round closed (mid tool batch) has no partial to write:
 * `round_end` already drained the painter and the thought controller. Flag the
 * assistant row that owns the interrupted work so the stop survives a reload.
 *
 * @returns the flagged history index, or -1 when the tail holds no assistant row.
 */
export function markInterruptedAssistantRowStopped(chat: Chat): number {
  for (let i = chat.history.length - 1; i >= 0; i -= 1) {
    const row = chat.history[i];
    if (row.role === 'user') return -1;
    if (row.role !== 'assistant') continue;
    const assistant = row as AssistantMessage | AssistantToolCallMessage;
    if (assistant.stopped !== true) {
      assistant.stopped = true;
      recordChatMessage(chat);
      scheduleSaveSessions();
    }
    return i;
  }
  return -1;
}

export function persistFailedTurnPartial(params: {
  chat: Chat;
  store?: InterruptedTurnStore;
  turnRunId?: TurnRunId;
  skip: boolean;
  partialText: string;
  thinking: string[];
}): boolean {
  if (params.skip) return false;
  const row = resolveFailedTurnPartialRow({
    partialText: params.partialText,
    thinking: params.thinking,
  });
  if (!row) return false;
  appendInterruptedAssistantRow(params.chat, params.store, params.turnRunId, row);
  return true;
}

function tearDownLiveStreamChrome(chrome: InterruptedTurnChrome): void {
  chrome.store?.abortThinking?.();
  chrome.streamStatus?.setThinkingElapsed(null);
  cancelAssistantBubbleRenderDebounce(chrome.bubble);
  if (chrome.bubble) {
    finishStreamingBubbleRender(chrome.bubble, chrome.cursor);
  }
}

// ── Settle ───────────────────────────────────────────────────────────────────

export function settleStoppedTurn(chrome: InterruptedTurnChrome): SettleStoppedResult {
  const { chat } = chrome;
  clearPendingSteer(chat);
  const stopReason = takeChatStopReason(chat.id);

  const text = livePartialTextFromPainter(chrome.painter).trim();
  const thinking = thinkingFromController(chrome.thoughtController);

  tearDownLiveStreamChrome(chrome);
  chrome.thoughtController?.abort();

  if (stopReason !== 'system') {
    chat.currentGenerationId = undefined;
  }
  touchChat(chat);
  scheduleSaveSessions();

  const wrap = chrome.wrap;
  const bubble = chrome.bubble;
  const wrapConnected = Boolean(wrap?.isConnected);

  if (text && wrapConnected && wrap && bubble) {
    wrap.classList.remove('msg--awaiting-prose');
    bubble.classList.remove('msg-bubble--awaiting');
    setAssistantBubbleContent(bubble, text, {
      streaming: false,
      modeId: chat.modeId,
    });
    completeStreamAnnouncer(text);
    markMessageStopped(wrap);
  } else if (wrapConnected && wrap?.classList.contains('msg--awaiting-prose')) {
    removeOrphanStreamingRow(wrap, chrome.streamStatus);
  }

  const persistedPartial = persistStoppedTurnPartial({
    chat,
    store: chrome.store,
    turnRunId: chrome.turnRunId,
    partialText: text,
    thinking,
  });
  if (!persistedPartial) {
    const markedIndex = markInterruptedAssistantRowStopped(chat);
    if (markedIndex >= 0 && isStreamDomVisible(chat.id)) {
      paintStoppedRowFromHistory(markedIndex);
    }
  }

  chrome.streamStatus?.dispose();
  if (isStreamDomVisible(chat.id)) {
    setStatus('ok', 'Stopped');
  }
  return { stopReason };
}

/**
 * Provider / generation-lost failure: persist the partial, then three-way triage.
 */
export function settleFailedTurn(
  chrome: InterruptedTurnChrome,
  err: unknown,
): SettleFailedResult {
  const { chat } = chrome;
  markChatTurnError(chat);

  const rawMessage =
    err instanceof Error
      ? err.message
      : typeof err === 'string'
        ? err
        : String(err);
  const generationLost = isGenerationLostError(err) || isGenerationLostMessage(rawMessage);
  const lostCopy = generationLost
    ? GENERATION_LOST_ON_RESTART_MESSAGE
    : `Could not complete this reply: ${formatGenerationErrorMessage(rawMessage || 'Unknown error')}`;

  const text = livePartialTextFromPainter(chrome.painter);
  const thinking = thinkingFromController(chrome.thoughtController);

  tearDownLiveStreamChrome(chrome);
  chrome.thoughtController?.abort();

  chat.currentGenerationId = undefined;
  touchChat(chat);
  scheduleSaveSessions();

  const failedRun = chrome.turnRunId ? findRunById(chat, chrome.turnRunId) : undefined;
  const failedForkIndex =
    failedRun?.forkHistoryIndex ?? resolveForkHistoryIndex(chat, chrome.pushUser);

  persistFailedTurnPartial({
    chat,
    store: chrome.store,
    turnRunId: chrome.turnRunId,
    skip: generationLost,
    partialText: text,
    thinking,
  });

  let rolledBack = false;
  let preservedTurnOutput = false;

  if (generationLost) {
    preservedTurnOutput = true;
    if (repairSessionHistoryTail(chat)) {
      recordChatMessage(chat);
      scheduleSaveSessions();
      renderSidebar();
    }
    if (isStreamDomVisible(chat.id)) {
      if (chrome.wrap) removeOrphanStreamingRow(chrome.wrap, chrome.streamStatus);
      renderChatFromHistory(chat);
    }
  } else if (isBoardTaskChat(chat)) {
    const repaired = repairSessionHistoryTail(chat);
    if (repaired) {
      recordChatMessage(chat);
      scheduleSaveSessions();
      renderSidebar();
      if (isStreamDomVisible(chat.id)) {
        renderChatFromHistory(chat);
      }
    }
  } else if (turnProducedOutput(chat.history, failedForkIndex)) {
    preservedTurnOutput = true;
    repairSessionHistoryTail(chat);
    recordChatMessage(chat);
    scheduleSaveSessions();
    renderSidebar();
    if (isStreamDomVisible(chat.id)) {
      if (chrome.wrap) removeOrphanStreamingRow(chrome.wrap, chrome.streamStatus);
      renderChatFromHistory(chat);
    }
  } else {
    rolledBack = rollbackFailedTurnHistory(chat, failedForkIndex);
    if (rolledBack) {
      recordChatMessage(chat);
      scheduleSaveSessions();
      renderSidebar();
      if (isStreamDomVisible(chat.id)) {
        renderChatFromHistory(chat);
      }
    }
  }

  if (failedRun) {
    failedRun.status = 'failed';
    failedRun.errorMessage = lostCopy;
  }

  void Promise.resolve()
    .then(() => reportBackgroundError('chat-turn-failed', err))
    .catch(() => {
    });

  if (isStreamDomVisible(chat.id)) {
    const wrap = chrome.wrap;
    const bubble = chrome.bubble;
    if (!rolledBack) {
      if (preservedTurnOutput) {
        const { bubble: errorBubble } = appendBubble('assistant', '', {
          historyIndex: chat.history.length,
          turnKind: 'assistant',
          chatId: chat.id,
          modeId: chat.modeId,
        });
        setAssistantErrorBubbleWithRecovery(errorBubble, lostCopy, {
          chatId: chat.id,
          forkHistoryIndex: failedForkIndex,
        });
      } else if (bubble) {
        if (wrap) {
          revealAssistantProseBubble(wrap, bubble, chrome.streamStatus);
          markMessageFailed(wrap);
        }
        setAssistantErrorBubbleWithRecovery(bubble as HTMLDivElement, lostCopy, {
          chatId: chat.id,
          forkHistoryIndex: failedForkIndex,
        });
      }
    }
    const statusMsg =
      rawMessage.length > 48 ? `${rawMessage.slice(0, 45)}…` : rawMessage;
    setStatus('err', rolledBack ? lostCopy : statusMsg || lostCopy);
  } else {
    const statusMsg = lostCopy.length > 80 ? `${lostCopy.slice(0, 77)}…` : lostCopy;
    setStatus('err', statusMsg);
  }

  chrome.streamStatus?.dispose();
  return {
    errorMessage: lostCopy,
    generationLost,
    rolledBack,
    preservedTurnOutput,
  };
}

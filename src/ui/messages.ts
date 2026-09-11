import { isHubMounted, renderHub, refreshHubLiveData, teardownHub } from './hub';
import { isOrchestrateHubMounted, teardownOrchestrateHub } from './orchestrate-hub';
import { teardownCodeBrainMapBeforeChatPaint } from './code-brain-map';
import { teardownIssuesEmbedBeforeChatPaint } from './issues-page';
import {
  isMainColumnOverlaySuppressingChatDom,
  stripMainColumnOverlayClasses,
} from './main-column-overlay';
import {
  getOrchestratePlanScreenSession,
  isOrchestratePlanScreenMounted,
  isOrchestratePlanScreenSessionActive,
  isOrchestratePlanScreenSuppressingChatDom,
  isOrchestratePlanScreenSuspendedForChat,
  isSuperPlanScreenMountedForOtherChat,
  isSuperPlanScreenShowingChat,
  removeOrchestratePlanScreenSuspendedBanner,
  reopenSuperPlanScreenForChat,
  restoreOrchestratePlanScreenSessionFromChat,
  showOrchestratePlanScreenSuspendedBanner,
  teardownOrchestratePlanScreen,
  teardownOrchestratePlanScreenDom,
} from './orchestrate-plan-screen';
import { extractInlineThinkingFromContent } from '../api/inline-thinking';
import { apiMessageContentToText } from '../api/message-content';
import { normalizeModeId } from '../chat/modes/types';
import { isHiddenTranscriptUserMessage } from '../chat/hidden-transcript-user-messages';
import {
  contextNoticeAction,
  contextNoticeOutcome,
} from '../chat/context/context-notice';
import {
  injectionNoticeAction,
  injectionNoticeOutcome,
} from '../chat/context/injection-notice';
import type {
  ContextNoticeMessage,
  InjectionNoticeMessage,
  PromptInjectionKind,
} from '../types';
import { createIcon, type IconName } from './icon';
import { resolveModelInfo, showCachedModelInfo } from '../api/models';
import { isActiveChatStreaming, isChatStreaming, isStreamDomVisible } from '../chat/streaming-state';
import { STREAMING_CARET_CLASS, STREAMING_CARET_SELECTOR, setAssistantBubbleContent } from '../markdown/renderer';
import { syncComposerMessageQueue } from './composer-message-queue';
import {
  getActiveBoardGroup,
  getBoardGroupForChat,
  isBoardOwnedChat,
} from '../state/chat-groups';
import {
  isBoardChatEmbedOpenForChat,
  queryBoardChatTranscriptHost,
} from './orchestrate-board-chat-state';
import {
  clearActiveGoal,
  clearActiveLoops,
  clearChatTodos,
  getActiveChat,
  touchChat,
  scheduleSaveSessions,
} from '../state/sessions';
import type {
  AssistantToolCallMessage,
  AssistantMessage,
  Chat,
  Message,
  ModelInfo,
  Stats,
  ToolResultMessage,
  Usage,
} from '../types';
import {
  captureChatScrollAnchor,
  getChatScrollRoot,
  restoreChatScrollAnchor,
  scrollChatIfPinned,
  scrollChatToBottom,
} from './chat-scroll';
import {
  appendChatTranscriptNode,
  getActiveChatMountElement,
  isChatAppForeground,
  isCodeChatMount,
  resolveChatMount,
  runWithChatMount,
} from './chat-mount';
import { dismissCodeOverviewForNavigation } from './code-overview';
import { dismissDevServerScreenForNavigation } from './dev-server-screen';
import { isBoardViewActive, syncBoardViewChrome } from './view-mode-toggle';
import { closeDrawer } from './settings';
import { appConfirm } from './app-dialog';
import { setStatus } from './status';
import { refreshMetricsStripForChat } from './stats';
import { refreshContextUsageRing } from './context-usage-ring';
import { resetCodeChangeTotals, recomputeWorkspaceCodeChangeTotals } from '../usage/code-change-ledger';
import { normalizeUsageTotals } from '../usage/pricing';
import { formatStatCount } from '../usage/format-stat-count';
import { sessionState } from '../state/sessions';
import { updateWorkspaceCodeChangeDisplay } from './workspace-code-change';
import { resetTokenLedger } from '../usage/token-ledger';
import { updateCodeChangeStrip } from './code-change-strip';
import { renderSidebar } from './sidebar';
import { syncTodoPanel } from './todo-panel';
import { renderThoughtsToggle, syncThoughtsCaretPulse } from './thought-bubbles';
import { renderToolCall, renderToolResult } from './tool-messages';
import { attachShellKillUi } from './shell-run-ui';
import {
  createStoppedMarkerRow,
  markMessageFailed,
  markMessageStopped,
} from './stopped-affordance';
import { markMessageTruncated } from './truncated-affordance';
import { appendFailedTurnRecoveryActions } from './failed-turn-recovery-actions';
import { indexOfLastFailedAssistantAtTail } from '../chat/history';
import { indexOfUserBeforeBlock } from '../chat/history-truncate-core';
import { markMessageSteered } from './steer-affordance';
import { restoreGoalAchievedAffordance } from './goal-affordance';
import {
  clearSubAgentCardDomRegistry,
  renderPersistedSubAgentCardsForChat,
} from './sub-agent-cards';
import {
  attachStreamStatus,
  type StreamingStatusHandle,
  type StreamPhase,
} from './stream-status';
import {
  beginStreamAnnouncer,
  cancelStreamAnnouncer,
  completeStreamAnnouncer,
} from './a11y/stream-announcer';
import {
  attachMessageActions,
  type MessageTurnKind,
} from './message-actions';
import { attachVoicePlayButton } from './voice-controls';
import { attachBranchPicker } from './branch-picker';
import {
  renderUserMessageBubble,
  type UserBubbleRenderOptions,
} from './user-message-bubble';
import { getBeforeAfterPairs } from '../design/before-after-integration';
import { renderBeforeAfterCard } from '../design/before-after-card';
import { disposeChatWorkView, installChatWorkView } from './chat-work';

// ── Pending ──────────────────────────────────────────────────────────────────

/** Parse stored tool `arguments` JSON for display in the args <details> block. */
function parseToolArgsForDisplay(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  if (!trimmed) return {};
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { value: parsed };
  } catch {
    return { _raw: raw };
  }
}

function isAssistantToolCallMessage(msg: Message): msg is AssistantToolCallMessage {
  return (
    msg.role === 'assistant' &&
    'tool_calls' in msg &&
    Array.isArray((msg as AssistantToolCallMessage).tool_calls) &&
    (msg as AssistantToolCallMessage).tool_calls.length > 0
  );
}

export { resolveModelInfo, showCachedModelInfo } from '../api/models';

/** Suppress per-bubble scroll while bulk-rendering history (renderChatFromHistory). */
let suppressBubbleScroll = false;

/** Remove landing placeholders before the first live bubble mounts. */
function clearTranscriptEmptyState(mount: HTMLElement): void {
  document.getElementById('emptyState')?.remove();
  for (const el of mount.querySelectorAll(
    '.mn-os-chat-empty, .chat-app-empty, .chat-history-pending',
  )) {
    el.remove();
  }
}

/** Lightweight skeleton rows while lazy history is still in flight on chat switch. */
function buildChatHistoryPendingMarker(): HTMLElement {
  const root = document.createElement('div');
  root.className = 'chat-history-pending';
  root.setAttribute('aria-busy', 'true');
  root.setAttribute('aria-label', 'Loading chat messages');
  for (let i = 0; i < 3; i++) {
    const row = document.createElement('div');
    row.className = 'chat-history-pending__row';
    row.style.setProperty('--chat-history-pending-w', `${76 - i * 10}%`);
    root.appendChild(row);
  }
  return root;
}

/** Clear the transcript mount and show a pending marker synchronously so a switch never leaves another chat's bubbles visible during the history GET. */
export function paintChatTranscriptHistoryPending(mount?: string | HTMLElement): void {
  const boardChatHost =
    mount == null && isBoardChatEmbedOpenForChat(getActiveChat().id)
      ? queryBoardChatTranscriptHost()
      : null;
  const area = boardChatHost ?? resolveChatMount(mount);
  disposeChatWorkView(area);
  const codeMount = boardChatHost != null || isCodeChatMount(mount);

  if (codeMount && !boardChatHost && isMainColumnOverlaySuppressingChatDom()) {
    return;
  }

  const boardGroup = codeMount && !boardChatHost ? getActiveBoardGroup() : null;
  if (boardGroup?.viewMode === 'board') {
    return;
  }

  cancelChatHistoryBackfill();
  runWithChatMount(area, () => {
    clearSubAgentCardDomRegistry();
    clearTranscriptEmptyState(area);
    area.classList.remove('chat-area--hub');
    area.replaceChildren(buildChatHistoryPendingMarker());
  });
}

/** Route pending transcript paint to the active foreground shell (Code / Chat app / desktop). */
export function paintChatHistoryPendingInForegroundShell(): void {
  if (isChatAppForeground()) {
    paintChatTranscriptHistoryPending('#chatAppMessageCol');
    return;
  }
  if (
    dismissCodeOverviewForNavigation() ||
    dismissDevServerScreenForNavigation()
  ) {
    paintChatTranscriptHistoryPending();
    return;
  }
  paintChatTranscriptHistoryPending();
}

// ── Transcript ───────────────────────────────────────────────────────────────

export function renderStatsForChat(chat: Chat): void {
  refreshMetricsStripForChat(chat);
  refreshContextUsageRing();
  if (isHubMounted()) refreshHubLiveData();
}

/** Empty transcript for a board task that has not run yet. */
function buildBoardChatEmptyState(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'ob-chat__empty';
  wrap.setAttribute('role', 'status');

  const title = document.createElement('p');
  title.className = 'ob-chat__empty-title';
  title.textContent = 'This task has not started.';

  const hint = document.createElement('p');
  hint.className = 'ob-chat__empty-hint';
  hint.textContent = 'Its transcript appears here once the board runs it.';

  wrap.append(title, hint);
  return wrap;
}

type ToolResultLookup = Map<
  string,
  {
    content: string;
    attachments?: ToolResultMessage['attachments'];
    codeChange?: ToolResultMessage['codeChange'];
  }
>;

interface HistoryRenderContext {
  chat: Chat;
  toolResultMap: ToolResultLookup;
}

/**
 * Render one history entry into `host`. Split out of `renderChatFromHistory` so the transcript
 * can be built in chunks across frames instead of one unbroken task (MIN-793).
 * Caller must already be inside `runWithChatMount(host, …)`.
 */
function appendHistoryMessageAt(host: HTMLElement, ctx: HistoryRenderContext, i: number): void {
  const { chat, toolResultMap } = ctx;
  const msg = chat.history[i];
  if (!msg || !msg.role) return;
  if (msg.role === 'tool') return;

  if (msg.role === 'context') {
    appendContextNotice(host, msg as ContextNoticeMessage, i);
    return;
  }

  if (msg.role === 'injection') {
    appendInjectionNotice(host, msg as InjectionNoticeMessage, i);
    return;
  }

  if (msg.role === 'user') {
    const userMsg = msg;
    if (isHiddenTranscriptUserMessage(userMsg)) {
      return;
    }
    const { wrap } = appendBubble('user', apiMessageContentToText(userMsg.content), {
      historyIndex: i,
      turnKind: 'user',
      chatId: chat.id,
      modeId: chat.modeId,
    }, { renderFromHistory: true, persistedImages: userMsg.images });
    if (userMsg.steer) {
      markMessageSteered(wrap);
    }
    if (userMsg.goalAchieved) {
      restoreGoalAchievedAffordance(wrap, userMsg);
    }
    attachMessageActions(wrap, {
      chatId: chat.id,
      historyIndex: i,
      turnKind: 'user',
    });
    attachBranchPicker(wrap, chat.id, i);
    return;
  }

  if (isAssistantToolCallMessage(msg)) {
    const prose = msg.content != null ? String(msg.content).trim() : '';
    const toolThinking =
      msg.thinking != null && msg.thinking.length > 0 ? msg.thinking : undefined;
    const hasToolThinking = toolThinking != null && toolThinking.length > 0;
    if (prose || hasToolThinking) {
      const { wrap, bubble } = appendBubble('assistant', prose, {
        historyIndex: i,
        turnKind: 'assistant-tools',
        chatId: chat.id,
        modeId: chat.modeId,
      });
      if (!prose && hasToolThinking) {
        bubble.remove();
      }
      if (hasToolThinking) {
        const durationMs = msg.thinkingDurationMs;
        renderThoughtsToggle(wrap, toolThinking!, {
          durationMs: durationMs != null && durationMs > 0 ? durationMs : undefined,
        });
      }
      if (msg.stats || msg.usage) {
        appendStats(wrap, msg.stats || {}, msg.usage || {});
      }
      if (msg.stopped) {
        markMessageStopped(wrap);
      }
      attachMessageActions(wrap, {
        chatId: chat.id,
        historyIndex: i,
        turnKind: 'assistant-tools',
      });
    }
    const stoppedNeedsMarkerRow = Boolean(msg.stopped) && !prose && !hasToolThinking;

    let firstToolEl: HTMLElement | null = null;
    for (const tc of msg.tool_calls) {
      const argsObj = parseToolArgsForDisplay(tc.function.arguments);
      const toolWrap = renderToolCall(tc.function.name, argsObj);
      toolWrap.dataset.toolCallId = tc.id;
      toolWrap.dataset.historyIndex = String(i);
      toolWrap.dataset.turnKind = 'assistant-tools';
      host.appendChild(toolWrap);
      if (!firstToolEl) firstToolEl = toolWrap;
      const stored = toolResultMap.get(tc.id);
      if (stored !== undefined) {
        renderToolResult(
          toolWrap,
          stored.content,
          stored.attachments,
          argsObj,
          stored.codeChange,
        );
      }
      attachShellKillUi(toolWrap, tc.function.name, tc.id, argsObj, undefined, chat.id);
    }
    if (!prose && !hasToolThinking && firstToolEl) {
      attachMessageActions(firstToolEl, {
        chatId: chat.id,
        historyIndex: i,
        turnKind: 'assistant-tools',
      });
    }

    for (const pair of getBeforeAfterPairs(chat.id)) {
      if (pair.turnId !== String(i)) continue;
      host.appendChild(renderBeforeAfterCard(pair));
    }
    if (stoppedNeedsMarkerRow) {
      host.appendChild(createStoppedMarkerRow());
    }
    return;
  }

  const text = apiMessageContentToText(msg.content);
  let trimmed = text.trim();
  const withThinking = msg as AssistantMessage;
  let thinkingSegments =
    withThinking.thinking != null && withThinking.thinking.length > 0
      ? withThinking.thinking
      : undefined;
  if (!thinkingSegments?.length && trimmed) {
    const split = extractInlineThinkingFromContent(text);
    if (split.thinking.length > 0 && split.reply.trim()) {
      trimmed = split.reply.trim();
      thinkingSegments = split.thinking;
    }
  }
  const hasThinking = thinkingSegments != null && thinkingSegments.length > 0;
  if (!trimmed && !hasThinking) {
    return;
  }
  const { wrap } = appendBubble('assistant', trimmed, {
    historyIndex: i,
    turnKind: 'assistant',
    chatId: chat.id,
    modeId: chat.modeId,
  });
  if (hasThinking) {
    const durationMs = withThinking.thinkingDurationMs;
    renderThoughtsToggle(wrap, thinkingSegments!, {
      durationMs: durationMs != null && durationMs > 0 ? durationMs : undefined,
    });
  }
  if (withThinking.stopped) {
    markMessageStopped(wrap);
  }
  if (withThinking.failed) {
    const tailFailed = indexOfLastFailedAssistantAtTail(chat.history);
    const fork = indexOfUserBeforeBlock(chat.history, i);
    markMessageFailed(
      wrap,
      tailFailed === i && fork >= 0
        ? { chatId: chat.id, forkHistoryIndex: fork }
        : undefined,
    );
  }
  if (withThinking.truncated) {
    markMessageTruncated(wrap, chat);
  }
  if (msg.stats || msg.usage) {
    appendStats(wrap, msg.stats || {}, msg.usage || {});
  }
  attachMessageActions(wrap, {
    chatId: chat.id,
    historyIndex: i,
    turnKind: 'assistant',
  });
  attachVoicePlayButton(wrap, trimmed);
}

/** Newest messages rendered in the switch's own task — what the user actually looks at. */
const HISTORY_SYNC_TAIL = 30;
/** Older messages backfilled this many per idle callback. */
const HISTORY_BACKFILL_CHUNK = 15;

/** Bumped by every transcript paint so a switch abandons the previous chat's backfill. */
let historyBackfillEpoch = 0;
let cancelPendingBackfill: (() => void) | null = null;

/** Abort any in-flight chunked backfill (a newer paint owns the transcript now). */
export function cancelChatHistoryBackfill(): void {
  historyBackfillEpoch += 1;
  cancelPendingBackfill?.();
  cancelPendingBackfill = null;
}

/** requestIdleCallback where available, rAF otherwise — chunks must not fight paint. */
function scheduleBackfillStep(step: () => void): () => void {
  const w = typeof window !== 'undefined' ? (window as Window & {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
    cancelIdleCallback?: (handle: number) => void;
  }) : undefined;
  if (w?.requestIdleCallback) {
    const handle = w.requestIdleCallback(step, { timeout: 200 });
    return () => w.cancelIdleCallback?.(handle);
  }
  if (typeof requestAnimationFrame === 'function') {
    const handle = requestAnimationFrame(step);
    return () => {
      if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(handle);
    };
  }
  const handle = setTimeout(step, 0);
  return () => clearTimeout(handle);
}

/**
 * Insert older rows above without moving the transcript under the reader: the scroll root's
 * height grows by exactly what we prepended, so scrollTop must grow by the same amount.
 */
function prependPreservingScroll(area: HTMLElement, nodes: Node[]): void {
  if (nodes.length === 0) return;
  const root = getChatScrollRoot();
  const prevTop = root?.scrollTop ?? 0;
  const prevHeight = root?.scrollHeight ?? 0;
  area.prepend(...nodes);
  if (!root) return;
  const delta = root.scrollHeight - prevHeight;
  if (delta !== 0) root.scrollTop = prevTop + delta;
}

/**
 * Render `[0, from)` backwards in idle-time chunks, prepending each into the live transcript.
 * The synchronous pass covers only the tail, so a long history no longer lands as one
 * multi-hundred-millisecond task on every chat switch (MIN-793).
 */
function backfillChatHistory(
  area: HTMLElement,
  ctx: HistoryRenderContext,
  from: number,
  onDone: () => void,
): void {
  if (from <= 0) {
    onDone();
    return;
  }
  const epoch = historyBackfillEpoch;
  let end = from;
  const step = (): void => {
    cancelPendingBackfill = null;
    if (epoch !== historyBackfillEpoch) return;
    if (!area.isConnected) return;
    const start = Math.max(0, end - HISTORY_BACKFILL_CHUNK);
    const chunk = document.createElement('div');
    const wasSuppressed = suppressBubbleScroll;
    suppressBubbleScroll = true;
    try {
      runWithChatMount(chunk, () => {
        for (let i = start; i < end; i += 1) {
          appendHistoryMessageAt(chunk, ctx, i);
        }
      });
    } finally {
      suppressBubbleScroll = wasSuppressed;
    }
    prependPreservingScroll(area, [...chunk.childNodes]);
    end = start;
    if (end <= 0) {
      onDone();
      return;
    }
    cancelPendingBackfill = scheduleBackfillStep(step);
  };
  cancelPendingBackfill = scheduleBackfillStep(step);
}

export function renderChatFromHistory(chat: Chat, mount?: string | HTMLElement): void {
  const boardChatHost =
    mount == null && isBoardChatEmbedOpenForChat(chat.id)
      ? queryBoardChatTranscriptHost()
      : null;
  const area = boardChatHost ?? resolveChatMount(mount);
  const codeMount = boardChatHost != null || isCodeChatMount(mount);
  const scrollAnchor = captureChatScrollAnchor();
  disposeChatWorkView(area);
  // A newer paint owns the transcript; the previous chat's chunks must not land in it.
  cancelChatHistoryBackfill();

  if (codeMount && isSuperPlanScreenMountedForOtherChat(chat.id)) {
    teardownOrchestratePlanScreen();
  }

  if (codeMount && !boardChatHost && isMainColumnOverlaySuppressingChatDom()) {
    return;
  }

  runWithChatMount(area, () => {
  suppressBubbleScroll = true;
  try {
  if (codeMount && !boardChatHost) {
    teardownCodeBrainMapBeforeChatPaint();
    teardownIssuesEmbedBeforeChatPaint();
    stripMainColumnOverlayClasses();
  }
  updateCodeChangeStrip(chat);
  if (codeMount && isOrchestrateHubMounted()) {
    teardownOrchestrateHub();
  }
  if (codeMount) {
    restoreOrchestratePlanScreenSessionFromChat(chat);
  }
  if (codeMount && normalizeModeId(chat.modeId) === 'super-plan') {
    if (isSuperPlanScreenShowingChat(chat.id)) return;
    teardownHub();
    removeOrchestratePlanScreenSuspendedBanner();
    reopenSuperPlanScreenForChat(chat);
    return;
  }
  const suspendedPlanChat = codeMount && isOrchestratePlanScreenSuspendedForChat(chat);
  if (suspendedPlanChat) {
    teardownHub();
    if (!chat.history.length) {
      area.innerHTML = '';
      showOrchestratePlanScreenSuspendedBanner(area, chat);
      renderPersistedSubAgentCardsForChat(chat);
      refreshContextUsageRing();
      return;
    }
  } else if (codeMount && !isOrchestratePlanScreenSessionActive(chat)) {
    const foreignSuspendedPlan = (() => {
      const session = getOrchestratePlanScreenSession();
      return Boolean(
        session?.planScreenSuspended && session.chatId !== chat.id,
      );
    })();
    if (!foreignSuspendedPlan) {
      teardownOrchestratePlanScreen();
    } else {
      removeOrchestratePlanScreenSuspendedBanner();
    }
  } else if (codeMount && isOrchestratePlanScreenMounted()) {
    teardownOrchestratePlanScreenDom();
  }
  const boardGroup = codeMount && !boardChatHost ? getActiveBoardGroup() : null;
  if (boardGroup?.viewMode === 'board') {
    teardownHub();
    syncBoardViewChrome();
    void import('./orchestrate-board-setup-banner').then((m) => m.removeBoardSetupReturnBanner());
    void import('../os/router').then((m) => m.navigateToCodeBoards());
    return;
  }
  if (codeMount && !boardChatHost && isBoardOwnedChat(chat)) {
    const owner = getBoardGroupForChat(chat);
    if (owner?.viewMode === 'board') {
      void import('../state/chat-groups').then((m) => m.openBoardGroup(owner.id));
      return;
    }
  }
  void import('./orchestrate-board-setup-banner').then((m) => m.syncBoardSetupReturnBanner(chat));
  clearSubAgentCardDomRegistry();
  if (!chat.history.length) {
    if (boardChatHost) {
      area.replaceChildren(buildBoardChatEmptyState());
    } else if (codeMount) {
      renderHub(chat);
    } else {
      area.innerHTML = '';
      renderPersistedSubAgentCardsForChat(chat);
    }
    scrollChatToBottom();
    refreshContextUsageRing();
    return;
  }
  if (codeMount) {
    teardownHub();
  }
  // Paint off-DOM and swap so the previous transcript stays until the new one is ready (MIN-584).
  const transcriptHost = document.createElement('div');
  const toolResultMap = new Map<
    string,
    {
      content: string;
      attachments?: ToolResultMessage['attachments'];
      codeChange?: ToolResultMessage['codeChange'];
    }
  >();
  for (const msg of chat.history) {
    if (msg?.role !== 'tool') continue;
    const toolMsg = msg as ToolResultMessage;
    toolResultMap.set(toolMsg.tool_call_id, {
      content: toolMsg.content,
      attachments: toolMsg.attachments,
      ...(toolMsg.codeChange ? { codeChange: toolMsg.codeChange } : {}),
    });
  }

  const renderCtx: HistoryRenderContext = { chat, toolResultMap };
  const total = chat.history.length;
  const tailStart = Math.max(0, total - HISTORY_SYNC_TAIL);
  runWithChatMount(transcriptHost, () => {
    for (let i = tailStart; i < total; i += 1) {
      appendHistoryMessageAt(transcriptHost, renderCtx, i);
    }
  });
  area.replaceChildren(...transcriptHost.childNodes);
  installChatWorkView(area, chat, () => isChatStreaming(chat.id));
  if (suspendedPlanChat) {
    // Floats over the viewport rather than living in the transcript, so it is order-independent.
    showOrchestratePlanScreenSuspendedBanner(area, chat);
  }
  backfillChatHistory(area, renderCtx, tailStart, () => {
    // Cards anchor to their spawn tool row; re-place now that the older rows exist.
    runWithChatMount(area, () => renderPersistedSubAgentCardsForChat(chat));
    syncThoughtsCaretPulse(area);
  });
  renderPersistedSubAgentCardsForChat(chat);
  syncThoughtsCaretPulse(area);
  syncComposerMessageQueue();
  restoreChatScrollAnchor(scrollAnchor);
  refreshMetricsStripForChat(chat);
  refreshContextUsageRing();
  if (isChatStreaming(chat.id) && isStreamDomVisible(chat.id)) {
    void import('../tools/stream-chat-dom').then((m) => m.remountStreamDomForChat(chat.id));
  }
  } finally {
    suppressBubbleScroll = false;
    void import('./loop-active-hint').then(({ syncLoopStatusUi }) => {
      syncLoopStatusUi(chat.id);
    });
  }
  });
}

/** Re-render the chat transcript in whichever shell is currently foreground. */
export function renderChatInForegroundShell(chat: Chat): void {
  if (isChatAppForeground()) {
    renderChatFromHistory(chat, '#chatAppMessageCol');
    return;
  }
  renderChatFromHistory(chat);
}

/** Optional history index for message action menus. */
export interface BubbleRenderMeta {
  historyIndex: number;
  turnKind: MessageTurnKind;
  chatId: string;
  /** Mode of the chat when the bubble was rendered (passed to markdown renderer). */
  modeId?: string;
}

export interface AppendUserBubbleOptions extends UserBubbleRenderOptions {
  /** When true, paint chips from persisted history content (default for user rows). */
  renderFromHistory?: boolean;
}

// ── Notices ──────────────────────────────────────────────────────────────────

/** True when board view should suppress chat bubbles (user can jump to Chat view). */
function shouldStubOrchestrateBoardStreamDom(chat: Chat): boolean {
  if (isBoardChatEmbedOpenForChat(chat.id)) return false;
  return isBoardViewActive();
}

/** True when plan authoring screen suppresses chat bubble DOM. */
function shouldStubOrchestratePlanScreenStreamDom(chat: Chat): boolean {
  const modeId = normalizeModeId(chat.modeId);
  if (modeId !== 'plan' && modeId !== 'super-plan' && modeId !== 'orchestrate') {
    return false;
  }
  return isOrchestratePlanScreenSuppressingChatDom(chat.id);
}

function shouldStubOrchestrateStreamDom(chat: Chat): boolean {
  return (
    shouldStubOrchestrateBoardStreamDom(chat) ||
    shouldStubOrchestratePlanScreenStreamDom(chat)
  );
}

function resolveBubbleTargetChat(meta?: BubbleRenderMeta): Chat {
  const active = getActiveChat();
  const targetId = meta?.chatId?.trim();
  if (!targetId || targetId === active.id) return active;
  return sessionState?.chats.find((c) => c.id === targetId) ?? active;
}

function bubbleDomStub(): { wrap: HTMLDivElement; bubble: HTMLDivElement } {
  const stub = document.createElement('div');
  return { wrap: stub, bubble: stub };
}

interface TranscriptNoticeChipOptions {
  action: string;
  outcome: string;
  icon: IconName;
  body?: string;
  historyIndex: number;
  emptyFallback: string;
}

function injectionNoticeIcon(kind: PromptInjectionKind): IconName {
  switch (kind) {
    case 'brain-notes':
      return 'appBrain';
    case 'code-map':
      return 'appCodeBrainMap';
    case 'context-documents':
      return 'contextDocuments';
    default:
      return 'fileText';
  }
}

function contextNoticeIcon(policy: ContextNoticeMessage['policy']): IconName {
  return policy === 'archive' ? 'archive' : 'compress';
}

function appendTranscriptNoticeChip(
  area: HTMLElement,
  options: TranscriptNoticeChipOptions,
  insertBefore?: ChildNode | null,
): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'context-notice tool-call-msg';
  wrap.dataset.historyIndex = String(options.historyIndex);

  const details = document.createElement('details');
  details.className = 'tool-call-details context-notice__details';

  const summary = document.createElement('summary');
  summary.className = 'tool-call-summary tool-call-summary--ok';

  const statusGlyph = document.createElement('span');
  statusGlyph.className = 'tool-call-status';
  statusGlyph.appendChild(
    createIcon(options.icon, { className: 'tool-call-icon', size: 15 }),
  );

  const action = document.createElement('span');
  action.className = 'tool-call-action';
  action.textContent = options.action;

  const outcome = document.createElement('span');
  outcome.className = 'tool-call-outcome';
  outcome.textContent = options.outcome;

  const chevron = createIcon('chevronDown', {
    className: 'tool-call-chevron',
    size: 14,
  });

  summary.appendChild(statusGlyph);
  summary.appendChild(action);
  summary.appendChild(outcome);
  summary.appendChild(chevron);

  const body = document.createElement('div');
  body.className = 'tool-call-body';

  if (options.body?.trim()) {
    const pre = document.createElement('pre');
    pre.className = 'context-notice__summary';
    pre.textContent = options.body;
    body.appendChild(pre);
  } else {
    const empty = document.createElement('p');
    empty.className = 'context-notice__empty';
    empty.textContent = options.emptyFallback;
    body.appendChild(empty);
  }

  details.appendChild(summary);
  details.appendChild(body);
  wrap.appendChild(details);
  if (insertBefore) {
    area.insertBefore(wrap, insertBefore);
  } else {
    appendChatTranscriptNode(wrap, area);
  }
  return wrap;
}

function appendContextNotice(
  area: HTMLElement,
  notice: ContextNoticeMessage,
  historyIndex: number,
): void {
  appendTranscriptNoticeChip(area, {
    action: contextNoticeAction(notice.policy),
    outcome: contextNoticeOutcome(notice.droppedTurns, notice.summaryText),
    icon: contextNoticeIcon(notice.policy),
    body: notice.summaryText,
    historyIndex,
    emptyFallback: 'No summary text was recorded for this trim.',
  });
}

function appendInjectionNotice(
  area: HTMLElement,
  notice: InjectionNoticeMessage,
  historyIndex: number,
  insertBefore?: ChildNode | null,
): void {
  const wrap = appendTranscriptNoticeChip(
    area,
    {
      action: injectionNoticeAction(notice.kind),
      outcome: injectionNoticeOutcome(notice.body),
      icon: injectionNoticeIcon(notice.kind),
      body: notice.body,
      historyIndex,
      emptyFallback: 'No injection payload was recorded.',
    },
    insertBefore,
  );
  wrap.classList.add('context-notice--user-turn');
}

/**
 * Mount injection notice chips during an in-flight turn (before assistant stream).
 */
export function appendInjectionNoticesDom(
  notices: InjectionNoticeMessage[],
  startHistoryIndex: number,
  meta?: { chatId?: string },
): void {
  const active = getActiveChat();
  const targetId = meta?.chatId?.trim() || active.id;
  if (targetId !== active.id && !isStreamDomVisible(targetId)) return;
  const chat = resolveBubbleTargetChat({
    chatId: targetId,
    historyIndex: startHistoryIndex,
    turnKind: 'user',
  });
  if (shouldStubOrchestrateStreamDom(chat)) return;
  const mount = getActiveChatMountElement();
  clearTranscriptEmptyState(mount);
  const insertBefore = mount.querySelector('.msg.assistant.msg--awaiting-prose');
  let index = startHistoryIndex;
  for (const notice of notices) {
    appendInjectionNotice(mount, notice, index, insertBefore);
    index += 1;
  }
  scrollChatIfPinned();
}

// ── Bubbles ──────────────────────────────────────────────────────────────────

/**
 * Paint the stopped label on a row the live turn already rendered, matching what
 * a reload draws: chip the bubble when the row has one, otherwise give the label
 * its own row under the tool cards the stop cut short.
 */
export function paintStoppedRowFromHistory(historyIndex: number): void {
  const mount = getActiveChatMountElement();
  const painted = mount.querySelector<HTMLElement>(
    `.msg.assistant[data-history-index="${historyIndex}"]`,
  );
  if (painted) {
    markMessageStopped(painted);
    return;
  }
  appendChatTranscriptNode(createStoppedMarkerRow(), mount);
}

export function appendBubble(
  role: 'user' | 'assistant',
  content: string,
  meta?: BubbleRenderMeta,
  userOptions?: AppendUserBubbleOptions,
): { wrap: HTMLDivElement; bubble: HTMLDivElement } {
  const active = getActiveChat();
  const targetId = meta?.chatId?.trim() || active.id;
  if (targetId !== active.id && !isStreamDomVisible(targetId)) {
    return bubbleDomStub();
  }
  const chat = resolveBubbleTargetChat(meta);
  if (shouldStubOrchestrateStreamDom(chat)) {
    return bubbleDomStub();
  }
  const mount = getActiveChatMountElement();
  clearTranscriptEmptyState(mount);
  if (isHubMounted()) {
    teardownHub();
  }

  const wrap = document.createElement('div');
  wrap.className = `msg ${role}`;
  if (meta) {
    wrap.dataset.historyIndex = String(meta.historyIndex);
    wrap.dataset.turnKind = meta.turnKind;
    wrap.dataset.chatId = meta.chatId;
  }

  const label = document.createElement('div');
  label.className = 'msg-label';
  label.textContent = role === 'user' ? 'You' : 'Assistant';

  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';
  if (role === 'assistant') {
    setAssistantBubbleContent(bubble, content, {
      streaming: false,
      modeId: meta?.modeId ?? chat.modeId,
    });
  } else if (userOptions?.renderFromHistory !== false) {
    renderUserMessageBubble(bubble, content, userOptions);
    bubble.dataset.historyContent = content;
  } else {
    bubble.textContent = content;
  }

  wrap.appendChild(label);
  wrap.appendChild(bubble);
  appendChatTranscriptNode(wrap, mount);
  if (!suppressBubbleScroll) {
    if (role === 'user') {
      scrollChatToBottom();
    } else {
      scrollChatIfPinned();
    }
  }
  return { wrap, bubble };
}

/** Inline assistant failure copy (network, provider, or lost generation). */
export function setAssistantErrorBubble(bubble: HTMLDivElement, message: string): void {
  bubble.classList.remove('msg-bubble--md', 'msg-bubble--awaiting');
  bubble.classList.add('msg-bubble--error');
  bubble.replaceChildren();
  bubble.textContent = message;
}

export interface AssistantErrorRecoveryOptions {
  chatId: string;
  forkHistoryIndex: number;
  onRecover?: () => void;
}

/** Error bubble with Continue + Clear when history could not be auto-rolled back. */
export function setAssistantErrorBubbleWithRecovery(
  bubble: HTMLDivElement,
  message: string,
  recovery: AssistantErrorRecoveryOptions,
): void {
  bubble.classList.remove('msg-bubble--md', 'msg-bubble--awaiting');
  bubble.classList.add('msg-bubble--error');
  bubble.replaceChildren();

  const text = document.createElement('span');
  text.textContent = message;
  bubble.appendChild(text);

  appendFailedTurnRecoveryActions(bubble, recovery);
}

/** DOM row for an in-flight assistant reply (prose bubble hidden until first token). */
export interface StreamingAssistantRow {
  wrap: HTMLDivElement;
  bubble: HTMLDivElement;
  cursor: HTMLDivElement;
  streamStatus: StreamingStatusHandle;
}

/** Update the live stream phase label on an in-flight assistant row. */
export function setStreamingRowPhase(wrap: HTMLElement, phase: StreamPhase): void {
  const phaseAttr = wrap.dataset.streamPhase;
  if (!phaseAttr) return;
  const status = wrap.querySelector('.stream-status');
  if (!status) return;
  const label = status.querySelector('.stream-status__label');
  if (phase === 'prose' || phase === 'done') {
    status.classList.add('hidden');
    status.setAttribute('aria-busy', 'false');
    wrap.dataset.streamPhase = phase;
    return;
  }
  status.classList.remove('hidden');
  status.setAttribute('aria-busy', 'true');
  status.classList.remove('stream-status--generating', 'stream-status--thinking');
  status.classList.add(
    phase === 'thinking' ? 'stream-status--thinking' : 'stream-status--generating',
  );
  if (label) {
    label.textContent =
      phase === 'thinking' ? 'Thinking…' : 'Generating response…';
  }
  wrap.dataset.streamPhase = phase;
}

// ── Streaming ────────────────────────────────────────────────────────────────

/** Create an assistant message shell for SSE streaming without showing an empty bubble. */
/** Stub row when the stream targets a chat that is not visible in #chatArea. */
function streamingAssistantRowStub(): StreamingAssistantRow {
  const stub = document.createElement('div');
  const bubble = document.createElement('div');
  const cursor = document.createElement('div');
  return {
    wrap: stub,
    bubble,
    cursor,
    streamStatus: {
      setPhase: () => {},
      setThinkingElapsed: () => {},
      setRuntimeDetail: () => {},
      dispose: () => {},
    },
  };
}

/** Drop orphaned in-flight assistant shells before mounting a fresh stream row. */
function removeStaleLiveStreamingRows(mount: HTMLElement): void {
  for (const row of mount.querySelectorAll('.msg.assistant')) {
    const isAwaiting = row.classList.contains('msg--awaiting-prose');
    const hasLiveCaret = Boolean(row.querySelector(STREAMING_CARET_SELECTOR));
    if (isAwaiting || hasLiveCaret) {
      row.remove();
    }
  }
}

export function appendStreamingAssistantRow(forChatId?: string): StreamingAssistantRow {
  const active = getActiveChat();
  const targetId = forChatId ?? active.id;
  if (!isStreamDomVisible(targetId)) {
    return streamingAssistantRowStub();
  }
  const targetChat =
    targetId === active.id
      ? active
      : sessionState?.chats.find((c) => c.id === targetId) ?? active;
  if (shouldStubOrchestrateStreamDom(targetChat)) {
    return streamingAssistantRowStub();
  }
  const mount = getActiveChatMountElement();
  clearTranscriptEmptyState(mount);
  if (isHubMounted()) {
    teardownHub();
  }

  removeStaleLiveStreamingRows(mount);

  const wrap = document.createElement('div');
  wrap.className = 'msg assistant msg--awaiting-prose';

  const label = document.createElement('div');
  label.className = 'msg-label';
  label.textContent = 'Assistant';

  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble msg-bubble--awaiting';

  const cursor = document.createElement('div');
  cursor.className = `cursor ${STREAMING_CARET_CLASS}`;
  cursor.setAttribute('aria-hidden', 'true');

  wrap.appendChild(label);
  const streamStatus = attachStreamStatus(wrap);
  beginStreamAnnouncer(wrap);
  wrap.appendChild(bubble);
  bubble.appendChild(cursor);
  appendChatTranscriptNode(wrap, mount);
  installChatWorkView(mount, targetChat, () => isChatStreaming(targetChat.id));
  scrollChatIfPinned();
  return { wrap, bubble, cursor, streamStatus };
}

/** Show the assistant prose bubble once streamed content (or fallback text) is ready. */
export function revealAssistantProseBubble(
  wrap: HTMLElement,
  bubble: HTMLElement,
  streamStatus?: StreamingStatusHandle,
): void {
  wrap.classList.remove('msg--awaiting-prose');
  bubble.classList.remove('msg-bubble--awaiting');
  streamStatus?.setPhase('prose');
}

/** True when assistant prose should be painted (non-whitespace or persisted thoughts). */
export function assistantProseHasVisibleContent(
  content: string | null | undefined,
  hasThinking = false,
): boolean {
  const trimmed = content != null ? String(content).trim() : '';
  return trimmed.length > 0 || hasThinking;
}

/** Remove a live streaming assistant shell that would show an empty bubble (tool-only turns, cancelled streams, or turn end with no prose). */
export function removeOrphanStreamingRow(
  wrap: HTMLElement,
  streamStatus?: StreamingStatusHandle,
): void {
  streamStatus?.dispose();
  cancelStreamAnnouncer();
  if (wrap.isConnected) {
    wrap.remove();
  }
}

export interface AnchorPersistedThoughtsOptions {
  durationMs?: number;
  streamStatus?: StreamingStatusHandle;
}

/** Pin a completed thinking block on an assistant row at the response that produced it. */
export function anchorPersistedThoughtsOnRow(
  wrap: HTMLElement,
  segments: string[],
  opts: AnchorPersistedThoughtsOptions = {},
): void {
  if (segments.length === 0) return;
  renderThoughtsToggle(wrap, segments, {
    durationMs: opts.durationMs != null && opts.durationMs > 0 ? opts.durationMs : undefined,
  });
  opts.streamStatus?.dispose();
  wrap.querySelector('.msg-bubble')?.remove();
  wrap.querySelector('.stream-status')?.remove();
  wrap.classList.remove('msg--awaiting-prose');
}

// ── Stats ────────────────────────────────────────────────────────────────────

/** Add per-turn metric chips under an assistant bubble. */
export function appendStats(
  wrap: HTMLElement,
  stats: Stats | undefined,
  usage: Usage | undefined
): void {
  const s = stats || {};
  // Derive total from prompt+completion for legacy rows that omitted total_tokens.
  const u = normalizeUsageTotals(usage || {});

  const chips = document.createElement('div');
  chips.className = 'msg-stats';

  const defs: [string, boolean, string][] = [
    ['c', s.tokens_per_second != null, `<span>${s.tokens_per_second?.toFixed(1)}</span> tok/s`],
    ['g', s.time_to_first_token != null, `TTFT <span>${s.time_to_first_token?.toFixed(3)}s</span>`],
    ['y', s.generation_time != null, `gen <span>${s.generation_time?.toFixed(3)}s</span>`],
    ['r', u.total_tokens != null, `<span>${formatStatCount(u.total_tokens).display}</span> tokens`],
    [
      'b',
      s.prompt_tokens_per_second != null,
      `pp <span>${s.prompt_tokens_per_second?.toFixed(0)}</span> tok/s`,
    ],
    [
      'p',
      s.draft_acceptance != null,
      `draft <span>${((s.draft_acceptance ?? 0) * 100).toFixed(0)}%</span> accepted`,
    ],
  ];

  for (const [cls, show, html] of defs) {
    if (!show) continue;
    const chip = document.createElement('div');
    chip.className = `stat-chip ${cls}`;
    chip.innerHTML = html;
    if (cls === 'r' && u.total_tokens != null) {
      const formatted = formatStatCount(u.total_tokens);
      if (formatted.full) chip.setAttribute('title', formatted.full);
    }
    chips.appendChild(chip);
  }

  if (chips.children.length) wrap.appendChild(chips);
}

/** Clear the active chat's message history (session row remains). */
export function clearChat(): void {
  if (isActiveChatStreaming()) {
    setStatus('spin', 'Finish the current reply first');
    return;
  }
  void (async () => {
    if (
      !(await appConfirm('Clear all messages in this chat? The chat stays in your sidebar.', {
        confirmLabel: 'Clear',
        danger: true,
      }))
    ) {
      return;
    }
    const chat = getActiveChat();
    clearActiveGoal(chat);
    clearActiveLoops(chat);
    clearChatTodos(chat);
    chat.history = [];
    resetTokenLedger(chat);
    resetCodeChangeTotals(chat);
    updateCodeChangeStrip(chat);
    if (sessionState) {
      recomputeWorkspaceCodeChangeTotals(sessionState, chat.workspacePath);
      updateWorkspaceCodeChangeDisplay();
    }
    chat.lastStats = null;
    chat.modelInfo = {};
    chat.lastMessageAt = 0;
    touchChat(chat);
    renderChatFromHistory(chat);
    renderStatsForChat(chat);
    renderSidebar();
    scheduleSaveSessions();
    syncTodoPanel();
    void import('./loop-active-hint').then(({ syncLoopActiveHint }) => {
      syncLoopActiveHint();
    });
    void import('./goal-active-hint').then(({ syncGoalActiveHint }) => {
      syncGoalActiveHint();
    });
    closeDrawer();
  })();
}

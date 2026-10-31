import { loadDefaultModelValue } from '../models/selection';
import { getSharedChatHost } from './shared-chat-host-state';
import { showToast } from './toast';
import { runSettingsAction } from './settings-controls';
﻿import { reportBackgroundError } from '../boot/report-background-error';
import { isChatsWorkspacePath } from '../lib/chats-workspace';
import { clearAttachments } from '../attachments/store';
import { decodeModelSelectKey } from '../lib/model-select-key';
import { routerChatModelLabel, getRouterConfigSync, saveRouterConfig } from '../models/routers';
import { normalizeWorkspacePath } from '../lib/normalize-workspace-path';
import { isChatStreaming } from '../chat/streaming-state';
import { stopGeneration } from '../chat/stop-generation';
import {
  createGroup,
  deleteGroup,
  findBoardGroupForPlanner,
  findGroupById,
  getActiveBoardGroup,
  getBoardGroupForChat,
  buildSortedWorkspaceSidebarEntries,
  getGroupsForWorkspace,
  isBoardOwnedChat,
  isBoardOwnedGroup,
  isChatPinned,
  listBoardGroupChatIds,
  openBoardGroup,
  renameGroup,
  resolveBoardRestoreGroupOnSwitch,
  setChatPinned,
  splitPinnedChats,
  toggleGroupCollapsed,
} from '../state/chat-groups';
import { appConfirm } from './app-dialog';
import { createBoardCategoryIcon } from './board-category-icons';
import { createIcon } from './icon';
import { agentMarkStateFromLabel, createAgentMark, createAgentModelChip, syncAgentMark, syncAgentMarkStack, syncAgentModelChip, type AgentMarkState } from './agent-model-mark';
import { formatWorkDuration } from '../chat/transcript-turns';
import { isChatAppForeground } from './chat-mount';
import { teardownCodeBrainMapBeforeChatPaint } from './code-brain-map';
import { syncComposerFromStreamingState } from './composer-send';
import { syncGoalActiveHint } from './goal-active-hint';
import { syncLoopActiveHint } from './loop-active-hint';
import { syncGoalEvalUi } from './goal-eval-status';
import { isGoalEvaluating } from '../chat/goal/evaluating-state';
import { syncTodoPanel } from './todo-panel';
import {
  createEmptyChatObject,
  ensureChatHistoryLoaded,
  formatDraftChatSidebarName,
  getActiveChat,
  getChatMessageCount,
  getSidebarListedChatsForWorkspace,
  getUnassignedChats,
  isEphemeralEmptyChat,
  isHiddenFromMainSidebar,
  markSessionScalarsDirty,
  onWorkspaceChanged,
  pruneEphemeralEmptyChats,
  removeChatByIdAsync,
  sessionState,
  touchChat,
  recordChatMessage,
  scheduleSaveSessions,
  type RemoveChatResult,
} from '../state/sessions';
import {
  getExpertScopeId,
  isExpertScopeActive,
  renderExpertScopeChatList,
  renderExpertScopeHeader,
} from './experts/experts-scope';
import { getWorkspacePath } from '../state/workspace';
import { normalizeModeId, type ModeId } from '../chat/modes/types';
import { normalizeOrchestratePlanPath } from '../chat/plans/plan-path';
import type { BoardCategory, Chat, ChatGroup, LeftoverBoardTask } from '../types';
import {
  applySidebarVisuals,
  closeMobileSidebar,
} from './layout';
import { bootGenerationResumeForChat } from '../chat/generation-resume';
import { resumeIncompleteToolBatchOnChatSwitch } from '../chat/incomplete-tool-resume';
import { notifyAskQuestionDisplayContextChanged } from '../chat/ask-question-display';
import { syncAskQuestionModalOnChatSwitch } from './question-cards-modal';
import {
  paintChatHistoryPendingInForegroundShell,
  renderChatFromHistory,
  renderStatsForChat,
  showCachedModelInfo,
} from './messages';
import {
  appendChatItemCodeChangeStats,
  formatChatItemCodeChangeAria,
  updateCodeChangeStrip,
} from './code-change-strip';
import { updateWorkspaceCodeChangeDisplay } from './workspace-code-change';
import { hasCodeChangeTotals } from '../usage/code-change-ledger';
import { getDefaultWorkAgentForMode } from '../agents/work-agent-registry';
import { syncModeSelectorFromActiveChat } from './mode-selector';
import { syncComposerReasoningEffortFromActiveChat } from './composer-reasoning-effort';
import { syncOrchestratePlanStripFromActiveChat } from './orchestrate-plan-selector';
import { syncComposerPinnedSkillFromActiveChat } from './composer-pinned-skill';
import { syncChatLinkChipsFromActiveChat } from './chat-link-chips';
import { syncComposerRunTargetFromActiveChat } from './composer-run-target';
import {
  invalidateComposerUndoGitCache,
  syncComposerUndoFromActiveChat,
} from './composer-undo';
import { clearPanelCwdUserOverride, syncPanelFromActiveChat } from './git-panel';
import { seedNewChatComposerRunTarget } from './new-chat-run-target-seed';
import { buildDefaultPinnedSkillForNewChat } from '../skills/config';
import { dismissCodeOverviewForNavigation, isCodeOverviewOpen } from './code-overview';
import {
  dismissDevServerScreenForNavigation,
  isDevServerScreenOpen,
} from './dev-server-screen';
import { isBoardViewActive, syncViewModeToggleFromActiveChat } from './view-mode-toggle';
import {
  isOrchestrateHubMounted,
  refreshOrchestrateHubBoardList,
  refreshOrchestrateHubPlanList,
  teardownOrchestrateHub,
} from './orchestrate-hub';
import {
  isOrchestratePlanScreenSuspendedForChat,
  suspendOrchestratePlanScreenOnLeave,
} from './orchestrate-plan-screen';
import { exitBoardViewForNavigation } from './exit-board-view';
import { isBoardChatEmbedOpenForChat } from './orchestrate-board-chat-state';
import { onModelRoutingActiveChatChanged } from './settings-model-routing';
import { syncWorkAgentDevFromActiveChat } from './work-agent-dev';
import { updateModelLoadUnloadButtons } from '../api/models';
import { scheduleCapabilityProbeForSelectValue } from '../providers/first-load-probe';
import { restoreChatColumnOnChatSelect } from './workspace-split-resize';
import { updateModelStateDot } from './model-state-dot';
import { syncModelSelectPicker } from './model-select-picker';
import {
  applyDefaultModelToChat,
  persistDefaultModelValue,
  readDefaultModelBinding,
} from './default-model';
import { syncActiveChatModelUi, onActiveChatModelChange } from './chat-model-ui';
import { setStatus } from './status';
import {
  applyChatItemDotClasses,
  applyGroupHeaderDotClasses,
  getChatItemDotContext,
  isChatItemDotVisible,
  maybeMarkChatUnreadAfterLeave,
  recordChatOpened,
  resolveChatItemDotState,
  resolveGroupHeaderDotState,
  syncChatItemDotsInDom,
} from './chat-item-dot';
import {
  applyChatItemLoopIcon,
  createChatItemLoopIcon,
  resolveChatItemLoopIconState,
  syncChatItemLoopIconsInDom,
} from './chat-item-loop-icon';
import { acknowledgeChatViewed } from '../notifications/acknowledge';
import { syncChatItemWorktreeIcon } from './chat-item-worktree-icon';
import { hasComposerDraft } from '../state/session-workspace-scope';
import { getChatsForWorkspace, isSidebarListedChat } from '../state/session-workspace-scope';
import { AGENT_CHILD_PAGE_SIZE, AGENT_VISUAL_DEPTH_LIMIT, agentChatStatusLabel, chatLink, chatReadOnlyReason, hasUnsettledAgentWork, isAgentChatActive, projectChatRelationships, sortAgentChats, type ChatRelationships } from '../state/chat-relationships';
import { isChatRunningRemotely } from '../chat/remote-turn-state';
import { markPreviewOccluder } from './preview-occlusion';
import {
  flushActiveComposerDraftBeforeNewChat,
  resetComposerForEphemeralReuse,
  switchComposerDraft,
} from './composer-draft';
import { isMainColumnOverlaySuppressingChatDom } from './main-column-overlay';

// ── Board waves ──────────────────────────────────────────────────────────────

/** Pointer dwell on a chat row before its transcript is prefetched. */
const HOVER_PREFETCH_DELAY_MS = 150;

/** True when every task in a wave is complete (sidebar auto-collapse). */
function isWaveComplete(tasks: LeftoverBoardTask[], waveId: number | string): boolean {
  const wt = tasks.filter((t) => t.wave === waveId);
  return wt.length > 0 && wt.every((t) => t.status === 'complete');
}

function toggleSidebarWaveCollapsed(group: ChatGroup, waveId: number | string): void {
  const wave = group.orchestrateBoard?.waves.find((w) => w.id === waveId);
  if (!wave) return;
  wave.collapsed = !(wave.collapsed ?? false);
  scheduleSaveSessions();
}

function appendWaveSubgroupHeader(
  container: HTMLElement,
  waveId: number | string,
  collapsed: boolean,
  onToggle: () => void,
): void {
  const head = document.createElement('div');
  head.className = 'chat-wave-subgroup-header';
  head.setAttribute('aria-expanded', collapsed ? 'false' : 'true');

  const caret = document.createElement('button');
  caret.type = 'button';
  caret.className = 'chat-wave-subgroup-header__caret';
  caret.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  caret.setAttribute(
    'aria-label',
    collapsed ? `Expand wave ${waveId} chats` : `Collapse wave ${waveId} chats`,
  );
  caret.textContent = collapsed ? '▸' : '▾';
  caret.addEventListener('click', (e) => {
    e.stopPropagation();
    onToggle();
    renderSidebar();
  });

  const label = document.createElement('span');
  label.textContent = `Wave ${waveId}`;

  head.appendChild(caret);
  head.appendChild(label);
  container.appendChild(head);
}

function appendBoardGroupWaveMembers(
  membersEl: HTMLElement,
  group: ChatGroup,
  members: Chat[],
  highlightChatId: string | null,
): void {
  const board = group.orchestrateBoard;
  if (!board) return;

  const plannerId = group.plannerChatId?.trim();
  const taskById = new Map(board.tasks.map((t) => [t.id, t]));
  const rendered = new Set<string>();

  if (plannerId) {
    const planner = members.find((c) => c.id === plannerId);
    if (planner) {
      appendChatRow(membersEl, planner, highlightChatId, { inGroup: true, group });
      rendered.add(planner.id);
    }
  }

  for (const wave of board.waves) {
    const waveChats = members.filter((c) => {
      if (rendered.has(c.id)) return false;
      const taskId = c.boardTaskId?.trim();
      if (!taskId) return false;
      const task = taskById.get(taskId);
      return task?.wave === wave.id;
    });
    if (waveChats.length === 0) continue;

    const collapsed = isWaveComplete(board.tasks, wave.id) || (wave.collapsed ?? false);
    appendWaveSubgroupHeader(membersEl, wave.id, collapsed, () => {
      toggleSidebarWaveCollapsed(group, wave.id);
    });

    for (const chat of waveChats) rendered.add(chat.id);

    if (!collapsed) {
      const waveMembersEl = document.createElement('div');
      waveMembersEl.className = 'chat-wave-members';
      for (const chat of waveChats) {
        appendChatRow(waveMembersEl, chat, highlightChatId, { inGroup: true, group });
      }
      membersEl.appendChild(waveMembersEl);
    }
  }

  for (const chat of members) {
    if (rendered.has(chat.id)) continue;
    if (plannerId && chat.id === plannerId) continue;
    if (chat.boardTaskId?.trim()) continue;
    appendChatRow(membersEl, chat, highlightChatId, { inGroup: true, group });
  }
}

const selectedChatIds = new Set<string>();
let lastSelectedChatId: string | null = null;

// ── Selection ────────────────────────────────────────────────────────────────

function clearChatSelection(): void {
  if (selectedChatIds.size === 0) return;
  selectedChatIds.clear();
  lastSelectedChatId = null;
  document.querySelectorAll<HTMLElement>('.chat-item-row--selected').forEach((el) => {
    el.classList.remove('chat-item-row--selected');
  });
}

function toggleChatSelected(chatId: string): void {
  if (selectedChatIds.has(chatId)) {
    selectedChatIds.delete(chatId);
  } else {
    selectedChatIds.add(chatId);
    lastSelectedChatId = chatId;
  }
  updateSelectionVisuals();
}

function selectRangeTo(toId: string): void {
  const list = document.getElementById('chatList');
  if (!list || !lastSelectedChatId) {
    selectedChatIds.add(toId);
    lastSelectedChatId = toId;
    updateSelectionVisuals();
    return;
  }
  const rows = [...list.querySelectorAll<HTMLElement>('.chat-item-row[data-chat-id]')];
  const fromIdx = rows.findIndex((r) => r.dataset.chatId === lastSelectedChatId);
  const toIdx = rows.findIndex((r) => r.dataset.chatId === toId);
  if (fromIdx < 0 || toIdx < 0) {
    selectedChatIds.add(toId);
    lastSelectedChatId = toId;
    updateSelectionVisuals();
    return;
  }
  const [lo, hi] = fromIdx <= toIdx ? [fromIdx, toIdx] : [toIdx, fromIdx];
  for (let i = lo; i <= hi; i++) {
    const id = rows[i].dataset.chatId;
    if (id) selectedChatIds.add(id);
  }
  updateSelectionVisuals();
}

function updateSelectionVisuals(): void {
  const list = document.getElementById('chatList');
  if (!list) return;
  list.querySelectorAll<HTMLElement>('.chat-item-row[data-chat-id]').forEach((row) => {
    row.classList.toggle('chat-item-row--selected', selectedChatIds.has(row.dataset.chatId ?? ''));
  });
}

/** Refresh composer model UI from the active chat (default #modelSelect stays put). */
export function syncModelSelectForActiveChat(): void {
  syncActiveChatModelUi();
}

export { onActiveChatModelChange };

/** Global default model changed via header picker or menubar chip. */
export async function onModelSelectChange(): Promise<void> {
  const sel = document.getElementById('modelSelect') as HTMLSelectElement;
  const savingDefault = persistDefaultModelValue(sel.value).catch((error) => {
    setStatus('err', (error as Error).message);
  });
  updateModelStateDot(sel.value);
  updateModelLoadUnloadButtons();
  syncModelSelectPicker();
  showCachedModelInfo();
  scheduleCapabilityProbeForSelectValue(sel.value);
  const active = getActiveChat();
  if (isEphemeralEmptyChat(active)) {
    applyDefaultModelToChat(active);
    touchChat(active);
    scheduleSaveSessions();
  }
  syncActiveChatModelUi();
  await savingDefault;
}

// ── Workspace ────────────────────────────────────────────────────────────────

/** Refresh main column after workspace folder changes. */
export async function applyWorkspaceScopedSession(
  newPath: string,
  previousPath?: string,
  options?: { skipFileTreeSync?: boolean },
): Promise<void> {
  clearChatSelection();
  exitBoardViewForNavigation();
  invalidateComposerUndoGitCache();
  const { activeChat, activeChanged } = await onWorkspaceChanged(newPath, previousPath);
  if (activeChanged) {
    clearAttachments();
    recordChatOpened(activeChat.id);
    syncModelSelectForActiveChat();
    renderChatFromHistory(activeChat);
    renderStatsForChat(activeChat);
    syncModeSelectorFromActiveChat();
    syncComposerReasoningEffortFromActiveChat();
    void syncOrchestratePlanStripFromActiveChat();
    syncComposerPinnedSkillFromActiveChat();
    syncChatLinkChipsFromActiveChat();
    syncComposerRunTargetFromActiveChat();
    syncComposerUndoFromActiveChat();
    syncViewModeToggleFromActiveChat();
    if (!options?.skipFileTreeSync) {
      clearPanelCwdUserOverride();
      syncPanelFromActiveChat({ forceFileTree: true });
    }
    syncWorkAgentDevFromActiveChat();
    onModelRoutingActiveChatChanged(activeChat.id);
    void import('./terminal-panel').then((m) => m.refreshTerminalHistoryForActiveChat());
  }
  renderSidebar();
}

interface AppendChatRowOptions {
  /** Workspace chats can be dragged onto groups or chats; Unassigned rows cannot. */
  draggable?: boolean;
  /** Compact name-only row when listed under a sidebar group. */
  inGroup?: boolean;
  /** Offer Pin / Unpin in the row menu (main sidebar workspace chats only). */
  pinnable?: boolean;
  /** Board folder for resolving task category icons on in-group rows. */
  group?: import('../types').ChatGroup;
  /** Override default switchChat activation (e.g. Experts hub before shell opens). */
  onActivate?: (chat: Chat) => void;
  /** Override default deleteChat (e.g. Experts hub detail list refresh). */
  onDelete?: (chat: Chat) => void;
}

/** Board task category for a chat row (from group board state, not stored on Chat). */
function boardCategoryForChat(
  chat: Chat,
  group?: import('../types').ChatGroup,
): import('../types').BoardCategory | undefined {
  const taskId = chat.boardTaskId?.trim();
  if (!taskId || !group?.orchestrateBoard) return undefined;
  return group.orchestrateBoard.tasks.find((t) => t.id === taskId)?.category;
}

/** Sidebar row highlight id; suppressed while a board folder owns the main column. */
function sidebarHighlightChatId(): string | null {
  if (!sessionState) return null;
  const boardGroup = getActiveBoardGroup();
  if (boardGroup?.viewMode === 'board') return null;
  return sessionState.activeId;
}

// ── Rows ─────────────────────────────────────────────────────────────────────

/** The model an agent chat actually runs on, else the one it asked for. */
function chatAgentModelId(chat: Chat): string {
  return chat.agentExecution?.resolvedModel?.modelId?.trim() || chat.modelId?.trim() || '';
}

const LIVE_AGENT_STATES: ReadonlySet<AgentMarkState> = new Set(['queued', 'running', 'waiting']);

/** Agent rows tick their clocks from one shared timer that stops once none are live. */
let agentClockTimer: ReturnType<typeof setInterval> | null = null;

function tickAgentClocks(): void {
  const clocks = document.querySelectorAll<HTMLElement>('.chat-item-agent-clock[data-started-at]');
  for (const clock of clocks) clock.textContent = formatWorkDuration(Math.max(0, Date.now() - Number(clock.dataset.startedAt)));
  if (!clocks.length && agentClockTimer != null) { clearInterval(agentClockTimer); agentClockTimer = null; }
}

/** Live: time since the execution began, ticking. Settled: how long it took. */
function syncAgentClock(clock: HTMLElement, chat: Chat, state: AgentMarkState): void {
  const execution = chat.agentExecution;
  const startedAt = execution?.createdAt;
  delete clock.dataset.startedAt;
  clock.textContent = '';
  if (!startedAt) return;
  if (LIVE_AGENT_STATES.has(state)) {
    clock.dataset.startedAt = String(startedAt);
    clock.textContent = formatWorkDuration(Math.max(0, Date.now() - startedAt));
    if (agentClockTimer == null && typeof setInterval === 'function') {
      agentClockTimer = setInterval(tickAgentClocks, 1000);
      (agentClockTimer as { unref?: () => void }).unref?.();
    }
  } else if (execution?.settledAt && execution.settledAt >= startedAt) {
    clock.textContent = formatWorkDuration(execution.settledAt - startedAt);
  }
}

/** Under a parent: its agents' provider stack and a one-line tally, beside the disclosure. */
function syncAgentSummary(row: HTMLElement, children: readonly Chat[], running: (id: string) => boolean, toggle: HTMLElement): void {
  let summary = row.querySelector<HTMLElement>(':scope > .chat-item-agent-summary');
  if (!summary) {
    summary = document.createElement('div'); summary.className = 'chat-item-agent-summary';
    const stack = document.createElement('span'); stack.className = 'agent-mark-stack'; stack.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span'); label.className = 'chat-item-agent-summary__label';
    summary.append(stack, label);
    row.append(summary);
  }
  if (summary.firstElementChild !== toggle) summary.prepend(toggle);
  const states = children.map(child => agentMarkStateFromLabel(agentChatStatusLabel(child, running)));
  const working = states.filter(state => state === 'running').length;
  const waiting = states.filter(state => state === 'waiting' || state === 'queued').length;
  const failed = states.filter(state => state === 'failed').length;
  syncAgentMarkStack(summary.querySelector<HTMLElement>('.agent-mark-stack')!, children.map(chatAgentModelId));
  summary.dataset.live = String(working > 0);
  summary.querySelector('.chat-item-agent-summary__label')!.textContent = [
    `${children.length} ${children.length === 1 ? 'agent' : 'agents'}`,
    working ? `${working} running` : '', waiting ? `${waiting} waiting` : '', failed ? `${failed} failed` : '',
    !working && !waiting && !failed ? 'all done' : '',
  ].filter(Boolean).join(' · ');
}

/** Session model line: the picker's producer logo + model label. */
function syncChatItemModel(modelEl: HTMLElement, chat: Chat): void {
  let chip = modelEl.querySelector<HTMLElement>(':scope > .agent-model-chip');
  if (!chip) {
    chip = createAgentModelChip();
    modelEl.replaceChildren(chip);
  }
  syncAgentModelChip(chip, chat.modelId ?? '', routerChatModelLabel(chat) || '\u2014');
  chip.removeAttribute('title');
}

/** Shared session row builder (main sidebar + expert-scoped list). */
export function appendChatRow(
  list: HTMLElement,
  chat: Chat,
  highlightChatId: string | null,
  options?: AppendChatRowOptions,
): void {
  list.appendChild(buildChatRow(chat, highlightChatId, options));
}

function buildChatRow(
  chat: Chat,
  highlightChatId: string | null,
  options?: AppendChatRowOptions,
): HTMLElement {
  const isActive = highlightChatId != null && chat.id === highlightChatId;
  const isSelected = selectedChatIds.has(chat.id);
  const inGroup = options?.inGroup === true;
  const modelLabel = routerChatModelLabel(chat) || 'No model selected';
  const codeChangeAria = inGroup ? '' : formatChatItemCodeChangeAria(chat);
  const isDraftOnly = getChatMessageCount(chat) === 0 && hasComposerDraft(chat);
  const displayName = isDraftOnly ? formatDraftChatSidebarName(chat) : chat.name;
  const rowLabel = inGroup
    ? displayName
    : `${displayName}, ${modelLabel}${codeChangeAria ? `, ${codeChangeAria}` : ''}`;

  const row = document.createElement('div');
  row.dataset.chatId = chat.id;
  row.className =
    'chat-item-row' +
    (isActive ? ' active' : '') +
    (inGroup ? ' chat-item-row--in-group' : '') +
    (isSelected ? ' chat-item-row--selected' : '') +
    (isDraftOnly ? ' chat-item-row--draft' : '');
  row.setAttribute('role', 'listitem');
  row.setAttribute('aria-label', rowLabel);
  row.title = [displayName, modelLabel, codeChangeAria].filter(Boolean).join('\n');
  row.tabIndex = 0;
  const currentChat = () => sessionState?.chats.find(entry => entry.id === chat.id) ?? chat;
  const prefetchHistoryOnIntent = () => {
    if (currentChat().historyLoaded === false) {
      void ensureChatHistoryLoaded(chat.id);
    }
  };
  // Intent, not transit: sweeping the pointer down the list used to fetch and parse
  // every transcript it crossed, saturating the renderer's six sockets mid-stream.
  let hoverPrefetchTimer: ReturnType<typeof setTimeout> | undefined;
  row.addEventListener('pointerenter', () => {
    clearTimeout(hoverPrefetchTimer);
    hoverPrefetchTimer = setTimeout(prefetchHistoryOnIntent, HOVER_PREFETCH_DELAY_MS);
  });
  row.addEventListener('pointerleave', () => clearTimeout(hoverPrefetchTimer));
  row.addEventListener('focus', prefetchHistoryOnIntent);
  if (options?.draggable !== false) {
    row.draggable = true;
    row.classList.add('chat-item-row--draggable');
  } else row.draggable = false;
  row.addEventListener('click', (e) => {
    if ((e.target as Element).closest('.chat-rename-input, button, a')) return;
    if (e.shiftKey) {
      e.preventDefault();
      selectRangeTo(chat.id);
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      toggleChatSelected(chat.id);
      return;
    }
    clearChatSelection();
    lastSelectedChatId = chat.id;
    if (options?.onActivate) {
      options.onActivate(currentChat());
      return;
    }
    switchChat(chat.id);
  });
  row.addEventListener('keydown', (e) => {
    if ((e.target as Element).closest('.chat-rename-input, button, a')) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      clearChatSelection();
      lastSelectedChatId = chat.id;
      if (options?.onActivate) {
        options.onActivate(currentChat());
        return;
      }
      switchChat(chat.id);
    }
    if (e.key === 'Escape') {
      clearChatSelection();
    }
  });

  const head = document.createElement('div');
  head.className = 'chat-item-head';

  const titleRow = document.createElement('div');
  titleRow.className = 'chat-item-title-row';

  const boardCategory = inGroup ? boardCategoryForChat(chat, options?.group) : undefined;

  const dotCtx = getChatItemDotContext(sessionState?.activeId ?? null);
  const dotState = resolveChatItemDotState(chat, dotCtx);
  if (!inGroup) {
    const dot = document.createElement('div');
    dot.className = 'chat-item-dot';
    dot.setAttribute('aria-hidden', 'true');
    applyChatItemDotClasses(dot, dotState, row);
    titleRow.appendChild(dot);
  } else if (isChatItemDotVisible(dotState)) {
    row.dataset.dotState = dotState;
  }

  const nameSpan = document.createElement('span');
  nameSpan.className = 'chat-item-name';
  nameSpan.textContent = displayName;
  if (isDraftOnly) {
    nameSpan.title = 'Unsent draft';
  }

  if (boardCategory) {
    const catIcon = createBoardCategoryIcon(boardCategory, 'chat-item-board-cat-icon');
    if (catIcon) titleRow.appendChild(catIcon);
  }
  titleRow.appendChild(nameSpan);

  const loopIcon = createChatItemLoopIcon();
  applyChatItemLoopIcon(loopIcon, resolveChatItemLoopIconState(chat), chat);
  titleRow.appendChild(loopIcon);

  head.appendChild(titleRow);

  row.addEventListener('contextmenu', (e) => {
    if ((e.target as Element).closest('.chat-rename-input')) return;
    e.preventDefault();
    if (selectedChatIds.size > 1 && selectedChatIds.has(chat.id)) {
      showMultiSelectContextMenu(e.clientX, e.clientY, [...selectedChatIds]);
    } else {
      showChatItemContextMenu(e.clientX, e.clientY, currentChat(), nameSpan, options);
    }
  });

  row.appendChild(head);
  if (!inGroup) {
    const modelEl = document.createElement('div');
    modelEl.className = 'chat-item-model';
    syncChatItemModel(modelEl, chat);

    row.appendChild(modelEl);
    if (hasCodeChangeTotals(chat.codeChangeTotals)) {
      const statsEl = document.createElement('div');
      statsEl.className = 'chat-item-stats';
      const statsFrag = document.createDocumentFragment();
      appendChatItemCodeChangeStats(statsFrag, chat, chat.codeChangeTotals!);
      statsEl.appendChild(statsFrag);
      row.appendChild(statsEl);
    }
  }
  row.dataset.rowLayout = inGroup ? 'group' : 'flat';
  row.dataset.boardCategory = boardCategory ?? '';
  syncChatItemWorktreeIcon(row, chat);
  return row;
}

function appendGroupHeader(
  _list: HTMLElement,
  group: import('../types').ChatGroup,
  members: Chat[],
  memberCount: number,
): HTMLElement {
  const head = document.createElement('div');
  head.className = 'chat-group-header';
  const isActiveBoardFolder =
    Boolean(group.orchestrateBoard) &&
    sessionState?.activeBoardGroupId === group.id &&
    group.viewMode === 'board';
  if (group.orchestrateBoard) {
    head.classList.add('chat-group-header--has-board');
  }
  if (isActiveBoardFolder) {
    head.classList.add('active');
    head.setAttribute('aria-current', 'true');
  }
  head.dataset.groupId = group.id;
  head.dataset.hasBoard = group.orchestrateBoard ? '1' : '0';
  head.title = group.name;
  const membersHidden = group.collapsed;
  head.setAttribute('aria-expanded', membersHidden ? 'false' : 'true');

  const icon = createIcon(
    group.orchestrateBoard ? 'modeOrchestrate' : 'folder',
    { className: 'chat-group-header__icon', size: 14 },
  );

  const caret = document.createElement('button');
  caret.type = 'button';
  caret.className = 'chat-group-header__caret';
  caret.setAttribute('aria-expanded', membersHidden ? 'false' : 'true');
  caret.setAttribute(
    'aria-label',
    membersHidden ? 'Expand group chats' : 'Collapse group chats',
  );
  caret.textContent = membersHidden ? '▸' : '▾';
  caret.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleGroupCollapsed(group.id);
    renderSidebar();
  });

  const nameSpan = document.createElement('span');
  nameSpan.className = 'chat-group-header__name';
  nameSpan.textContent = group.name;

  const count = document.createElement('span');
  count.className = 'chat-group-header__count';
  count.textContent = String(memberCount);

  const dotCtx = getChatItemDotContext(sessionState?.activeId ?? null);
  applyGroupHeaderDotClasses(head, resolveGroupHeaderDotState(members, dotCtx));

  head.appendChild(icon);
  head.appendChild(caret);
  head.appendChild(nameSpan);
  head.appendChild(count);

  head.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showGroupContextMenu(e.clientX, e.clientY, group.id, nameSpan);
  });

  if (group.orchestrateBoard) {
    head.addEventListener('click', (e) => {
      if ((e.target as Element).closest('.chat-group-header__caret')) return;
      openBoardGroup(group.id);
      renderSidebar();
      syncViewModeToggleFromActiveChat();
    });
  }

  return head;
}

function showGroupContextMenu(
  x: number,
  y: number,
  groupId: string,
  nameSpan: HTMLSpanElement,
): void {
  const existing = document.getElementById('chatGroupContextMenu');
  existing?.remove();

  const menu = document.createElement('div');
  menu.id = 'chatGroupContextMenu';
  menu.className = 'chat-group-context-menu';
  markPreviewOccluder(menu, 'menu');
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;

  const renameItem = document.createElement('button');
  renameItem.type = 'button';
  renameItem.textContent = 'Rename';
  renameItem.addEventListener('click', (e) => {
    e.stopPropagation();
    menu.remove();
    beginRenameGroup(groupId, nameSpan);
  });

  const deleteItem = document.createElement('button');
  deleteItem.type = 'button';
  deleteItem.textContent = 'Delete group';
  deleteItem.addEventListener('click', (e) => {
    e.stopPropagation();
    menu.remove();
    void (async () => {
      const group = findGroupById(groupId);
      const isBoardGroup = Boolean(group?.orchestrateBoard);
      if (isBoardGroup) {
        const chatCount = group ? listBoardGroupChatIds(group, sessionState?.chats ?? []).length : 0;
        const chatLabel = chatCount === 1 ? '1 chat' : `${chatCount} chats`;
        if (
          !(await appConfirm(
            `Delete this board and ${chatLabel} inside it? This cannot be undone.`,
            { confirmLabel: 'Delete', danger: true },
          ))
        ) {
          return;
        }
        if (sessionState?.activeBoardGroupId === groupId) {
          exitBoardViewForNavigation();
        }
        if (!group) return;
        for (const chatId of listBoardGroupChatIds(group, sessionState?.chats ?? [])) {
          if (isChatStreaming(chatId)) {
            stopGeneration(chatId, 'system');
          }
        }
      } else if (
        !(await appConfirm('Delete this group? Chats will stay in the list, ungrouped.', {
          confirmLabel: 'Delete',
          danger: true,
        }))
      ) {
        return;
      }
      const { modelId } = readDefaultModelBinding();
      const result = deleteGroup(groupId, { fallbackModelId: modelId });
      if (result.chatRemoval) {
        onChatRemoved({ ...result.chatRemoval, activeChanged: result.activeChanged });
      } else {
        refreshSessionListUIs();
        if (isOrchestrateHubMounted()) {
          refreshOrchestrateHubBoardList();
        }
      }
    })();
  });

  menu.appendChild(renameItem);
  menu.appendChild(deleteItem);
  document.body.appendChild(menu);

  const close = (): void => {
    menu.remove();
    document.removeEventListener('click', close);
  };
  window.setTimeout(() => document.addEventListener('click', close), 0);
}

function beginRenameGroup(groupId: string, nameSpan: HTMLSpanElement): void {
  const groups = sessionState?.groups ?? [];
  const group = groups.find((g) => g.id === groupId);
  if (!group) return;
  const inp = document.createElement('input');
  inp.type = 'text';
  inp.className = 'chat-rename-input';
  inp.value = group.name;
  inp.maxLength = 80;
  nameSpan.replaceWith(inp);
  inp.focus();
  inp.select();
  const finish = (): void => {
    renameGroup(groupId, inp.value);
    inp.replaceWith(nameSpan);
    nameSpan.textContent = group.name;
    renderSidebar();
  };
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') inp.blur();
    if (e.key === 'Escape') {
      inp.value = group.name;
      inp.blur();
    }
  });
  inp.addEventListener('blur', finish, { once: true });
}

// ── Render ───────────────────────────────────────────────────────────────────

/** Wire "+ New group" and chat drag-drop (call once at init). */
export function wireSidebarNewGroupButton(): void {
  void import('./sidebar-chat-dnd').then((m) => m.wireSidebarChatDragDrop());

  const btn = document.getElementById('btnNewChatGroup');
  if (!btn || btn.dataset.wired === '1') return;
  btn.dataset.wired = '1';

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && selectedChatIds.size > 0) clearChatSelection();
  });
  btn.addEventListener('click', () => {
    const g = createGroup('New group', getWorkspacePath());
    renderSidebar();
    const head = document.querySelector(
      `.chat-group-header[data-group-id="${g.id}"] .chat-group-header__name`,
    );
    if (head instanceof HTMLSpanElement) beginRenameGroup(g.id, head);
  });
}

/** Rebuild the session list in the left sidebar (workspace-scoped + Unassigned). */

/** Update draft-only chat row labels without rebuilding the sidebar (composer typing). */
export function syncComposerDraftSidebarLabels(chat: Chat): void {
  if (getChatMessageCount(chat) !== 0 || !hasComposerDraft(chat)) return;
  const displayName = formatDraftChatSidebarName(chat);
  const modelLabel = routerChatModelLabel(chat) || 'No model selected';
  const rows = document.querySelectorAll<HTMLElement>(
    `.chat-item-row[data-chat-id="${chat.id}"]`,
  );
  for (const row of rows) {
    const nameSpan = row.querySelector('.chat-item-name');
    if (nameSpan?.textContent === displayName) continue;
    if (nameSpan) nameSpan.textContent = displayName;
    row.classList.add('chat-item-row--draft');
    row.setAttribute('aria-label', `${displayName}, ${modelLabel}`);
    row.title = [displayName, modelLabel].filter(Boolean).join('\n');
    syncChatItemWorktreeIcon(row, chat);
  }
}

function chatRowReusable(
  row: HTMLElement,
  chat: Chat,
  options?: AppendChatRowOptions,
): boolean {
  const inGroup = options?.inGroup === true;
  if (row.dataset.rowLayout !== (inGroup ? 'group' : 'flat')) return false;
  const wantDrag = options?.draggable !== false;
  if (row.classList.contains('chat-item-row--draggable') !== wantDrag) return false;
  const boardCategory = inGroup ? boardCategoryForChat(chat, options?.group) : undefined;
  return (row.dataset.boardCategory ?? '') === (boardCategory ?? '');
}

function syncChatRow(
  row: HTMLElement,
  chat: Chat,
  highlightChatId: string | null,
  options?: AppendChatRowOptions,
): void {
  const isActive = highlightChatId != null && chat.id === highlightChatId;
  const isSelected = selectedChatIds.has(chat.id);
  const inGroup = options?.inGroup === true;
  const modelLabel = routerChatModelLabel(chat) || 'No model selected';
  const codeChangeAria = inGroup ? '' : formatChatItemCodeChangeAria(chat);
  const isDraftOnly = getChatMessageCount(chat) === 0 && hasComposerDraft(chat);
  const displayName = isDraftOnly ? formatDraftChatSidebarName(chat) : chat.name;
  const rowLabel = inGroup
    ? displayName
    : `${displayName}, ${modelLabel}${codeChangeAria ? `, ${codeChangeAria}` : ''}`;

  row.classList.toggle('active', isActive);
  row.classList.toggle('chat-item-row--in-group', inGroup);
  row.classList.toggle('chat-item-row--selected', isSelected);
  row.classList.toggle('chat-item-row--draft', isDraftOnly);
  row.setAttribute('aria-label', rowLabel);
  row.title = [displayName, modelLabel, codeChangeAria].filter(Boolean).join('\n');

  const nameSpan = row.querySelector<HTMLElement>('.chat-item-name');
  if (nameSpan) {
    nameSpan.textContent = displayName;
    if (isDraftOnly) nameSpan.title = 'Unsent draft';
    else nameSpan.removeAttribute('title');
  }

  syncChatItemWorktreeIcon(row, chat);

  const modelEl = row.querySelector<HTMLElement>('.chat-item-model');
  if (modelEl) syncChatItemModel(modelEl, chat);

  let statsEl = row.querySelector<HTMLElement>('.chat-item-stats');
  if (!inGroup && hasCodeChangeTotals(chat.codeChangeTotals)) {
    if (!statsEl) {
      statsEl = document.createElement('div');
      statsEl.className = 'chat-item-stats';
      // Beside the model chip, ahead of any agent meta or summary lines.
      if (modelEl) modelEl.after(statsEl); else row.appendChild(statsEl);
    }
    statsEl.replaceChildren();
    const statsFrag = document.createDocumentFragment();
    appendChatItemCodeChangeStats(statsFrag, chat, chat.codeChangeTotals!);
    statsEl.appendChild(statsFrag);
  } else {
    statsEl?.remove();
  }
}

function syncGroupHeader(
  head: HTMLElement,
  group: import('../types').ChatGroup,
  members: Chat[],
  memberCount: number,
): void {
  const isActiveBoardFolder =
    Boolean(group.orchestrateBoard) &&
    sessionState?.activeBoardGroupId === group.id &&
    group.viewMode === 'board';
  head.classList.toggle('chat-group-header--has-board', Boolean(group.orchestrateBoard));
  head.classList.toggle('active', isActiveBoardFolder);
  if (isActiveBoardFolder) head.setAttribute('aria-current', 'true');
  else head.removeAttribute('aria-current');
  head.title = group.name;
  const membersHidden = group.collapsed;
  head.setAttribute('aria-expanded', membersHidden ? 'false' : 'true');
  const caret = head.querySelector<HTMLButtonElement>('.chat-group-header__caret');
  if (caret) {
    caret.setAttribute('aria-expanded', membersHidden ? 'false' : 'true');
    caret.setAttribute(
      'aria-label',
      membersHidden ? 'Expand group chats' : 'Collapse group chats',
    );
    caret.textContent = membersHidden ? '▸' : '▾';
  }
  const nameSpan = head.querySelector('.chat-group-header__name');
  if (nameSpan) nameSpan.textContent = group.name;
  const count = head.querySelector('.chat-group-header__count');
  if (count) count.textContent = String(memberCount);
  const dotCtx = getChatItemDotContext(sessionState?.activeId ?? null);
  applyGroupHeaderDotClasses(head, resolveGroupHeaderDotState(members, dotCtx));
}

/** Reorder existing nodes in place so CSS animations on reused rows are not restarted. */
function reconcileChildren(parent: HTMLElement, desired: HTMLElement[]): void {
  let next: ChildNode | null = parent.firstChild;
  for (const node of desired) {
    if (next !== node) parent.insertBefore(node, next);
    next = node.nextSibling;
  }
  while (next) {
    const gone = next;
    next = next.nextSibling;
    gone.remove();
  }
}

function buildChatListSectionHead(title: string, count: number): HTMLElement {
  const head = document.createElement('div');
  head.className = 'chat-list-section-head';
  head.dataset.section = title.toLowerCase();
  head.setAttribute('role', 'presentation');
  const titleEl = document.createElement('span');
  titleEl.className = 'chat-list-section-title';
  titleEl.textContent = title;
  const badge = document.createElement('span');
  badge.className = 'chat-list-section-badge';
  badge.textContent = String(count);
  badge.setAttribute('aria-hidden', 'true');
  head.append(titleEl, badge);
  return head;
}

let sidebarRenderFrame: number | null = null;

/** Coalesce hot-path sidebar paints onto one animation frame (MIN-584). */
export function scheduleRenderSidebar(): void {
  if (typeof requestAnimationFrame !== 'function') {
    renderSidebar();
    return;
  }
  if (sidebarRenderFrame != null) return;
  sidebarRenderFrame = requestAnimationFrame(() => {
    sidebarRenderFrame = null;
    renderSidebar();
  });
}

function cancelScheduledSidebarRender(): void {
  if (sidebarRenderFrame == null) return;
  if (typeof cancelAnimationFrame === 'function') {
    cancelAnimationFrame(sidebarRenderFrame);
  }
  sidebarRenderFrame = null;
}

const sidebarRenderListeners = new Set<() => void>();
const expandedAgentChats = new Map<string, boolean>();
const expandedPreviousAgents = new Map<string, boolean>();
const agentPageSizes = new Map<string, number>();
let revealedAgentChatId: string | null = null;

export function resetSidebarAgentNavigationForTests(): void {
  expandedAgentChats.clear(); expandedPreviousAgents.clear(); agentPageSizes.clear(); revealedAgentChatId = null;
}

/** Relationship state survives keyed updates and ordinary chat navigation. */
function agentSidebarBranches(list: HTMLElement, relationships: ChatRelationships, activeId: string | null,
  takeRow: (chat: Chat, options?: AppendChatRowOptions) => HTMLElement): (chat: Chat, options?: AppendChatRowOptions) => HTMLElement[] {
  const running = (id: string) => isChatStreaming(id) || isChatRunningRemotely(id);
  const existing = new Map<string, HTMLElement>();
  list.querySelectorAll<HTMLElement>('[data-agent-key]').forEach(node => existing.set(node.dataset.agentKey!, node));
  const ancestors = activeId ? relationships.ancestors(activeId) : [];
  const priorityIds = new Set([...ancestors.map(chat => chat.id), ...(activeId ? [activeId] : [])]);
  const activeIds = new Set<string>();
  for (const chat of relationships.byId.values()) {
    if (!isAgentChatActive(chat, running)) continue;
    activeIds.add(chat.id);
    for (const ancestor of relationships.ancestors(chat.id)) activeIds.add(ancestor.id);
  }
  for (const map of [expandedAgentChats, expandedPreviousAgents, agentPageSizes]) {
    for (const id of map.keys()) if (!relationships.byId.has(id.split(':')[0]!)) map.delete(id);
  }
  if (activeId !== revealedAgentChatId) {
    revealedAgentChatId = activeId;
    for (const ancestor of ancestors) { expandedAgentChats.set(ancestor.id, true); expandedPreviousAgents.set(ancestor.id, true); }
    const root = ancestors[0];
    const group = root?.groupId ? findGroupById(root.groupId) : undefined;
    if (group?.collapsed) toggleGroupCollapsed(group.id);
  }
  const take = (key: string, tag = 'div'): HTMLElement => {
    const node = existing.get(key) ?? document.createElement(tag);
    node.dataset.agentKey = key; existing.delete(key); return node;
  };
  const button = (key: string, text: string, expanded: boolean | null, action: () => void): HTMLButtonElement => {
    const node = take(key, 'button') as HTMLButtonElement;
    node.type = 'button'; node.className = 'chat-agent-disclosure'; node.textContent = text;
    if (expanded !== null) node.setAttribute('aria-expanded', String(expanded));
    node.onclick = event => { event.stopPropagation(); action(); renderSidebar(); };
    return node;
  };
  return (root, rootOptions) => {
    const output: HTMLElement[] = [];
    const jobs = [{ chat: root, options: rootOptions, depth: 0, output }];
    const pending: { parent: HTMLElement; children: HTMLElement[] }[] = [];
    const trailing: { target: HTMLElement[]; more: HTMLElement }[] = [];
    const sections: { target: HTMLElement[]; nodes: HTMLElement[] }[] = [];
    for (let i = 0; i < jobs.length; i++) {
      const { chat, options, depth, output: nodes } = jobs[i]!;
      const child = Boolean(chat.agentConversation);
      const row = takeRow(chat, child ? { ...options, draggable: false, pinnable: false } : options);
      nodes.push(row);
      row.classList.toggle('chat-item-row--agent', child);
      row.style.setProperty('--agent-depth', String(Math.min(depth, AGENT_VISUAL_DEPTH_LIMIT)));
      if (child) {
        let meta = row.querySelector<HTMLElement>('.chat-item-agent-meta');
        if (!meta) {
          meta = document.createElement('div'); meta.className = 'chat-item-agent-meta';
          const text = document.createElement('span'); text.className = 'chat-item-agent-meta__text';
          const clock = document.createElement('span'); clock.className = 'chat-item-agent-clock';
          meta.append(text, clock); row.append(meta);
        }
        const missing = !relationships.parentById.has(chat.id) && Boolean(chat.agentConversation?.parentChatId || chat.agentConversation?.missingParent);
        const status = agentChatStatusLabel(chat, running);
        const state = agentMarkStateFromLabel(status);
        // Model · status · clock reads as one instrument line; the agent type moves to the label.
        const metaText = [routerChatModelLabel(chat) || null, status, missing ? 'Parent unavailable' : null].filter(Boolean).join(' · ');
        meta.querySelector('.chat-item-agent-meta__text')!.textContent = metaText;
        syncAgentClock(meta.querySelector<HTMLElement>('.chat-item-agent-clock')!, chat, state);
        let mark = row.querySelector<HTMLElement>(':scope > .chat-item-agent-mark');
        if (!mark) { mark = createAgentMark('chat-item-agent-mark'); row.prepend(mark); }
        syncAgentMark(mark, chatAgentModelId(chat), state);
        const described = [chat.agentTypeId, metaText].filter(Boolean).join(' · ');
        row.setAttribute('aria-label', `${row.getAttribute('aria-label')}, ${described}`);
        row.title += `\n${chatReadOnlyReason(chat) ?? described}`;
      } else { row.querySelector('.chat-item-agent-meta')?.remove(); row.querySelector('.chat-item-agent-mark')?.remove(); }
      const children = relationships.children.get(chat.id) ?? [];
      if (!children.length) { row.querySelector('.chat-agent-toggle')?.remove(); row.querySelector(':scope > .chat-item-agent-summary')?.remove(); continue; }
      const activeChildren = children.filter(entry => activeIds.has(entry.id));
      const previousChildren = children.filter(entry => !activeIds.has(entry.id));
      if (!expandedAgentChats.has(chat.id)) expandedAgentChats.set(chat.id, activeChildren.length > 0);
      const expanded = expandedAgentChats.get(chat.id) ?? activeChildren.length > 0;
      const toggle = button(`toggle:${chat.id}`, expanded ? '▾' : '▸', expanded,
        () => expandedAgentChats.set(chat.id, !expanded));
      toggle.classList.add('chat-agent-toggle');
      toggle.setAttribute('aria-label', `${expanded ? 'Collapse' : 'Expand'} ${children.length} agents of ${chat.name}`);
      syncAgentSummary(row, children, running, toggle);
      if (!expanded) continue;
      const group = take(`children:${chat.id}`);
      group.className = 'chat-agent-children'; group.style.setProperty('--agent-depth', String(Math.min(depth, AGENT_VISUAL_DEPTH_LIMIT))); group.setAttribute('role', 'group'); group.setAttribute('aria-label', `Agents of ${chat.name}`);
      nodes.push(group);
      const groupNodes: HTMLElement[] = [];
      pending.push({ parent: group, children: groupNodes });
      const enqueue = (entries: readonly Chat[], target: HTMLElement[], section: string) => {
        const sorted = sortAgentChats(entries, priorityIds);
        const key = `${chat.id}:${section}`;
        const limit = agentPageSizes.get(key) ?? AGENT_CHILD_PAGE_SIZE;
        for (const entry of sorted.slice(0, limit)) jobs.push({ chat: entry, options, depth: depth + 1, output: target });
        if (sorted.length > limit) {
          // Finalizers append this after the child branches have populated target.
          const more = button(`more:${key}`, `Show ${Math.min(AGENT_CHILD_PAGE_SIZE, sorted.length - limit)} more agents`, null,
            () => agentPageSizes.set(key, limit + AGENT_CHILD_PAGE_SIZE));
          more.classList.add('chat-agent-show-more');
          more.dataset.agentMore = key;
          trailing.push({ target, more });
        }
      };
      enqueue(activeChildren, groupNodes, 'active');
      if (previousChildren.length) {
        const open = expandedPreviousAgents.get(chat.id) ?? false;
        const previous = button(`previous:${chat.id}`, `${open ? '▾' : '▸'} Previous agents · ${previousChildren.length}`, open,
          () => expandedPreviousAgents.set(chat.id, !open));
        previous.classList.add('chat-agent-previous-toggle');
        // Keep section headings after active branches even when those are nested.
        const previousNodes: HTMLElement[] = [previous];
        if (open) {
          const body = take(`previous-body:${chat.id}`);
          body.className = 'chat-agent-previous'; body.setAttribute('role', 'group'); body.setAttribute('aria-label', `Previous agents of ${chat.name}`);
          previousNodes.push(body);
          const bodyNodes: HTMLElement[] = [];
          pending.push({ parent: body, children: bodyNodes });
          enqueue(previousChildren, bodyNodes, 'previous');
        }
        sections.push({ target: groupNodes, nodes: previousNodes });
      }
    }
    for (const { target, more } of trailing) target.push(more);
    for (const section of sections) section.target.push(...section.nodes);
    for (const entry of pending.reverse()) reconcileChildren(entry.parent, entry.children);
    return output;
  };
}

/** Called whenever the chat list re-renders: chats added, renamed, reordered or removed. */
export function subscribeSidebarRender(listener: () => void): () => void {
  sidebarRenderListeners.add(listener);
  return () => sidebarRenderListeners.delete(listener);
}

export function renderSidebar(): void {
  cancelScheduledSidebarRender();
  for (const listener of sidebarRenderListeners) {
    try {
      listener();
    } catch (error) {
      console.error('[sidebar] render listener threw', error);
    }
  }
  if (isExpertScopeActive() && sessionState) {
    const expertId = getExpertScopeId();
    if (expertId) {
      renderExpertScopeHeader(expertId);
      renderExpertScopeChatList(expertId, getActiveChat().id);
    }
    return;
  }

  const list = document.getElementById('chatList');
  if (!list || !sessionState) return;

  const existingRows = new Map<string, HTMLElement>();
  list.querySelectorAll<HTMLElement>('.chat-item-row[data-chat-id]').forEach((el) => {
    const id = el.dataset.chatId;
    if (id && !existingRows.has(id)) existingRows.set(id, el);
  });
  const existingHeaders = new Map<string, HTMLElement>();
  list.querySelectorAll<HTMLElement>('.chat-group-header[data-group-id]').forEach((el) => {
    const id = el.dataset.groupId;
    if (id && !existingHeaders.has(id)) existingHeaders.set(id, el);
  });
  const existingMembers = new Map<string, HTMLElement>();
  list.querySelectorAll<HTMLElement>('.chat-group-members[data-group-members]').forEach((el) => {
    const id = el.dataset.groupMembers;
    if (id && !existingMembers.has(id)) existingMembers.set(id, el);
  });
  const existingSectionHeads = new Map<string, HTMLElement>();
  list.querySelectorAll<HTMLElement>('.chat-list-section-head[data-section]').forEach((el) => {
    const id = el.dataset.section;
    if (id && !existingSectionHeads.has(id)) existingSectionHeads.set(id, el);
  });
  const takeSectionHead = (title: string, count: number): HTMLElement => {
    const prev = existingSectionHeads.get(title.toLowerCase());
    if (!prev) return buildChatListSectionHead(title, count);
    const badge = prev.querySelector('.chat-list-section-badge');
    if (badge) badge.textContent = String(count);
    return prev;
  };
  const existingEmpty = list.querySelector<HTMLElement>('.chat-list-empty');

  const ws = getWorkspacePath();
  const excludeAssistantChats = (chat: { workspacePath?: string }) =>
    !isChatsWorkspacePath(chat.workspacePath ?? '');
  const workspaceCandidates = getChatsForWorkspace(ws, sessionState)
    .filter((c) => !isHiddenFromMainSidebar(c))
    .filter((c) => !isBoardOwnedChat(c))
    .filter(excludeAssistantChats);
  const unassignedCandidates = getUnassignedChats(sessionState)
    .filter((c) => !isHiddenFromMainSidebar(c))
    .filter((c) => !isBoardOwnedChat(c))
    .filter(excludeAssistantChats);
  const relationships = projectChatRelationships([...workspaceCandidates, ...unassignedCandidates]);
  const workspaceIds = new Set(workspaceCandidates.map(chat => chat.id));
  const listedRoots = relationships.roots.filter(chat => isSidebarListedChat(chat) || relationships.children.has(chat.id));
  const workspaceChats = listedRoots.filter(chat => workspaceIds.has(chat.id));
  const highlightChatId = sidebarHighlightChatId();
  // A pinned chat lists once, up top — lifted out of its group until it is unpinned.
  const { pinned, rest: unpinnedChats } = splitPinnedChats(workspaceChats);
  const sidebarEntries = buildSortedWorkspaceSidebarEntries(
    getGroupsForWorkspace(ws).filter((g) => !isBoardOwnedGroup(g)),
    unpinnedChats,
  );

  const desired: HTMLElement[] = [];

  const takeRow = (chat: Chat, options?: AppendChatRowOptions): HTMLElement => {
    const prev = existingRows.get(chat.id);
    if (prev && chatRowReusable(prev, chat, options)) {
      syncChatRow(prev, chat, highlightChatId, options);
      existingRows.delete(chat.id);
      return prev;
    }
    existingRows.delete(chat.id);
    return buildChatRow(chat, highlightChatId, options);
  };
  const takeBranch = agentSidebarBranches(list, relationships, highlightChatId, takeRow);

  if (pinned.length) {
    desired.push(takeSectionHead('Pinned', pinned.length));
    for (const chat of pinned) {
      desired.push(...takeBranch(chat, { draggable: false, pinnable: true }));
    }
    if (sidebarEntries.length) desired.push(takeSectionHead('Chats', unpinnedChats.length));
  }

  for (const entry of sidebarEntries) {
    if (entry.kind === 'group') {
      const { group, members } = entry;
      const prevHead = existingHeaders.get(group.id);
      const wantBoard = Boolean(group.orchestrateBoard);
      let head: HTMLElement;
      if (prevHead && prevHead.dataset.hasBoard === (wantBoard ? '1' : '0')) {
        syncGroupHeader(prevHead, group, members, members.length);
        existingHeaders.delete(group.id);
        head = prevHead;
      } else {
        existingHeaders.delete(group.id);
        head = appendGroupHeader(list, group, members, members.length);
      }
      desired.push(head);

      const hideMembersInIconRail =
        sessionState.sidebarCollapsed === true && Boolean(group.orchestrateBoard);
      if (!group.collapsed && members.length > 0 && !hideMembersInIconRail) {
        let membersEl = existingMembers.get(group.id);
        if (!membersEl) {
          membersEl = document.createElement('div');
          membersEl.className = 'chat-group-members';
          membersEl.setAttribute('role', 'group');
        }
        existingMembers.delete(group.id);
        membersEl.dataset.groupMembers = group.id;
        membersEl.setAttribute('aria-label', `${group.name} chats`);
        if (group.orchestrateBoard) {
          membersEl.replaceChildren();
          appendBoardGroupWaveMembers(membersEl, group, members, highlightChatId);
        } else {
          const memberRows = members.flatMap((chat) =>
            takeBranch(chat, { inGroup: true, group, pinnable: true }),
          );
          reconcileChildren(membersEl, memberRows);
        }
        desired.push(membersEl);
      }
      continue;
    }
    desired.push(...takeBranch(entry.chat, { pinnable: true }));
  }

  const unassigned = listedRoots.filter(chat => !workspaceIds.has(chat.id));
  if (unassigned.length) {
    desired.push(takeSectionHead('Unassigned', unassigned.length));
    for (const chat of unassigned) {
      desired.push(...takeBranch(chat, { draggable: false }));
    }
  }
  if (desired.length === 0) {
    desired.push(existingEmpty ?? buildChatListEmptyState());
  }

  reconcileChildren(list, desired);
  syncChatItemDotsInDom();
  syncChatItemLoopIconsInDom();
}

function buildChatListEmptyState(): HTMLElement {
  const empty = document.createElement('div');
  empty.className = 'chat-list-empty';
  const title = document.createElement('p');
  title.className = 'chat-list-empty__title';
  title.textContent = 'No chats yet';
  const hint = document.createElement('p');
  hint.className = 'chat-list-empty__hint';
  hint.textContent = 'Start one to work on this folder with a model.';
  empty.append(title, hint);
  return empty;
}

// ── Menus ────────────────────────────────────────────────────────────────────

function showMultiSelectContextMenu(x: number, y: number, chatIds: string[]): void {
  const existing = document.getElementById('chatItemContextMenu');
  existing?.remove();

  const chats = chatIds
    .map((id) => sessionState?.chats.find((c) => c.id === id))
    .filter((c): c is Chat => c != null);
  if (!chats.length) return;

  const menu = document.createElement('div');
  menu.id = 'chatItemContextMenu';
  menu.className = 'chat-group-context-menu';
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;

  const label = document.createElement('div');
  label.className = 'chat-context-menu__multi-label';
  label.textContent = `${chats.length} chats selected`;
  menu.appendChild(label);

  const eligible = chats.filter((c) => !isChatStreaming(c.id) && getChatMessageCount(c) > 0);
  const brainItem = document.createElement('button');
  brainItem.type = 'button';
  brainItem.textContent = `Add ${eligible.length} to Brain`;
  brainItem.disabled = eligible.length === 0;
  if (eligible.length === 0) {
    brainItem.title = 'No eligible chats (must have messages and not be streaming)';
  }
  brainItem.addEventListener('click', () => {
    void runSettingsAction(brainItem, 'Adding to Brain…', async () => {
      const m = await import('./chat-brain-capture');
      for (const chat of eligible) await m.runChatBrainCapture(chat);
      menu.remove();
      clearChatSelection();
    });
  });

  const sep = document.createElement('div');
  sep.className = 'chat-context-menu__sep';

  const deletable = chats.filter((c) => !isChatStreaming(c.id));
  const deleteItem = document.createElement('button');
  deleteItem.type = 'button';
  deleteItem.textContent = `Delete ${deletable.length} chat${deletable.length === 1 ? '' : 's'}`;
  deleteItem.className = 'chat-context-menu__item--danger';
  deleteItem.disabled = deletable.length === 0;
  deleteItem.addEventListener('click', (e) => {
    e.stopPropagation();
    menu.remove();
    void (async () => {
      const n = deletable.length;
      if (!n) return;
      if (
        !(await appConfirm(`Delete ${n} chat${n === 1 ? '' : 's'}? This cannot be undone.`, {
          confirmLabel: 'Delete',
          danger: true,
        }))
      ) {
        return;
      }
      const prevActiveId = sessionState?.activeId;
      const { modelId } = readDefaultModelBinding();
      let lastResult: RemoveChatResult | null = null;
      for (const chat of deletable) {
        try {
          const r = await removeChatByIdAsync(chat.id, modelId);
          if (r.ok) { lastResult = r; selectedChatIds.delete(chat.id); if (lastSelectedChatId === chat.id) lastSelectedChatId = null; }
        } catch (error) { showToast(error instanceof Error ? error.message : 'Could not delete this conversation.', 'error'); break; }
      }
      updateSelectionVisuals();
      const activeChanged = prevActiveId !== sessionState?.activeId;
      if (lastResult) {
        onChatRemoved({ ...lastResult, activeChanged });
      } else {
        renderSidebar();
      }
    })();
  });

  menu.appendChild(brainItem);
  menu.appendChild(sep);
  menu.appendChild(deleteItem);
  document.body.appendChild(menu);

  const close = (): void => {
    menu.remove();
    document.removeEventListener('click', close);
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') close();
  };
  window.setTimeout(() => {
    document.addEventListener('click', close);
    document.addEventListener('keydown', onKey);
  }, 0);
}

function chatBrainCaptureState(chat: Chat): { disabled: boolean; title: string } {
  const streaming = isChatStreaming(chat.id);
  const empty = getChatMessageCount(chat) === 0;
  if (streaming) {
    return { disabled: true, title: 'Wait for reply to finish' };
  }
  if (empty) {
    return { disabled: true, title: 'Chat has no messages' };
  }
  return { disabled: false, title: 'Add to Brain' };
}

/** Extra behaviour for callers outside the sidebar (Orchestrate's chat rail). */
export interface ChatItemContextMenuOptions {
  /** Override default deleteChat (e.g. Experts hub detail list refresh). */
  onDelete?: (chat: Chat) => void;
  /** Drop "Open in orchestrator". */
  hideOrchestrateEntry?: boolean;
  /** Repaint after an inline rename commits. Defaults to the sidebar. */
  onRenamed?: (chat: Chat) => void;
  /** Offer Pin to top / Unpin. */
  pinnable?: boolean;
}

/** Shared chat-row actions, including portable transcript copy and export. */
export function showChatItemContextMenu(
  x: number,
  y: number,
  chat: Chat,
  nameSpan: HTMLSpanElement,
  options?: ChatItemContextMenuOptions,
): void {
  const existing = document.getElementById('chatItemContextMenu');
  existing?.remove();

  const menu = document.createElement('div');
  menu.id = 'chatItemContextMenu';
  menu.className = 'chat-group-context-menu';
  markPreviewOccluder(menu, 'menu');
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;

  const closeMenu = (): void => {
    menu.remove();
    document.removeEventListener('pointerdown', onPointerDownOutside, true);
    document.removeEventListener('keydown', onKey);
  };
  const onPointerDownOutside = (e: PointerEvent): void => {
    if (menu.contains(e.target as Node)) return;
    closeMenu();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') closeMenu();
  };

  const renameItem = document.createElement('button');
  renameItem.type = 'button';
  renameItem.textContent = 'Rename';
  renameItem.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    closeMenu();
    beginRenameChat(chat.id, nameSpan, options?.onRenamed);
  });

  let pinItem: HTMLButtonElement | null = null;
  if (options?.pinnable && !chat.agentConversation) {
    const pinned = isChatPinned(chat);
    pinItem = document.createElement('button');
    pinItem.type = 'button';
    pinItem.textContent = pinned ? 'Unpin' : 'Pin to top';
    pinItem.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      closeMenu();
      setChatPinned(chat, !pinned);
      renderSidebar();
    });
  }

  const brainState = chatBrainCaptureState(chat);
  const brainItem = document.createElement('button');
  brainItem.type = 'button';
  brainItem.textContent = 'Add to Brain';
  brainItem.title = brainState.title;
  brainItem.disabled = brainState.disabled;
  brainItem.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (brainState.disabled) return;
    void runSettingsAction(brainItem, 'Adding to Brain…', async () => {
      const m = await import('./chat-brain-capture');
      await m.runChatBrainCapture(chat);
      closeMenu();
    });
  });

  const isPlannerChat = normalizeModeId(chat.modeId) === 'orchestrate';
  let orchestrateItem: HTMLButtonElement | null = null;
  if (isPlannerChat && !options?.hideOrchestrateEntry) {
    orchestrateItem = document.createElement('button');
    orchestrateItem.type = 'button';
    orchestrateItem.textContent = 'Open in orchestrator';
    orchestrateItem.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      closeMenu();
      const group = getBoardGroupForChat(chat) ?? findBoardGroupForPlanner(chat.id);
      if (group && group.orchestrateBoard) {
        void import('../state/chat-groups').then((m) => m.openBoardGroup(group.id));
        return;
      }
      if (sessionState && sessionState.activeId !== chat.id) {
        switchChat(chat.id);
      }
      void import('./orchestrate-hub').then((m) => m.renderOrchestrateHub());
    });
  }

  const deleteItem = document.createElement('button');
  deleteItem.type = 'button';
  deleteItem.textContent = 'Delete';
  deleteItem.className = 'chat-context-menu__item--danger';
  deleteItem.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    closeMenu();
    if (options?.onDelete) {
      options.onDelete(chat);
      return;
    }
    void deleteChat(chat.id);
  });

  if (pinItem) menu.appendChild(pinItem);
  menu.appendChild(renameItem);
  const linkItem = document.createElement('button');
  linkItem.type = 'button'; linkItem.textContent = 'Copy chat link';
  linkItem.addEventListener('click', () => {
    closeMenu();
    const url = new URL(window.location.href); url.hash = chatLink(chat.id);
    void navigator.clipboard.writeText(url.href).then(() => showToast('Chat link copied'), () => showToast('Could not copy this chat link', 'error'));
  });
  menu.append(linkItem);
  if (chat.agentConversation?.parentChatId) {
    const parentItem = document.createElement('button');
    parentItem.type = 'button'; parentItem.textContent = 'Open parent';
    parentItem.addEventListener('click', () => {
      closeMenu(); void import('../os/chat-launch').then(module => module.launchCodeWithChat(chat.agentConversation!.parentChatId!));
    });
    menu.append(parentItem);
  }
  for (const [format, label] of [
    ['text', 'Copy chat transcript'],
    ['html', 'Export chat as HTML'],
  ] as const) {
    const item = document.createElement('button');
    item.type = 'button';
    item.textContent = label;
    item.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      closeMenu();
      void import('./chat-transcript-export').then((m) => m.runChatTranscriptExport(chat, format))
        .catch((error) => reportBackgroundError('chat-transcript-export', error));
    });
    menu.appendChild(item);
  }
  menu.appendChild(brainItem);
  if (orchestrateItem) menu.appendChild(orchestrateItem);
  menu.appendChild(deleteItem);
  document.body.appendChild(menu);

  // Extra actions must remain reachable near the bottom of the window.
  menu.style.maxHeight = `${Math.max(0, window.innerHeight - 16)}px`;
  menu.style.overflowY = 'auto';
  const bounds = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - bounds.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - bounds.height - 8))}px`;

  window.setTimeout(() => {
    document.addEventListener('pointerdown', onPointerDownOutside, true);
    document.addEventListener('keydown', onKey);
  }, 0);
}

function beginRenameChat(
  chatId: string,
  nameSpan: HTMLSpanElement,
  onRenamed?: (chat: Chat) => void,
): void {
  const chat = sessionState!.chats.find((c) => c.id === chatId);
  if (!chat) return;
  const inp = document.createElement('input');
  inp.type = 'text';
  inp.className = 'chat-rename-input';
  inp.value = chat.name;
  inp.maxLength = 120;
  inp.setAttribute('aria-label', 'Chat title');
  nameSpan.replaceWith(inp);
  inp.focus();
  inp.select();

  const finish = () => {
    const v = inp.value.trim();
    if (v) chat.name = v;
    inp.replaceWith(nameSpan);
    nameSpan.textContent = chat.name;
    touchChat(chat);
    if (onRenamed) {
      onRenamed(chat);
    } else {
      renderSidebar();
    }
    scheduleSaveSessions();
  };

  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      inp.blur();
    }
    if (e.key === 'Escape') {
      inp.value = chat.name;
      inp.blur();
    }
  });
  inp.addEventListener('blur', finish, { once: true });
}

/** Refresh every session list surface (Code sidebar, Chat app rail). */
function refreshSessionListUIs(): void {
  renderSidebar();
  void import('./chat-app').then((m) => m.refreshChatAppSessionRail());
}

/** Refresh sidebar and main chat UI after removeChatById. */
function onChatRemoved(result: RemoveChatResult): void {
  if (!result.ok) return;
  if (result.activeChanged) {
    clearAttachments();
    const active = result.activeChat;
    switchComposerDraft(result.removed?.id, active);
    syncAskQuestionModalOnChatSwitch(result.removed?.id ?? '', active.id);
    notifyAskQuestionDisplayContextChanged();
    recordChatOpened(active.id);
    syncModelSelectForActiveChat();
    renderStatsForChat(active);
    renderChatFromHistory(active);
    syncCreateChatChrome(active.id);
    syncComposerFromStreamingState();
  }
  refreshSessionListUIs();
  if (isOrchestrateHubMounted()) {
    refreshOrchestrateHubBoardList();
    void refreshOrchestrateHubPlanList();
  }
  closeMobileSidebar();
}

/** Render the active chat into the correct foreground shell (Chat app / Code). */
function paintActiveChatInForegroundShell(chat: Chat): void {
  if (isChatAppForeground()) {
    renderChatFromHistory(chat, '#chatAppMessageCol');
    return;
  }
  if (getSharedChatHost(chat.id)) { renderChatFromHistory(chat); return; }
  if (
    dismissCodeOverviewForNavigation() ||
    dismissDevServerScreenForNavigation()
  ) {
    renderChatFromHistory(chat);
    return;
  }
  renderChatFromHistory(chat);
}

// ── Switch ───────────────────────────────────────────────────────────────────

export async function deleteChat(chatId: string, evt?: Event): Promise<void> {
  if (evt) evt.stopPropagation();
  if (isChatStreaming(chatId)) {
    showToast('Finish the current reply first');
    return;
  }
  const idx = sessionState!.chats.findIndex((c) => c.id === chatId);
  if (idx < 0) return;
  const victim = sessionState!.chats[idx];
  const family = projectChatRelationships(sessionState!.chats);
  const descendants = sessionState!.chats.filter(chat => family.ancestors(chat.id).some(parent => parent.id === chatId));
  if ([victim, ...descendants].some(chat => hasUnsettledAgentWork(chat, id => isChatStreaming(id) || isChatRunningRemotely(id)))) {
    showToast('Stop this conversation and its agents, and resolve pending requests before deleting it.');
    return;
  }
  const victimLabel =
    getChatMessageCount(victim) === 0 && hasComposerDraft(victim)
      ? formatDraftChatSidebarName(victim)
      : victim.name;
  if (
    !(await appConfirm(`Delete "${victimLabel}"? Messages in this chat cannot be recovered.${descendants.length ? ` Its ${descendants.length === 1 ? 'agent chat stays' : `${descendants.length} agent chats stay`} available in the chat list.` : ''}`, {
      confirmLabel: 'Delete',
      danger: true,
    }))
  ) {
    return;
  }

  const { modelId } = readDefaultModelBinding();
  try { onChatRemoved(await removeChatByIdAsync(chatId, modelId)); }
  catch (error) { showToast(error instanceof Error ? error.message : 'Could not delete this conversation.', 'error'); }
}

export async function switchChat(id: string): Promise<void> {
  const sharedHost = getSharedChatHost(id);
  if (!sharedHost && document.getElementById('codeMapChatSidebar')) {
    teardownCodeBrainMapBeforeChatPaint();
  }
  if (!sharedHost) restoreChatColumnOnChatSelect();
  void import('../ui/chat-scroll').then((m) => m.invalidateChatScrollRootCache());
  void import('../agents/sub-agent-completion-push')
    .then((m) => m.flushAllPendingSubAgentCompletions())
    .catch((err) => reportBackgroundError('sub-agent-completion-flush', err));
  void import('../agents/orchestrator')
    .then((m) => m.hydrateSubAgentRunsForParentChat(id))
    .catch((err) => reportBackgroundError('sub-agent-hydrate', err));
  if (!sharedHost && isOrchestrateHubMounted()) {
    teardownOrchestrateHub();
  }
  if (sessionState?.activeId) {
    suspendOrchestratePlanScreenOnLeave(sessionState.activeId);
  }
  if (!sessionState) {
    closeMobileSidebar();
    applySidebarVisuals();
    return;
  }

  const boardChatEmbedOpen = isBoardChatEmbedOpenForChat(id);
  const issuesEmbedded = !sharedHost && document.getElementById('chatArea')?.classList.contains('chat-area--issues');
  if (issuesEmbedded) {
    const { teardownIssuesEmbedBeforeChatPaint } = await import('./issues-page');
    teardownIssuesEmbedBeforeChatPaint();
  }

  const boardRestoreGroup = boardChatEmbedOpen || sharedHost
    ? undefined
    : resolveBoardRestoreGroupOnSwitch(id);
  if (boardRestoreGroup) {
    const prevActiveId = sessionState.activeId;
    if (prevActiveId !== id) {
      clearAttachments();
      const leaving = sessionState.chats.find((c) => c.id === prevActiveId);
      if (leaving) maybeMarkChatUnreadAfterLeave(leaving);
    }
    acknowledgeChatViewed(id);
    openBoardGroup(boardRestoreGroup.id);
    syncViewModeToggleFromActiveChat();
    clearPanelCwdUserOverride();
    syncPanelFromActiveChat({ forceFileTree: true });
    syncComposerFromStreamingState();
    closeMobileSidebar();
    applySidebarVisuals();
    return;
  }

  const boardWasOpen = boardChatEmbedOpen || sharedHost ? false : exitBoardViewForNavigation();

  if (id === sessionState.activeId) {
    acknowledgeChatViewed(id);
    const sameChat = sessionState.chats.find((c) => c.id === id);
    const planScreenSuspendedForSameChat =
      sameChat != null && isOrchestratePlanScreenSuspendedForChat(sameChat);
    const codeOverviewOpen = isCodeOverviewOpen();
    const devServerScreenOpen = isDevServerScreenOpen();
    const chatSurfaceEmpty = document.getElementById('chatArea')?.childElementCount === 0;
    if (
      sharedHost ||
      boardWasOpen ||
      planScreenSuspendedForSameChat ||
      codeOverviewOpen ||
      devServerScreenOpen ||
      issuesEmbedded ||
      chatSurfaceEmpty
    ) {
      if (sameChat) {
        await ensureChatHistoryLoaded(id);
        if (sessionState.activeId !== id) return;
        if (sharedHost) {
          syncModelSelectForActiveChat();
          syncModeSelectorFromActiveChat();
          syncComposerReasoningEffortFromActiveChat();
          syncComposerPinnedSkillFromActiveChat();
          syncComposerRunTargetFromActiveChat();
          syncChatLinkChipsFromActiveChat();
          void bootGenerationResumeForChat(sameChat);
          void resumeIncompleteToolBatchOnChatSwitch(sameChat);
        }
        paintActiveChatInForegroundShell(sameChat);
        syncViewModeToggleFromActiveChat();
        syncComposerFromStreamingState();
        renderSidebar();
        scheduleSaveSessions();
        void import('../tools/stream-chat-dom').then((m) => m.remountStreamDomForChat(id));
      }
    }
    closeMobileSidebar();
    applySidebarVisuals();
    return;
  }
  const prevActiveId = sessionState.activeId;
  const leaving = prevActiveId
    ? sessionState.chats.find((c) => c.id === prevActiveId)
    : undefined;
  if (leaving) {
    maybeMarkChatUnreadAfterLeave(leaving);
  }
  const chat = sessionState.chats.find((c) => c.id === id);
  if (!chat) return;
  sessionState.activeId = id;
  clearAttachments();
  markSessionScalarsDirty();
  const historyPending = chat.historyLoaded === false;
  if (historyPending) {
    paintChatHistoryPendingInForegroundShell();
    await ensureChatHistoryLoaded(id);
    if (!sessionState || sessionState.activeId !== id) return;
  }
  syncAskQuestionModalOnChatSwitch(prevActiveId, id);
  notifyAskQuestionDisplayContextChanged();
  acknowledgeChatViewed(id);
  switchComposerDraft(prevActiveId, chat);
  syncModelSelectForActiveChat();
  paintActiveChatInForegroundShell(chat);
  void import('../usage/code-change-backfill').then((m) =>
    m.ensureChatCodeChangeBackfillOnSwitch(chat).then(() => {
      updateCodeChangeStrip(chat);
      updateWorkspaceCodeChangeDisplay();
    }),
  );
  void bootGenerationResumeForChat(chat);
  void resumeIncompleteToolBatchOnChatSwitch(chat);
  renderStatsForChat(chat);
  syncModeSelectorFromActiveChat();
  syncComposerReasoningEffortFromActiveChat();
  void syncOrchestratePlanStripFromActiveChat();
  syncComposerPinnedSkillFromActiveChat();
  syncChatLinkChipsFromActiveChat();
  syncComposerRunTargetFromActiveChat();
  syncComposerUndoFromActiveChat();
  syncViewModeToggleFromActiveChat();
  clearPanelCwdUserOverride();
  syncPanelFromActiveChat({ forceFileTree: true });
  syncWorkAgentDevFromActiveChat();
  syncGoalActiveHint();
  syncLoopActiveHint();
  if (isGoalEvaluating(chat.id)) {
    syncGoalEvalUi(chat.id);
  }
  syncTodoPanel();
  onModelRoutingActiveChatChanged(chat.id);
  void import('./terminal-panel').then((m) => m.refreshTerminalHistoryForActiveChat());
  syncComposerFromStreamingState();
  renderSidebar();
  scheduleSaveSessions();
  closeMobileSidebar();
  applySidebarVisuals();
  void import('../tools/stream-chat-dom').then((m) => m.remountStreamDomForChat(id));
}

export interface CreateChatWithModeOptions {
  modeId: ModeId;
  orchestratePlanPath?: string;
  initialUserMessage?: string;
  /** Use the source chat's binding when creating a follow-up. */
  modelId?: string;
  providerId?: string;
  forceNewChat?: boolean;
  /**
   * Workspace root to bind the new chat to; defaults to the current workspace.
   * Passed explicitly by background spawners (e.g. /followup) that must land in the
   * source chat's workspace even when the user has since switched folders.
   */
  workspacePath?: string;
}

// ── Create ───────────────────────────────────────────────────────────────────

/** Apply operating mode and default work-agent binding on an existing chat row. */
function applyModeIdToChat(chat: Chat, modeId: ModeId): void {
  chat.modeId = modeId;
  if (chat.workAgentAuto !== false) {
    const agent = getDefaultWorkAgentForMode(modeId);
    chat.workAgentId = agent?.id ?? null;
  }
}

/** Board planners must not be repurposed when New chat requests a different mode. */
function isBoardAnchorChat(chat: Chat): boolean {
  if (findBoardGroupForPlanner(chat.id)) return true;
  return Boolean(chat.boardGroupId?.trim() && !chat.boardTaskId?.trim());
}

/** Sync composer chrome after reusing or retargeting the active chat row. */
function syncCreateChatChrome(chatId: string): void {
  syncModeSelectorFromActiveChat();
  syncComposerReasoningEffortFromActiveChat();
  void syncOrchestratePlanStripFromActiveChat();
  syncComposerPinnedSkillFromActiveChat();
  syncChatLinkChipsFromActiveChat();
  syncComposerRunTargetFromActiveChat();
  syncComposerUndoFromActiveChat();
  syncViewModeToggleFromActiveChat();
  syncWorkAgentDevFromActiveChat();
  onModelRoutingActiveChatChanged(chatId);
}

/** Start an LLM turn when the user message was already pushed into history. */
async function kickoffSeededChatTurn(chat: Chat, message: string): Promise<void> {
  const { detectLocalServer } = await import('../tools/client');
  const { buildHistoryUserContent } = await import('../chat/build-api-messages');
  const { runChatTurn } = await import('../chat/run-turn-chat');
  const { isFirstUserMessagePending } = await import('../chat/titles/schedule');

  await detectLocalServer();
  await runChatTurn({
    chat,
    pushUser: false,
    rawText: message,
    userText: message,
    displayText: message,
    historyContent: buildHistoryUserContent(message, []),
    skillId: null,
    validAttachments: [],
    titleSeed: message,
    shouldScheduleTitle: isFirstUserMessagePending(chat),
    ownsGlobalStreaming: chat.id === getActiveChat().id,
  });
}

export interface CreateChatWithModeResult {
  ok: boolean;
  chatId?: string;
  modeId?: ModeId;
  orchestratePlanPath?: string;
  error?: string;
}

/** Create and activate a chat with a preset operating mode (tool handoff). */
export async function createChatWithMode(
  options: CreateChatWithModeOptions,
): Promise<CreateChatWithModeResult> {
  const originWorkspace = getWorkspacePath();
  const originChatId = sessionState?.activeId;
  try { await loadDefaultModelValue(); }
  catch (error) { return { ok: false, error: error instanceof Error ? error.message : 'Could not read the last selected model' }; }
  if (!options.workspacePath && (originWorkspace !== getWorkspacePath() || originChatId !== sessionState?.activeId)) return { ok: false, error: 'The chat context changed. Try New chat again.' };
  if (document.getElementById('codeMapChatSidebar')) {
    teardownCodeBrainMapBeforeChatPaint();
  }
  if (isOrchestrateHubMounted()) {
    teardownOrchestrateHub();
  }
  if (sessionState?.activeId) {
    suspendOrchestratePlanScreenOnLeave(sessionState.activeId);
  }
  exitBoardViewForNavigation();

  const requestedWorkspace = options.workspacePath?.trim();
  const workspacePath = requestedWorkspace || getWorkspacePath();
  const active = getActiveChat();
  flushActiveComposerDraftBeforeNewChat();

  const requestedMode = normalizeModeId(options.modeId);
  // An explicit workspace must never reuse (or retarget) the active chat.
  const sameWorkspace =
    !requestedWorkspace &&
    normalizeWorkspacePath(active.workspacePath ?? '') === normalizeWorkspacePath(workspacePath);
  const canReuseEphemeral =
    !options.forceNewChat &&
    !requestedWorkspace &&
    !options.initialUserMessage?.trim() &&
    isEphemeralEmptyChat(active) &&
    sameWorkspace &&
    !isMainColumnOverlaySuppressingChatDom() &&
    !isBoardAnchorChat(active);

  if (canReuseEphemeral) {
    const activeMode = normalizeModeId(active.modeId);
    const needsNewChat = requestedMode !== activeMode && isBoardAnchorChat(active);
    if (!needsNewChat) {
      if (requestedMode !== activeMode) {
        applyModeIdToChat(active, requestedMode);
      }
      applyDefaultModelToChat(active);
      seedNewChatComposerRunTarget(active);
      touchChat(active);
      resetComposerForEphemeralReuse();
      recordChatOpened(active.id);
      paintActiveChatInForegroundShell(active);
      syncCreateChatChrome(active.id);
      clearPanelCwdUserOverride();
      syncPanelFromActiveChat({ forceFileTree: true });
      syncModelSelectForActiveChat();
      renderSidebar();
      scheduleSaveSessions();
      closeMobileSidebar();
      applySidebarVisuals();
      return {
        ok: true,
        chatId: active.id,
        modeId: requestedMode,
        orchestratePlanPath: active.orchestratePlanPath,
      };
    }
  }

  const modeId = requestedMode;
  const { modelId } = readDefaultModelBinding();
  const chat = createEmptyChatObject(modelId, requestedWorkspace || undefined);
  applyDefaultModelToChat(chat);
  if (options.modelId?.trim()) {
    chat.modelId = options.modelId.trim();
    chat.providerId = options.providerId?.trim() || undefined;
  }
  chat.modeId = modeId;
  if (chat.workAgentAuto !== false) {
    const agent = getDefaultWorkAgentForMode(modeId);
    chat.workAgentId = agent?.id ?? null;
  }

  const defaultPin = buildDefaultPinnedSkillForNewChat();
  if (defaultPin) {
    chat.pinnedSkill = defaultPin;
  }

  const planPath = options.orchestratePlanPath?.trim();
  if (planPath) {
    const normalized = normalizeOrchestratePlanPath(planPath);
    if (normalized) chat.orchestratePlanPath = normalized;
  }

  const initial = options.initialUserMessage?.trim();
  if (initial) {
    chat.history.push({ role: 'user', content: initial });
    recordChatMessage(chat);
  }

  seedNewChatComposerRunTarget(chat);

  sessionState!.chats.unshift(chat);
  pruneEphemeralEmptyChats(sessionState!, chat.id);
  sessionState!.activeId = chat.id;
  if (!initial) resetComposerForEphemeralReuse();
  recordChatOpened(chat.id);
  paintActiveChatInForegroundShell(chat);
  void bootGenerationResumeForChat(chat);
  renderStatsForChat(chat);
  syncCreateChatChrome(chat.id);
  clearPanelCwdUserOverride();
  syncPanelFromActiveChat({ forceFileTree: true });
  syncModelSelectForActiveChat();
  void import('./terminal-panel').then((m) => m.refreshTerminalHistoryForActiveChat());
  syncComposerFromStreamingState();
  renderSidebar();
  scheduleSaveSessions();
  closeMobileSidebar();
  applySidebarVisuals();

  if (initial) {
    void kickoffSeededChatTurn(chat, initial).catch(() => {
    });
  }

  return {
    ok: true,
    chatId: chat.id,
    modeId,
    orchestratePlanPath: chat.orchestratePlanPath,
  };
}

export async function createChat(): Promise<void> {
  const active = getActiveChat();
  const leavingOrchestrate =
    isBoardViewActive() || normalizeModeId(active.modeId) === 'orchestrate';
  const result = await createChatWithMode({
    modeId: leavingOrchestrate ? 'general' : normalizeModeId(active.modeId),
  });
  if (!result.ok) setStatus('err', result.error || 'Could not create chat');
}

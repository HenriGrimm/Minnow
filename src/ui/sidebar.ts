import { reportBackgroundError } from '../boot/report-background-error';
import { isChatsWorkspacePath } from '../lib/chats-workspace';
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
  listBoardGroupChatIds,
  openBoardGroup,
  renameGroup,
  resolveBoardRestoreGroupOnSwitch,
  toggleGroupCollapsed,
} from '../state/chat-groups';
import { appConfirm } from './app-dialog';
import { createBoardCategoryIcon } from './board-category-icons';
import { createIcon } from './icon';
import { isChatAppForeground } from './chat-mount';
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
  removeChatById,
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
import { syncWorkAgentDevFromActiveChat, workAgentSidebarAbbrev } from './work-agent-dev';
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
import { createModeMaskIcon } from './mode-icons';
import { hasComposerDraft } from '../state/session-workspace-scope';
import {
  flushActiveComposerDraftBeforeNewChat,
  resetComposerForEphemeralReuse,
  switchComposerDraft,
} from './composer-draft';
import { isMainColumnOverlaySuppressingChatDom } from './main-column-overlay';

// ── Board waves ──────────────────────────────────────────────────────────────

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
  const config = getRouterConfigSync();
  const selected = decodeModelSelectKey(sel.value);
  const routerId = selected?.providerId === 'minnow-router' ? selected.modelId : null;
  if (routerId !== config.defaultRouterId) {
    try { await saveRouterConfig({ ...config, defaultRouterId: routerId }); }
    catch (error) { setStatus('err', (error as Error).message); return; }
  }
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
  /** Workspace chats can be dragged onto group headers; Unassigned rows cannot. */
  draggable?: boolean;
  /** Compact name-only row when listed under a sidebar group. */
  inGroup?: boolean;
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
  const prefetchHistoryOnIntent = () => {
    if (chat.historyLoaded === false) {
      void ensureChatHistoryLoaded(chat.id);
    }
  };
  row.addEventListener('pointerenter', prefetchHistoryOnIntent);
  row.addEventListener('focus', prefetchHistoryOnIntent);
  if (options?.draggable !== false) {
    row.draggable = true;
    row.classList.add('chat-item-row--draggable');
  }
  row.addEventListener('click', (e) => {
    if ((e.target as Element).closest('.chat-rename-input')) return;
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
      options.onActivate(chat);
      return;
    }
    switchChat(chat.id);
  });
  row.addEventListener('keydown', (e) => {
    if ((e.target as Element).closest('.chat-rename-input')) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      clearChatSelection();
      lastSelectedChatId = chat.id;
      if (options?.onActivate) {
        options.onActivate(chat);
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

  if (!inGroup || !boardCategory) {
    const icon = createModeMaskIcon(chat.modeId, 'chat-item-icon mode-mask-icon');
    titleRow.appendChild(icon);
  }

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

  if (!inGroup) {
    const agentAbbrev = workAgentSidebarAbbrev(chat.workAgentId);
    if (agentAbbrev) {
      const badge = document.createElement('span');
      badge.className = 'chat-item-agent-badge';
      badge.textContent = agentAbbrev;
      badge.title = `Work agent: ${chat.workAgentId}`;
      titleRow.appendChild(badge);
    }
  }

  head.appendChild(titleRow);

  row.addEventListener('contextmenu', (e) => {
    if ((e.target as Element).closest('.chat-rename-input')) return;
    e.preventDefault();
    if (selectedChatIds.size > 1 && selectedChatIds.has(chat.id)) {
      showMultiSelectContextMenu(e.clientX, e.clientY, [...selectedChatIds]);
    } else {
      showChatItemContextMenu(e.clientX, e.clientY, chat, nameSpan, options);
    }
  });

  row.appendChild(head);
  if (!inGroup) {
    const modelEl = document.createElement('div');
    modelEl.className = 'chat-item-model';
    modelEl.textContent = routerChatModelLabel(chat) || '\u2014';

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
  row.dataset.modeId = chat.modeId ?? '';
  row.dataset.boardCategory = boardCategory ?? '';
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
    if (nameSpan) nameSpan.textContent = displayName;
    row.classList.add('chat-item-row--draft');
    row.setAttribute('aria-label', `${displayName}, ${modelLabel}`);
    row.title = [displayName, modelLabel].filter(Boolean).join('\n');
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

  if (row.dataset.modeId !== (chat.modeId ?? '')) {
    const titleRow = row.querySelector('.chat-item-title-row');
    const oldIcon = titleRow?.querySelector('.chat-item-icon');
    if (titleRow && oldIcon) {
      oldIcon.replaceWith(createModeMaskIcon(chat.modeId, 'chat-item-icon mode-mask-icon'));
    }
    row.dataset.modeId = chat.modeId ?? '';
  }

  const modelEl = row.querySelector<HTMLElement>('.chat-item-model');
  if (modelEl) modelEl.textContent = routerChatModelLabel(chat) || '\u2014';

  let statsEl = row.querySelector<HTMLElement>('.chat-item-stats');
  if (!inGroup && hasCodeChangeTotals(chat.codeChangeTotals)) {
    if (!statsEl) {
      statsEl = document.createElement('div');
      statsEl.className = 'chat-item-stats';
      row.appendChild(statsEl);
    }
    statsEl.replaceChildren();
    const statsFrag = document.createDocumentFragment();
    appendChatItemCodeChangeStats(statsFrag, chat, chat.codeChangeTotals!);
    statsEl.appendChild(statsFrag);
  } else {
    statsEl?.remove();
  }

  const titleRow = row.querySelector('.chat-item-title-row');
  const agentAbbrev = !inGroup ? workAgentSidebarAbbrev(chat.workAgentId) : '';
  let badge = row.querySelector<HTMLElement>('.chat-item-agent-badge');
  if (agentAbbrev) {
    if (!badge && titleRow) {
      badge = document.createElement('span');
      badge.className = 'chat-item-agent-badge';
      titleRow.appendChild(badge);
    }
    if (badge) {
      badge.textContent = agentAbbrev;
      badge.title = `Work agent: ${chat.workAgentId}`;
    }
  } else {
    badge?.remove();
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

export function renderSidebar(): void {
  cancelScheduledSidebarRender();
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
  const existingUnassignedHead = list.querySelector<HTMLElement>(
    '.chat-list-section-head[data-section="unassigned"]',
  );
  const existingEmpty = list.querySelector<HTMLElement>('.chat-list-empty');

  const ws = getWorkspacePath();
  const excludeAssistantChats = (chat: { workspacePath?: string }) =>
    !isChatsWorkspacePath(chat.workspacePath ?? '');
  const workspaceChats = getSidebarListedChatsForWorkspace(ws, sessionState)
    .filter((c) => !isHiddenFromMainSidebar(c))
    .filter((c) => !isBoardOwnedChat(c))
    .filter(excludeAssistantChats);
  const highlightChatId = sidebarHighlightChatId();
  const sidebarEntries = buildSortedWorkspaceSidebarEntries(
    getGroupsForWorkspace(ws).filter((g) => !isBoardOwnedGroup(g)),
    workspaceChats,
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
          const memberRows = members.map((chat) =>
            takeRow(chat, { inGroup: true, group }),
          );
          reconcileChildren(membersEl, memberRows);
        }
        desired.push(membersEl);
      }
      continue;
    }
    desired.push(takeRow(entry.chat));
  }

  const unassigned = getUnassignedChats(sessionState)
    .filter((c) => !isHiddenFromMainSidebar(c))
    .filter((c) => !isBoardOwnedChat(c))
    .filter(excludeAssistantChats);
  if (unassigned.length) {
    let head = existingUnassignedHead;
    if (!head) head = buildChatListSectionHead('Unassigned', unassigned.length);
    else {
      const badge = head.querySelector('.chat-list-section-badge');
      if (badge) badge.textContent = String(unassigned.length);
    }
    desired.push(head);
    for (const chat of unassigned) {
      desired.push(takeRow(chat, { draggable: false }));
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
    menu.remove();
    clearChatSelection();
    void import('./chat-brain-capture').then(async (m) => {
      for (const chat of eligible) {
        await m.runChatBrainCapture(chat);
      }
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
      clearChatSelection();
      const { modelId } = readDefaultModelBinding();
      let lastResult: ReturnType<typeof removeChatById> | null = null;
      for (const chat of deletable) {
        const r = removeChatById(chat.id, modelId);
        if (r.ok) lastResult = r;
      }
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
}

/** Row context menu for a chat: Rename, Add to Brain, Open in orchestrator, Delete. */
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

  const brainState = chatBrainCaptureState(chat);
  const brainItem = document.createElement('button');
  brainItem.type = 'button';
  brainItem.textContent = 'Add to Brain';
  brainItem.title = brainState.title;
  brainItem.disabled = brainState.disabled;
  brainItem.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    closeMenu();
    if (brainState.disabled) return;
    void import('./chat-brain-capture').then((m) => m.runChatBrainCapture(chat));
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

  menu.appendChild(renameItem);
  menu.appendChild(brainItem);
  if (orchestrateItem) menu.appendChild(orchestrateItem);
  menu.appendChild(deleteItem);
  document.body.appendChild(menu);

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
    const active = result.activeChat;
    recordChatOpened(active.id);
    syncModelSelectForActiveChat();
    renderStatsForChat(active);
    renderChatFromHistory(active);
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
    setStatus('spin', 'Finish the current reply first');
    return;
  }
  const idx = sessionState!.chats.findIndex((c) => c.id === chatId);
  if (idx < 0) return;
  const victim = sessionState!.chats[idx];
  const victimLabel =
    getChatMessageCount(victim) === 0 && hasComposerDraft(victim)
      ? formatDraftChatSidebarName(victim)
      : victim.name;
  if (
    !(await appConfirm(`Delete "${victimLabel}"? Messages in this chat cannot be recovered.`, {
      confirmLabel: 'Delete',
      danger: true,
    }))
  ) {
    return;
  }

  const { modelId } = readDefaultModelBinding();
  const result = removeChatById(chatId, modelId);
  onChatRemoved(result);
}

export async function switchChat(id: string): Promise<void> {
  restoreChatColumnOnChatSelect();
  void import('../ui/chat-scroll').then((m) => m.invalidateChatScrollRootCache());
  void import('../agents/sub-agent-completion-push')
    .then((m) => m.flushAllPendingSubAgentCompletions())
    .catch((err) => reportBackgroundError('sub-agent-completion-flush', err));
  void import('../agents/orchestrator')
    .then((m) => m.hydrateSubAgentRunsForParentChat(id))
    .catch((err) => reportBackgroundError('sub-agent-hydrate', err));
  if (isOrchestrateHubMounted()) {
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

  const boardRestoreGroup = boardChatEmbedOpen
    ? undefined
    : resolveBoardRestoreGroupOnSwitch(id);
  if (boardRestoreGroup) {
    const prevActiveId = sessionState.activeId;
    if (prevActiveId !== id) {
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

  const boardWasOpen = boardChatEmbedOpen ? false : exitBoardViewForNavigation();

  if (id === sessionState.activeId) {
    acknowledgeChatViewed(id);
    const sameChat = sessionState.chats.find((c) => c.id === id);
    const planScreenSuspendedForSameChat =
      sameChat != null && isOrchestratePlanScreenSuspendedForChat(sameChat);
    const codeOverviewOpen = isCodeOverviewOpen();
    const devServerScreenOpen = isDevServerScreenOpen();
    if (
      boardWasOpen ||
      planScreenSuspendedForSameChat ||
      codeOverviewOpen ||
      devServerScreenOpen
    ) {
      if (sameChat) {
        await ensureChatHistoryLoaded(id);
        if (sessionState.activeId !== id) return;
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
export function createChatWithMode(
  options: CreateChatWithModeOptions,
): CreateChatWithModeResult {
  if (isOrchestrateHubMounted()) {
    teardownOrchestrateHub();
  }
  if (sessionState?.activeId) {
    suspendOrchestratePlanScreenOnLeave(sessionState.activeId);
  }
  exitBoardViewForNavigation();

  const workspacePath = getWorkspacePath();
  const active = getActiveChat();
  flushActiveComposerDraftBeforeNewChat();

  const requestedMode = normalizeModeId(options.modeId);
  const sameWorkspace =
    normalizeWorkspacePath(active.workspacePath ?? '') === normalizeWorkspacePath(workspacePath);
  const canReuseEphemeral =
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
  const chat = createEmptyChatObject(modelId);
  applyDefaultModelToChat(chat);
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

export function createChat(): void {
  const active = getActiveChat();
  const leavingOrchestrate =
    isBoardViewActive() || normalizeModeId(active.modeId) === 'orchestrate';
  createChatWithMode({
    modeId: leavingOrchestrate ? 'general' : normalizeModeId(active.modeId),
  });
}

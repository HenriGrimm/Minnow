import { createButton, setButtonClassName } from './components';
import { normalizeModeId } from '../chat/modes/types';
import { isChatStreaming } from '../chat/streaming-state';
import { notifyAskQuestionDisplayContextChanged } from '../chat/ask-question-display';
import { emitChatSidebarChanged } from './layout-events';
import {
  closeBoardGroupView,
  getActiveBoardGroup,
  getBoardGroupForChat,
  getOrCreateBoardGroup,
  openBoardGroup,
} from '../state/chat-groups';
import { exitBoardViewForNavigation } from './exit-board-view';
import { isBoardChatEmbedOpen } from './orchestrate-board-chat-state';
import {
  getActiveChat,
  scheduleSaveSessions,
  sessionState,
  touchChat,
} from '../state/sessions';
import type { Chat, ChatGroup } from '../types';
import { createIcon } from './icon';

const BOARD_TOGGLE_ID = 'btnViewModeToggleBoard';
const CHAT_TOGGLE_ID = 'btnViewModeToggleChat';

let boardToggleEl: HTMLButtonElement | null = null;

function defaultRenderChat(chat: Chat): void {
  void import('./messages').then((m) => m.renderChatFromHistory(chat));
}

let renderChat: (chat: Chat) => void = defaultRenderChat;

/** Replace render callback in unit tests (restored by resetViewModeToggleForTests). */
export function setViewModeToggleRenderHandlerForTests(
  fn: ((chat: Chat) => void) | null,
): void {
  renderChat = fn ?? defaultRenderChat;
}

/** Clear cached DOM refs between happy-dom test runs. */
export function resetViewModeToggleForTests(): void {
  boardToggleEl = null;
  renderChat = defaultRenderChat;
  document.getElementById('mainColumn')?.classList.remove('main-column--board-view');
}

/** Resolve board folder for toggles (active board view or planner link). */
function resolveBoardGroupForToggle(chat: Chat): ChatGroup | undefined {
  const activeBoard = getActiveBoardGroup();
  if (activeBoard) return activeBoard;
  return getBoardGroupForChat(chat);
}

/** True when Orchestrate kanban fills the main column. */
export function isOrchestrateBoardViewActive(): boolean {
  const group = getActiveBoardGroup();
  return group?.viewMode === 'board';
}

/** True when Orchestrate board view replaces chat bubbles. */
export function isBoardViewActive(): boolean {
  return isOrchestrateBoardViewActive();
}

/** Toggle main-column layout class: hides chat composer and session list in board view. */
export function syncBoardViewChrome(): void {
  const mainColumn = document.getElementById('mainColumn');
  if (!mainColumn) return;
  const boardView = isBoardViewActive();
  const initSplit = mainColumn.classList.contains('main-column--orchestrate-init-split');
  const next = boardView && !initSplit;
  const was = mainColumn.classList.contains('main-column--board-view');
  mainColumn.classList.toggle('main-column--board-view', next);
  if (was !== next) {
    emitChatSidebarChanged();
    void import('./preview-electron-visibility').then((m) => {
      m.scheduleElectronPreviewHostLayoutSync();
    });
  }
  void import('./chat-scroll').then((m) => m.refreshChatJumpChipVisibility());
  notifyAskQuestionDisplayContextChanged();
}

function getBoardToggleButton(): HTMLButtonElement | null {
  if (!boardToggleEl) {
    boardToggleEl = document.getElementById(BOARD_TOGGLE_ID) as HTMLButtonElement | null;
  }
  return boardToggleEl;
}

function getChatToggleButton(): HTMLButtonElement | null {
  return document.getElementById(CHAT_TOGGLE_ID) as HTMLButtonElement | null;
}

/** Whether view toggles can switch chat/board for this chat. */
function isViewModeToggleEnabled(chat: Chat): boolean {
  return normalizeModeId(chat.modeId) === 'orchestrate';
}

function boardToggleLabels(
  chat: Chat,
  boardActive: boolean,
): { ariaLabel: string; title: string } {
  const group = resolveBoardGroupForToggle(chat);
  const hasPlan = Boolean(
    group?.orchestratePlanPath?.trim() || chat.orchestratePlanPath?.trim(),
  );

  if (normalizeModeId(chat.modeId) !== 'orchestrate') {
    return {
      ariaLabel: 'Board view',
      title: 'Board view (Orchestrate mode only)',
    };
  }
  if (!hasPlan) {
    return {
      ariaLabel: 'Switch to board view',
      title: 'Board view (select a plan in chat view for full board)',
    };
  }
  if (boardActive) {
    return { ariaLabel: 'Board view', title: 'Board view' };
  }
  return { ariaLabel: 'Switch to board view', title: 'Board view' };
}

function chatToggleLabels(
  chat: Chat,
  boardActive: boolean,
): { ariaLabel: string; title: string } {
  const group = resolveBoardGroupForToggle(chat);
  const hasPlan = Boolean(
    group?.orchestratePlanPath?.trim() || chat.orchestratePlanPath?.trim(),
  );

  if (normalizeModeId(chat.modeId) !== 'orchestrate') {
    return {
      ariaLabel: 'Chat view',
      title: 'Chat view (Orchestrate mode only)',
    };
  }
  if (boardActive && !hasPlan) {
    return {
      ariaLabel: 'Switch to chat view',
      title: 'Chat view (select a plan in the composer)',
    };
  }
  if (boardActive) {
    return { ariaLabel: 'Switch to chat view', title: 'Chat view' };
  }
  return { ariaLabel: 'Chat view', title: 'Chat view' };
}

function applyToggleButtonState(
  btn: HTMLButtonElement | null,
  enabled: boolean,
  labels: { ariaLabel: string; title: string },
  accentWhenActive: boolean,
): void {
  if (!btn) return;
  btn.disabled = !enabled;
  btn.setAttribute('aria-label', labels.ariaLabel);
  btn.title = labels.title;
  btn.classList.toggle('view-mode-toggle-btn--accent', accentWhenActive && enabled);
}

/** Disables composer/board toggles outside Orchestrate mode. */
export function refreshViewModeToggleDisabled(): void {
  syncViewModeToggleFromActiveChat();
}

/**
 * Syncs board (composer) and chat (board header) toggles from active chat state.
 */
export function syncViewModeToggleFromActiveChat(): void {
  if (!sessionState) return;
  const chat = getActiveChat();
  const boardActive = isBoardViewActive();
  const enabled = isViewModeToggleEnabled(chat);

  applyToggleButtonState(
    getBoardToggleButton(),
    enabled && !boardActive,
    boardToggleLabels(chat, boardActive),
    false,
  );

  applyToggleButtonState(
    getChatToggleButton(),
    enabled && boardActive,
    chatToggleLabels(chat, boardActive),
    true,
  );

  const boardBtn = getBoardToggleButton();
  if (boardBtn) {
    const showBoardToggle = enabled && !boardActive;
    boardBtn.hidden = !showBoardToggle;
    boardBtn.classList.toggle('hidden', !showBoardToggle);
    wireViewToggleButton(boardBtn, 'board');
  }

  const chatBtn = getChatToggleButton();
  if (chatBtn) {
    wireViewToggleButton(chatBtn, 'chat');
  }

  syncBoardViewChrome();
}

/** Switch Orchestrate folder between board and chat views. */
export function setOrchestrateViewMode(next: 'chat' | 'board'): void {
  const chat = getActiveChat();
  if (!isViewModeToggleEnabled(chat)) return;

  if (next === 'board') {
    const group = getBoardGroupForChat(chat) ?? getOrCreateBoardGroup(chat);
    if (group.orchestrateBoard) {
      openBoardGroup(group.id);
    } else {
      group.viewMode = 'board';
      if (sessionState) {
        sessionState.activeBoardGroupId = group.id;
      }
      scheduleSaveSessions();
      renderChat(chat);
    }
    void import('./sidebar').then((m) => m.renderSidebar());
    syncViewModeToggleFromActiveChat();
    void import('./git-panel').then((m) =>
      m.syncPanelFromActiveChat({ forceFileTree: true }),
    );
    void import('./orchestrate-plan-selector').then((m) =>
      m.syncOrchestratePlanStripFromActiveChat(),
    );
    return;
  }

  const activeGroup = getActiveBoardGroup() ?? getBoardGroupForChat(chat);
  if (!activeGroup) return;
  if (activeGroup.viewMode === 'chat') {
    const area = document.getElementById('chatArea');
    const boardDomVisible = Boolean(
      area?.querySelector(':scope > .ob-page, :scope > .board-root'),
    );
    if (!boardDomVisible && !isBoardChatEmbedOpen()) return;
  }
  activeGroup.viewMode = 'chat';
  exitBoardViewForNavigation();
  closeBoardGroupView(activeGroup);
  renderChat(chat);
  if (isChatStreaming(chat.id)) {
    void import('../tools/stream-chat-dom').then((m) => m.remountStreamDomForChat(chat.id));
  }
  syncViewModeToggleFromActiveChat();
  void import('./git-panel').then((m) =>
    m.syncPanelFromActiveChat({ forceFileTree: true }),
  );
  void import('./orchestrate-plan-selector').then((m) =>
    m.syncOrchestratePlanStripFromActiveChat(),
  );
}

function wireViewToggleButton(
  btn: HTMLButtonElement,
  next: 'chat' | 'board',
): void {
  btn.onclick = () => setOrchestrateViewMode(next);
}

function createBoardChatViewToggleButton(): HTMLButtonElement {
  const btn = createButton({ appearance: 'surface', variant: 'ghost', size: 'sm' });
  btn.type = 'button';
  btn.id = CHAT_TOGGLE_ID;
  setButtonClassName(btn, 'icon-btn view-mode-toggle-btn view-mode-toggle-btn--to-chat board-header__view-toggle');
  btn.setAttribute('aria-label', 'Switch to chat view');
  btn.title = 'Chat view';
  btn.disabled = true;

  btn.appendChild(createIcon('appChat', { className: 'view-mode-toggle-btn__icon' }));
  return btn;
}

export function ensureBoardChatViewToggle(controls: HTMLElement): void {
  let btn = controls.querySelector(
    `#${CHAT_TOGGLE_ID}`,
  ) as HTMLButtonElement | null;
  if (!btn) {
    btn = createBoardChatViewToggleButton();
    controls.appendChild(btn);
  }
  wireViewToggleButton(btn, 'chat');
}

/** Chat-view icon button for board header controls (recreated when header wires). */
export function appendBoardChatViewToggle(controls: HTMLElement): void {
  ensureBoardChatViewToggle(controls);
  syncViewModeToggleFromActiveChat();
}

/** Wires composer/board toggle clicks and first sync (idempotent). */
export function initViewModeToggle(): void {
  const boardBtn = getBoardToggleButton();
  if (boardBtn) wireViewToggleButton(boardBtn, 'board');
  syncViewModeToggleFromActiveChat();
}


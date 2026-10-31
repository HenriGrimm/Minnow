import { normalizeWorkspacePath } from '../lib/normalize-workspace-path';
import { assignChatToGroup } from '../state/chat-groups';
import { sessionState } from '../state/sessions';
import { getWorkspacePath } from '../state/workspace';
import { renderSidebar } from './sidebar';

import { CHAT_DRAG_MIME } from '../attachments/chat-drag';
const DROP_TARGET_CLASS = 'chat-group-header--drop-target';
const DRAGGING_ROW_CLASS = 'chat-item-row--dragging';

let listBound: HTMLElement | null = null;
/** Active drag id (dragover cannot read getData in most browsers). */
let activeDragChatId: string | null = null;
let suppressRowClick = false;

function chatIdFromDataTransfer(dataTransfer: DataTransfer | null): string | null {
  if (!dataTransfer) return null;
  const typed = dataTransfer.getData(CHAT_DRAG_MIME).trim();
  if (typed) return typed;
  const plain = dataTransfer.getData('text/plain').trim();
  if (plain && !plain.includes('\n') && plain.length <= 64) return plain;
  return null;
}

function groupHeaderFromTarget(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof HTMLElement)) return null;
  const head = target.closest('.chat-group-header[data-group-id]');
  return head instanceof HTMLElement ? head : null;
}

function chatRowFromTarget(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof HTMLElement)) return null;
  const row = target.closest('.chat-item-row[data-chat-id]');
  return row instanceof HTMLElement ? row : null;
}

function clearDropHighlight(host: HTMLElement): void {
  for (const el of host.querySelectorAll(`.${DROP_TARGET_CLASS}`)) {
    el.classList.remove(DROP_TARGET_CLASS);
  }
}

function isWorkspaceChatDraggable(chatId: string): boolean {
  if (!sessionState) return false;
  const chat = sessionState.chats.find((c) => c.id === chatId);
  if (!chat || chat.agentConversation) return false;
  const ws = normalizeWorkspacePath(getWorkspacePath());
  return normalizeWorkspacePath(chat.workspacePath ?? '') === ws;
}

function bindChatList(host: HTMLElement): void {
  host.addEventListener(
    'dragstart',
    (event) => {
      if (!(event.target instanceof HTMLElement)) return;
      if (event.target.closest('.chat-rename-input')) {
        event.preventDefault();
        return;
      }
      const row = chatRowFromTarget(event.target);
      const chatId = row?.dataset.chatId?.trim();
      if (!row || !chatId || !isWorkspaceChatDraggable(chatId)) {
        event.preventDefault();
        return;
      }
      activeDragChatId = chatId;
      row.classList.add(DRAGGING_ROW_CLASS);
      const transfer = event.dataTransfer;
      if (!transfer) return;
      transfer.effectAllowed = 'move';
      transfer.setData(CHAT_DRAG_MIME, chatId);
      transfer.setData('text/plain', chatId);
    },
    true,
  );

  host.addEventListener(
    'click',
    (event) => {
      if (!suppressRowClick) return;
      if (!chatRowFromTarget(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      suppressRowClick = false;
    },
    true,
  );

  host.addEventListener('dragover', (event) => {
    const chatId = activeDragChatId?.trim();
    if (!chatId) return;

    const header = groupHeaderFromTarget(event.target);
    if (!header?.dataset.groupId) return;

    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'move';
    }
    clearDropHighlight(host);
    header.classList.add(DROP_TARGET_CLASS);
  });

  host.addEventListener('dragleave', (event) => {
    const header = groupHeaderFromTarget(event.target);
    if (!header) return;
    const related = event.relatedTarget;
    if (related instanceof Node && header.contains(related)) return;
    header.classList.remove(DROP_TARGET_CLASS);
  });

  host.addEventListener('drop', (event) => {
    clearDropHighlight(host);
    const header = groupHeaderFromTarget(event.target);
    const groupId = header?.dataset.groupId?.trim();
    if (!groupId) return;

    event.preventDefault();
    event.stopPropagation();

    const chatId =
      activeDragChatId?.trim() ?? chatIdFromDataTransfer(event.dataTransfer)?.trim();
    if (!chatId || !isWorkspaceChatDraggable(chatId)) return;

    const chat = sessionState?.chats.find((c) => c.id === chatId);
    if (chat?.groupId === groupId) return;

    assignChatToGroup(chatId, groupId);
    renderSidebar();
  });

  host.addEventListener('dragend', () => {
    activeDragChatId = null;
    suppressRowClick = true;
    window.setTimeout(() => {
      suppressRowClick = false;
    }, 0);
    clearDropHighlight(host);
    for (const row of host.querySelectorAll(`.${DRAGGING_ROW_CLASS}`)) {
      row.classList.remove(DRAGGING_ROW_CLASS);
    }
  });
}

/** Wire group drop targets on `#chatList` (idempotent). */
export function wireSidebarChatDragDrop(): void {
  const host = document.getElementById('chatList');
  if (!host || host === listBound) return;
  listBound = host;
  bindChatList(host);
}

/** Clear binding state (tests). */
export function resetSidebarChatDnDForTests(): void {
  listBound = null;
  activeDragChatId = null;
  suppressRowClick = false;
}

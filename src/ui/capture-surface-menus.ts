import { openRegisteredMenu } from './menu-registry';
import { CAPTURE_MENU_KINDS } from './issue-capture';
import { copyTextToClipboard } from './terminal-copy-shortcut';
import { findSelectionScope, selectAllInElement } from './scoped-select-all';
import { showToast } from './toast';

/** Longest selection folded into a capture before it stops being useful. */
const MAX_SELECTION_CHARS = 8000;

function selectedText(): string {
  const selection = window.getSelection?.();
  const text = selection?.toString() ?? '';
  return text.trim() ? text.slice(0, MAX_SELECTION_CHARS) : '';
}

function closestMessage(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  const el = target.closest('.msg');
  return el instanceof HTMLElement ? el : null;
}

function messageText(el: HTMLElement): string {
  const bubble = el.querySelector('.msg-bubble');
  const text = (bubble?.textContent ?? el.textContent ?? '').trim();
  return text;
}

function onChatContextMenu(event: MouseEvent): void {
  if (event.defaultPrevented || !(event.target instanceof HTMLElement)) return;
  // Message edit fields keep the browser/desktop's native editing menu.
  if (event.target.closest('input, textarea, [contenteditable]:not([contenteditable="false"])')) return;
  const message = closestMessage(event.target);
  if (!message) return;

  const domSelection = window.getSelection();
  const scope = findSelectionScope(message) ?? message;
  const selection = domSelection?.rangeCount && scope.contains(domSelection.anchorNode)
    && scope.contains(domSelection.focusNode) ? domSelection.toString() : '';
  const text = selection || messageText(message);
  if (!text) return;
  const shortcut = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+';

  event.preventDefault();
  openRegisteredMenu({
    label: 'Message actions',
    clientX: event.clientX,
    clientY: event.clientY,
    restoreFocus: message,
    items: [
      { id: 'cut', label: 'Cut', shortcut: `${shortcut}X`, disabled: true, onSelect: () => {} },
      {
        id: 'copy', label: 'Copy', shortcut: `${shortcut}C`,
        onSelect: async () => {
          try { await copyTextToClipboard(text); }
          catch { showToast('Could not copy text', 'error'); }
        },
      },
      { id: 'paste', label: 'Paste', shortcut: `${shortcut}V`, disabled: true, onSelect: () => {} },
      { kind: 'separator' },
      {
        id: 'select-all', label: 'Select All', shortcut: `${shortcut}A`,
        onSelect: () => selectAllInElement(scope),
      },
    ],
    target: {
      kind: CAPTURE_MENU_KINDS.chatMessage,
      chatId: message.dataset.chatId ?? '',
      chatTitle: selection ? 'Selected text' : 'Chat message',
      text: text.slice(0, MAX_SELECTION_CHARS),
    },
  });
}

function onTerminalContextMenu(event: MouseEvent): void {
  if (!(event.target instanceof Element)) return;
  if (!event.target.closest('.terminal-xterm-host, .terminal-output')) return;

  const text = selectedText();
  if (!text) return;

  event.preventDefault();
  openRegisteredMenu({
    label: 'Terminal selection',
    clientX: event.clientX,
    clientY: event.clientY,
    target: { kind: CAPTURE_MENU_KINDS.terminalSelection, text },
  });
}

let bound = false;

/** Bind the delegated menus once. */
export function initCaptureSurfaceMenus(): void {
  if (bound || typeof document === 'undefined') return;
  bound = true;
  document.addEventListener('contextmenu', onChatContextMenu);
  document.addEventListener('contextmenu', onTerminalContextMenu);
}

/** Reset module state (tests). */
export function resetCaptureSurfaceMenusForTests(): void {
  if (!bound) return;
  document.removeEventListener('contextmenu', onChatContextMenu);
  document.removeEventListener('contextmenu', onTerminalContextMenu);
  bound = false;
}

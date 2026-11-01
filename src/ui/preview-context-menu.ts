import { createButton, setButtonClassName } from './components';
import type {
  MinnowPreviewContextMenuItem,
  MinnowPreviewContextMenuOpenPayload,
} from '../electron';

export interface PreviewContextMenuActionItem {
  role: string;
  label: string;
  enabled: boolean;
  suggestion?: string;
}

let menuEl: HTMLDivElement | null = null;
let dismissBound = false;
let activePayload: MinnowPreviewContextMenuOpenPayload | null = null;
let onItemSelect: ((item: PreviewContextMenuActionItem) => void) | null = null;

function ensureMenuElement(): HTMLDivElement {
  if (menuEl) return menuEl;
  menuEl = document.createElement('div');
  menuEl.className = 'preview-context-menu';
  menuEl.setAttribute('role', 'menu');
  menuEl.hidden = true;
  document.body.appendChild(menuEl);
  return menuEl;
}

/** Hide the preview context menu. */
export function hidePreviewContextMenu(): void {
  if (menuEl) menuEl.hidden = true;
  activePayload = null;
}

function bindDismissOnce(): void {
  if (dismissBound) return;
  dismissBound = true;
  document.addEventListener('click', () => hidePreviewContextMenu());
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hidePreviewContextMenu();
  });
  document.addEventListener(
    'scroll',
    () => hidePreviewContextMenu(),
    { capture: true, passive: true },
  );
}

function renderMenuItems(items: MinnowPreviewContextMenuItem[]): void {
  const menu = ensureMenuElement();
  menu.innerHTML = '';
  for (const item of items) {
    if (item.type === 'separator') {
      const sep = document.createElement('div');
      sep.className = 'preview-context-menu__separator';
      sep.setAttribute('role', 'separator');
      menu.appendChild(sep);
      continue;
    }

    const btn = createButton({ appearance: 'surface', variant: 'ghost', size: 'sm' });
    btn.type = 'button';
    setButtonClassName(btn, 'preview-context-menu__item');
    btn.setAttribute('role', 'menuitem');
    btn.textContent = item.label;
    if (!item.enabled) {
      btn.disabled = true;
      btn.classList.add('preview-context-menu__item--disabled');
    } else {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const selected: PreviewContextMenuActionItem = {
          role: item.role,
          label: item.label,
          enabled: item.enabled,
          suggestion: item.suggestion,
        };
        hidePreviewContextMenu();
        onItemSelect?.(selected);
      });
    }
    menu.appendChild(btn);
  }
}

/** Map guest-local (x, y) onto viewport client coords using #previewBody's current rect. */
export function mapGuestPointToClient(guestX: number, guestY: number): { x: number; y: number } {
  const body = document.getElementById('previewBody');
  if (!body) return { x: guestX, y: guestY };
  const rect = body.getBoundingClientRect();
  return { x: rect.left + guestX, y: rect.top + guestY };
}

function positionMenuAtCursor(clientX: number, clientY: number): void {
  const menu = ensureMenuElement();
  menu.hidden = false;
  const margin = 8;
  const rect = menu.getBoundingClientRect();
  let left = clientX;
  let top = clientY;
  if (left + rect.width > window.innerWidth - margin) {
    left = Math.max(margin, window.innerWidth - rect.width - margin);
  }
  if (top + rect.height > window.innerHeight - margin) {
    top = Math.max(margin, window.innerHeight - rect.height - margin);
  }
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

/** Show the preview context menu for a main-process open payload. */
export function showPreviewContextMenu(
  payload: MinnowPreviewContextMenuOpenPayload,
  onSelect: (item: PreviewContextMenuActionItem) => void,
): void {
  bindDismissOnce();
  activePayload = payload;
  onItemSelect = onSelect;

  renderMenuItems(payload.items);
  const mapped = mapGuestPointToClient(payload.x, payload.y);
  positionMenuAtCursor(mapped.x, mapped.y);
}

/** Payload for the menu currently open (null when hidden). */
export function getActivePreviewContextMenuPayload(): MinnowPreviewContextMenuOpenPayload | null {
  return activePayload;
}

/** Test helper — reset singleton menu state between cases. */
export function resetPreviewContextMenuForTests(): void {
  hidePreviewContextMenu();
  onItemSelect = null;
  if (menuEl) {
    menuEl.remove();
    menuEl = null;
  }
  dismissBound = false;
}

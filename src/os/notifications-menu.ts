import { openShellOverlay, shellOverlayClosed, bindShellOverlayTrigger } from '../ui/shell-overlay-state';
/**
 * OS menubar notifications popover — per-event inbox rows with chat deep-links.
 */

import { formatRelativeTime, kindLabel } from '../notifications/preview';
import { openNotificationTarget } from '../notifications/navigate';
import {
  loadNotificationPrefs,
  saveNotificationPref,
  subscribeNotificationPrefs,
} from '../notifications/prefs';
import {
  getNotifications,
  getUnreadNotificationCount,
  markAllNotificationsRead,
  subscribeNotifications,
} from '../notifications/store';
import type { NotificationRecord } from '../notifications/types';
import { getAppById } from './app-registry';
import { createAppIcon, createOsIcon, type OsIconName } from './icons';
import { closeComposerModelMenu } from '../ui/composer-model-trigger';
import { closeAppSwitcherMenu } from './app-switcher-menu';
import {
  registerChromePopover,
  unregisterChromePopover,
} from '../ui/preview-electron-visibility';

// ── State ────────────────────────────────────────────────────────────────────

let panelEl: HTMLDivElement | null = null;
let listEl: HTMLUListElement | null = null;
let emptyEl: HTMLElement | null = null;
let clearBtn: HTMLButtonElement | null = null;
let muteBtn: HTMLButtonElement | null = null;
let emptyTextEl: HTMLParagraphElement | null = null;
let emptyHintEl: HTMLParagraphElement | null = null;
let anchorBell: HTMLButtonElement | null = null;
let menuOpen = false;
let outsideHandler: ((e: PointerEvent) => void) | null = null;
let escapeHandler: ((e: KeyboardEvent) => void) | null = null;
let unsubNotifications: (() => void) | null = null;
let unsubPrefs: (() => void) | null = null;

function syncMutedUi(): void {
  const muted = loadNotificationPrefs().muted;
  panelEl?.classList.toggle('is-muted', muted);
  anchorBell?.classList.toggle('is-muted', muted);
  if (!muteBtn) return;
  muteBtn.setAttribute('aria-pressed', muted ? 'true' : 'false');
  muteBtn.setAttribute('aria-label', muted ? 'Unsilence notifications' : 'Silence notifications');
  muteBtn.title = muted ? 'Unsilence notifications' : 'Silence notifications';
  muteBtn.replaceChildren(createOsIcon(muted ? 'bellOff' : 'bell', { size: 14 }));
  if (emptyTextEl) {
    emptyTextEl.textContent = muted ? 'Notifications silenced' : 'No new notifications';
  }
  if (emptyHintEl) {
    emptyHintEl.textContent = muted
      ? 'New alerts are muted until you turn notifications back on.'
      : 'Background chats, tasks, and jobs appear here when they finish.';
  }
}

function unreadNotifications(): NotificationRecord[] {
  return getNotifications().filter((n) => !n.read);
}

function rebuildList(): void {
  if (!listEl || !emptyEl || !clearBtn) return;

  const unread = unreadNotifications();
  listEl.replaceChildren();
  listEl.hidden = unread.length === 0;
  emptyEl.hidden = unread.length > 0;
  clearBtn.hidden = unread.length === 0;

  for (const record of unread) {
    const app = getAppById(record.appId);
    if (!app) continue;

    const li = document.createElement('li');
    li.className = 'mn-os-notif-item';
    if (!record.read) li.classList.add('is-unread');

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mn-os-notif-item__btn';
    btn.addEventListener('click', () => {
      void openNotificationTarget(record);
      closeOsNotificationsMenu();
    });

    const icon = document.createElement('span');
    icon.className = 'mn-os-notif-item__icon';
    icon.appendChild(createAppIcon(app.icon as OsIconName));
    btn.appendChild(icon);

    const body = document.createElement('span');
    body.className = 'mn-os-notif-item__body';

    const head = document.createElement('span');
    head.className = 'mn-os-notif-item__head';

    const title = document.createElement('span');
    title.className = 'mn-os-notif-item__title';
    title.textContent = record.title;
    head.appendChild(title);

    const time = document.createElement('span');
    time.className = 'mn-os-notif-item__time';
    time.textContent = formatRelativeTime(record.createdAt);
    head.appendChild(time);

    body.appendChild(head);

    const meta = document.createElement('span');
    meta.className = 'mn-os-notif-item__kind';
    meta.textContent = kindLabel(record.kind);
    body.appendChild(meta);

    const preview = document.createElement('span');
    preview.className = 'mn-os-notif-item__preview';
    preview.textContent = record.preview || app.tag;
    body.appendChild(preview);

    btn.appendChild(body);
    li.appendChild(btn);
    listEl.appendChild(li);
  }
}

function positionPanel(bell: HTMLButtonElement, panel: HTMLElement): void {
  const rect = bell.getBoundingClientRect();
  const margin = 8;
  panel.style.top = `${rect.bottom + 4}px`;
  panel.style.right = 'auto';

  const panelWidth = panel.offsetWidth || panel.getBoundingClientRect().width;
  let left = rect.right - panelWidth;
  left = Math.max(margin, Math.min(left, window.innerWidth - panelWidth - margin));
  panel.style.left = `${left}px`;
}

function detachGlobalListeners(): void {
  if (outsideHandler) {
    document.removeEventListener('pointerdown', outsideHandler, true);
    outsideHandler = null;
  }
  if (escapeHandler) {
    document.removeEventListener('keydown', escapeHandler, true);
    escapeHandler = null;
  }
}

/** Close the notifications popover. */
export function closeOsNotificationsMenu(): void {
  if (!menuOpen) return;
  menuOpen = false;
  shellOverlayClosed('notifications');
  unregisterChromePopover();
  detachGlobalListeners();
  panelEl?.classList.add('hidden');
  anchorBell?.setAttribute('aria-expanded', 'false');
  anchorBell?.classList.remove('is-open');
}

function attachGlobalListeners(): void {
  outsideHandler = (e: PointerEvent) => {
    const target = e.target as Node | null;
    if (!panelEl || !anchorBell) return;
    if (panelEl.contains(target) || anchorBell.contains(target)) return;
    closeOsNotificationsMenu();
  };
  document.addEventListener('pointerdown', outsideHandler, true);

  escapeHandler = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    closeOsNotificationsMenu();
  };
  document.addEventListener('keydown', escapeHandler, true);
}

// ── Panel ────────────────────────────────────────────────────────────────────

function ensurePanel(): HTMLDivElement {
  if (panelEl) return panelEl;

  panelEl = document.createElement('div');
  panelEl.id = 'osNotificationsMenu';
  panelEl.className = 'mn-os-notif-menu hidden';
  panelEl.setAttribute('role', 'dialog');
  panelEl.setAttribute('aria-label', 'Notifications');

  const header = document.createElement('div');
  header.className = 'mn-os-notif-menu__header';

  const title = document.createElement('span');
  title.className = 'mn-os-notif-menu__title';
  title.textContent = 'Notifications';
  header.appendChild(title);

  const headerActions = document.createElement('div');
  headerActions.className = 'mn-os-notif-menu__actions';

  muteBtn = document.createElement('button');
  muteBtn.type = 'button';
  muteBtn.className = 'mn-os-notif-menu__mute';
  muteBtn.addEventListener('click', () => {
    const nextMuted = !loadNotificationPrefs().muted;
    saveNotificationPref('muted', nextMuted);
    syncMutedUi();
  });
  headerActions.appendChild(muteBtn);

  clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.className = 'mn-os-notif-menu__clear';
  clearBtn.textContent = 'Mark all read';
  clearBtn.hidden = true;
  clearBtn.addEventListener('click', () => {
    markAllNotificationsRead();
    rebuildList();
  });
  headerActions.appendChild(clearBtn);

  header.appendChild(headerActions);

  listEl = document.createElement('ul');
  listEl.className = 'mn-os-notif-menu__list';
  listEl.setAttribute('role', 'list');

  emptyEl = document.createElement('div');
  emptyEl.className = 'mn-os-notif-menu__empty';
  emptyEl.hidden = true;

  const emptyIcon = document.createElement('span');
  emptyIcon.className = 'mn-os-notif-menu__empty-icon';
  emptyIcon.appendChild(createOsIcon('bell', { size: 22 }));
  emptyEl.appendChild(emptyIcon);

  const emptyText = document.createElement('p');
  emptyText.className = 'mn-os-notif-menu__empty-text';
  emptyText.textContent = 'No new notifications';
  emptyTextEl = emptyText;
  emptyEl.appendChild(emptyText);

  const emptyHint = document.createElement('p');
  emptyHint.className = 'mn-os-notif-menu__empty-hint';
  emptyHint.textContent =
    'Background chats, tasks, and jobs appear here when they finish.';
  emptyHintEl = emptyHint;
  emptyEl.appendChild(emptyHint);

  syncMutedUi();

  panelEl.append(header, listEl, emptyEl);
  document.body.appendChild(panelEl);
  return panelEl;
}

function openMenu(): void {
  const bell = anchorBell;
  if (!bell) return;
  openShellOverlay('notifications', closeOsNotificationsMenu);
  closeComposerModelMenu();
  closeAppSwitcherMenu();
  const panel = ensurePanel();
  syncMutedUi();
  rebuildList();
  menuOpen = true;
  registerChromePopover();
  panel.classList.remove('hidden');
  bell.setAttribute('aria-expanded', 'true');
  bell.classList.add('is-open');
  positionPanel(bell, panel);
  attachGlobalListeners();
}

function toggleMenu(): void {
  if (menuOpen) closeOsNotificationsMenu();
  else openMenu();
}

// ── Init ─────────────────────────────────────────────────────────────────────

/** Wire the menubar bell to open the notifications popover. Returns cleanup. */
export function initOsNotificationsMenu(bell: HTMLButtonElement): () => void {
  anchorBell = bell;
  syncMutedUi();

  bell.setAttribute('aria-haspopup', 'dialog');
  bell.setAttribute('aria-expanded', 'false');
  bell.setAttribute('aria-controls', 'osNotificationsMenu');

  const unbindTrigger = bindShellOverlayTrigger(bell, 'notifications');
  const onBellClick = () => {
    void import('../notifications/sound').then((m) => m.unlockNotificationAudio());
    toggleMenu();
  };
  bell.addEventListener('click', onBellClick);

  unsubNotifications = subscribeNotifications(() => {
    if (menuOpen) rebuildList();
  });

  unsubPrefs = subscribeNotificationPrefs(() => {
    syncMutedUi();
    if (menuOpen) rebuildList();
  });

  return () => {
    bell.removeEventListener('click', onBellClick);
    unsubNotifications?.();
    unsubNotifications = null;
    unsubPrefs?.();
    unsubPrefs = null;
    closeOsNotificationsMenu();
    unbindTrigger();
    panelEl?.remove();
    panelEl = null;
    listEl = null;
    emptyEl = null;
    emptyTextEl = null;
    emptyHintEl = null;
    clearBtn = null;
    muteBtn = null;
    anchorBell = null;
  };
}

/** Unread count for menubar badge (exported for menubar sync). */
export { getUnreadNotificationCount };

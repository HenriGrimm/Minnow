/**
 * Menubar app switcher — compact grid of rail apps.
 */

import { listRailApps, subscribeAppPreferences } from './app-preferences';
import { getForegroundAppId, getOsView } from './instances';
import { createAppIcon } from './icons';
import { MINNOW_GLYPH_HEADER_HTML } from '../ui/minnow-glyph';
import { launchApp } from './router';
import { closeComposerModelMenu } from '../ui/composer-model-trigger';
import { markPreviewOccluder, unmarkPreviewOccluder } from '../ui/preview-occlusion';
import { APP_SWITCHER_DESKTOP_ID, type AppSwitcherItemId } from './surface-id';
import type { AppId } from './types';

export { APP_SWITCHER_DESKTOP_ID, type AppSwitcherItemId } from './surface-id';

// ── Items ────────────────────────────────────────────────────────────────────

/** One tile in the switcher grid (Desktop first, then dock apps). */
export interface AppSwitcherItem {
  id: AppSwitcherItemId;
  name: string;
  /** Icon name from the OS icon set (`minnow-glyph` for Desktop home). */
  icon: string;
  /** True when this surface is the current OS view / foreground app. */
  active: boolean;
}

/**
 * Build the ordered switcher catalog: Desktop, then the same apps as the dock.
 * Pure helper for tests and for rebuilding the open popover.
 */
export function listAppSwitcherItems(options?: {
  osView?: 'workspaces' | 'app';
  foregroundAppId?: AppId | null;
}): AppSwitcherItem[] {
  const osView = options?.osView ?? getOsView();
  const foreground = options?.foregroundAppId ?? getForegroundAppId();

  const items: AppSwitcherItem[] = [];

  for (const app of listRailApps()) {
    items.push({
      id: app.id,
      name: app.name,
      icon: app.icon,
      active: osView === 'app' && foreground === app.id,
    });
  }

  return items;
}

// ── Panel ────────────────────────────────────────────────────────────────────

let panelEl: HTMLDivElement | null = null;
let gridEl: HTMLElement | null = null;
let anchorBtn: HTMLButtonElement | null = null;
let menuOpen = false;
let outsideHandler: ((e: PointerEvent) => void) | null = null;
let escapeHandler: ((e: KeyboardEvent) => void) | null = null;
let unsubPrefs: (() => void) | null = null;

/** Close the app switcher popover. */
export function closeAppSwitcherMenu(): void {
  if (!menuOpen) return;
  menuOpen = false;
  if (panelEl) unmarkPreviewOccluder(panelEl);
  detachGlobalListeners();
  panelEl?.classList.add('hidden');
  anchorBtn?.setAttribute('aria-expanded', 'false');
  anchorBtn?.classList.remove('is-open');
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

/** Anchor the panel under the left-side menubar trigger (left-aligned). */
function positionPanel(btn: HTMLButtonElement, panel: HTMLElement): void {
  const rect = btn.getBoundingClientRect();
  const margin = 8;
  panel.style.top = `${rect.bottom + 4}px`;
  panel.style.right = 'auto';

  const panelWidth = panel.offsetWidth || panel.getBoundingClientRect().width;
  let left = rect.left;
  left = Math.max(margin, Math.min(left, window.innerWidth - panelWidth - margin));
  panel.style.left = `${left}px`;
}

/** Launch Desktop or an app, then dismiss the popover. */
function activateItem(id: AppSwitcherItemId): void {
  closeAppSwitcherMenu();
  if (id === APP_SWITCHER_DESKTOP_ID) return;
  launchApp(id);
}

/** Render icon + label for one switcher tile. */
function buildTile(item: AppSwitcherItem): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'mn-os-app-switcher__tile';
  btn.dataset.itemId = item.id;
  btn.setAttribute('aria-label', item.name);
  btn.setAttribute('aria-current', item.active ? 'true' : 'false');
  if (item.active) btn.classList.add('is-active');

  const ico = document.createElement('span');
  ico.className = 'mn-os-app-switcher__ico';
  ico.setAttribute('aria-hidden', 'true');
  if (item.id === APP_SWITCHER_DESKTOP_ID) {
    ico.innerHTML = MINNOW_GLYPH_HEADER_HTML;
  } else {
    ico.appendChild(createAppIcon(item.icon as 'code'));
  }
  btn.appendChild(ico);

  const name = document.createElement('span');
  name.className = 'mn-os-app-switcher__name';
  name.textContent = item.name;
  btn.appendChild(name);

  btn.addEventListener('click', () => activateItem(item.id));
  return btn;
}

/** Rebuild grid contents from the current dock set and focus state. */
function rebuildGrid(): void {
  if (!gridEl) return;
  gridEl.replaceChildren();
  for (const item of listAppSwitcherItems()) {
    gridEl.appendChild(buildTile(item));
  }
}

function ensurePanel(): HTMLDivElement {
  if (panelEl) return panelEl;

  panelEl = document.createElement('div');
  panelEl.id = 'osAppSwitcherMenu';
  panelEl.className = 'mn-os-app-switcher hidden';
  panelEl.setAttribute('role', 'dialog');
  panelEl.setAttribute('aria-label', 'Apps');

  const header = document.createElement('div');
  header.className = 'mn-os-app-switcher__header';
  const title = document.createElement('span');
  title.className = 'mn-os-app-switcher__title';
  title.textContent = 'Apps';
  header.appendChild(title);

  gridEl = document.createElement('div');
  gridEl.className = 'mn-os-app-switcher__grid';
  gridEl.setAttribute('role', 'menu');

  panelEl.append(header, gridEl);
  document.body.appendChild(panelEl);
  return panelEl;
}

function attachGlobalListeners(): void {
  outsideHandler = (e: PointerEvent) => {
    const target = e.target as Node | null;
    if (!panelEl || !anchorBtn) return;
    if (panelEl.contains(target) || anchorBtn.contains(target)) return;
    closeAppSwitcherMenu();
  };
  document.addEventListener('pointerdown', outsideHandler, true);

  escapeHandler = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    closeAppSwitcherMenu();
  };
  document.addEventListener('keydown', escapeHandler, true);
}

function openMenu(): void {
  const btn = anchorBtn;
  if (!btn || btn.hidden) return;

  closeComposerModelMenu();
  void import('./notifications-menu').then((m) => m.closeOsNotificationsMenu());

  const panel = ensurePanel();
  rebuildGrid();
  menuOpen = true;
  markPreviewOccluder(panel, 'menu');
  panel.classList.remove('hidden');
  btn.setAttribute('aria-expanded', 'true');
  btn.classList.add('is-open');
  positionPanel(btn, panel);
  attachGlobalListeners();
}

function toggleMenu(): void {
  if (menuOpen) closeAppSwitcherMenu();
  else openMenu();
}

// ── Init ─────────────────────────────────────────────────────────────────────

/**
 * Wire the menubar Apps button to the switcher popover.
 * Returns cleanup for menubar unmount.
 */
export function initAppSwitcherMenu(btn: HTMLButtonElement): () => void {
  anchorBtn = btn;

  btn.setAttribute('aria-haspopup', 'dialog');
  btn.setAttribute('aria-expanded', 'false');
  btn.setAttribute('aria-controls', 'osAppSwitcherMenu');
  btn.setAttribute('aria-label', 'Apps');
  btn.title = 'Apps';

  const onClick = () => toggleMenu();
  btn.addEventListener('click', onClick);

  unsubPrefs = subscribeAppPreferences(() => {
    if (menuOpen) rebuildGrid();
  });

  return () => {
    closeAppSwitcherMenu();
    btn.removeEventListener('click', onClick);
    unsubPrefs?.();
    unsubPrefs = null;
    panelEl?.remove();
    panelEl = null;
    gridEl = null;
    anchorBtn = null;
  };
}

import { scheduleAnimationFrame } from '../lib/schedule-animation-frame';
import { closeModeSelectorMenu } from './mode-selector';
import { closeComposerRunTargetMenus } from './composer-run-target';

/** Park the Cursor Fast control at or below this controls-row width. */
export const COMPOSER_COMPACT_ENTER_PX = 560;

/** Bring them back only after the row grows past this, so the class does not flicker. */
export const COMPOSER_COMPACT_LEAVE_PX = 600;

/**
 * The footer row keeps mode, worktree, context and model one click away;
 * everything else lives in the cog sheet. Settings-page order follows this list.
 */
const SETTINGS_ITEM_IDS = [
  'composerCursorFast',
  'composerContextDocumentsWrap',
  'composerCodeMapWrap',
  'composerBrainNotesWrap',
  'orchestratePlanStrip',
  'workAgentDev',
  'btnViewModeToggleBoard',
] as const;

/** Footer-row controls that only park when the row is too narrow to hold them. */
const NARROW_ITEM_IDS = new Set<string>(['composerCursorFast']);


const overflowHomes = new Map<string, { parent: Node; next: ChildNode | null }>();

/** The footer row is on once the composer is initialized. */
let compact = false;
/** Row is too narrow for secondary model controls. */
let narrow = false;
let overflowOpen = false;
let rowObserver: ResizeObserver | null = null;
let outsideHandler: ((event: PointerEvent) => void) | null = null;
let escapeHandler: ((event: KeyboardEvent) => void) | null = null;
let controlsChangedHandler: ((event: Event) => void) | null = null;
let initialized = false;
/** Original neighbor of the overflow sheet before it was portaled to `document.body`. */
let overflowPopoverHome: { parent: Node; next: ChildNode | null } | null = null;

// ── Queries ──────────────────────────────────────────────────────────────────

function getRow(): HTMLElement | null {
  return document.getElementById('composerControls');
}

function getInputBar(): HTMLElement | null {
  return getRow()?.closest('.input-bar') as HTMLElement | null;
}

function getOverflowButton(): HTMLButtonElement | null {
  return document.getElementById('btnComposerOverflow') as HTMLButtonElement | null;
}

function getOverflowPopover(): HTMLElement | null {
  return document.getElementById('composerOverflowPopover');
}

function getOverflowSlot(): HTMLElement | null {
  return document.getElementById('composerOverflowSlot');
}

function getSettingsPage(): HTMLElement | null {
  return document.getElementById('composerOverflowSettingsPage') ?? getOverflowSlot();
}



// ── State ────────────────────────────────────────────────────────────────────

/** True when the Code composer is in the footer strip (always, once initialized). */
export function isComposerControlsCompact(): boolean {
  return compact;
}

/** True when secondary model controls are parked in the cog. */
export function isComposerControlsNarrow(): boolean {
  return narrow;
}



/** Width hysteresis for the narrow strip. */
export function nextComposerCompactState(current: boolean, width: number): boolean {
  if (!Number.isFinite(width) || width <= 0) return current;
  if (current) return width <= COMPOSER_COMPACT_LEAVE_PX;
  return width < COMPOSER_COMPACT_ENTER_PX;
}

// ── Overflow ─────────────────────────────────────────────────────────────────

function detachOverflowListeners(): void {
  window.removeEventListener('resize', repositionOverflowPopover);
  window.visualViewport?.removeEventListener('resize', repositionOverflowPopover);
  window.visualViewport?.removeEventListener('scroll', repositionOverflowPopover);
  if (outsideHandler) {
    document.removeEventListener('pointerdown', outsideHandler, true);
    outsideHandler = null;
  }
  if (escapeHandler) {
    document.removeEventListener('keydown', escapeHandler, true);
    escapeHandler = null;
  }
}

/** Viewport box used to keep the overflow sheet on screen and, when it fits, inside the Code chat column so it does not slide under the chats sidebar. */
export type ComposerOverflowViewport = {
  width: number;
  height: number;
  columnLeft?: number;
  columnRight?: number;
  margin?: number;
};

/** Clamp a viewport-fixed overflow sheet. */
export function clampComposerOverflowPlacement(
  box: { top: number; left: number; width: number; height: number },
  viewport: ComposerOverflowViewport,
): { top: number; left: number } {
  const margin = viewport.margin ?? 8;
  let { top, left } = box;
  const { width, height } = box;

  const colLeft = viewport.columnLeft;
  const colRight = viewport.columnRight;
  const columnInner =
    colLeft != null && colRight != null ? colRight - colLeft - margin * 2 : Number.NaN;

  if (Number.isFinite(columnInner) && width <= columnInner && colLeft != null && colRight != null) {
    const minLeft = colLeft + margin;
    const maxLeft = colRight - width - margin;
    left = Math.min(Math.max(left, minLeft), Math.max(minLeft, maxLeft));
  }

  const minLeft = margin;
  const maxLeft = viewport.width - width - margin;
  left = Math.min(Math.max(left, minLeft), Math.max(minLeft, maxLeft));

  const minTop = margin;
  const maxTop = viewport.height - height - margin;
  top = Math.min(Math.max(top, minTop), Math.max(minTop, maxTop));

  return { top, left };
}

/** Lift the sheet to `document.body` while open. */
function portalOverflowPopover(popover: HTMLElement): void {
  if (popover.parentElement === document.body) return;
  if (popover.parentNode) {
    overflowPopoverHome = { parent: popover.parentNode, next: popover.nextSibling };
  }
  document.body.appendChild(popover);
}

/** Put the hidden sheet back next to the cog so compact DOM stays predictable. */
function unportalOverflowPopover(popover: HTMLElement): void {
  const home = overflowPopoverHome;
  overflowPopoverHome = null;
  if (!home?.parent.isConnected) return;
  const next = home.next && home.next.isConnected ? home.next : null;
  home.parent.insertBefore(popover, next);
}

function repositionOverflowPopover(): void {
  const button = getOverflowButton();
  const popover = getOverflowPopover();
  if (!button || !popover || !overflowOpen) return;
  positionFixedPanel(button, popover, 'end');
}

function firstFocusable(root: HTMLElement | null): HTMLElement | null {
  if (!root) return null;
  const candidates = root.querySelectorAll<HTMLElement>('button, select, input, a[href], [tabindex]');
  for (const el of candidates) {
    if (el.hasAttribute('disabled')) continue;
    if (el.getAttribute('tabindex') === '-1') continue;
    if (el.closest('[hidden], .hidden, [inert]')) continue;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    return el;
  }
  return null;
}

function showOverflowSettingsPage(): void {
  const settings = getSettingsPage();
  settings?.classList.remove('hidden');
  settings?.removeAttribute('hidden');
  getOverflowPopover()?.setAttribute('aria-label', 'Composer settings');
}

/** Close the overflow settings sheet (cog popover). */
export function closeComposerOverflowPopover(): void {
  const popover = getOverflowPopover();
  const button = getOverflowButton();
  if (!popover) {
    overflowOpen = false;
    overflowPopoverHome = null;
    return;
  }
  showOverflowSettingsPage();
  popover.classList.add('hidden');
  overflowOpen = false;
  button?.setAttribute('aria-expanded', 'false');
  detachOverflowListeners();
  unportalOverflowPopover(popover);
}

/** Place a panel above `anchor`, flipping below if it would clip the viewport. */
function positionFixedPanel(anchor: HTMLElement, panel: HTMLElement, align: 'start' | 'end'): void {
  panel.style.position = 'fixed';
  const rect = anchor.getBoundingClientRect();
  const margin = 8;
  const gap = 6;
  const viewport = window.visualViewport;
  const viewportHeight = viewport?.height ?? window.innerHeight;
  const viewportTop = viewport?.offsetTop ?? 0;
  const viewportLeft = viewport?.offsetLeft ?? 0;
  panel.style.maxHeight = `${Math.max(0, viewportHeight - margin * 2)}px`;
  const height = panel.offsetHeight || panel.getBoundingClientRect().height;
  const width = panel.offsetWidth || panel.getBoundingClientRect().width;

  let top = rect.top - height - gap;
  if (top < margin) {
    top = rect.bottom + gap;
  }

  const column = getInputBar()?.closest('.main-column') ?? document.getElementById('mainColumn');
  const columnRect = column?.getBoundingClientRect();
  const preferredLeft = align === 'end' ? rect.right - width : rect.left;
  const placed = clampComposerOverflowPlacement(
    { top: top - viewportTop, left: preferredLeft - viewportLeft, width, height },
    {
      width: viewport?.width ?? window.innerWidth,
      height: viewportHeight,
      columnLeft: columnRect ? columnRect.left - viewportLeft : undefined,
      columnRight: columnRect ? columnRect.right - viewportLeft : undefined,
      margin,
    },
  );

  panel.style.top = `${Math.round(placed.top + viewportTop)}px`;
  panel.style.left = `${Math.round(placed.left + viewportLeft)}px`;
}

function attachOverflowListeners(): void {
  detachOverflowListeners();
  window.addEventListener('resize', repositionOverflowPopover);
  window.visualViewport?.addEventListener('resize', repositionOverflowPopover);
  window.visualViewport?.addEventListener('scroll', repositionOverflowPopover);

  outsideHandler = (event: PointerEvent) => {
    const target = event.target;
    if (!(target instanceof Node)) return;
    const popover = getOverflowPopover();
    const button = getOverflowButton();
    if (popover?.contains(target) || button?.contains(target)) return;
    closeComposerOverflowPopover();
  };
  document.addEventListener('pointerdown', outsideHandler, true);

  escapeHandler = (event: KeyboardEvent) => {
    if (event.key === 'Tab' && overflowOpen) {
      const page = getSettingsPage();
      const nodes = Array.from(page?.querySelectorAll<HTMLElement>('button, select, input, a[href], [tabindex]') ?? [])
        .filter(el => !el.hasAttribute('disabled') && el.tabIndex >= 0 && !el.closest('[hidden], .hidden, [inert]'))
        .filter(el => {
          const style = window.getComputedStyle(el);
          return style.display !== 'none' && style.visibility !== 'hidden';
        });
      const boundary = event.shiftKey ? nodes[0] : nodes[nodes.length - 1];
      if (document.activeElement === boundary || !page?.contains(document.activeElement)) {
        event.preventDefault();
        closeComposerOverflowPopover();
        getOverflowButton()?.focus();
      }
      return;
    }
    if (event.key !== 'Escape' || !overflowOpen) return;
    event.stopPropagation();
    closeComposerOverflowPopover();
    getOverflowButton()?.focus();
  };
  document.addEventListener('keydown', escapeHandler, true);
}

function openOverflowPopover(): void {
  const popover = getOverflowPopover();
  const button = getOverflowButton();
  if (!popover || !button || !compact) return;

  closeModeSelectorMenu();
  showOverflowSettingsPage();
  portalOverflowPopover(popover);
  popover.classList.remove('hidden');
  overflowOpen = true;
  button.setAttribute('aria-expanded', 'true');
  positionFixedPanel(button, popover, 'end');
  attachOverflowListeners();
  try {
    firstFocusable(getSettingsPage())?.focus();
  } catch {
  }
}

function toggleOverflowPopover(): void {
  if (overflowOpen) {
    closeComposerOverflowPopover();
    return;
  }
  openOverflowPopover();
}

// ── Park ─────────────────────────────────────────────────────────────────────

function overflowKey(el: HTMLElement): string {
  return el.id || el.dataset.overflowId || '';
}

function ensureOverflowKey(el: HTMLElement): string {
  if (el.id) return el.id;
  if (!el.dataset.overflowId) {
    el.dataset.overflowId = `anon-${el.className.slice(0, 24)}`;
  }
  return el.dataset.overflowId;
}

/** Move one control into a page, remembering its original neighbor. */
function parkElement(el: HTMLElement, host: HTMLElement, before: Node | null = null): void {
  if (host.contains(el)) return;
  const key = ensureOverflowKey(el);
  if (!overflowHomes.has(key) && el.parentNode) {
    overflowHomes.set(key, { parent: el.parentNode, next: el.nextSibling });
  }
  if (before && before.parentNode === host) {
    host.insertBefore(el, before);
    return;
  }
  host.appendChild(el);
}

/** Put a parked control back next to the sibling it had before compact. */
function restoreElement(el: HTMLElement): void {
  const key = overflowKey(el);
  const home = key ? overflowHomes.get(key) : undefined;
  if (key) overflowHomes.delete(key);
  if (home?.parent.isConnected) {
    const next = home.next && home.next.isConnected ? home.next : null;
    home.parent.insertBefore(el, next);
    return;
  }
  const row = getRow();
  const trail = row?.querySelector('.composer-controls__trail');
  if (el.id === 'btnViewModeToggleBoard') {
    const overflowAnchor = document.getElementById('composerOverflowAnchor');
    if (overflowAnchor?.parentElement) {
      overflowAnchor.parentElement.insertBefore(el, overflowAnchor);
      return;
    }
  }
  if (trail && row) {
    row.insertBefore(el, trail);
  } else {
    row?.appendChild(el);
  }
}

function settingsElements(all = false): HTMLElement[] {
  const found: HTMLElement[] = [];
  for (const id of SETTINGS_ITEM_IDS) {
    if (!all && !narrow && NARROW_ITEM_IDS.has(id)) continue;
    const el = document.getElementById(id);
    if (el) found.push(el);
  }
  return found;
}

/** Compact row is flex, not a 4-column grid: the cog must be a sibling of the mode dropdown. */
function placeOverflowAnchor(compactMode: boolean): void {
  const anchor = document.getElementById('composerOverflowAnchor');
  const trail = getRow()?.querySelector('.composer-controls__trail');
  if (!anchor) return;

  if (!compactMode) {
    if (trail && anchor.parentElement !== trail) trail.appendChild(anchor);
    return;
  }

  const dropdown = document.getElementById('modeSelectorDropdown');
  const row = dropdown?.parentElement ?? getRow();
  if (!row) return;
  if (dropdown && anchor.parentElement === row && dropdown.nextSibling === anchor) return;
  if (dropdown) {
    row.insertBefore(anchor, dropdown.nextSibling);
    return;
  }
  if (row.firstChild !== anchor) row.insertBefore(anchor, row.firstChild);
}

// ── Sync ─────────────────────────────────────────────────────────────────────

/** Park (or restore) overflow controls to match the current compact flag. */
export function refreshComposerCompactOverflow(): void {
  const settingsPage = getSettingsPage();
  if (!settingsPage) return;

  if (compact) {
    // Leaving narrow: footer controls go back to the row, in list order.
    for (const id of [...NARROW_ITEM_IDS].reverse()) {
      const el = document.getElementById(id);
      if (!narrow && el && settingsPage.contains(el)) restoreElement(el);
    }
    for (const el of settingsElements()) {
      parkElement(el, settingsPage);
    }
    placeOverflowAnchor(true);
    return;
  }

  placeOverflowAnchor(false);
  showOverflowSettingsPage();
  for (const el of settingsElements(true).reverse()) {
    if (settingsPage.contains(el) || getOverflowSlot()?.contains(el)) {
      restoreElement(el);
    }
  }
}

function applyCompactClass(): void {
  const row = getRow();
  const bar = getInputBar();
  row?.classList.toggle('composer-controls--compact', compact);
  row?.classList.toggle('composer-controls--narrow', compact && narrow);
  bar?.classList.toggle('input-bar--composer-compact', compact);
}

function applyCompactState(nextCompact: boolean, nextNarrow: boolean): void {
  const changed = compact !== nextCompact || narrow !== nextNarrow;
  compact = nextCompact;
  narrow = nextCompact && nextNarrow;
  applyCompactClass();

  if (changed) {
    closeComposerOverflowPopover();
    closeModeSelectorMenu();
    closeComposerRunTargetMenus();
  }

  refreshComposerCompactOverflow();
}

/** Apply hysteresis to a measured `#composerControls` width; returns the narrow flag. */
export function syncComposerCompactFromWidth(width: number): boolean {
  const next = nextComposerCompactState(narrow, width);
  if (next !== narrow) applyCompactState(compact, next);
  return narrow;
}

function measureAndSync(): void {
  const row = getRow();
  if (!row) return;
  syncComposerCompactFromWidth(row.clientWidth);
}

/** Defer compact class/parking so the observer does not mutate layout in-cycle. */
const scheduleMeasureAndSync = scheduleAnimationFrame(measureAndSync);

function onOverflowButtonClick(event: MouseEvent): void {
  event.stopPropagation();
  toggleOverflowPopover();
}

function onControlsChanged(): void {
  refreshComposerCompactOverflow();
  if (overflowOpen) repositionOverflowPopover();
}

/** Wire the compact observer and overflow cog (idempotent). */
export function initComposerCompact(): void {
  const row = getRow();
  const button = getOverflowButton();
  if (!row || !button || initialized) return;
  initialized = true;

  button.addEventListener('click', onOverflowButtonClick);

  applyCompactState(true, narrow);

  controlsChangedHandler = () => onControlsChanged();
  document.addEventListener('minnow:composer-controls-changed', controlsChangedHandler);
  document.addEventListener('minnow:close-composer-overflow', closeComposerOverflowPopover);

  if (typeof ResizeObserver === 'undefined') {
    measureAndSync();
    return;
  }

  rowObserver = new ResizeObserver(() => {
    scheduleMeasureAndSync();
  });
  rowObserver.observe(row);
  measureAndSync();
}

/** Tear down observers and restore parked nodes (unit tests). */
export function disposeComposerCompactForTests(): void {
  closeComposerOverflowPopover();
  if (compact) applyCompactState(false, false);
  rowObserver?.disconnect();
  rowObserver = null;
  if (controlsChangedHandler) {
    document.removeEventListener('minnow:composer-controls-changed', controlsChangedHandler);
    controlsChangedHandler = null;
  }
  document.removeEventListener('minnow:close-composer-overflow', closeComposerOverflowPopover);
  const button = getOverflowButton();
  button?.removeEventListener('click', onOverflowButtonClick);
  overflowHomes.clear();
  overflowPopoverHome = null;
  initialized = false;
  compact = false;
  narrow = false;
  overflowOpen = false;
  getRow()?.classList.remove('composer-controls--compact', 'composer-controls--narrow');
  getInputBar()?.classList.remove('input-bar--composer-compact');
}

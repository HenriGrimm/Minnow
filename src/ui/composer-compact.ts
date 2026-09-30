import { scheduleAnimationFrame } from '../lib/schedule-animation-frame';
import { closeModeSelectorMenu } from './mode-selector';
import { closeComposerRunTargetMenus } from './composer-run-target';
import { closeComposerToolsPopover } from './composer-tools-popover';
import { loadToolConfigIntoDrawer } from '../tools/config';
import { ensureToolsSectionFilled } from './tools-list';

/** Park run target and effort too at or below this controls-row width. */
export const COMPOSER_COMPACT_ENTER_PX = 560;

/** Bring them back only after the row grows past this, so the class does not flicker. */
export const COMPOSER_COMPACT_LEAVE_PX = 600;

/**
 * The footer row keeps mode, run target, branch and effort one click away;
 * everything else lives in the cog sheet. Settings-page order follows this list.
 * Tools parks into the second page, not this list.
 */
const SETTINGS_ITEM_IDS = [
  'composerRunTargetWrap',
  'composerThinkingWrap',
  'composerContextDocumentsWrap',
  'composerCodeMapWrap',
  'composerBrainNotesWrap',
  'orchestratePlanStrip',
  'workAgentDev',
  'btnViewModeToggleBoard',
] as const;

/** Footer-row controls that only park when the row is too narrow to hold them. */
const NARROW_ITEM_IDS = new Set<string>(['composerRunTargetWrap', 'composerThinkingWrap']);

const TOOLS_ITEM_ID = 'composerToolsAnchor';

const overflowHomes = new Map<string, { parent: Node; next: ChildNode | null }>();

/** The footer row is on once the composer is initialized. */
let compact = false;
/** Row is too narrow for run target and effort. */
let narrow = false;
let overflowOpen = false;
/** True while the cog sheet is showing the Tools drill-in, not this-turn settings. */
let toolsPageOpen = false;
let rowObserver: ResizeObserver | null = null;
let outsideHandler: ((event: PointerEvent) => void) | null = null;
let escapeHandler: ((event: KeyboardEvent) => void) | null = null;
let controlsChangedHandler: ((event: Event) => void) | null = null;
let toolsNavHandler: ((event: Event) => void) | null = null;
let toolsBackHandler: ((event: Event) => void) | null = null;
let settingsLinkHandler: ((event: Event) => void) | null = null;
let toolsListClickHandler: ((event: Event) => void) | null = null;
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

function getToolsPage(): HTMLElement | null {
  return document.getElementById('composerOverflowToolsPage');
}

function getToolsBody(): HTMLElement | null {
  return document.getElementById('composerOverflowToolsBody') ?? getToolsPage();
}

function getToolsNav(): HTMLButtonElement | null {
  return document.getElementById('composerOverflowToolsNav') as HTMLButtonElement | null;
}

function getToolsBack(): HTMLButtonElement | null {
  return document.getElementById('composerOverflowToolsBack') as HTMLButtonElement | null;
}

function getEnableAllSlot(): HTMLElement | null {
  return document.getElementById('composerOverflowEnableAllSlot');
}

// ── State ────────────────────────────────────────────────────────────────────

/** True when the Code composer is in the footer strip (always, once initialized). */
export function isComposerControlsCompact(): boolean {
  return compact;
}

/** True when run target and effort are parked in the cog because the row is narrow. */
export function isComposerControlsNarrow(): boolean {
  return narrow;
}

/** True when the open cog sheet is on the Tools drill-in page. */
export function isComposerOverflowToolsPageOpen(): boolean {
  return overflowOpen && toolsPageOpen;
}

/** Width hysteresis for the narrow strip. */
export function nextComposerCompactState(current: boolean, width: number): boolean {
  if (!Number.isFinite(width) || width <= 0) return current;
  if (current) return width <= COMPOSER_COMPACT_LEAVE_PX;
  return width < COMPOSER_COMPACT_ENTER_PX;
}

// ── Overflow ─────────────────────────────────────────────────────────────────

function detachOverflowListeners(): void {
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
    if (el.hidden) continue;
    return el;
  }
  return null;
}

function setPopoverLabel(page: 'settings' | 'tools'): void {
  const popover = getOverflowPopover();
  if (!popover) return;
  if (page === 'tools') {
    popover.setAttribute('aria-labelledby', 'composerOverflowToolsTitle');
    popover.removeAttribute('aria-label');
    return;
  }
  popover.removeAttribute('aria-labelledby');
  popover.setAttribute('aria-label', 'Composer settings');
}

/** Put Enable all back in the tools list before a fill recreates the toolbar. */
function restoreEnableAllToolbar(): void {
  const slot = getEnableAllSlot();
  const list = document.getElementById('composerToolsList');
  const toolbar = slot?.querySelector('.tool-list-toolbar');
  if (toolbar && list) {
    list.insertBefore(toolbar, list.firstChild);
  }
}

/** Lift Enable all into the Tools page header so it sits with Back + title. */
function parkEnableAllToolbar(): void {
  const list = document.getElementById('composerToolsList');
  const toolbar = list?.querySelector('.tool-list-toolbar');
  const slot = getEnableAllSlot();
  if (toolbar && slot) slot.appendChild(toolbar);
}

function formatGroupMode(values: string[]): string {
  const unique = [...new Set(values)];
  if (unique.length === 0) return '';
  if (unique.length > 1) return 'Mix';
  if (unique[0] === 'full') return 'Full';
  if (unique[0] === 'ask') return 'Ask';
  if (unique[0] === 'off') return 'Off';
  return unique[0] ?? '';
}

/** Glanceable Full / Ask / Off / Mix on each Tools group row. */
function syncOverflowToolGroupModes(): void {
  const list = document.getElementById('composerToolsList');
  if (!list) return;
  for (const group of list.querySelectorAll<HTMLElement>('.tool-group--collapsible')) {
    const summary = group.querySelector(':scope > .tool-group-summary');
    if (!(summary instanceof HTMLElement)) continue;
    let modeEl = summary.querySelector<HTMLElement>(':scope > .tool-group-mode');
    if (!modeEl) {
      modeEl = document.createElement('span');
      modeEl.className = 'tool-group-mode';
      summary.appendChild(modeEl);
    }
    const values = [...group.querySelectorAll<HTMLElement>('.tool-permission-segment[aria-checked="true"]')]
      .map((el) => el.dataset.value)
      .filter((value): value is string => Boolean(value));
    const label = formatGroupMode(values);
    modeEl.textContent = label;
    const unique = [...new Set(values)];
    modeEl.dataset.mode = unique.length === 1 ? (unique[0] ?? '') : unique.length > 1 ? 'mix' : '';
  }
}

function showOverflowSettingsPage(): void {
  toolsPageOpen = false;
  const settings = getSettingsPage();
  const tools = getToolsPage();
  settings?.classList.remove('hidden');
  settings?.removeAttribute('hidden');
  tools?.classList.add('hidden');
  tools?.setAttribute('hidden', '');
  setToolsPopoverInline(false);
  restoreEnableAllToolbar();
  setPopoverLabel('settings');
}

function showOverflowToolsPage(): void {
  toolsPageOpen = true;
  const settings = getSettingsPage();
  const tools = getToolsPage();
  settings?.classList.add('hidden');
  settings?.setAttribute('hidden', '');
  tools?.classList.remove('hidden');
  tools?.removeAttribute('hidden');
  try {
    const list = document.getElementById('composerToolsList');
    if (list) {
      ensureToolsSectionFilled('composerToolsList', { variant: 'composer' });
      loadToolConfigIntoDrawer(document);
    }
  } catch {
  }
  setToolsPopoverInline(true);
  parkEnableAllToolbar();
  syncOverflowToolGroupModes();
  setPopoverLabel('tools');
}

function onToolsNavClick(event: Event): void {
  event.stopPropagation();
  showOverflowToolsPage();
  repositionOverflowPopover();
  getToolsBack()?.focus();
}

function onToolsBackClick(event: Event): void {
  event.stopPropagation();
  showOverflowSettingsPage();
  repositionOverflowPopover();
  getToolsNav()?.focus();
}

function onSettingsLinkClick(): void {
  closeComposerOverflowPopover();
}

function onToolsListClick(): void {
  if (!toolsPageOpen) return;
  syncOverflowToolGroupModes();
}

/** Close the overflow settings sheet (cog popover). */
export function closeComposerOverflowPopover(): void {
  const popover = getOverflowPopover();
  const button = getOverflowButton();
  if (!popover) {
    overflowOpen = false;
    overflowPopoverHome = null;
    toolsPageOpen = false;
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
  const height = panel.offsetHeight || panel.getBoundingClientRect().height;
  const width = panel.offsetWidth || panel.getBoundingClientRect().width;

  let top = rect.top - height - gap;
  if (top < margin) {
    top = rect.bottom + gap;
  }

  const column = document.getElementById('mainColumn');
  const columnRect = column?.getBoundingClientRect();
  const preferredLeft = align === 'end' ? rect.right - width : rect.left;
  const placed = clampComposerOverflowPlacement(
    { top, left: preferredLeft, width, height },
    {
      width: window.innerWidth,
      height: window.innerHeight,
      columnLeft: columnRect?.left,
      columnRight: columnRect?.right,
      margin,
    },
  );

  panel.style.top = `${Math.round(placed.top)}px`;
  panel.style.left = `${Math.round(placed.left)}px`;
}

function attachOverflowListeners(): void {
  detachOverflowListeners();

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
  if (el.id === TOOLS_ITEM_ID || el.id === 'btnViewModeToggleBoard') {
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

function overflowElements(): HTMLElement[] {
  const found = settingsElements(true);
  const tools = document.getElementById(TOOLS_ITEM_ID);
  if (tools) found.push(tools);
  return found;
}

function setToolsPopoverInline(inline: boolean): void {
  const popover = document.getElementById('composerToolsPopover');
  if (!popover) return;
  popover.classList.toggle('hidden', !inline);
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
  const toolsBody = getToolsBody();
  if (!settingsPage) return;

  if (compact) {
    const nav = getToolsNav();
    // Leaving narrow: footer controls go back to the row, in list order.
    for (const id of [...NARROW_ITEM_IDS].reverse()) {
      const el = document.getElementById(id);
      if (!narrow && el && settingsPage.contains(el)) restoreElement(el);
    }
    for (const el of settingsElements()) {
      parkElement(el, settingsPage, nav);
    }
    const tools = document.getElementById(TOOLS_ITEM_ID);
    if (tools && toolsBody) parkElement(tools, toolsBody);
    setToolsPopoverInline(toolsPageOpen);
    placeOverflowAnchor(true);
    return;
  }

  restoreEnableAllToolbar();
  placeOverflowAnchor(false);
  setToolsPopoverInline(false);
  showOverflowSettingsPage();
  for (const el of overflowElements().reverse()) {
    if (settingsPage.contains(el) || toolsBody?.contains(el) || getOverflowSlot()?.contains(el)) {
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
    closeComposerToolsPopover();
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

  const nav = getToolsNav();
  const back = getToolsBack();
  const settingsLink = document.getElementById('composerToolsOpenSettings');
  const toolsList = document.getElementById('composerToolsList');

  toolsNavHandler = onToolsNavClick;
  toolsBackHandler = onToolsBackClick;
  settingsLinkHandler = onSettingsLinkClick;
  toolsListClickHandler = onToolsListClick;
  nav?.addEventListener('click', toolsNavHandler);
  back?.addEventListener('click', toolsBackHandler);
  settingsLink?.addEventListener('click', settingsLinkHandler);
  toolsList?.addEventListener('click', toolsListClickHandler);

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
  const nav = getToolsNav();
  const back = getToolsBack();
  const settingsLink = document.getElementById('composerToolsOpenSettings');
  const toolsList = document.getElementById('composerToolsList');
  if (toolsNavHandler) nav?.removeEventListener('click', toolsNavHandler);
  if (toolsBackHandler) back?.removeEventListener('click', toolsBackHandler);
  if (settingsLinkHandler) settingsLink?.removeEventListener('click', settingsLinkHandler);
  if (toolsListClickHandler) toolsList?.removeEventListener('click', toolsListClickHandler);
  toolsNavHandler = null;
  toolsBackHandler = null;
  settingsLinkHandler = null;
  toolsListClickHandler = null;
  overflowHomes.clear();
  overflowPopoverHome = null;
  initialized = false;
  compact = false;
  narrow = false;
  overflowOpen = false;
  toolsPageOpen = false;
  getRow()?.classList.remove('composer-controls--compact', 'composer-controls--narrow');
  getInputBar()?.classList.remove('input-bar--composer-compact');
}

import { getFilePanelState, patchFilePanelState } from '../state/file-panel';
import { scheduleSaveSessions, sessionState } from '../state/sessions';
import { createPointerFrame } from './pointer-frame';
import { isCodeFileOverlayLayout } from './code-responsive-layout';

export const DEFAULT_CHAT_SIDEBAR_W = 300;
export const DEFAULT_FILE_SIDEBAR_W = 350;
export const CHAT_SIDEBAR_MIN_W = 200;
export const CHAT_SIDEBAR_MAX_W = 520;
export const FILE_SIDEBAR_MIN_W = 220;
export const FILE_SIDEBAR_MAX_W = 560;

const MOBILE_LAYOUT_MQ = '(max-width: 640px)';

// ── Width ────────────────────────────────────────────────────────────────────

function isMobileLayout(): boolean {
  return window.matchMedia(MOBILE_LAYOUT_MQ).matches;
}

export function clampChatSidebarWidth(px: number): number {
  if (!Number.isFinite(px)) return DEFAULT_CHAT_SIDEBAR_W;
  return Math.min(CHAT_SIDEBAR_MAX_W, Math.max(CHAT_SIDEBAR_MIN_W, Math.round(px)));
}

export function clampFileSidebarWidth(px: number): number {
  if (!Number.isFinite(px)) return DEFAULT_FILE_SIDEBAR_W;
  return Math.min(FILE_SIDEBAR_MAX_W, Math.max(FILE_SIDEBAR_MIN_W, Math.round(px)));
}

function resolvedChatSidebarWidth(): number {
  return clampChatSidebarWidth(sessionState?.sidebarWidth ?? DEFAULT_CHAT_SIDEBAR_W);
}

function resolvedFileSidebarWidth(): number {
  return clampFileSidebarWidth(getFilePanelState().fileSidebarWidth ?? DEFAULT_FILE_SIDEBAR_W);
}

/** Push persisted sidebar widths onto #appBody CSS variables. */
export function syncAppBodySidebarWidthVars(): void {
  const body = document.getElementById('appBody');
  if (!body) return;
  body.style.setProperty('--sidebar-w', `${resolvedChatSidebarWidth()}px`);
  body.style.setProperty('--file-sidebar-w', `${resolvedFileSidebarWidth()}px`);
}

function schedulePreviewLayoutSyncIfNeeded(): void {
  if (getFilePanelState().rightPaneMode !== 'preview') return;
  if (!window.minnow?.preview) return;
  void import('./preview-electron-visibility').then((m) => {
    m.scheduleElectronPreviewHostLayoutSync();
  });
}

function maxWidthForContainer(containerRect: DOMRect, minWidth: number, hardMax: number): number {
  const viewportCap = Math.floor(containerRect.width * 0.55);
  return Math.max(minWidth, Math.min(hardMax, viewportCap));
}

function setResizerEnabled(resizer: HTMLElement | null, enabled: boolean): void {
  if (!resizer) return;
  resizer.hidden = !enabled;
  resizer.setAttribute('aria-hidden', enabled ? 'false' : 'true');
  resizer.tabIndex = enabled ? 0 : -1;
  if (!enabled) resizer.classList.remove('dragging');
}

// ── Resizers ─────────────────────────────────────────────────────────────────

export function syncChatSidebarResizer(): void {
  const resizer = document.getElementById('chatSidebarResizer');
  const collapsed = sessionState?.sidebarCollapsed === true;
  setResizerEnabled(resizer, !isMobileLayout() && !collapsed);
}

export function syncFileSidebarResizer(): void {
  const resizer = document.getElementById('fileSidebarResizer');
  const collapsed = getFilePanelState().fileSidebarCollapsed;
  setResizerEnabled(resizer, !isMobileLayout() && !isCodeFileOverlayLayout() && !collapsed);
}

type SidebarResizeSide = 'start' | 'end';

interface BindSidebarResizerOptions {
  resizer: HTMLElement;
  container: HTMLElement;
  side: SidebarResizeSide;
  minWidth: number;
  hardMaxWidth: number;
  readWidth: () => number;
  writeWidth: (width: number) => void;
  cssProperty: string;
  onDragEnd?: () => void;
}

// ── Init ─────────────────────────────────────────────────────────────────────

function bindSidebarResizer(options: BindSidebarResizerOptions): void {
  const { resizer, container, side, minWidth, hardMaxWidth, readWidth, writeWidth, cssProperty, onDragEnd } =
    options;
  let dragging = false;
  let dragRect: DOMRect;
  let maxWidth = hardMaxWidth;
  let liveWidth: number | null = null;

  const pointerFrame = createPointerFrame((clientX) => {
    if (!dragging || resizer.hidden) return;
    const nextWidth =
      side === 'start'
        ? clientX - dragRect.left
        : dragRect.right - clientX;
    const clamped = Math.min(maxWidth, Math.max(minWidth, Math.round(nextWidth)));
    liveWidth = clamped;
    container.style.setProperty(cssProperty, `${clamped}px`);
    schedulePreviewLayoutSyncIfNeeded();
    resizer.setAttribute('aria-valuenow', String(clamped));
  });
  const onPointerMove = (e: PointerEvent): void => {
    if (dragging && !resizer.hidden) pointerFrame.schedule(e.clientX);
  };

  const stopDrag = (): void => {
    if (!dragging) return;
    pointerFrame.flush();
    dragging = false;
    if (liveWidth !== null) writeWidth(liveWidth);
    syncAppBodySidebarWidthVars();
    resizer.classList.remove('dragging');
    document.body.style.removeProperty('cursor');
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', stopDrag);
    window.removeEventListener('pointercancel', stopDrag);
    window.removeEventListener('blur', stopDrag);
    onDragEnd?.();
  };

  resizer.addEventListener('pointerdown', (e) => {
    if (resizer.hidden) return;
    e.preventDefault();
    dragging = true;
    liveWidth = null;
    dragRect = container.getBoundingClientRect();
    maxWidth = maxWidthForContainer(dragRect, minWidth, hardMaxWidth);
    resizer.classList.add('dragging');
    resizer.setPointerCapture(e.pointerId);
    document.body.style.cursor = 'col-resize';
    resizer.setAttribute('aria-valuenow', String(readWidth()));
    resizer.setAttribute('aria-valuemin', String(minWidth));
    resizer.setAttribute('aria-valuemax', String(maxWidth));
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', stopDrag);
    window.addEventListener('pointercancel', stopDrag);
    window.addEventListener('blur', stopDrag);
  });

  resizer.addEventListener('lostpointercapture', stopDrag);
}

let resizersBound = false;

/** Wire chat and file sidebar drag handles once at boot. */
export function initAppSidebarResizers(): void {
  if (resizersBound) return;
  const body = document.getElementById('appBody');
  const chatResizer = document.getElementById('chatSidebarResizer');
  const fileResizer = document.getElementById('fileSidebarResizer');
  if (!body || !chatResizer || !fileResizer) return;
  resizersBound = true;

  bindSidebarResizer({
    resizer: chatResizer,
    container: body,
    side: 'start',
    minWidth: CHAT_SIDEBAR_MIN_W,
    hardMaxWidth: CHAT_SIDEBAR_MAX_W,
    readWidth: resolvedChatSidebarWidth,
    cssProperty: '--sidebar-w',
    writeWidth: (width) => {
      if (!sessionState) return;
      sessionState.sidebarWidth = width;
    },
    onDragEnd: () => {
      scheduleSaveSessions();
    },
  });

  bindSidebarResizer({
    resizer: fileResizer,
    container: body,
    side: 'end',
    minWidth: FILE_SIDEBAR_MIN_W,
    hardMaxWidth: FILE_SIDEBAR_MAX_W,
    readWidth: resolvedFileSidebarWidth,
    cssProperty: '--file-sidebar-w',
    writeWidth: (width) => {
      patchFilePanelState({ fileSidebarWidth: width });
    },
  });

  syncAppBodySidebarWidthVars();
  syncChatSidebarResizer();
  syncFileSidebarResizer();

  window.addEventListener('resize', () => {
    syncChatSidebarResizer();
    syncFileSidebarResizer();
    syncAppBodySidebarWidthVars();
  });
}

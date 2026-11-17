/** Left-edge drag resize for the docked (inline) issue detail column. */

const STORAGE_KEY = 'minnow-issues-detail-inline-width-v1';
const WIDTH_VAR = '--issues-detail-inline-w';
const HANDLE_ID = 'issuesDetailResizer';
export const ISSUES_DETAIL_MIN_WIDTH = 300;
/** Room always left for the issue list beside the column. */
const LIST_MIN_WIDTH = 320;
const KEY_STEP = 24;

function viewRoot(): HTMLElement | null {
  return document.getElementById('issuesView');
}

function bodyWidth(host: HTMLElement): number {
  const body = host.closest('.issues-body') as HTMLElement | null;
  return body?.getBoundingClientRect().width || window.innerWidth;
}

function clampWidth(px: number, host: HTMLElement): number {
  const max = Math.max(ISSUES_DETAIL_MIN_WIDTH, Math.floor(bodyWidth(host) - LIST_MIN_WIDTH));
  return Math.min(max, Math.max(ISSUES_DETAIL_MIN_WIDTH, Math.round(px)));
}

function loadSavedWidth(): number | null {
  try {
    const parsed = Number.parseInt(localStorage.getItem(STORAGE_KEY) ?? '', 10);
    return Number.isFinite(parsed) && parsed >= ISSUES_DETAIL_MIN_WIDTH ? parsed : null;
  } catch {
    return null;
  }
}

function saveWidth(px: number | null): void {
  try {
    if (px === null) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, String(Math.round(px)));
  } catch {
    // The current width still applies when preferences cannot be saved.
  }
}

/** Apply a column width, or clear it to fall back to the CSS default. */
function applyWidth(px: number | null): void {
  const root = viewRoot();
  if (!root) return;
  // The CSS cap keeps the list usable when the window shrinks after a drag.
  if (px === null) root.style.removeProperty(WIDTH_VAR);
  else root.style.setProperty(WIDTH_VAR, `min(${Math.round(px)}px, calc(100% - ${LIST_MIN_WIDTH}px))`);
}

function syncAria(handle: HTMLElement, host: HTMLElement): void {
  handle.setAttribute('aria-valuemin', String(ISSUES_DETAIL_MIN_WIDTH));
  handle.setAttribute('aria-valuemax', String(clampWidth(Number.MAX_SAFE_INTEGER, host)));
  handle.setAttribute('aria-valuenow', String(Math.round(host.getBoundingClientRect().width)));
}

function createHandle(host: HTMLElement): HTMLElement {
  const handle = document.createElement('div');
  handle.id = HANDLE_ID;
  handle.className = 'issues-detail__resize';
  handle.setAttribute('role', 'separator');
  handle.setAttribute('aria-orientation', 'vertical');
  handle.setAttribute('aria-label', 'Resize issue panel');
  handle.title = 'Drag or use arrow keys to resize. Double-click to reset.';
  handle.tabIndex = 0;

  let dragging = false;
  const onPointerMove = (event: PointerEvent): void => {
    if (!dragging) return;
    applyWidth(clampWidth(host.getBoundingClientRect().right - event.clientX, host));
  };
  const stopDrag = (): void => {
    if (!dragging) return;
    dragging = false;
    host.classList.remove('is-resizing');
    handle.classList.remove('dragging');
    document.body.style.removeProperty('cursor');
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', stopDrag);
    window.removeEventListener('pointercancel', stopDrag);
    window.removeEventListener('blur', stopDrag);
    const width = host.getBoundingClientRect().width;
    if (width >= ISSUES_DETAIL_MIN_WIDTH) saveWidth(width);
    syncAria(handle, host);
  };

  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    dragging = true;
    host.classList.add('is-resizing');
    handle.classList.add('dragging');
    handle.setPointerCapture?.(event.pointerId);
    document.body.style.cursor = 'col-resize';
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', stopDrag);
    window.addEventListener('pointercancel', stopDrag);
    window.addEventListener('blur', stopDrag);
  });
  handle.addEventListener('lostpointercapture', stopDrag);
  handle.addEventListener('keydown', (event) => {
    if (event.key === 'Home') {
      event.preventDefault();
      resetIssuesDetailWidth();
      syncAria(handle, host);
      return;
    }
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const next = clampWidth(host.getBoundingClientRect().width + (event.key === 'ArrowLeft' ? KEY_STEP : -KEY_STEP), host);
    applyWidth(next);
    saveWidth(next);
    syncAria(handle, host);
  });
  handle.addEventListener('dblclick', () => {
    resetIssuesDetailWidth();
    syncAria(handle, host);
  });
  return handle;
}

/** Restore the saved width and back the column with the CSS default. */
export function resetIssuesDetailWidth(): void {
  applyWidth(null);
  saveWidth(null);
}

/** Show the resize handle only while the detail is a docked column. */
export function syncIssuesDetailResizer(host: HTMLElement | null, inline: boolean): void {
  const existing = document.getElementById(HANDLE_ID);
  if (!host || !inline) {
    existing?.remove();
    return;
  }
  applyWidth(loadSavedWidth());
  const handle = existing && existing.parentElement === host ? existing : createHandle(host);
  if (existing && existing !== handle) existing.remove();
  if (handle.parentElement !== host) host.prepend(handle);
  syncAria(handle, host);
}

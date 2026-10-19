const STORAGE_KEY = 'minnow-brain-graph-sidebar-width';
const DEFAULT_WIDTH = 300;
const MIN_WIDTH = 200;
/** Legacy fixed rail width before resize shipped — treat as “no saved preference”. */
const LEGACY_DEFAULT_WIDTH = 232;

let listenersBound = false;

function clampWidth(px: number, stage?: HTMLElement | null): number {
  const stageWidth = stage?.getBoundingClientRect().width || window.innerWidth;
  const maxWidth = Math.max(MIN_WIDTH, Math.floor(stageWidth * 0.3));
  return Math.min(maxWidth, Math.max(MIN_WIDTH, Math.round(px)));
}

function loadSavedWidth(): number {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return DEFAULT_WIDTH;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_WIDTH;
  if (parsed === LEGACY_DEFAULT_WIDTH) return DEFAULT_WIDTH;
  return parsed;
}

function saveWidth(px: number): void {
  localStorage.setItem(STORAGE_KEY, String(px));
}

function getSidebar(): HTMLElement | null {
  return document.querySelector('#brainSection-graph .brain-graph-sidebar') as HTMLElement | null;
}

/** Apply sidebar width via CSS variable + inline width on the rail element. */
export function applyBrainGraphSidebarWidth(px: number): void {
  const sidebar = getSidebar();
  const root = document.getElementById('brainView');
  const stage =
    (sidebar?.closest('.brain-stage') as HTMLElement | null) ??
    root?.querySelector('.brain-stage');
  const w = clampWidth(px, stage);
  if (root) root.style.setProperty('--brain-graph-sidebar-w', `${w}px`);
  if (sidebar) sidebar.style.width = `${w}px`;
  const handle = document.getElementById('brainGraphSidebarResize');
  handle?.setAttribute('aria-valuemax', String(clampWidth(Number.MAX_SAFE_INTEGER, stage)));
  handle?.setAttribute('aria-valuenow', String(w));
}

/** Restore saved sidebar width when Brain graph is shown. */
export function restoreBrainGraphSidebarWidth(): void {
  applyBrainGraphSidebarWidth(loadSavedWidth());
}

function getSidebarElements(): {
  sidebar: HTMLElement;
  handle: HTMLElement;
  stage: HTMLElement | null;
} | null {
  const sidebar = getSidebar();
  const handle = document.getElementById('brainGraphSidebarResize');
  if (!sidebar || !handle) return null;
  const stage = sidebar.closest('.brain-stage') as HTMLElement | null;
  return { sidebar, handle, stage };
}

/** Wire right-edge drag resize on the graph page tree rail. */
export function initBrainGraphSidebarResize(): void {
  const els = getSidebarElements();
  if (!els) return;

  restoreBrainGraphSidebarWidth();

  if (listenersBound) return;
  listenersBound = true;

  const { sidebar, handle, stage } = els;

  let dragging = false;

  const onPointerMove = (e: PointerEvent): void => {
    if (!dragging) return;
    const rect = sidebar.getBoundingClientRect();
    const next = clampWidth(e.clientX - rect.left, stage);
    applyBrainGraphSidebarWidth(next);
    handle.setAttribute('aria-valuenow', String(next));
  };

  const stopDrag = (): void => {
    if (!dragging) return;
    dragging = false;
    sidebar.classList.remove('is-resizing');
    handle.classList.remove('dragging');
    document.body.style.removeProperty('cursor');
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', stopDrag);
    window.removeEventListener('pointercancel', stopDrag);
    window.removeEventListener('blur', stopDrag);

    const width = sidebar.getBoundingClientRect().width;
    if (width >= MIN_WIDTH) saveWidth(width);
  };

  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    dragging = true;
    sidebar.classList.add('is-resizing');
    handle.classList.add('dragging');
    handle.setPointerCapture(e.pointerId);
    document.body.style.cursor = 'col-resize';
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', stopDrag);
    window.addEventListener('pointercancel', stopDrag);
    window.addEventListener('blur', stopDrag);
  });

  handle.addEventListener('lostpointercapture', stopDrag);

  handle.title = 'Drag or use arrow keys to resize. Double-click to reset.';
  handle.tabIndex = 0;
  handle.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home') return;
    e.preventDefault();
    const next = e.key === 'Home'
      ? DEFAULT_WIDTH
      : sidebar.getBoundingClientRect().width + (e.key === 'ArrowRight' ? 24 : -24);
    applyBrainGraphSidebarWidth(next);
    const width = sidebar.getBoundingClientRect().width;
    handle.setAttribute('aria-valuenow', String(Math.round(width)));
    saveWidth(width);
  });
  handle.addEventListener('dblclick', () => {
    applyBrainGraphSidebarWidth(DEFAULT_WIDTH);
    saveWidth(DEFAULT_WIDTH);
  });
}

/** Re-apply width after graph section render (tests). */
export function resetBrainGraphSidebarResizeForTests(): void {
  listenersBound = false;
}

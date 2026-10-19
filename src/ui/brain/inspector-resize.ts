const STORAGE_KEY = 'minnow-brain-inspector-width-v2';
const DEFAULT_WIDTH = 532;
const MIN_WIDTH = 420;

let bound = false;

function clampWidth(px: number, stage?: HTMLElement | null): number {
  const stageWidth = stage?.getBoundingClientRect().width || window.innerWidth;
  const maxWidth = Math.max(MIN_WIDTH, Math.floor(stageWidth * 0.52));
  return Math.min(maxWidth, Math.max(MIN_WIDTH, Math.round(px)));
}

function loadSavedWidth(): number {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return DEFAULT_WIDTH;
  const parsed = Number.parseInt(raw, 10);
  if (parsed === 760) return DEFAULT_WIDTH;
  return Number.isFinite(parsed) && parsed >= MIN_WIDTH ? parsed : DEFAULT_WIDTH;
}

function saveWidth(px: number): void {
  localStorage.setItem(STORAGE_KEY, String(px));
}

/** Apply inspector width via CSS variable on the Brain root. */
export function applyBrainInspectorWidth(px: number): void {
  const root = document.getElementById('brainView');
  if (!root) return;
  const stage = root.querySelector('.brain-stage') as HTMLElement | null;
  const width = clampWidth(px, stage);
  root.style.setProperty('--brain-inspector-w', `${width}px`);
  const handle = document.getElementById('brainInspectorResize');
  handle?.setAttribute('aria-valuemin', String(MIN_WIDTH));
  handle?.setAttribute('aria-valuemax', String(clampWidth(Number.MAX_SAFE_INTEGER, stage)));
  handle?.setAttribute('aria-valuenow', String(width));
}

/** Restore saved inspector width when Brain mounts. */
export function restoreBrainInspectorWidth(): void {
  applyBrainInspectorWidth(loadSavedWidth());
}

function getInspectorElements(): {
  inspector: HTMLElement;
  handle: HTMLElement;
  stage: HTMLElement | null;
} | null {
  const inspector = document.getElementById('brainInspector');
  const handle = document.getElementById('brainInspectorResize');
  if (!inspector || !handle) return null;
  const stage = inspector.closest('.brain-stage') as HTMLElement | null;
  return { inspector, handle, stage };
}

/** Wire left-edge drag resize on the Brain inspector panel. */
export function initBrainInspectorResize(): void {
  if (bound) return;
  const els = getInspectorElements();
  if (!els) return;
  bound = true;

  const { inspector, handle, stage } = els;
  restoreBrainInspectorWidth();

  let dragging = false;

  const onPointerMove = (e: PointerEvent): void => {
    if (!dragging) return;
    const rect = inspector.getBoundingClientRect();
    const next = clampWidth(rect.right - e.clientX, stage);
    applyBrainInspectorWidth(next);
    handle.setAttribute('aria-valuenow', String(next));
  };

  const stopDrag = (): void => {
    if (!dragging) return;
    dragging = false;
    inspector.classList.remove('is-resizing');
    handle.classList.remove('dragging');
    document.body.style.removeProperty('cursor');
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', stopDrag);
    window.removeEventListener('pointercancel', stopDrag);
    window.removeEventListener('blur', stopDrag);

    const width = inspector.getBoundingClientRect().width;
    if (width >= MIN_WIDTH) saveWidth(width);
  };

  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !inspector.classList.contains('is-open')) return;
    e.preventDefault();
    dragging = true;
    inspector.classList.add('is-resizing');
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
      : inspector.getBoundingClientRect().width + (e.key === 'ArrowLeft' ? 24 : -24);
    applyBrainInspectorWidth(next);
    const width = inspector.getBoundingClientRect().width;
    handle.setAttribute('aria-valuenow', String(Math.round(width)));
    saveWidth(width);
  });
  handle.addEventListener('dblclick', () => {
    applyBrainInspectorWidth(DEFAULT_WIDTH);
    saveWidth(DEFAULT_WIDTH);
  });
}

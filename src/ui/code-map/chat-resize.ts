import { createPointerFrame } from '../pointer-frame';

const WIDTH_KEY = 'minnow.codeMapChatWidth';
const MIN_WIDTH = 320;
const DEFAULT_WIDTH = 480;

/** Resize the chat without moving the map, and retain the last chosen reading width. */
export function bindCodeMapChatResize(root: HTMLElement, sidebar: HTMLElement): () => void {
  const handle = document.createElement('div');
  handle.className = 'code-map-chat__resize';
  handle.tabIndex = 0;
  handle.setAttribute('role', 'separator');
  handle.setAttribute('aria-label', 'Resize code map chat');
  handle.setAttribute('aria-orientation', 'vertical');
  handle.setAttribute('aria-controls', sidebar.id);
  handle.title = 'Drag to resize chat. Arrow keys adjust width; double-click resets.';
  root.insertBefore(handle, sidebar);
  let preferred = DEFAULT_WIDTH;
  try {
    const saved = Number(localStorage.getItem(WIDTH_KEY));
    if (Number.isFinite(saved) && saved >= MIN_WIDTH) preferred = saved;
  } catch { /* Storage can be unavailable in private windows. */ }
  let width = preferred;
  let pointerId: number | null = null;
  let startX = 0;
  let startWidth = 0;
  let dragMax = MIN_WIDTH;
  const maximum = () => Math.max(MIN_WIDTH, Math.min(root.clientWidth - 280, root.clientWidth * 0.75));
  const apply = (next: number, max = maximum()) => {
    width = Math.round(Math.max(MIN_WIDTH, Math.min(max, next)));
    root.style.setProperty('--code-map-chat-width', `${width}px`);
    handle.setAttribute('aria-valuemin', String(MIN_WIDTH));
    handle.setAttribute('aria-valuemax', String(Math.round(max)));
    handle.setAttribute('aria-valuenow', String(width));
    handle.setAttribute('aria-valuetext', `${width} pixels wide`);
  };
  const persist = () => {
    preferred = width;
    try { localStorage.setItem(WIDTH_KEY, String(width)); } catch { /* Keep the live width. */ }
  };
  const frame = createPointerFrame((x) => apply(startWidth + startX - x, dragMax));
  const finish = () => {
    if (pointerId === null) return;
    frame.flush();
    const id = pointerId;
    pointerId = null;
    if (handle.hasPointerCapture?.(id)) handle.releasePointerCapture(id);
    root.classList.remove('code-brain-map-root--resizing');
    persist();
  };
  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || root.clientWidth <= 760 || pointerId !== null) return;
    event.preventDefault();
    startX = event.clientX;
    startWidth = sidebar.getBoundingClientRect().width;
    dragMax = maximum();
    pointerId = event.pointerId;
    handle.setPointerCapture(event.pointerId);
    root.classList.add('code-brain-map-root--resizing');
  });
  handle.addEventListener('pointermove', (event) => {
    if (event.pointerId === pointerId) frame.schedule(event.clientX);
  });
  handle.addEventListener('pointerup', finish);
  handle.addEventListener('pointercancel', finish);
  handle.addEventListener('lostpointercapture', finish);
  handle.addEventListener('keydown', (event) => {
    const step = event.shiftKey ? 80 : 24;
    const next = event.key === 'ArrowLeft' ? width + step
      : event.key === 'ArrowRight' ? width - step
      : event.key === 'Home' ? MIN_WIDTH
      : event.key === 'End' ? maximum() : null;
    if (next === null) return;
    event.preventDefault();
    apply(next);
    persist();
  });
  handle.addEventListener('dblclick', () => { apply(DEFAULT_WIDTH); persist(); });
  const resize = () => { if (pointerId === null && root.clientWidth > 760) apply(preferred); };
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null;
  observer?.observe(root);
  window.addEventListener('blur', finish);
  resize();
  return () => {
    finish();
    observer?.disconnect();
    window.removeEventListener('blur', finish);
    handle.remove();
    root.style.removeProperty('--code-map-chat-width');
  };
}

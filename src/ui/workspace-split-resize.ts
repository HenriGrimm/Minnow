import {
  SPLIT_DRAG_CHAT_COLLAPSE_THRESHOLD,
  SPLIT_RATIO_MAX,
  SPLIT_RATIO_MIN,
  getFilePanelState,
  patchFilePanelState,
} from '../state/file-panel';
import {
  applyFileSidebarVisuals,
  collapseChatColumnFromDrag,
  isChatColumnDragCollapsed,
  restoreChatColumnFromDrag,
} from './file-layout';
import { createPointerFrame } from './pointer-frame';

/** Live drag range (wider than persisted split ratio). */
export const SPLIT_DRAG_RATIO_MIN = 0.05;
export const SPLIT_DRAG_RATIO_MAX = 0.95;

let resizerBound = false;

function clampDragRatio(ratio: number): number {
  return Math.min(SPLIT_DRAG_RATIO_MAX, Math.max(SPLIT_DRAG_RATIO_MIN, ratio));
}

function clampPersistedRatio(ratio: number): number {
  return Math.min(SPLIT_RATIO_MAX, Math.max(SPLIT_RATIO_MIN, ratio));
}

function syncResizerAria(resizer: HTMLElement, ratio: number): void {
  resizer.setAttribute('aria-valuemin', String(Math.round(SPLIT_DRAG_RATIO_MIN * 100)));
  resizer.setAttribute('aria-valuemax', String(Math.round(SPLIT_DRAG_RATIO_MAX * 100)));
  resizer.setAttribute('aria-valuenow', String(Math.round(ratio * 100)));
}

/** Wire workspace split drag handle once at boot. */
export function bindWorkspaceSplitResizer(): void {
  if (resizerBound) return;
  const resizer = document.getElementById('splitResizer');
  const split = document.getElementById('workspaceSplit');
  if (!resizer || !split) return;
  resizerBound = true;

  let dragging = false;
  let ratioAtDragStart = getFilePanelState().splitRatio;
  let dragRect: DOMRect;

  const pointerFrame = createPointerFrame((clientX) => {
    if (!dragging || dragRect.width <= 0) return;
    const ratio = clampDragRatio((clientX - dragRect.left) / dragRect.width);
    split.style.setProperty('--split-ratio', String(ratio));
    syncResizerAria(resizer, ratio);
  });
  const onPointerMove = (e: PointerEvent): void => {
    if (dragging) pointerFrame.schedule(e.clientX);
  };

  const stopDrag = (): void => {
    if (!dragging) return;
    pointerFrame.flush();
    dragging = false;
    resizer.classList.remove('dragging');
    document.body.style.removeProperty('cursor');
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', stopDrag);
    window.removeEventListener('pointercancel', stopDrag);
    window.removeEventListener('blur', stopDrag);

    const rawStyle = split.style.getPropertyValue('--split-ratio');
    const liveRatio = rawStyle ? Number.parseFloat(rawStyle) : ratioAtDragStart;
    const ratio = Number.isFinite(liveRatio) ? liveRatio : ratioAtDragStart;

    if (isChatColumnDragCollapsed()) {
      if (ratio > SPLIT_DRAG_CHAT_COLLAPSE_THRESHOLD) {
        restoreChatColumnFromDrag();
        patchFilePanelState({ splitRatio: clampPersistedRatio(ratio) });
      }
      applyFileSidebarVisuals();
      syncResizerAria(resizer, getFilePanelState().splitRatio);
      return;
    }

    if (
      ratio <= SPLIT_DRAG_CHAT_COLLAPSE_THRESHOLD &&
      getFilePanelState().rightPaneMode !== null
    ) {
      collapseChatColumnFromDrag();
      applyFileSidebarVisuals();
      syncResizerAria(resizer, getFilePanelState().splitRatio);
      return;
    }

    const persisted = clampPersistedRatio(ratio);
    patchFilePanelState({ splitRatio: persisted });
    applyFileSidebarVisuals();
    syncResizerAria(resizer, persisted);
  };

  resizer.addEventListener('pointerdown', (e) => {
    if (resizer.classList.contains('hidden')) return;
    e.preventDefault();
    dragging = true;
    dragRect = split.getBoundingClientRect();
    ratioAtDragStart = getFilePanelState().splitRatio;
    resizer.classList.add('dragging');
    resizer.setPointerCapture(e.pointerId);
    document.body.style.cursor = 'col-resize';
    syncResizerAria(resizer, isChatColumnDragCollapsed() ? 0 : ratioAtDragStart);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', stopDrag);
    window.addEventListener('pointercancel', stopDrag);
    window.addEventListener('blur', stopDrag);
  });

  resizer.addEventListener('lostpointercapture', stopDrag);
  syncResizerAria(resizer, getFilePanelState().splitRatio);
}

/** Restore a drag-collapsed chat column when the user selects a sidebar chat. */
export function restoreChatColumnOnChatSelect(): void {
  restoreChatColumnFromDrag();
}

/** Test helper — reset resizer bindings. */
export function resetWorkspaceSplitResizerForTests(): void {
  resizerBound = false;
}

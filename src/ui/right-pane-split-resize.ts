import {
  RIGHT_PANE_SPLIT_RATIO_MAX,
  RIGHT_PANE_SPLIT_RATIO_MIN,
  getFilePanelState,
  patchFilePanelState,
} from '../state/file-panel';
import { applyRightPaneSplitDom, isRightPaneSplitActive } from './right-pane-split';
import { createPointerFrame } from './pointer-frame';

let bound = false;

function clampRatio(ratio: number): number {
  return Math.min(RIGHT_PANE_SPLIT_RATIO_MAX, Math.max(RIGHT_PANE_SPLIT_RATIO_MIN, ratio));
}

/** Wire right-pane split drag handle once at boot. */
export function bindRightPaneSplitResizer(): void {
  if (bound) return;
  const resizer = document.getElementById('rightPaneSplitResizer');
  const wrapper = document.getElementById('rightPaneSplit');
  if (!resizer || !wrapper) return;
  bound = true;

  let dragging = false;
  let ratioAtStart = getFilePanelState().rightPaneSplit.ratio;
  let dragRect: DOMRect;

  const syncAria = (ratio: number): void => {
    resizer.setAttribute('aria-valuemin', String(Math.round(RIGHT_PANE_SPLIT_RATIO_MIN * 100)));
    resizer.setAttribute('aria-valuemax', String(Math.round(RIGHT_PANE_SPLIT_RATIO_MAX * 100)));
    resizer.setAttribute('aria-valuenow', String(Math.round(ratio * 100)));
  };

  const pointerFrame = createPointerFrame((clientX) => {
    if (!dragging || dragRect.width <= 0) return;
    const ratio = clampRatio((clientX - dragRect.left) / dragRect.width);
    wrapper.style.setProperty('--right-pane-split-ratio', String(ratio));
    syncAria(ratio);
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

    const raw = wrapper.style.getPropertyValue('--right-pane-split-ratio');
    const live = raw ? Number.parseFloat(raw) : ratioAtStart;
    const ratio = Number.isFinite(live) ? clampRatio(live) : ratioAtStart;
    patchFilePanelState({
      rightPaneSplit: { ...getFilePanelState().rightPaneSplit, ratio },
    });
    applyRightPaneSplitDom();
    void import('./preview-electron-visibility').then((m) => {
      m.scheduleElectronPreviewHostLayoutSync();
      m.scheduleSecondaryPreviewHostLayoutSync?.();
    });
  };

  resizer.addEventListener('pointerdown', (e: PointerEvent) => {
    if (!isRightPaneSplitActive()) return;
    if (e.button !== 0) return;
    dragging = true;
    dragRect = wrapper.getBoundingClientRect();
    ratioAtStart = getFilePanelState().rightPaneSplit.ratio;
    resizer.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    resizer.setPointerCapture(e.pointerId);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', stopDrag);
    window.addEventListener('pointercancel', stopDrag);
    window.addEventListener('blur', stopDrag);
    e.preventDefault();
  });

  resizer.addEventListener('lostpointercapture', stopDrag);
  syncAria(getFilePanelState().rightPaneSplit.ratio);
}

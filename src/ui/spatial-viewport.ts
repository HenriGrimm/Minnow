/**
 * Shared spatial navigation: drag to pan, wheel to zoom at the cursor, keyboard
 * zoom and pan when the canvas has focus, and a minimap that mirrors the view.
 */

export interface ViewState {
  x: number;
  y: number;
  k: number;
}

export interface MinimapShape {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Frame outline vs. card fill. */
  frame: boolean;
  active?: boolean;
  /** Resolved CSS color for data-driven maps; omitted by Code Map. */
  color?: string;
}

export interface ViewportApi {
  setContent(width: number, height: number, view?: ViewState): void;
  fit(options?: { animate?: boolean; maxScale?: number }): void;
  zoomBy(factor: number): void;
  panBy(x: number, y: number): void;
  reset(): void;
  /** Pan so a scene rectangle is in view (keeps the scale unless it does not fit). */
  reveal(rect: { x: number; y: number; w: number; h: number }, options?: { padding?: number; minScale?: number }): void;
  getState(): ViewState;
  /** True right after a drag, so the click that ends it can be ignored. */
  consumeDrag(): boolean;
  setMinimapShapes(shapes: MinimapShape[]): void;
  /** Area kept clear on the right (an open inspector), in viewport pixels. */
  setRightInset(px: number): void;
  onChange(cb: (state: ViewState) => void): void;
  destroy(): void;
}

const MIN_SCALE = 0.12;
const MAX_SCALE = 2.4;
const DRAG_THRESHOLD = 4;

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** Wire pan/zoom on `viewport`, transforming `scene`; draws into `minimap` when given. */
export function createViewport(
  viewport: HTMLElement,
  scene: HTMLElement,
  minimap: HTMLCanvasElement | null,
  options: { prefix?: string; noPanSelector?: string; minScale?: number; horizontal?: boolean;
    /** Center the rows in the current horizontal window rather than distant branches. */
    horizontalRange?: (left: number, right: number) => { top: number; bottom: number } | null;
  } = {},
): ViewportApi {
  const prefix = options.prefix ?? 'code-map';
  const minScale = options.minScale ?? MIN_SCALE;
  let state: ViewState = { x: 0, y: 0, k: 1 };
  let contentW = 1;
  let contentH = 1;
  let rightInset = 0;
  let shapes: MinimapShape[] = [];
  let dragged = false;
  let pointer: { id: number; startX: number; startY: number; x0: number; y0: number; moved: boolean } | null = null;
  const listeners: Array<(s: ViewState) => void> = [];
  let frame = 0;
  let animationTimer = 0;
  let dragTimer = 0;
  let miniPointer: number | null = null;

  const apply = () => {
    if (options.horizontal) {
      const { w, h } = usable();
      const range = () => options.horizontalRange?.(-state.x / state.k, (w - state.x) / state.k)
        ?? { top: 0, bottom: contentH };
      const extent = range();
      const height = Math.max(1, extent.bottom - extent.top);
      if (h > 1 && state.k > h / height) {
        const k = Math.max(minScale, h / height);
        state.x = w / 2 - (w / 2 - state.x) * k / state.k;
        state.k = k;
      }
      state.x = contentW * state.k <= w ? (w - contentW * state.k) / 2
        : clamp(state.x, w - contentW * state.k - 32, 32);
      const centered = range();
      state.y = h / 2 - (centered.top + centered.bottom) / 2 * state.k;
    }
    scene.style.transform = `translate(${state.x}px, ${state.y}px) scale(${state.k})`;
    viewport.style.setProperty(`--${prefix}-zoom`, String(state.k));
    for (const cb of listeners) cb(state);
    scheduleMinimap();
  };

  const set = (next: ViewState, animate = false) => {
    state = { x: next.x, y: next.y, k: clamp(next.k, minScale, MAX_SCALE) };
    window.clearTimeout(animationTimer);
    animate = animate && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    scene.classList.toggle('is-animating', animate);
    apply();
    if (animate) {
      animationTimer = window.setTimeout(() => scene.classList.remove('is-animating'), 260);
    }
  };

  const zoomAt = (factor: number, cx: number, cy: number) => {
    const k = clamp(state.k * factor, minScale, MAX_SCALE);
    const f = k / state.k;
    set({ k, x: cx - (cx - state.x) * f, y: cy - (cy - state.y) * f });
  };

  const usable = () => {
    const rect = viewport.getBoundingClientRect();
    return { w: Math.max(1, rect.width - rightInset), h: Math.max(1, rect.height), rect };
  };

  const onWheel = (ev: WheelEvent) => {
    ev.preventDefault();
    const { rect } = usable();
    // Trackpad two-finger scroll pans; pinch (ctrlKey) and mouse wheels zoom.
    const pixelScroll = ev.deltaMode === 0 && !ev.ctrlKey && (options.horizontal || Math.abs(ev.deltaX) > 0);
    if (pixelScroll) {
      set({ ...state, x: state.x - (options.horizontal ? ev.deltaX || ev.deltaY : ev.deltaX), y: state.y - ev.deltaY });
      return;
    }
    const delta = ev.deltaMode === 1 ? ev.deltaY * 16 : ev.deltaY;
    zoomAt(Math.exp(-delta * (ev.ctrlKey ? 0.01 : 0.0015)), ev.clientX - rect.left, ev.clientY - rect.top);
  };

  const onPointerDown = (ev: PointerEvent) => {
    if (ev.button !== 0) return;
    if ((ev.target as Element | null)?.closest(`input, textarea, select, ${options.noPanSelector ?? '.code-map-no-pan'}`)) return;
    window.clearTimeout(dragTimer);
    dragged = false;
    pointer = { id: ev.pointerId, startX: ev.clientX, startY: ev.clientY, x0: state.x, y0: state.y, moved: false };
  };

  const onPointerMove = (ev: PointerEvent) => {
    if (!pointer || ev.pointerId !== pointer.id) return;
    const dx = ev.clientX - pointer.startX;
    const dy = ev.clientY - pointer.startY;
    if (!pointer.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    if (!pointer.moved) {
      pointer.moved = true;
      viewport.setPointerCapture(pointer.id);
      viewport.classList.add('is-panning');
    }
    set({ ...state, x: pointer.x0 + dx, y: pointer.y0 + dy });
  };

  const endPointer = (ev: PointerEvent) => {
    if (!pointer || ev.pointerId !== pointer.id) return;
    const current = pointer;
    pointer = null;
    if (current.moved) {
      dragged = true;
      dragTimer = window.setTimeout(() => {
        dragged = false;
      }, 0);
    }
    viewport.classList.remove('is-panning');
    if (viewport.hasPointerCapture(current.id)) viewport.releasePointerCapture(current.id);
  };

  const onKeyDown = (ev: KeyboardEvent) => {
    if (ev.target !== viewport) return;
    const step = 64;
    const { w, h } = usable();
    if (ev.key === '+' || ev.key === '=') zoomAt(1.2, w / 2, h / 2);
    else if (ev.key === '-' || ev.key === '_') zoomAt(1 / 1.2, w / 2, h / 2);
    else if (ev.key === '0') api.fit({ animate: true });
    else if (ev.key === 'ArrowLeft') set({ ...state, x: state.x + step });
    else if (ev.key === 'ArrowRight') set({ ...state, x: state.x - step });
    else if (ev.key === 'ArrowUp' && !options.horizontal) set({ ...state, y: state.y + step });
    else if (ev.key === 'ArrowDown' && !options.horizontal) set({ ...state, y: state.y - step });
    else return;
    ev.preventDefault();
  };

  // ── Minimap ──────────────────────────────────────────────────────────────

  const scheduleMinimap = () => {
    if (!minimap || frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      drawMinimap();
    });
  };

  const minimapScale = () => {
    if (!minimap) return { s: 1, ox: 0, oy: 0 };
    const w = minimap.clientWidth || 168;
    const h = minimap.clientHeight || 104;
    const pad = 8;
    const s = Math.min((w - pad * 2) / contentW, (h - pad * 2) / contentH);
    return { s, ox: (w - contentW * s) / 2, oy: (h - contentH * s) / 2 };
  };

  const drawMinimap = () => {
    if (!minimap) return;
    const dpr = window.devicePixelRatio || 1;
    const w = minimap.clientWidth || 168;
    const h = minimap.clientHeight || 104;
    if (minimap.width !== Math.round(w * dpr)) minimap.width = Math.round(w * dpr);
    if (minimap.height !== Math.round(h * dpr)) minimap.height = Math.round(h * dpr);
    const ctx = minimap.getContext('2d');
    if (!ctx) return;
    const css = getComputedStyle(minimap);
    const forced = window.matchMedia('(forced-colors: active)').matches;
    const frameColor = forced ? 'CanvasText' : css.getPropertyValue(`--${prefix}-mini-frame`).trim() || 'CanvasText';
    const cardColor = forced ? 'CanvasText' : css.getPropertyValue(`--${prefix}-mini-card`).trim() || 'CanvasText';
    const activeColor = forced ? 'Highlight' : css.getPropertyValue(`--${prefix}-mini-active`).trim() || 'Highlight';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const { s, ox, oy } = minimapScale();
    for (const shape of shapes) {
      const x = ox + shape.x * s;
      const y = oy + shape.y * s;
      const sw = Math.max(1, shape.w * s);
      const sh = Math.max(1, shape.h * s);
      if (shape.frame) {
        ctx.fillStyle = frameColor;
        ctx.fillRect(x, y, sw, sh);
      } else {
        ctx.fillStyle = shape.active ? activeColor : !forced && shape.color ? shape.color : cardColor;
        ctx.fillRect(x, y, sw, sh);
      }
    }
    const { w: vw, h: vh } = usable();
    const vx = ox + (-state.x / state.k) * s;
    const vy = oy + (-state.y / state.k) * s;
    ctx.strokeStyle = activeColor;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(vx, vy, (vw / state.k) * s, (vh / state.k) * s);
  };

  let miniDrag = false;
  const miniMove = (ev: PointerEvent) => {
    if (!minimap) return;
    const rect = minimap.getBoundingClientRect();
    const { s, ox, oy } = minimapScale();
    const sx = (ev.clientX - rect.left - ox) / s;
    const sy = (ev.clientY - rect.top - oy) / s;
    const { w, h } = usable();
    set({ ...state, x: w / 2 - sx * state.k, y: h / 2 - sy * state.k });
  };
  const onMiniDown = (ev: PointerEvent) => {
    if (!minimap || ev.button !== 0) return;
    miniDrag = true;
    miniPointer = ev.pointerId;
    minimap.setPointerCapture(ev.pointerId);
    miniMove(ev);
  };
  const onMiniMove = (ev: PointerEvent) => {
    if (miniDrag && miniPointer === ev.pointerId) miniMove(ev);
  };
  const onMiniUp = (ev: PointerEvent) => {
    if (miniPointer !== ev.pointerId) return;
    miniDrag = false;
    miniPointer = null;
    if (minimap?.hasPointerCapture(ev.pointerId)) minimap.releasePointerCapture(ev.pointerId);
  };

  const resizeObserver = new ResizeObserver(() => {
    if (options.horizontal) apply();
    else scheduleMinimap();
  });
  resizeObserver.observe(viewport);

  viewport.addEventListener('wheel', onWheel, { passive: false });
  viewport.addEventListener('pointerdown', onPointerDown);
  viewport.addEventListener('pointermove', onPointerMove);
  viewport.addEventListener('pointerup', endPointer);
  viewport.addEventListener('pointercancel', endPointer);
  viewport.addEventListener('lostpointercapture', endPointer);
  viewport.addEventListener('keydown', onKeyDown);
  minimap?.addEventListener('pointerdown', onMiniDown);
  minimap?.addEventListener('pointermove', onMiniMove);
  minimap?.addEventListener('pointerup', onMiniUp);
  minimap?.addEventListener('pointercancel', onMiniUp);

  const api: ViewportApi = {
    setContent(width, height, view) {
      contentW = Math.max(1, width);
      contentH = Math.max(1, height);
      if (view) state = { ...view, k: clamp(view.k, minScale, MAX_SCALE) };
      scene.style.width = `${contentW}px`;
      scene.style.height = `${contentH}px`;
      if (options.horizontal || view) apply();
      else scheduleMinimap();
    },
    fit(options) {
      const { w, h } = usable();
      const k = clamp(Math.min(w / contentW, h / contentH, options?.maxScale ?? 1), minScale, MAX_SCALE);
      set({ k, x: (w - contentW * k) / 2, y: Math.max(0, (h - contentH * k) / 2) }, options?.animate);
    },
    zoomBy(factor) {
      const { w, h } = usable();
      zoomAt(factor, w / 2, h / 2);
    },
    panBy(x, y) { set({ ...state, x: state.x + x, y: state.y + y }); },
    reset() {
      set({ x: 24, y: 24, k: 1 });
    },
    reveal(rect, options) {
      const pad = options?.padding ?? 48;
      const { w, h } = usable();
      const fits = state.k >= (options?.minScale ?? minScale)
        && (rect.w + pad * 2) * state.k <= w && (rect.h + pad * 2) * state.k <= h;
      if (!fits) {
        const k = clamp(Math.min(w / (rect.w + pad * 2), h / (rect.h + pad * 2), 1), minScale, MAX_SCALE);
        set({ k, x: w / 2 - (rect.x + rect.w / 2) * k, y: h / 2 - (rect.y + rect.h / 2) * k }, true);
        return;
      }
      const k = state.k;
      const sx = rect.x * k;
      const sy = rect.y * k;
      let x = state.x;
      let y = state.y;
      if (sx + x < pad) x = pad - sx;
      if (sx + rect.w * k + x > w - pad) x = w - pad - sx - rect.w * k;
      if (sy + y < pad) y = pad - sy;
      if (sy + rect.h * k + y > h - pad) y = h - pad - sy - rect.h * k;
      set({ k, x, y }, true);
    },
    getState: () => ({ ...state }),
    consumeDrag: () => dragged,
    setMinimapShapes(next) {
      shapes = next;
      scheduleMinimap();
    },
    setRightInset(px) {
      rightInset = Math.max(0, px);
      scheduleMinimap();
    },
    onChange(cb) {
      listeners.push(cb);
    },
    destroy() {
      window.clearTimeout(animationTimer);
      window.clearTimeout(dragTimer);
      if (pointer && viewport.hasPointerCapture(pointer.id)) viewport.releasePointerCapture(pointer.id);
      if (miniPointer !== null && minimap?.hasPointerCapture(miniPointer)) minimap.releasePointerCapture(miniPointer);
      pointer = null;
      miniPointer = null;
      listeners.length = 0;
      viewport.classList.remove('is-panning');
      scene.classList.remove('is-animating');
      resizeObserver.disconnect();
      viewport.removeEventListener('wheel', onWheel);
      viewport.removeEventListener('pointerdown', onPointerDown);
      viewport.removeEventListener('pointermove', onPointerMove);
      viewport.removeEventListener('pointerup', endPointer);
      viewport.removeEventListener('pointercancel', endPointer);
      viewport.removeEventListener('lostpointercapture', endPointer);
      viewport.removeEventListener('keydown', onKeyDown);
      minimap?.removeEventListener('pointerdown', onMiniDown);
      minimap?.removeEventListener('pointermove', onMiniMove);
      minimap?.removeEventListener('pointerup', onMiniUp);
      minimap?.removeEventListener('pointercancel', onMiniUp);
      if (frame) cancelAnimationFrame(frame);
    },
  };
  return api;
}

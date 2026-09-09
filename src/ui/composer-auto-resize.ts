const COMPOSER_MIN_HEIGHT_PX = 44;
const COMPOSER_MAX_HEIGHT_VH = 40;

/** Test override: null uses CSS.supports, boolean forces the JS or CSS path. */
let fieldSizingSupportOverride: boolean | null = null;

/** Parse a computed px length; `none` / keywords / `min()` strings yield null. */
function parsePositivePx(value: string): number | null {
  if (!value || value === 'none' || value === 'auto') return null;
  const n = parseFloat(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Read computed style from the element's window. */
function readComposerComputedStyle(el: HTMLTextAreaElement): CSSStyleDeclaration | null {
  const view = el.ownerDocument?.defaultView ?? (typeof window !== 'undefined' ? window : null);
  if (!view || typeof view.getComputedStyle !== 'function') return null;
  return view.getComputedStyle(el);
}

/** Floor for the JS resize path. */
function composerMinHeightPx(el: HTMLTextAreaElement): number {
  const style = readComposerComputedStyle(el);
  const fromCss = style ? parsePositivePx(style.minHeight) : null;
  return fromCss != null ? Math.max(COMPOSER_MIN_HEIGHT_PX, fromCss) : COMPOSER_MIN_HEIGHT_PX;
}

/** Cap for the JS resize path. */
function composerMaxHeightPx(el: HTMLTextAreaElement): number {
  const inner =
    typeof window !== 'undefined' && Number.isFinite(window.innerHeight) ? window.innerHeight : 800;
  const vhCap = Math.floor(inner * (COMPOSER_MAX_HEIGHT_VH / 100));
  const style = readComposerComputedStyle(el);
  const fromCss = style ? parsePositivePx(style.maxHeight) : null;
  return fromCss != null ? Math.min(vhCap, fromCss) : vhCap;
}

/** True when CSS `field-sizing: content` can grow the composer without JS layout. */
export function composerFieldSizingSupported(): boolean {
  if (fieldSizingSupportOverride != null) return fieldSizingSupportOverride;
  return (
    typeof CSS !== 'undefined' &&
    typeof CSS.supports === 'function' &&
    CSS.supports('field-sizing', 'content')
  );
}

/** @internal Force field-sizing detection in unit tests (`null` restores CSS.supports). */
export function setComposerFieldSizingSupportedForTests(value: boolean | null): void {
  fieldSizingSupportOverride = value;
}

/** Drop leftover inline height so CSS field-sizing (or min-height) can take over. */
function clearInlineComposerHeight(el: HTMLTextAreaElement): void {
  if (el.style.height) el.style.height = '';
}

/** Keep slash skill chips aligned after a programmatic value or height change. */
function syncSkillHighlight(el: HTMLTextAreaElement): void {
  if (el.dataset.skillHighlightBound !== '1') return;
  void import('./composer-skill-highlight').then((mod) => {
    mod.syncComposerSkillHighlight(el);
  });
}

/** Grow a composer textarea to fit lines. */
export function autoResize(el: HTMLTextAreaElement): void {
  if (composerFieldSizingSupported()) {
    clearInlineComposerHeight(el);
    syncSkillHighlight(el);
    return;
  }

  const maxPx = composerMaxHeightPx(el);
  const minPx = composerMinHeightPx(el);
  const current = el.offsetHeight;

  if (el.scrollHeight > el.clientHeight + 1) {
    const next = Math.min(Math.max(el.scrollHeight, minPx), maxPx);
    if (Math.abs(next - current) > 0.5) {
      el.style.height = `${next}px`;
    }
    el.style.overflowY = el.scrollHeight > maxPx ? 'auto' : 'hidden';
    syncSkillHighlight(el);
    return;
  }

  if (current <= minPx + 1) {
    el.style.height = `${minPx}px`;
    el.style.overflowY = 'hidden';
    syncSkillHighlight(el);
    return;
  }

  el.style.overflowY = 'hidden';
  el.style.height = 'auto';
  const contentHeight = el.scrollHeight;
  if (contentHeight <= maxPx) {
    el.style.height = `${Math.max(contentHeight, minPx)}px`;
    el.style.overflowY = 'hidden';
    syncSkillHighlight(el);
    return;
  }
  el.style.height = `${maxPx}px`;
  el.style.overflowY = 'auto';
  syncSkillHighlight(el);
}

/** Wire JS auto-resize when CSS field-sizing is unavailable (idempotent). */
export function bindComposerAutoResize(el: HTMLTextAreaElement): () => void {
  autoResize(el);
  if (el.dataset.composerAutoResizeWired === '1') return () => {};
  el.dataset.composerAutoResizeWired = '1';
  if (composerFieldSizingSupported()) {
    return () => {
      delete el.dataset.composerAutoResizeWired;
    };
  }
  const onInput = (): void => {
    autoResize(el);
  };
  const onResize = (): void => {
    autoResize(el);
  };
  el.addEventListener('input', onInput);
  const view = el.ownerDocument.defaultView;
  view?.addEventListener('resize', onResize);
  return () => {
    el.removeEventListener('input', onInput);
    view?.removeEventListener('resize', onResize);
    delete el.dataset.composerAutoResizeWired;
  };
}

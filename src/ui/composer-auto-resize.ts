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

/**
 * `field-sizing: content` re-measures the box against its content on every
 * reflow, which some Chromium builds treat as a fresh layout and reset the
 * textarea's scroll offset to 0 for — so once content overflows the max-height
 * clamp, wheel/trackpad scrolling inside the box silently does nothing (the
 * scroll chains up to the page instead). Pin a concrete height + `field-sizing:
 * fixed` while clamped so the box behaves like an ordinary scrollable textarea;
 * release the pin once content shrinks back under the cap.
 */
function syncFieldSizingClamp(el: HTMLTextAreaElement, maxPx: number): void {
  const wasPinned = el.style.height !== '';
  if (wasPinned) {
    el.style.height = '';
    el.style.removeProperty('field-sizing');
  }
  if (el.scrollHeight > maxPx + 1) {
    el.style.height = `${maxPx}px`;
    el.style.setProperty('field-sizing', 'fixed');
  }
}

/** Keep slash skill chips aligned after a programmatic value or height change. */
function syncSkillHighlight(el: HTMLTextAreaElement): void {
  if (el.dataset.skillHighlightBound !== '1') return;
  void import('./composer-skill-highlight').then((mod) => {
    mod.syncComposerSkillHighlight(el);
  });
}

/**
 * Key overflow-y off actual overflow, not the height cap. A box sitting at the
 * max height with content that overflows the visible client area must stay
 * scrollable (wheel/trackpad + caret), while short content hides the (invisible)
 * scrollbar. Uses the same +1px tolerance as the grow check below (MIN-344).
 */
function applyComposerOverflowY(el: HTMLTextAreaElement): void {
  el.style.overflowY = el.scrollHeight > el.clientHeight + 1 ? 'auto' : 'hidden';
}

/** Grow a composer textarea to fit lines. */
export function autoResize(el: HTMLTextAreaElement): void {
  if (composerFieldSizingSupported()) {
    syncFieldSizingClamp(el, composerMaxHeightPx(el));
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
    applyComposerOverflowY(el);
    syncSkillHighlight(el);
    return;
  }

  if (current <= minPx + 1) {
    el.style.height = `${minPx}px`;
    applyComposerOverflowY(el);
    syncSkillHighlight(el);
    return;
  }

  el.style.overflowY = 'hidden';
  el.style.height = 'auto';
  const contentHeight = el.scrollHeight;
  if (contentHeight <= maxPx) {
    el.style.height = `${Math.max(contentHeight, minPx)}px`;
    applyComposerOverflowY(el);
    syncSkillHighlight(el);
    return;
  }
  el.style.height = `${maxPx}px`;
  applyComposerOverflowY(el);
  syncSkillHighlight(el);
}

/** Wire JS auto-resize when CSS field-sizing is unavailable (idempotent). */
export function bindComposerAutoResize(el: HTMLTextAreaElement): () => void {
  autoResize(el);
  if (el.dataset.composerAutoResizeWired === '1') return () => {};
  el.dataset.composerAutoResizeWired = '1';
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

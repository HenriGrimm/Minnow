export const PHONE_MQ = '(max-width: 640px), (max-width: 1024px) and (max-height: 540px)';
export const TABLET_MQ =
  '(min-width: 641px) and (max-width: 1024px) and (min-height: 541px) and (pointer: coarse)';
/** Touch-first input; true on tablets and touchscreen laptops as well as phones. */
export const COARSE_POINTER_MQ = '(pointer: coarse)';
export const NARROW_MQ = '(max-width: 767px)';

type Listener = (phone: boolean) => void;

const listeners = new Set<Listener>();
let phoneMq: MediaQueryList | null = null;
let tabletMq: MediaQueryList | null = null;
let coarseMq: MediaQueryList | null = null;
let narrowMq: MediaQueryList | null = null;
let installed = false;

function query(mq: string): MediaQueryList | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null;
  return window.matchMedia(mq);
}

function bindMqChange(mq: MediaQueryList | null, handler: () => void): void {
  if (!mq) return;
  if (typeof mq.addEventListener === 'function') {
    mq.addEventListener('change', handler);
    return;
  }
  if (typeof mq.addListener === 'function') {
    mq.addListener(handler);
  }
}

/** True when the viewport is phone-sized. Safe to call before init. */
export function isPhoneLayout(): boolean {
  return (phoneMq ?? query(PHONE_MQ))?.matches ?? false;
}

/** True on tablet-width touch viewports (excludes phones and mouse-driven browsers). */
export function isTabletLayout(): boolean {
  return (tabletMq ?? query(TABLET_MQ))?.matches ?? false;
}

/** True when the primary pointer is touch — hover affordances are unavailable. */
export function isCoarsePointer(): boolean {
  return (coarseMq ?? query(COARSE_POINTER_MQ))?.matches ?? false;
}

/** True when the workspace rail should dock to the bottom and sidebars use overlays. */
export function isNarrowLayout(): boolean {
  return (narrowMq ?? query(NARROW_MQ))?.matches ?? false;
}

/**
 * Scroll the horizontal tab strip that holds `item` so the item is fully visible.
 * Section rails become sideways-scrolling strips on phones; without this a deep
 * link to a later section (Models → Usage) opens with its tab off-screen. Only
 * the strip scrolls — `scrollIntoView` would also move the page and the shell.
 * A no-op for vertical rails, which never overflow sideways.
 */
export function revealInTabStrip(item: Element | null | undefined): void {
  const strip = item?.parentElement?.closest<HTMLElement>(
    '.models-nav, .brain-rail, .scc-rail',
  );
  if (!item || !strip || strip.scrollWidth <= strip.clientWidth) return;
  const stripRect = strip.getBoundingClientRect();
  const itemRect = item.getBoundingClientRect();
  const pad = 24;
  if (itemRect.left < stripRect.left + pad) {
    strip.scrollLeft -= stripRect.left + pad - itemRect.left;
  } else if (itemRect.right > stripRect.right - pad) {
    strip.scrollLeft += itemRect.right - (stripRect.right - pad);
  }
}

/** Subscribe to phone-layout changes. Returns an unsubscribe function. */
export function onPhoneLayoutChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function syncFlags(): void {
  const root = document.documentElement;
  root.classList.toggle('mn-phone', isPhoneLayout());
  root.classList.toggle('mn-tablet', isTabletLayout());
  root.classList.toggle('mn-touch', isCoarsePointer());
  root.classList.toggle('mn-narrow', isNarrowLayout());
}

/** Stamp layout flags on `<html>` and keep them current. */
export function initMobileLayout(): void {
  phoneMq = query(PHONE_MQ);
  tabletMq = query(TABLET_MQ);
  coarseMq = query(COARSE_POINTER_MQ);
  narrowMq = query(NARROW_MQ);
  syncFlags();

  if (installed) return;
  installed = true;

  const onChange = () => {
    const wasPhone = document.documentElement.classList.contains('mn-phone');
    syncFlags();
    const nowPhone = isPhoneLayout();
    if (wasPhone === nowPhone) return;
    for (const listener of listeners) listener(nowPhone);
  };

  bindMqChange(phoneMq, onChange);
  bindMqChange(tabletMq, onChange);
  bindMqChange(coarseMq, onChange);
  bindMqChange(narrowMq, onChange);

  if (typeof window === 'undefined') return;

  window.addEventListener('resize', onChange, { passive: true });
  window.addEventListener('orientationchange', onChange, { passive: true });
  window.visualViewport?.addEventListener('resize', onChange, { passive: true });
}

/** Test hook — reset listener installation between cases. */
export function resetMobileLayoutForTests(): void {
  installed = false;
  phoneMq = null;
  tabletMq = null;
  coarseMq = null;
  narrowMq = null;
  listeners.clear();
}

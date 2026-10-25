import { scheduleAnimationFrame } from '../lib/schedule-animation-frame';

/** Marks a shell overlay that must paint above the native preview guest. */
export const PREVIEW_OCCLUDER_CLASS = 'mn-occludes-preview';
/** Transparent click-catcher layers that hit-testing looks through. */
export const PREVIEW_OCCLUDER_HIT_EXCLUDE_CLASS = 'mn-occluder-hit-exclude';

export type PreviewOccluderKind = 'menu' | 'dialog' | 'panel' | 'notification';

const OCCLUDER_KINDS: ReadonlySet<string> = new Set(['menu', 'dialog', 'panel', 'notification']);

export interface PreviewOccluderInfo {
  element: HTMLElement;
  kind: PreviewOccluderKind;
  rect: DOMRectReadOnly;
}

export interface PreviewOcclusionTrackerOptions {
  doc: Document;
  /** Defaults to `getBoundingClientRect`; tests inject fixed rectangles (happy-dom has no layout). */
  getRect?: (element: Element) => DOMRectReadOnly;
  /** Defaults to the topmost non-excluded element at the point, piercing one shadow root. */
  hitTest?: (x: number, y: number) => Element | null;
}

export interface PreviewOcclusionTracker {
  getOverlaps(host: HTMLElement): PreviewOccluderInfo[];
  subscribe(listener: () => void): () => void;
  invalidate(): void;
  dispose(): void;
}

/** Tag an overlay root so the preview guest steps aside while it covers the pane. */
export function markPreviewOccluder(element: HTMLElement, kind: PreviewOccluderKind = 'panel'): void {
  element.classList.add(PREVIEW_OCCLUDER_CLASS);
  element.dataset.occluderKind = kind;
}

/** Untag an overlay that stays mounted while closed. */
export function unmarkPreviewOccluder(element: HTMLElement): void {
  element.classList.remove(PREVIEW_OCCLUDER_CLASS);
  delete element.dataset.occluderKind;
}

function readOccluderKind(element: HTMLElement): PreviewOccluderKind {
  const kind = element.dataset?.occluderKind;
  return kind && OCCLUDER_KINDS.has(kind) ? (kind as PreviewOccluderKind) : 'panel';
}

function isHitTestExcluded(element: Element): boolean {
  return element.classList.contains(PREVIEW_OCCLUDER_HIT_EXCLUDE_CLASS);
}

type HitTestRoot = Pick<Document, 'elementFromPoint' | 'elementsFromPoint'>;

function topmostIn(root: HitTestRoot, x: number, y: number): Element | null {
  if (typeof root.elementFromPoint !== 'function') return null;
  // Fast path avoids allocating the full hit list on every overlay change.
  const hit = root.elementFromPoint(x, y);
  if (hit && !isHitTestExcluded(hit)) return hit;
  if (typeof root.elementsFromPoint !== 'function') return null;
  return root.elementsFromPoint(x, y).find((element) => !isHitTestExcluded(element)) ?? null;
}

function defaultHitTest(doc: Document, x: number, y: number): Element | null {
  const hit = topmostIn(doc, x, y);
  // Point hit-testing does not pierce shadow DOM; repeat it inside the host's root.
  const shadow = hit?.shadowRoot as unknown as HitTestRoot | null | undefined;
  if (shadow && typeof shadow.elementFromPoint === 'function') return topmostIn(shadow, x, y) ?? hit;
  return hit;
}

function overlapCenter(a: DOMRectReadOnly, b: DOMRectReadOnly): { x: number; y: number } | null {
  const left = Math.max(a.left, b.left);
  const right = Math.min(a.left + a.width, b.left + b.width);
  const top = Math.max(a.top, b.top);
  const bottom = Math.min(a.top + a.height, b.top + b.height);
  if (right <= left || bottom <= top) return null;
  return { x: (left + right) / 2, y: (top + bottom) / 2 };
}

/**
 * Find marked overlays that are painted over a host element: their box must
 * intersect the host, and a hit-test at the overlap centre must land inside them.
 */
export function createPreviewOcclusionTracker(options: PreviewOcclusionTrackerOptions): PreviewOcclusionTracker {
  const { doc } = options;
  const view = doc.defaultView;
  const getRect = options.getRect ?? ((element: Element) => element.getBoundingClientRect());
  const hitTest = options.hitTest ?? ((x: number, y: number) => defaultHitTest(doc, x, y));
  // A live collection keeps the no-overlay check a length test while chat streams.
  const overlays: ArrayLike<Element> = typeof doc.getElementsByClassName === 'function'
    ? doc.getElementsByClassName(PREVIEW_OCCLUDER_CLASS)
    : [];
  const listeners = new Set<() => void>();
  const elementObservers = new Map<Element, MutationObserver>();
  let rects = new WeakMap<Element, DOMRectReadOnly>();
  let structuralObserver: MutationObserver | null = null;
  let connected = false;

  const notify = scheduleAnimationFrame(() => {
    for (const listener of [...listeners]) listener();
  });
  const ObserverCtor: typeof MutationObserver | undefined =
    (view as (Window & typeof globalThis) | null)?.MutationObserver ?? globalThis.MutationObserver;

  /** Observe new overlays and drop departed ones; true when the tracked set changed. */
  const trackElements = (): boolean => {
    let changed = false;
    for (const [element, observer] of elementObservers) {
      if (element.isConnected && element.classList.contains(PREVIEW_OCCLUDER_CLASS)) continue;
      observer.disconnect();
      elementObservers.delete(element);
      rects.delete(element);
      changed = true;
    }
    if (!ObserverCtor) return changed;
    for (const element of Array.from(overlays)) {
      if (elementObservers.has(element)) continue;
      const observer = new ObserverCtor(() => {
        rects.delete(element);
        notify();
      });
      observer.observe(element, { attributes: true, attributeFilter: ['style', 'class', 'hidden'], childList: true, subtree: true });
      elementObservers.set(element, observer);
      changed = true;
    }
    return changed;
  };

  const onResize = (): void => {
    rects = new WeakMap();
    notify();
  };

  const connect = (): void => {
    if (connected) return;
    connected = true;
    const root = doc.body ?? doc.documentElement;
    if (ObserverCtor && root) {
      // Body-wide childList changes are frequent; only overlay membership changes notify.
      structuralObserver = new ObserverCtor(() => {
        if (trackElements()) notify();
      });
      structuralObserver.observe(root, { childList: true, subtree: true });
    }
    trackElements();
    view?.addEventListener('resize', onResize);
  };

  const disconnect = (): void => {
    if (!connected) return;
    connected = false;
    structuralObserver?.disconnect();
    structuralObserver = null;
    for (const observer of elementObservers.values()) observer.disconnect();
    elementObservers.clear();
    rects = new WeakMap();
    view?.removeEventListener('resize', onResize);
  };

  const readRect = (element: Element): DOMRectReadOnly => {
    // Without observers nothing would invalidate a cached rect.
    if (!connected) return getRect(element);
    let rect = rects.get(element);
    if (!rect) {
      rect = getRect(element);
      rects.set(element, rect);
    }
    return rect;
  };

  return {
    getOverlaps(host) {
      if (overlays.length === 0) return [];
      const hostRect = getRect(host);
      if (hostRect.width <= 0 || hostRect.height <= 0) return [];
      const found: PreviewOccluderInfo[] = [];
      for (const element of Array.from(overlays) as HTMLElement[]) {
        // A backdrop that wraps the host (e.g. a modal hosting a preview) is not over it.
        if (element.contains(host)) continue;
        const rect = readRect(element);
        const center = overlapCenter(hostRect, rect);
        if (!center) continue;
        const hit = hitTest(center.x, center.y);
        if (hit && element.contains(hit)) found.push({ element, kind: readOccluderKind(element), rect });
      }
      return found;
    },
    subscribe(listener) {
      listeners.add(listener);
      connect();
      return () => {
        if (!listeners.delete(listener)) return;
        if (listeners.size === 0) disconnect();
      };
    },
    invalidate() {
      rects = new WeakMap();
    },
    dispose() {
      listeners.clear();
      disconnect();
    },
  };
}

// ── Shared document tracker ──────────────────────────────────────────────────

const sharedListeners = new Set<() => void>();
let sharedTracker: PreviewOcclusionTracker | null = null;
let sharedDocument: Document | null = null;
let sharedTestOptions: Omit<PreviewOcclusionTrackerOptions, 'doc'> | null = null;
let unsubscribeShared: (() => void) | null = null;

function fanOut(): void {
  for (const listener of [...sharedListeners]) listener();
}

function getSharedTracker(): PreviewOcclusionTracker | null {
  if (typeof document === 'undefined') return null;
  if (sharedTracker && sharedDocument === document) return sharedTracker;
  unsubscribeShared?.();
  unsubscribeShared = null;
  sharedTracker?.dispose();
  sharedDocument = document;
  sharedTracker = createPreviewOcclusionTracker({ doc: document, ...sharedTestOptions });
  if (sharedListeners.size > 0) unsubscribeShared = sharedTracker.subscribe(fanOut);
  return sharedTracker;
}

/** Notify when marked overlays appear, disappear, move or restyle. Observers run only while subscribed. */
export function subscribePreviewOcclusion(listener: () => void): () => void {
  sharedListeners.add(listener);
  const tracker = getSharedTracker();
  if (tracker && !unsubscribeShared) unsubscribeShared = tracker.subscribe(fanOut);
  return () => {
    if (!sharedListeners.delete(listener) || sharedListeners.size > 0) return;
    unsubscribeShared?.();
    unsubscribeShared = null;
  };
}

/** Marked overlays currently painted over `host` in the live document. */
export function getPreviewOccluders(host: HTMLElement): PreviewOccluderInfo[] {
  return getSharedTracker()?.getOverlaps(host) ?? [];
}

/** Test helper: rebuild the shared tracker, optionally with injected geometry. Existing listeners re-attach. */
export function resetPreviewOcclusionForTests(options?: Omit<PreviewOcclusionTrackerOptions, 'doc'>): void {
  sharedTestOptions = options ?? null;
  unsubscribeShared?.();
  unsubscribeShared = null;
  sharedTracker?.dispose();
  sharedTracker = null;
  sharedDocument = null;
  if (sharedListeners.size > 0) getSharedTracker();
}

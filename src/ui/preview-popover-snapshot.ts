/** Keep the browser's last frame visible while a DOM menu covers its native guest. */
let snapshot: HTMLImageElement | null = null;

const FRAME_INTERVAL_MS = 1000;
const BOUNDS_SETTLE_MS = 300;

function createSnapshotImage(): HTMLImageElement {
  const image = document.createElement('img');
  image.className = 'preview-popover-snapshot';
  image.alt = '';
  image.setAttribute('aria-hidden', 'true');
  return image;
}

export function clearPreviewPopoverSnapshot(): void {
  snapshot?.remove();
  snapshot = null;
}

/** Fallback when no cached frame exists yet: capture the painted page on demand. */
export async function preparePreviewPopoverSnapshot(): Promise<void> {
  if (snapshot?.isConnected) return;
  const api = window.minnow?.preview;
  const body = document.getElementById('previewBody');
  if (!api?.capturePage || !body) return;
  try {
    const base64 = await api.capturePage(undefined, undefined, true);
    if (!base64 || !body.isConnected) return;
    const image = createSnapshotImage();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    if (!body.isConnected) return;
    clearPreviewPopoverSnapshot();
    body.appendChild(image);
    snapshot = image;
  } catch {
    // Capture failure must not block menus or prevent the live guest returning.
  }
}

// ── Cached frame per host ──────────────────────────────────────────────────────────────

interface FrameCache {
  image: HTMLImageElement;
  loaded: boolean;
  stop: () => void;
}

export interface PreviewFrameCacheOptions {
  instanceId?: string;
  /** Captures run only while this is true; a hidden surface is never copied. */
  isGuestVisible: () => boolean;
}

const frameCaches = new Map<HTMLElement, FrameCache>();
const boundsChangedAt = new WeakMap<HTMLElement, number>();

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/** Record a host resize; captures pause briefly so a mid-resize surface is not copied. */
export function noteHostBoundsChanged(host: HTMLElement): void {
  boundsChangedAt.set(host, now());
}

/**
 * Keep a hidden, always-mounted JPEG of the guest's page in `host`, refreshed
 * about once a second while the guest is visible. Showing it is synchronous,
 * so an overlay never waits on a capture before the guest steps aside.
 */
export function startPreviewFrameCache(host: HTMLElement, options: PreviewFrameCacheOptions): () => void {
  const existing = frameCaches.get(host);
  if (existing) return existing.stop;
  const api = typeof window !== 'undefined' ? window.minnow?.preview : undefined;
  if (!api?.capturePlaceholder) return () => {};
  const capturePlaceholder = api.capturePlaceholder.bind(api);

  const image = createSnapshotImage();
  image.hidden = true;
  host.appendChild(image);
  let stopped = false;
  let timer: number | undefined;

  const schedule = (): void => {
    if (!stopped) timer = window.setTimeout(() => { void tick(); }, FRAME_INTERVAL_MS);
  };
  const tick = async (): Promise<void> => {
    timer = undefined;
    if (stopped) return;
    const settling = now() - (boundsChangedAt.get(host) ?? -Infinity) < BOUNDS_SETTLE_MS;
    if (!options.isGuestVisible() || document.visibilityState === 'hidden' || settling) {
      schedule();
      return;
    }
    try {
      const base64 = await capturePlaceholder(undefined, options.instanceId);
      if (base64 && !stopped) {
        const url = `data:image/jpeg;base64,${base64}`;
        // Decode off-screen so a visible placeholder swaps frames without a blank paint.
        const probe = createSnapshotImage();
        probe.src = url;
        await probe.decode();
        if (!stopped) {
          image.src = url;
          cache.loaded = true;
        }
      }
    } catch {
      // A failed frame keeps the previous one; the on-demand snapshot remains the fallback.
    }
    schedule();
  };

  const cache: FrameCache = {
    image,
    loaded: false,
    stop: () => {
      if (stopped) return;
      stopped = true;
      if (timer !== undefined) window.clearTimeout(timer);
      image.remove();
      if (frameCaches.get(host) === cache) frameCaches.delete(host);
    },
  };
  frameCaches.set(host, cache);
  void tick();
  return cache.stop;
}

/** Stop the frame cache for `host`, removing its image. */
export function stopPreviewFrameCache(host: HTMLElement): void {
  frameCaches.get(host)?.stop();
}

/** Reveal the cached frame; false when no frame has loaded yet. */
export function showCachedPreviewFrame(host: HTMLElement): boolean {
  const cache = frameCaches.get(host);
  if (!cache?.loaded) return false;
  cache.image.hidden = false;
  return true;
}

export function hideCachedPreviewFrame(host: HTMLElement): void {
  const cache = frameCaches.get(host);
  if (cache) cache.image.hidden = true;
}

// ── Paused message ──────────────────────────────────────────────────────────────────

const pausedMessages = new WeakMap<HTMLElement, HTMLElement>();

/** Toasts can stay open indefinitely, so a page frozen by one says why. */
export function setPreviewPausedMessage(host: HTMLElement, visible: boolean): void {
  let paused = pausedMessages.get(host);
  if (!visible) {
    if (paused) paused.hidden = true;
    return;
  }
  if (!paused || paused.parentElement !== host) {
    paused = document.createElement('div');
    paused.className = 'preview-paused';
    paused.setAttribute('role', 'status');
    const heading = document.createElement('p');
    heading.className = 'preview-paused__heading';
    heading.textContent = 'Paused while a notification is open';
    const detail = document.createElement('p');
    detail.className = 'preview-paused__detail';
    detail.textContent = 'Dismiss the notification to keep using the browser.';
    paused.append(heading, detail);
    host.appendChild(paused);
    pausedMessages.set(host, paused);
  }
  paused.hidden = false;
}

/** Remove every occlusion placeholder from `host` (cached frame stays mounted, hidden). */
export function clearPreviewOcclusionPlaceholders(host: HTMLElement | null): void {
  if (!host) return;
  hideCachedPreviewFrame(host);
  setPreviewPausedMessage(host, false);
  if (snapshot?.parentElement === host) clearPreviewPopoverSnapshot();
}

/** Test helper: stop every frame cache. */
export function resetPreviewFrameCachesForTests(): void {
  for (const cache of [...frameCaches.values()]) cache.stop();
}

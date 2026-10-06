/**
 * Pause decorative animation while nobody can see the window.
 *
 * The shell runs with `backgroundThrottling: false` so AFK boards, chat timers and SSE
 * delivery survive a sleeping display. The cost is that Chromium also stops throttling
 * the *compositor*: a caret blink or a spinner keeps producing a frame every vsync for a
 * window sitting in the tray. On a machine hosting a local model that is not free — the
 * GPU time-shares its 3D queue between the compositor and CUDA, so decode slows down.
 *
 * Setting `data-mn-render="idle"` on <html> parks every running animation and transition
 * (see `motion.css`). View-only pollers subscribe to the same visibility signal;
 * agent execution and network transports remain independent.
 */

const IDLE_ATTR = 'data-mn-render';

let applied = false;
const listeners = new Set<(idle: boolean) => void>();

/** Subscribe to visibility transitions without taking ownership of background execution. */
export function subscribeRenderIdle(listener: (idle: boolean) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function setIdle(idle: boolean): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (!root) return;
  const previous = root.getAttribute(IDLE_ATTR) === 'idle';
  if (idle) {
    root.setAttribute(IDLE_ATTR, 'idle');
  } else {
    root.removeAttribute(IDLE_ATTR);
  }
  if (previous !== idle) {
    for (const listener of listeners) listener(idle);
  }
}

/** True while the window is hidden, minimised, or otherwise not being presented. */
export function isRenderIdle(): boolean {
  if (typeof document === 'undefined') return false;
  return document.visibilityState === 'hidden' ||
    document.documentElement?.getAttribute(IDLE_ATTR) === 'idle';
}

/**
 * Start tracking window visibility. Safe to call once at boot; later calls are no-ops.
 *
 * Two sources, because neither alone is reliable here: the Page Visibility API does not
 * fire for every Electron tray/minimise path once background throttling is off, and the
 * main-process events do not fire for display sleep or occlusion.
 */
export function initRenderIdleTracking(): () => void {
  if (applied || typeof document === 'undefined') return () => {};
  applied = true;

  const cleanups: Array<() => void> = [];

  let nativeVisible = true;
  const fromDocument = (): void => {
    setIdle(!nativeVisible || document.visibilityState === 'hidden');
  };
  document.addEventListener('visibilitychange', fromDocument);
  cleanups.push(() => document.removeEventListener('visibilitychange', fromDocument));
  fromDocument();

  const windowApi = window.minnow?.window;
  if (windowApi?.onVisibilityChanged) {
    cleanups.push(
      windowApi.onVisibilityChanged((visible) => {
        nativeVisible = visible;
        fromDocument();
      }),
    );
  }

  return () => {
    for (const fn of cleanups) fn();
    cleanups.length = 0;
    applied = false;
    setIdle(false);
  };
}

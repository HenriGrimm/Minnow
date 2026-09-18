// ── Style wait ───────────────────────────────────────────────────────────────

/** Max wait before treating a missing stylesheet signal as failed and continuing. */
export const APP_READY_STYLE_TIMEOUT_MS = 4_000;

/**
 * Last-resort escape hatch when app initialization never produces coherent chrome.
 * Keep this separate from the CSS deadline: Code's lazy workspace modules can take
 * longer than the stylesheet probe on a cold start, and revealing at the CSS deadline
 * exposes their unstyled DOM while those chunks are still loading.
 */
export const APP_READY_CHROME_TIMEOUT_MS = 15_000;

/**
 * Grace period before the faded loader leaves the DOM — the `html.app-ready` opacity
 * transition in `index.html` is 0.22s. Removal matters: the loader is
 * `position: fixed; inset: 0`, so leaving it parked at `opacity: 0` keeps a
 * full-viewport composited layer alive for the whole session.
 */
export const APP_LOADER_REMOVE_DELAY_MS = 260;

/**
 * Sentinel custom property declared on `:root` by `styles/tokens.css`. The inline
 * critical CSS in `index.html` only *consumes* tokens (with fallbacks) and declares
 * none, so resolving this proves the bundled stylesheet is applied.
 */
export const APP_CSS_READY_PROPERTY = '--mn-app-css-ready';

/**
 * Own deadline for the CSS-applied probe. Bounded so a probe that can never
 * succeed costs a frame budget rather than the full outer timeout.
 */
export const APP_SHELL_STYLED_TIMEOUT_MS = 500;

/** True for app bundle stylesheets (not highlight.js, fonts CDN, etc.). */
function isBundledStylesheetLink(link: HTMLLinkElement): boolean {
  const href = link.getAttribute('href');
  if (!href || href.startsWith('data:')) return false;
  try {
    const url = new URL(href, location.href);
    if (url.origin !== location.origin) return false;
    if (url.pathname.includes('/node_modules/')) return false;
    if (import.meta.env?.PROD && !url.pathname.includes('/assets/')) return false;
    return true;
  } catch {
    return false;
  }
}

/** Stylesheet already applied (including cache hits before load listeners run). */
function isStylesheetLinkReady(link: HTMLLinkElement): boolean {
  if (link.sheet) return true;
  const href = link.href;
  if (!href) return true;
  try {
    return Array.from(document.styleSheets).some((sheet) => sheet.href === href);
  } catch {
    return false;
  }
}

/** Wait until after the next layout/paint (double rAF). */
export function waitForStablePaint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve());
    });
  });
}

/**
 * Wait for production bundle `<link rel="stylesheet">` tags.
 * Dev app CSS is injected as `<style data-vite-dev-id>` (see `whenViteInjectedStylesReady`).
 */
export function whenAppStylesReady(): Promise<void> {
  const links = Array.from(
    document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'),
  ).filter(isBundledStylesheetLink);

  if (links.length === 0) {
    return Promise.resolve();
  }

  return Promise.all(
    links.map(
      (link) =>
        new Promise<void>((resolve) => {
          if (isStylesheetLinkReady(link)) {
            resolve();
            return;
          }
          const finish = () => resolve();
          link.addEventListener('load', finish, { once: true });
          link.addEventListener('error', finish, { once: true });
          queueMicrotask(() => {
            if (isStylesheetLinkReady(link)) finish();
          });
        }),
    ),
  ).then(() => undefined);
}

/** True when Vite dev has injected module CSS into `<style data-vite-dev-id>`. */
function hasViteInjectedModuleStyles(): boolean {
  const styles = document.querySelectorAll<HTMLStyleElement>('style[data-vite-dev-id]');
  if (styles.length === 0) return false;
  return Array.from(styles).every((el) => (el.textContent?.length ?? 0) > 0);
}

/** Dev-only: wait for Vite HMR `<style data-vite-dev-id>` tags (not `<link>` bundles). */
export function whenViteInjectedStylesReady(): Promise<void> {
  if (import.meta.env?.DEV !== true) {
    return Promise.resolve();
  }
  if (hasViteInjectedModuleStyles()) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const observer = new MutationObserver(() => {
      if (hasViteInjectedModuleStyles()) {
        observer.disconnect();
        resolve();
      }
    });
    observer.observe(document.head, { childList: true, subtree: true });
  });
}

/** True once bundled app CSS has been applied (see `APP_CSS_READY_PROPERTY`). */
export function isAppShellStyled(): boolean {
  if (typeof getComputedStyle !== 'function') return true;
  const root = document.documentElement;
  if (!root) return false;
  return getComputedStyle(root).getPropertyValue(APP_CSS_READY_PROPERTY).trim() === '1';
}

/** Poll until app CSS is active, giving up after `timeoutMs` so boot never stalls on it. */
export function whenAppShellStyled(
  timeoutMs: number = APP_SHELL_STYLED_TIMEOUT_MS,
): Promise<void> {
  if (isAppShellStyled()) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      if (isAppShellStyled() || Date.now() >= deadline) {
        resolve();
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

import {
  logBootMetricsIfDebug,
  recordAppReadyMetrics,
} from './boot-metrics.ts';

// ── Gates ────────────────────────────────────────────────────────────────────

/** Dual-gate state: CSS ready + first coherent chrome before dismissing the loader. */
let stylesGateReady = false;
let chromeGateReady = false;
let revealFinished = false;
let stylesTimeoutId: number | undefined;
let chromeTimeoutId: number | undefined;
let stylesGatePromise: Promise<void> | null = null;
let chromeGateResolvers: Array<() => void> = [];

/** True after the loader has been dismissed (or safety timeout fired). */
export function isAppReady(): boolean {
  return revealFinished;
}

/** True once initApp (or workspace gate) signaled a coherent first composition. */
export function isChromeReady(): boolean {
  return chromeGateReady;
}

/** Resolve waiters when chrome becomes ready (tests / dual-gate). */
function notifyChromeReadyWaiters(): void {
  const waiters = chromeGateResolvers;
  chromeGateResolvers = [];
  for (const resolve of waiters) resolve();
}

/**
 * Signal that primary chrome is painted (workspace gate, or sidebar+composer+chat).
 * Combined with the CSS gate before `markAppReady` so the shell does not pop in piece by piece.
 */
export function markChromeReady(): void {
  if (chromeGateReady) return;
  chromeGateReady = true;
  if (chromeTimeoutId !== undefined) {
    window.clearTimeout(chromeTimeoutId);
    chromeTimeoutId = undefined;
  }
  notifyChromeReadyWaiters();
  tryRevealApp();
}

/** Wait until chrome-ready has been signaled (or already true). */
export function whenChromeReady(): Promise<void> {
  if (chromeGateReady) return Promise.resolve();
  return new Promise((resolve) => {
    chromeGateResolvers.push(resolve);
  });
}

// ── Reveal ───────────────────────────────────────────────────────────────────

/** Dismiss the inline loading shell (see index.html `#app-loader`). */
export function markAppReady(): void {
  if (revealFinished) return;
  revealFinished = true;
  if (stylesTimeoutId !== undefined) {
    window.clearTimeout(stylesTimeoutId);
    stylesTimeoutId = undefined;
  }
  if (chromeTimeoutId !== undefined) {
    window.clearTimeout(chromeTimeoutId);
    chromeTimeoutId = undefined;
  }
  const snapshot = recordAppReadyMetrics();
  logBootMetricsIfDebug(snapshot);
  const loader = document.getElementById('app-loader');
  if (loader) {
    loader.setAttribute('aria-busy', 'false');
    loader.setAttribute('aria-hidden', 'true');
    window.setTimeout(() => loader.remove(), APP_LOADER_REMOVE_DELAY_MS);
  }
  const status = document.getElementById('appLoaderStatus');
  if (status) status.textContent = '';
  document.documentElement.classList.add('app-ready');
}

/** Reveal when both gates pass (or the safety timeout already forced reveal). */
function tryRevealApp(): void {
  if (revealFinished) return;
  if (!stylesGateReady || !chromeGateReady) return;
  void waitForStablePaint().then(() => {
    if (revealFinished) return;
    if (!stylesGateReady || !chromeGateReady) return;
    markAppReady();
  });
}

/** Mark the CSS half of the dual gate and attempt reveal. */
function markStylesGateReady(): void {
  if (stylesGateReady) return;
  stylesGateReady = true;
  if (stylesTimeoutId !== undefined) {
    window.clearTimeout(stylesTimeoutId);
    stylesTimeoutId = undefined;
  }
  tryRevealApp();
}

/**
 * Wait for bundled CSS (and Vite-injected styles in DEV), then open the styles gate.
 * Idempotent — concurrent callers share one promise.
 */
export function signalStylesReadyForReveal(): Promise<void> {
  if (stylesGateReady) return Promise.resolve();
  if (!stylesGatePromise) {
    stylesGatePromise = Promise.all([whenAppStylesReady(), whenViteInjectedStylesReady()])
      .then(() => whenAppShellStyled())
      .then(() => {
        markStylesGateReady();
      })
      .catch(() => {
        markStylesGateReady();
      });
  }
  return stylesGatePromise;
}

/**
 * Dual-gate loader dismiss: CSS applied + chrome ready.
 * CSS failure and stalled initialization have separate deadlines so a normal slow
 * Code boot cannot reveal partially initialized, unstyled workspace chrome.
 */
export function scheduleMarkAppReady(options?: {
  styleTimeoutMs?: number;
  chromeTimeoutMs?: number;
}): void {
  if (revealFinished) return;

  if (!stylesGateReady && stylesTimeoutId === undefined) {
    stylesTimeoutId = window.setTimeout(() => {
      stylesTimeoutId = undefined;
      markStylesGateReady();
    }, options?.styleTimeoutMs ?? APP_READY_STYLE_TIMEOUT_MS);
  }

  if (!chromeGateReady && chromeTimeoutId === undefined) {
    chromeTimeoutId = window.setTimeout(() => {
      chromeTimeoutId = undefined;
      markStylesGateReady();
      chromeGateReady = true;
      notifyChromeReadyWaiters();
      markAppReady();
    }, options?.chromeTimeoutMs ?? APP_READY_CHROME_TIMEOUT_MS);
  }

  void signalStylesReadyForReveal();
}

/** Reset dual-gate state (tests only). */
export function resetAppReadyForTests(): void {
  stylesGateReady = false;
  chromeGateReady = false;
  revealFinished = false;
  stylesGatePromise = null;
  chromeGateResolvers = [];
  if (stylesTimeoutId !== undefined) {
    window.clearTimeout(stylesTimeoutId);
    stylesTimeoutId = undefined;
  }
  if (chromeTimeoutId !== undefined) {
    window.clearTimeout(chromeTimeoutId);
    chromeTimeoutId = undefined;
  }
  if (typeof document !== 'undefined') {
    document.documentElement.classList.remove('app-ready');
  }
}

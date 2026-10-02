import type { WebContents } from 'electron';

export interface PreviewNavigateAwaitResult {
  ok: boolean;
  url: string;
  title: string;
  errorCode?: number;
  errorDescription?: string;
}

export interface PreviewGuestInfo {
  url: string;
  title: string;
  loading: boolean;
}

const PREVIEW_CAPTURE_MAX_RETRIES = 3;
const PREVIEW_LOAD_POLL_MS = 50;
const PREVIEW_LOAD_MAX_WAIT_MS = 3_000;
export const PREVIEW_CAPTURE_PAGE_TIMEOUT_MS = 3_000;
export const PREVIEW_EXEC_JS_TIMEOUT_MS = 30_000;

// ── Wait helpers ─────────────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Rejects if the promise does not settle; does not cancel the work.
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export async function waitForPreviewGuestNotLoading(
  wc: WebContents,
  maxWaitMs = PREVIEW_LOAD_MAX_WAIT_MS,
): Promise<void> {
  if (wc.isDestroyed()) return;
  const start = Date.now();
  while (wc.isLoading()) {
    if (Date.now() - start >= maxWaitMs) break;
    await delay(PREVIEW_LOAD_POLL_MS);
  }
}

export async function waitForPreviewGuestDoubleRaf(wc: WebContents): Promise<void> {
  if (wc.isDestroyed()) return;
  try {
    await wc.executeJavaScript(
      'new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
      true,
    );
  } catch {
  }
}

function formatGuestThrownValue(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err && typeof (err as Error).message === 'string') {
    const message = (err as Error).message;
    const stack = 'stack' in err && typeof (err as Error).stack === 'string' ? (err as Error).stack : '';
    if (stack && stack.includes(message)) return stack;
    if (stack) return `${message}\n${stack}`;
    return message;
  }
  return String(err);
}

// ── Exec JS ──────────────────────────────────────────────────────────────────

export function wrapPreviewGuestUserCode(
  code: string,
  timeoutMs: number = PREVIEW_EXEC_JS_TIMEOUT_MS,
): string {
  const encoded = JSON.stringify(code);
  const boundMs = Math.max(1, Math.floor(timeoutMs));
  return `(async function(){
    var __timer;
    try {
      var __run = Promise.resolve().then(function(){ return (0, eval)(${encoded}); });
      var __timeout = new Promise(function(_, reject){
        __timer = setTimeout(function(){
          reject(new Error('preview script timed out after ${boundMs}ms'));
        }, ${boundMs});
      });
      return await Promise.race([__run, __timeout]);
    } catch (e) {
      var msg = e && e.message ? e.message : String(e);
      if (e && e.stack && typeof e.stack === 'string') {
        if (e.stack.indexOf(msg) !== -1) return { __execError: e.stack };
        return { __execError: msg + '\\n' + e.stack };
      }
      return { __execError: msg };
    } finally {
      if (__timer) clearTimeout(__timer);
    }
  })()`;
}

export interface PreviewExecJsOptions {
  timeoutMs?: number;
}

export async function previewExecJs(
  wc: WebContents,
  code: string,
  options?: PreviewExecJsOptions,
): Promise<unknown> {
  if (wc.isDestroyed()) {
    return { __execError: 'Preview guest is destroyed' };
  }
  const timeoutMs = options?.timeoutMs ?? PREVIEW_EXEC_JS_TIMEOUT_MS;
  try {
    return await withTimeout(
      wc.executeJavaScript(wrapPreviewGuestUserCode(code, timeoutMs), true),
      timeoutMs,
      `preview executeJavaScript timed out after ${timeoutMs}ms`,
    );
  } catch (err) {
    return { __execError: formatGuestThrownValue(err) };
  }
}

// ── Capture ──────────────────────────────────────────────────────────────────

export interface PreviewCapturePageOptions {
  captureTimeoutMs?: number;
  /** Capture the currently painted frame for transient shell overlays. */
  immediate?: boolean;
}

// Empty PNG after a hung GPU copy is not retried — retries would stack CopyFromSurface.
export async function previewCapturePageBase64(
  wc: WebContents,
  options?: PreviewCapturePageOptions,
): Promise<string> {
  if (wc.isDestroyed()) return '';

  const timeoutMs = options?.captureTimeoutMs ?? PREVIEW_CAPTURE_PAGE_TIMEOUT_MS;

  if (options?.immediate) {
    try {
      const image = await withTimeout(wc.capturePage(), timeoutMs, 'preview snapshot timed out');
      return image.toPNG().toString('base64');
    } catch {
      return '';
    }
  }

  await waitForPreviewGuestNotLoading(wc);
  try {
    await withTimeout(
      waitForPreviewGuestDoubleRaf(wc),
      timeoutMs,
      'preview capture rAF timed out',
    );
  } catch {
  }

  for (let attempt = 0; attempt < PREVIEW_CAPTURE_MAX_RETRIES; attempt++) {
    try {
      const image = await withTimeout(
        wc.capturePage(),
        timeoutMs,
        'preview capturePage timed out',
      );
      const png = image.toPNG();
      const b64 = png.length > 0 ? png.toString('base64') : '';
      if (b64.trim()) return b64;
    } catch {
      return '';
    }
    if (attempt < PREVIEW_CAPTURE_MAX_RETRIES - 1) {
      try {
        await withTimeout(
          waitForPreviewGuestDoubleRaf(wc),
          timeoutMs,
          'preview capture rAF timed out',
        );
      } catch {
        return '';
      }
      await delay(PREVIEW_LOAD_POLL_MS);
    }
  }
  return '';
}

export function previewGetGuestInfo(wc: WebContents): PreviewGuestInfo {
  return {
    url: wc.getURL(),
    title: wc.getTitle(),
    loading: wc.isLoading(),
  };
}

// ── Navigation ───────────────────────────────────────────────────────────────

const BLANK_GUEST_URL = 'about:blank';

export function isNavigationAbortedError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { errno?: number; code?: string; message?: string };
  if (e.errno === -3 || e.code === 'ERR_ABORTED') return true;
  return typeof e.message === 'string' && e.message.includes('ERR_ABORTED');
}

export async function previewClearGuest(wc: WebContents): Promise<void> {
  if (wc.isDestroyed()) return;
  const current = wc.getURL();
  if (!wc.isLoading() && (current === BLANK_GUEST_URL || current === '')) {
    return;
  }
  try {
    await wc.loadURL(BLANK_GUEST_URL);
  } catch (err) {
    if (!isNavigationAbortedError(err)) throw err;
  }
}

export async function previewNavigateAwait(
  wc: WebContents,
  url: string,
): Promise<PreviewNavigateAwaitResult> {
  const target = url.trim();
  if (!target) {
    return {
      ok: false,
      url: '',
      title: '',
      errorDescription: 'url is required',
    };
  }
  try {
    await wc.loadURL(target);
    return {
      ok: true,
      url: wc.getURL(),
      title: wc.getTitle(),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      url: target,
      title: wc.getTitle(),
      errorDescription: message,
    };
  }
}

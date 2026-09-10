import { loadBrowserMeta } from '../config/browser-meta';
import type { ToolExecutionResult } from '../types';
import {
  PREVIEW_DOM_SNAPSHOT_SCRIPT,
  renderPreviewSnapshotTree,
  type PreviewSnapshotNode,
} from './browser-preview-snapshot';
import {
  isElectronPreviewAvailable,
  isMinnowElectronShell,
  isPreviewAutomationReady,
} from './minnow-shell';

export { isElectronPreviewAvailable } from './minnow-shell';

const DESKTOP_SHELL_MESSAGE =
  'Error: Browser automation runs in the Minnow desktop app. Use the Minnow app window — not a separate browser tab.';

const STALE_SHELL_MESSAGE =
  'Error: Browser automation IPC is missing. Quit the app, run npm run electron:build, then restart the desktop shell.';

// ── Preview ──────────────────────────────────────────────────────────────────

function previewApi(): NonNullable<Window['minnow']>['preview'] {
  if (!isMinnowElectronShell()) {
    throw new Error(DESKTOP_SHELL_MESSAGE.replace(/^Error: /, ''));
  }
  if (!isPreviewAutomationReady()) {
    throw new Error(STALE_SHELL_MESSAGE.replace(/^Error: /, ''));
  }
  return window.minnow!.preview;
}

async function assertBrowserAutomationEnabled(): Promise<string | null> {
  const meta = await loadBrowserMeta();
  if (!meta.enabled) {
    return 'Error: browser automation is disabled in settings';
  }
  return null;
}

async function ensureBrowserPreviewTab(instance?: string, requestedTabId?: string): Promise<string> {
  const { getActivePreviewTabId, ensureDefaultPreviewTab, getPreviewTab } = await import('../ui/preview-tab-store');
  const requested = requestedTabId?.trim() ?? '';
  if (requested && !getPreviewTab(requested)) {
    throw new Error(`unknown preview tab "${requested}"`);
  }
  const tabId = requested || getActivePreviewTabId() || ensureDefaultPreviewTab().id;
  const api = previewApi();
  if (api.tabs?.create) {
    const listed = await api.tabs.list(instance);
    if (!listed.some((t) => t.id === tabId)) {
      await api.tabs.create(tabId, instance);
    }
  }
  if (api.tabs?.activate) {
    await api.tabs.activate(tabId, instance);
  }
  return tabId;
}

/** Consume a one-time allowlist grant after a successful navigation. */
async function consumeEphemeralNavigationGrant(url: string): Promise<void> {
  try {
    await fetch('/api/browser/allowlist/consume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
  } catch {}
}

function formatEvalResult(val: unknown): string {
  if (val === undefined) return '(undefined)';
  if (typeof val === 'object' && val !== null) {
    try {
      return JSON.stringify(val, null, 2);
    } catch {
      return String(val);
    }
  }
  return String(val);
}

export const BROWSER_EVAL_TIMEOUT_MS = 30_000;

const PREVIEW_SCRIPT_TIMEOUT_HINT =
  'The page JavaScript did not finish (infinite loop or a Promise that never settles). ' +
  'Prefer browser_snapshot for DOM inspection; avoid waiting forever inside browser_eval.';

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
}

function previewScriptTimeoutMessage(timeoutMs: number): string {
  return `preview script timed out after ${timeoutMs}ms. ${PREVIEW_SCRIPT_TIMEOUT_HINT}`;
}

// ── Exec ─────────────────────────────────────────────────────────────────────

export function racePreviewExecJs<T>(
  promise: Promise<T>,
  options?: { timeoutMs?: number; signal?: AbortSignal },
): Promise<T> {
  const timeoutMs = options?.timeoutMs ?? BROWSER_EVAL_TIMEOUT_MS;
  const signal = options?.signal;
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('The operation was aborted.', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      reject(new Error(previewScriptTimeoutMessage(timeoutMs)));
    }, timeoutMs);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('The operation was aborted.', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

function previewExecErrorMessage(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object' || !('__execError' in raw)) return null;
  return String((raw as { __execError: unknown }).__execError ?? 'Script failed');
}

async function execPreviewGuestJs(
  code: string,
  tabId: string,
  instance: string | undefined,
  options?: { timeoutMs?: number; signal?: AbortSignal },
): Promise<unknown> {
  if (options?.signal?.aborted) {
    throw new DOMException('The operation was aborted.', 'AbortError');
  }
  try {
    return await racePreviewExecJs(previewApi().execJs(code, tabId, instance), options);
  } catch (err) {
    if (isAbortError(err)) throw err;
    const message = err instanceof Error ? err.message : String(err);
    return { __execError: message };
  }
}

async function uploadScreenshotBase64(dataBase64: string): Promise<{ id: string; sizeBytes: number }> {
  const res = await fetch('/api/browser/screenshot', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dataBase64 }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    const raw = body.error ?? `screenshot upload failed (HTTP ${res.status})`;
    throw new Error(remapScreenshotUploadError(raw));
  }
  return (await res.json()) as { id: string; sizeBytes: number };
}

function remapScreenshotUploadError(message: string): string {
  if (/dataBase64 is required/i.test(message)) {
    return (
      'Preview browser not available — use the Minnow desktop shell, open a preview tab, ' +
      'and navigate with browser_navigate before browser_screenshot.'
    );
  }
  return message;
}

const EMPTY_SCREENSHOT_MESSAGE =
  'Error: Screenshot capture returned no image. Navigate with browser_navigate first, or ensure the preview guest is loaded in the Minnow desktop shell.';

const BLANK_PAGE_SCREENSHOT_MESSAGE =
  'Error: Nothing to screenshot — preview page is empty (about:blank). Use browser_navigate to open a URL first.';

// ── Tabs ─────────────────────────────────────────────────────────────────────

export async function browserPreviewList(instance?: string): Promise<string> {
  if (!isElectronPreviewAvailable()) return DESKTOP_SHELL_MESSAGE;
  const disabled = await assertBrowserAutomationEnabled();
  if (disabled) return disabled;

  const api = previewApi();
  if (api.tabs?.list) {
    const tabs = await api.tabs.list(instance);
    if (tabs.length === 0) return '(no preview tabs)';
    return tabs
      .map((tab) => {
        const prefix = tab.active ? '[active] ' : '';
        const title = tab.title || '(no title)';
        const url = tab.url || '(no url)';
        return `${prefix}${title}\n  ${url}\n  id: ${tab.id}`;
      })
      .join('\n\n');
  }

  const tabId = await ensureBrowserPreviewTab(instance);
  const info = await api.getInfo(tabId, instance);
  const title = info.title || '(no title)';
  return `[active] ${title}\n  ${info.url || '(no url)'}`;
}

export async function browserPreviewNewTab(url?: string): Promise<string> {
  if (!isElectronPreviewAvailable()) return DESKTOP_SHELL_MESSAGE;
  const disabled = await assertBrowserAutomationEnabled();
  if (disabled) return disabled;

  const { openPreviewTabWithCapacity } = await import('../ui/preview-tab-store');
  const { activatePreviewTabGuest, closePreviewTabUi, loadPreviewSource } = await import(
    '../ui/preview-panel'
  );
  const { showPreviewSplit } = await import('../ui/file-layout');

  const trimmed = url?.trim() ?? '';
  const source =
    trimmed && trimmed.startsWith('http')
      ? ({ kind: 'url' as const, url: trimmed })
      : trimmed
        ? ({ kind: 'workspace' as const, path: trimmed })
        : null;

  let opened = openPreviewTabWithCapacity(source);
  let evictedId = opened.evictedId;
  if (!opened.tab && evictedId) {
    await closePreviewTabUi(evictedId);
    opened = openPreviewTabWithCapacity(source, { evict: false });
  }
  if (!opened.tab) return 'Error: preview tab limit reached';
  const tab = opened.tab;

  showPreviewSplit();
  const api = previewApi();
  if (api.tabs?.create) {
    await api.tabs.create(tab.id);
    await api.tabs.activate(tab.id);
  }
  await activatePreviewTabGuest(tab.id, { forceLoad: Boolean(source) });
  if (source?.kind === 'url') {
    await loadPreviewSource(source);
  }

  const evictedNote = evictedId
    ? `\nClosed oldest background tab ${evictedId} (tab limit).`
    : '';
  return `Opened preview tab ${tab.id}${trimmed ? `\n${trimmed}` : ''}${evictedNote}`;
}

export async function browserPreviewSwitchTab(tabId: string): Promise<string> {
  if (!isElectronPreviewAvailable()) return DESKTOP_SHELL_MESSAGE;
  const disabled = await assertBrowserAutomationEnabled();
  if (disabled) return disabled;
  if (!tabId.trim()) return 'Error: tab_id is required';

  const { getPreviewTab, activatePreviewTab } = await import('../ui/preview-tab-store');
  const { activatePreviewTabGuest } = await import('../ui/preview-panel');
  if (!getPreviewTab(tabId.trim())) {
    return `Error: unknown preview tab "${tabId.trim()}"`;
  }

  const api = previewApi();
  if (api.tabs?.activate) {
    await api.tabs.activate(tabId.trim());
  }
  activatePreviewTab(tabId.trim());
  await activatePreviewTabGuest(tabId.trim());

  const info = await api.getInfo(tabId.trim());
  return `Active tab: ${tabId.trim()}\nTitle: ${info.title || '(no title)'}\n${info.url || ''}`;
}

export async function browserPreviewCloseTab(tabId: string): Promise<string> {
  if (!isElectronPreviewAvailable()) return DESKTOP_SHELL_MESSAGE;
  const disabled = await assertBrowserAutomationEnabled();
  if (disabled) return disabled;
  if (!tabId.trim()) return 'Error: tab_id is required';

  const { closePreviewTabUi } = await import('../ui/preview-panel');
  await closePreviewTabUi(tabId.trim());
  return `Closed preview tab ${tabId.trim()}`;
}

export async function browserPreviewNavigate(
  url: string,
  instance?: string,
  requestedTabId?: string,
): Promise<string> {
  if (!isElectronPreviewAvailable()) return DESKTOP_SHELL_MESSAGE;
  const disabled = await assertBrowserAutomationEnabled();
  if (disabled) return disabled;

  const meta = await loadBrowserMeta();
  if (!meta.allowNavigate) {
    return 'Error: navigation is disabled in settings';
  }

  const tabId = await ensureBrowserPreviewTab(instance, requestedTabId);
  const { revealPreviewPanelForAgentNavigation } = await import('../ui/preview-panel');
  await revealPreviewPanelForAgentNavigation(url, tabId);
  const api = previewApi();
  const result = await api.navigateAndWait(url, tabId, instance);
  if (!result.ok) {
    const detail = result.errorDescription ?? 'navigation failed';
    return `Error: ${detail}`;
  }

  await consumeEphemeralNavigationGrant(url);
  const { scheduleElectronPreviewHostVisibilitySync } = await import('../ui/preview-electron-visibility');
  scheduleElectronPreviewHostVisibilitySync();
  const title = result.title || '(no title)';
  return `Navigated to: ${result.url}\nTitle: ${title}`;
}

const EMPTY_SNAPSHOT_HINT =
  'Snapshot found no interactive elements. Try browser_eval or browser_screenshot.';

export async function browserPreviewSnapshot(
  instance?: string,
  signal?: AbortSignal,
  requestedTabId?: string,
): Promise<string> {
  if (!isElectronPreviewAvailable()) return DESKTOP_SHELL_MESSAGE;
  const disabled = await assertBrowserAutomationEnabled();
  if (disabled) return disabled;

  const tabId = await ensureBrowserPreviewTab(instance, requestedTabId);
  const raw = await execPreviewGuestJs(PREVIEW_DOM_SNAPSHOT_SCRIPT, tabId, instance, { signal });
  const execError = previewExecErrorMessage(raw);
  if (execError) return `Error: ${execError}`;
  const payload = raw as {
    text?: string;
    nodes?: PreviewSnapshotNode[];
  };

  if (payload?.nodes?.length) {
    const rendered = renderPreviewSnapshotTree(payload.nodes);
    if (rendered) return rendered;
  }

  if (payload?.text && payload.text !== '(empty page)') {
    return payload.text;
  }

  return EMPTY_SNAPSHOT_HINT;
}

// ── Actions ──────────────────────────────────────────────────────────────────

export async function browserPreviewClick(
  uid: number,
  instance?: string,
  signal?: AbortSignal,
  requestedTabId?: string,
): Promise<string> {
  if (!isElectronPreviewAvailable()) return DESKTOP_SHELL_MESSAGE;
  const disabled = await assertBrowserAutomationEnabled();
  if (disabled) return disabled;

  const script = `(() => {
    const el = document.querySelector('[data-mn-uid="${uid}"]');
    if (!el) return { missing: true };
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
    const role = el.getAttribute('role') || el.tagName.toLowerCase();
    const name =
      (el.getAttribute('aria-label') || (el.innerText || el.textContent || '').trim()).slice(0, 200);
    if (typeof el.click === 'function') el.click();
    return { missing: false, role, name };
  })()`;

  const tabId = await ensureBrowserPreviewTab(instance, requestedTabId);
  const raw = await execPreviewGuestJs(script, tabId, instance, { signal });
  const execError = previewExecErrorMessage(raw);
  if (execError) return `Error: ${execError}`;
  const result = raw as { missing?: boolean; role?: string; name?: string };
  if (result?.missing) {
    return 'No snapshot cached. Call browser_snapshot first.';
  }
  return `Clicked [${uid}] ${result.role ?? 'element'} "${result.name ?? ''}"`;
}

export async function browserPreviewFill(
  uid: number,
  value: string,
  instance?: string,
  signal?: AbortSignal,
  requestedTabId?: string,
): Promise<string> {
  if (!isElectronPreviewAvailable()) return DESKTOP_SHELL_MESSAGE;
  const disabled = await assertBrowserAutomationEnabled();
  if (disabled) return disabled;

  const escaped = JSON.stringify(value);
  const script = `(() => {
    const el = document.querySelector('[data-mn-uid="${uid}"]');
    if (!el) return { missing: true };
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
    el.focus();
    if ('value' in el) {
      el.value = ${escaped};
    } else {
      el.textContent = ${escaped};
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { missing: false };
  })()`;

  const tabId = await ensureBrowserPreviewTab(instance, requestedTabId);
  const raw = await execPreviewGuestJs(script, tabId, instance, { signal });
  const execError = previewExecErrorMessage(raw);
  if (execError) return `Error: ${execError}`;
  const result = raw as { missing?: boolean };
  if (result?.missing) {
    return 'No snapshot cached. Call browser_snapshot first.';
  }
  return `Filled [${uid}] with "${value}"`;
}

export async function browserPreviewEval(
  expression: string,
  instance?: string,
  signal?: AbortSignal,
  timeoutMs: number = BROWSER_EVAL_TIMEOUT_MS,
  requestedTabId?: string,
): Promise<string> {
  if (!isElectronPreviewAvailable()) return DESKTOP_SHELL_MESSAGE;
  const disabled = await assertBrowserAutomationEnabled();
  if (disabled) return disabled;

  const tabId = await ensureBrowserPreviewTab(instance, requestedTabId);
  const info = await previewApi().getInfo(tabId, instance);
  if (info.loading) {
    return 'Error: preview guest is still loading — wait for navigation to finish';
  }

  const val = await execPreviewGuestJs(expression, tabId, instance, { signal, timeoutMs });
  const execError = previewExecErrorMessage(val);
  if (execError) {
    if (/timed out/i.test(execError)) {
      return `Error: ${previewScriptTimeoutMessage(timeoutMs)}`;
    }
    return `Error: ${execError}`;
  }
  return formatEvalResult(val);
}

export async function browserPreviewScreenshot(
  instance?: string,
  requestedTabId?: string,
): Promise<ToolExecutionResult> {
  if (!isElectronPreviewAvailable()) {
    return { content: DESKTOP_SHELL_MESSAGE };
  }
  const disabled = await assertBrowserAutomationEnabled();
  if (disabled) {
    return { content: disabled };
  }

  try {
    const tabId = await ensureBrowserPreviewTab(instance, requestedTabId);
    const api = previewApi();
    const { prepareElectronPreviewForCapture, pollPreviewGuestUntilIdle } = await import(
      '../ui/preview-capture-ready'
    );
    await prepareElectronPreviewForCapture();
    await pollPreviewGuestUntilIdle(() => api.getInfo(tabId, instance));

    const info = await api.getInfo(tabId, instance);
    const pageUrl = (info.url ?? '').trim();
    if (!pageUrl || pageUrl === 'about:blank') {
      return { content: BLANK_PAGE_SCREENSHOT_MESSAGE };
    }

    const dataBase64 = await api.capturePage(tabId, instance);
    if (!dataBase64?.trim()) {
      return { content: EMPTY_SCREENSHOT_MESSAGE };
    }

    const { id, sizeBytes } = await uploadScreenshotBase64(dataBase64);
    const url = `/api/browser/screenshot/${id}`;
    const kb = Math.round(sizeBytes / 1024);
    const text = `Screenshot saved: ${id}.png\nURL: ${url}\n(${kb} KB)`;
    return {
      content: text,
      attachments: [
        {
          type: 'image',
          url,
          mime: 'image/png',
          alt: 'Browser screenshot',
          dataUrl: `data:image/png;base64,${dataBase64}`,
        },
      ],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: `Error: ${message}` };
  }
}

/** Dispatch a built-in preview browser tool by function name. */
export async function executeBrowserPreviewTool(
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<ToolExecutionResult> {
  const explicitTabId =
    typeof (args.tab_id ?? args.tabId) === 'string'
      ? String(args.tab_id ?? args.tabId).trim()
      : '';
  const instance =
    typeof args.instance === 'string' && args.instance.trim()
      ? args.instance.trim()
      : typeof window?.addEventListener === 'function'
        ? (await import('../ui/right-pane-split')).getFocusedPreviewInstanceId()
        : undefined;

  try {
    switch (name) {
      case 'browser_list':
      case 'browser_list_tabs':
        return { content: await browserPreviewList(instance) };
      case 'browser_navigate': {
        const url = args.url;
        if (typeof url !== 'string' || !url.trim()) {
          return { content: 'Error: url is required' };
        }
        return { content: await browserPreviewNavigate(url.trim(), instance, explicitTabId) };
      }
      case 'browser_snapshot':
        return { content: await browserPreviewSnapshot(instance, signal, explicitTabId) };
      case 'browser_click': {
        const uid = Number(args.uid);
        if (!Number.isFinite(uid)) {
          return { content: 'Error: uid is required' };
        }
        return { content: await browserPreviewClick(uid, instance, signal, explicitTabId) };
      }
      case 'browser_fill': {
        const uid = Number(args.uid);
        const value = args.value != null ? String(args.value) : '';
        if (!Number.isFinite(uid)) {
          return { content: 'Error: uid is required' };
        }
        return { content: await browserPreviewFill(uid, value, instance, signal, explicitTabId) };
      }
      case 'browser_eval': {
        const expression = args.expression;
        if (typeof expression !== 'string' || !expression.trim()) {
          return { content: 'Error: expression is required' };
        }
        return {
          content: await browserPreviewEval(
            expression,
            instance,
            signal,
            BROWSER_EVAL_TIMEOUT_MS,
            explicitTabId,
          ),
        };
      }
      case 'browser_screenshot':
        return browserPreviewScreenshot(instance, explicitTabId);
      case 'browser_new_tab': {
        const url = typeof args.url === 'string' ? args.url : undefined;
        return { content: await browserPreviewNewTab(url) };
      }
      case 'browser_switch_tab': {
        const tabId = args.tab_id ?? args.tabId;
        if (typeof tabId !== 'string' || !tabId.trim()) {
          return { content: 'Error: tab_id is required' };
        }
        return { content: await browserPreviewSwitchTab(tabId.trim()) };
      }
      case 'browser_close_tab': {
        const tabId = args.tab_id ?? args.tabId;
        if (typeof tabId !== 'string' || !tabId.trim()) {
          return { content: 'Error: tab_id is required' };
        }
        return { content: await browserPreviewCloseTab(tabId.trim()) };
      }
      default:
        return { content: `Error: unknown preview browser tool "${name}"` };
    }
  } catch (err) {
    if (isAbortError(err)) throw err;
    const message = err instanceof Error ? err.message : String(err);
    return { content: `Error: ${message}` };
  }
}

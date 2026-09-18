import type { PreviewSource } from '../state/file-panel';
import { getPreviewTab, updatePreviewTabSource } from './preview-tab-store';
import { resolvePreviewLoadUrl } from './preview-load-url';
import { getFileTreeListingWorkspaceRoot } from './file-tree-listing-root';
import {
  bindPreviewInstanceToElement,
  setPreviewInstanceVisible,
  unbindPreviewInstance,
} from './preview-instance-host';
import { getSlotContent, WORKSPACE_PREVIEW_SECONDARY_INSTANCE } from './right-pane-split';
import { HTTP_URL_RE, parsePreviewAddress } from './preview-url';
import { attachBrowserUrlSuggest } from './browser-url-suggest';

const PREVIEW_FILE_API = '/api/preview/file/';

let secondaryBound = false;
let secondaryFrame: HTMLIFrameElement | null = null;
let activeSecondaryTabId: string | null = null;
/** URL the secondary guest currently holds — guards redundant reloads on relayout. */
let loadedSecondaryUrl: string | null = null;
let secondaryControlsBound = false;
let unsubscribeSecondaryNavigation: (() => void) | null = null;

function usesElectron(): boolean {
  return Boolean(window.minnow?.preview);
}

function getBody(): HTMLElement | null {
  return document.getElementById('previewBodySecondary');
}

function getSecondaryUrlInput(): HTMLInputElement | null {
  return document.getElementById('previewUrlInputSecondary') as HTMLInputElement | null;
}

function getSecondaryBackButton(): HTMLButtonElement | null {
  return document.getElementById('btnPreviewBackSecondary') as HTMLButtonElement | null;
}

function getSecondaryForwardButton(): HTMLButtonElement | null {
  return document.getElementById('btnPreviewForwardSecondary') as HTMLButtonElement | null;
}

function sourceToAddressBar(source: PreviewSource): string {
  if (source.kind === 'url') return source.url;
  return source.path;
}

export function getSecondaryPreviewTabId(): string | null {
  if (activeSecondaryTabId) return activeSecondaryTabId;
  const sec = getSlotContent('secondary');
  if (sec.kind === 'preview' && sec.tabId) return sec.tabId;
  return null;
}

/** Sync secondary address bar from a preview source (tab model or navigation). */
export function syncSecondaryPreviewUrlInput(source: PreviewSource | null): void {
  const input = getSecondaryUrlInput();
  if (!input) return;
  if (!source) {
    input.value = '';
    return;
  }
  input.value = sourceToAddressBar(source);
}

function syncSecondaryUrlInputFromNavigation(url: string): void {
  const input = getSecondaryUrlInput();
  if (!input || !url || url === 'about:blank') return;

  const tabId = getSecondaryPreviewTabId();
  const tabSource = tabId ? getPreviewTab(tabId)?.source : null;
  if (tabSource?.kind === 'workspace') {
    try {
      const parsed = new URL(url);
      const prefix = `${window.location.origin}${PREVIEW_FILE_API}`;
      if (parsed.origin === window.location.origin && parsed.pathname.startsWith(PREVIEW_FILE_API)) {
        const encoded = parsed.pathname.slice(PREVIEW_FILE_API.length);
        const path = decodeURIComponent(encoded).replace(/^\/+/, '');
        input.value = path;
        return;
      }
    } catch {
    }
  }

  input.value = url;
}

function commitSecondaryTabSourceFromNavigation(url: string, tabId: string): void {
  if (!url || url === 'about:blank' || url.startsWith('chrome-error:')) return;

  if (url.startsWith('file://') || HTTP_URL_RE.test(url)) {
    updatePreviewTabSource(tabId, { kind: 'url', url });
    return;
  }

  try {
    const parsed = new URL(url);
    const prefix = `${window.location.origin}${PREVIEW_FILE_API}`;
    if (parsed.origin === window.location.origin && parsed.pathname.startsWith(PREVIEW_FILE_API)) {
      const encoded = parsed.pathname.slice(PREVIEW_FILE_API.length);
      const path = decodeURIComponent(encoded).replace(/^\/+/, '');
      updatePreviewTabSource(tabId, { kind: 'workspace', path });
    }
  } catch {
  }
}

function hideFrame(): void {
  if (secondaryFrame) {
    secondaryFrame.remove();
    secondaryFrame = null;
  }
}

function goBackInSecondaryFrame(): void {
  try {
    secondaryFrame?.contentWindow?.history.back();
  } catch {
  }
}

function goForwardInSecondaryFrame(): void {
  try {
    secondaryFrame?.contentWindow?.history.forward();
  } catch {
  }
}

async function loadSecondaryPreviewSource(
  source: PreviewSource,
  options?: { cacheBust?: boolean },
): Promise<void> {
  const tabId = getSecondaryPreviewTabId();
  if (!tabId) return;

  updatePreviewTabSource(tabId, source);
  syncSecondaryPreviewUrlInput(source);
  activeSecondaryTabId = tabId;

  const bust = options?.cacheBust ? Date.now() : undefined;
  const url = resolvePreviewLoadUrl(source, bust, getFileTreeListingWorkspaceRoot());
  loadedSecondaryUrl = url;

  if (usesElectron()) {
    hideFrame();
    await loadSecondaryElectron(tabId, url);
    return;
  }

  if (secondaryBound) {
    unbindPreviewInstance(WORKSPACE_PREVIEW_SECONDARY_INSTANCE);
    secondaryBound = false;
  }
  loadSecondaryIframe(url);
}

function navigateFromSecondaryAddressBar(): void {
  const input = getSecondaryUrlInput();
  if (!input) return;
  const parsed = parsePreviewAddress(input.value, { allowLocalFiles: usesElectron() });
  if (!parsed) return;
  void loadSecondaryPreviewSource(parsed);
}

function reloadSecondaryPreview(): void {
  const tabId = getSecondaryPreviewTabId();
  if (!tabId) return;

  const tab = getPreviewTab(tabId);
  const source = tab?.source;
  const api = window.minnow?.preview;

  if (usesElectron() && api) {
    if (source?.kind === 'workspace') {
      void loadSecondaryPreviewSource(source, { cacheBust: true });
      return;
    }
    if (source) {
      void api.reload(tabId, WORKSPACE_PREVIEW_SECONDARY_INSTANCE);
      return;
    }
    const input = getSecondaryUrlInput();
    const parsed = input ? parsePreviewAddress(input.value, { allowLocalFiles: true }) : null;
    if (parsed) void loadSecondaryPreviewSource(parsed, { cacheBust: true });
    return;
  }

  if (!source) {
    const input = getSecondaryUrlInput();
    const parsed = input ? parsePreviewAddress(input.value, { allowLocalFiles: false }) : null;
    if (parsed) void loadSecondaryPreviewSource(parsed, { cacheBust: true });
    return;
  }

  if (source.kind === 'workspace') {
    void loadSecondaryPreviewSource(source, { cacheBust: true });
    return;
  }

  try {
    secondaryFrame?.contentWindow?.location.reload();
  } catch {
    void loadSecondaryPreviewSource(source, { cacheBust: true });
  }
}

function bindSecondaryPreviewIpcListeners(): void {
  const api = window.minnow?.preview;
  if (!api) return;

  unsubscribeSecondaryNavigation?.();
  unsubscribeSecondaryNavigation = api.onNavigation((url, tabId, instanceId) => {
    if (instanceId && instanceId !== WORKSPACE_PREVIEW_SECONDARY_INSTANCE) return;
    const secondaryTabId = getSecondaryPreviewTabId();
    if (!secondaryTabId) return;
    const resolvedTabId = tabId ?? secondaryTabId;
    if (resolvedTabId !== secondaryTabId) return;
    syncSecondaryUrlInputFromNavigation(url);
    commitSecondaryTabSourceFromNavigation(url, secondaryTabId);
  });
}

/** Wire secondary preview header controls (back, forward, reload, Go, address bar). */
export function bindSecondaryPreviewControls(): void {
  if (secondaryControlsBound) return;
  secondaryControlsBound = true;

  const back = getSecondaryBackButton();
  const forward = getSecondaryForwardButton();
  if (back) back.disabled = false;
  if (forward) forward.disabled = false;

  document.getElementById('btnPreviewBackSecondary')?.addEventListener('click', () => {
    const tabId = getSecondaryPreviewTabId() ?? undefined;
    const api = window.minnow?.preview;
    if (usesElectron() && api) {
      void api.goBack(tabId, WORKSPACE_PREVIEW_SECONDARY_INSTANCE);
    } else {
      goBackInSecondaryFrame();
    }
  });

  document.getElementById('btnPreviewForwardSecondary')?.addEventListener('click', () => {
    const tabId = getSecondaryPreviewTabId() ?? undefined;
    const api = window.minnow?.preview;
    if (usesElectron() && api) {
      void api.goForward(tabId, WORKSPACE_PREVIEW_SECONDARY_INSTANCE);
    } else {
      goForwardInSecondaryFrame();
    }
  });

  document.getElementById('btnPreviewReloadSecondary')?.addEventListener('click', () => {
    reloadSecondaryPreview();
  });

  document.getElementById('btnPreviewGoSecondary')?.addEventListener('click', () => {
    navigateFromSecondaryAddressBar();
  });

  getSecondaryUrlInput()?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      navigateFromSecondaryAddressBar();
    }
  });
  const urlInput = getSecondaryUrlInput();
  if (urlInput) attachBrowserUrlSuggest(urlInput, { navigate: navigateFromSecondaryAddressBar });

  bindSecondaryPreviewIpcListeners();
}

/** Hide secondary preview guest and clear slot UI. */
export function hideSecondaryPreviewSlot(): void {
  activeSecondaryTabId = null;
  loadedSecondaryUrl = null;
  syncSecondaryPreviewUrlInput(null);
  hideFrame();
  if (secondaryBound) {
    unbindPreviewInstance(WORKSPACE_PREVIEW_SECONDARY_INSTANCE);
    secondaryBound = false;
  } else {
    setPreviewInstanceVisible(WORKSPACE_PREVIEW_SECONDARY_INSTANCE, false);
  }
}

async function loadSecondaryElectron(tabId: string, url: string): Promise<void> {
  const api = window.minnow?.preview;
  const body = getBody();
  if (!api || !body) return;

  if (!secondaryBound) {
    bindPreviewInstanceToElement(WORKSPACE_PREVIEW_SECONDARY_INSTANCE, body);
    secondaryBound = true;
  } else {
    setPreviewInstanceVisible(WORKSPACE_PREVIEW_SECONDARY_INSTANCE, true);
  }

  if (api.tabs?.create) {
    const listed = await api.tabs.list(WORKSPACE_PREVIEW_SECONDARY_INSTANCE);
    if (!listed.some((t) => t.id === tabId)) {
      await api.tabs.create(tabId, WORKSPACE_PREVIEW_SECONDARY_INSTANCE);
    }
  }
  if (api.tabs?.activate) {
    await api.tabs.activate(tabId, WORKSPACE_PREVIEW_SECONDARY_INSTANCE);
  }
  await api.loadURL(url, tabId, WORKSPACE_PREVIEW_SECONDARY_INSTANCE);
}

function loadSecondaryIframe(url: string): void {
  const body = getBody();
  if (!body) return;
  hideFrame();
  const frame = document.createElement('iframe');
  frame.className = 'preview-frame';
  frame.title = 'Workspace preview (secondary)';
  frame.setAttribute(
    'sandbox',
    'allow-scripts allow-forms allow-popups allow-modals allow-same-origin',
  );
  frame.src = url;
  body.appendChild(frame);
  secondaryFrame = frame;
}

/** Show preview tab in secondary slot. */
export async function renderSecondaryPreviewSlot(tabId: string | null): Promise<void> {
  if (!tabId) {
    hideSecondaryPreviewSlot();
    return;
  }
  const tab = getPreviewTab(tabId);
  if (!tab?.source) {
    hideSecondaryPreviewSlot();
    return;
  }
  activeSecondaryTabId = tabId;
  syncSecondaryPreviewUrlInput(tab.source);
  const url = resolvePreviewLoadUrl(tab.source, undefined, getFileTreeListingWorkspaceRoot());
  if (loadedSecondaryUrl === url) return;
  loadedSecondaryUrl = url;
  if (usesElectron()) {
    hideFrame();
    await loadSecondaryElectron(tabId, url);
    return;
  }
  if (secondaryBound) {
    unbindPreviewInstance(WORKSPACE_PREVIEW_SECONDARY_INSTANCE);
    secondaryBound = false;
  }
  loadSecondaryIframe(url);
}

/** When primary slot shows preview during split, keep primary Electron host on #previewBody. */
export async function renderPrimaryPreviewInSplitSlot(tabId: string | null): Promise<void> {
  if (!tabId) return;
  const preview = await import('./preview-panel');
  await preview.activatePreviewTabGuest(tabId);
}

/** Re-measure secondary preview bounds after layout changes. */
export function scheduleSecondaryPreviewHostLayoutSync(): void {
  if (!activeSecondaryTabId) return;
  void import('./preview-instance-host').then((m) => {
    m.syncPreviewInstanceBounds(WORKSPACE_PREVIEW_SECONDARY_INSTANCE);
  });
}


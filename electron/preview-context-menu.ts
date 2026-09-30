import {
  BrowserWindow,
  clipboard,
  Menu,
  shell,
  type ContextMenuParams,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
  type WebContents,
  type WebContentsView,
} from 'electron';
import * as channels from './ipc-channels.js';
import { allowedExternalUrl } from './navigation-policy.js';
import { trustedIpc } from './trusted-ipc.js';
import { resolveElementAtPoint } from './preview-cdp-element-at-point.js';
import {
  buildPreviewContextMenuItems,
  type PreviewContextMenuItem,
  type PreviewContextMenuParams,
  type PreviewContextMenuRole,
} from './preview-context-menu-items.js';

let contextMenuHost: PreviewContextMenuHost | null = null;

export interface PreviewContextMenuEntry {
  view: WebContentsView;
  visible: boolean;
  devtools: WebContentsView | null;
  devtoolsPopout: BrowserWindow | null;
}

export interface PreviewContextMenuHost {
  windowFromEvent(event: IpcMainInvokeEvent): BrowserWindow | null;
  getEntry(
    event: IpcMainInvokeEvent,
    tabId?: string,
    instanceId?: string,
  ): PreviewContextMenuEntry | null;
  openDevTools(
    win: BrowserWindow,
    tabId: string,
    entry: PreviewContextMenuEntry,
    instanceId?: string,
  ): void;
  isCdpPickActive(webContentsId: number): boolean;
}

export interface PreviewContextMenuOpenPayload {
  tabId: string;
  instanceId: string;
  x: number;
  y: number;
  params: PreviewContextMenuParams;
  items: ReturnType<typeof buildPreviewContextMenuItems>;
  canGoBack: boolean;
  canGoForward: boolean;
  pageUrl: string;
}

// ── Serialize ────────────────────────────────────────────────────────────────

function serializeParams(params: ContextMenuParams): PreviewContextMenuParams {
  return {
    linkURL: params.linkURL || '',
    srcURL: params.srcURL || '',
    mediaType: params.mediaType || 'none',
    isEditable: Boolean(params.isEditable),
    selectionText: params.selectionText || '',
    misspelledWord: params.misspelledWord || '',
    dictionarySuggestions: Array.isArray(params.dictionarySuggestions)
      ? [...params.dictionarySuggestions]
      : [],
    editFlags: {
      canCut: Boolean(params.editFlags?.canCut),
      canCopy: Boolean(params.editFlags?.canCopy),
      canPaste: Boolean(params.editFlags?.canPaste),
      canSelectAll: Boolean(params.editFlags?.canSelectAll),
    },
  };
}

function sendToRenderer(win: BrowserWindow, channel: string, ...args: unknown[]): void {
  if (win.isDestroyed()) return;
  win.webContents.send(channel, ...args);
}

export function guestPointToWindowCoords(
  entry: PreviewContextMenuEntry,
  params: Pick<ContextMenuParams, 'x' | 'y'>,
): { x: number; y: number } {
  const bounds = entry.view.getBounds();
  return {
    x: Math.round(bounds.x + params.x),
    y: Math.round(bounds.y + params.y),
  };
}

// ── Menu dispatch ────────────────────────────────────────────────────────────

function buildElectronContextMenu(
  items: PreviewContextMenuItem[],
  onSelect: (role: PreviewContextMenuRole, suggestion?: string) => void,
): Menu {
  const template: MenuItemConstructorOptions[] = [];
  for (const item of items) {
    if (item.type === 'separator') {
      template.push({ type: 'separator' });
      continue;
    }
    template.push({
      label: item.label,
      enabled: item.enabled,
      click: () => onSelect(item.role, item.suggestion),
    });
  }
  return Menu.buildFromTemplate(template);
}

async function dispatchContextMenuRole(
  host: PreviewContextMenuHost,
  win: BrowserWindow,
  tabId: string,
  instanceId: string,
  entry: PreviewContextMenuEntry,
  menuPayload: PreviewContextMenuOpenPayload,
  role: PreviewContextMenuRole,
  suggestion?: string,
): Promise<void> {
  const actionPayload = {
    x: menuPayload.x,
    y: menuPayload.y,
    linkURL: menuPayload.params.linkURL,
    srcURL: menuPayload.params.srcURL,
    suggestion,
    misspelledWord: menuPayload.params.misspelledWord,
  };

  if (role === 'sendToChat' || role === 'openLinkInNewTab') {
    sendToRenderer(win, channels.PREVIEW_CONTEXT_MENU_SELECT, {
      ...menuPayload,
      role,
      suggestion,
    });
    return;
  }

  if (role === 'inspect') {
    if (!entry.devtools && !entry.devtoolsPopout) {
      host.openDevTools(win, tabId, entry, instanceId);
    }
    const wc = entry.view.webContents;
    if (!wc.isDestroyed()) {
      wc.inspectElement(Math.round(menuPayload.x), Math.round(menuPayload.y));
    }
    return;
  }

  await runContextAction(entry, role, actionPayload);
}

// ── Guest handler ────────────────────────────────────────────────────────────

export function handleGuestContextMenu(
  win: BrowserWindow,
  tabId: string,
  instanceId: string,
  entry: PreviewContextMenuEntry,
  params: ContextMenuParams,
): void {
  const host = contextMenuHost;
  if (!host || !entry.visible || win.isDestroyed()) return;

  const wc = entry.view.webContents;
  if (wc.isDestroyed()) return;

  const canGoBack = typeof wc.navigationHistory?.canGoBack === 'function'
    ? wc.navigationHistory.canGoBack()
    : typeof (wc as WebContents & { canGoBack?: () => boolean }).canGoBack === 'function'
      ? Boolean((wc as WebContents & { canGoBack: () => boolean }).canGoBack())
      : false;
  const canGoForward = typeof wc.navigationHistory?.canGoForward === 'function'
    ? wc.navigationHistory.canGoForward()
    : typeof (wc as WebContents & { canGoForward?: () => boolean }).canGoForward === 'function'
      ? Boolean((wc as WebContents & { canGoForward: () => boolean }).canGoForward())
      : false;

  const serialized = serializeParams(params);
  const items = buildPreviewContextMenuItems({
    params: serialized,
    canGoBack,
    canGoForward,
  });

  const menuPayload: PreviewContextMenuOpenPayload = {
    tabId,
    instanceId,
    x: params.x,
    y: params.y,
    params: serialized,
    items,
    canGoBack,
    canGoForward,
    pageUrl: wc.getURL(),
  };

  const { x, y } = guestPointToWindowCoords(entry, params);
  const menu = buildElectronContextMenu(items, (role, suggestion) => {
    void dispatchContextMenuRole(host, win, tabId, instanceId, entry, menuPayload, role, suggestion);
  });
  menu.popup({ window: win, x, y });
}

// ── Context actions ──────────────────────────────────────────────────────────

async function runContextAction(
  entry: PreviewContextMenuEntry,
  role: PreviewContextMenuRole,
  payload: {
    x?: number;
    y?: number;
    linkURL?: string;
    srcURL?: string;
    suggestion?: string;
    misspelledWord?: string;
  },
): Promise<{ ok: boolean; error?: string }> {
  const wc = entry.view.webContents;
  if (wc.isDestroyed()) return { ok: false, error: 'Preview guest is not available' };

  try {
    switch (role) {
      case 'goBack': {
        if (typeof wc.navigationHistory?.goBack === 'function') wc.navigationHistory.goBack();
        else if (typeof (wc as WebContents & { goBack?: () => void }).goBack === 'function') {
          (wc as WebContents & { goBack: () => void }).goBack();
        }
        return { ok: true };
      }
      case 'goForward': {
        if (typeof wc.navigationHistory?.goForward === 'function') wc.navigationHistory.goForward();
        else if (typeof (wc as WebContents & { goForward?: () => void }).goForward === 'function') {
          (wc as WebContents & { goForward: () => void }).goForward();
        }
        return { ok: true };
      }
      case 'reload':
        wc.reload();
        return { ok: true };
      case 'cut':
        wc.cut();
        return { ok: true };
      case 'copy':
        wc.copy();
        return { ok: true };
      case 'paste':
        wc.paste();
        return { ok: true };
      case 'selectAll':
        wc.selectAll();
        return { ok: true };
      case 'copyLink': {
        const url = typeof payload.linkURL === 'string' ? payload.linkURL.trim() : '';
        if (!url) return { ok: false, error: 'No link to copy' };
        clipboard.writeText(url);
        return { ok: true };
      }
      case 'openExternal': {
        const url = allowedExternalUrl(payload.linkURL);
        if (!url) return { ok: false, error: 'Unsupported external URL' };
        await shell.openExternal(url);
        return { ok: true };
      }
      case 'copyImage': {
        const x = Number(payload.x);
        const y = Number(payload.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
          return { ok: false, error: 'Invalid image coordinates' };
        }
        wc.copyImageAt(Math.round(x), Math.round(y));
        return { ok: true };
      }
      case 'copyImageAddress': {
        const url = typeof payload.srcURL === 'string' ? payload.srcURL.trim() : '';
        if (!url) return { ok: false, error: 'No image address' };
        clipboard.writeText(url);
        return { ok: true };
      }
      case 'saveImage': {
        const url = typeof payload.srcURL === 'string' ? payload.srcURL.trim() : '';
        if (!url) return { ok: false, error: 'No image to save' };
        wc.downloadURL(url);
        return { ok: true };
      }
      case 'replaceMisspelling': {
        const suggestion =
          typeof payload.suggestion === 'string' ? payload.suggestion.trim() : '';
        if (!suggestion) return { ok: false, error: 'No suggestion' };
        wc.replaceMisspelling(suggestion);
        return { ok: true };
      }
      case 'addToDictionary': {
        const word =
          typeof payload.misspelledWord === 'string' ? payload.misspelledWord.trim() : '';
        if (!word) return { ok: false, error: 'No word to add' };
        wc.session.addWordToSpellCheckerDictionary(word);
        return { ok: true };
      }
      default:
        return { ok: false, error: `Unsupported context action: ${role}` };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

// ── IPC ──────────────────────────────────────────────────────────────────────

export function registerPreviewContextMenuIpc(host: PreviewContextMenuHost): void {
  contextMenuHost = host;

  trustedIpc.handle(
    channels.PREVIEW_CONTEXT_INSPECT,
    async (
      event,
      tabId: string,
      instanceId: string | undefined,
      x: number,
      y: number,
    ) => {
      const win = host.windowFromEvent(event);
      const entry = host.getEntry(event, tabId, instanceId);
      if (!win || !entry) return { ok: false, error: 'Preview guest is not available' };
      if (!entry.visible) return { ok: false, error: 'Preview guest is hidden' };
      const wc = entry.view.webContents;
      if (wc.isDestroyed()) return { ok: false, error: 'Preview guest is not available' };
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return { ok: false, error: 'Invalid inspect coordinates' };
      }

      if (!entry.devtools && !entry.devtoolsPopout) {
        host.openDevTools(win, tabId, entry, instanceId);
      }
      try {
        wc.inspectElement(Math.round(x), Math.round(y));
        return { ok: true };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, error: message };
      }
    },
  );

  trustedIpc.handle(
    channels.PREVIEW_CONTEXT_RESOLVE_ELEMENT,
    async (
      event,
      tabId: string,
      instanceId: string | undefined,
      x: number,
      y: number,
    ) => {
      const entry = host.getEntry(event, tabId, instanceId);
      if (!entry) return { ok: false, error: 'Preview guest is not available' };
      const wc = entry.view.webContents;
      if (wc.isDestroyed()) return { ok: false, error: 'Preview guest is not available' };

      const result = await resolveElementAtPoint(wc, x, y, {
        pickSessionActive: host.isCdpPickActive(wc.id),
      });
      if (!result.ok) return result;
      return {
        ok: true,
        picked: result.picked,
        pageUrl: wc.getURL(),
      };
    },
  );

  trustedIpc.handle(
    channels.PREVIEW_CONTEXT_ACTION,
    async (
      event,
      tabId: string,
      instanceId: string | undefined,
      role: PreviewContextMenuRole,
      payload: {
        x?: number;
        y?: number;
        linkURL?: string;
        srcURL?: string;
        suggestion?: string;
        misspelledWord?: string;
      } = {},
    ) => {
      const entry = host.getEntry(event, tabId, instanceId);
      if (!entry) return { ok: false, error: 'Preview guest is not available' };
      if (role === 'openLinkInNewTab' || role === 'inspect' || role === 'sendToChat') {
        return { ok: false, error: `Role ${role} is handled in the renderer` };
      }
      return runContextAction(entry, role, payload ?? {});
    },
  );
}

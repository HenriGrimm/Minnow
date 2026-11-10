import {
  getFilePanelState, patchFilePanelState, type PaneSlotId, type SlotContent, type SlotPaneTabs,
} from '../../state/file-panel';
import { setPreviewTabDragData, setViewerTabDragData } from '../../attachments/tab-drag';
import { WORKSPACE_FILE_MIME } from '../../attachments/workspace-ref';
import { createFileTypeIconElement } from '../file-type-icons';
import {
  adoptActiveViewerTabPath, getActiveViewerTabPath, getViewerTab, isAttachmentViewerPath, listViewerTabs,
  onViewerTabStoreChange, restoreWorkspaceViewerTabs,
} from '../file-viewer-tab-store';
import { closeViewerTab, closeViewerTabPaths, renderViewerSlots } from '../file-viewer';
import { createIcon } from '../icon';
import { activatePreviewTabGuest, closePreviewTabUi, openNewPreviewTabUi } from '../preview-panel';
import { renderSecondaryPreviewSlot } from '../preview-secondary-slot';
import {
  activatePreviewTab, getActivePreviewTabId, getPreviewTab, listPreviewTabs, onPreviewTabStoreChange,
} from '../preview-tab-store';
import { mountGraphitePreviewWorkspace } from './graphite-preview-workspace';
import type { ContentTabPlacement, SurfaceContent } from './surface-registry';
import { closeSurfaceTab, contentTab, getSurfacePanel, type ContentTabId, type ContentTabKind } from './surface-state';
import { isCurrentSurfaceChat, moveSurfaceNode, refreshSurfacePanels, retargetContentSurface } from './surfaces-column';

const SLOTS = ['primary', 'secondary'] as const;

function slotTabs(file?: ContentTabPlacement, browser?: ContentTabPlacement): SlotPaneTabs {
  const path = contentTab(file?.id)?.key ?? null;
  const previewId = contentTab(browser?.id)?.key ?? null;
  return {
    viewerPaths: path ? [path] : [],
    activeViewerPath: path,
    previewIds: previewId ? [previewId] : [],
    activePreviewId: previewId,
    surface: path ? 'viewer' : previewId ? 'preview' : 'none',
  };
}

function slotContent(tabs: SlotPaneTabs): SlotContent {
  if (tabs.activeViewerPath) return { kind: 'viewer', tabPath: tabs.activeViewerPath };
  if (tabs.activePreviewId) return { kind: 'preview', tabId: tabs.activePreviewId };
  return { kind: 'none' };
}

export function createWorkbenchContent(stage: HTMLElement): SurfaceContent {
  const saved = getFilePanelState();
  if (!listViewerTabs().length && saved.openViewerTabs.length) {
    restoreWorkspaceViewerTabs(saved.openViewerTabs, saved.activeViewerTab);
  }

  const hosts = SLOTS.map((slot) => {
    const suffix = slot === 'primary' ? '' : 'Secondary';
    const viewer = document.getElementById(`fileViewerPane${suffix}`)!;
    const preview = document.getElementById(`previewPane${suffix}`)!;
    const browser = document.createElement('div');
    browser.className = 'graphite-browser-host';
    const workspace = mountGraphitePreviewWorkspace(browser, stage, [preview]);
    const parking = viewer.parentElement!;
    parking.append(browser);
    moveSurfaceNode(preview, browser);
    preview.classList.add('graphite-browser-detached');
    return { slot, viewer, browser, preview, parking, workspace,
      current: {} as Partial<Record<ContentTabKind, ContentTabPlacement>>,
    };
  });
  const pending = new Map<ContentTabId, Promise<void>>();
  const previewSlots = new WeakMap<NonNullable<ReturnType<typeof getPreviewTab>>, PaneSlotId>();
  let imported = false;

  function previewSlot(tabId: string): PaneSlotId | undefined {
    const tab = getPreviewTab(tabId);
    return tab && previewSlots.get(tab);
  }

  const trackViewerPaths = new WeakMap(listViewerTabs().map(tab => [tab, tab.path]));
  onViewerTabStoreChange(() => {
    for (const tab of listViewerTabs()) {
      const prior = trackViewerPaths.get(tab);
      if (prior && prior !== tab.path) retargetContentSurface(`file:${prior}`, `file:${tab.path}`);
      trackViewerPaths.set(tab, tab.path);
    }
    refreshSurfacePanels();
  });
  onPreviewTabStoreChange(refreshSurfacePanels);

  function activateBrowser(id: ContentTabId, slot: PaneSlotId, forceLoad = false): Promise<void> {
    const tab = contentTab(id)!;
    const host = hosts[slot === 'primary' ? 0 : 1];
    const current = host.current.preview;
    const isCurrent = () => host.current.preview?.id === id && host.current.preview.chat.id === current?.chat.id;
    const task = Promise.resolve().then(async () => {
      if (!isCurrent()) return;
      if (slot === 'primary') {
        await activatePreviewTabGuest(tab.key, { fromSurface: true, forceLoad, isCurrent });
      } else {
        await renderSecondaryPreviewSlot(tab.key, { forceLoad, isCurrent });
      }
    }).catch(error => console.error('[graphite] Could not activate browser tab', error)).finally(() => {
      if (pending.get(id) === task) pending.delete(id);
    });
    pending.set(id, task);
    return task;
  }

  function place(kind: ContentTabKind, visible: ContentTabPlacement[]): (ContentTabPlacement | undefined)[] {
    const tabs = visible.filter(tab => contentTab(tab.id)?.kind === kind);
    const next = hosts.map(host => tabs.find(tab => tab.id === host.current[kind]?.id));
    for (const tab of tabs) {
      if (next.includes(tab)) continue;
      const previousSlot = kind === 'preview' ? previewSlot(contentTab(tab.id)!.key) : undefined;
      const preferred = hosts.findIndex((host, index) => !next[index] && host.slot === previousSlot);
      next[preferred >= 0 ? preferred : next.indexOf(undefined)] = tab;
    }
    return next;
  }

  return {
    previewSlot,
    describe(id) {
      const tab = contentTab(id)!;
      if (tab.kind === 'file') {
        const file = getViewerTab(tab.key);
        return file && {
          label: file.displayName, title: file.path, dirty: file.isDirty,
          icon: () => createFileTypeIconElement(file.path, 'tab'),
        };
      }
      const browser = getPreviewTab(tab.key);
      return browser && {
        label: browser.title === 'New tab' ? 'New browser tab' : browser.title,
        title: browser.source?.kind === 'url' ? browser.source.url : browser.title,
        icon: () => createIcon('browser', { size: 14 }), loading: browser.loading,
      };
    },
    layout(visible, focused) {
      // Files and browsers can use their primary hosts at the same time. The
      // secondary hosts are needed when both panels show the same kind of tab.
      const files = place('file', visible);
      const browsers = place('preview', visible);
      const primary = slotTabs(files[0], browsers[0]);
      const secondary = slotTabs(files[1], browsers[1]);
      const current = getFilePanelState();
      const enabled = secondary.surface !== 'none';
      const mode = enabled ? 'split' : primary.surface === 'none' ? null : primary.surface;
      const focusedSlot = (files[1] ?? browsers[1])?.panel === focused ? 'secondary' : 'primary';
      const filesChanged = files.some((tab, index) => tab?.id !== hosts[index].current.file?.id);
      const browsersChanged = browsers.some((tab, index) => tab?.id !== hosts[index].current.preview?.id);
      const focusChanged = current.rightPaneSplit.focusedSlot !== focusedSlot;
      if (filesChanged || browsersChanged || current.rightPaneMode !== mode || current.rightPaneSplit.enabled !== enabled ||
        focusChanged) {
        patchFilePanelState({
          rightPaneMode: mode, viewerOpen: Boolean(mode), rightPaneCollapsed: false,
          rightPaneSplit: {
            ...current.rightPaneSplit, enabled, focusedSlot,
            primary: slotContent(primary), secondary: slotContent(secondary),
            primaryTabs: primary, secondaryTabs: secondary,
          },
        });
      }
      const activeFile = (focusedSlot === 'secondary' ? secondary : primary).activeViewerPath ??
        primary.activeViewerPath ?? secondary.activeViewerPath;
      if (activeFile) adoptActiveViewerTabPath(activeFile);
      if (filesChanged && activeFile) queueMicrotask(renderViewerSlots);
      if (!files[1] && hosts[1].current.file) {
        void import('../file-viewer-secondary-slot').then(({ destroySecondaryViewerSlot }) => {
          if (!hosts[1].current.file) destroySecondaryViewerSlot();
        });
      }
      const activeBrowser = primary.activePreviewId ?? secondary.activePreviewId;
      if (activeBrowser && activeBrowser !== getActivePreviewTabId()) activatePreviewTab(activeBrowser);

      for (const [index, host] of hosts.entries()) {
        host.current.file = files[index];
        if (!files[index]) moveSurfaceNode(host.viewer, host.parking);

        const before = host.current.preview;
        const tab = host.current.preview = browsers[index];
        if (!tab) {
          moveSurfaceNode(host.browser, host.parking);
          if (before) host.workspace.setVisible(false, before);
          continue;
        }
        const browser = getPreviewTab(contentTab(tab.id)!.key);
        if (browser) previewSlots.set(browser, host.slot);
        host.preview.classList.remove('hidden');
        const changed = tab.id !== before?.id || tab.chat.id !== before.chat.id;
        if (changed || tab.panel !== before.panel) {
          queueMicrotask(() => {
            if (host.current.preview === tab) host.workspace.setVisible(true, tab);
          });
        }
        if (changed) void activateBrowser(tab.id, host.slot);
      }
    },
    render(id) {
      const kind = contentTab(id)!.kind;
      const host = hosts.find(({ current }) => current[kind]?.id === id);
      if (!host) return null;
      const node = kind === 'file' ? host.viewer : host.browser;
      node.classList.remove('hidden');
      return node;
    },
    ready(id, forceLoad) {
      const task = pending.get(id);
      const host = hosts.find(({ current }) => current.preview?.id === id);
      if (task) return task;
      if (forceLoad && host && contentTab(id)?.kind === 'preview') return activateBrowser(id, host.slot, true);
      return Promise.resolve();
    },
    async close(id) {
      const tab = contentTab(id)!;
      if (tab.kind === 'file') await closeViewerTab(tab.key);
      else await closePreviewTabUi(tab.key);
    },
    closeFiles: closeViewerTabPaths,
    drag(id, transfer) {
      const tab = contentTab(id)!;
      if (tab.kind === 'preview') {
        const browser = getPreviewTab(tab.key);
        if (browser) setPreviewTabDragData(transfer, browser);
      } else if (!isAttachmentViewerPath(tab.key)) {
        const file = getViewerTab(tab.key);
        if (!file) return;
        setViewerTabDragData(transfer, { path: file.path, label: file.displayName });
        transfer.setData(WORKSPACE_FILE_MIME, file.path);
      }
    },
    async openBrowser({ chat, panel, target }) {
      const url = (target as { url?: unknown } | undefined)?.url;
      const source = typeof url === 'string' && /^https?:\/\//i.test(url.trim())
        ? { kind: 'url' as const, url: url.trim() } : null;
      await openNewPreviewTabUi(source, panel, () => isCurrentSurfaceChat(chat.id));
    },
    restore(state, hasSaved) {
      const migrated = state.open.includes('preview');
      const addMissing = !imported && (!hasSaved || migrated || state.open.includes('files'));
      const browsePanel = getSurfacePanel(state, 'preview');
      const filePanel = getSurfacePanel(state, 'files');
      const browserActive = state[browsePanel].active === 'preview';
      const viewerActive = state[filePanel].active === 'files' && !state.open.some(id => contentTab(id)?.kind === 'file');
      const previews = listPreviewTabs().filter(tab => tab.source || migrated);
      const activePreview = previews.find(tab => tab.id === getActivePreviewTabId());
      if (migrated) closeSurfaceTab(state, 'preview');
      const add = (id: ContentTabId, panel: typeof browsePanel) => {
        if (state.open.includes(id)) return;
        state.open.push(id);
        state.panelOf[id] = panel;
      };
      if (migrated || addMissing) for (const tab of previews) add(`preview:${tab.id}`, browsePanel);
      if (addMissing) for (const tab of listViewerTabs()) add(`file:${tab.path}`, filePanel);
      const path = getActiveViewerTabPath();
      if (addMissing && viewerActive && path) state[filePanel].active = `file:${path}`;
      if (browserActive && activePreview) state[browsePanel].active = `preview:${activePreview.id}`;
      imported = true;
    },
  };
}

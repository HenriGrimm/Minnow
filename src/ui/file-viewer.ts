import { appAlert, appConfirm, appPrompt } from './app-dialog';
/**
 * Editable file viewer (CodeMirror 6) with multi-tab strip and per-tab in-memory state.
 */

import { EditorSelection, EditorState, type Extension } from '@codemirror/state';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { isImageFilePath } from '../attachments/image-path';
import {
  documentPreviewViewMode,
  getDocumentPreviewKind,
} from '../attachments/document-path';
import { setAssistantBubbleContent } from '../markdown/renderer';
import { scrollMarkdownHeading, takePendingMarkdownHeading } from '../markdown/links';
import { executeTool, getLocalServerAvailable } from '../tools/client';
import { resolveDocumentHtmlLoadUrl, resolvePreviewLoadUrl } from './preview-load-url';
import { getFileTreeListingWorkspaceRoot } from './file-tree-listing-root';
import { getActivePreviewTabId, listPreviewTabs } from './preview-tab-store';
import { fetchLspConfig } from '../lsp/config-client';
import { notifyLspDocument } from '../lsp/completion-client';
import {
  MAX_OPEN_VIEWER_TABS,
  getFilePanelState,
  patchFilePanelState,
} from '../state/file-panel';
import {
  hideViewerPaneDom,
  hideViewerSplit,
  isMobileLayout,
  showViewerSplit,
} from './file-layout';
import { isMarkdownFilePath } from './file-markdown-path';
import { showFilePanelContextMenu } from './file-tree-context-menu';
import {
  renderFileTreeViaBridge,
} from './file-tree-refresh-bridge';
import {
  EDITOR_AI_CONFIG_CHANGED_EVENT,
  loadEditorAiCompletionConfig,
  getEditorAiCompletionConfigSync,
} from '../config/editor-ai-completion';
import {
  getEditorIntentModeConfigSync,
  loadEditorIntentModeConfig,
} from '../config/editor-intent-mode';
import { EDITOR_AI_NO_MODEL_MESSAGE } from './editor-ai-binding';
import { loadEditorSettings } from '../config/editor-settings';
import { minnowEditorExtensions } from './codemirror-theme';
import { editorCoreExtensions } from './editor-core-extensions';
import { loadLanguageExtensionsForPath } from './editor-language';
import { fileEditorKeymapExtensions } from './file-editor-keymap';
import { lspEditorExtensions } from './file-editor-extensions';
import { setLspDiagnosticsChromeListener } from './lsp-editor';
import {
  editorSuggestionBaseExtensions,
  editorSuggestionCompartmentExtension,
  editorSuggestionExtensions,
  mountEditorSuggestions,
  reconfigureEditorSuggestions,
  type EditorSuggestionOptions,
} from './editor-suggestions';
import { isIntentEnabled, toggleIntentMode } from './editor-suggestions';
import { addCodeReferenceToComposer } from '../attachments/code-ref';
import { CAPTURE_MENU_KINDS, legacyCaptureMenuItems } from './issue-capture';
import { codeSelectionDragExtension } from './editor-code-selection-drag';
import {
  buildFileViewerContextMenuItems,
  editorQuickEditExtensions,
  lineNumbersForRange,
  openQuickEditPanel,
} from './editor-quick-edit';
import {
  activateViewerTab,
  adoptActiveViewerTabPath,
  clearAllViewerTabs,
  getActiveViewerTab,
  getActiveViewerTabPath,
  getOpenViewerTabPaths,
  getViewerTab,
  isAnyViewerTabDirty,
  isAttachmentViewerPath,
  isViewerDocDirty,
  isViewerTabDirty,
  listViewerTabs,
  markViewerTabSaved,
  normalizeViewerDocText,
  openViewerTab,
  rebaselineViewerTabFromEditor,
  removeViewerTab,
  restoreWorkspaceViewerTabs,
  retargetViewerTab,
  setActiveTabLoadState,
  setViewerTabLoadState,
  snapshotViewerTabEditorContent,
  type OpenViewerTabOptions,
  type ViewerTabState,
} from './file-viewer-tab-store';
import { refreshFileViewerTabs, registerFileViewerTabHandlers } from './file-viewer-tabs';
import { showViewerUnsavedDialog } from './file-viewer-unsaved-dialog';
import { renderViewerRecentFilesEmptyState } from './file-viewer-recent';
import { recordRecentViewerFile } from '../state/recent-viewer-files';
import { setStatus } from './status';

export const LARGE_FILE_BYTES = 512_000;
const RANGE_LINE_COUNT = 2000;
const LSP_CHANGE_DEBOUNCE_MS = 400;

/** Footer appended when only a range of a large file is loaded. */
export const LARGE_FILE_EXCERPT_FOOTER_RE =
  /\n\n\/\* Showing lines 1–\d+ only \(\d+ bytes total\)\. \*\/\s*$/;

let editorView: EditorView | null = null;
/** Path key for the tab currently bound to `editorView` (may differ from active tab during switches). */
let editorViewPath: string | null = null;
/** Monotonic token so stale async `mountEditor` completions are discarded. */
let mountGeneration = 0;
let markdownPreviewEl: HTMLElement | null = null;
/** What the primary host is painting right now — guards against redundant remounts. */
let primaryRenderKey: string | null = null;
/** Path of an async editor mount that has not attached its EditorView yet. */
let pendingMountPath: string | null = null;
/** Paths with an in-flight content load — both panes can ask for the same tab. */
const loadsInFlight = new Set<string>();
let isSaving = false;
let viewerControlsBound = false;
let viewerContextMenuBound = false;
let lspSyncedPath: string | null = null;
let lspChangeTimer: ReturnType<typeof setTimeout> | null = null;
let editorAiStatusEl: HTMLElement | null = null;
let editorIntentToggleEl: HTMLButtonElement | null = null;
/** Per-document Intent mode enabled flag (session only). */
const intentModeEnabledByPath = new Map<string, boolean>();
let editorAiModelSelectListener: (() => void) | null = null;
/** Live suggestion options for hot-reload without remounting the editor. */
let editorAiOpts: EditorSuggestionOptions | null = null;
let diagnosticsBadgeEl: HTMLElement | null = null;
/** Blob URL for the active PDF preview; revoked when the tab unmounts. */
let activePdfPreviewBlobUrl: string | null = null;

// ── Slots ────────────────────────────────────────────────────────────────────

function revokeActivePdfPreviewBlob(): void {
  if (!activePdfPreviewBlobUrl) return;
  URL.revokeObjectURL(activePdfPreviewBlobUrl);
  activePdfPreviewBlobUrl = null;
}

/** True when the right pane is showing two editor groups. */
function splitLayoutEnabled(): boolean {
  const state = getFilePanelState();
  return (
    state.rightPaneSplit.enabled && state.rightPaneMode === 'split' && !isMobileLayout()
  );
}

/** Path the **primary** pane renders. */
function primarySlotViewerPath(): string | null {
  if (!splitLayoutEnabled()) return getActiveViewerTabPath();
  return getFilePanelState().rightPaneSplit.primaryTabs.activeViewerPath;
}

function primarySlotViewerTab(): ViewerTabState | null {
  const path = primarySlotViewerPath();
  if (!path) return null;
  return getViewerTab(path) ?? null;
}

/** Path the secondary pane renders (null when the split is closed). */
function secondarySlotViewerPath(): string | null {
  if (!splitLayoutEnabled()) return null;
  const tabs = getFilePanelState().rightPaneSplit.secondaryTabs;
  return tabs.surface === 'preview' ? null : tabs.activeViewerPath;
}

/** True when the primary pane is currently showing a browser tab instead of a file. */
function primarySlotShowsPreview(): boolean {
  if (!splitLayoutEnabled()) return getFilePanelState().rightPaneMode === 'preview';
  return getFilePanelState().rightPaneSplit.primary.kind === 'preview';
}

/** Repaint whichever pane(s) are showing `path` after its content or mode changed. */
function renderViewerSlotsForPath(path: string): void {
  if (primarySlotViewerPath() === path) renderActiveViewerTab();
  if (secondarySlotViewerPath() === path) renderSecondarySlot();
}

function renderSecondarySlot(): void {
  if (!splitLayoutEnabled()) return;
  const tabs = getFilePanelState().rightPaneSplit.secondaryTabs;
  void import('./file-viewer-secondary-slot').then((m) => {
    if (tabs.surface === 'preview') {
      m.destroySecondaryViewerSlot();
      return;
    }
    m.renderSecondaryViewerSlot(tabs.activeViewerPath);
  });
}

/** Repaint both editor groups from their own slot tab lists. */
export function renderViewerSlots(): void {
  renderActiveViewerTab();
  renderSecondarySlot();
}

/** Identity of what the primary host is currently painting. */
function primaryRenderKeyFor(tab: ViewerTabState): string {
  return `${tab.path}::${tab.viewMode}::${tab.loadStatus}`;
}

/** True when the primary host already shows this tab and needs no remount. */
function primaryRenderIsCurrent(tab: ViewerTabState): boolean {
  if (primaryRenderKey !== primaryRenderKeyFor(tab)) return false;
  const host = getViewerHost();
  if (!host || host.childElementCount === 0) return false;
  if (tab.viewMode === 'editor') {
    return (editorView !== null && editorViewPath === tab.path) || pendingMountPath === tab.path;
  }
  if (tab.viewMode === 'markdown-preview') return markdownPreviewEl !== null;
  return true;
}

/** Force the next {@link renderActiveViewerTab} to remount (content or mode changed). */
export function invalidatePrimaryViewerRender(): void {
  primaryRenderKey = null;
}

// ── Path ─────────────────────────────────────────────────────────────────────

/** Strip "N: " prefixes from read_file_range output (EOL-normalized for the editor). */
export function parseReadFileRangeBody(raw: string): string {
  return normalizeViewerDocText(raw)
    .split('\n')
    .map((line) => line.replace(/^\d+:\s?/, ''))
    .join('\n');
}

export { normalizeViewerDocText, isViewerDocDirty } from './file-viewer-tab-store';

/** Path label with optional dirty marker (●). */
export function formatViewerPathLabel(path: string, dirty: boolean): string {
  return dirty ? `${path} ●` : path;
}

/** Whether content ends with the large-file excerpt notice. */
export function hasLargeFileExcerptFooter(content: string): boolean {
  return LARGE_FILE_EXCERPT_FOOTER_RE.test(content);
}

export { isMarkdownFilePath } from './file-markdown-path';

/** Whether to show GFM preview instead of the CodeMirror editor for this open request. */
export function shouldUseMarkdownPreview(path: string, asCode?: boolean): boolean {
  return isMarkdownFilePath(path) && !asCode;
}

/** True when the viewer is showing markdown preview (not the code editor). */
export function isMarkdownPreviewActive(): boolean {
  const tab = primarySlotViewerTab();
  return tab?.viewMode === 'markdown-preview' && markdownPreviewEl !== null;
}

function buildLargeFileExcerptFooter(byteLength: number): string {
  return `\n\n/* Showing lines 1–${RANGE_LINE_COUNT} only (${byteLength} bytes total). */`;
}

function getViewerHost(): HTMLElement | null {
  return document.getElementById('fileViewerHost');
}

// ── Intent ───────────────────────────────────────────────────────────────────

function getIntentToggleButton(): HTMLButtonElement | null {
  return document.getElementById('btnFileViewerIntent') as HTMLButtonElement | null;
}

function isIntentModeEnabledForPath(path: string, defaultEnabled: boolean): boolean {
  if (intentModeEnabledByPath.has(path)) {
    return intentModeEnabledByPath.get(path) === true;
  }
  return defaultEnabled;
}

function setIntentModeEnabledForPath(path: string, enabled: boolean): void {
  intentModeEnabledByPath.set(path, enabled);
  updateIntentToolbarChrome(enabled);
}

/** Per-path Intent toggle memory (shared by primary and secondary editors). */
export function rememberIntentModeEnabledForPath(path: string, enabled: boolean): void {
  intentModeEnabledByPath.set(path, enabled);
}

export function isIntentModeEnabledForViewerPath(path: string, defaultEnabled: boolean): boolean {
  return isIntentModeEnabledForPath(path, defaultEnabled);
}

function updateIntentToolbarChrome(enabled: boolean): void {
  applyIntentToolbarChrome(editorIntentToggleEl ?? getIntentToggleButton(), enabled);
}

function getSecondaryIntentToggleButton(): HTMLButtonElement | null {
  return document.getElementById('btnFileViewerIntentSecondary') as HTMLButtonElement | null;
}

function getSecondarySaveButton(): HTMLButtonElement | null {
  return document.getElementById('btnFileViewerSaveSecondary') as HTMLButtonElement | null;
}

function applyIntentToolbarChrome(toggle: HTMLButtonElement | null, enabled: boolean): void {
  if (!toggle) return;
  toggle.classList.toggle('is-active', enabled);
  toggle.setAttribute('aria-pressed', enabled ? 'true' : 'false');
  if (!enabled) toggle.classList.remove('is-busy');
}

/** Spinner on the toggle while an intent proposal is being generated. */
function applyIntentBusyChrome(toggle: HTMLButtonElement | null, busy: boolean): void {
  if (!toggle) return;
  toggle.classList.toggle('is-busy', busy);
  toggle.setAttribute('aria-busy', busy ? 'true' : 'false');
}

/** Intent chrome for the secondary editor group header. */
export function syncSecondaryIntentToolbarChrome(enabled: boolean): void {
  applyIntentToolbarChrome(getSecondaryIntentToggleButton(), enabled);
}

/** Intent busy chrome for the secondary editor group header. */
export function syncSecondaryIntentBusyChrome(busy: boolean): void {
  applyIntentBusyChrome(getSecondaryIntentToggleButton(), busy);
}

function syncSecondaryIntentToolbarAvailability(tab: ViewerTabState | null): void {
  const toggle = getSecondaryIntentToggleButton();
  if (!toggle) return;
  void import('./file-viewer-secondary-slot').then((m) => {
    const secondaryView = m.getSecondaryViewerEditorView();
    const available =
      Boolean(tab) &&
      tab!.viewMode === 'editor' &&
      !tab!.readOnlyExcerpt &&
      getLocalServerAvailable() &&
      Boolean(secondaryView);
    toggle.disabled = !available;
  });
}

/** Secondary pane header (save + intent) — mirrors primary chrome for the secondary tab. */
export function updateSecondaryViewerChrome(): void {
  const path = secondarySlotViewerPath();
  const tab = path ? (getViewerTab(path) ?? null) : null;
  const saveBtn = getSecondarySaveButton();
  if (saveBtn) {
    void import('./file-viewer-secondary-slot').then((m) => {
      const secondaryView = m.getSecondaryViewerEditorView();
      const canSave = Boolean(
        tab &&
          secondaryView &&
          tab.isDirty &&
          !tab.readOnlyExcerpt &&
          tab.viewMode === 'editor' &&
          !isSaving,
      );
      saveBtn.disabled = !canSave;
      saveBtn.classList.toggle('file-viewer-save--active', canSave);
      saveBtn.setAttribute('aria-busy', isSaving ? 'true' : 'false');
    });
  }
  syncSecondaryIntentToolbarAvailability(tab);
  if (tab && tab.viewMode === 'editor') {
    void import('./file-viewer-secondary-slot').then((m) => {
      const secondaryView = m.getSecondaryViewerEditorView();
      if (!secondaryView) return;
      syncSecondaryIntentToolbarChrome(isIntentEnabled(secondaryView.state));
    });
  } else {
    syncSecondaryIntentToolbarChrome(false);
  }
}

function syncIntentToolbarAvailability(tab: ViewerTabState | null): void {
  const toggle = editorIntentToggleEl ?? getIntentToggleButton();
  if (!toggle) return;
  const available =
    Boolean(tab) &&
    tab!.viewMode === 'editor' &&
    !tab!.readOnlyExcerpt &&
    getLocalServerAvailable() &&
    Boolean(editorView);
  toggle.disabled = !available;
}

function getSaveButton(): HTMLButtonElement | null {
  return document.getElementById('btnFileViewerSave') as HTMLButtonElement | null;
}

function getReadOnlyBanner(): HTMLElement | null {
  return document.getElementById('fileViewerReadOnlyBanner');
}

// ── LSP ──────────────────────────────────────────────────────────────────────

function activeTabContent(tab: ViewerTabState): string {
  if (editorView && editorViewPath === tab.path) {
    return editorView.state.doc.toString();
  }
  return tab.cachedEditorContent ?? tab.originalContent;
}

function readOnlyBannerMessage(tab: ViewerTabState): string {
  if (tab.readOnlyBannerText) return tab.readOnlyBannerText;
  return `Read-only preview: file is larger than ${LARGE_FILE_BYTES.toLocaleString()} bytes; showing lines 1–${RANGE_LINE_COUNT} only.`;
}

function clearLspChangeTimer(): void {
  if (lspChangeTimer) {
    clearTimeout(lspChangeTimer);
    lspChangeTimer = null;
  }
}

function closeLspDocument(): void {
  clearLspChangeTimer();
  if (lspSyncedPath) {
    void notifyLspDocument(lspSyncedPath, 'close');
    lspSyncedPath = null;
  }
}

function scheduleLspChangeNotify(path: string, text: string): void {
  if (lspSyncedPath !== path) return;
  clearLspChangeTimer();
  lspChangeTimer = setTimeout(() => {
    void notifyLspDocument(path, 'change', text);
  }, LSP_CHANGE_DEBOUNCE_MS);
}

/** Whether the file viewer should sync documents to LSP (config + local server). */
export async function isLspEnabledForViewer(): Promise<boolean> {
  if (!getLocalServerAvailable()) return false;
  const cfg = await fetchLspConfig();
  return cfg?.enabled === true;
}

let snapshotSecondaryEditor: (() => void) | null = null;

/** Let the secondary slot editor take part in the unsaved-changes guard. */
export function registerSecondaryEditorSnapshot(fn: (() => void) | null): void {
  snapshotSecondaryEditor = fn;
}

/** Persist the live editor buffers of both slots into the tabs that own them. */
function snapshotOutgoingEditorTab(): void {
  snapshotSecondaryEditor?.();
  if (!editorView || !editorViewPath) return;
  const tab = getViewerTab(editorViewPath);
  if (!tab || tab.viewMode === 'image') return;
  const text = editorView.state.doc.toString();
  const dirty = !tab.readOnlyExcerpt && isViewerDocDirty(text, tab.originalContent);
  snapshotViewerTabEditorContent(editorViewPath, text, dirty);
}

function detachEditorAiModelSelectListener(): void {
  if (!editorAiModelSelectListener) return;
  document
    .getElementById('modelSelect')
    ?.removeEventListener('change', editorAiModelSelectListener);
  editorAiModelSelectListener = null;
}

/** Clear stale "no model" hint when the user picks a model while editing. */
function attachEditorAiModelSelectListener(): void {
  detachEditorAiModelSelectListener();
  editorAiModelSelectListener = () => {
    if (!editorAiStatusEl || editorAiStatusEl.hidden) return;
    if (editorAiStatusEl.textContent === EDITOR_AI_NO_MODEL_MESSAGE) {
      editorAiStatusEl.hidden = true;
    }
  };
  document
    .getElementById('modelSelect')
    ?.addEventListener('change', editorAiModelSelectListener);
}

function destroyEditor(): void {
  snapshotOutgoingEditorTab();
  closeLspDocument();
  detachEditorAiModelSelectListener();
  revokeActivePdfPreviewBlob();
  if (editorView) {
    editorView.destroy();
    editorView = null;
  }
  editorViewPath = null;
  markdownPreviewEl = null;
}

function ensureDiagnosticsBadge(): HTMLElement | null {
  if (!diagnosticsBadgeEl) {
    diagnosticsBadgeEl = document.getElementById('fileViewerDiagnostics');
  }
  return diagnosticsBadgeEl;
}

function updateDiagnosticsChrome(counts: {
  errors: number;
  warnings: number;
}): void {
  const badge = ensureDiagnosticsBadge();
  if (!badge) return;
  const { errors, warnings } = counts;
  if (errors === 0 && warnings === 0) {
    badge.hidden = true;
    badge.textContent = '';
    return;
  }
  const parts: string[] = [];
  if (errors > 0) parts.push(`${errors} error${errors === 1 ? '' : 's'}`);
  if (warnings > 0) parts.push(`${warnings} warning${warnings === 1 ? '' : 's'}`);
  badge.textContent = parts.join(', ');
  badge.hidden = false;
  badge.classList.toggle('file-viewer-diagnostics--errors', errors > 0);
}

function updateViewerChrome(): void {
  const tab = primarySlotViewerTab();
  const saveBtn = getSaveButton();
  if (saveBtn) {
    const canSave = Boolean(
      tab &&
        editorView &&
        tab.isDirty &&
        !tab.readOnlyExcerpt &&
        tab.viewMode === 'editor' &&
        !isSaving,
    );
    saveBtn.disabled = !canSave;
    saveBtn.classList.toggle('file-viewer-save--active', canSave);
    saveBtn.setAttribute('aria-busy', isSaving ? 'true' : 'false');
  }

  const banner = getReadOnlyBanner();
  if (banner && tab) {
    banner.hidden = !tab.readOnlyExcerpt;
    if (tab.readOnlyExcerpt) {
      banner.textContent = readOnlyBannerMessage(tab);
    }
  }
  refreshFileViewerTabs();
  syncIntentToolbarAvailability(tab);
  updateSecondaryViewerChrome();
}

// ── Mount ────────────────────────────────────────────────────────────────────

function mountMarkdownPreview(tab: ViewerTabState, content: string): void {
  const host = getViewerHost();
  if (!host) return;
  destroyEditor();
  host.innerHTML = '';

  if (tab.readOnlyExcerpt) {
    const banner = document.createElement('p');
    banner.id = 'fileViewerReadOnlyBanner';
    banner.className = 'file-viewer-readonly-banner';
    banner.textContent = readOnlyBannerMessage(tab);
    host.appendChild(banner);
  }

  const preview = document.createElement('div');
  preview.className = 'file-viewer-markdown-preview msg-bubble msg-bubble--md';
  // Relative markdown links resolve against this file, not the SPA origin.
  preview.dataset.mdSourcePath = tab.path;
  host.appendChild(preview);
  markdownPreviewEl = preview;
  setAssistantBubbleContent(preview, content, { streaming: false });
  const headingId = takePendingMarkdownHeading(tab.path);
  if (headingId) scrollMarkdownHeading(preview, headingId);
  updateViewerChrome();
}

function mountEditor(tab: ViewerTabState, content: string): void {
  const host = getViewerHost();
  if (!host) return;
  const generation = ++mountGeneration;
  destroyEditor();
  host.innerHTML = '';
  content = normalizeViewerDocText(content);

  if (tab.readOnlyExcerpt) {
    const banner = document.createElement('p');
    banner.id = 'fileViewerReadOnlyBanner';
    banner.className = 'file-viewer-readonly-banner';
    banner.textContent = readOnlyBannerMessage(tab);
    host.appendChild(banner);
  }

  const editorMount = document.createElement('div');
  editorMount.className = 'file-viewer-editor-mount';
  host.appendChild(editorMount);

  const aiStatus = document.createElement('p');
  aiStatus.className = 'file-viewer-ai-status field-hint';
  aiStatus.hidden = true;
  host.appendChild(aiStatus);
  editorAiStatusEl = aiStatus;

  const path = tab.path;
  pendingMountPath = path;

  void (async () => {
    const [langExts, useLsp, editorAiConfig, editorSettings, intentConfig] = await Promise.all([
      loadLanguageExtensionsForPath(path),
      isLspEnabledForViewer(),
      loadEditorAiCompletionConfig(),
      loadEditorSettings(),
      loadEditorIntentModeConfig(),
    ]);
    const readOnlyExts: Extension[] = tab.readOnlyExcerpt
      ? [EditorView.editable.of(false), EditorState.readOnly.of(true)]
      : [];
    const lspExts = useLsp ? lspEditorExtensions(path) : [];
    const useEditorAi =
      editorAiConfig.enabled && !tab.readOnlyExcerpt && getLocalServerAvailable();
    const canMountEditorAi = !tab.readOnlyExcerpt && getLocalServerAvailable();
    const intentInitialEnabled = isIntentModeEnabledForPath(path, intentConfig.enabledByDefault);
    editorAiOpts = canMountEditorAi
      ? {
          filePath: path,
          getConfig: getEditorAiCompletionConfigSync,
          getIntentConfig: getEditorIntentModeConfigSync,
          canRequest: () => getLocalServerAvailable(),
          onStatus: (message) => {
            if (!editorAiStatusEl) return;
            if (message) {
              editorAiStatusEl.textContent = message;
              editorAiStatusEl.hidden = false;
            } else {
              editorAiStatusEl.hidden = true;
            }
          },
          onIntentEnabledChange: (enabled) => {
            setIntentModeEnabledForPath(path, enabled);
          },
          onIntentBusyChange: (busy) => {
            applyIntentBusyChrome(editorIntentToggleEl ?? getIntentToggleButton(), busy);
          },
        }
      : null;
    const aiExts =
      canMountEditorAi && editorAiOpts
        ? [
            ...editorSuggestionBaseExtensions(),
            editorSuggestionCompartmentExtension(editorSuggestionExtensions(editorAiOpts)),
          ]
        : [];
    if (useEditorAi) attachEditorAiModelSelectListener();
    const quickEditExts =
      !tab.readOnlyExcerpt && getLocalServerAvailable()
        ? editorQuickEditExtensions({
            filePath: path,
            canRequest: () => getLocalServerAvailable(),
          })
        : [];
    const state = EditorState.create({
      doc: content,
      extensions: [
        lineNumbers(),
        ...readOnlyExts,
        ...lspExts,
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return;
          const text = update.state.doc.toString();
          if (useLsp) {
            scheduleLspChangeNotify(path, text);
          }
          const liveTab = getViewerTab(path);
          if (!liveTab || liveTab.readOnlyExcerpt) return;
          const nextDirty = isViewerDocDirty(text, liveTab.originalContent);
          if (nextDirty !== liveTab.isDirty) {
            snapshotViewerTabEditorContent(path, text, nextDirty);
            updateViewerChrome();
          }
        }),
        ...editorCoreExtensions({
          wordWrap: editorSettings.wordWrap,
          tabSize: editorSettings.tabSize,
          renderWhitespace: editorSettings.renderWhitespace,
        }),
        ...fileEditorKeymapExtensions(),
        ...aiExts,
        ...quickEditExts,
        keymap.of([
          {
            key: 'Mod-s',
            run: () => {
              void saveCurrentFile();
              return true;
            },
          },
        ]),
        EditorView.theme({
          '&': { height: '100%', fontSize: `${editorSettings.fontSize}px` },
          '.cm-scroller': { fontFamily: 'var(--font-mono)' },
          '.cm-content': { caretColor: 'var(--mn-fg)' },
        }),
        ...minnowEditorExtensions(),
        ...langExts,
        ...(tab.readOnlyExcerpt ? [] : [codeSelectionDragExtension(path)]),
      ],
    });
    if (generation !== mountGeneration) return;
    if (pendingMountPath === path) pendingMountPath = null;
    if (primarySlotViewerPath() !== path || !editorMount.isConnected) {
      primaryRenderKey = null;
      return;
    }
    editorView = new EditorView({ state, parent: editorMount });
    editorViewPath = path;
    const liveTab = getViewerTab(path);
    if (liveTab && !liveTab.readOnlyExcerpt && !liveTab.isDirty) {
      rebaselineViewerTabFromEditor(path, editorView.state.doc.toString());
    }
    if (aiExts.length > 0) {
      mountEditorSuggestions(editorView, intentInitialEnabled);
      updateIntentToolbarChrome(intentInitialEnabled);
    }
    syncIntentToolbarAvailability(tab);

    if (tab.pendingInitialLineRange && editorView) {
      const { startLine, endLine } = tab.pendingInitialLineRange;
      tab.pendingInitialLineRange = null;
      const doc = editorView.state.doc;
      const fromLine = Math.max(1, Math.min(startLine, doc.lines));
      const toLine = Math.max(fromLine, Math.min(endLine, doc.lines));
      const from = doc.line(fromLine).from;
      const to = doc.line(toLine).to;
      editorView.dispatch({
        selection: EditorSelection.range(from, to),
        scrollIntoView: true,
      });
      editorView.focus();
    } else if (tab.pendingInitialSelection && editorView) {
      const { line, character } = tab.pendingInitialSelection;
      tab.pendingInitialSelection = null;
      const doc = editorView.state.doc;
      const lineNumber = Math.min(line + 1, doc.lines);
      const lineInfo = doc.line(lineNumber);
      const col = Math.min(character, lineInfo.length);
      const anchor = lineInfo.from + col;
      editorView.dispatch({
        selection: EditorSelection.cursor(anchor),
        scrollIntoView: true,
      });
      editorView.focus();
    } else if (getActiveViewerTabPath() === path) {
      editorView.focus();
    }

    if (useLsp) {
      lspSyncedPath = path;
      void notifyLspDocument(path, 'open', content);
    }
    updateViewerChrome();
  })();
}

function mountImagePreview(tab: ViewerTabState, src: string, onImageError?: () => void): void {
  const host = getViewerHost();
  if (!host) return;
  destroyEditor();
  host.innerHTML = '';

  const banner = document.createElement('p');
  banner.id = 'fileViewerReadOnlyBanner';
  banner.className = 'file-viewer-readonly-banner';
  banner.textContent = readOnlyBannerMessage(tab);
  host.appendChild(banner);

  const figure = document.createElement('figure');
  figure.className = 'file-viewer-image-preview';
  const img = document.createElement('img');
  img.src = src;
  img.alt = tab.displayName;
  if (onImageError) {
    img.onerror = onImageError;
  }
  figure.appendChild(img);
  host.appendChild(figure);
  updateViewerChrome();
}

/** Embed spreadsheet/Word HTML previews (same-origin, server-rendered). */
function mountDocumentHtmlPreview(
  tab: ViewerTabState,
  src: string,
  title: string,
  onFrameError?: () => void,
): void {
  const host = getViewerHost();
  if (!host) return;
  destroyEditor();
  host.innerHTML = '';

  const banner = document.createElement('p');
  banner.id = 'fileViewerReadOnlyBanner';
  banner.className = 'file-viewer-readonly-banner';
  banner.textContent = readOnlyBannerMessage(tab);
  host.appendChild(banner);

  const frame = document.createElement('iframe');
  frame.className = 'file-viewer-document-preview';
  frame.title = title;
  frame.setAttribute('sandbox', '');
  frame.src = src;
  if (onFrameError) {
    frame.onerror = onFrameError;
  }
  host.appendChild(frame);
  updateViewerChrome();
}

/** PDF preview via blob URL + embed. */
async function mountPdfPreview(tab: ViewerTabState, src: string): Promise<void> {
  const host = getViewerHost();
  if (!host) return;
  destroyEditor();
  host.innerHTML = '<p class="file-viewer-status">Loading PDF…</p>';

  try {
    const response = await fetch(src);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const blob = await response.blob();
    revokeActivePdfPreviewBlob();
    activePdfPreviewBlobUrl = URL.createObjectURL(blob);

    host.innerHTML = '';

    const banner = document.createElement('p');
    banner.id = 'fileViewerReadOnlyBanner';
    banner.className = 'file-viewer-readonly-banner';
    banner.textContent = readOnlyBannerMessage(tab);
    host.appendChild(banner);

    const embed = document.createElement('embed');
    embed.className = 'file-viewer-document-preview file-viewer-pdf-preview';
    embed.type = 'application/pdf';
    embed.src = activePdfPreviewBlobUrl;
    embed.title = tab.displayName;
    host.appendChild(embed);
    updateViewerChrome();
  } catch {
    setViewerError(
      'Could not load PDF preview. Is Minnow running locally?',
    );
  }
}

// ── Load ─────────────────────────────────────────────────────────────────────

export function setViewerLoading(_path: string): void {
  primaryRenderKey = null;
  const host = getViewerHost();
  if (host) {
    destroyEditor();
    host.innerHTML = '<p class="file-viewer-status">Loading…</p>';
  }
  const saveBtn = getSaveButton();
  if (saveBtn) saveBtn.disabled = true;
}

export function setViewerError(message: string): void {
  primaryRenderKey = null;
  const host = getViewerHost();
  if (host) {
    destroyEditor();
    host.innerHTML = `<p class="file-viewer-status file-viewer-error">${escapeHtml(message)}</p>`;
  }
  const saveBtn = getSaveButton();
  if (saveBtn) saveBtn.disabled = true;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

interface LoadedFileContent {
  content: string;
  readOnlyExcerpt: boolean;
}

async function loadFileContent(path: string): Promise<LoadedFileContent> {
  const { buildFileTreeToolContext } = await import('./file-tree-listing-root');
  const { parseGetFileMetadataSize, readWorkspaceTextFile } = await import(
    '../attachments/workspace-text-read'
  );
  const toolContext = buildFileTreeToolContext();

  const metaRaw = (await executeTool('get_file_metadata', { path }, toolContext)).content;
  if (metaRaw.startsWith('Error:')) {
    throw new Error(metaRaw.replace(/^Error:\s*/i, '').trim());
  }
  const byteSize = parseGetFileMetadataSize(metaRaw);

  if (byteSize !== null && byteSize > LARGE_FILE_BYTES) {
    const rangeRaw = (
      await executeTool(
        'read_file_range',
        {
          path,
          start_line: 1,
          end_line: RANGE_LINE_COUNT,
        },
        toolContext,
      )
    ).content;
    if (rangeRaw.startsWith('Error:')) {
      throw new Error(rangeRaw.replace(/^Error:\s*/i, '').trim());
    }
    const body = parseReadFileRangeBody(rangeRaw);
    return {
      content: body + buildLargeFileExcerptFooter(byteSize),
      readOnlyExcerpt: true,
    };
  }

  const content = await readWorkspaceTextFile(path, toolContext.workspaceRoot);
  return { content, readOnlyExcerpt: false };
}

/** Load workspace file content for a tab, whichever pane is showing it. */
export async function ensureViewerTabLoaded(path: string): Promise<void> {
  const tab = getViewerTab(path);
  if (!tab || tab.loadStatus !== 'loading' || tab.kind === 'attachment') return;
  if (loadsInFlight.has(path)) return;
  loadsInFlight.add(path);

  if (primarySlotViewerPath() === path) setViewerLoading(path);
  try {
    if (isImageFilePath(path)) {
      setViewerTabLoadState(path, 'ready', { viewMode: 'image' });
      renderViewerSlotsForPath(path);
      return;
    }
    const documentKind = getDocumentPreviewKind(path);
    if (documentKind) {
      setViewerTabLoadState(path, 'ready', {
        viewMode: documentPreviewViewMode(documentKind),
        readOnlyExcerpt: true,
        readOnlyBannerText:
          'Document preview (read-only). Use create_pdf, create_spreadsheet, or create_word_document to generate files.',
      });
      renderViewerSlotsForPath(path);
      return;
    }
    const loaded = await loadFileContent(path);
    const still = getViewerTab(path);
    if (!still || still.loadStatus !== 'loading') return;
    const viewMode = still.viewMode === 'markdown-preview' ? 'markdown-preview' : 'editor';
    setViewerTabLoadState(path, 'ready', {
      content: loaded.content,
      readOnlyExcerpt: loaded.readOnlyExcerpt,
      viewMode,
    });
    renderViewerSlotsForPath(path);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const still = getViewerTab(path);
    if (!still || still.loadStatus !== 'loading') return;
    setViewerTabLoadState(path, 'error', { error: message });
    if (primarySlotViewerPath() === path) {
      setViewerError(message || 'Could not open file');
    } else {
      renderViewerSlotsForPath(path);
    }
  } finally {
    loadsInFlight.delete(path);
  }
}

/** Paint the recent-files empty state when the viewer has no open tabs. */
export function renderViewerEmptyState(): void {
  primaryRenderKey = null;
  const host = getViewerHost();
  if (!host) return;
  destroyEditor();
  renderViewerRecentFilesEmptyState(host);
  updateViewerChrome();
}

/** Remember a workspace file in the empty-state MRU (skip attachments). */
function noteRecentViewerOpen(path: string): void {
  if (isAttachmentViewerPath(path)) return;
  recordRecentViewerFile(path, {
    workspaceRoot: getFileTreeListingWorkspaceRoot(),
  });
}

/** Mount the primary slot's tab in #fileViewerHost (editor, preview, image, loading, error). */
export function renderActiveViewerTab(): void {
  if (splitLayoutEnabled() && primarySlotShowsPreview()) return;

  const tab = primarySlotViewerTab();
  const host = getViewerHost();
  if (!tab || !host) {
    if (!host) {
      destroyEditor();
      updateViewerChrome();
      return;
    }
    if (!primarySlotShowsPreview()) renderViewerEmptyState();
    return;
  }

  if (tab.loadStatus === 'loading') {
    setViewerLoading(tab.path);
    void ensureViewerTabLoaded(tab.path);
    return;
  }

  if (tab.loadStatus === 'error') {
    setViewerError(tab.loadError ?? 'Could not open file');
    return;
  }

  if (primaryRenderIsCurrent(tab)) {
    updateViewerChrome();
    return;
  }
  primaryRenderKey = primaryRenderKeyFor(tab);

  const content = activeTabContent(tab);

  if (tab.viewMode === 'image') {
    if (tab.kind === 'attachment') {
      mountImagePreview(tab, content);
    } else {
      const src = resolvePreviewLoadUrl(
        { kind: 'workspace', path: tab.path },
        undefined,
        getFileTreeListingWorkspaceRoot(),
      );
      mountImagePreview(tab, src, () => {
        setViewerError(
          'Could not load image preview. Is Minnow running locally?',
        );
      });
    }
    return;
  }

  if (tab.viewMode === 'pdf') {
    const src = resolvePreviewLoadUrl(
      { kind: 'workspace', path: tab.path },
      undefined,
      getFileTreeListingWorkspaceRoot(),
    );
    void mountPdfPreview(tab, src);
    return;
  }

  if (tab.viewMode === 'spreadsheet' || tab.viewMode === 'word') {
    const src = resolveDocumentHtmlLoadUrl(
      tab.path,
      undefined,
      getFileTreeListingWorkspaceRoot(),
    );
    const label = tab.viewMode === 'spreadsheet' ? 'Spreadsheet preview' : 'Word document preview';
    mountDocumentHtmlPreview(tab, src, label, () => {
      setViewerError(
        'Could not load document preview. Is Minnow running locally?',
      );
    });
    return;
  }

  if (tab.viewMode === 'markdown-preview') {
    mountMarkdownPreview(tab, content);
    return;
  }

  mountEditor(tab, content);
}

// ── Tabs ─────────────────────────────────────────────────────────────────────

/** Confirm when leaving a dirty active editor tab (Save / Discard / Cancel). */
export async function confirmLeaveDirtyActiveTab(): Promise<boolean> {
  snapshotOutgoingEditorTab();
  const tab = getActiveViewerTab();
  if (!tab?.isDirty) return true;
  const choice = await showViewerUnsavedDialog(
    `You have unsaved changes in "${tab.displayName}".`,
  );
  if (choice === 'cancel') return false;
  if (choice === 'discard') return true;
  return saveViewerTabByPath(tab.path);
}

/** Confirm closing a dirty tab (may be inactive). */
async function confirmCloseDirtyTab(tab: ViewerTabState): Promise<boolean> {
  snapshotOutgoingEditorTab();
  if (!tab.isDirty) return true;
  const choice = await showViewerUnsavedDialog(
    `You have unsaved changes in "${tab.displayName}".`,
  );
  if (choice === 'cancel') return false;
  if (choice === 'discard') return true;
  return saveViewerTabByPath(tab.path);
}

/** Activate a tab inside the slot that owns it. */
async function activateTabAndRender(path: string, options?: { skipUnsavedGuard?: boolean }): Promise<boolean> {
  const slotTabs = await import('./right-pane-slot-tabs');
  const split = await import('./right-pane-split');
  const targetSlot = slotTabs.targetSlotForViewerPath(path);

  const ok = await activateViewerTab(path, {
    skipUnsavedGuard: options?.skipUnsavedGuard,
    confirmUnsaved: confirmLeaveDirtyActiveTab,
    beforeActivate: snapshotOutgoingEditorTab,
  });
  if (!ok) return false;

  if (split.isRightPaneSplitLayoutEnabled()) {
    slotTabs.registerViewerTabOpened(path, targetSlot);
    split.focusPaneSlot(targetSlot);
  }
  showViewerSplit();
  renderViewerSlots();
  renderFileTreeViaBridge();
  return true;
}

/** Close a single tab by path (with unsaved confirm). */
export async function closeViewerTab(path: string): Promise<void> {
  const tab = listViewerTabs().find((t) => t.path === path);
  if (!tab) return;

  if (!(await confirmCloseDirtyTab(tab))) return;

  if (editorViewPath === path) destroyEditor();
  removeViewerTab(path);
  const slotTabs = await import('./right-pane-slot-tabs');
  slotTabs.unregisterViewerTab(path);
  const split = await import('./right-pane-split');
  split.collapseEmptySlots();

  if (listViewerTabs().length === 0) {
    patchFilePanelState({ openViewerTabs: [], activeViewerTab: null, selectedPath: null });
    renderViewerEmptyState();
    if (listPreviewTabs().length > 0) {
      const { showPreviewSplit } = await import('./file-layout');
      showPreviewSplit();
      const nextId = getActivePreviewTabId();
      if (nextId) {
        const preview = await import('./preview-panel');
        await preview.activatePreviewTabGuest(nextId);
      }
    } else {
      hideViewerSplit();
    }
  } else {
    if (split.isRightPaneSplitLayoutEnabled()) {
      const focusPath = slotTabs.activeViewerPathForSlot(split.getFocusedPaneSlot());
      if (focusPath) adoptActiveViewerTabPath(focusPath);
    }
    renderViewerSlots();
  }
  refreshRightTabs();
  renderFileTreeViaBridge();
}

function refreshRightTabs(): void {
  void import('./unified-right-tabs').then((m) => m.refreshUnifiedRightTabs());
}

/** Tabs in the same editor group as `path`, in strip order. */
async function groupTabPathsFor(path: string): Promise<string[]> {
  const split = await import('./right-pane-split');
  const ordered = listViewerTabs().map((t) => t.path);
  if (!split.isRightPaneSplitLayoutEnabled()) return ordered;
  const slotTabs = await import('./right-pane-slot-tabs');
  const slot = slotTabs.slotOwningViewerPath(path);
  if (!slot) return [path];
  const owned = new Set(slotTabs.viewerPathsForSlot(slot));
  return ordered.filter((p) => owned.has(p));
}

/** Close a set of tabs with a per-tab dirty guard; aborts entirely on cancel. */
async function closeViewerTabPaths(paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  for (const p of paths) {
    const tab = getViewerTab(p);
    if (tab && !(await confirmCloseDirtyTab(tab))) return;
  }
  const slotTabs = await import('./right-pane-slot-tabs');
  for (const p of paths) {
    if (editorViewPath === p) destroyEditor();
    removeViewerTab(p);
    slotTabs.unregisterViewerTab(p);
  }
  const split = await import('./right-pane-split');
  split.collapseEmptySlots();

  if (listViewerTabs().length === 0 && listPreviewTabs().length === 0) {
    hideViewerSplit();
  }
  invalidatePrimaryViewerRender();
  renderViewerSlots();
  refreshRightTabs();
  renderFileTreeViaBridge();
}

/** Close every tab in the same group except the given path. */
export async function closeOtherViewerTabsUi(keepPath: string): Promise<void> {
  const group = await groupTabPathsFor(keepPath);
  await closeViewerTabPaths(group.filter((p) => p !== keepPath));
}

/** Close tabs to the right of the given path within its group. */
export async function closeViewerTabsToRightUi(path: string): Promise<void> {
  const group = await groupTabPathsFor(path);
  const idx = group.indexOf(path);
  if (idx < 0) return;
  await closeViewerTabPaths(group.slice(idx + 1));
}

/** Close all open tabs (with per-tab dirty guard). */
export async function closeAllViewerTabsUi(): Promise<void> {
  for (const tab of [...listViewerTabs()]) {
    if (!(await confirmCloseDirtyTab(tab))) return;
  }
  resetAllViewerTabs();
}

/** Cycle to the next or previous tab within the focused group. */
export async function cycleViewerTab(direction: 'next' | 'prev'): Promise<void> {
  const activePath = getActiveViewerTabPath();
  if (!activePath) return;
  const group = await groupTabPathsFor(activePath);
  if (group.length < 2) return;
  const idx = group.indexOf(activePath);
  if (idx < 0) return;
  const nextIdx =
    direction === 'next' ? (idx + 1) % group.length : (idx - 1 + group.length) % group.length;
  await activateTabAndRender(group[nextIdx]!);
}

// ── Save ─────────────────────────────────────────────────────────────────────

/** Persist one tab via save_file, from whichever pane holds its live buffer. */
export async function saveViewerTabByPath(path: string): Promise<boolean> {
  snapshotOutgoingEditorTab();
  const tab = getViewerTab(path);
  if (!tab || tab.readOnlyExcerpt || isSaving) return false;
  if (!tab.isDirty) return true;

  const content = tab.cachedEditorContent ?? tab.originalContent;
  let contentToSave = content;
  try {
    const { fetchLspConfig } = await import('../lsp/config-client');
    const { languageIdForPath } = await import('../lsp/language-id');
    const { formatTextForSave } = await import('./lsp-editor/format-document');
    const lspCfg = await fetchLspConfig();
    if (lspCfg) {
      contentToSave = await formatTextForSave(
        tab.path,
        content,
        lspCfg.formatOnSaveLanguageIds ?? [],
        languageIdForPath(tab.path),
      );
    }
  } catch {
  }
  isSaving = true;
  updateViewerChrome();

  try {
    const { buildFileTreeToolContext } = await import('./file-tree-listing-root');
    const raw = (
      await executeTool('save_file', { path: tab.path, content: contentToSave }, buildFileTreeToolContext())
    ).content;
    if (raw.startsWith('Error:')) {
      throw new Error(raw.replace(/^Error:\s*/i, '').trim());
    }
    markViewerTabSaved(tab.path, contentToSave);
    if (lspSyncedPath === tab.path) {
      void notifyLspDocument(tab.path, 'change', contentToSave);
    }
    const { emitFileSaved } = await import('../state/preview-events');
    emitFileSaved(tab.path);
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await appAlert(message || 'Could not save file');
    return false;
  } finally {
    isSaving = false;
    updateViewerChrome();
    refreshRightTabs();
  }
}

/** Save the primary pane's file (header Save button and its Ctrl+S). */
export async function saveCurrentFile(): Promise<boolean> {
  const path = editorViewPath ?? primarySlotViewerPath();
  if (!path) return false;
  return saveViewerTabByPath(path);
}

/** Save the file in the focused pane (global Ctrl+S). */
export async function saveFocusedViewerTab(): Promise<boolean> {
  const path = getActiveViewerTabPath() ?? primarySlotViewerPath();
  if (!path) return false;
  return saveViewerTabByPath(path);
}

/** Switch the open markdown file from preview to the editable code editor. */
export function switchMarkdownViewerToCode(): void {
  const tab = primarySlotViewerTab();
  if (!tab || !isMarkdownFilePath(tab.path) || tab.viewMode !== 'markdown-preview') return;
  tab.viewMode = 'editor';
  tab.cachedEditorContent = tab.originalContent;
  renderActiveViewerTab();
}

/** Switch the open markdown file from the code editor to GFM preview. */
export async function switchMarkdownViewerToPreview(): Promise<void> {
  const tab = primarySlotViewerTab();
  if (!tab || !isMarkdownFilePath(tab.path) || !editorView) return;
  if (tab.isDirty) {
    const choice = await showViewerUnsavedDialog(
      `You have unsaved changes in "${tab.displayName}".`,
    );
    if (choice === 'cancel') return;
    if (choice === 'save') {
      const saved = await saveViewerTabByPath(tab.path);
      if (!saved) return;
    }
  }
  const content = normalizeViewerDocText(editorView.state.doc.toString());
  tab.originalContent = content;
  tab.cachedEditorContent = content;
  tab.isDirty = false;
  tab.viewMode = 'markdown-preview';
  renderActiveViewerTab();
}

/** Wire Save button and tab handlers (call once from init-file-panel). */
export function bindFileViewerControls(): void {
  if (viewerControlsBound) return;
  viewerControlsBound = true;

  registerFileViewerTabHandlers({
    onActivate: (path) => {
      void activateTabAndRender(path);
    },
    onClose: (path) => {
      void closeViewerTab(path);
    },
    onCloseOthers: (path) => {
      void closeOtherViewerTabsUi(path);
    },
    onCloseToRight: (path) => {
      void closeViewerTabsToRightUi(path);
    },
    onCloseAll: () => {
      void closeAllViewerTabsUi();
    },
    onCycle: (direction) => {
      void cycleViewerTab(direction);
    },
  });

  setLspDiagnosticsChromeListener((counts) => {
    updateDiagnosticsChrome({ errors: counts.errors, warnings: counts.warnings });
  });

  const saveBtn = getSaveButton();
  if (saveBtn) {
    saveBtn.addEventListener('click', () => {
      void saveCurrentFile();
    });
  }

  const secondarySaveBtn = getSecondarySaveButton();
  if (secondarySaveBtn) {
    secondarySaveBtn.addEventListener('click', () => {
      const path = secondarySlotViewerPath();
      if (path) void saveViewerTabByPath(path);
    });
  }

  editorIntentToggleEl = getIntentToggleButton();
  if (editorIntentToggleEl) {
    editorIntentToggleEl.addEventListener('click', () => {
      if (!editorView || !getLocalServerAvailable()) return;
      toggleIntentMode(editorView);
    });
  }

  const secondaryIntentBtn = getSecondaryIntentToggleButton();
  if (secondaryIntentBtn) {
    secondaryIntentBtn.addEventListener('click', () => {
      if (!getLocalServerAvailable()) return;
      void import('./file-viewer-secondary-slot').then((m) => {
        const view = m.getSecondaryViewerEditorView();
        if (!view) return;
        toggleIntentMode(view);
        syncSecondaryIntentToolbarChrome(isIntentEnabled(view.state));
      });
    });
  }

  const closeBtn = document.getElementById('btnFileViewerClose');
  if (closeBtn) {
    closeBtn.setAttribute('aria-label', 'Hide panel');
    closeBtn.setAttribute('title', 'Hide panel');
  }

  window.addEventListener(EDITOR_AI_CONFIG_CHANGED_EVENT, () => {
    void (async () => {
      await loadEditorAiCompletionConfig();
      const tab = primarySlotViewerTab();
      if (tab?.viewMode === 'editor' && tab.loadStatus === 'ready' && editorView && editorAiOpts) {
        reconfigureEditorSuggestions(editorView, editorAiOpts);
      }
      void import('./file-viewer-secondary-slot').then((m) => {
        m.reconfigureSecondaryEditorSuggestions();
      });
      const config = getEditorAiCompletionConfigSync();
      if (config.enabled && getLocalServerAvailable()) {
        attachEditorAiModelSelectListener();
      } else {
        detachEditorAiModelSelectListener();
      }
    })();
  });
}

/** Right-click on the viewer: selection → chat / quick edit; markdown preview toggles. */
export function bindFileViewerContextMenu(): void {
  if (viewerContextMenuBound) return;
  const host = getViewerHost();
  if (!host) return;
  viewerContextMenuBound = true;

  host.addEventListener('contextmenu', (e) => {
    const tab = primarySlotViewerTab();
    if (!tab) return;

    const hasEditorSelection = Boolean(
      editorView &&
        !tab.readOnlyExcerpt &&
        tab.viewMode === 'editor' &&
        !editorView.state.selection.main.empty,
    );
    const isMarkdown = isMarkdownFilePath(tab.path);
    const isPreview = isMarkdownPreviewActive();

    if (!hasEditorSelection && !isMarkdown) return;

    e.preventDefault();

    const selectionTarget = hasEditorSelection && editorView
      ? (() => {
          const sel = editorView.state.selection.main;
          const { fromLine, toLine } = lineNumbersForRange(
            editorView.state.doc,
            sel.from,
            sel.to,
          );
          return {
            kind: CAPTURE_MENU_KINDS.editorSelection,
            path: tab.path,
            startLine: fromLine,
            endLine: toLine,
            text: editorView.state.doc.sliceString(sel.from, sel.to),
          };
        })()
      : null;

    const items = buildFileViewerContextMenuItems({
      path: tab.path,
      hasEditorSelection,
      captureItems: selectionTarget ? legacyCaptureMenuItems(selectionTarget) : undefined,
      isMarkdown,
      isMarkdownPreview: isPreview,
      onAddSelectionToChat: () => {
        if (!editorView || tab.readOnlyExcerpt) return;
        const sel = editorView.state.selection.main;
        const text = editorView.state.doc.sliceString(sel.from, sel.to);
        const { fromLine, toLine } = lineNumbersForRange(
          editorView.state.doc,
          sel.from,
          sel.to,
        );
        addCodeReferenceToComposer({
          workspacePath: tab.path,
          startLine: fromLine,
          endLine: toLine,
          text,
        });
      },
      onQuickEdit: () => {
        if (!editorView || tab.readOnlyExcerpt) return;
        openQuickEditPanel(editorView, tab.path);
      },
      onLinkToIssue: () => {
        if (!editorView || tab.readOnlyExcerpt) return;
        const sel = editorView.state.selection.main;
        const text = editorView.state.doc.sliceString(sel.from, sel.to);
        const { fromLine, toLine } = lineNumbersForRange(
          editorView.state.doc,
          sel.from,
          sel.to,
        );
        void import('./issue-link-from-editor').then((m) => {
          void m.linkSelectionToIssue({
            path: tab.path,
            startLine: fromLine,
            endLine: toLine,
            text,
          });
        });
      },
      onSwitchToCode: () => switchMarkdownViewerToCode(),
      onSwitchToPreview: () => {
        void switchMarkdownViewerToPreview();
      },
    });

    if (items.length === 0) return;
    showFilePanelContextMenu(items, e.clientX, e.clientY);
  });
}

// ── Open ─────────────────────────────────────────────────────────────────────

/** Active CodeMirror view when the code editor (not markdown preview) is mounted. */
export function getFileViewerEditorView(): EditorView | null {
  return editorView;
}

export interface OpenFileInViewerOptions {
  skipUnsavedGuard?: boolean;
  asCode?: boolean;
  initialSelection?: { line: number; character: number };
  initialLineRange?: { startLine: number; endLine: number };
}

function openTabOptionsFromViewerOptions(
  options?: OpenFileInViewerOptions,
): OpenViewerTabOptions {
  return {
    skipUnsavedGuard: options?.skipUnsavedGuard,
    asCode: options?.asCode,
    initialSelection: options?.initialSelection,
    initialLineRange: options?.initialLineRange,
    viewMode: undefined,
  };
}

/** Open inlined chat attachment text in a read-only editor pane. */
export async function openAttachmentSnapshotInViewer(displayName: string, content: string): Promise<void> {
  const safeName = displayName.replace(/[/\\]/g, '_') || 'attachment';
  const path = `.minnow/attachments/${safeName}`;

  const result = await openViewerTab(path, {
    kind: 'attachment',
    displayName,
    content,
    readOnlyExcerpt: true,
    readOnlyBannerText: 'Chat attachment snapshot (read-only; not saved to the project).',
    viewMode: shouldUseMarkdownPreview(path) ? 'markdown-preview' : 'editor',
    confirmUnsaved: confirmLeaveDirtyActiveTab,
    skipUnsavedGuard: false,
    beforeActivate: snapshotOutgoingEditorTab,
  });
  if (!result) return;

  await adoptOpenedViewerTab(path);
  showViewerSplit();
  renderViewerSlots();
  renderFileTreeViaBridge();
}

/** Route a freshly opened tab into one pane: the pane that already owns it, else the focused one. */
async function adoptOpenedViewerTab(path: string): Promise<void> {
  const split = await import('./right-pane-split');
  if (!split.isRightPaneSplitLayoutEnabled()) return;
  const slotTabs = await import('./right-pane-slot-tabs');
  const slot = slotTabs.registerViewerTabOpened(path);
  split.focusPaneSlot(slot);
}

/** Open a workspace image via the preview file API (binary-safe). */
export async function openWorkspaceImageInViewer(relativePath: string): Promise<void> {
  const result = await openViewerTab(relativePath, {
    viewMode: 'image',
    readOnlyExcerpt: true,
    readOnlyBannerText: 'Workspace image (read-only preview).',
    content: '',
    confirmUnsaved: confirmLeaveDirtyActiveTab,
    beforeActivate: snapshotOutgoingEditorTab,
  });
  if (!result) return;
  noteRecentViewerOpen(relativePath);
  await adoptOpenedViewerTab(relativePath);
  showViewerSplit();
  renderViewerSlots();
  renderFileTreeViaBridge();
}

/** Open an image data URL from a chat attachment in the viewer pane. */
export async function openImageDataUrlInViewer(displayName: string, dataUrl: string): Promise<void> {
  const safeName = displayName.replace(/[/\\]/g, '_') || 'image';
  const path = `.minnow/attachments/${safeName}`;

  const result = await openViewerTab(path, {
    kind: 'attachment',
    displayName,
    content: dataUrl,
    viewMode: 'image',
    readOnlyExcerpt: true,
    readOnlyBannerText: 'Chat image attachment (read-only preview).',
    confirmUnsaved: confirmLeaveDirtyActiveTab,
    beforeActivate: snapshotOutgoingEditorTab,
  });
  if (!result) return;
  await adoptOpenedViewerTab(path);
  showViewerSplit();
  renderViewerSlots();
  renderFileTreeViaBridge();
}

/** Open a project file in the split viewer. */
export async function openFileInViewer(
  relativePath: string,
  options?: OpenFileInViewerOptions,
): Promise<void> {
  if (window.minnow?.viewContext?.appId) {
    const { routeCodeWindowCommand } = await import('../os/code-window-command');
    const { getWorkspacePath } = await import('../state/workspace');
    if (await routeCodeWindowCommand({ kind: 'file', path: relativePath, workspacePath: getFileTreeListingWorkspaceRoot() || getWorkspacePath() })) return;
  }
  if (isImageFilePath(relativePath)) {
    openWorkspaceImageInViewer(relativePath);
    return;
  }

  const documentKind = getDocumentPreviewKind(relativePath);
  if (documentKind) {
    const result = await openViewerTab(relativePath, {
      ...openTabOptionsFromViewerOptions(options),
      viewMode: documentPreviewViewMode(documentKind),
      readOnlyExcerpt: true,
      readOnlyBannerText:
        'Document preview (read-only). Use create_pdf, create_spreadsheet, or create_word_document to generate files.',
      confirmUnsaved: options?.skipUnsavedGuard ? undefined : confirmLeaveDirtyActiveTab,
      skipUnsavedGuard: options?.skipUnsavedGuard,
      beforeActivate: snapshotOutgoingEditorTab,
    });

    if (!result) {
      if (listViewerTabs().length >= MAX_OPEN_VIEWER_TABS) {
        setStatus('err', `At most ${MAX_OPEN_VIEWER_TABS} files can be open in the viewer.`);
      }
      return;
    }

    noteRecentViewerOpen(relativePath);
    await adoptOpenedViewerTab(relativePath);
    showViewerSplit();

    renderFileTreeViaBridge();
    result.tab.loadStatus = 'loading';
    renderViewerSlots();
    return;
  }

  const viewMode = shouldUseMarkdownPreview(relativePath, options?.asCode)
    ? 'markdown-preview'
    : 'editor';

  const result = await openViewerTab(relativePath, {
    ...openTabOptionsFromViewerOptions(options),
    viewMode,
    confirmUnsaved: options?.skipUnsavedGuard ? undefined : confirmLeaveDirtyActiveTab,
    skipUnsavedGuard: options?.skipUnsavedGuard,
    beforeActivate: snapshotOutgoingEditorTab,
  });

  if (!result) {
    if (listViewerTabs().length >= MAX_OPEN_VIEWER_TABS) {
      setStatus('err', `At most ${MAX_OPEN_VIEWER_TABS} files can be open in the viewer.`);
    }
    return;
  }

  noteRecentViewerOpen(relativePath);
  await adoptOpenedViewerTab(relativePath);
  showViewerSplit();

  renderFileTreeViaBridge();

  if (result.focusedExisting && result.tab.loadStatus === 'ready') {
    renderViewerSlots();
    return;
  }

  result.tab.loadStatus = 'loading';
  renderViewerSlots();
}

/** Restore persisted workspace tabs after boot (active tab loads first). */
export async function restoreViewerTabsFromPrefs(
  paths: string[],
  activePath: string | null,
): Promise<void> {
  if (paths.length === 0) return;
  restoreWorkspaceViewerTabs(paths, activePath);
  const split = await import('./right-pane-split');
  split.reconcileRightPaneSlots();
  showViewerSplit();
  renderFileTreeViaBridge();
  renderViewerSlots();
}

function resetAllViewerTabs(options?: { closeSplit?: boolean }): void {
  clearAllViewerTabs();
  renderViewerEmptyState();
  const saveBtn = getSaveButton();
  if (saveBtn) saveBtn.disabled = true;
  if (options?.closeSplit !== false) {
    hideViewerSplit({ skipPreviewFallback: true });
  } else {
    hideViewerPaneDom();
  }
  renderFileTreeViaBridge();
}

// ── Close ────────────────────────────────────────────────────────────────────

/** Close the primary pane's tab (its header close button); hide split when none remain. */
export function closeFileViewer(): void {
  const path = primarySlotViewerPath();
  if (!path) return;
  void closeViewerTab(path);
}

/** Confirm leaving the active file tab when switching to browser preview (tabs stay open). */
export async function dismissFileViewerForPreview(): Promise<boolean> {
  if (getFilePanelState().rightPaneMode !== 'viewer') return true;
  const active = getActiveViewerTab();
  if (!active?.isDirty) return true;
  return confirmLeaveDirtyActiveTab();
}

/** Close all tabs without unsaved prompt (paths removed on disk). */
export function closeFileViewerForce(): void {
  resetAllViewerTabs();
}

/** Update open path after rename/move without reloading editor content. */
export function retargetOpenViewerPath(newPath: string): void {
  const active = getActiveViewerTabPath();
  if (!active) return;
  retargetViewerTab(active, newPath);
  void import('./right-pane-slot-tabs').then((m) => {
    m.retargetSlotViewerPath(active, newPath);
    invalidatePrimaryViewerRender();
    renderViewerSlots();
  });
  renderFileTreeViaBridge();
}

export function getOpenViewerPath(): string | null {
  return getActiveViewerTabPath();
}

export function isFileViewerDirty(): boolean {
  const tab = getActiveViewerTab();
  return tab?.isDirty ?? false;
}

export { getOpenViewerTabPaths, isViewerTabDirty };

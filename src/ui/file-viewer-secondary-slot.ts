import { EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { setAssistantBubbleContent } from '../markdown/renderer';
import { scrollMarkdownHeading, takePendingMarkdownHeading } from '../markdown/links';
import {
  getViewerTab,
  isViewerDocDirty,
  snapshotViewerTabEditorContent,
  type ViewerTabState,
} from './file-viewer-tab-store';
import { editorCoreExtensions } from './editor-core-extensions';
import { loadEditorSettings } from '../config/editor-settings';
import {
  getEditorIntentModeConfigSync,
  loadEditorIntentModeConfig,
} from '../config/editor-intent-mode';
import { getEditorAiCompletionConfigSync } from '../config/editor-ai-completion';
import { loadLanguageExtensionsForPath } from './editor-language';
import { minnowEditorExtensions } from './codemirror-theme';
import { notifyLspDocument } from '../lsp/completion-client';
import { resolveDocumentHtmlLoadUrl, resolvePreviewLoadUrl } from './preview-load-url';
import { getFileTreeListingWorkspaceRoot } from './file-tree-listing-root';
import { getLocalServerAvailable } from '../tools/client';
import {
  editorSuggestionBaseExtensions,
  editorSuggestionCompartmentExtension,
  editorSuggestionExtensions,
  mountEditorSuggestions,
  reconfigureEditorSuggestions,
  type EditorSuggestionOptions,
} from './editor-suggestions';
import {
  ensureViewerTabLoaded,
  isIntentModeEnabledForViewerPath,
  isLspEnabledForViewer,
  rememberIntentModeEnabledForPath,
  registerSecondaryEditorSnapshot,
  saveViewerTabByPath,
  syncSecondaryIntentBusyChrome,
  syncSecondaryIntentToolbarChrome,
  updateSecondaryViewerChrome,
} from './file-viewer';
import { codeSelectionDragExtension } from './editor-code-selection-drag';
import { editorGitDiffExtensions } from './editor-git-diff';

let secondaryView: EditorView | null = null;
let secondaryPath: string | null = null;
let lspTimer: ReturnType<typeof setTimeout> | null = null;
/** Path currently open in LSP from the secondary editor (when LSP is enabled). */
let secondaryLspSyncedPath: string | null = null;
/** Live suggestion options for hot-reload without remounting the secondary editor. */
let secondaryEditorAiOpts: EditorSuggestionOptions | null = null;
/** What the secondary host is painting — guards against remounting on every layout pass. */
let renderKey: string | null = null;
let pendingMountPath: string | null = null;
let mountGeneration = 0;
let snapshotHookBound = false;

// ── Snapshot ─────────────────────────────────────────────────────────────────

function getHost(): HTMLElement | null {
  return document.getElementById('fileViewerHostSecondary');
}

/** Persist the live secondary buffer into its tab (unsaved guard + save read this). */
export function snapshotSecondaryEditorTab(): void {
  if (!secondaryView || !secondaryPath) return;
  const tab = getViewerTab(secondaryPath);
  if (!tab || tab.viewMode === 'image') return;
  const text = secondaryView.state.doc.toString();
  const dirty = !tab.readOnlyExcerpt && isViewerDocDirty(text, tab.originalContent);
  snapshotViewerTabEditorContent(secondaryPath, text, dirty);
}

/** Reflect format-on-save only while this pane still shows the submitted buffer. */
export function applySavedContentToSecondaryEditor(
  tab: ViewerTabState,
  submittedContent: string,
  savedContent: string,
): void {
  if (secondaryPath !== tab.path || getViewerTab(tab.path) !== tab ||
      secondaryView?.state.doc.toString() !== submittedContent) return;
  secondaryView.dispatch({
    changes: { from: 0, to: secondaryView.state.doc.length, insert: savedContent },
  });
}

function bindSnapshotHook(): void {
  if (snapshotHookBound) return;
  snapshotHookBound = true;
  registerSecondaryEditorSnapshot(snapshotSecondaryEditorTab);
}

// ── LSP ──────────────────────────────────────────────────────────────────────

function clearSecondaryLspChangeTimer(): void {
  if (lspTimer) {
    clearTimeout(lspTimer);
    lspTimer = null;
  }
}

function closeSecondaryLspDocument(): void {
  clearSecondaryLspChangeTimer();
  if (secondaryLspSyncedPath) {
    void notifyLspDocument(secondaryLspSyncedPath, 'close');
    secondaryLspSyncedPath = null;
  }
}

function scheduleSecondaryLspChangeNotify(path: string, text: string): void {
  if (secondaryLspSyncedPath !== path) return;
  clearSecondaryLspChangeTimer();
  lspTimer = setTimeout(() => {
    void notifyLspDocument(path, 'change', text);
  }, 400);
}

function destroySecondaryEditor(): void {
  closeSecondaryLspDocument();
  secondaryEditorAiOpts = null;
  if (secondaryView) {
    snapshotSecondaryEditorTab();
    secondaryView.destroy();
    secondaryView = null;
  }
  secondaryPath = null;
  pendingMountPath = null;
}

/** Tear down the secondary editor (split closed or slot cleared). */
export function destroySecondaryViewerSlot(): void {
  destroySecondaryEditor();
  renderKey = null;
  const host = getHost();
  if (host) host.replaceChildren();
  updateSecondaryViewerChrome();
}

// ── Mount ────────────────────────────────────────────────────────────────────

function renderKeyFor(tab: ViewerTabState): string {
  return `${tab.path}::${tab.viewMode}::${tab.loadStatus}`;
}

function renderIsCurrent(tab: ViewerTabState): boolean {
  if (renderKey !== renderKeyFor(tab)) return false;
  const host = getHost();
  if (!host || host.childElementCount === 0) return false;
  if (tab.viewMode === 'editor') {
    return (secondaryView !== null && secondaryPath === tab.path) || pendingMountPath === tab.path;
  }
  return true;
}

function showMessage(host: HTMLElement, message: string, isError = false): void {
  destroySecondaryEditor();
  const p = document.createElement('p');
  p.className = isError
    ? 'file-viewer-status file-viewer-error'
    : 'file-viewer-status';
  p.textContent = message;
  host.replaceChildren(p);
}

function appendReadOnlyBanner(host: HTMLElement, tab: ViewerTabState): void {
  if (!tab.readOnlyExcerpt) return;
  const banner = document.createElement('p');
  banner.className = 'file-viewer-readonly-banner';
  banner.textContent = tab.readOnlyBannerText ?? 'Read-only preview.';
  host.appendChild(banner);
}

function mountMarkdown(host: HTMLElement, tab: ViewerTabState, content: string): void {
  destroySecondaryEditor();
  host.replaceChildren();
  appendReadOnlyBanner(host, tab);
  const preview = document.createElement('div');
  preview.className = 'file-viewer-markdown-preview msg-bubble msg-bubble--md';
  // Relative markdown links resolve against this file, not the SPA origin.
  preview.dataset.mdSourcePath = tab.path;
  host.appendChild(preview);
  setAssistantBubbleContent(preview, content, { streaming: false });
  const headingId = takePendingMarkdownHeading(tab.path);
  if (headingId) scrollMarkdownHeading(preview, headingId);
}

function mountImage(host: HTMLElement, tab: ViewerTabState, content: string): void {
  destroySecondaryEditor();
  host.replaceChildren();
  appendReadOnlyBanner(host, tab);
  const figure = document.createElement('figure');
  figure.className = 'file-viewer-image-preview';
  const img = document.createElement('img');
  img.src =
    tab.kind === 'attachment'
      ? content
      : resolvePreviewLoadUrl(
          { kind: 'workspace', path: tab.path },
          undefined,
          getFileTreeListingWorkspaceRoot(),
        );
  img.alt = tab.displayName;
  figure.appendChild(img);
  host.appendChild(figure);
}

function mountDocumentPreview(host: HTMLElement, tab: ViewerTabState): void {
  destroySecondaryEditor();
  host.replaceChildren();
  appendReadOnlyBanner(host, tab);
  const frame = document.createElement('iframe');
  frame.className = 'file-viewer-document-preview';
  frame.title = `${tab.displayName} preview`;
  frame.setAttribute('sandbox', '');
  frame.src =
    tab.viewMode === 'pdf'
      ? resolvePreviewLoadUrl(
          { kind: 'workspace', path: tab.path },
          undefined,
          getFileTreeListingWorkspaceRoot(),
        )
      : resolveDocumentHtmlLoadUrl(tab.path, undefined, getFileTreeListingWorkspaceRoot());
  host.appendChild(frame);
}

function mountEditor(host: HTMLElement, tab: ViewerTabState, content: string): void {
  const generation = ++mountGeneration;
  destroySecondaryEditor();
  host.replaceChildren();
  appendReadOnlyBanner(host, tab);

  const mount = document.createElement('div');
  mount.className = 'file-viewer-editor-mount';
  host.appendChild(mount);

  const aiStatus = document.createElement('p');
  aiStatus.className = 'file-viewer-ai-status field-hint';
  aiStatus.hidden = true;
  host.appendChild(aiStatus);

  const path = tab.path;
  pendingMountPath = path;

  void (async () => {
    const [editorSettings, langExts, useLsp, intentConfig] = await Promise.all([
      loadEditorSettings(),
      loadLanguageExtensionsForPath(path),
      isLspEnabledForViewer(),
      loadEditorIntentModeConfig(),
    ]);
    const intentInitialEnabled = isIntentModeEnabledForViewerPath(
      path,
      intentConfig.enabledByDefault,
    );
    const canMountEditorAi = !tab.readOnlyExcerpt && getLocalServerAvailable();
    secondaryEditorAiOpts = canMountEditorAi
      ? {
          filePath: path,
          getConfig: getEditorAiCompletionConfigSync,
          getIntentConfig: getEditorIntentModeConfigSync,
          canRequest: () => getLocalServerAvailable(),
          onStatus: (message) => {
            if (!aiStatus.isConnected) return;
            if (message) {
              aiStatus.textContent = message;
              aiStatus.hidden = false;
            } else {
              aiStatus.hidden = true;
            }
          },
          onIntentEnabledChange: (enabled) => {
            rememberIntentModeEnabledForPath(path, enabled);
            syncSecondaryIntentToolbarChrome(enabled);
          },
          onIntentBusyChange: (busy) => {
            syncSecondaryIntentBusyChrome(busy);
          },
        }
      : null;
    const aiExts =
      canMountEditorAi && secondaryEditorAiOpts
        ? [
            ...editorSuggestionBaseExtensions(),
            editorSuggestionCompartmentExtension(
              editorSuggestionExtensions(secondaryEditorAiOpts),
            ),
          ]
        : [];
    const state = EditorState.create({
      doc: content,
      extensions: [
        lineNumbers(),
        ...editorGitDiffExtensions(tab.gitDiff),
        EditorState.readOnly.of(tab.readOnlyExcerpt),
        EditorView.editable.of(!tab.readOnlyExcerpt),
        ...editorCoreExtensions({
          wordWrap: editorSettings.wordWrap,
          tabSize: editorSettings.tabSize,
          renderWhitespace: editorSettings.renderWhitespace,
        }),
        keymap.of([
          {
            key: 'Mod-s',
            run: () => {
              snapshotSecondaryEditorTab();
              void saveViewerTabByPath(path);
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
        ...aiExts,
        ...(tab.readOnlyExcerpt ? [] : [codeSelectionDragExtension(path)]),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged || secondaryPath !== path) return;
          const text = update.state.doc.toString();
          const liveTab = getViewerTab(path);
          if (!liveTab || liveTab.readOnlyExcerpt) return;
          snapshotViewerTabEditorContent(
            path,
            text,
            isViewerDocDirty(text, liveTab.originalContent),
          );
          updateSecondaryViewerChrome();
          if (useLsp) {
            scheduleSecondaryLspChangeNotify(path, text);
          }
        }),
      ],
    });
    if (generation !== mountGeneration || !mount.isConnected) return;
    if (pendingMountPath === path) pendingMountPath = null;
    secondaryPath = path;
    secondaryView = new EditorView({ state, parent: mount });
    if (aiExts.length > 0) {
      mountEditorSuggestions(secondaryView, intentInitialEnabled);
    }
    if (useLsp) {
      secondaryLspSyncedPath = path;
      void notifyLspDocument(path, 'open', content);
    }
    updateSecondaryViewerChrome();
  })();
}

// ── Render ───────────────────────────────────────────────────────────────────

/** Mount the secondary slot's active tab (loads content on demand). */
export function renderSecondaryViewerSlot(tabPath: string | null): void {
  bindSnapshotHook();
  const host = getHost();
  if (!host) return;

  if (!tabPath) {
    destroySecondaryViewerSlot();
    showMessage(host, 'Open a file in this pane');
    return;
  }

  const tab = getViewerTab(tabPath);
  if (!tab) {
    destroySecondaryViewerSlot();
    showMessage(host, 'Open a file in this pane');
    return;
  }

  if (tab.loadStatus === 'loading') {
    if (secondaryPath !== tabPath) destroySecondaryEditor();
    renderKey = null;
    showMessage(host, 'Loading…');
    void ensureViewerTabLoaded(tabPath);
    return;
  }

  if (tab.loadStatus === 'error') {
    renderKey = null;
    showMessage(host, tab.loadError ?? 'Could not open file', true);
    return;
  }

  if (renderIsCurrent(tab)) return;
  renderKey = renderKeyFor(tab);

  const content = tab.cachedEditorContent ?? tab.originalContent;

  if (tab.viewMode === 'image') {
    mountImage(host, tab, content);
    return;
  }
  if (tab.viewMode === 'pdf' || tab.viewMode === 'spreadsheet' || tab.viewMode === 'word') {
    mountDocumentPreview(host, tab);
    return;
  }
  if (tab.viewMode === 'markdown-preview') {
    mountMarkdown(host, tab, content);
    return;
  }
  mountEditor(host, tab, content);
  updateSecondaryViewerChrome();
}

/** Live CodeMirror view of the secondary group, when one is mounted. */
export function getSecondaryViewerEditorView(): EditorView | null {
  return secondaryView;
}

/** Hot-reload editor AI / Intent settings on the secondary CodeMirror view. */
export function reconfigureSecondaryEditorSuggestions(): void {
  if (!secondaryView || !secondaryEditorAiOpts) return;
  reconfigureEditorSuggestions(secondaryView, secondaryEditorAiOpts);
}

/** Test helper — drop cached render identity so the next render remounts. */
export function invalidateSecondaryViewerRender(): void {
  renderKey = null;
}

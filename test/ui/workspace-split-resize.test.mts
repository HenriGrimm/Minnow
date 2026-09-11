import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import {
  patchFilePanelState,
  resetFilePanelStateForTests,
} from '../../src/state/file-panel.ts';
import {
  applyFileSidebarVisuals,
  collapseChatColumnFromDrag,
  isChatColumnDragCollapsed,
  resetChatColumnDragCollapsedForTests,
  restoreChatColumnFromDrag,
  toggleRightPaneFullWidth,
  showPreviewSplit,
  showViewerSplit,
  hideViewerSplit,
} from '../../src/ui/file-layout.ts';
import { restoreChatColumnOnChatSelect } from '../../src/ui/workspace-split-resize.ts';

function setupSplitDom(): void {
  document.body.innerHTML = `
    <div id="workspaceSplit" class="workspace-split">
      <div class="main-column" id="mainColumn"></div>
      <div id="splitResizer" class="split-resizer"></div>
      <div id="rightPaneColumn" class="right-pane-column">
        <header id="unifiedTabBar"><div id="unifiedTabs"></div></header>
        <section id="fileViewerPane" class="file-viewer-pane hidden"></section>
        <section id="previewPane" class="preview-pane"></section>
        <button id="btnPreviewFullWidth" type="button" aria-pressed="false"></button>
        <button id="btnPreviewFullWidthSecondary" type="button" aria-pressed="false"></button>
      </div>
    </div>
    <aside id="fileSidebar">
      <button id="btnFileSidebarCollapse" type="button"></button>
      <button id="btnPreviewToggle" type="button"></button>
    </aside>
  `;
}

describe('workspace split drag collapse', () => {
  beforeEach(async () => {
    const { Window } = await import('happy-dom');
    const win = new Window();
    const g = globalThis as typeof globalThis & {
      window: Window;
      document: Document;
      HTMLElement: typeof HTMLElement;
    };
    g.window = win as unknown as Window & typeof globalThis.window;
    g.document = win.document;
    g.HTMLElement = win.HTMLElement;
    win.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
      onchange: null,
    })) as typeof window.matchMedia;
    resetFilePanelStateForTests();
    resetChatColumnDragCollapsedForTests();
    setupSplitDom();
  });

  afterEach(() => {
    resetFilePanelStateForTests();
    resetChatColumnDragCollapsedForTests();
  });

  test('collapseChatColumnFromDrag keeps preview open at full width', () => {
    patchFilePanelState({
      rightPaneMode: 'preview',
      viewerOpen: true,
      previewTabs: [{ id: 'tab-1', source: { kind: 'url', url: 'https://example.com' } }],
      activePreviewTab: 'tab-1',
    });
    applyFileSidebarVisuals();

    collapseChatColumnFromDrag();

    const split = document.getElementById('workspaceSplit');
    assert.equal(isChatColumnDragCollapsed(), true);
    assert.equal(split?.classList.contains('chat-column-collapsed'), true);
    assert.equal(split?.classList.contains('viewer-open'), true);
    assert.equal(document.getElementById('rightPaneColumn')?.classList.contains('hidden'), false);
    assert.equal(document.getElementById('previewPane')?.classList.contains('hidden'), false);
    assert.equal(patchFilePanelState({}).rightPaneMode, 'preview');
    assert.equal(document.getElementById('btnPreviewFullWidth')?.getAttribute('aria-pressed'), 'true');
    assert.equal(
      document.getElementById('btnPreviewFullWidthSecondary')?.getAttribute('aria-pressed'),
      'true',
    );
    assert.equal(
      document.getElementById('btnPreviewFullWidth')?.getAttribute('aria-label'),
      'Restore chat beside preview',
    );
  });

  test('restoreChatColumnFromDrag shows chat column again', () => {
    patchFilePanelState({ rightPaneMode: 'preview', viewerOpen: true });
    applyFileSidebarVisuals();
    collapseChatColumnFromDrag();

    const restored = restoreChatColumnFromDrag();

    assert.equal(restored, true);
    assert.equal(isChatColumnDragCollapsed(), false);
    assert.equal(
      document.getElementById('workspaceSplit')?.classList.contains('chat-column-collapsed'),
      false,
    );
    assert.equal(document.getElementById('btnPreviewFullWidth')?.getAttribute('aria-pressed'), 'false');
    assert.equal(
      document.getElementById('btnPreviewFullWidth')?.getAttribute('aria-label'),
      'Expand preview to full width',
    );
  });

  test('preview full-width control uses the drag-collapse state in both directions', () => {
    patchFilePanelState({ rightPaneMode: 'preview', viewerOpen: true });
    applyFileSidebarVisuals();

    toggleRightPaneFullWidth();
    assert.equal(isChatColumnDragCollapsed(), true);
    assert.equal(
      document.getElementById('workspaceSplit')?.classList.contains('chat-column-collapsed'),
      true,
    );
    assert.equal(document.getElementById('btnPreviewFullWidth')?.getAttribute('aria-pressed'), 'true');

    toggleRightPaneFullWidth();
    assert.equal(isChatColumnDragCollapsed(), false);
    assert.equal(
      document.getElementById('workspaceSplit')?.classList.contains('chat-column-collapsed'),
      false,
    );
  });

  test('switching preview and file tabs preserves a full-width pane until explicitly closed', () => {
    patchFilePanelState({ rightPaneMode: 'preview', viewerOpen: true });
    applyFileSidebarVisuals();
    collapseChatColumnFromDrag();

    for (const show of [showPreviewSplit, showViewerSplit, showViewerSplit, showPreviewSplit]) {
      show();
      assert.equal(isChatColumnDragCollapsed(), true);
      assert.equal(document.getElementById('workspaceSplit')?.classList.contains('chat-column-collapsed'), true);
    }

    showViewerSplit();
    hideViewerSplit({ skipPreviewFallback: true });
    showViewerSplit();
    assert.equal(isChatColumnDragCollapsed(), false, 'opening a closed pane restores the normal split');
  });

  test('restoreChatColumnOnChatSelect is a no-op when chat was not drag-collapsed', () => {
    patchFilePanelState({ rightPaneMode: 'preview', viewerOpen: true });
    applyFileSidebarVisuals();
    restoreChatColumnOnChatSelect();
    assert.equal(isChatColumnDragCollapsed(), false);
    assert.equal(
      document.getElementById('workspaceSplit')?.classList.contains('chat-column-collapsed'),
      false,
    );
  });
});

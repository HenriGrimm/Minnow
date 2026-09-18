import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import {
  getFilePanelState,
  patchFilePanelState,
  resetFilePanelStateForTests,
} from '../../src/state/file-panel.ts';
import {
  collapseRightPane,
  expandRightPane,
  isRightPaneCollapsed,
  showPreviewSplit,
  showViewerSplit,
} from '../../src/ui/file-layout.ts';
import { launchInstance, resetInstancesForTests } from '../../src/os/instances.ts';

function setupSplitDom(): void {
  document.body.innerHTML = `
    <div id="workspaceSplit" class="workspace-split">
      <div class="main-column"></div>
      <div id="splitResizer" class="split-resizer"></div>
      <div id="rightPaneColumn" class="right-pane-column">
        <div id="rightPaneSplit">
          <div id="rightPaneSlotPrimary">
            <section id="fileViewerPane" class="file-viewer-pane"></section>
            <section id="previewPane" class="preview-pane"></section>
          </div>
          <div id="rightPaneSplitResizer"></div>
          <div id="rightPaneSlotSecondary">
            <section id="fileViewerPaneSecondary" class="file-viewer-pane"></section>
            <section id="previewPaneSecondary" class="preview-pane"></section>
          </div>
        </div>
      </div>
    </div>
    <aside id="fileSidebar">
      <button id="btnFileSidebarCollapse" type="button"></button>
      <button id="btnPreviewToggle" type="button"></button>
    </aside>
  `;
}

function isHidden(id: string): boolean {
  return document.getElementById(id)?.classList.contains('hidden') === true;
}

describe('right pane collapse (close button hides, tabs survive)', () => {
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
    resetInstancesForTests();
    resetFilePanelStateForTests();
    launchInstance('code');
    setupSplitDom();
  });

  afterEach(() => {
    resetInstancesForTests();
    resetFilePanelStateForTests();
  });

  test('collapsing a browser pane keeps its tabs and source', () => {
    patchFilePanelState({
      rightPaneMode: 'preview',
      viewerOpen: true,
      previewSource: { kind: 'url', url: 'http://localhost:3000' },
      previewTabs: [{ id: 'tab-1', source: { kind: 'url', url: 'http://localhost:3000' } }],
      activePreviewTab: 'tab-1',
    });

    collapseRightPane();

    const state = getFilePanelState();
    assert.equal(isRightPaneCollapsed(), true);
    assert.equal(state.rightPaneMode, 'preview');
    assert.deepEqual(state.previewSource, { kind: 'url', url: 'http://localhost:3000' });
    assert.equal(state.previewTabs.length, 1);
    assert.equal(isHidden('rightPaneColumn'), true);
    assert.equal(isHidden('previewPane'), true);
  });

  test('collapsing never falls back to the file tabs underneath', () => {
    patchFilePanelState({
      rightPaneMode: 'preview',
      viewerOpen: true,
      openViewerTabs: ['src/a.ts'],
      activeViewerTab: 'src/a.ts',
      previewTabs: [{ id: 'tab-1', source: { kind: 'url', url: 'http://localhost:3000' } }],
      activePreviewTab: 'tab-1',
    });

    collapseRightPane();

    assert.equal(isHidden('rightPaneColumn'), true);
    assert.equal(isHidden('fileViewerPane'), true);
    assert.equal(getFilePanelState().openViewerTabs.length, 1);
  });

  test('reopening restores the same surface', () => {
    patchFilePanelState({
      rightPaneMode: 'preview',
      viewerOpen: true,
      previewTabs: [{ id: 'tab-1', source: { kind: 'url', url: 'http://localhost:3000' } }],
      activePreviewTab: 'tab-1',
    });
    collapseRightPane();

    assert.equal(expandRightPane(), true);

    assert.equal(isRightPaneCollapsed(), false);
    assert.equal(getFilePanelState().rightPaneMode, 'preview');
    assert.equal(isHidden('rightPaneColumn'), false);
    assert.equal(isHidden('previewPane'), false);
  });

  test('a collapsed file pane hides without closing the tab', () => {
    patchFilePanelState({
      rightPaneMode: 'viewer',
      viewerOpen: true,
      openViewerTabs: ['src/a.ts'],
      activeViewerTab: 'src/a.ts',
    });

    collapseRightPane();
    assert.equal(isHidden('rightPaneColumn'), true);
    assert.deepEqual(getFilePanelState().openViewerTabs, ['src/a.ts']);
    assert.equal(getFilePanelState().activeViewerTab, 'src/a.ts');

    expandRightPane();
    assert.equal(isHidden('rightPaneColumn'), false);
    assert.equal(isHidden('fileViewerPane'), false);
  });

  test('split layout collapses whole and comes back split', () => {
    patchFilePanelState({
      rightPaneMode: 'split',
      viewerOpen: true,
      openViewerTabs: ['src/a.ts'],
      activeViewerTab: 'src/a.ts',
      previewTabs: [{ id: 'tab-1', source: { kind: 'url', url: 'http://localhost:3000' } }],
      activePreviewTab: 'tab-1',
      rightPaneSplit: {
        ...getFilePanelState().rightPaneSplit,
        enabled: true,
        focusedSlot: 'secondary',
        primary: { kind: 'viewer', tabPath: 'src/a.ts' },
        secondary: { kind: 'preview', tabId: 'tab-1' },
      },
    });

    collapseRightPane();

    assert.equal(isHidden('rightPaneColumn'), true);
    assert.equal(isHidden('previewPaneSecondary'), true);
    assert.equal(isHidden('fileViewerPane'), true);
    assert.equal(getFilePanelState().rightPaneSplit.enabled, true);

    expandRightPane();

    const state = getFilePanelState();
    assert.equal(state.rightPaneMode, 'split');
    assert.equal(state.rightPaneSplit.enabled, true);
    assert.equal(state.rightPaneSplit.secondary.kind, 'preview');
    assert.equal(isHidden('rightPaneColumn'), false);
    assert.equal(isHidden('rightPaneSlotSecondary'), false);
    assert.equal(isHidden('fileViewerPane'), false);
    assert.equal(isHidden('previewPaneSecondary'), false);
  });

  test('opening a file or browser tab reopens a collapsed pane', () => {
    patchFilePanelState({
      rightPaneMode: 'viewer',
      viewerOpen: true,
      openViewerTabs: ['src/a.ts'],
      activeViewerTab: 'src/a.ts',
    });
    collapseRightPane();

    showPreviewSplit();
    assert.equal(isRightPaneCollapsed(), false);
    assert.equal(getFilePanelState().rightPaneMode, 'preview');

    collapseRightPane();
    showViewerSplit();
    assert.equal(isRightPaneCollapsed(), false);
    assert.equal(getFilePanelState().rightPaneMode, 'viewer');
  });

  test('collapse is a no-op when nothing is open', () => {
    patchFilePanelState({ rightPaneMode: null, viewerOpen: false });

    collapseRightPane();

    assert.equal(getFilePanelState().rightPaneCollapsed, false);
    assert.equal(expandRightPane(), false);
  });
});

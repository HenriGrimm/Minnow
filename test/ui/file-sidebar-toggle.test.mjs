import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { Window } from 'happy-dom';

const {
  applyFileSidebarVisuals,
  closeFileSidebar,
  syncFileSidebarFilesPaneButton,
  toggleFileSidebarLayout,
} = await import('../../src/ui/file-layout.ts');
const {
  DEFAULT_FILE_PANEL_STATE,
  getFilePanelState,
  resetFilePanelStateForTests,
  setFilePanelState,
} = await import('../../src/state/file-panel.ts');
const {
  closeGitSidePanel,
  openGitSidePanel,
  resetGitPanelForTests,
} = await import('../../src/ui/git-panel.ts');

const FILE_TREE_CLASS = 'fi-rr-folder';

function stubMatchMedia(win, matches) {
  const stub = (query) => ({
    matches,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  });
  const origGlobal = globalThis.matchMedia;
  const origWindow = win.matchMedia;
  Object.defineProperty(globalThis, 'matchMedia', { configurable: true, value: stub });
  win.matchMedia = stub;
  return { origGlobal, origWindow, win };
}

function setupFileSidebarDom() {
  const window = new Window();
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Node = window.Node;

  // Mirrors the Code left-pane header: refresh outside the stable pane cluster.
  document.body.innerHTML = `
    <aside id="fileSidebar" class="file-sidebar" aria-label="Project files">
      <div class="file-sidebar-header">
        <button type="button" class="icon-btn file-sidebar-close" id="btnFileSidebarClose" aria-label="Close file tree"></button>
        <span class="file-sidebar-title" id="fileSidebarTitle">Files</span>
        <button type="button" class="icon-btn file-tree-refresh" id="btnFileTreeRefresh"></button>
        <div class="file-sidebar-header-actions" role="toolbar" aria-label="Code left pane">
          <button type="button" id="btnFileSidebarCollapse" class="file-sidebar-toggle"></button>
          <button type="button" id="btnPreviewToggle" class="file-sidebar-preview-toggle" aria-pressed="false"></button>
          <button type="button" id="btnGitPanelToggle" class="git-panel-toggle" aria-pressed="false"></button>
        </div>
      </div>
      <div id="fileSidebarFilesView" class="file-sidebar-files-view"></div>
      <div id="gitPanelRoot" class="git-panel-root" hidden></div>
    </aside>
    <div id="workspaceSplit" class="workspace-split"></div>
  `;
}

function paneClusterButtons() {
  const cluster = document.querySelector('.file-sidebar-header-actions');
  assert.ok(cluster);
  return [...cluster.querySelectorAll(':scope > button')].map((btn) => btn.id);
}

describe('file sidebar toggle icons', { concurrency: false }, () => {
  let matchMediaRestore;
  let origWindow;

  beforeEach(() => {
    origWindow = globalThis.window;
    resetFilePanelStateForTests();
    setupFileSidebarDom();
    resetGitPanelForTests();
  });

  afterEach(() => {
    resetGitPanelForTests();
    globalThis.window = origWindow;
    if (matchMediaRestore) {
      Object.defineProperty(globalThis, 'matchMedia', {
        configurable: true,
        value: matchMediaRestore.origGlobal,
      });
      matchMediaRestore.win.matchMedia = matchMediaRestore.origWindow;
      matchMediaRestore = undefined;
    }
  });

  test('desktop expanded shows folder icon and Files active highlight', () => {
    matchMediaRestore = stubMatchMedia(globalThis.window, false);
    setFilePanelState({ ...DEFAULT_FILE_PANEL_STATE, fileSidebarCollapsed: false });

    applyFileSidebarVisuals();

    const btn = document.getElementById('btnFileSidebarCollapse');
    assert.ok(btn.innerHTML.includes(FILE_TREE_CLASS));
    assert.equal(btn.classList.contains('is-active'), true);
    assert.equal(btn.getAttribute('aria-pressed'), 'true');
    assert.equal(btn.getAttribute('aria-label'), 'Collapse file tree');
  });

  test('desktop collapsed shows folder icon without Files active highlight', () => {
    matchMediaRestore = stubMatchMedia(globalThis.window, false);
    setFilePanelState({ ...DEFAULT_FILE_PANEL_STATE, fileSidebarCollapsed: true });

    applyFileSidebarVisuals();

    const btn = document.getElementById('btnFileSidebarCollapse');
    assert.ok(btn.innerHTML.includes(FILE_TREE_CLASS));
    assert.equal(btn.classList.contains('is-active'), false);
    assert.equal(btn.getAttribute('aria-pressed'), 'false');
    assert.equal(btn.getAttribute('aria-label'), 'Expand file tree');
  });

  test('mobile overlay open shows folder icon and Files active highlight', () => {
    matchMediaRestore = stubMatchMedia(globalThis.window, true);
    const side = document.getElementById('fileSidebar');
    side.classList.add('mobile-open');

    applyFileSidebarVisuals();

    const btn = document.getElementById('btnFileSidebarCollapse');
    assert.ok(btn.innerHTML.includes(FILE_TREE_CLASS));
    assert.equal(btn.classList.contains('is-active'), true);
    assert.equal(btn.getAttribute('aria-label'), 'Close file tree');
  });

  test('mobile overlay closed shows folder icon', () => {
    matchMediaRestore = stubMatchMedia(globalThis.window, true);

    applyFileSidebarVisuals();

    const btn = document.getElementById('btnFileSidebarCollapse');
    assert.ok(btn.innerHTML.includes(FILE_TREE_CLASS));
    assert.equal(btn.classList.contains('is-active'), false);
    assert.equal(btn.getAttribute('aria-label'), 'Open file tree');
  });

  test('pane cluster stays Files / Browser / Source Control while Source Control is open', async () => {
    matchMediaRestore = stubMatchMedia(globalThis.window, false);
    setFilePanelState({ ...DEFAULT_FILE_PANEL_STATE, fileSidebarCollapsed: false });
    applyFileSidebarVisuals();

    assert.deepEqual(paneClusterButtons(), [
      'btnFileSidebarCollapse',
      'btnPreviewToggle',
      'btnGitPanelToggle',
    ]);
    assert.ok(document.getElementById('btnPreviewToggle'));
    assert.ok(document.getElementById('btnFileTreeRefresh'));

    await openGitSidePanel();

    assert.deepEqual(paneClusterButtons(), [
      'btnFileSidebarCollapse',
      'btnPreviewToggle',
      'btnGitPanelToggle',
    ]);
    assert.equal(document.getElementById('btnPreviewToggle')?.isConnected, true);

    const filesBtn = document.getElementById('btnFileSidebarCollapse');
    const gitBtn = document.getElementById('btnGitPanelToggle');
    assert.ok(filesBtn.innerHTML.includes(FILE_TREE_CLASS));
    assert.equal(filesBtn.classList.contains('is-active'), false);
    assert.equal(gitBtn?.classList.contains('is-active'), true);
    assert.equal(filesBtn.getAttribute('aria-label'), 'Show file tree');
  });

  test('Files button switches back from Source Control without collapsing', async () => {
    matchMediaRestore = stubMatchMedia(globalThis.window, false);
    setFilePanelState({ ...DEFAULT_FILE_PANEL_STATE, fileSidebarCollapsed: false });
    applyFileSidebarVisuals();
    await openGitSidePanel();
    assert.equal(
      document.getElementById('fileSidebar')?.classList.contains('file-sidebar--git'),
      true,
    );

    await toggleFileSidebarLayout();

    // Assert via DOM — file-layout dynamically imports git-panel, which can be a
    // separate module instance from this test's static import under tsx.
    assert.equal(
      document.getElementById('fileSidebar')?.classList.contains('file-sidebar--git'),
      false,
    );
    assert.equal(getFilePanelState().fileSidebarCollapsed, false);
    const filesBtn = document.getElementById('btnFileSidebarCollapse');
    assert.equal(filesBtn?.classList.contains('is-active'), true);
    assert.equal(document.getElementById('btnGitPanelToggle')?.classList.contains('is-active'), false);
  });

  test('closeFileSidebar collapses expanded desktop sidebar', () => {
    matchMediaRestore = stubMatchMedia(globalThis.window, false);
    setFilePanelState({ ...DEFAULT_FILE_PANEL_STATE, fileSidebarCollapsed: false });
    applyFileSidebarVisuals();

    closeFileSidebar();

    assert.equal(getFilePanelState().fileSidebarCollapsed, true);
    assert.equal(document.getElementById('fileSidebar')?.classList.contains('collapsed'), true);
  });

  test('closeFileSidebar dismisses mobile drawer', () => {
    matchMediaRestore = stubMatchMedia(globalThis.window, true);
    const side = document.getElementById('fileSidebar');
    side.classList.add('mobile-open');
    applyFileSidebarVisuals();

    closeFileSidebar();

    assert.equal(side.classList.contains('mobile-open'), false);
  });

  test('syncFileSidebarFilesPaneButton honors explicit gitOpen', () => {
    matchMediaRestore = stubMatchMedia(globalThis.window, false);
    setFilePanelState({ ...DEFAULT_FILE_PANEL_STATE, fileSidebarCollapsed: false });
    applyFileSidebarVisuals();

    syncFileSidebarFilesPaneButton({ gitOpen: true });
    const btn = document.getElementById('btnFileSidebarCollapse');
    assert.equal(btn.classList.contains('is-active'), false);
    assert.equal(btn.getAttribute('aria-label'), 'Show file tree');
    assert.ok(btn.innerHTML.includes(FILE_TREE_CLASS));

    closeGitSidePanel();
    syncFileSidebarFilesPaneButton({ gitOpen: false });
    assert.equal(btn.classList.contains('is-active'), true);
  });
});

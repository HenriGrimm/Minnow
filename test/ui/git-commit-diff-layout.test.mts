import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { Window } from 'happy-dom';
import { getFilePanelState, patchFilePanelState, resetFilePanelStateForTests } from '../../src/state/file-panel.ts';
import { resetViewerTabStoreForTests } from '../../src/ui/file-viewer-tab-store.ts';

const patch = `diff --git a/example.ts b/example.ts
--- a/example.ts
+++ b/example.ts
@@ -1 +1 @@
-const value = 1;
+const value = 2;
`;

mock.module('../../src/state/git-api.ts', {
  namedExports: {
    gitBranches: async () => ({ ok: true, local: [], remote: [] }),
    gitShow: async () => ({ ok: true, patch }),
    gitDiff: async () => ({ ok: true, patch }),
  },
});
mock.module('../../src/ui/file-viewer.ts', {
  namedExports: { dismissFileViewerForPreview: async () => true },
});
mock.module('../../src/ui/stats.ts', {
  namedExports: { syncStatsStripLayoutForViewer() {} },
});
mock.module('../../src/ui/unified-right-tabs.ts', {
  namedExports: { refreshUnifiedRightTabs() {} },
});
mock.module('../../src/ui/sidebar-resize.ts', {
  namedExports: { syncAppBodySidebarWidthVars() {}, syncFileSidebarResizer() {} },
});

let win: Window;
const originalWindow = globalThis.window;
const originalDocument = globalThis.document;
const originalHTMLElement = globalThis.HTMLElement;
const originalCustomEvent = globalThis.CustomEvent;
beforeEach(() => {
  win = new Window({ url: 'http://localhost/' });
  globalThis.window = win as unknown as Window & typeof globalThis;
  globalThis.document = win.document as unknown as Document;
  globalThis.HTMLElement = win.HTMLElement as unknown as typeof HTMLElement;
  globalThis.CustomEvent = win.CustomEvent as unknown as typeof CustomEvent;
  win.matchMedia = ((query: string) => ({
    matches: false, media: query, addEventListener() {}, removeEventListener() {},
    addListener() {}, removeListener() {}, dispatchEvent: () => false, onchange: null,
  })) as typeof window.matchMedia;
  resetFilePanelStateForTests();
  resetViewerTabStoreForTests();
  document.body.innerHTML = `
    <div id="workspaceSplit"><div class="main-column"></div><div id="splitResizer"></div>
      <div id="rightPaneColumn" class="hidden"><div id="rightPaneSlotPrimary">
        <section id="fileViewerPane" class="hidden"><div id="fileViewerHost"></div></section>
        <section id="previewPane"></section>
      </div></div>
    </div>`;
  patchFilePanelState({
    rightPaneMode: 'preview', viewerOpen: true,
    previewTabs: [{ id: 'browser', source: { kind: 'url', url: 'http://localhost:3000' } }],
    activePreviewTab: 'browser',
  });
});
afterEach(async () => {
  const { closeGitCommitDiffPanel } = await import('../../src/ui/git-commit-diff-panel.ts');
  closeGitCommitDiffPanel();
  resetFilePanelStateForTests();
  resetViewerTabStoreForTests();
  await win.happyDOM.whenAsyncComplete();
  await win.close();
  globalThis.window = originalWindow;
  globalThis.document = originalDocument;
  globalThis.HTMLElement = originalHTMLElement;
  globalThis.CustomEvent = originalCustomEvent;
});

for (const hasFile of [false, true]) {
  test(`commit diff uses the viewer with ${hasFile ? 'an existing file' : 'no files open'} (MIN-36)`, async () => {
    if (hasFile) {
      patchFilePanelState({ openViewerTabs: ['example.ts'], activeViewerTab: 'example.ts' });
    }
    const { openGitCommitDiffPanel, closeGitCommitDiffPanel } = await import('../../src/ui/git-commit-diff-panel.ts');
    const { applyFileSidebarVisuals } = await import('../../src/ui/file-layout.ts');
    assert.deepEqual(await openGitCommitDiffPanel({ sha: 'abcdef', subject: 'Change value' }), { ok: true });
    applyFileSidebarVisuals();
    assert.equal(getFilePanelState().rightPaneMode, 'viewer');
    assert.equal(document.getElementById('rightPaneColumn')!.classList.contains('hidden'), false);
    assert.equal(document.getElementById('fileViewerPane')!.classList.contains('hidden'), false);
    assert.equal(document.getElementById('previewPane')!.classList.contains('hidden'), true);
    assert.ok(document.querySelector('#fileViewerHost .sbs-diff'));
    assert.match(document.getElementById('fileViewerHost')!.textContent!, /const value = 2/);
    assert.deepEqual(getFilePanelState().openViewerTabs, hasFile ? ['example.ts'] : []);
    closeGitCommitDiffPanel();
    assert.equal(getFilePanelState().rightPaneMode, 'preview');
    assert.equal(document.getElementById('previewPane')!.classList.contains('hidden'), false);
  });
}

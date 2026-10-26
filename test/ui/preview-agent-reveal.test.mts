/**
 * Agent browser_navigate reveal: open the Code/Orchestrate preview pane, stay hidden on Issues.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { setStorageModeForTests } from '../../src/config/storage-mode.ts';
import {
  getFilePanelState,
  resetFilePanelStateForTests,
} from '../../src/state/file-panel.ts';
import {
  getActivePreviewTab,
  resetPreviewTabStoreForTests,
} from '../../src/ui/preview-tab-store.ts';
import {
  resetPreviewHideHoldsForTests,
  resetPreviewGuestVisibilityForTests,
} from '../../src/ui/preview-electron-visibility.ts';
import { teardownHappyDomAsync } from '../os/dom-helpers.mts';

function setupPreviewDom(): void {
  document.documentElement.dataset.osApp = 'code';
  document.body.innerHTML = `
    <div id="appBody">
      <div id="workspaceSplit" class="workspace-split">
        <div class="main-column"></div>
        <div id="splitResizer" class="split-resizer"></div>
        <div id="rightPaneColumn" class="right-pane-column hidden">
          <header id="unifiedTabBar"><div id="unifiedTabs"></div></header>
          <section id="fileViewerPane" class="file-viewer-pane hidden"></section>
          <section id="previewPane" class="preview-pane hidden">
            <input id="previewUrlInput" />
            <div id="previewBody"></div>
          </section>
        </div>
      </div>
    </div>
    <div id="issuesView"></div>
    <aside id="fileSidebar">
      <button id="btnPreviewToggle" type="button"></button>
      <button id="btnFileSidebarCollapse" type="button"></button>
    </aside>
  `;
  const body = document.getElementById('previewBody');
  if (body) {
    body.getBoundingClientRect = () =>
      ({
        left: 10,
        top: 20,
        width: 400,
        height: 300,
        right: 410,
        bottom: 320,
        x: 10,
        y: 20,
        toJSON: () => ({}),
      }) as DOMRect;
  }
}

describe('revealPreviewPanelForAgentNavigation', () => {
  let happyDomWindow: import('happy-dom').Window | undefined;
  let showCalls = 0;
  let hideCalls = 0;
  let lastShowBounds: { x: number; y: number; width: number; height: number } | null = null;

  beforeEach(async () => {
    setStorageModeForTests('localStorage');
    resetPreviewHideHoldsForTests();
    resetPreviewGuestVisibilityForTests();
    const { Window } = await import('happy-dom');
    const win = new Window();
    happyDomWindow = win;
    const g = globalThis as typeof globalThis & {
      window: Window;
      document: Document;
      HTMLElement: typeof HTMLElement;
      requestAnimationFrame: typeof requestAnimationFrame;
    };
    g.window = win as unknown as Window & typeof globalThis.window;
    g.document = win.document;
    g.HTMLElement = win.HTMLElement;
    g.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    }) as typeof requestAnimationFrame;
    g.fetch = (async () =>
      ({ ok: true, json: async () => ({}) }) as Response) as typeof fetch;
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

    showCalls = 0;
    hideCalls = 0;
    lastShowBounds = null;
    (g.window as unknown as { minnow: unknown }).minnow = {
      preview: {
        show: async (bounds?: { x: number; y: number; width: number; height: number }) => {
          showCalls += 1;
          lastShowBounds = bounds ?? null;
        },
        hide: async () => {
          hideCalls += 1;
        },
      },
    };

    resetFilePanelStateForTests();
    resetPreviewTabStoreForTests();
    setupPreviewDom();
  });

  afterEach(async () => {
    resetFilePanelStateForTests();
    resetPreviewTabStoreForTests();
    resetPreviewHideHoldsForTests();
    resetPreviewGuestVisibilityForTests();
    setStorageModeForTests('localStorage');
    if (happyDomWindow) {
      await teardownHappyDomAsync(happyDomWindow);
      happyDomWindow = undefined;
    }
  });

  test('Issues overlay: does not open the pane and hides the guest', async () => {
    document.getElementById('issuesView')?.classList.add('is-open');
    const { revealPreviewPanelForAgentNavigation } = await import('../../src/ui/preview-panel.ts');
    await revealPreviewPanelForAgentNavigation('https://example.com/from-agent');

    assert.equal(document.getElementById('previewPane')?.classList.contains('hidden'), true);
    assert.notEqual(getFilePanelState().rightPaneMode, 'preview');
    assert.equal(showCalls, 0);
    assert.ok(hideCalls >= 1);
    assert.equal(getActivePreviewTab()?.source?.kind, 'url');
    if (getActivePreviewTab()?.source?.kind === 'url') {
      assert.equal(getActivePreviewTab()?.source.url, 'https://example.com/from-agent');
    }
  });

  test('non-Code data-os-app: hides the guest and does not open the pane', async () => {
    document.documentElement.dataset.osApp = 'issues';
    const { revealPreviewPanelForAgentNavigation } = await import('../../src/ui/preview-panel.ts');
    await revealPreviewPanelForAgentNavigation('https://example.com/bg');

    assert.equal(document.getElementById('previewPane')?.classList.contains('hidden'), true);
    assert.equal(showCalls, 0);
    assert.ok(hideCalls >= 1);
  });

  test('Code/Orchestrate: opens the split and shows the guest only after pane layout', async () => {
    const { revealPreviewPanelForAgentNavigation } = await import('../../src/ui/preview-panel.ts');
    await revealPreviewPanelForAgentNavigation('https://example.com/code');

    assert.equal(document.getElementById('previewPane')?.classList.contains('hidden'), false);
    assert.equal(getFilePanelState().rightPaneMode, 'preview');
    assert.equal(showCalls, 1);
    assert.deepEqual(lastShowBounds, { x: 10, y: 20, width: 400, height: 300 });
    assert.equal(getActivePreviewTab()?.source?.kind, 'url');
  });
});

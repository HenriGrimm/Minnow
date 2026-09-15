/**
 * Guest strategy for Design Mode in Electron (cross-origin Select fix).
 *
 * Same-origin previews (workspace HTML, or a URL on Minnow's own origin) always use the iframe
 * guest. On a cross-origin preview the iframe can't be introspected, so element Select must fall
 * back to CDP inspect on the native WebContentsView — which needs that view visible. So the guest
 * strategy becomes tool-aware there: iframe for Draw/Comment/disarmed, native view for Select
 * (armed by default on enable).
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { Window } from 'happy-dom';
import { enableDesignMode, resetDesignModeForTests } from '../../src/design/design-mode.ts';
import { resetDesignToolRegistryForTests } from '../../src/design/design-tool.ts';
import { resetDesignMetaCacheForTests } from '../../src/config/design-meta.ts';
import { resolveDesignModeMountOptions } from '../../src/ui/preview-design-mode-mount.ts';
import { usesDesignModeIframeGuest, syncPrimaryDesignModeElectronGuest } from '../../src/ui/preview-panel.ts';
import { openPreviewTab, resetPreviewTabStoreForTests } from '../../src/ui/preview-tab-store.ts';
import {
  DEFAULT_FILE_PANEL_STATE,
  resetFilePanelStateForTests,
  setFilePanelState,
} from '../../src/state/file-panel.ts';

function mountHost(): { host: HTMLElement; pane: HTMLElement; chrome: HTMLElement } {
  const pane = document.createElement('div');
  pane.id = 'previewPane';
  const host = document.createElement('div');
  host.id = 'previewBody';
  const chrome = document.createElement('div');
  chrome.id = 'previewDesignChrome';
  chrome.setAttribute('hidden', '');
  pane.appendChild(host);
  pane.appendChild(chrome);
  document.body.appendChild(pane);
  host.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 400, height: 300, right: 400, bottom: 300, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  Object.defineProperty(host, 'clientWidth', { configurable: true, value: 400 });
  return { host, pane, chrome };
}

describe('design mode guest strategy (cross-origin Select)', () => {
  beforeEach(() => {
    // Renderer origin is 127.0.0.1:5173; a hosted preview at example.com is cross-origin.
    const win = new Window({ url: 'http://127.0.0.1:5173/' });
    globalThis.window = win as unknown as Window & typeof globalThis;
    globalThis.document = win.document;
    globalThis.ResizeObserver = win.ResizeObserver;
    globalThis.PointerEvent = win.PointerEvent;
    globalThis.HTMLElement = win.HTMLElement as unknown as typeof HTMLElement;
    globalThis.fetch = (async () => ({ ok: true, json: async () => ({}) }) as Response) as typeof fetch;
    // Electron bridge present → usesElectronPreview() is true. cdpPicker exists so Select routes CDP.
    (globalThis.window as unknown as { minnow?: unknown }).minnow = {
      preview: {
        hide: async () => {},
        show: async () => {},
        setBounds: async () => {},
        execJs: async () => ({}),
        cdpPicker: {
          enable: async () => ({ ok: true }),
          disable: async () => {},
          onPick: () => () => {},
          onError: () => () => {},
        },
      },
    };
    resetFilePanelStateForTests();
    resetPreviewTabStoreForTests();
    resetDesignMetaCacheForTests();
    resetDesignToolRegistryForTests();
    resetDesignModeForTests();
  });

  afterEach(() => {
    resetDesignModeForTests();
    resetDesignToolRegistryForTests();
    resetDesignMetaCacheForTests();
    resetFilePanelStateForTests();
    (globalThis.window as unknown as { minnow?: unknown }).minnow = undefined;
    document.body.innerHTML = '';
  });

  test('same-origin preview always uses the iframe guest, even with Select armed', async () => {
    setFilePanelState({
      ...DEFAULT_FILE_PANEL_STATE,
      previewSource: { kind: 'url', url: 'http://127.0.0.1:5173/app' },
    });
    const { host, pane, chrome } = mountHost();
    const session = await enableDesignMode(resolveDesignModeMountOptions(host, pane, chrome));

    assert.equal(usesDesignModeIframeGuest(), true);
    session.armTool('select');
    assert.equal(usesDesignModeIframeGuest(), true, 'same-origin Select still uses iframe guest');
  });

  test('repeated guest synchronization preserves the loaded iframe without navigating again', async () => {
    openPreviewTab({ kind: 'url', url: 'http://127.0.0.1:5173/app' });
    const { host, pane, chrome } = mountHost();
    await enableDesignMode(resolveDesignModeMountOptions(host, pane, chrome));
    await syncPrimaryDesignModeElectronGuest();
    const frame = host.querySelector('iframe')!;
    assert.ok(frame);
    let navigations = 0;
    const observer = new window.MutationObserver(records => {
      navigations += records.filter(record => record.attributeName === 'src').length;
    });
    observer.observe(frame, { attributes: true });
    try {
      await syncPrimaryDesignModeElectronGuest();
      await syncPrimaryDesignModeElectronGuest();
      await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(host.querySelector('iframe'), frame);
      assert.equal(navigations, 0);
      assert.equal(chrome.hidden, true);
    } finally {
      observer.disconnect();
    }
  });

  test('cross-origin preview keeps iframe guest for Draw/Comment but hands Select the native view', async () => {
    setFilePanelState({
      ...DEFAULT_FILE_PANEL_STATE,
      previewSource: { kind: 'url', url: 'https://example.com/pricing' },
    });
    const { host, pane, chrome } = mountHost();
    const session = await enableDesignMode(resolveDesignModeMountOptions(host, pane, chrome));

    // Select is armed by default → native view for CDP inspect on cross-origin previews.
    assert.equal(session.getArmedToolId(), 'select');
    assert.equal(usesDesignModeIframeGuest(), false, 'default Select reveals the native view for CDP');

    session.armTool('select');
    assert.equal(usesDesignModeIframeGuest(), false, 'Select reveals the native view for CDP');

    session.armTool('draw');
    assert.equal(usesDesignModeIframeGuest(), true, 'Draw returns to the iframe guest');

    session.armTool('comment');
    assert.equal(usesDesignModeIframeGuest(), true, 'Comment uses the iframe guest');

    session.disarmTool();
    assert.equal(usesDesignModeIframeGuest(), true, 'disarming returns to the iframe guest');
  });
});

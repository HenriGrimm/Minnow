import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { Window } from 'happy-dom';
import {
  bindPreviewBrowserMenu,
  closePreviewBrowserMenu,
  executePreviewBrowserMenuAction,
} from '../../src/ui/preview-browser-menu.ts';
import type { MinnowPreviewBrowserMenuApi } from '../../src/electron.d.ts';

describe('preview browser menu', () => {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  let win: Window;
  let calls: string[];
  let api: MinnowPreviewBrowserMenuApi;

  beforeEach(() => {
    calls = [];
    win = new Window({ url: 'http://localhost/' });
    (globalThis as { window: Window }).window = win;
    (globalThis as { document: Document }).document = win.document as unknown as Document;
    api = {
      hardReload: async () => (calls.push('hard-reload'), { ok: true }),
      copyUrl: async (address) => (calls.push(`copy-url:${address}`), { ok: true }),
      copyScreenshot: async () => (calls.push('copy-screenshot'), { ok: true }),
      getZoom: async () => 100,
      setZoom: async (percent) => (calls.push(`zoom:${percent}`), percent),
      clearHistory: async () => (calls.push('clear-history'), { ok: true }),
      clearCookies: async () => (calls.push('clear-cookies'), { ok: true }),
      clearCache: async () => (calls.push('clear-cache'), { ok: true }),
    };
  });

  afterEach(() => {
    closePreviewBrowserMenu();
    (globalThis as { window: typeof window }).window = previousWindow;
    (globalThis as { document: typeof document }).document = previousDocument;
  });

  test('renders every requested action and states the screenshot destination', async () => {
    Object.defineProperty(win, 'minnow', {
      configurable: true,
      value: { preview: { browserMenu: api, hide: async () => undefined } },
    });
    const anchor = win.document.createElement('button') as unknown as HTMLButtonElement;
    win.document.body.appendChild(anchor as unknown as Node);
    bindPreviewBrowserMenu(anchor, { tabId: () => 'tab-1', address: () => 'https://example.com/' });
    anchor.click();
    await Promise.resolve();

    const text = win.document.querySelector('.preview-browser-menu')?.textContent ?? '';
    assert.match(text, /Zoom/);
    assert.match(text, /Hard reload/);
    assert.match(text, /Copy URL/);
    assert.match(text, /Copy screenshot to clipboard/);
    assert.match(text, /Clear browsing history/);
    assert.match(text, /Clear cookies/);
    assert.match(text, /Clear cache/);
  });

  test('routes every menu action to the preview bridge', async () => {
    const notices: string[] = [];
    let localHistoryClears = 0;
    const deps = {
      api,
      address: 'https://example.com/',
      tabId: 'tab-1',
      instanceId: 'workspace-preview',
      confirm: async () => true,
      clearHistory: () => {
        localHistoryClears += 1;
      },
      notify: (message: string) => notices.push(message),
    } as Parameters<typeof executePreviewBrowserMenuAction>[1];

    for (const action of [
      'hard-reload',
      'copy-url',
      'copy-screenshot',
      'clear-history',
      'clear-cookies',
      'clear-cache',
    ] as const) {
      await executePreviewBrowserMenuAction(action, deps);
    }

    assert.deepEqual(calls, [
      'hard-reload',
      'copy-url:https://example.com/',
      'copy-screenshot',
      'clear-history',
      'clear-cookies',
      'clear-cache',
    ]);
    assert.equal(localHistoryClears, 1);
    assert.ok(notices.includes('Screenshot copied to clipboard'));
  });

  for (const suffix of ['', 'Secondary']) {
    test(`toolbar actions work without Electron in ${suffix ? 'split' : 'primary'} preview`, async () => {
      const anchor = win.document.createElement('button');
      const design = win.document.createElement('button');
      design.id = `btnPreviewDesignToggle${suffix}`;
      design.setAttribute('aria-pressed', 'true');
      design.addEventListener('click', () => calls.push(`design:${suffix}`));
      const auto = win.document.createElement('input');
      auto.id = 'previewAutoReload';
      auto.type = 'checkbox';
      auto.checked = true;
      auto.addEventListener('change', () => calls.push(`auto:${auto.checked}`));
      const unavailable = win.document.createElement('button');
      unavailable.id = 'unavailable';
      unavailable.hidden = true;
      win.document.body.append(anchor, design, auto, unavailable);
      bindPreviewBrowserMenu(anchor as unknown as HTMLButtonElement, {
        tabId: () => 'tab-1', address: () => '',
        toolbarControls: [
          { id: design.id, label: 'Design Mode' },
          { id: auto.id, label: 'Auto-reload saved files' },
          { id: unavailable.id, label: 'Unavailable' },
        ],
      });
      assert.equal(anchor.hidden, false);
      anchor.click();
      await Promise.resolve();
      const menu = win.document.querySelector('.preview-browser-menu')!;
      assert.equal(menu.querySelector('[data-control="unavailable"]'), null);
      assert.equal(menu.querySelector('[data-action="clear-cache"]'), null);
      const designItem = menu.querySelector(`[data-control="${design.id}"]`)!;
      assert.equal(designItem.getAttribute('aria-checked'), 'true');
      assert.equal(win.document.activeElement, designItem);
      win.document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      const autoItem = menu.querySelector('[data-control="previewAutoReload"]')!;
      assert.equal(win.document.activeElement, autoItem);
      (autoItem as unknown as HTMLButtonElement).click();
      assert.equal(auto.checked, false);
      assert.deepEqual(calls, ['auto:false']);
      assert.equal(win.document.querySelector('.preview-browser-menu'), null);
      assert.equal(win.document.activeElement, anchor);
      anchor.click();
      await Promise.resolve();
      const nextDesign = win.document.querySelector(`[data-control="${design.id}"]`)!;
      (nextDesign as unknown as HTMLButtonElement).click();
      assert.deepEqual(calls, ['auto:false', `design:${suffix}`]);
      anchor.click();
      await Promise.resolve();
      win.document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      assert.equal(win.document.querySelector('.preview-browser-menu'), null);
      assert.equal(win.document.activeElement, anchor);
    });
  }
});

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
});

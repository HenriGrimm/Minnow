import assert from 'node:assert/strict';
import { describe, test, afterEach } from 'node:test';
import { Window } from 'happy-dom';
import {
  PREVIEW_DOM_SNAPSHOT_SCRIPT,
  renderPreviewSnapshotTree,
  type PreviewSnapshotNode,
} from '../../src/tools/browser-preview-snapshot.ts';

function metaFetchResponse(): Response {
  return new Response(
    JSON.stringify({
      browser: {
        enabled: true,
        allowNavigate: true,
        allowedOriginPatterns: ['http://localhost:*'],
      },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

function mockElectronPreview(execJs: (script: string) => Promise<unknown>): void {
  Object.defineProperty(globalThis, 'window', {
    value: {
      addEventListener: () => {},
      minnow: {
        app: { isElectron: true, platform: 'linux', openExternal: async () => {} },
        preview: {
          execJs,
          getInfo: async () => ({ url: '', title: '', loading: false }),
          capturePage: async () => '',
          navigateAndWait: async () => ({ ok: true, url: '', title: '' }),
          show: async () => {},
        },
      },
    },
    configurable: true,
    writable: true,
  });
}

/** The user-preview tool contract always addresses a tab returned by browser_list. */
async function userPreviewTabId(): Promise<string> {
  const { ensureDefaultPreviewTab } = await import('../../src/ui/preview-tab-store.ts');
  return ensureDefaultPreviewTab().id;
}

describe('browser-preview-snapshot', () => {
  test('renderPreviewSnapshotTree formats uid role name tree', () => {
    const nodes: PreviewSnapshotNode[] = [
      {
        uid: 1,
        role: 'link',
        name: 'Home',
        children: [{ uid: 2, role: 'button', name: 'Go' }],
      },
    ];
    const text = renderPreviewSnapshotTree(nodes);
    assert.match(text, /\[1\] link "Home"/);
    assert.match(text, /\[2\] button "Go"/);
  });

  test('renderPreviewSnapshotTree recurses through uid-0 wrapper nodes', () => {
    const nodes: PreviewSnapshotNode[] = [
      {
        uid: 0,
        role: 'generic',
        name: '',
        children: [
          { uid: 1, role: 'link', name: 'Home' },
          { uid: 2, role: 'button', name: 'Go' },
        ],
      },
    ];
    const text = renderPreviewSnapshotTree(nodes);
    assert.match(text, /\[1\] link "Home"/);
    assert.match(text, /\[2\] button "Go"/);
    assert.doesNotMatch(text, /\[0\]/);
  });

  test('PREVIEW_DOM_SNAPSHOT_SCRIPT stamps uids on SPA-shaped DOM', () => {
    const win = new Window();
    win.document.body.innerHTML =
      '<div id="root"><header><a href="/">Home</a></header><main><button>Go</button></main></div>';

    const result = win.eval(PREVIEW_DOM_SNAPSHOT_SCRIPT) as {
      text: string;
      nodes: PreviewSnapshotNode[];
    };

    assert.match(result.text, /\[1\]/);
    assert.match(result.text, /\[2\]/);
    assert.doesNotMatch(result.text, /\(empty page\)/);
    assert.match(result.text, /link "Home"/);
    assert.match(result.text, /button "Go"/);

    const home = win.document.querySelector('a[href="/"]');
    const go = win.document.querySelector('button');
    assert.equal(home?.getAttribute('data-mn-uid'), '1');
    assert.equal(go?.getAttribute('data-mn-uid'), '2');

    win.close();
  });
});

describe('browser-preview-tools', () => {
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    Object.defineProperty(globalThis, 'window', {
      value: originalWindow,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, 'document', {
      value: originalDocument,
      configurable: true,
      writable: true,
    });
    globalThis.fetch = originalFetch;
  });

  test('isElectronPreviewAvailable is false without minnow bridge', async () => {
    Object.defineProperty(globalThis, 'window', {
      value: {},
      configurable: true,
      writable: true,
    });
    const shell = await import('../../src/tools/minnow-shell.ts');
    assert.equal(shell.isElectronPreviewAvailable(), false);
  });

  test('executeBrowserPreviewTool returns desktop shell message outside Electron', async () => {
    Object.defineProperty(globalThis, 'window', {
      value: {},
      configurable: true,
      writable: true,
    });
    const mod = await import('../../src/tools/browser-preview-tools.ts');
    const result = await mod.executeBrowserPreviewTool('browser_list', {});
    assert.match(
      result.content,
      /Error: Browser automation runs in the Minnow desktop app/,
    );
  });

  test('browser_list_tabs alias lists tabs with active marker', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/config/meta')) return metaFetchResponse();
      return new Response('{}', { status: 404 });
    }) as typeof fetch;

    Object.defineProperty(globalThis, 'window', {
      value: {
        addEventListener: () => {},
        minnow: {
          app: { isElectron: true, platform: 'linux', openExternal: async () => {} },
          preview: {
            tabs: {
              list: async () => [
                { id: 'a', title: 'One', url: 'https://one.test', loading: false, active: false },
                { id: 'b', title: 'Two', url: 'https://two.test', loading: false, active: true },
              ],
            },
            execJs: async () => ({}),
            getInfo: async () => ({ url: '', title: '', loading: false }),
            capturePage: async () => '',
            navigateAndWait: async () => ({ ok: true, url: '', title: '' }),
            show: async () => {},
          },
        },
      },
      configurable: true,
      writable: true,
    });

    const mod = await import('../../src/tools/browser-preview-tools.ts');
    const result = await mod.executeBrowserPreviewTool('browser_list_tabs', {});
    assert.match(result.content ?? '', /\[active\] Two/);
    assert.match(result.content ?? '', /id: b/);
    assert.match(result.content ?? '', /One/);
  });

  test('browser_snapshot prefers uid tree when guest text is empty page', async () => {
    let execCalls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/config/meta')) return metaFetchResponse();
      return new Response('{}', { status: 404 });
    }) as typeof fetch;

    mockElectronPreview(async (script) => {
      execCalls++;
      if (script.includes('nextUid')) {
        return {
          text: '(empty page)',
          nodes: [
            {
              uid: 0,
              role: 'generic',
              name: '',
              children: [
                { uid: 1, role: 'link', name: 'Home' },
                { uid: 2, role: 'button', name: 'Go' },
              ],
            },
          ],
        };
      }
      return 'LM-STUDIO // TERMINAL v0.1.0';
    });

    const mod = await import('../../src/tools/browser-preview-tools.ts');
    const result = await mod.executeBrowserPreviewTool('browser_snapshot', { tab_id: await userPreviewTabId() });
    assert.match(result.content ?? '', /\[1\] link "Home"/);
    assert.match(result.content ?? '', /\[2\] button "Go"/);
    assert.doesNotMatch(result.content ?? '', /LM-STUDIO/);
    assert.equal(execCalls, 1);
  });

  test('browser_snapshot ensures preview tab guest exists before execJs', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/config/meta')) return metaFetchResponse();
      return new Response('{}', { status: 404 });
    }) as typeof fetch;

    const tabOps: string[] = [];
    let execTabId: string | undefined;
    Object.defineProperty(globalThis, 'window', {
      value: {
        addEventListener: () => {},
        minnow: {
          app: { isElectron: true, platform: 'linux', openExternal: async () => {} },
          preview: {
            execJs: async (_script: string, tabId?: string) => {
              execTabId = tabId;
              return { text: '(empty page)', nodes: [] };
            },
            getInfo: async () => ({ url: '', title: '', loading: false }),
            capturePage: async () => '',
            navigateAndWait: async () => ({ ok: true, url: '', title: '' }),
            show: async () => {},
            tabs: {
              list: async () => [],
              create: async (tabId?: string) => {
                tabOps.push(`create:${tabId ?? ''}`);
                return tabId ?? 'tab';
              },
              activate: async (tabId: string) => {
                tabOps.push(`activate:${tabId}`);
              },
            },
          },
        },
      },
      configurable: true,
      writable: true,
    });

    const mod = await import('../../src/tools/browser-preview-tools.ts');
    await mod.executeBrowserPreviewTool('browser_snapshot', { tab_id: await userPreviewTabId() });
    assert.ok(tabOps.some((op) => op.startsWith('create:')), 'should create guest tab');
    assert.ok(tabOps.some((op) => op.startsWith('activate:')), 'should activate guest tab');
    assert.ok(execTabId && execTabId.length > 0, 'execJs should receive tab id');
  });

  test('browser_snapshot returns exec error from guest script', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/config/meta')) return metaFetchResponse();
      return new Response('{}', { status: 404 });
    }) as typeof fetch;

    mockElectronPreview(async () => ({ __execError: 'DOM access denied' }));

    const mod = await import('../../src/tools/browser-preview-tools.ts');
    const result = await mod.executeBrowserPreviewTool('browser_snapshot', { tab_id: await userPreviewTabId() });
    assert.match(result.content ?? '', /Error: DOM access denied/);
  });

  test('browser_eval returns guest script errors to the model', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/config/meta')) return metaFetchResponse();
      return new Response('{}', { status: 404 });
    }) as typeof fetch;

    mockElectronPreview(async () => ({ __execError: 'ReferenceError: missingVar is not defined' }));

    const mod = await import('../../src/tools/browser-preview-tools.ts');
    const result = await mod.executeBrowserPreviewTool('browser_eval', {
      expression: 'missingVar',
      tab_id: await userPreviewTabId(),
    });
    assert.match(result.content ?? '', /Error: ReferenceError: missingVar is not defined/);
  });

  test('racePreviewExecJs times out a hung promise', async () => {
    const mod = await import('../../src/tools/browser-preview-tools.ts');
    const started = Date.now();
    await assert.rejects(
      () => mod.racePreviewExecJs(new Promise(() => {}), { timeoutMs: 50 }),
      /timed out after 50ms/,
    );
    assert.ok(Date.now() - started < 1000);
  });

  test('racePreviewExecJs rejects when the chat abort signal fires', async () => {
    const mod = await import('../../src/tools/browser-preview-tools.ts');
    const controller = new AbortController();
    const pending = mod.racePreviewExecJs(new Promise(() => {}), {
      timeoutMs: 5_000,
      signal: controller.signal,
    });
    queueMicrotask(() => controller.abort());
    await assert.rejects(pending, (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.equal(err.name, 'AbortError');
      return true;
    });
  });

  test('browser_eval times out hung execJs instead of stalling', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/config/meta')) return metaFetchResponse();
      return new Response('{}', { status: 404 });
    }) as typeof fetch;

    mockElectronPreview(() => new Promise(() => {}));

    const mod = await import('../../src/tools/browser-preview-tools.ts');
    const started = Date.now();
    const result = await mod.browserPreviewEval(
      'new Promise(() => {})',
      undefined,
      undefined,
      50,
      await userPreviewTabId(),
    );
    assert.match(result, /timed out after 50ms/);
    assert.match(result, /browser_snapshot/);
    assert.ok(Date.now() - started < 1000);
  });

  test('browser_eval aborts hung execJs when the chat is stopped', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/config/meta')) return metaFetchResponse();
      return new Response('{}', { status: 404 });
    }) as typeof fetch;

    mockElectronPreview(() => new Promise(() => {}));

    const mod = await import('../../src/tools/browser-preview-tools.ts');
    const controller = new AbortController();
    const pending = mod.executeBrowserPreviewTool(
      'browser_eval',
      { expression: 'new Promise(() => {})', tab_id: await userPreviewTabId() },
      controller.signal,
    );
    queueMicrotask(() => controller.abort());
    await assert.rejects(pending, (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.equal(err.name, 'AbortError');
      return true;
    });
  });

  test('browser_snapshot returns hint when no interactive elements found', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/config/meta')) return metaFetchResponse();
      return new Response('{}', { status: 404 });
    }) as typeof fetch;

    mockElectronPreview(async () => ({ text: '(empty page)', nodes: [] }));

    const mod = await import('../../src/tools/browser-preview-tools.ts');
    const result = await mod.executeBrowserPreviewTool('browser_snapshot', { tab_id: await userPreviewTabId() });
    assert.match(result.content ?? '', /no interactive elements/i);
  });

  test('browser_click reports missing uid when element not found', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/config/meta')) {
        return new Response(
          JSON.stringify({
            browser: {
              enabled: true,
              allowNavigate: true,
              allowedOriginPatterns: ['http://localhost:*'],
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response('{}', { status: 404 });
    }) as typeof fetch;

    Object.defineProperty(globalThis, 'window', {
      value: {
        minnow: {
          app: { isElectron: true, platform: 'linux', openExternal: async () => {} },
          preview: {
            execJs: async () => ({ missing: true }),
            getInfo: async () => ({ url: '', title: '', loading: false }),
            capturePage: async () => '',
            navigateAndWait: async () => ({ ok: true, url: '', title: '' }),
            show: async () => {},
          },
        },
      },
      configurable: true,
      writable: true,
    });

    const shell = await import('../../src/tools/minnow-shell.ts');
    assert.equal(shell.isElectronPreviewAvailable(), true);

    const mod = await import('../../src/tools/browser-preview-tools.ts');
    const result = await mod.executeBrowserPreviewTool('browser_click', {
      tab_id: await userPreviewTabId(),
      uid: 9,
    });
    assert.match(result.content, /No snapshot cached/);
  });

  test('browser_screenshot POSTs base64 and returns attachment', async () => {
    const uploads: { body: string }[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/config/meta')) {
        return new Response(
          JSON.stringify({
            browser: {
              enabled: true,
              allowNavigate: true,
              allowedOriginPatterns: [],
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url === '/api/browser/screenshot' && init?.method === 'POST') {
        uploads.push({ body: String(init.body) });
        return new Response(JSON.stringify({ id: 'shot1', sizeBytes: 2048 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('{}', { status: 404 });
    }) as typeof fetch;

    Object.defineProperty(globalThis, 'window', {
      value: {
        addEventListener: () => {},
        minnow: {
          app: { isElectron: true, platform: 'linux', openExternal: async () => {} },
          preview: {
            execJs: async () => ({}),
            capturePage: async () => Buffer.from('png').toString('base64'),
            getInfo: async () => ({ url: 'http://localhost/', title: 't', loading: false }),
            navigateAndWait: async () => ({ ok: true, url: '', title: '' }),
            show: async () => {},
          },
        },
      },
      configurable: true,
      writable: true,
    });

    const mod = await import('../../src/tools/browser-preview-tools.ts');
    const result = await mod.executeBrowserPreviewTool('browser_screenshot', { tab_id: await userPreviewTabId() });
    assert.equal(uploads.length, 1);
    assert.match(result.content ?? '', /shot1\.png/);
    assert.equal(result.attachments?.[0]?.url, '/api/browser/screenshot/shot1');
    assert.equal(result.attachments?.[0]?.mime, 'image/png');
    assert.ok(result.attachments?.[0]?.dataUrl?.startsWith('data:image/png;base64,'));
  });

  test('browser_screenshot returns friendly message when capturePage is empty', async () => {
    const uploads: unknown[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/config/meta')) {
        return new Response(
          JSON.stringify({
            browser: {
              enabled: true,
              allowNavigate: true,
              allowedOriginPatterns: [],
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url === '/api/browser/screenshot' && init?.method === 'POST') {
        uploads.push(init.body);
        return new Response(JSON.stringify({ error: 'dataBase64 is required' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('{}', { status: 404 });
    }) as typeof fetch;

    Object.defineProperty(globalThis, 'window', {
      value: {
        addEventListener: () => {},
        minnow: {
          app: { isElectron: true, platform: 'linux', openExternal: async () => {} },
          preview: {
            execJs: async () => ({}),
            capturePage: async () => '   ',
            getInfo: async () => ({
              url: 'http://localhost:3000/',
              title: 't',
              loading: false,
            }),
            navigateAndWait: async () => ({ ok: true, url: '', title: '' }),
            show: async () => {},
          },
        },
      },
      configurable: true,
      writable: true,
    });

    const mod = await import('../../src/tools/browser-preview-tools.ts');
    const result = await mod.executeBrowserPreviewTool('browser_screenshot', { tab_id: await userPreviewTabId() });
    assert.equal(uploads.length, 0);
    assert.match(result.content ?? '', /no image/i);
    assert.doesNotMatch(result.content ?? '', /dataBase64 is required/i);
  });

  test('browser_navigate updates the explicitly requested user tab, not the active tab', async () => {
    const testWindow = new Window();
    Object.assign(testWindow, {
      minnow: {
        app: { isElectron: true, platform: 'linux', openExternal: async () => {} },
        preview: {
          hide: async () => {},
          execJs: async () => ({}),
          capturePage: async () => '',
          tabs: { list: async () => [] },
          navigateAndWait: async (url: string) => ({ ok: true, url, title: 'Target' }),
        },
      },
    });
    Object.defineProperty(globalThis, 'window', { value: testWindow, configurable: true, writable: true });
    Object.defineProperty(globalThis, 'document', {
      value: testWindow.document,
      configurable: true,
      writable: true,
    });
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input).includes('/api/config/meta')) return metaFetchResponse();
      return new Response('{}', { status: 404 });
    }) as typeof fetch;

    const { activatePreviewTab, getPreviewTab, openPreviewTab } = await import('../../src/ui/preview-tab-store.ts');
    const active = await userPreviewTabId();
    const target = openPreviewTab(null);
    assert.ok(target, 'test needs a second preview tab');
    activatePreviewTab(active);

    const mod = await import('../../src/tools/browser-preview-tools.ts');
    const result = await mod.executeBrowserPreviewTool('browser_navigate', {
      surface: 'user',
      tab_id: target.id,
      url: 'https://target.example/path',
    });

    assert.match(result.content ?? '', /Navigated to: https:\/\/target\.example\/path/);
    assert.equal(getPreviewTab(active)?.source, null);
    assert.deepEqual(getPreviewTab(target.id)?.source, {
      kind: 'url',
      url: 'https://target.example/path',
    });
    testWindow.close();
  });
});

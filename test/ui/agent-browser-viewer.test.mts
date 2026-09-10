import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { Window } from 'happy-dom';

import {
  initAgentBrowserViewer,
  fitAgentBrowserFrame,
  mapViewerPointToViewport,
  mountAgentBrowserViewerRoot,
  resetAgentBrowserViewerForTests,
  shouldPollAgentBrowserFrames,
} from '../../src/agent-browser/viewer.ts';

test('maps a scaled viewer point into the captured tab viewport', () => {
  const point = mapViewerPointToViewport(410, 245, {
    left: 10,
    top: 20,
    width: 800,
    height: 450,
  } as DOMRect, { width: 1440, height: 900 });
  assert.deepEqual(point, { x: 720, y: 450 });
});

test('fits the complete captured viewport inside an available stage', () => {
  assert.deepEqual(
    fitAgentBrowserFrame({ width: 1042, height: 548 }, { width: 1440, height: 900 }, {
      horizontal: 36,
      vertical: 36,
    }),
    { width: 819, height: 512 },
  );
});

test('rejects a point in canvas letterboxing and does not poll frames while hidden', () => {
  const point = mapViewerPointToViewport(-100, 900, {
    left: 10,
    top: 20,
    width: 800,
    height: 450,
  } as DOMRect, { width: 1440, height: 900 });
  assert.equal(point, null);
  assert.equal(shouldPollAgentBrowserFrames(false, 'tab-1'), false);
  assert.equal(shouldPollAgentBrowserFrames(true, null), false);
  assert.equal(shouldPollAgentBrowserFrames(true, 'tab-1'), true);
});

test('mounts a viewer root against the actual shared index scaffold', async () => {
  const html = await readFile(new URL('../../index.html', import.meta.url), 'utf8');
  const window = new Window();
  window.document.write(html);
  assert.equal(window.document.getElementById('app'), null, 'the shared shell has no generic app root');

  const root = mountAgentBrowserViewerRoot(window.document);

  assert.equal(root.id, 'app');
  assert.equal(window.document.getElementById('app'), root);
  assert.equal(window.document.body.children.length, 1);
  window.close();
});

test('keeps an address draft and focus while a live update redraws controls', async () => {
  const testWindow = new Window();
  const priorWindow = globalThis.window;
  const priorDocument = globalThis.document;
  const priorFetch = globalThis.fetch;
  const priorEventSource = globalThis.EventSource;
  const events: FakeEventSource[] = [];

  class FakeEventSource {
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: (() => void) | null = null;

    constructor() {
      events.push(this);
    }

    close(): void {}
  }

  Object.assign(globalThis, {
    window: testWindow,
    document: testWindow.document,
    EventSource: FakeEventSource,
    fetch: async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/tabs')) {
        return new Response(JSON.stringify({
          tabs: [{ tabId: 'tab-1', url: 'https://example.test', owner: 'Build chat', controlMode: 'control' }],
        }), { headers: { 'Content-Type': 'application/json' } });
      }
      if (url.endsWith('/targets')) {
        return new Response(JSON.stringify({ targets: [] }), { headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(new Blob(['frame']), {
        headers: {
          'X-Minnow-Agent-Browser-Viewport-Width': '1440',
          'X-Minnow-Agent-Browser-Viewport-Height': '900',
        },
      });
    },
  });

  try {
    await initAgentBrowserViewer();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const address = testWindow.document.querySelector<HTMLInputElement>('[data-agent-browser-address]');
    assert.ok(address);
    assert.equal(address.value, 'https://example.test');
    address.value = 'https://draft.example';
    address.focus();

    events[0]?.onmessage?.(new MessageEvent('message'));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const updatedAddress = testWindow.document.querySelector<HTMLInputElement>('[data-agent-browser-address]');
    assert.equal(updatedAddress, address, 'ordinary live updates keep the control node stable');
    assert.equal(updatedAddress?.value, 'https://draft.example');
    assert.equal(testWindow.document.activeElement, updatedAddress);
  } finally {
    resetAgentBrowserViewerForTests();
    Object.assign(globalThis, {
      window: priorWindow,
      document: priorDocument,
      fetch: priorFetch,
      EventSource: priorEventSource,
    });
    testWindow.close();
  }
});

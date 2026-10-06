import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { resolveIsolatedPreviewLoadUrl, resolvePreviewLoadUrl, workspacePreviewUrl } from '../../src/ui/preview-load-url.ts';

describe('preview panel helpers', () => {
  test('workspacePreviewUrl encodes path segments', () => {
    assert.equal(workspacePreviewUrl('index.html'), '/api/preview/file/index.html');
    assert.equal(
      workspacePreviewUrl('docs/demo page.html'),
      '/api/preview/file/docs/demo%20page.html',
    );
  });

  test('workspacePreviewUrl adds cache-bust query', () => {
    assert.equal(
      workspacePreviewUrl('app.js', 12345),
      '/api/preview/file/app.js?v=12345',
    );
  });

  test('workspacePreviewUrl adds workspaceRoot query', () => {
    assert.equal(
      workspacePreviewUrl('note.txt', undefined, 'C:/Users/me/.minnow/workspace'),
      '/api/preview/file/note.txt?workspaceRoot=C%3A%2FUsers%2Fme%2F.minnow%2Fworkspace',
    );
    assert.equal(
      workspacePreviewUrl('app.js', 9, 'C:/alt'),
      '/api/preview/file/app.js?v=9&workspaceRoot=C%3A%2Falt',
    );
  });

  test('workspacePreviewUrl raw flag skips browser base injection for editor loads', () => {
    assert.equal(
      workspacePreviewUrl('index.html', { raw: true }),
      '/api/preview/file/index.html?raw=1',
    );
    assert.equal(
      workspacePreviewUrl('index.html', { cacheBust: 3, raw: true, workspaceRoot: 'C:/ws' }),
      '/api/preview/file/index.html?v=3&workspaceRoot=C%3A%2Fws&raw=1',
    );
  });

  test('resolvePreviewLoadUrl absolutizes root-relative API paths for Electron', () => {
    const prev = globalThis.window;
    globalThis.window = { location: { origin: 'http://127.0.0.1:5173' } } as Window & typeof globalThis;
    try {
      assert.equal(
        resolvePreviewLoadUrl({
          kind: 'url',
          url: '/api/research/report/rs-24552c627990',
        }),
        'http://127.0.0.1:5173/api/research/report/rs-24552c627990',
      );
      assert.equal(
        resolvePreviewLoadUrl({ kind: 'url', url: 'https://example.com/page' }),
        'https://example.com/page',
      );
    } finally {
      globalThis.window = prev;
    }
  });

  test('isolated workspace URL contains only a preview capability', async () => {
    const previousWindow = globalThis.window;
    const previousFetch = globalThis.fetch;
    globalThis.window = {
      location: { origin: 'http://127.0.0.1:9473' },
      __MINNOW_SESSION_TOKEN__: 'host-secret',
    } as Window & typeof globalThis;
    globalThis.fetch = (async () => new Response(JSON.stringify({
      origin: 'http://127.0.0.1:9474',
      token: 'preview-only',
      expiresAt: Date.now() + 60_000,
    }), { status: 200 })) as typeof fetch;
    try {
      const url = await resolveIsolatedPreviewLoadUrl(
        { kind: 'workspace', path: 'docs/index.html' }, 7, 'C:/preview-test',
      );
      assert.equal(url, 'http://127.0.0.1:9474/p/preview-only/api/preview/file/docs/index.html?v=7');
      assert.equal(url.includes('host-secret'), false);
    } finally {
      globalThis.window = previousWindow;
      globalThis.fetch = previousFetch;
    }
  });
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Window } from 'happy-dom';
import DOMPurify from 'dompurify';
import { installHappyDomGlobals } from './dom-helpers.mts';
import { isOsAppHash } from '../../src/os/page-bridge.ts';

test('Wiki routes belong to the shell without matching unrelated hashes', () => {
  for (const hash of ['#/wiki', '#/wiki/documentation%2Fmanual%2FREADME.md', '#/app/brain', '#/workspaces']) {
    assert.equal(isOsAppHash(hash), true, hash);
  }
  for (const hash of ['#/wikipedia', '#/wiki-search', '#/unknown']) {
    assert.equal(isOsAppHash(hash), false, hash);
  }
});

test('opening Wiki over Brain preserves the app and restores its route on close (MIN-562)', async () => {
  const win = new Window();
  const originalFetch = globalThis.fetch;
  const originalSanitize = DOMPurify.sanitize;
  DOMPurify.sanitize = DOMPurify(win as unknown as globalThis.Window).sanitize;
  installHappyDomGlobals(win, { fetch: async (input) => {
    const url = String(input);
    if (url.includes('/api/product-wiki/catalog')) {
      return Response.json({ entries: [] });
    }
    if (url.includes('/api/product-wiki/page')) {
      const path = new URL(url, 'http://localhost').searchParams.get('path');
      return Response.json({ path, title: 'User manual', section: 'Manual', content: 'Wiki content.' });
    }
    return Response.json({});
  } });
  const { initBrainPage, resetBrainPageForTests } = await import('../../src/ui/brain-page.ts');
  const { initProductWiki, openProductWiki, closeProductWiki } = await import('../../src/ui/product-wiki.ts');
  const { launchInstance, getForegroundAppId, resetInstancesForTests } = await import('../../src/os/instances.ts');
  const { syncOsRouteFromHashForTests, resetOsRouterForTests } = await import('../../src/os/router.ts');
  try {
    win.document.body.innerHTML = '<div id="osStage"></div><div id="appBody"></div><main id="brainView" class="is-open"></main>';
    // Bind the real legacy listener without triggering unrelated Brain data loads.
    win.history.replaceState(null, '', '#/app/code/chat');
    resetBrainPageForTests();
    initBrainPage();
    win.history.replaceState(null, '', '#/app/brain/edit');
    launchInstance('brain');
    initProductWiki();
    const wikiHash = '#/wiki/documentation%2Fmanual%2FREADME.md';
    for (let attempt = 0; attempt < 2; attempt += 1) {
      openProductWiki();
      syncOsRouteFromHashForTests();
      win.dispatchEvent(new win.HashChangeEvent('hashchange'));
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(win.location.hash, wikiHash);
      assert.equal(getForegroundAppId(), 'brain');
      assert.equal(win.document.getElementById('brainView')?.classList.contains('is-open'), true);
      assert.equal(win.document.getElementById('productWikiOverlay')?.classList.contains('hidden'), false);
      assert.equal(win.document.getElementById('productWikiArticleBody')?.textContent?.trim(), 'Wiki content.');
    }
    closeProductWiki();
    assert.equal(win.location.hash, '#/app/brain/edit');
    win.dispatchEvent(new win.HashChangeEvent('hashchange'));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(win.location.hash, '#/app/brain/edit');
    assert.equal(win.document.getElementById('productWikiOverlay')?.classList.contains('hidden'), true);
  } finally {
    resetBrainPageForTests();
    resetInstancesForTests();
    resetOsRouterForTests();
    await win.happyDOM.abort();
    win.close();
    globalThis.fetch = originalFetch;
    DOMPurify.sanitize = originalSanitize;
  }
});

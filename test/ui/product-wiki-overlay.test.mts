import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Window } from 'happy-dom';
import { installHappyDomGlobals, teardownHappyDomAsync } from '../os/dom-helpers.mts';

test('Wiki has no close button; toggle, Escape, outside click and replacement restore the caller', async () => {
  const win = new Window({ url: 'http://localhost/#/app/code/chat' });
  const page = {
    path: 'documentation/manual/README.md', title: 'User manual', summary: 'Help',
    headings: [], section: 'Manual', hash: 'fixture', content: '# User manual\n\n## Setup\n\nHelp.\n\n## Read more\n\nMore help.',
  };
  const fetchMock = async (input: RequestInfo | URL) => new Response(
    JSON.stringify(String(input).includes('/catalog') ? { entries: [page] } : page),
    { headers: { 'Content-Type': 'application/json' } },
  );
  installHappyDomGlobals(win, { fetch: fetchMock as typeof fetch });
  win.document.body.innerHTML = '<button id="wikiTrigger"></button><div id="osStage"></div>';
  const state = await import('../../src/ui/shell-overlay-state.ts');
  const wiki = await import('../../src/ui/product-wiki.ts');
  const trigger = win.document.getElementById('wikiTrigger')!;
  const unbind = state.bindShellOverlayTrigger(trigger, 'wiki');
  trigger.addEventListener('click', () => {
    if (state.isShellOverlayOpen('wiki')) state.closeShellOverlay();
    else wiki.openProductWiki();
  });
  wiki.initProductWiki();
  const flush = async () => { await new Promise((resolve) => setTimeout(resolve, 20)); };
  try {
    trigger.click();
    await flush();
    assert.equal(win.document.getElementById('productWikiClose'), null);
    assert.equal(trigger.getAttribute('aria-expanded'), 'true');
    assert.equal(win.document.getElementById('productWikiOverlay')!.classList.contains('hidden'), false);
    // Heading navigation must preserve the Wiki route and therefore its toggle state.
    win.document.querySelector<HTMLAnchorElement>('.product-wiki__toc-link')?.click();
    assert.match(win.location.hash, /^#\/wiki/);
    trigger.click();
    await flush();
    assert.equal(trigger.getAttribute('aria-pressed'), 'false');
    assert.equal(win.location.hash, '#/app/code/chat');

    trigger.click();
    await flush();
    win.document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await flush();
    assert.equal(trigger.getAttribute('aria-expanded'), 'false');
    assert.equal(win.document.activeElement, trigger);
    assert.equal(win.location.hash, '#/app/code/chat');

    trigger.click();
    await flush();
    win.document.body.dispatchEvent(new win.PointerEvent('pointerdown', { bubbles: true }));
    await flush();
    assert.equal(trigger.getAttribute('aria-expanded'), 'false');

    trigger.click();
    await flush();
    state.openShellOverlay('notifications', () => state.shellOverlayClosed('notifications'));
    await flush();
    assert.equal(trigger.getAttribute('aria-pressed'), 'false');
    assert.equal(win.document.getElementById('productWikiOverlay')!.classList.contains('hidden'), true);
    assert.equal(win.location.hash, '#/app/code/chat');
    assert.equal(state.isShellOverlayOpen('notifications'), true);
  } finally {
    state.closeShellOverlay();
    unbind();
    await teardownHappyDomAsync(win);
  }
});

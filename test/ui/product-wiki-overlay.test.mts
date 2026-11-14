import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Window } from 'happy-dom';
import { installHappyDomGlobals, teardownHappyDomAsync } from '../os/dom-helpers.mts';

test('Wiki retains its article under menubar popovers and restores the caller on dismissal', async () => {
  const win = new Window({ url: 'http://localhost/#/app/code/chat' });
  const page = {
    path: 'documentation/manual/README.md', title: 'User manual', summary: 'Help',
    headings: [], section: 'Manual', hash: 'fixture', content: '# User manual\n\n## Setup\n\nHelp.\n\n## Read more\n\nMore help.',
  };
  const fetchMock: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes('/product-wiki/catalog')) return Response.json({ entries: [page] });
    if (url.includes('/product-wiki/page')) return Response.json(page);
    if (url.includes('/generations/routers')) return Response.json({ routers: [], defaultRouterId: null, revision: 0 });
    if (url.includes('/agent-clis/updates')) return Response.json({ items: [], checkedAt: Date.now() });
    return Response.json({});
  };
  installHappyDomGlobals(win, { fetch: fetchMock });
  win.document.body.innerHTML = '<div id="osMenubar"></div><button id="caption" data-above-shell-overlay></button><div id="osStage"></div>';
  const state = await import('../../src/ui/shell-overlay-state.ts');
  const wiki = await import('../../src/ui/product-wiki.ts');
  const { renderMenubar } = await import('../../src/os/menubar.ts');
  await import('../../src/ui/models-popover.ts');
  const menubar = win.document.getElementById('osMenubar')!;
  const cleanup = renderMenubar(menubar);
  const trigger = menubar.querySelector<HTMLButtonElement>('[data-shell-overlay="wiki"]')!;
  const models = menubar.querySelector<HTMLButtonElement>('[data-shell-overlay="models"]')!;
  const updates = menubar.querySelector<HTMLButtonElement>('[data-shell-overlay="update"]')!;
  updates.getClientRects = () => [new win.DOMRect(400, 0, 32, 32)] as unknown as DOMRectList;
  updates.style.visibility = 'visible';
  wiki.initProductWiki();
  const flush = async () => { await new Promise((resolve) => setTimeout(resolve, 20)); };
  try {
    trigger.click();
    await flush();
    const header = win.document.querySelector('.product-wiki__header')!;
    assert.equal(header.querySelector('[aria-label="Close wiki"]'), null);
    assert.ok(header.querySelector('button[aria-label="Back to chat"]'));
    assert.equal(trigger.getAttribute('aria-expanded'), 'true');
    assert.equal(win.document.getElementById('productWikiOverlay')!.classList.contains('hidden'), false);
    // Heading navigation must preserve the Wiki route and therefore its toggle state.
    win.document.querySelector<HTMLAnchorElement>('.product-wiki__toc-link')?.click();
    assert.match(win.location.hash, /^#\/wiki/);
    win.document.getElementById('caption')!.dispatchEvent(new win.PointerEvent('pointerdown', { bubbles: true }));
    assert.equal(trigger.getAttribute('aria-expanded'), 'true');

    const wikiHash = win.location.hash;
    const article = win.document.getElementById('productWikiArticle')!;
    article.scrollTop = 150;
    models.dispatchEvent(new win.PointerEvent('pointerdown', { bubbles: true }));
    models.click();
    await flush();
    const modelsPanel = win.document.getElementById('modelsSystemPopover');
    assert.ok(modelsPanel);
    modelsPanel.dispatchEvent(new win.PointerEvent('pointerdown', { bubbles: true }));
    assert.equal(trigger.getAttribute('aria-expanded'), 'true');
    assert.equal(win.location.hash, wikiHash);

    win.document.activeElement!.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    assert.equal(modelsPanel.isConnected, false);
    assert.equal(win.document.activeElement, models);
    assert.equal(trigger.getAttribute('aria-expanded'), 'true');

    models.click();
    await flush();
    updates.dispatchEvent(new win.PointerEvent('pointerdown', { bubbles: true }));
    updates.click();
    const updatesPanel = win.document.querySelector('.mn-os-update-menu');
    assert.ok(updatesPanel);
    assert.equal(win.document.getElementById('modelsSystemPopover'), null);
    assert.equal(trigger.getAttribute('aria-expanded'), 'true');
    updatesPanel.dispatchEvent(new win.PointerEvent('pointerdown', { bubbles: true }));
    article.dispatchEvent(new win.PointerEvent('pointerdown', { bubbles: true }));
    assert.equal(updatesPanel.isConnected, false);
    assert.equal(win.document.getElementById('productWikiOverlay')!.classList.contains('hidden'), false);
    assert.equal(win.location.hash, wikiHash);
    assert.equal(article.scrollTop, 150);

    updates.click();
    win.document.activeElement!.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    assert.equal(win.document.querySelector('.mn-os-update-menu'), null);
    assert.equal(win.document.activeElement, updates);
    assert.equal(win.location.hash, wikiHash);

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
    state.closeShellOverlays();
    cleanup();
    await teardownHappyDomAsync(win);
  }
});

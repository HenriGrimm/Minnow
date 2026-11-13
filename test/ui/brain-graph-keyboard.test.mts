import '../tools/install-dom-before-imports.mts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Window } from 'happy-dom';
import { installHappyDomGlobals, teardownHappyDomAsync } from '../os/dom-helpers.mts';
import { setLocalServerAvailableForTests } from '../../src/tools/config.ts';

test('Brain page disclosures and inspector expose keyboard graph actions', async () => {
  const window = new Window();
  const path = 'facts/first.md';
  const meta = { type: 'page', path, title: 'First page', folder: 'facts', tags: [], links: [] };
  const originalFetch = globalThis.fetch;
  installHappyDomGlobals(window, {
    fetch: async (input) => {
      if (String(input).includes('/api/brain/tree')) {
        return Response.json({ tree: { facts: { type: 'folder', children: { first: meta } } } });
      }
      return Response.json({ path, meta, body: 'First page contents' });
    },
  });
  setLocalServerAvailableForTests(true);
  Object.assign(globalThis, {
    MutationObserver: window.MutationObserver,
    SVGElement: window.SVGElement,
    cancelAnimationFrame: (id: number) => window.clearTimeout(id),
  });
  document.body.innerHTML = `
    <div id="brainGraphStage">
      <div id="brainGraphTree"></div>
      <canvas id="brainGraphCanvas"></canvas>
      <aside id="brainInspector"></aside>
    </div>
    <button id="brainGraphLayoutToggle"></button>
  `;
  const canvas = document.getElementById('brainGraphCanvas')!;
  Object.defineProperty(canvas, 'getContext', { value: () => ({ setTransform() {} }) });
  const { renderGraphSection, teardownGraphSection } = await import('../../src/ui/brain/graph-section.ts');
  try {
    await renderGraphSection();
    const folder = document.querySelector<HTMLButtonElement>('.brain-tree__folder')!;
    const pages = document.getElementById(folder.getAttribute('aria-controls')!)!;
    assert.equal(document.querySelector('#brainGraphTree [role="tree"]'), null);
    folder.click();
    assert.equal(folder.getAttribute('aria-expanded'), 'false');
    assert.equal(pages.hidden, true);
    folder.click();
    assert.equal(folder.getAttribute('aria-expanded'), 'true');
    assert.equal(pages.hidden, false);

    const page = pages.querySelector<HTMLButtonElement>('button')!;
    page.focus();
    page.click();
    await new Promise(resolve => setImmediate(resolve));
    const heading = document.querySelector('.brain-inspector__title');
    assert.equal(heading?.textContent, 'First page');
    assert.equal(document.activeElement, heading);
    assert.equal(page.getAttribute('aria-current'), 'page');

    const actions = document.querySelector<HTMLElement>('.brain-inspector__graph-actions')!;
    const focus = actions.querySelector<HTMLButtonElement>('[data-graph-action="focus"]')!;
    const pin = actions.querySelector<HTMLButtonElement>('[data-graph-action="pin"]')!;
    assert.equal(actions.hidden, false);
    focus.click();
    pin.click();
    assert.equal(focus.getAttribute('aria-pressed'), 'true');
    assert.equal(pin.getAttribute('aria-pressed'), 'true');
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
    pin.click();
    assert.equal(focus.getAttribute('aria-pressed'), 'false');
    assert.equal(pin.getAttribute('aria-pressed'), 'false');

    document.getElementById('brainGraphLayoutToggle')!.click();
    assert.equal(actions.hidden, true);
    document.getElementById('brainGraphLayoutToggle')!.click();
    assert.equal(actions.hidden, false);
    document.querySelector<HTMLButtonElement>('.brain-inspector__close')!.click();
    assert.equal(document.activeElement, page);
  } finally {
    teardownGraphSection({ clearSelection: true });
    setLocalServerAvailableForTests(false);
    globalThis.fetch = originalFetch;
    await teardownHappyDomAsync(window);
  }
});

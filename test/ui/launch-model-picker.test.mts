/**
 * MIN-1054: the Issues launch model picker uses the shared chat picker surface.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Window } from 'happy-dom';
import { installHappyDomGlobals, teardownHappyDomAsync } from '../os/dom-helpers.mts';

const emptyCatalogFetch = (async () => new Response(JSON.stringify({ providers: [], models: [], data: [], routers: [] }), {
  status: 200, headers: { 'content-type': 'application/json' },
})) as typeof fetch;

async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(check(), 'condition not met');
}

test('issue launch picker opens with the chat model picker surface', async () => {
  const win = new Window({ url: 'http://localhost/' });
  installHappyDomGlobals(win, { fetch: emptyCatalogFetch });
  try {
    const anchor = document.createElement('button');
    anchor.textContent = 'Model';
    document.body.append(anchor);
    const { openLaunchModelPicker } = await import('../../src/ui/launch-model-picker.ts');
    let closed = false;
    openLaunchModelPicker(anchor, '', () => {}, {
      reasoning: () => undefined,
      onReasoning: () => {},
      onClose: () => { closed = true; },
    });
    await waitFor(() => !!document.querySelector('.auxiliary-model-popover:not(.hidden)'));
    const panel = document.querySelector<HTMLElement>('.auxiliary-model-popover')!;
    assert.ok(panel.classList.contains('composer-model-menu'));
    assert.ok(panel.classList.contains('composer-model-menu--code'));
    assert.ok(panel.querySelector(':scope > .model-select-host-filter.composer-model-menu__filter'));
    // Reasoning lives beside the list, as in chat, never as a separate select.
    assert.ok(panel.querySelector(':scope > .model-select-menu + .composer-model-reasoning'));
    assert.equal(panel.querySelector('.composer-model-reasoning select'), null);
    panel.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }) as unknown as Event);
    await waitFor(() => closed);
  } finally {
    await teardownHappyDomAsync(win);
  }
});

test('plain launch picker keeps the auxiliary popover surface', async () => {
  const win = new Window({ url: 'http://localhost/' });
  installHappyDomGlobals(win, { fetch: emptyCatalogFetch });
  try {
    const anchor = document.createElement('button');
    document.body.append(anchor);
    const { openLaunchModelPicker } = await import('../../src/ui/launch-model-picker.ts');
    openLaunchModelPicker(anchor, '', () => {});
    await waitFor(() => !!document.querySelector('.auxiliary-model-popover:not(.hidden)'));
    const panel = document.querySelector<HTMLElement>('.auxiliary-model-popover')!;
    assert.equal(panel.classList.contains('composer-model-menu--code'), false);
    assert.equal(panel.querySelector('.composer-model-reasoning'), null);
    anchor.remove();
  } finally {
    await teardownHappyDomAsync(win);
  }
});

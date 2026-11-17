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

test('reasoning selection updates checkmarks without changing favorite stars', async () => {
  const win = new Window({ url: 'http://localhost/' });
  installHappyDomGlobals(win, { fetch: emptyCatalogFetch });
  const { modelCache } = await import('../../src/app-state.ts');
  const { encodeModelSelectKey } = await import('../../src/lib/model-select-key.ts');
  const key = encodeModelSelectKey('openai', 'launch-reasoning-test');
  const { setStorageModeForTests } = await import('../../src/config/storage-mode.ts');
  const { persistDefaultModelValue } = await import('../../src/models/selection.ts');
  setStorageModeForTests('localStorage');
  await persistDefaultModelValue(key);
  modelCache.set(key, { id: 'launch-reasoning-test', reasoning: { allowed_options: ['low', 'high'] }, capabilities: {
    vision: false, tools: true, streaming: true, grammar: null, reasoning: true,
    reasoningAllowedOptions: ['low', 'high'], contextLength: null, loadState: null,
  } });
  try {
    const anchor = document.createElement('button');
    document.body.append(anchor);
    const { openLaunchModelPicker } = await import('../../src/ui/launch-model-picker.ts');
    let selected: string | undefined;
    openLaunchModelPicker(anchor, key, () => {}, {
      reasoning: () => undefined,
      onReasoning: effort => { selected = effort; },
      onClose: () => {},
    });
    await waitFor(() => !!document.querySelector('[data-reasoning-favorite="high"]'));
    const star = document.querySelector<HTMLButtonElement>('[data-reasoning-favorite="high"]')!;
    const starMarkup = star.innerHTML;
    const choice = document.querySelector<HTMLButtonElement>('[data-composer-reasoning="high"]')!;
    choice.click();
    assert.equal(selected, 'high');
    assert.equal(choice.getAttribute('aria-pressed'), 'true');
    assert.ok(choice.querySelector('.icon-svg'));
    assert.equal(document.querySelector('[data-composer-reasoning="inherit"]')!.getAttribute('aria-pressed'), 'false');
    assert.equal(star.innerHTML, starMarkup);
    assert.equal(star.getAttribute('aria-pressed'), 'false');
    document.querySelector('.auxiliary-model-popover')!.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }) as unknown as Event);
  } finally {
    modelCache.delete(key);
    await persistDefaultModelValue('');
    setStorageModeForTests(null);
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

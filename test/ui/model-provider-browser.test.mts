import '../tools/install-dom-before-imports.mts';
import assert from 'node:assert/strict';
import { after, beforeEach, describe, test } from 'node:test';
import { modelCache } from '../../src/app-state.ts';
import { encodeModelSelectKey } from '../../src/lib/model-select-key.ts';
import { readModelPickerPreferences, recordModelPickerUse } from '../../src/models/model-picker-preferences.ts';
import { handleModelProviderBrowserKeydown, renderModelProviderBrowser, resetModelProviderBrowser } from '../../src/ui/model-provider-browser.ts';
import { resolveModelHostFilterLoadUnloadValue } from '../../src/ui/model-host-filter-context.ts';
import { mountAuxiliaryModelSelectCombobox, unmountAuxiliaryModelSelectCombobox, renderModelSelectMenuRows, setModelHostFilter, setModelLibraryFilter, setModelLocalLoadFilter, setModelSearchQuery } from '../../src/ui/model-select-picker.ts';
import { teardownHappyDomAsync } from '../os/dom-helpers.mts';

Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: window.localStorage });
after(async () => teardownHappyDomAsync(window));

describe('provider browser', { concurrency: false }, () => {
  let select: HTMLSelectElement;
  let menu: HTMLUListElement;
  let picked: string[];
  const key = (provider: string) => encodeModelSelectKey(provider, 'same-model');
  const provider = (id: string) => [...menu.querySelectorAll<HTMLButtonElement>('.model-browser-provider')].find(b => b.dataset.providerId === id)!;
  const render = () => renderModelSelectMenuRows(menu, select, value => picked.push(value));
  beforeEach(() => {
    document.body.replaceChildren(); localStorage.clear(); modelCache.clear();
    setModelHostFilter('all'); setModelLibraryFilter('all'); setModelLocalLoadFilter('all'); setModelSearchQuery('');
    picked = [];
    select = document.createElement('select'); menu = document.createElement('ul'); menu.className = 'model-select-menu';
    for (const [id, label, host] of [['claude', 'Claude Code', 'cloud'], ['api', 'Anthropic API', 'cloud'], ['lm', 'LM Studio', 'local']]) {
      const option = document.createElement('option');
      option.value = key(id); option.text = `Same model — ${label}`;
      option.dataset.providerId = id; option.dataset.providerLabel = label; option.dataset.providerHost = host;
      select.appendChild(option);
    }
    document.body.append(select, menu); render();
  });
  test('starts collapsed and separates identical models on different connections', () => {
    assert.equal(menu.querySelectorAll('.model-browser-provider').length, 3);
    assert.equal(menu.querySelectorAll('.model-select-option').length, 0);
    provider('claude').click();
    assert.equal(menu.querySelector<HTMLElement>('.model-select-option')?.dataset.value, key('claude'));
    assert.equal(provider('api').getAttribute('aria-expanded'), 'false');
  });
  test('provider rail uses connection logos and the Minnow library mark', () => {
    menu.replaceChildren();
    const connections = [
      ['codex-cli', 'Codex CLI', 'openai'],
      ['claude-code-cli', 'Claude Code', 'anthropic'],
      ['opencode-go', 'OpenCode Go', 'opencode'],
      ['opencode-zen', 'OpenCode Zen', 'opencode'],
      ['minnow-library', 'My Models', 'minnow'],
    ];
    renderModelProviderBrowser(menu, connections.map(([id, label]) => ({
      id, label, local: id === 'minnow-library', entries: [], hasFavorites: false,
    })), [], () => {}, () => {});
    for (const [id, , logo] of connections) {
      const mark = provider(id).querySelector<HTMLElement>('.model-browser-provider-mark')!;
      assert.equal(mark.dataset.logo, logo);
      assert.equal(mark.textContent, '');
      const path = logo === 'minnow' ? '/logos/minnow-glyph.svg' : `/logos/providers/${logo}.svg`;
      assert.ok(mark.querySelector<HTMLElement>('.model-browser-provider-glyph')?.style.maskImage.includes(path));
    }
  });
  test('delays hover previews, cancels flyovers, and honors pinned groups', async () => {
    provider('api').dispatchEvent(new window.PointerEvent('pointerenter', { pointerType: 'mouse' }));
    assert.equal(menu.querySelectorAll('.model-select-option').length, 0);
    provider('api').dispatchEvent(new window.PointerEvent('pointerleave', { pointerType: 'mouse' }));
    await new Promise(resolve => setTimeout(resolve, 210));
    assert.equal(menu.querySelectorAll('.model-select-option').length, 0);
    provider('claude').dispatchEvent(new window.PointerEvent('pointerenter', { pointerType: 'mouse' }));
    await new Promise(resolve => setTimeout(resolve, 210));
    assert.equal(provider('claude').getAttribute('aria-expanded'), 'true');
    provider('claude').click();
    provider('api').dispatchEvent(new window.PointerEvent('pointerenter', { pointerType: 'mouse' }));
    await new Promise(resolve => setTimeout(resolve, 210));
    assert.equal(provider('claude').getAttribute('aria-expanded'), 'true');
    provider('api').click();
    assert.equal(provider('api').getAttribute('aria-expanded'), 'true');
    resetModelProviderBrowser(menu); render();
    assert.equal(menu.querySelectorAll('[aria-expanded="true"]').length, 0);
  });
  test('starring does not select, survives reopening, and includes the provider identity', () => {
    provider('claude').click(); menu.querySelector<HTMLButtonElement>('.model-select-favorite')!.click();
    assert.deepEqual(picked, []);
    assert.deepEqual(readModelPickerPreferences().favorites, [key('claude')]);
    resetModelProviderBrowser(menu); render();
    assert.equal(menu.querySelectorAll('.model-browser-favorite-list .model-select-option').length, 1);
    provider('api').click();
    assert.equal(menu.querySelector('.model-browser-pane .model-select-favorite')?.getAttribute('aria-pressed'), 'false');
    menu.querySelector<HTMLButtonElement>('.model-browser-favorite-list .model-select-option')!.click();
    assert.deepEqual(picked, [key('claude')]);
    menu.querySelector<HTMLButtonElement>('.model-browser-favorite-list .model-select-favorite')!.click();
    assert.deepEqual(readModelPickerPreferences().favorites, []);
  });
  test('sorts by usage, name or locality, keeping favorites first in smart order', () => {
    recordModelPickerUse('lm'); render();
    assert.equal(menu.querySelector<HTMLElement>('.model-browser-provider')?.dataset.providerId, 'lm');
    provider('claude').click(); menu.querySelector<HTMLButtonElement>('.model-select-favorite')!.click();
    assert.equal(menu.querySelector<HTMLElement>('.model-browser-provider')?.dataset.providerId, 'claude');
    const choose = (value: string) => {
      const sort = menu.querySelector<HTMLSelectElement>('.model-browser-sort')!;
      sort.value = value; sort.dispatchEvent(new window.Event('change'));
    };
    choose('name');
    assert.equal(menu.querySelector<HTMLElement>('.model-browser-provider')?.dataset.providerId, 'api');
    choose('local');
    assert.equal(menu.querySelector<HTMLElement>('.model-browser-provider')?.dataset.providerId, 'lm');
    render(); assert.equal(menu.querySelector<HTMLSelectElement>('.model-browser-sort')?.value, 'local');
  });
  test('searches collapsed providers and preserves filters and disabled entries', () => {
    setModelSearchQuery('Same model'); render();
    assert.equal(menu.querySelectorAll('.model-select-option').length, 3);
    assert.equal(menu.querySelector('.model-browser-provider'), null);
    setModelSearchQuery('Anthropic'); render();
    assert.equal(menu.querySelector<HTMLElement>('.model-select-option')?.dataset.value, key('api'));
    select.options[1].disabled = true; render();
    assert.equal(menu.querySelectorAll('.model-select-option').length, 0);
    setModelSearchQuery(''); setModelHostFilter('local'); render();
    assert.equal(menu.querySelectorAll('.model-browser-provider').length, 1);
    assert.equal(menu.querySelector<HTMLElement>('.model-browser-provider')?.dataset.providerId, 'lm');
  });
  test('keyboard browsing enters a provider and keeps native model and star activation', () => {
    provider('claude').focus();
    provider('claude').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    const row = menu.querySelector<HTMLButtonElement>('.model-browser-pane .model-select-option')!;
    assert.equal(document.activeElement, row);
    assert.equal(handleModelProviderBrowserKeydown(menu, new window.KeyboardEvent('keydown', { key: 'Enter' })), false);
    row.click(); assert.deepEqual(picked, [key('claude')]);
    row.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    assert.equal(document.activeElement, provider('claude'));
  });
  test('ignores malformed preferences without losing model selection', () => {
    localStorage.setItem('minnow.modelPicker.v1', '{bad json'); render();
    assert.deepEqual(readModelPickerPreferences().favorites, []);
    provider('api').click(); menu.querySelector<HTMLButtonElement>('.model-select-option')!.click();
    assert.deepEqual(picked, [key('api')]);
  });
  test('every auxiliary picker opens the full-size overlay with styled isolated search', () => {
    window.innerWidth = 900;
    const host = document.createElement('div'); host.style.cssText = 'width:160px;height:80px;overflow:hidden';
    document.body.append(host); host.append(select);
    mountAuxiliaryModelSelectCombobox(select);
    const panel = host.querySelector<HTMLElement>('.auxiliary-model-popover')!;
    let opened = false;
    panel.showPopover = () => { opened = true; };
    panel.hidePopover = () => { opened = false; };
    const matches = panel.matches.bind(panel);
    panel.matches = selector => selector === ':popover-open' ? opened : matches(selector);
    const trigger = host.querySelector<HTMLButtonElement>('.model-select-trigger')!;
    trigger.click();
    assert.equal(opened, true, 'opening the trigger enters the top layer');
    assert.equal(panel.style.width, '620px', 'field width cannot shrink the browser');
    assert.ok(panel.querySelector('.model-host-filter-search-wrap input'));
    assert.equal(panel.querySelectorAll('.model-host-filter-segment').length, 3);
    const search = panel.querySelector<HTMLInputElement>('input')!;
    search.value = 'my own query';
    setModelSearchQuery('composer query');
    assert.equal(search.value, 'my own query', 'composer search leaves isolated inputs alone');
    trigger.click(); assert.equal(opened, false);
    unmountAuxiliaryModelSelectCombobox(select);
  });
  test('provider-specific native values retain their contract and share favorite identities', () => {
    select.options[0].value = 'same-model';
    render(); provider('claude').click();
    menu.querySelector<HTMLButtonElement>('.model-browser-pane .model-select-favorite')!.click();
    assert.deepEqual(readModelPickerPreferences().favorites, [key('claude')]);
    menu.querySelector<HTMLButtonElement>('.model-browser-pane .model-select-option')!.click();
    assert.deepEqual(picked, ['same-model']);
  });
  test('an inherited auxiliary binding never targets the global model', () => {
    select.id = 'modelSelect';
    const auxiliary = document.createElement('select');
    const inherit = document.createElement('option');
    inherit.value = ''; inherit.textContent = 'Follow parent chat'; inherit.dataset.modelSelectReset = 'true';
    auxiliary.append(inherit, select.options[2].cloneNode(true));
    document.body.append(auxiliary); mountAuxiliaryModelSelectCombobox(auxiliary);
    const actions = auxiliary.parentElement!.querySelector<HTMLElement>('.model-menu-actions')!;
    assert.equal(resolveModelHostFilterLoadUnloadValue(actions), '');
    auxiliary.value = key('lm');
    auxiliary.dispatchEvent(new window.Event('change'));
    assert.equal(resolveModelHostFilterLoadUnloadValue(actions), key('lm'));
    select.removeAttribute('id');
    assert.equal(resolveModelHostFilterLoadUnloadValue(actions), key('lm'), 'a settings picker works without a mounted global select');
    unmountAuxiliaryModelSelectCombobox(auxiliary);
  });
  test('pool entry selections keep entry IDs while favorites use their model binding', () => {
    select.replaceChildren();
    for (const [entryId, modelId] of [['entry-a', 'claude-medium'], ['entry-b', 'claude-high']]) {
      const option = document.createElement('option');
      option.value = entryId; option.text = modelId;
      option.dataset.providerId = 'cursor-agent-cli'; option.dataset.providerLabel = 'Cursor'; option.dataset.modelId = modelId;
      select.append(option);
    }
    render(); provider('cursor-agent-cli').click();
    assert.equal(menu.querySelectorAll('.model-browser-pane .model-select-option').length, 2);
    menu.querySelector<HTMLButtonElement>('.model-browser-pane .model-select-favorite')!.click();
    assert.deepEqual(readModelPickerPreferences().favorites, [encodeModelSelectKey('cursor-agent-cli', 'claude-medium')]);
    menu.querySelector<HTMLButtonElement>('.model-browser-pane .model-select-option')!.click();
    assert.deepEqual(picked, ['entry-a']);
  });
});

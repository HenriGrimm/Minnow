import '../tools/install-dom-before-imports.mts';
import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, test } from 'node:test';
import { encodeModelSelectKey } from '../../src/lib/model-select-key.ts';
import type { RouterConfig } from '../../src/models/routers.ts';
import { mountModelPoolBrowser, type ModelPoolBrowser } from '../../src/ui/model-pool-picker.ts';
import { leaveModelPoolPicker, mountModelPoolPickerHost, refreshModelPoolPicker } from '../../src/ui/model-pool-picker-host.ts';
import { getModelHostFilter, mountModelHostFilterBar, renderModelSelectMenuRows, setModelHostFilter, setModelSearchQuery } from '../../src/ui/model-select-picker.ts';
import { teardownHappyDomAsync } from '../os/dom-helpers.mts';

Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: window.localStorage });
const nativeFetch = globalThis.fetch;
after(async () => { globalThis.fetch = nativeFetch; await teardownHappyDomAsync(window); });
const key = encodeModelSelectKey;
const initial: RouterConfig = { revision: 3, defaultRouterId: null, routers: [
  { id: 'coding', name: 'Coding', enabled: true, policy: 'priority', entries: [
    { id: 'first', providerId: 'codex-cli', modelId: 'sol', enabled: true, concurrencyLimit: 1 },
    { id: 'second', providerId: 'cloud', modelId: 'sol', enabled: true, concurrencyLimit: 2 },
  ] },
  { id: 'paused', name: 'Experiments', enabled: false, policy: 'balance', entries: [
    { id: 'third', providerId: 'cloud', modelId: 'fast', enabled: true, concurrencyLimit: 1 },
  ] },
] };
const tick = () => new Promise(resolve => setTimeout(resolve, 20));

describe('pool browser and draft editor', { concurrency: false }, () => {
  let host: HTMLElement;
  let select: HTMLSelectElement;
  let browser: ModelPoolBrowser | undefined;
  let config: RouterConfig;
  let saves: RouterConfig[];
  let picks: string[];
  let query: string;
  let failure: string;
  let saveGate: Promise<void> | undefined;
  let editing: boolean;
  const button = (text: string): HTMLButtonElement => {
    const found = [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === text);
    assert.ok(found, `Missing button: ${text}`); return found;
  };
  const setInput = (label: string, value: string): void => {
    const input = host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
    input.value = value; input.dispatchEvent(new window.Event('input', { bubbles: true }));
  };
  beforeEach(() => {
    document.body.replaceChildren(); localStorage.clear();
    config = structuredClone(initial); saves = []; picks = []; query = ''; failure = ''; saveGate = undefined; editing = false;
    select = document.createElement('select'); select.id = 'modelSelect';
    for (const [providerId, modelId, label, provider] of [
      ['codex-cli', 'sol', 'Sol', 'Codex CLI'], ['cloud', 'sol', 'Sol', 'Cloud API'], ['cloud', 'fast', 'Fast', 'Cloud API'],
      ['minnow-library', 'gguf:test', 'Local coder', 'My Models'], ['minnow-router', 'coding', 'Coding', 'Model pools'],
    ]) {
      const option = document.createElement('option'); option.value = key(providerId, modelId);
      option.text = `${label} — ${provider}`; option.dataset.providerId = providerId; option.dataset.providerLabel = provider;
      select.append(option);
    }
    host = document.createElement('div'); document.body.append(select, host);
    globalThis.fetch = (async (url, init) => {
      if (!String(url).includes('/api/generations/routers')) return new Response('{}');
      if (init?.method === 'PUT') {
        if (saveGate) await saveGate;
        if (failure) return new Response(JSON.stringify({ error: failure }), { status: 400 });
        const next = JSON.parse(String(init.body)) as RouterConfig;
        assert.equal(next.revision, config.revision);
        saves.push(structuredClone(next)); config = { ...next, revision: next.revision + 1 };
      }
      return new Response(JSON.stringify(config), { headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
  });
  afterEach(() => { browser?.dispose(); browser = undefined; });
  async function mount(selected = key('codex-cli', 'sol')): Promise<void> {
    browser = mountModelPoolBrowser(host, { select: () => select, selectedValue: () => selected,
      query: () => query, pick: value => picks.push(value), onEditing: value => { editing = value; }, manage: () => {} });
    await tick();
  }

  test('inspects before choosing, preserves provider identity and selects a pool binding', async () => {
    await mount();
    assert.deepEqual(picks, []);
    assert.match(host.querySelector('.pool-picker-detail')?.textContent || '', /Codex CLI.*Cloud API/s);
    button('Use pool').click();
    assert.deepEqual(picks, [key('minnow-router', 'coding')]);
    host.querySelector<HTMLButtonElement>('[data-pool-id="paused"]')!.click();
    assert.ok(button('Use pool').disabled);
    assert.match(host.textContent || '', /paused.*Edit it to enable/s);
  });

  test('searches model and provider names and keeps keyboard inspection separate from selection', async () => {
    await mount();
    query = 'fast Cloud'; browser!.refreshSearch();
    assert.equal(host.querySelectorAll('[data-pool-id]').length, 1);
    assert.equal(host.querySelector('[data-pool-id]')?.getAttribute('data-pool-id'), 'paused');
    query = ''; browser!.refreshSearch();
    host.querySelector<HTMLButtonElement>('[data-pool-id="coding"]')!.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    assert.equal(host.querySelector('[aria-pressed="true"]')?.getAttribute('data-pool-id'), 'paused');
    assert.deepEqual(picks, []);
  });

  test('creates a draft seeded from the current model, prevents duplicates and saves before use', async () => {
    await mount(); button('New pool').click();
    assert.equal(editing, true);
    assert.equal(host.querySelectorAll('[data-entry-id]').length, 1);
    button('Save & use').click(); assert.match(host.textContent || '', /Give your pool a name/);
    setInput('Pool name', 'New coding'); button('+ Add models').click();
    const existing = [...host.querySelectorAll<HTMLButtonElement>('.pool-picker-catalog-row')].find(row => row.textContent?.includes('Codex CLI'))!;
    assert.ok(existing.disabled);
    assert.equal(host.querySelectorAll('.pool-picker-catalog-row').length, 4, 'pools cannot be added to pools');
    [...host.querySelectorAll<HTMLButtonElement>('.pool-picker-catalog-row')].find(row => row.textContent?.includes('Cloud API'))!.click();
    button('Done').click();
    assert.equal(saves.length, 0, 'draft changes never autosave');
    button('Save & use').click(); await tick();
    assert.equal(saves[0].routers.length, 3);
    assert.equal(saves[0].routers[2].entries.length, 2);
    assert.deepEqual(picks, [key('minnow-router', saves[0].routers[2].id)]);
    assert.equal(select.querySelector('option:last-child')?.value, picks[0], 'saved pool is in the shared picker');
  });

  test('saving an edit preserves other pools and does not select it', async () => {
    await mount(); button('Edit').click(); setInput('Pool name', 'Renamed');
    host.querySelector<HTMLButtonElement>('[aria-label="Actions for rank 1"]')!.click();
    document.querySelector<HTMLButtonElement>('.mn-menu [data-id="down"]')!.click();
    setInput('Concurrent slots for Sol', '4');
    button('Save').click(); await tick();
    assert.equal(saves[0].routers[0].name, 'Renamed');
    assert.equal(saves[0].routers[0].entries[0].id, 'second');
    assert.deepEqual(saves[0].routers[1], initial.routers[1]);
    assert.deepEqual(picks, []);
  });

  test('retains failed drafts, blocks stale writes, and confirms before reloading', async () => {
    await mount(); button('Edit').click(); setInput('Pool name', 'My draft');
    failure = 'Model pools changed in another window. Reload before saving.';
    button('Save & use').click(); await tick();
    assert.match(host.textContent || '', /changed in another window/);
    assert.equal(host.querySelector<HTMLInputElement>('[aria-label="Pool name"]')!.value, 'My draft');
    assert.deepEqual(picks, []);
    button('Reload pools').click(); assert.match(host.textContent || '', /Discard unsaved changes/);
    button('Keep editing').click(); assert.equal(editing, true);
    button('Reload pools').click(); button('Discard changes').click(); await tick();
    assert.equal(editing, false); assert.match(host.textContent || '', /Coding/);
  });

  test('disallows dismissal and repeat submission during a save, and ignores late results after disposal', async () => {
    let release!: () => void; saveGate = new Promise(resolve => { release = resolve; });
    await mount(); button('Edit').click(); setInput('Pool name', 'Saving'); button('Save & use').click();
    assert.equal(browser!.requestLeave(() => assert.fail('cannot leave during save')), false);
    assert.ok(button('Save & use').disabled);
    browser!.dispose(); release(); await tick();
    assert.equal(saves.length, 1); assert.deepEqual(picks, []);
  });

  test('keeps missing entries and evaluator IDs editable, with tiers for Auto pools', async () => {
    config.routers[0].policy = 'evaluate'; config.routers[0].evaluator = { providerId: 'old', modelId: 'unlisted-judge' };
    config.routers[0].entries[0].modelId = 'unlisted-model';
    await mount(); button('Edit').click();
    const evaluator = host.querySelector<HTMLSelectElement>('[aria-label="Task evaluator"]')!;
    assert.equal(evaluator.value, key('old', 'unlisted-judge'));
    assert.match(host.textContent || '', /Not in current catalog/);
    assert.equal(host.querySelectorAll('.pool-picker-tier').length, 2);
    const taskTypes = host.querySelector('[aria-label="Task types for rank 1"]')!;
    taskTypes.querySelector<HTMLButtonElement>('.router-task-types__trigger')!.click();
    taskTypes.querySelector<HTMLInputElement>('[value="ux-design"]')!.click();
    taskTypes.querySelector<HTMLInputElement>('[value="coding"]')!.click();
    assert.equal(taskTypes.querySelector<HTMLButtonElement>('.router-task-types__any')?.getAttribute('aria-pressed'), 'false');
    assert.equal(host.querySelector('.pool-picker-entry-identity .router-task-types'), null, 'assignments have their own row');
    taskTypes.querySelector<HTMLButtonElement>('.router-task-types__done')!.click();
    button('Save').click(); await tick();
    assert.equal(saves[0].routers[0].entries[0].modelId, 'unlisted-model');
    assert.equal(saves[0].routers[0].evaluator?.modelId, 'unlisted-judge');
    assert.deepEqual(saves[0].routers[0].entries[0].taskTypes, ['coding', 'ux-design']);
  });

  test('shows specialties in pool previews and search, and Any task clears all assignments', async () => {
    config.routers[0].policy = 'evaluate';
    config.routers[0].entries[0].taskTypes = ['coding', 'ux-design'];
    await mount();
    assert.match(host.querySelector('.pool-picker-preview')?.textContent || '', /Coder.*UX Design/s);
    query = 'UX Design'; browser!.refreshSearch();
    assert.equal(host.querySelectorAll('[data-pool-id]').length, 1);
    button('Edit').click();
    const group = host.querySelector('[aria-label="Task types for rank 1"]')!;
    group.querySelector<HTMLButtonElement>('.router-task-types__trigger')!.click();
    group.querySelector<HTMLButtonElement>('.router-task-types__any')!.click();
    assert.equal(group.querySelectorAll('input:checked').length, 0);
    assert.equal(group.querySelector('.router-task-types__any')?.getAttribute('aria-pressed'), 'true');
    group.querySelector<HTMLButtonElement>('.router-task-types__done')!.click();
    button('Save').click(); await tick();
    assert.equal(saves[0].routers[0].entries[0].taskTypes, undefined);
    query = ''; browser!.refreshSearch();
    assert.match(host.querySelector('.pool-picker-preview .router-task-badges')?.textContent || '', /Any task/);
  });

  test('task pickers dismiss on Escape and release their overlay when the editor is removed', async () => {
    config.routers[0].policy = 'evaluate';
    await mount(); button('Edit').click();
    const group = host.querySelector('[aria-label="Task types for rank 1"]')!;
    const trigger = group.querySelector<HTMLButtonElement>('.router-task-types__trigger')!;
    const popup = group.querySelector<HTMLElement>('.router-task-popover')!;
    trigger.click(); assert.equal(trigger.getAttribute('aria-expanded'), 'true');
    popup.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(popup.hidden, true);
    assert.equal(document.activeElement, trigger);
    trigger.click(); browser!.dispose();
    assert.equal(popup.hidden, true);
    assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  });

  test('protects draft dismissal and confirms deletion without removing models', async () => {
    await mount(); button('Edit').click(); setInput('Pool name', 'Draft');
    let left = false;
    assert.equal(browser!.requestLeave(() => { left = true; }), false);
    button('Keep editing').click(); assert.equal(left, false);
    button('Delete pool').click(); assert.equal(saves.length, 0);
    button('Delete pool permanently').click(); await tick();
    assert.deepEqual(saves[0].routers.map(pool => pool.id), ['paused']);
    assert.ok([...select.options].some(option => option.value === key('codex-cli', 'sol')));
  });

  test('mounts a separate Pools view without changing the host filter and guards switching tabs', async () => {
    setModelHostFilter('local'); setModelSearchQuery('');
    const panel = host; const menu = document.createElement('ul'); panel.append(menu);
    const render = () => renderModelSelectMenuRows(menu, select, value => picks.push(value));
    const filterBar = mountModelHostFilterBar(panel, render);
    mountModelPoolPickerHost({ panel, menu, filterBar, select: () => select, selectedValue: () => select.value,
      query: () => '', pick: value => picks.push(value), renderModels: render, closeMenu: () => {} });
    filterBar.querySelector<HTMLButtonElement>('.model-pool-tab')!.click(); await tick(); await tick();
    assert.equal(getModelHostFilter(), 'local');
    assert.equal(refreshModelPoolPicker(menu), true);
    button('Edit').click(); setInput('Pool name', 'Unsaved');
    filterBar.querySelector<HTMLButtonElement>('[data-filter="cloud"]')!.click();
    assert.equal(getModelHostFilter(), 'local');
    button('Keep editing').click();
    filterBar.querySelector<HTMLButtonElement>('[data-filter="cloud"]')!.click(); button('Discard changes').click();
    assert.equal(getModelHostFilter(), 'cloud');
    assert.equal(panel.classList.contains('is-browsing-pools'), false);
    assert.equal(leaveModelPoolPicker(panel, () => {}), true);
  });

  test('removing a picker disposes a pending save without selecting into another surface', async () => {
    let release!: () => void; saveGate = new Promise(resolve => { release = resolve; });
    const panel = host; const menu = document.createElement('ul'); panel.append(menu);
    const filterBar = mountModelHostFilterBar(panel, () => {});
    mountModelPoolPickerHost({ panel, menu, filterBar, select: () => select, selectedValue: () => select.value,
      query: () => '', pick: value => picks.push(value), renderModels: () => {}, closeMenu: () => {} });
    filterBar.querySelector<HTMLButtonElement>('.model-pool-tab')!.click(); await tick(); await tick();
    button('Edit').click(); setInput('Pool name', 'Pending save'); button('Save & use').click();
    panel.remove(); await tick(); release(); await tick();
    assert.equal(saves.length, 1);
    assert.deepEqual(picks, []);
    assert.equal(refreshModelPoolPicker(menu), false);
  });
});

import '../tools/install-dom-before-imports.mts';
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { bindShellOverlayTrigger, closeShellOverlay, isShellOverlayOpen, openShellOverlay } from '../../src/ui/shell-overlay-state.ts';
import type { RouterConfig } from '../../src/models/routers.ts';

let pools: RouterConfig = { revision: 1, defaultRouterId: null, routers: [{
  id: 'auto', name: 'Everyday work', policy: 'evaluate', enabled: true, entries: [
    { id: 'coder', providerId: 'cloud', modelId: 'coder', enabled: true, concurrencyLimit: 1, taskTypes: ['coding', 'ux-design'], tier: 'frontier' },
    { id: 'general', providerId: 'cloud', modelId: 'general', enabled: true, concurrencyLimit: 1 },
  ],
}] };
mock.module('../../src/models/routers.ts', { namedExports: {
  getRouterConfigSync: () => pools,
  loadRouterConfig: async () => pools,
} });

let disposed = 0;
mock.module('../../src/ui/routing-form.ts', { namedExports: {
  mountRoutingForm: (host: HTMLElement) => {
    host.append(document.createElement('select'));
    return { dispose: () => { disposed++; } };
  },
} });
const openedSections: string[] = [];
mock.module('../../src/ui/models-page.ts', { namedExports: {
  openModels: (section: string) => { openedSections.push(section); },
} });
const { openModelsPopover } = await import('../../src/ui/models-popover.ts');

test('Manage models and Manage pools open their own sections and dismiss the popover', async () => {
  const trigger = document.createElement('button'); document.body.append(trigger);
  try {
    for (const [selector, section] of [
      ['.models-system__footer button', 'installed'],
      ['.models-system__edit-pools', 'routers'],
    ]) {
      openedSections.length = 0;
      const close = openModelsPopover(trigger);
      try {
        document.querySelector<HTMLButtonElement>(selector)!.click();
        await new Promise(resolve => setTimeout(resolve, 0));
        assert.deepEqual(openedSections, [section]);
        assert.equal(document.querySelector('#modelsSystemPopover'), null);
        assert.equal(isShellOverlayOpen('models'), false);
        assert.equal(document.activeElement, trigger);
      } finally { close(); }
    }
  } finally { trigger.remove(); }
});

test('Models shows pool coverage and per-model assignments, and refreshes while open', async () => {
  const trigger = document.createElement('button'); document.body.append(trigger);
  const close = openModelsPopover(trigger);
  try {
    const overview = document.querySelector<HTMLElement>('[aria-label="Pool task assignments"]')!;
    assert.match(overview.textContent || '', /Everyday work.*Match the task.*2 models/s);
    const card = overview.querySelector<HTMLDetailsElement>('[data-pool-id="auto"]')!;
    assert.match(card.querySelector('summary')?.textContent || '', /Coder.*UX Design.*Any task/s);
    card.open = true;
    card.dispatchEvent(new window.Event('toggle'));
    assert.match(card.querySelector('li')?.textContent || '', /Frontier tier.*Coder.*UX Design/s);
    pools = structuredClone(pools); pools.routers[0].name = 'Design work';
    window.dispatchEvent(new window.Event('minnow-routers-changed'));
    assert.match(overview.textContent || '', /Design work/);
    assert.equal(overview.querySelector('details')?.open, true, 'live updates retain expansion');
    assert.ok(overview.querySelector('.models-system__edit-pools'));
  } finally { close(); trigger.remove(); }
});

test('Models preserves nested picker dismissal, tracks mounted preview occlusion and restores trigger focus', () => {
  disposed = 0;
  const trigger = document.createElement('button'); document.body.append(trigger);
  const unbind = bindShellOverlayTrigger(trigger, 'models');
  try {
    const close = openModelsPopover(trigger);
    const panel = document.querySelector<HTMLElement>('#modelsSystemPopover')!;
    assert.equal(isShellOverlayOpen('models'), true);
    assert.equal(panel.isConnected, true);
    assert.equal(panel.classList.contains('mn-occludes-preview'), true);
    assert.equal(panel.getAttribute('data-occluder-kind'), 'panel');
    assert.equal(panel.hidden, false);
    assert.equal(trigger.getAttribute('aria-expanded'), 'true');
    const picker = document.createElement('div'); picker.className = 'auxiliary-model-popover'; panel.append(picker);
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    assert.equal(isShellOverlayOpen('models'), true, 'Escape stays with the nested picker');
    picker.remove();
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    assert.equal(isShellOverlayOpen('models'), false);
    assert.equal(panel.isConnected, false);
    assert.equal(document.querySelector('#modelsSystemPopover'), null);
    assert.equal(document.activeElement, trigger);
    assert.equal(disposed, 1);
    close(); assert.equal(disposed, 1);
    openModelsPopover(trigger);
    openShellOverlay('other', () => {});
    assert.equal(disposed, 2);
    assert.equal(document.querySelector('#modelsSystemPopover'), null);
  } finally { closeShellOverlay(); unbind(); trigger.remove(); }
});

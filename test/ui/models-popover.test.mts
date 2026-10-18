import '../tools/install-dom-before-imports.mts';
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { bindShellOverlayTrigger, closeShellOverlay, isShellOverlayOpen, openShellOverlay } from '../../src/ui/shell-overlay-state.ts';
import { isChromePopoverOpen, resetChromePopoverRegistryForTests } from '../../src/ui/preview-electron-visibility.ts';

let disposed = 0;
mock.module('../../src/ui/routing-form.ts', { namedExports: {
  mountRoutingForm: (host: HTMLElement) => {
    host.append(document.createElement('select'));
    return { dispose: () => { disposed++; } };
  },
} });
const { openModelsPopover } = await import('../../src/ui/models-popover.ts');

test('Models preserves nested picker dismissal, balances chrome registration and restores trigger focus', () => {
  resetChromePopoverRegistryForTests();
  const trigger = document.createElement('button'); document.body.append(trigger);
  const unbind = bindShellOverlayTrigger(trigger, 'models');
  try {
    const close = openModelsPopover(trigger);
    const panel = document.querySelector<HTMLElement>('#modelsSystemPopover')!;
    assert.equal(isShellOverlayOpen('models'), true);
    assert.equal(isChromePopoverOpen(), true);
    assert.equal(trigger.getAttribute('aria-expanded'), 'true');
    const picker = document.createElement('div'); picker.className = 'auxiliary-model-popover'; panel.append(picker);
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    assert.equal(isShellOverlayOpen('models'), true, 'Escape stays with the nested picker');
    picker.remove();
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    assert.equal(isShellOverlayOpen('models'), false);
    assert.equal(isChromePopoverOpen(), false);
    assert.equal(document.activeElement, trigger);
    assert.equal(disposed, 1);
    close(); assert.equal(disposed, 1);
    openModelsPopover(trigger);
    openShellOverlay('other', () => {});
    assert.equal(disposed, 2);
    assert.equal(document.querySelector('#modelsSystemPopover'), null);
    assert.equal(isChromePopoverOpen(), false);
  } finally { closeShellOverlay(); unbind(); trigger.remove(); resetChromePopoverRegistryForTests(); }
});

/**
 * Shared tooltip: delay on hover, immediate on keyboard focus, ARIA wiring.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, mock, test } from 'node:test';

import {
  attachTooltip,
  getTooltipText,
  resetTooltipForTests,
  setTooltip,
  TOOLTIP_DELAY_MS,
} from '../../../src/ui/components/tooltip';
import { installComponentDom, type ComponentDom } from './component-dom.mts';

describe('tooltip', () => {
  let dom: ComponentDom;

  afterEach(() => {
    mock.timers.reset();
    resetTooltipForTests();
    dom?.cleanup();
  });

  function setup(): HTMLButtonElement {
    dom = installComponentDom();
    const button = dom.doc.createElement('button');
    button.textContent = 'Save';
    button.title = 'native title';
    dom.doc.body.appendChild(button);
    return button;
  }

  function tooltip(): HTMLElement | null {
    return dom.doc.querySelector<HTMLElement>('.mn-tooltip');
  }

  test('keyboard focus shows the tooltip at once and links it with aria-describedby', () => {
    const button = setup();
    attachTooltip(button, 'Save changes (Ctrl+S)');
    assert.equal(button.hasAttribute('title'), false, 'native title removed');

    button.focus();
    const tip = tooltip();
    assert.ok(tip);
    assert.equal(tip.hidden, false);
    assert.equal(tip.getAttribute('role'), 'tooltip');
    assert.equal(tip.textContent, 'Save changes (Ctrl+S)');
    assert.equal(button.getAttribute('aria-describedby'), tip.id);
    assert.equal(tip.classList.contains('mn-occludes-preview'), true);

    button.blur();
    assert.equal(tip.hidden, true);
    assert.equal(button.hasAttribute('aria-describedby'), false);
  });

  test('hover waits for the delay and leaving cancels it', () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const button = setup();
    attachTooltip(button, 'Save');

    dom.pointer(button, 'pointerenter');
    assert.equal(tooltip()?.hidden ?? true, true, 'not shown before the delay');
    mock.timers.tick(TOOLTIP_DELAY_MS);
    assert.equal(tooltip()?.hidden, false, 'shown after the delay');

    dom.pointer(button, 'pointerleave');
    assert.equal(tooltip()?.hidden, true);

    dom.pointer(button, 'pointerenter');
    dom.pointer(button, 'pointerleave');
    mock.timers.tick(TOOLTIP_DELAY_MS);
    assert.equal(tooltip()?.hidden, true, 'a cancelled hover never shows');
  });

  test('touch pointers never show a tooltip', () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const button = setup();
    attachTooltip(button, 'Save');
    dom.pointer(button, 'pointerenter', { pointerType: 'touch' });
    mock.timers.tick(TOOLTIP_DELAY_MS * 2);
    assert.equal(tooltip()?.hidden ?? true, true);
  });

  test('Escape hides it', () => {
    const button = setup();
    attachTooltip(button, 'Save');
    button.focus();
    assert.equal(tooltip()?.hidden, false);
    dom.key(button, 'Escape');
    assert.equal(tooltip()?.hidden, true);
  });

  test('text equal to the aria-label is shown without a duplicate description', () => {
    const button = setup();
    button.setAttribute('aria-label', 'Close');
    attachTooltip(button, 'Close');
    button.focus();
    assert.equal(tooltip()?.textContent, 'Close');
    assert.equal(button.hasAttribute('aria-describedby'), false);
  });

  test('setTooltip updates the visible text; detach removes listeners', () => {
    const button = setup();
    const detach = attachTooltip(button, 'One');
    button.focus();
    setTooltip(button, 'Two');
    assert.equal(tooltip()?.textContent, 'Two');
    assert.equal(getTooltipText(button), 'Two');

    detach();
    assert.equal(tooltip()?.hidden, true);
    assert.equal(getTooltipText(button), null);
    button.blur();
    button.focus();
    assert.equal(tooltip()?.hidden, true, 'no longer reacts to focus');
  });
});

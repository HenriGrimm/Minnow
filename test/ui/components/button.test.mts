/**
 * Shared button: defaults, variants, toggle, busy, icon-only naming.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

import {
  createButton,
  createIconButton,
  setButtonBusy,
  setButtonLabel,
  setButtonPressed,
} from '../../../src/ui/components/button';
import { getTooltipText, resetTooltipForTests } from '../../../src/ui/components/tooltip';
import { installComponentDom, type ComponentDom } from './component-dom.mts';

describe('button', () => {
  let dom: ComponentDom;

  afterEach(() => {
    resetTooltipForTests();
    dom?.cleanup();
  });

  test('defaults to a secondary, medium, non-submitting button', () => {
    dom = installComponentDom();
    const button = createButton({ label: 'Save' });
    assert.equal(button.type, 'button');
    assert.equal(button.className, 'mn-btn mn-btn--secondary mn-btn--md');
    assert.equal(button.querySelector('.mn-btn__label')?.textContent, 'Save');
  });

  test('variants, sizes, block and extra classes map to classes', () => {
    dom = installComponentDom();
    for (const variant of ['primary', 'secondary', 'ghost', 'danger'] as const) {
      for (const size of ['sm', 'md', 'lg'] as const) {
        const button = createButton({ label: 'x', variant, size });
        assert.equal(button.classList.contains(`mn-btn--${variant}`), true);
        assert.equal(button.classList.contains(`mn-btn--${size}`), true);
      }
    }
    const block = createButton({ label: 'x', block: true, className: 'a b' });
    assert.equal(block.classList.contains('mn-btn--block'), true);
    assert.equal(block.classList.contains('a') && block.classList.contains('b'), true);
  });

  test('icons render before and after the label; icon-only gets the square modifier', () => {
    dom = installComponentDom();
    const both = createButton({ label: 'Open', icon: 'folder', iconEnd: 'chevronDown' });
    const icons = both.querySelectorAll('.mn-btn__icon');
    assert.equal(icons.length, 2);
    assert.equal(both.firstElementChild === icons[0], true);
    assert.equal(icons[1].classList.contains('mn-btn__icon--end'), true);
    assert.equal(both.classList.contains('mn-btn--icon'), false);

    const iconOnly = createButton({ icon: 'plus', ariaLabel: 'Add' });
    assert.equal(iconOnly.classList.contains('mn-btn--icon'), true);
  });

  test('pressed makes a toggle button', () => {
    dom = installComponentDom();
    const button = createButton({ label: 'Wrap', pressed: false });
    assert.equal(button.getAttribute('aria-pressed'), 'false');
    setButtonPressed(button, true);
    assert.equal(button.getAttribute('aria-pressed'), 'true');
    assert.equal(createButton({ label: 'Plain' }).hasAttribute('aria-pressed'), false);
  });

  test('icon buttons are named by their label and show it as a tooltip', () => {
    dom = installComponentDom();
    const button = createIconButton({ icon: 'close', label: 'Close panel' });
    assert.equal(button.getAttribute('aria-label'), 'Close panel');
    assert.equal(button.classList.contains('mn-btn--ghost'), true, 'ghost by default');
    assert.equal(button.classList.contains('mn-btn--icon'), true);
    assert.equal(getTooltipText(button), 'Close panel');

    const quiet = createIconButton({ icon: 'close', label: 'Close', tooltip: false });
    assert.equal(getTooltipText(quiet), null);

    setButtonLabel(button, 'Close inspector');
    assert.equal(button.getAttribute('aria-label'), 'Close inspector');
    assert.equal(getTooltipText(button), 'Close inspector');
  });

  test('setButtonLabel changes visible text on labelled buttons', () => {
    dom = installComponentDom();
    const button = createButton({ label: 'Run' });
    setButtonLabel(button, 'Running');
    assert.equal(button.querySelector('.mn-btn__label')?.textContent, 'Running');
    assert.equal(button.hasAttribute('aria-label'), false);
  });

  test('busy disables and restores the previous disabled state', () => {
    dom = installComponentDom();
    const button = createButton({ label: 'Save' });
    setButtonBusy(button, true);
    assert.equal(button.disabled, true);
    assert.equal(button.getAttribute('aria-busy'), 'true');
    assert.equal(button.classList.contains('mn-btn--busy'), true);
    setButtonBusy(button, false);
    assert.equal(button.disabled, false);
    assert.equal(button.hasAttribute('aria-busy'), false);

    const disabled = createButton({ label: 'Save', disabled: true });
    setButtonBusy(disabled, true);
    setButtonBusy(disabled, false);
    assert.equal(disabled.disabled, true, 'stays disabled');
  });

  test('onClick fires only while enabled', () => {
    dom = installComponentDom();
    let clicks = 0;
    const button = createButton({ label: 'Go', onClick: () => clicks++ });
    dom.doc.body.appendChild(button);
    button.click();
    assert.equal(clicks, 1);
    button.disabled = true;
    button.click();
    assert.equal(clicks, 1);
  });
});

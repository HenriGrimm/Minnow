/**
 * Component internals: focusable discovery, Tab trapping, attribute tokens.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

import {
  addAttributeToken,
  focusableWithin,
  markOverlayRoot,
  removeAttributeToken,
  trapTabKey,
} from '../../../src/ui/components/internal';
import { installComponentDom, type ComponentDom } from './component-dom.mts';

describe('component internals', () => {
  let dom: ComponentDom;

  afterEach(() => dom?.cleanup());

  function buildPanel(): { panel: HTMLElement; first: HTMLButtonElement; last: HTMLButtonElement } {
    const panel = dom.doc.createElement('div');
    panel.innerHTML = `
      <button id="first">First</button>
      <button disabled>Disabled</button>
      <div hidden><button>Hidden</button></div>
      <span tabindex="-1">Skipped</span>
      <input type="hidden">
      <button id="last">Last</button>`;
    dom.doc.body.appendChild(panel);
    return {
      panel,
      first: panel.querySelector('#first')!,
      last: panel.querySelector('#last')!,
    };
  }

  test('focusableWithin skips disabled, hidden and tabindex=-1 nodes', () => {
    dom = installComponentDom();
    const { panel } = buildPanel();
    assert.deepEqual(focusableWithin(panel).map((el) => el.id), ['first', 'last']);
  });

  test('trapTabKey wraps Tab from the last node and Shift+Tab from the first', () => {
    dom = installComponentDom();
    const { panel, first, last } = buildPanel();
    const listener = (event: KeyboardEvent) => trapTabKey(panel, event);
    dom.doc.addEventListener('keydown', listener);

    last.focus();
    const forward = dom.key(last, 'Tab');
    assert.equal(forward.defaultPrevented, true);
    assert.equal(dom.doc.activeElement === first, true);

    const backward = dom.key(first, 'Tab', { shiftKey: true });
    assert.equal(backward.defaultPrevented, true);
    assert.equal(dom.doc.activeElement === last, true);

    first.focus();
    const middle = dom.key(first, 'Tab');
    assert.equal(middle.defaultPrevented, false);
  });

  test('attribute tokens add once and remove cleanly', () => {
    dom = installComponentDom();
    const el = dom.doc.createElement('button');
    addAttributeToken(el, 'aria-describedby', 'a');
    addAttributeToken(el, 'aria-describedby', 'b');
    addAttributeToken(el, 'aria-describedby', 'a');
    assert.equal(el.getAttribute('aria-describedby'), 'a b');
    removeAttributeToken(el, 'aria-describedby', 'a');
    assert.equal(el.getAttribute('aria-describedby'), 'b');
    removeAttributeToken(el, 'aria-describedby', 'b');
    assert.equal(el.hasAttribute('aria-describedby'), false);
  });

  test('markOverlayRoot opts the root out of shell outside-click handling and marks it an occluder', () => {
    dom = installComponentDom();
    const el = dom.doc.createElement('div');
    markOverlayRoot(el, 'menu');
    assert.equal(el.hasAttribute('data-above-shell-overlay'), true);
    assert.equal(el.classList.contains('mn-occludes-preview'), true);
    assert.equal(el.dataset.occluderKind, 'menu');
  });
});

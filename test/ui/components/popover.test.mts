/**
 * Shared popover: anchor wiring, dismissal, nesting and toggling.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

import {
  closeAllPopovers,
  isPopoverOpen,
  openPopover,
  togglePopover,
  type PopoverCloseReason,
} from '../../../src/ui/components/popover';
import { installComponentDom, type ComponentDom } from './component-dom.mts';

describe('popover', () => {
  let dom: ComponentDom;

  afterEach(() => {
    closeAllPopovers();
    dom?.cleanup();
  });

  function setup() {
    dom = installComponentDom();
    const anchor = dom.doc.createElement('button');
    anchor.textContent = 'Filters';
    const outside = dom.doc.createElement('div');
    dom.doc.body.append(anchor, outside);
    const content = () => {
      const el = dom.doc.createElement('div');
      el.innerHTML = '<button class="inner">Apply</button>';
      return el;
    };
    return { anchor, outside, content };
  }

  test('opening wires the anchor, focuses the first control and marks the overlay', () => {
    const { anchor, content } = setup();
    anchor.focus();
    const handle = openPopover({ anchor, content: content(), ariaLabel: 'Filters' });
    assert.equal(handle.isOpen(), true);
    assert.equal(anchor.getAttribute('aria-expanded'), 'true');
    assert.equal(anchor.getAttribute('aria-controls'), handle.root.id);
    assert.equal(handle.root.getAttribute('role'), 'dialog');
    assert.equal(handle.root.getAttribute('aria-label'), 'Filters');
    assert.equal(handle.root.classList.contains('mn-occludes-preview'), true);
    assert.equal(handle.root.hasAttribute('data-above-shell-overlay'), true);
    assert.equal(dom.doc.activeElement === handle.root.querySelector('.inner'), true);
  });

  test('Escape closes and returns focus to the anchor', () => {
    const { anchor, content } = setup();
    const reasons: PopoverCloseReason[] = [];
    const handle = openPopover({ anchor, content: content(), onClose: (reason) => reasons.push(reason) });
    const event = dom.key(handle.root.querySelector('.inner')!, 'Escape');
    assert.equal(event.defaultPrevented, true);
    assert.equal(handle.isOpen(), false);
    assert.equal(handle.root.isConnected, false);
    assert.equal(anchor.getAttribute('aria-expanded'), 'false');
    assert.equal(anchor.hasAttribute('aria-controls'), false);
    assert.equal(dom.doc.activeElement === anchor, true);
    assert.deepEqual(reasons, ['escape']);
  });

  test('outside pointerdown closes; inside and anchor presses do not', () => {
    const { anchor, outside, content } = setup();
    const reasons: PopoverCloseReason[] = [];
    const handle = openPopover({ anchor, content: content(), onClose: (reason) => reasons.push(reason) });
    dom.pointer(handle.root.querySelector('.inner')!, 'pointerdown');
    dom.pointer(anchor, 'pointerdown');
    assert.equal(handle.isOpen(), true);
    dom.pointer(outside, 'pointerdown');
    assert.equal(handle.isOpen(), false);
    assert.deepEqual(reasons, ['outside']);
  });

  test('a press inside a nested popover keeps its parent open; Escape closes only the top', () => {
    const { anchor, outside, content } = setup();
    const parent = openPopover({ anchor, content: content() });
    const childAnchor = parent.root.querySelector<HTMLButtonElement>('.inner')!;
    const child = openPopover({ anchor: childAnchor, content: content() });

    dom.pointer(child.root.querySelector('.inner')!, 'pointerdown');
    assert.equal(parent.isOpen() && child.isOpen(), true);

    dom.key(child.root, 'Escape');
    assert.equal(child.isOpen(), false);
    assert.equal(parent.isOpen(), true);

    openPopover({ anchor: childAnchor, content: content() });
    dom.pointer(outside, 'pointerdown');
    assert.equal(isPopoverOpen(), false, 'outside press closes the whole stack');
  });

  test('menus and tooltips count as inside', () => {
    const { anchor, content } = setup();
    const handle = openPopover({ anchor, content: content() });
    const menu = dom.doc.createElement('div');
    menu.className = 'mn-menu';
    dom.doc.body.appendChild(menu);
    dom.pointer(menu, 'pointerdown');
    assert.equal(handle.isOpen(), true);
    dom.key(handle.root, 'Escape');
    assert.equal(handle.isOpen(), true, 'Escape belongs to the open menu first');
  });

  test('togglePopover closes the open popover for the same anchor', () => {
    const { anchor, content } = setup();
    const first = togglePopover({ anchor, content: content() });
    assert.ok(first);
    const second = togglePopover({ anchor, content: content() });
    assert.equal(second, null);
    assert.equal(first.isOpen(), false);
    assert.equal(isPopoverOpen(), false);
  });

  test('opening again on the same anchor replaces the open popover', () => {
    const { anchor, content } = setup();
    const first = openPopover({ anchor, content: content(), initialFocus: 'none' });
    const second = openPopover({ anchor, content: content(), initialFocus: 'none' });
    assert.equal(first.isOpen(), false);
    assert.equal(second.isOpen(), true);
    assert.equal(dom.doc.querySelectorAll('.mn-popover').length, 1);
  });
});

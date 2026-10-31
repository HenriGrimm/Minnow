/**
 * Shared switch: checkbox semantics with role="switch".
 */

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

import { createSwitch } from '../../../src/ui/components/switch';
import { installComponentDom, type ComponentDom } from './component-dom.mts';

describe('switch', () => {
  let dom: ComponentDom;

  afterEach(() => dom?.cleanup());

  test('is a checkbox with role="switch" inside a label', () => {
    dom = installComponentDom();
    const { root, input } = createSwitch({ id: 'wrap', name: 'wrap', ariaLabel: 'Wrap lines' });
    assert.equal(root.tagName, 'LABEL');
    assert.equal(root.className, 'mn-switch mn-switch--md');
    assert.equal(input.type, 'checkbox');
    assert.equal(input.getAttribute('role'), 'switch');
    assert.equal(input.id, 'wrap');
    assert.equal(input.name, 'wrap');
    assert.equal(input.getAttribute('aria-label'), 'Wrap lines');
    assert.equal(root.querySelector('.mn-switch__track .mn-switch__thumb') != null, true);
  });

  test('reflects checked, disabled, size and ARIA references', () => {
    dom = installComponentDom();
    const { root, input } = createSwitch({
      checked: true,
      disabled: true,
      size: 'sm',
      labelledBy: 'title',
      describedBy: 'hint',
    });
    assert.equal(input.checked, true);
    assert.equal(input.disabled, true);
    assert.equal(root.classList.contains('mn-switch--sm'), true);
    assert.equal(input.getAttribute('aria-labelledby'), 'title');
    assert.equal(input.getAttribute('aria-describedby'), 'hint');
  });

  test('onChange receives the new state', () => {
    dom = installComponentDom();
    const seen: boolean[] = [];
    const { root, input } = createSwitch({ onChange: (checked) => seen.push(checked) });
    dom.doc.body.appendChild(root);
    input.click();
    input.click();
    assert.deepEqual(seen, [true, false]);
  });
});

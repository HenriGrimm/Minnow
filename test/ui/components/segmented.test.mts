/**
 * Shared segmented control: radio-group semantics and keyboard model.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

import { createSegmentedControl } from '../../../src/ui/components/segmented';
import { installComponentDom, type ComponentDom } from './component-dom.mts';

describe('segmented control', () => {
  let dom: ComponentDom;

  afterEach(() => dom?.cleanup());

  function setup(onChange?: (value: string) => void) {
    dom = installComponentDom();
    const handle = createSegmentedControl({
      ariaLabel: 'View',
      value: 'list',
      options: [
        { value: 'list', label: 'List' },
        { value: 'board', label: 'Board', disabled: true },
        { value: 'graph', label: 'Graph', icon: 'boardView', iconOnly: true },
      ],
      onChange,
    });
    dom.doc.body.appendChild(handle.root);
    const option = (value: string) => handle.root.querySelector<HTMLButtonElement>(`[data-value="${value}"]`)!;
    return { handle, option };
  }

  test('is a radio group with one tab stop on the selected option', () => {
    const { handle, option } = setup();
    assert.equal(handle.root.getAttribute('role'), 'radiogroup');
    assert.equal(handle.root.getAttribute('aria-label'), 'View');
    assert.equal(option('list').getAttribute('role'), 'radio');
    assert.equal(option('list').getAttribute('aria-checked'), 'true');
    assert.equal(option('graph').getAttribute('aria-checked'), 'false');
    assert.deepEqual(
      [...handle.root.querySelectorAll('button')].map((b) => (b as HTMLButtonElement).tabIndex),
      [0, -1, -1],
    );
    assert.equal(option('graph').querySelector('.mn-segmented__label')?.classList.contains('visually-hidden'), true);
  });

  test('arrow keys skip disabled options, select and fire onChange', () => {
    const seen: string[] = [];
    const { handle, option } = setup((value) => seen.push(value));
    option('list').focus();
    dom.key(option('list'), 'ArrowRight');
    assert.equal(handle.getValue(), 'graph');
    assert.equal(dom.doc.activeElement === option('graph'), true);
    assert.equal(option('graph').tabIndex, 0);
    dom.key(option('graph'), 'ArrowRight');
    assert.equal(handle.getValue(), 'list', 'wraps around');
    dom.key(option('list'), 'End');
    assert.equal(handle.getValue(), 'graph');
    dom.key(option('graph'), 'Home');
    assert.equal(handle.getValue(), 'list');
    assert.deepEqual(seen, ['graph', 'list', 'graph', 'list']);
  });

  test('clicking selects; setValue can be silent; disabled options ignore clicks', () => {
    const seen: string[] = [];
    const { handle, option } = setup((value) => seen.push(value));
    option('graph').click();
    assert.equal(handle.getValue(), 'graph');
    handle.setValue('list', { silent: true });
    assert.equal(handle.getValue(), 'list');
    handle.setValue('board');
    assert.equal(handle.getValue(), 'list', 'disabled option not selected');
    handle.setDisabled('board', false);
    handle.setValue('board');
    assert.equal(handle.getValue(), 'board');
    assert.deepEqual(seen, ['graph', 'board']);
  });
});

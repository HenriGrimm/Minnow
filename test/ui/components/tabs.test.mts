/**
 * Shared tabs: ARIA wiring, panels, automatic and manual activation.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

import { createTabs, type TabsOptions } from '../../../src/ui/components/tabs';
import { installComponentDom, type ComponentDom } from './component-dom.mts';

describe('tabs', () => {
  let dom: ComponentDom;

  afterEach(() => dom?.cleanup());

  function setup(extra: Partial<TabsOptions> = {}) {
    dom = installComponentDom();
    const panel = (text: string) => {
      const el = dom.doc.createElement('div');
      el.textContent = text;
      return el;
    };
    const panels = { files: panel('Files'), changes: panel('Changes'), log: panel('Log') };
    const seen: string[] = [];
    const handle = createTabs({
      ariaLabel: 'Inspector',
      tabs: [
        { id: 'files', label: 'Files', panel: panels.files },
        { id: 'changes', label: 'Changes', count: 3, panel: panels.changes },
        { id: 'blame', label: 'Blame', disabled: true },
        { id: 'log', label: 'Log', panel: panels.log },
      ],
      onChange: (id) => seen.push(id),
      ...extra,
    });
    dom.doc.body.appendChild(handle.root);
    const tab = (id: string) => handle.list.querySelector<HTMLButtonElement>(`[data-tab-id="${id}"]`)!;
    return { handle, panels, tab, seen };
  }

  test('wires tablist, tabs and panels', () => {
    const { handle, panels, tab } = setup();
    assert.equal(handle.list.getAttribute('role'), 'tablist');
    assert.equal(handle.list.getAttribute('aria-label'), 'Inspector');
    assert.equal(tab('files').getAttribute('role'), 'tab');
    assert.equal(tab('files').getAttribute('aria-selected'), 'true');
    assert.equal(tab('files').getAttribute('aria-controls'), panels.files.id);
    assert.equal(panels.files.getAttribute('role'), 'tabpanel');
    assert.equal(panels.files.getAttribute('aria-labelledby'), tab('files').id);
    assert.equal(panels.files.hidden, false);
    assert.equal(panels.changes.hidden, true);
    assert.equal(tab('blame').hasAttribute('aria-controls'), false, 'tab without a panel');
    assert.equal(handle.getSelected(), 'files');
  });

  test('automatic activation selects as the arrow keys move, skipping disabled tabs', () => {
    const { handle, panels, tab, seen } = setup();
    tab('files').focus();
    dom.key(tab('files'), 'ArrowRight');
    assert.equal(handle.getSelected(), 'changes');
    assert.equal(panels.changes.hidden, false);
    assert.equal(panels.files.hidden, true);
    dom.key(tab('changes'), 'ArrowRight');
    assert.equal(handle.getSelected(), 'log', 'disabled Blame skipped');
    dom.key(tab('log'), 'Home');
    assert.equal(handle.getSelected(), 'files');
    assert.deepEqual(seen, ['changes', 'log', 'files']);
    assert.equal(tab('files').tabIndex, 0);
    assert.equal(tab('log').tabIndex, -1);
  });

  test('manual activation moves focus and waits for Enter', () => {
    const { handle, tab, seen } = setup({ activation: 'manual' });
    tab('files').focus();
    dom.key(tab('files'), 'ArrowRight');
    assert.equal(dom.doc.activeElement === tab('changes'), true);
    assert.equal(handle.getSelected(), 'files');
    dom.key(tab('changes'), 'Enter');
    assert.equal(handle.getSelected(), 'changes');
    assert.deepEqual(seen, ['changes']);
  });

  test('counts and disabled state can change later', () => {
    const { handle, tab } = setup();
    const count = tab('changes').querySelector<HTMLElement>('.mn-tabs__count')!;
    assert.equal(count.textContent, '3');
    assert.equal(tab('files').querySelector<HTMLElement>('.mn-tabs__count')!.hidden, true);
    handle.setCount('changes', 12);
    assert.equal(count.textContent, '12');
    handle.setCount('changes', null);
    assert.equal(count.hidden, true);

    handle.setDisabled('blame', false);
    handle.select('blame', { silent: true });
    assert.equal(handle.getSelected(), 'blame');
  });
});

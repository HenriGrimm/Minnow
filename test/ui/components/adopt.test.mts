import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { adoptControls } from '../../../src/ui/components';
import { installComponentDom, type ComponentDom } from './component-dom.mts';

let dom: ComponentDom;
afterEach(() => dom?.cleanup());

test('template adoption preserves identity, native values, labels and listeners, including detached labels', () => {
  dom = installComponentDom();
  const root = dom.doc.createElement('form');
  root.innerHTML = `<button type="submit" data-mn-variant="primary">Save</button><label>Name<input value="Minnow"></label><select><option>a</option><option selected>b</option></select><label><input type="checkbox" checked>Enabled</label>`;
  const button = root.querySelector('button')!;
  const checkbox = root.querySelector<HTMLInputElement>('[type="checkbox"]')!;
  let changes = 0;
  checkbox.addEventListener('change', () => changes++);
  adoptControls(root);
  adoptControls(root);
  assert.equal(root.querySelector('button') === button, true);
  assert.equal(button.type, 'submit');
  assert.equal(button.classList.contains('mn-btn--primary'), true);
  assert.equal(root.querySelector('select')!.value, 'b');
  assert.equal(root.querySelector('input')!.value, 'Minnow');
  assert.equal(checkbox.checked, true);
  assert.equal(checkbox.closest('label')!.textContent, 'Enabled');
  checkbox.dispatchEvent(new dom.win.Event('change') as unknown as Event);
  assert.equal(changes, 1);
  assert.equal(root.querySelectorAll('.mn-checkbox').length, 1);
});

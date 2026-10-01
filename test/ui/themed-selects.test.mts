import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { Window } from 'happy-dom';
import { installThemedSelects } from '../../src/ui/themed-selects';

const originals = new Map<string, PropertyDescriptor | undefined>();
const disposers: Array<() => void> = [];
let win: Window;

function setup(html: string): Document {
  win = new Window();
  for (const key of ['document', 'Element', 'HTMLSelectElement', 'MutationObserver', 'CSS']) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      value: key === 'CSS' ? { supports: () => true } : (win as unknown as Record<string, unknown>)[key],
      configurable: true,
      writable: true,
    });
  }
  win.document.body.innerHTML = html;
  return win.document as unknown as Document;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  win?.close();
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  originals.clear();
});

test('enhancement preserves native options, selection, and change events', () => {
  const doc = setup('<select><option value="low">Low</option><option value="high" selected>High</option></select>');
  const select = doc.querySelector('select')!;
  let value = '';
  select.addEventListener('change', () => { value = select.value; });
  disposers.push(installThemedSelects());
  disposers.push(installThemedSelects());
  assert.equal(select.options.length, 2);
  assert.equal(select.value, 'high');
  assert.equal(select.querySelectorAll(':scope > button').length, 1);
  assert.ok(select.querySelector('button > selectedcontent'));
  select.value = 'low';
  select.dispatchEvent(new win.Event('change') as unknown as Event);
  assert.equal(value, 'low');
});

test('lazy selects and replaced options gain exactly one label button', async () => {
  const doc = setup('<main></main>');
  disposers.push(installThemedSelects());
  doc.querySelector('main')!.innerHTML = '<select><option value="main">main</option></select>';
  await settle();
  const select = doc.querySelector('select')!;
  assert.equal(select.querySelectorAll('button').length, 1);
  select.innerHTML = '<optgroup label="Branches"><option value="next" selected>next</option></optgroup>';
  await settle();
  assert.equal(select.querySelectorAll('button').length, 1);
  assert.equal(select.value, 'next');
  assert.equal(select.options.length, 1);
  assert.equal(select.options[0].parentElement?.tagName, 'OPTGROUP');
});

test('listboxes, backing model selects, and existing custom buttons keep their markup', () => {
  const doc = setup('<select multiple><option>A</option></select><select size="4"><option>B</option></select><select class="model-select-native"><option>C</option></select><select><button id="custom"><selectedcontent></selectedcontent></button><option>D</option></select>');
  disposers.push(installThemedSelects());
  assert.equal(doc.querySelectorAll('.mn-select-button').length, 0);
  assert.ok(doc.getElementById('custom'));
  for (const select of doc.querySelectorAll('select')) assert.equal(select.options.length, 1);
});

test('changing a select into a listbox removes only the generated button', async () => {
  const doc = setup('<select><option>A</option></select>');
  disposers.push(installThemedSelects());
  const select = doc.querySelector('select')!;
  select.multiple = true;
  await settle();
  assert.equal(select.querySelectorAll('button').length, 0);
  assert.equal(select.options.length, 1);
  select.multiple = false;
  await settle();
  assert.equal(select.querySelectorAll('button').length, 1);
});

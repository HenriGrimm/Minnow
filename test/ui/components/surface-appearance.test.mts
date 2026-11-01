import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { adoptControls, createCheckbox, createSegmentedControl, openPopover, closeAllPopovers } from '../../../src/ui/components';
import { installComponentDom, type ComponentDom } from './component-dom.mts';

let dom: ComponentDom;
afterEach(() => { closeAllPopovers(); dom?.cleanup(); });

test('surface popovers can retain their CSS anchor without a portal or placement overrides', () => {
  dom = installComponentDom();
  dom.doc.body.innerHTML = '<div id="home"><button id="anchor">Open</button><div id="content" style="position:absolute;bottom:8px">Contents</div></div>';
  const anchor = dom.doc.getElementById('anchor')!;
  const content = dom.doc.getElementById('content')!;
  const home = content.parentElement;
  const handle = openPopover({ anchor, content, appearance: 'surface', portal: false });
  assert.ok(content.parentElement === home);
  assert.equal(content.style.position, 'absolute');
  assert.equal(content.style.bottom, '8px');
  assert.equal(content.style.left, '');
  handle.reposition();
  assert.equal(content.style.left, '');
  handle.close();
  assert.equal(content.isConnected, false);
});

test('floating surface popovers can keep their containing block and focus ancestry', () => {
  dom = installComponentDom();
  dom.doc.body.innerHTML = '<div id="home"><button id="anchor">Open</button><div id="content"><button>Choice</button></div></div>';
  const anchor = dom.doc.getElementById('anchor')!;
  const content = dom.doc.getElementById('content')!;
  const home = content.parentElement;
  openPopover({ anchor, content, appearance: 'surface', portal: false, positioning: 'floating' });
  assert.ok(content.parentElement === home);
  assert.equal(content.style.position, 'fixed');
  assert.ok(home?.contains(dom.doc.activeElement));
});

test('surface adoption preserves native forms and bindings while retaining shared controls', () => {
  dom = installComponentDom();
  const form = dom.doc.createElement('form');
  form.innerHTML = '<button type="submit" class="code-action">Save</button><input value="draft"><select><option selected>Build</option></select><label><input type="checkbox" checked>Enabled</label>';
  const button = form.querySelector('button')!;
  let clicks = 0;
  button.addEventListener('click', event => { event.preventDefault(); clicks++; });
  adoptControls(form, { appearance: 'surface' });
  adoptControls(form, { appearance: 'surface' });
  assert.ok(form.querySelector('button') === button);
  assert.equal(button.type, 'submit');
  assert.ok(button.classList.contains('mn-btn'));
  assert.ok(button.hasAttribute('data-mn-surface'));
  assert.ok(form.querySelector('.mn-input')!.hasAttribute('data-mn-surface'));
  assert.ok(form.querySelector('.mn-select')!.hasAttribute('data-mn-surface'));
  assert.equal(form.querySelector('select')!.value, 'Build');
  button.click();
  assert.equal(clicks, 1);
  const checkbox = createCheckbox({ appearance: 'surface', label: 'Enabled' });
  form.append(checkbox.input);
  assert.ok(checkbox.input.hasAttribute('data-mn-surface'), 'the input keeps its appearance when a caller owns its wrapper');
});

test('surface segments retain keyboard selection when reusing a host', () => {
  dom = installComponentDom();
  const host = dom.doc.createElement('div');
  host.className = 'code-modes';
  dom.doc.body.append(host);
  const changes: string[] = [];
  const options = { element: host, appearance: 'surface' as const, options: [{ value: 'build', label: 'Build' }, { value: 'plan', label: 'Plan' }], value: 'build', ariaLabel: 'Mode', onChange: (value: string) => changes.push(value) };
  createSegmentedControl(options);
  const control = createSegmentedControl(options);
  host.querySelector<HTMLButtonElement>('button')!.focus();
  dom.key(host, 'ArrowRight');
  assert.equal(control.getValue(), 'plan');
  assert.deepEqual(changes, ['plan']);
  assert.equal(host.querySelector('[aria-checked="true"]')?.textContent, 'Plan');
  assert.ok(host.classList.contains('code-modes'));
});

test('surface popovers reuse the content root and restore its identity, styles and focus on Escape', () => {
  dom = installComponentDom();
  const anchor = dom.doc.createElement('button');
  const home = dom.doc.createElement('div');
  const content = dom.doc.createElement('div');
  content.id = 'code-menu';
  content.className = 'code-menu';
  content.style.cssText = 'position: absolute; right: 0px; min-width: 200px;';
  const originalStyle = content.getAttribute('style');
  content.setAttribute('role', 'menu');
  content.innerHTML = '<button>Choose</button>';
  anchor.setAttribute('aria-controls', content.id);
  home.append(content);
  dom.doc.body.append(anchor, home);
  const handle = openPopover({ appearance: 'surface', anchor, content, onClose: () => home.append(content) });
  assert.ok(handle.root === content);
  assert.equal(content.id, 'code-menu');
  assert.equal(content.getAttribute('role'), 'menu');
  assert.equal(content.style.position, 'fixed');
  assert.ok(content.classList.contains('mn-occludes-preview'));
  assert.ok(dom.doc.activeElement === content.querySelector('button'));
  dom.key(dom.win, 'Escape');
  assert.equal(handle.isOpen(), false);
  assert.ok(content.parentElement === home);
  assert.equal(content.className, 'code-menu');
  assert.equal(content.getAttribute('style'), originalStyle);
  assert.equal(anchor.getAttribute('aria-controls'), 'code-menu');
  assert.ok(dom.doc.activeElement === anchor);
});

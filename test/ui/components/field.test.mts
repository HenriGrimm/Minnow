/**
 * Shared form controls and the labelled field wrapper.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

import {
  createCheckbox,
  createField,
  createSelect,
  createTextarea,
  createTextInput,
} from '../../../src/ui/components/field';
import { installComponentDom, type ComponentDom } from './component-dom.mts';

describe('field controls', () => {
  let dom: ComponentDom;

  afterEach(() => dom?.cleanup());

  test('text input carries size, value, placeholder and invalid state', () => {
    dom = installComponentDom();
    const seen: string[] = [];
    const input = createTextInput({
      value: 'abc',
      placeholder: 'Name',
      size: 'lg',
      invalid: true,
      autocomplete: 'off',
      onInput: (value) => seen.push(value),
    });
    assert.equal(input.className, 'mn-input mn-input--lg');
    assert.equal(input.value, 'abc');
    assert.equal(input.placeholder, 'Name');
    assert.equal(input.getAttribute('aria-invalid'), 'true');
    assert.equal(input.getAttribute('autocomplete'), 'off');
    input.value = 'abcd';
    input.dispatchEvent(new dom.win.Event('input') as unknown as Event);
    assert.deepEqual(seen, ['abcd']);
  });

  test('textarea defaults to three rows and supports no-resize', () => {
    dom = installComponentDom();
    const textarea = createTextarea({ resize: 'none' });
    // happy-dom reflects `rows` as a string.
    assert.equal(Number(textarea.rows), 3);
    assert.equal(textarea.classList.contains('mn-input--multiline'), true);
    assert.equal(textarea.classList.contains('mn-input--no-resize'), true);
  });

  test('select renders options and the chosen value', () => {
    dom = installComponentDom();
    let changed = '';
    const select = createSelect({
      options: [
        { value: 'a', label: 'Alpha' },
        { value: 'b', label: 'Beta' },
        { value: 'c', label: 'Gamma', disabled: true },
      ],
      value: 'b',
      onChange: (value) => {
        changed = value;
      },
    });
    assert.equal(select.className, 'mn-select mn-select--md');
    assert.equal(select.options.length, 3);
    assert.equal(select.value, 'b');
    assert.equal(select.options[2].disabled, true);
    select.value = 'a';
    select.dispatchEvent(new dom.win.Event('change') as unknown as Event);
    assert.equal(changed, 'a');
  });

  test('checkbox reports changes and links its description', () => {
    dom = installComponentDom();
    const seen: boolean[] = [];
    const { root, input } = createCheckbox({
      label: 'Remember',
      description: 'Applies to this workspace',
      onChange: (checked) => seen.push(checked),
    });
    dom.doc.body.appendChild(root);
    assert.equal(root.querySelector('.mn-checkbox__label')?.textContent, 'Remember');
    const description = root.querySelector('.mn-checkbox__description')!;
    assert.equal(input.getAttribute('aria-describedby'), description.id);
    input.click();
    assert.deepEqual(seen, [true]);
  });

  test('field wires label, hint and error to the control', () => {
    dom = installComponentDom();
    const input = createTextInput();
    const field = createField({ label: 'Port', control: input, hint: 'Between 1024 and 65535', required: true });
    dom.doc.body.appendChild(field.root);

    assert.ok(input.id);
    assert.equal(field.label.htmlFor, input.id);
    assert.equal(input.required, true);
    assert.equal(field.error.hidden, true);
    assert.equal(input.getAttribute('aria-describedby'), field.hint.id);

    field.setError('Port is in use');
    assert.equal(field.error.hidden, false);
    assert.equal(field.error.textContent, 'Port is in use');
    assert.equal(input.getAttribute('aria-invalid'), 'true');
    assert.equal(input.getAttribute('aria-describedby'), `${field.hint.id} ${field.error.id}`);
    assert.equal(field.root.classList.contains('mn-field--invalid'), true);

    field.setError(null);
    assert.equal(field.error.hidden, true);
    assert.equal(input.hasAttribute('aria-invalid'), false);
    assert.equal(input.getAttribute('aria-describedby'), field.hint.id);

    field.setHint(null);
    assert.equal(field.hint.hidden, true);
    assert.equal(input.hasAttribute('aria-describedby'), false);
  });

  test('field finds the control inside a wrapper and keeps an existing id', () => {
    dom = installComponentDom();
    const wrapper = dom.doc.createElement('div');
    const select = createSelect({ id: 'theme', options: [{ value: 'x', label: 'X' }] });
    wrapper.appendChild(select);
    const field = createField({ label: 'Theme', control: wrapper });
    assert.equal(field.label.htmlFor, 'theme');
  });
});

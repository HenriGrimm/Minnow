import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Window } from 'happy-dom';

test('supplied settings controls keep their bindings and receive styling and visible labels', async () => {
  const window = new Window();
  const previousDocument = globalThis.document;
  globalThis.document = window.document;
  try {
    const { createSettingsInputRow, createSettingsSelectRow, createSettingsTextareaRow } =
      await import('../../src/ui/settings-controls.ts');
    for (const [tag, build, option, styleClass] of [
      ['input', createSettingsInputRow, 'input', 'settings-input'],
      ['select', createSettingsSelectRow, 'select', 'settings-select'],
      ['textarea', createSettingsTextareaRow, 'textarea', 'settings-textarea'],
    ]) {
      const control = document.createElement(tag);
      control.id = `supplied-${tag}`;
      control.className = 'custom-control';
      let changes = 0;
      control.addEventListener('change', () => changes++);
      const { row } = build('Visible title', { [option]: control, description: 'Helpful description' });
      document.body.append(row);
      assert.equal(row.querySelector(tag), control);
      assert.ok(control.classList.contains(styleClass));
      assert.ok(control.classList.contains('custom-control'));
      assert.equal(control.labels[0].textContent, 'Visible title');
      assert.equal(document.getElementById(control.getAttribute('aria-describedby')).textContent, 'Helpful description');
      control.dispatchEvent(new window.Event('change'));
      assert.equal(changes, 1);
    }
  } finally {
    globalThis.document = previousDocument;
    await window.happyDOM.close();
  }
});

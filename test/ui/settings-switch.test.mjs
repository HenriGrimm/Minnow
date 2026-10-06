import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { Window } from 'happy-dom';

const { createSettingsToggleRow, wrapCheckboxAsSwitch } = await import(
  '../../src/ui/settings-switch.ts'
);

function setupDom() {
  const window = new Window();
  globalThis.document = window.document;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Node = window.Node;
  return window;
}

describe('settings switch upgrade', () => {
  afterEach(() => {
    delete globalThis.document;
    delete globalThis.HTMLElement;
    delete globalThis.Node;
  });

  test('wrapCheckboxAsSwitch keeps bare text labels on settings-toggle-row', () => {
    setupDom();
    const legacy = document.createElement('label');
    legacy.className = 'settings-toggle-row';
    legacy.dataset.settingsSearchKey = 'audio.echoCancellation';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.id = 'settingsAudioEchoCancellation';
    input.checked = true;
    legacy.append(input, document.createTextNode('Echo cancellation'));
    document.body.appendChild(legacy);

    const upgraded = wrapCheckboxAsSwitch(input);

    const row = document.querySelector('.settings-toggle-row');
    assert.ok(row);
    assert.equal(row.tagName, 'DIV');
    assert.equal(
      row.querySelector('.settings-toggle-row__label')?.textContent,
      'Echo cancellation',
    );
    assert.equal(row.dataset.settingsSearchKey, 'audio.echoCancellation');
    assert.equal(upgraded.id, 'settingsAudioEchoCancellation');
    assert.equal(upgraded.checked, true);
    assert.ok(upgraded.classList.contains('settings-switch__input'));
  });

  test('createSettingsToggleRow wires aria-labelledby to title text', () => {
    setupDom();
    const { row, input } = createSettingsToggleRow('Enable notifications', {
      id: 'settingsNotifEnabled',
    });

    const labelledBy = input.getAttribute('aria-labelledby');
    assert.ok(labelledBy);
    const title = row.querySelector(`#${labelledBy}`);
    assert.equal(title?.textContent, 'Enable notifications');
    assert.equal(title?.className, 'settings-toggle-row__title');
  });

  test('wrapCheckboxAsSwitch wires aria-labelledby for legacy label rows', () => {
    setupDom();
    const legacy = document.createElement('label');
    legacy.className = 'settings-toggle-row';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.id = 'settingsAudioEchoCancellation';
    legacy.append(input, document.createTextNode('Echo cancellation'));
    document.body.appendChild(legacy);

    const upgraded = wrapCheckboxAsSwitch(input);
    const labelledBy = upgraded.getAttribute('aria-labelledby');
    assert.ok(labelledBy);
    const title = document.getElementById(labelledBy);
    assert.equal(title?.textContent, 'Echo cancellation');
  });

  test('visible toggle labels activate their switch and expose its description', () => {
    setupDom();
    let saved;
    const { row, input } = createSettingsToggleRow('Play sounds', {
      description: 'Play a cue when a task finishes.',
      onChange: (value) => { saved = value; },
    });
    document.body.append(row);
    row.querySelector('.settings-toggle-row__title').click();
    assert.equal(input.checked, true);
    assert.equal(saved, true);
    assert.equal(document.getElementById(input.getAttribute('aria-describedby')).textContent,
      'Play a cue when a task finishes.');
  });
});

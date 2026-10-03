/**
 * Settings → Appearance font pickers expose the Google Fonts catalog.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { resetAppearanceFontsForTests } from '../../src/appearance/fonts.ts';
import { appendAppearanceFonts } from '../../src/ui/settings-appearance-fonts.ts';
import { installHappyDomGlobals, teardownHappyDomAsync } from '../os/dom-helpers.mts';

describe('settings appearance fonts', () => {
  let happyDomWindow: import('happy-dom').Window | undefined;

  beforeEach(async () => {
    const { Window } = await import('happy-dom');
    const win = new Window();
    happyDomWindow = win;
    installHappyDomGlobals(win);
    resetAppearanceFontsForTests();
  });

  afterEach(async () => {
    resetAppearanceFontsForTests();
    if (happyDomWindow) await teardownHappyDomAsync(happyDomWindow);
  });

  test('UI and mono selects list Google Fonts under an optgroup', () => {
    const mount = document.createElement('div');
    document.body.appendChild(mount);
    appendAppearanceFonts(mount);

    const selects = mount.querySelectorAll('select.settings-appearance-font-select');
    assert.equal(selects.length, 2);

    const uiSelect = selects[0]!;
    const monoSelect = selects[1]!;
    const uiOptions = [...uiSelect.querySelectorAll('option')].map((opt) => opt.value);
    const monoOptions = [...monoSelect.querySelectorAll('option')].map((opt) => opt.value);

    assert.ok(uiOptions.length >= 31, `UI options ${uiOptions.length}`);
    assert.ok(monoOptions.length >= 21, `mono options ${monoOptions.length}`);
    assert.equal(uiOptions[0], 'system');
    assert.ok(uiOptions.includes('inter'));
    assert.ok(!uiOptions.includes('geist'));
    assert.ok(monoOptions.includes('fira-code'));
    assert.ok(monoOptions.includes('jetbrains-mono'));
    assert.ok(!monoOptions.includes('geist-mono'));

    const groups = [...uiSelect.querySelectorAll('optgroup')];
    assert.equal(groups.length, 1);
    assert.equal(groups[0]?.label, 'Google Fonts');
    assert.ok((groups[0]?.querySelectorAll('option').length ?? 0) >= 30);
  });

  test('font labels name their selectors and keyboard buttons open one file picker', () => {
    const mount = document.createElement('div');
    document.body.appendChild(mount);
    appendAppearanceFonts(mount);
    for (const row of mount.querySelectorAll('.settings-appearance-font-row')) {
      const select = row.querySelector('select')!;
      assert.equal(select.labels?.length, 1);
      assert.ok(select.labels?.[0]?.textContent?.includes('font'));
      const upload = row.querySelector<HTMLButtonElement>('button')!;
      const file = row.querySelector<HTMLInputElement>('input[type="file"]')!;
      let opened = 0;
      file.click = () => { opened++; };
      upload.click();
      assert.equal(opened, 1);
      assert.match(upload.getAttribute('aria-label') ?? '', /Upload .*font/);
    }
  });
});

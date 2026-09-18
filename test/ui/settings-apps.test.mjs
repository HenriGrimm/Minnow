/**
 * Settings → Apps section rendering and catalog wiring.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Window } from 'happy-dom';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const html = readFileSync(join(root, 'index.html'), 'utf8');

const { SETTINGS_CATEGORIES, categoryForArea, fieldByKey } = await import(
  '../../src/ui/settings-catalog.ts'
);
const { SETTINGS_SECTION_LABELS, SETTINGS_SECTIONS } = await import(
  '../../src/ui/settings-page-types.ts'
);
const { renderAppsSettingsSection } = await import('../../src/ui/settings-apps.ts');
const { resetAppPreferencesForTests } = await import('../../src/os/app-preferences.ts');
const { listOptionalReleasedApps } = await import('../../src/os/app-registry.ts');

let testWindow = null;

function setupDom() {
  testWindow = new Window();
  globalThis.window = testWindow;
  globalThis.document = testWindow.document;
  globalThis.HTMLElement = testWindow.HTMLElement;
  globalThis.localStorage = testWindow.localStorage;
  testWindow.localStorage.clear();
  resetAppPreferencesForTests();
  document.body.innerHTML = '<div id="settingsAppsBody"></div>';
}

describe('settings apps catalog + html', () => {
  test('apps is a top-level settings category and section', () => {
    assert.ok(SETTINGS_CATEGORIES.includes('apps'));
    assert.equal(SETTINGS_SECTION_LABELS.apps, 'Apps');
    assert.ok(SETTINGS_SECTIONS.includes('apps'));
    assert.equal(categoryForArea('apps'), 'apps');
    assert.ok(fieldByKey('apps.visibility'));
    assert.ok(fieldByKey('apps.core.research'));
    assert.ok(fieldByKey('apps.core.scheduler'));
    assert.ok(fieldByKey('apps.optional.code'));
  });

  test('index.html includes Apps nav and section mount', () => {
    assert.match(html, /data-settings-nav-group="apps"/);
    assert.match(html, /data-area-jump="apps"/);
    assert.match(html, /id="settingsSection-apps"/);
    assert.match(html, /id="settingsAppsBody"/);
    assert.match(html, /data-category="apps"/);
  });
});

describe('settings apps renderer', () => {
  beforeEach(() => {
    setupDom();
  });

  afterEach(() => {
    resetAppPreferencesForTests();
    testWindow?.close();
    testWindow = null;
  });

  test('renders core note and Coming soon when no optional apps', () => {
    const mount = document.getElementById('settingsAppsBody');
    renderAppsSettingsSection(mount);
    assert.equal(listOptionalReleasedApps().length, 0);
    assert.equal(mount.querySelectorAll('.mn-app-picker-card').length, 0);
    assert.ok(mount.querySelector('.mn-app-picker-core'));
    assert.match(mount.querySelector('.mn-app-picker-core')?.textContent ?? '', /Always included/);
    assert.match(mount.querySelector('.mn-app-picker-core')?.textContent ?? '', /Issues/);
    assert.match(mount.querySelector('.mn-app-picker-core')?.textContent ?? '', /Scheduler/);
    // Research is hidden for release, so it is not listed.
    assert.doesNotMatch(mount.querySelector('.mn-app-picker-core')?.textContent ?? '', /Research/);
    assert.ok(mount.querySelector('[data-settings-search-key="apps.core.code"]'));
    assert.ok(mount.querySelector('[data-settings-search-key="apps.core.issues"]'));
    assert.ok(mount.querySelector('[data-settings-search-key="apps.visibility"]'));
    assert.ok(mount.querySelector('.mn-app-picker-coming-soon'));
    assert.equal(mount.querySelector('.mn-app-picker-toolbar'), null);
  });
});

/**
 * App availability policy + preference persistence.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { Window } from 'happy-dom';
import {
  APPS,
  isCoreApp,
  isDeveloperReleased,
  isOptionalApp,
  listCoreReleasedApps,
  listOptionalReleasedApps,
  listReleasedApps,
} from '../../src/os/app-registry.ts';
import {
  getAppUnavailableReason,
  isAppAvailable,
  isAppEnabled,
  listDockApps,
  listEnabledOptionalAppIds,
  loadDisabledAppIds,
  normalizeDisabledAppIds,
  resetAppPreferencesForTests,
  saveDisabledAppIds,
  setAppEnabled,
  setEnabledOptionalApps,
  subscribeAppPreferences,
} from '../../src/os/app-preferences.ts';

let testWindow: Window | null = null;

function setupDom(): void {
  testWindow = new Window();
  const g = globalThis as typeof globalThis & {
    window: Window;
    document: Document;
    localStorage: Storage;
  };
  g.window = testWindow as unknown as Window & typeof globalThis.window;
  g.document = testWindow.document;
  g.localStorage = testWindow.localStorage;
  testWindow.localStorage.clear();
  resetAppPreferencesForTests();
}

describe('app registry availability invariants', () => {
  test('core apps include code, research, models, brain, scheduler, issues, settings', () => {
    const coreIds = listCoreReleasedApps().map((app) => app.id).sort();
    assert.deepEqual(coreIds, [
      'brain',
      'code',
      'issues',
      'models',
      'research',
      'scheduler',
      'settings',
      'source-control',
    ]);
    for (const id of coreIds) {
      assert.equal(isCoreApp(id), true);
      assert.equal(isOptionalApp(id), false);
    }
  });

  test('no optional apps are released yet', () => {
    assert.deepEqual(listOptionalReleasedApps(), []);
  });

  test('every app has availability + releaseState; three apps are hidden', () => {
    assert.equal(APPS.length, 11);
    assert.equal(listReleasedApps().length, 8);
    for (const app of APPS) {
      assert.ok(app.availability === 'core' || app.availability === 'optional');
      assert.ok(app.releaseState === 'released' || app.releaseState === 'hidden');
      assert.equal(isDeveloperReleased(app.id), app.releaseState === 'released');
    }
  });
});

describe('app preferences', () => {
  beforeEach(() => {
    setupDom();
  });

  afterEach(() => {
    resetAppPreferencesForTests();
    testWindow?.close();
    testWindow = null;
  });

  test('missing storage defaults to all released optional apps enabled', () => {
    assert.equal(loadDisabledAppIds().size, 0);
    assert.equal(listEnabledOptionalAppIds().length, listOptionalReleasedApps().length);
    assert.equal(isAppEnabled('code'), true);
    assert.equal(isAppAvailable('settings'), true);
    assert.equal(isAppEnabled('research'), true);
    assert.equal(isAppEnabled('scheduler'), true);
  });

  test('normalizeDisabledAppIds drops core, hidden, unknown, and duplicates', () => {
    assert.deepEqual(
      normalizeDisabledAppIds([
        'code',
        'chat',
        'research',
        'scheduler',
        'code',
        'not-an-app',
        12,
        'bench',
      ]),
      [],
    );
  });

  test('setAppEnabled cannot disable core apps including research and scheduler', () => {
    setAppEnabled('code', false);
    setAppEnabled('settings', false);
    setAppEnabled('research', false);
    setAppEnabled('scheduler', false);
    assert.equal(isAppEnabled('code'), true);
    assert.equal(isAppEnabled('settings'), true);
    assert.equal(isAppEnabled('research'), true);
    assert.equal(isAppEnabled('scheduler'), true);
    assert.equal(loadDisabledAppIds().size, 0);
    assert.equal(listDockApps().some((app) => app.id === 'scheduler'), true);
  });

  test('legacy disabled storage for former optional apps is cleared on normalize', () => {
    localStorage.setItem('minnow.os.disabledApps', JSON.stringify(['scheduler', 'research']));
    resetAppPreferencesForTests();
    assert.equal(loadDisabledAppIds().size, 0);
    assert.equal(isAppEnabled('scheduler'), true);
    assert.equal(isAppEnabled('research'), true);
  });

  test('setEnabledOptionalApps with empty selection persists nothing when no optionals exist', () => {
    setEnabledOptionalApps([]);
    assert.equal(localStorage.getItem('minnow.os.disabledApps'), null);
    assert.deepEqual(listEnabledOptionalAppIds(), []);
  });

  test('re-enabling clears storage when nothing remains disabled', () => {
    saveDisabledAppIds(['scheduler']);
    assert.equal(localStorage.getItem('minnow.os.disabledApps'), null);
    setAppEnabled('scheduler', true);
    assert.equal(localStorage.getItem('minnow.os.disabledApps'), null);
  });

  test('developer-hidden apps cannot be toggled or persisted as disabled', () => {
    setAppEnabled('experts', false);
    assert.equal(isAppEnabled('experts'), false);
    assert.equal(getAppUnavailableReason('experts'), 'developer-hidden');
    assert.equal(loadDisabledAppIds().size, 0);
  });

  test('subscribers fire on preference changes', () => {
    let calls = 0;
    const unsub = subscribeAppPreferences(() => {
      calls += 1;
    });
    // Persist path still notifies even when the normalized disabled set stays empty.
    saveDisabledAppIds([]);
    assert.equal(calls, 1);
    unsub();
    saveDisabledAppIds([]);
    assert.equal(calls, 1);
  });
});

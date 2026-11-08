/**
 * App-gated tool catalog filtering (MIN-472).
 * Email/Calendar app-gated tools were removed; the catalog has no appId bindings.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { Window } from 'happy-dom';
import { isAppEnabled, resetAppPreferencesForTests, setAppEnabled } from '../../src/os/app-preferences.ts';
import { BUILT_IN_TOOLS } from '../../src/tools/definitions.ts';
import {
  getEnabledToolCatalogEntries,
  getEnabledToolDefinitionsForMode,
} from '../../src/tools/client.ts';
import {
  defaultToolConfig,
  invalidateToolConfigCache,
  setLocalServerAvailable,
  TOOL_CONFIG_STORAGE_KEY,
} from '../../src/tools/config.ts';

let testWindow: Window | null = null;

function setupDom(): void {
  testWindow = new Window();
  const g = globalThis as typeof globalThis & {
    window: Window;
    document: Document;
    localStorage: Storage;
    HTMLElement: typeof HTMLElement;
    HTMLInputElement: typeof HTMLInputElement;
    HTMLSelectElement: typeof HTMLSelectElement;
    HTMLLabelElement: typeof HTMLLabelElement;
    Event: typeof Event;
  };
  g.window = testWindow as unknown as Window & typeof globalThis.window;
  g.document = testWindow.document;
  g.localStorage = testWindow.localStorage;
  g.HTMLElement = testWindow.HTMLElement;
  g.HTMLInputElement = testWindow.HTMLInputElement;
  g.HTMLSelectElement = testWindow.HTMLSelectElement;
  g.HTMLLabelElement = testWindow.HTMLLabelElement;
  g.Event = testWindow.Event;
  testWindow.localStorage.clear();
  resetAppPreferencesForTests();

  const config = defaultToolConfig();
  invalidateToolConfigCache();
  localStorage.setItem(TOOL_CONFIG_STORAGE_KEY, JSON.stringify(config));
  setLocalServerAvailable(true);
}

function catalogIds(): Set<string> {
  return new Set(getEnabledToolCatalogEntries().map((tool) => tool.id));
}

function modelIdsForGeneralMode(): Set<string> {
  return new Set(
    getEnabledToolDefinitionsForMode('general').map((def) => def.function.name),
  );
}

describe('app-gated tool bindings', () => {
  test('no tools declare an appId', () => {
    const gated = BUILT_IN_TOOLS.filter((tool) => tool.appId);
    assert.deepEqual(gated.map((tool) => tool.id), []);
  });

  test('non-app tools omit appId', () => {
    assert.equal(BUILT_IN_TOOLS.find((tool) => tool.id === 'calculate')?.appId, undefined);
    assert.equal(BUILT_IN_TOOLS.find((tool) => tool.id === 'get_datetime')?.appId, undefined);
  });
});

describe('app-gated tool catalog filtering', () => {
  beforeEach(() => {
    setupDom();
  });

  afterEach(() => {
    resetAppPreferencesForTests();
    invalidateToolConfigCache();
    testWindow?.close();
    testWindow = null;
  });

  test('full catalog is shipped with no app-gated omissions', () => {
    const ids = catalogIds();
    assert.equal(ids.has('calculate'), true);
    assert.equal(ids.has('list_mail'), false);
  });

  test('getEnabledToolDefinitionsForMode applies mode policy without app gating', () => {
    const names = modelIdsForGeneralMode();
    assert.equal(names.has('list_mail'), false);
    assert.equal(names.has('read_file'), true);
  });

  test('core scheduler stays enabled and does not hide unrelated utility tools', () => {
    setAppEnabled('scheduler', false);
    assert.equal(isAppEnabled('scheduler'), true);

    const ids = catalogIds();
    assert.equal(ids.has('calculate'), true);
    assert.equal(ids.has('get_datetime'), true);
  });

});

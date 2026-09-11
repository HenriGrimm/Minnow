/**
 * Client appearance persist: localStorage snapshot, apply, and hydrate.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import {
  applyAppearanceToLocalStorage,
  hydrateAppearanceFromServer,
  localAppearanceHasUserChoice,
  resetAppearancePersistForTests,
  seedLocalStorageFromAppearanceBoot,
  snapshotAppearanceFromLocalStorage,
} from '../../src/appearance/persist.ts';
import { APPEARANCE_STORAGE_KEYS } from '../../src/appearance/types.ts';
import { setStorageModeForTests } from '../../src/config/storage-mode.ts';

const store = new Map<string, string>();

function mockLocalStorage(): void {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
      removeItem: (k: string) => {
        store.delete(k);
      },
    },
  });
}

describe('appearance persist', () => {
  const prevFetch = globalThis.fetch;

  beforeEach(() => {
    store.clear();
    mockLocalStorage();
    resetAppearancePersistForTests();
    setStorageModeForTests('server');
  });

  afterEach(() => {
    resetAppearancePersistForTests();
    setStorageModeForTests(null);
    globalThis.fetch = prevFetch;
    delete (globalThis as { window?: unknown }).window;
  });

  test('empty storage is not a user choice', () => {
    const snap = snapshotAppearanceFromLocalStorage();
    assert.equal(snap.themeId, 'swamp-dark');
    assert.equal(localAppearanceHasUserChoice(snap), false);
  });

  test('chat view round-trips and old settings default to compact', () => {
    store.set(APPEARANCE_STORAGE_KEYS.chatView, 'full');
    const saved = snapshotAppearanceFromLocalStorage();
    assert.equal(saved.chatView, 'full');
    assert.equal(localAppearanceHasUserChoice(saved), true);
    store.clear();
    applyAppearanceToLocalStorage(saved);
    assert.equal(store.get(APPEARANCE_STORAGE_KEYS.chatView), 'full');
    applyAppearanceToLocalStorage({ ...saved, chatView: undefined });
    assert.equal(store.get(APPEARANCE_STORAGE_KEYS.chatView), 'compact');
  });

  test('ocean-dark in localStorage is a user choice', () => {
    store.set('minnow.theme', 'ocean-dark');
    const snap = snapshotAppearanceFromLocalStorage();
    assert.equal(snap.themeId, 'ocean-dark');
    assert.equal(snap.family, 'ocean');
    assert.equal(localAppearanceHasUserChoice(snap), true);
  });

  test('applyAppearanceToLocalStorage restores follow-system family', () => {
    applyAppearanceToLocalStorage({
      version: 1,
      followSystem: true,
      family: 'mint',
      themeId: 'mint-dark',
      customEnabled: false,
      customAdvanced: false,
      customTokens: {},
      fonts: {
        ui: { kind: 'preset', slot: 'ui', id: 'system' },
        mono: { kind: 'preset', slot: 'mono', id: 'system' },
      },
      updatedAt: '2026-09-05T00:00:00.000Z',
    });
    assert.equal(store.get('minnow.theme.followSystem'), '1');
    assert.equal(store.get('minnow.theme.family'), 'mint');
    assert.equal(store.has('minnow.theme'), false);
  });

  test('hydrate applies a saved server theme onto empty localStorage', async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          version: 1,
          followSystem: false,
          family: 'human',
          themeId: 'human-dark',
          customEnabled: false,
          customAdvanced: false,
          customTokens: {},
          fonts: {
            ui: { kind: 'preset', slot: 'ui', id: 'system' },
            mono: { kind: 'preset', slot: 'mono', id: 'system' },
          },
          updatedAt: '2026-09-05T12:00:00.000Z',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )) as typeof fetch;

    const changed = await hydrateAppearanceFromServer();
    assert.equal(changed, true);
    assert.equal(store.get('minnow.theme'), 'human-dark');
  });

  test('hydrate migrates a local choice when the server file was never saved', async () => {
    store.set('minnow.theme', 'coral-light');
    const puts: unknown[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (!init || init.method === 'GET' || !init.method) {
        return new Response(
          JSON.stringify({
            version: 1,
            themeId: 'swamp-dark',
            family: 'swamp',
            followSystem: false,
            customEnabled: false,
            customAdvanced: false,
            customTokens: {},
            fonts: {
              ui: { kind: 'preset', slot: 'ui', id: 'system' },
              mono: { kind: 'preset', slot: 'mono', id: 'system' },
            },
            updatedAt: null,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      puts.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;

    const changed = await hydrateAppearanceFromServer();
    assert.equal(changed, false);
    assert.equal(puts.length, 1);
    assert.equal((puts[0] as { themeId: string }).themeId, 'coral-light');
  });

  test('seedLocalStorageFromAppearanceBoot reads the FOUC payload', () => {
    (globalThis as { window: Window }).window = {
      __MINNOW_APPEARANCE_BOOT__: {
        themeId: 'matrix-dark',
        family: 'matrix',
        followSystem: false,
        customEnabled: true,
        customTokens: { bg: '#040604' },
      },
    } as Window;

    const changed = seedLocalStorageFromAppearanceBoot();
    assert.equal(changed, true);
    assert.equal(store.get('minnow.theme'), 'matrix-dark');
    assert.equal(store.get(APPEARANCE_STORAGE_KEYS.customEnabled), '1');
  });
});

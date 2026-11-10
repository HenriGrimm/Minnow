/**
 * Theme registry, storage keys, migration, and follow-system resolution.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import {
  DEFAULT_THEME_ID,
  getFollowSystem,
  getStoredFamily,
  getStoredTheme,
  THEME_FAMILY_KEY,
  THEME_FOLLOW_SYSTEM_KEY,
  THEME_STORAGE_KEY,
} from '../src/theme.ts';

describe('theme', () => {
  const prev = globalThis.localStorage;
  const store = new Map<string, string>();

  beforeEach(() => {
    store.clear();
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
  });

  afterEach(() => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: prev,
    });
  });

  test('defaults to graphite-dark when storage empty', () => {
    assert.equal(getStoredTheme(), DEFAULT_THEME_ID);
    assert.equal(DEFAULT_THEME_ID, 'graphite-dark');
  });

  test('reads explicit theme id from minnow.theme', () => {
    store.set(THEME_STORAGE_KEY, 'ocean-light');
    assert.equal(getStoredTheme(), 'ocean-light');
  });

  test('migrates legacy light to swamp-light', () => {
    store.set(THEME_STORAGE_KEY, 'light');
    assert.equal(getStoredTheme(), 'swamp-light');
    assert.equal(store.get(THEME_STORAGE_KEY), 'swamp-light');
  });

  test('migrates legacy dark to swamp-dark', () => {
    store.set(THEME_STORAGE_KEY, 'dark');
    assert.equal(getStoredTheme(), 'swamp-dark');
  });

  test('migrates legacy system to followSystem + family', () => {
    store.set(THEME_STORAGE_KEY, 'system');
    getStoredTheme();
    assert.equal(store.get(THEME_FOLLOW_SYSTEM_KEY), '1');
    assert.equal(store.get(THEME_FAMILY_KEY), 'swamp');
    assert.equal(store.has(THEME_STORAGE_KEY), false);
  });

  test('migrates renamed theme ids (sage → swamp)', () => {
    store.set(THEME_STORAGE_KEY, 'sage-dark');
    assert.equal(getStoredTheme(), 'swamp-dark');
    assert.equal(store.get(THEME_STORAGE_KEY), 'swamp-dark');
  });

  test('migrates renamed follow-system family (amber → desert)', () => {
    store.set(THEME_FOLLOW_SYSTEM_KEY, '1');
    store.set(THEME_FAMILY_KEY, 'amber');
    assert.equal(getStoredFamily(), 'desert');
    assert.equal(store.get(THEME_FAMILY_KEY), 'desert');
  });

  test('followSystem resolves mode from matchMedia', () => {
    store.set(THEME_FOLLOW_SYSTEM_KEY, '1');
    store.set(THEME_FAMILY_KEY, 'desert');
    const mm = { matches: true, addEventListener: () => {}, removeEventListener: () => {} };
    const orig = globalThis.matchMedia;
    Object.defineProperty(globalThis, 'matchMedia', {
      configurable: true,
      value: () => mm,
    });
    try {
      assert.equal(getStoredTheme(), 'desert-light');
      mm.matches = false;
      assert.equal(getStoredTheme(), 'desert-dark');
    } finally {
      Object.defineProperty(globalThis, 'matchMedia', {
        configurable: true,
        value: orig,
      });
    }
  });

  test('invalid theme id falls back to graphite-dark', () => {
    store.set(THEME_STORAGE_KEY, 'neon-dark');
    assert.equal(getStoredTheme(), 'graphite-dark');
  });

  test('getFollowSystem and getStoredFamily', () => {
    assert.equal(getFollowSystem(), false);
    store.set(THEME_FOLLOW_SYSTEM_KEY, '1');
    store.set(THEME_FAMILY_KEY, 'coral');
    assert.equal(getFollowSystem(), true);
    assert.equal(getStoredFamily(), 'coral');
  });

  test('getStoredFamily derives from theme id when not following system', () => {
    store.set(THEME_STORAGE_KEY, 'ocean-dark');
    store.set(THEME_FAMILY_KEY, 'swamp');
    assert.equal(getFollowSystem(), false);
    assert.equal(getStoredFamily(), 'ocean');
  });

  test('applyTheme clears FOUC inline tokens so stylesheet themes apply', async () => {
    const { Window } = await import('happy-dom');
    const window = new Window();
    const prevDoc = globalThis.document;
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: window.document,
    });
    try {
      const { applyTheme } = await import('../src/theme.ts');
      const root = document.documentElement;
      root.style.setProperty('--mn-bg', '#111111');
      root.style.setProperty('--mn-fg', '#eeeeee');
      applyTheme('swamp-light', { persist: false });
      assert.equal(root.style.getPropertyValue('--mn-bg'), '');
      assert.equal(root.getAttribute('data-theme'), 'swamp-light');
    } finally {
      Object.defineProperty(globalThis, 'document', {
        configurable: true,
        value: prevDoc,
      });
    }
  });
});

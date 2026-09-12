/**
 * Issues remembers where you left it.
 *
 * Switching to Code and back used to reset the tab, grouping, sort, and chips,
 * which made every saved view a thing you had to re-pick. These tests pin the
 * normalization: garbage on disk falls back to the caller's defaults rather
 * than painting an empty list, and the search box is never restored.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

import {
  loadIssuesUiState,
  parseIssuesUiState,
  resetIssuesUiStateCacheForTests,
  saveIssuesUiState,
  serializeIssuesUiState,
  type IssuesPersistedUiState,
} from '../../src/issues/ui-state.ts';

const STORAGE_KEY = 'minnow.issues.uiState';

function defaults(): IssuesPersistedUiState {
  return {
    viewMode: 'list',
    groupBy: 'status',
    activeViewId: 'session:all',
    listSort: { key: 'created', direction: 'desc' },
    filters: {
      scope: 'current_workspace',
      type: 'all',
      status: 'all',
      priority: 'all',
      projectId: 'all',
      hideDone: true,
    },
  };
}

function installStorage(): Map<string, string> {
  const store = new Map<string, string>();
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
  };
  return store;
}

beforeEach(() => {
  resetIssuesUiStateCacheForTests();
});

describe('issues ui state', () => {
  test('round trips the view, grouping, sort, and chips', () => {
    const store = installStorage();
    const state: IssuesPersistedUiState = {
      ...defaults(),
      viewMode: 'board',
      groupBy: 'priority',
      activeViewId: 'builtin:triage',
      listSort: { key: 'title', direction: 'asc' },
      filters: { ...defaults().filters, scope: 'all', type: 'bug', hideDone: false },
    };
    saveIssuesUiState(state);
    assert.deepEqual(loadIssuesUiState(defaults()), state);
    assert.ok(store.has(STORAGE_KEY));
  });

  test('an unchanged save does not write again', () => {
    installStorage();
    let writes = 0;
    const storage = (globalThis as Record<string, unknown>).localStorage as {
      setItem: (key: string, value: string) => void;
    };
    const original = storage.setItem;
    storage.setItem = (key, value) => {
      writes += 1;
      original.call(storage, key, value);
    };
    saveIssuesUiState(defaults());
    saveIssuesUiState(defaults());
    assert.equal(writes, 1);
  });

  test('empty storage yields the caller defaults', () => {
    installStorage();
    assert.deepEqual(loadIssuesUiState(defaults()), defaults());
  });

  test('unparseable or nonsense values fall back instead of throwing', () => {
    const store = installStorage();
    store.set(STORAGE_KEY, '{not json');
    assert.deepEqual(loadIssuesUiState(defaults()), defaults());

    assert.deepEqual(
      parseIssuesUiState(
        { viewMode: 'kanban', groupBy: 'phase-of-moon', listSort: { key: 'nope' } },
        defaults(),
      ),
      defaults(),
    );
  });

  test('storage that throws is survivable — a private window is not a crash', () => {
    (globalThis as Record<string, unknown>).localStorage = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    assert.deepEqual(loadIssuesUiState(defaults()), defaults());
    saveIssuesUiState(defaults());
  });

  test('the search box is not part of the persisted shape', () => {
    assert.equal(serializeIssuesUiState(defaults()).includes('search'), false);
  });
});

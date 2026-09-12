/**
 * Built-in saved views seed when the file has none.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import {
  BUILTIN_VIEW_AGENTS,
  BUILTIN_VIEW_MY_OPEN,
  BUILTIN_VIEW_TRIAGE,
  builtInIssueViews,
  migrateBuiltInIssueViews,
  parseViewFilters,
} from '../../src/issues/saved-views.ts';
import {
  addIssueView,
  deleteIssueView,
  ensureIssueViews,
  listIssueViews,
  setIssuesNowForTests,
  setIssuesStateForTests,
} from '../../src/state/issues-store.ts';

const FIXED_NOW = 1_710_000_005_000;

describe('saved views', () => {
  beforeEach(() => {
    setIssuesNowForTests(() => FIXED_NOW);
    setIssuesStateForTests({ version: 2, nextId: 1, issues: [], workspaces: {} });
  });

  test('built-in catalog is Triage, Assigned to agents, My open', () => {
    const ids = builtInIssueViews().map((view) => view.id);
    assert.deepEqual(ids, [BUILTIN_VIEW_TRIAGE, BUILTIN_VIEW_AGENTS, BUILTIN_VIEW_MY_OPEN]);
  });

  test('ensureIssueViews seeds builtins when views is empty', () => {
    const seeded = ensureIssueViews();
    assert.equal(seeded.length, 3);
    assert.deepEqual(
      listIssueViews().map((view) => view.id),
      [BUILTIN_VIEW_TRIAGE, BUILTIN_VIEW_AGENTS, BUILTIN_VIEW_MY_OPEN],
    );
  });

  test('Triage hides closed issues — a fixed crash is not still waiting on you', () => {
    const triage = builtInIssueViews().find((view) => view.id === BUILTIN_VIEW_TRIAGE);
    assert.equal(parseViewFilters(triage?.filters).hideDone, true);
    assert.equal(parseViewFilters(triage?.filters).unreviewed, true);
  });

  test('a persisted Triage view that shipped with hideDone: false is repaired', () => {
    setIssuesStateForTests({
      version: 2,
      nextId: 1,
      issues: [],
      workspaces: {},
      views: [
        {
          id: BUILTIN_VIEW_TRIAGE,
          name: 'Triage',
          filters: { unreviewed: true, hideDone: false },
          groupBy: 'status',
          order: 0,
          builtIn: true,
        },
      ],
    });
    const views = ensureIssueViews();
    assert.equal(parseViewFilters(views[0].filters).hideDone, true);
    assert.equal(parseViewFilters(views[0].filters).unreviewed, true);
    // Second pass is a no-op, so it does not churn the store on every open.
    assert.equal(migrateBuiltInIssueViews(views), false);
  });

  test('user views persist and builtins cannot be deleted', () => {
    ensureIssueViews();
    const created = addIssueView({ name: 'Bugs', filters: { type: 'bug' } });
    assert.equal(created.name, 'Bugs');
    assert.equal(deleteIssueView(BUILTIN_VIEW_TRIAGE), false);
    assert.equal(deleteIssueView(created.id), true);
    assert.equal(listIssueViews().some((view) => view.id === created.id), false);
  });
});

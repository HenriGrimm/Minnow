/**
 * Issues reopens where you left it.
 *
 * The app is one surface among many; switching to Code and back used to drop
 * you on All / list / group-by-status regardless of the view you had chosen.
 * This drives the real page: saved state on disk, then a first open.
 */

import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { Window } from 'happy-dom';

const win = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: win, document: win.document, HTMLElement: win.HTMLElement,
  Node: win.Node, SVGElement: win.SVGElement, Element: win.Element,
  HTMLInputElement: win.HTMLInputElement, HTMLSelectElement: win.HTMLSelectElement,
  HTMLTextAreaElement: win.HTMLTextAreaElement, HTMLButtonElement: win.HTMLButtonElement,
  HTMLFormElement: win.HTMLFormElement, HTMLParagraphElement: win.HTMLParagraphElement,
  HTMLLabelElement: win.HTMLLabelElement, NodeFilter: win.NodeFilter,
  AbortController: win.AbortController, AbortSignal: win.AbortSignal,
  localStorage: win.localStorage,
  getComputedStyle: win.getComputedStyle.bind(win),
});
document.body.innerHTML =
  '<div id="osAppsLayer"><main id="issuesView" class="issues-page"></main></div>' +
  '<div id="sDot"></div><div id="sText"></div>';

// Written before the page module loads, exactly as a previous session left it.
localStorage.setItem(
  'minnow.issues.uiState',
  JSON.stringify({
    viewMode: 'board',
    groupBy: 'priority',
    activeViewId: 'builtin:my-open',
    listSort: { key: 'title', direction: 'asc' },
    filters: {
      scope: 'all',
      type: 'all',
      status: 'all',
      priority: 'all',
      projectId: 'all',
      hideDone: true,
    },
  }),
);

const store = await import('../../src/state/issues-store.ts');
const { closeIssues, openIssues } = await import('../../src/ui/issues-page.ts');

store.setIssuesStateForTests({
  version: 2,
  nextId: 2,
  issues: [{
    id: 'MIN-1', type: 'task', title: 'Still open', description: '',
    status: 'todo', priority: 'none', labels: [], workspacePath: '',
    createdAt: 1, updatedAt: 1, source: 'user',
  }],
  workspaces: {},
});

after(() => {
  closeIssues({ skipNavigate: true });
  store.setIssuesStateForTests(null);
  win.close();
});

test('the saved view, grouping, sort, and scope come back on first open', async () => {
  await openIssues();

  assert.equal(
    document.getElementById('issuesViewBoard')?.getAttribute('aria-pressed'),
    'true',
    'board view mode restored',
  );
  assert.equal(
    document.getElementById('issuesViewList')?.getAttribute('aria-pressed'),
    'false',
  );
  assert.equal(document.getElementById('btnIssuesGroupBy')?.textContent, 'Group: Priority');
  assert.equal(
    (document.getElementById('issuesScope') as HTMLSelectElement | null)?.value,
    'all',
    'workspace scope restored',
  );

  assert.equal((document.getElementById('issuesSavedView') as HTMLSelectElement).value, 'builtin:my-open');

});

test('switching views resets defaults and saved filter chips remain editable', async () => {
  const base = {
    type: 'task' as const, description: '', priority: 'none' as const,
    labels: [], workspacePath: '', createdAt: 1, updatedAt: 1, source: 'user' as const,
  };
  store.setIssuesStateForTests({
    version: 2, nextId: 4, workspaces: {},
    issues: [
      { ...base, id: 'MIN-1', title: 'Open task', status: 'todo' },
      { ...base, id: 'MIN-2', title: 'Completed task', status: 'done' },
      { ...base, id: 'MIN-3', type: 'bug', title: 'Open bug', status: 'todo' },
    ],
  });
  await openIssues();
  const select = document.getElementById('issuesSavedView') as HTMLSelectElement;
  const choose = (id: string): void => {
    select.value = id;
    select.dispatchEvent(new win.Event('change', { bubbles: true }));
  };
  const shown = (): string => document.getElementById('issuesPanelMount')?.textContent ?? '';
  assert.equal(document.querySelector('[role="tablist"]'), null);
  store.queueIssueAgent('MIN-2', 'builder');
  choose('builtin:agents');
  assert.ok(shown().includes('Completed task'));
  assert.ok(!shown().includes('Open task'));
  assert.ok(!shown().includes('Open bug'));
  choose('builtin:my-open');
  assert.ok(!shown().includes('Completed task'));
  choose('session:all');
  assert.ok(shown().includes('Completed task'), 'All resets hide-done');
  assert.equal(select.value, 'session:all');
  assert.match(document.getElementById('issuesViewDescription')?.textContent ?? '', /including completed/);
  assert.equal((document.getElementById('issuesScope') as HTMLSelectElement).value, 'all');

  const bugs = store.addIssueView({ name: 'Bugs', filters: { type: 'bug', hideDone: true } });
  choose(bugs.id);
  assert.ok(shown().includes('Open bug'));
  assert.ok(!shown().includes('Open task'));
  const typeChip = document.querySelector<HTMLButtonElement>('[data-chip-id="type"]');
  assert.ok(typeChip);
  typeChip.click();
  assert.ok(shown().includes('Open task'), 'removing the chip removes the saved type filter');
  assert.ok(!shown().includes('Completed task'), 'other saved defaults remain active');
  choose('session:all');
  assert.equal(document.querySelector('[data-chip-id="type"]'), null);
  assert.ok(shown().includes('Completed task'));
  assert.equal(document.getElementById('issuesSavedView'), select, 'selector stays mounted');
});

test('a saved view that no longer exists falls back to All in the view selector', async () => {
  localStorage.setItem(
    'minnow.issues.uiState',
    JSON.stringify({ ...JSON.parse(localStorage.getItem('minnow.issues.uiState') ?? '{}'), activeViewId: 'view-deleted', groupBy: 'priority' }),
  );
  // Restore runs once per session, so reload the page module to replay a boot.
  const fresh = await import(`../../src/ui/issues-page.ts?restore-fallback`);
  await fresh.openIssues();

  assert.equal((document.getElementById('issuesSavedView') as HTMLSelectElement).value, 'session:all');
  // The rest of the blob still applied, so this is the id falling back rather
  // than restore having been skipped wholesale.
  assert.equal(document.getElementById('btnIssuesGroupBy')?.textContent, 'Group: Priority');
});


test('legacy saved filters migrate once and removed chips stay removed after reload', async () => {
  const view = store.addIssueView({ name: 'Legacy bugs', filters: { type: 'bug', projectId: null } });
  const persisted = JSON.parse(localStorage.getItem('minnow.issues.uiState') ?? '{}');
  delete persisted.filterVersion;
  persisted.activeViewId = view.id;
  persisted.filters.type = 'all';
  persisted.filters.projectId = 'all';
  localStorage.setItem('minnow.issues.uiState', JSON.stringify(persisted));
  const migrated = await import('../../src/ui/issues-page.ts?legacy-filter-migration');
  await migrated.openIssues();
  const typeChip = document.querySelector<HTMLButtonElement>('[data-chip-id="type"]');
  assert.ok(typeChip);
  assert.match(typeChip.textContent ?? '', /bug/);
  const projectChip = document.querySelector<HTMLButtonElement>('[data-chip-id="project"]');
  assert.ok(projectChip);
  assert.match(projectChip.textContent ?? '', /No project/);
  typeChip.click();
  projectChip.click();
  const restored = await import('../../src/ui/issues-page.ts?editable-filter-restore');
  await restored.openIssues();
  assert.equal(document.querySelector('[data-chip-id="type"]'), null);
  assert.equal(document.querySelector('[data-chip-id="project"]'), null);
  assert.equal((document.getElementById('issuesSavedView') as HTMLSelectElement).value, view.id);
  restored.closeIssues({ skipNavigate: true });
  migrated.closeIssues({ skipNavigate: true });
});

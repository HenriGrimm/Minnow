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

  const activeTab = document.querySelector('#issuesViewTabs .issues-view-tab.is-active');
  assert.ok(activeTab instanceof HTMLElement);
  assert.equal(activeTab.dataset.viewId, 'builtin:my-open');
});

test('a saved view that no longer exists falls back to All rather than no tab', async () => {
  localStorage.setItem(
    'minnow.issues.uiState',
    JSON.stringify({ ...JSON.parse(localStorage.getItem('minnow.issues.uiState') ?? '{}'), activeViewId: 'view-deleted' }),
  );
  // Restore runs once per session, so reload the page module to replay a boot.
  const fresh = await import(`../../src/ui/issues-page.ts?restore-fallback`);
  await fresh.openIssues();

  const activeTab = document.querySelector('#issuesViewTabs .issues-view-tab.is-active');
  assert.ok(activeTab instanceof HTMLElement);
  assert.equal(activeTab.dataset.viewId, 'session:all');
  // The rest of the blob still applied, so this is the id falling back rather
  // than restore having been skipped wholesale.
  assert.equal(document.getElementById('btnIssuesGroupBy')?.textContent, 'Group: Priority');
});

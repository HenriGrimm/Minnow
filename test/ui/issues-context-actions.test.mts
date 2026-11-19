import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { Window } from 'happy-dom';

const dom = new Window({ url: 'http://localhost/' });
for (const name of ['window', 'document', 'HTMLElement', 'HTMLLabelElement', 'HTMLButtonElement', 'HTMLInputElement', 'HTMLSelectElement', 'HTMLTextAreaElement', 'HTMLFormElement', 'HTMLParagraphElement', 'Node', 'NodeFilter', 'Element', 'SVGElement', 'AbortController', 'AbortSignal'] as const) {
  (globalThis as Record<string, unknown>)[name] = name === 'window' ? dom : dom[name];
}
globalThis.getComputedStyle = dom.getComputedStyle.bind(dom) as typeof getComputedStyle;
document.body.innerHTML = '<main id="issuesView"></main>';
const { initIssuesPage, openIssues, renderIssuesPanel } = await import('../../src/ui/issues-page.ts');
const { closeContextMenu } = await import('../../src/ui/context-menu.ts');
const store = await import('../../src/state/issues-store.ts');
const { setIssuesGithubMode } = await import('../../src/state/issues-github.ts');
const config = await import('../../src/tools/config.ts');
config.setLocalServerAvailableForTests(false);
const issue = (id: string, status: string) => ({
  id, type: 'task', title: id, description: '', status, priority: 'none',
  labels: [], workspacePath: '', createdAt: 1, updatedAt: 1, source: 'user' as const,
});
store.setIssuesStateForTests({
  version: 2, nextId: 3, issues: [issue('MIN-1', 'todo'), issue('MIN-2', 'done')],
});
initIssuesPage();
await openIssues();
after(() => {
  closeContextMenu();
  config.setLocalServerAvailableForTests(false);
  store.setIssuesStateForTests(null);
  dom.close();
});
const mount = () => document.getElementById('issuesPanelMount')!;
const item = (id: string) => {
  const row = document.querySelector<HTMLButtonElement>(`.mn-menu__item[data-id="${id}"]`);
  assert.ok(row, `menu includes ${id}`);
  return row;
};
function rightClick(target: Element): boolean {
  const event = new dom.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}
function checkNewPanel(): void {
  item('new-issue').click();
  assert.ok(document.getElementById('issuesNewForm')?.classList.contains('is-open'));
  assert.equal((document.getElementById('issuesNewTitle') as HTMLInputElement).value, '');
  assert.equal(store.listIssues({ scope: 'all' }).length, 2, 'opening the panel does not create an issue');
  document.getElementById('btnIssuesNewCancel')!.click();
}

test('Sync all sits beside New issue independently of the filters', () => {
  const sync = document.querySelector<HTMLButtonElement>('#btnIssuesSyncAll')!;
  const filters = document.getElementById('btnIssuesFilters')!;
  assert.equal(sync.previousElementSibling?.id, 'btnIssuesNew');
  assert.equal(sync.closest('.issues-extra-filters'), null);
  assert.ok(sync.classList.contains('mn-btn--secondary'));
  assert.equal(sync.hidden, true);

  try {
    setIssuesGithubMode('mirror');
    assert.equal(filters.getAttribute('aria-expanded'), 'false');
    assert.equal(sync.hidden, false);
    filters.click();
    assert.equal(filters.getAttribute('aria-expanded'), 'true');
    assert.equal(sync.hidden, false);
  } finally {
    if (filters.getAttribute('aria-expanded') === 'true') filters.click();
    setIssuesGithubMode('off');
  }
  assert.equal(sync.hidden, true);
});

test('blank list and board menus expose filters and open the New issue panel', async () => {
  for (const view of ['issuesViewList', 'issuesViewBoard']) {
    document.getElementById(view)!.click();
    assert.equal(rightClick(mount()), true);
    item('filters').click();
    for (const id of ['type', 'status', 'priority', 'project', 'hide-done']) item(id);
    closeContextMenu();
    rightClick(mount());
    checkNewPanel();
  }
  document.getElementById('issuesViewList')!.click();
});

test('populated groups own their list items and the Add label button keeps keyboard activation', () => {
  const row = mount().querySelector<HTMLElement>('.issues-row')!;
  assert.equal(row.parentElement?.getAttribute('role'), 'list');
  assert.equal(row.getAttribute('role'), 'listitem');
  assert.equal(row.hasAttribute('aria-selected'), false);
  const add = row.querySelector<HTMLButtonElement>('button[aria-label="Add label"]')!;
  add.focus();
  const activation = new dom.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
  add.dispatchEvent(activation);
  assert.equal(activation.defaultPrevented, false);
  add.click(); // happy-dom does not dispatch the native activation click from a synthetic key.
  assert.equal(add.getAttribute('aria-expanded'), 'true');
  assert.doesNotMatch(window.location.hash, /MIN-\d+/);
  add.click();
});

test('blank-area filters change the visible issues and can show completed issues', async () => {
  rightClick(mount());
  item('filters').click();
  item('status').click();
  item('todo').click();
  await Promise.resolve();
  assert.equal(mount().querySelectorAll('.issues-row').length, 1);
  assert.match(mount().textContent ?? '', /MIN-1/);
  (document.querySelector('[data-chip-id="status"]') as HTMLButtonElement).click();
  renderIssuesPanel();
  const shownBefore = mount().querySelectorAll('.issues-row').length;
  rightClick(mount());
  item('filters').click();
  item('hide-done').click();
  await Promise.resolve();
  assert.notEqual(mount().querySelectorAll('.issues-row').length, shownBefore);
});

test('row and card menus keep issue actions and also open New issue', async () => {
  for (const [view, selector] of [['issuesViewList', '.issues-row'], ['issuesViewBoard', '.issues-card']]) {
    document.getElementById(view)!.click();
    const row = mount().querySelector(selector)!;
    assert.ok(row);
    rightClick(row);
    for (let attempt = 0; attempt < 100 && !document.querySelector('.mn-menu__item[data-id="open"]'); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    item('open');
    assert.equal(document.querySelector('.mn-menu__item[data-id="filters"]'), null);
    checkNewPanel();
  }
});

test('blank empty-state menu works without intercepting editing or project controls', async () => {
  document.getElementById('issuesViewList')!.click();
  const input = document.createElement('input');
  mount().appendChild(input);
  assert.equal(rightClick(input), false);
  assert.equal(document.querySelector('.mn-menu'), null);
  input.remove();
  const search = document.getElementById('issuesSearch') as HTMLInputElement;
  search.value = 'no matching issue';
  search.dispatchEvent(new dom.Event('input', { bubbles: true }));
  assert.ok(mount().querySelector('.issues-empty'));
  assert.equal(rightClick(mount().querySelector('.issues-empty')!), true);
  item('filters');
  checkNewPanel();
  document.getElementById('btnIssuesScreenProjects')!.click();
  assert.equal(rightClick(mount()), false);
  assert.equal(document.querySelector('.mn-menu'), null);
});

test('the parent workspace lists child cards and filters list and board by folder', async (t) => {
  const { setWorkspaceFromServer } = await import('../../src/state/workspace.ts');
  const workspacePath = 'C:/Coltiva';
  const repoId = 'apps/services/backend';
  t.mock.method(globalThis, 'fetch', async () => Response.json({
    ok: true,
    repos: [
      { id: repoId, relPath: repoId, absPath: `${workspacePath}/${repoId}`, isRoot: false,
        remote: { host: 'github', slug: 'acme/backend' } },
      { id: 'frontend', relPath: 'frontend', absPath: `${workspacePath}/frontend`, isRoot: false, remote: null },
    ],
  }));
  store.setIssuesStateForTests({ version: 2, nextId: 5, issues: [
    { ...issue('MIN-1', 'todo'), workspacePath, repos: [repoId, 'frontend'] },
    { ...issue('MIN-2', 'todo'), workspacePath: 'c:/coltiva/apps/services/backend' },
    { ...issue('MIN-3', 'todo'), workspacePath },
    { ...issue('MIN-4', 'todo'), workspacePath: 'C:/Coltiva-other' },
  ] });
  setWorkspaceFromServer({ path: workspacePath, label: 'Coltiva', isDefault: false });
  document.getElementById('btnIssuesScreenIssues')?.click();
  const search = document.getElementById('issuesSearch') as HTMLInputElement;
  search.value = '';
  search.dispatchEvent(new dom.Event('input', { bubbles: true }));
  await openIssues({ screen: 'issues' });
  const { fetchWorkspaceRepos } = await import('../../src/state/workspace-repos.ts');
  await fetchWorkspaceRepos({ workspacePath });
  assert.match(mount().textContent!, /MIN-1/);
  assert.match(mount().textContent!, /MIN-2/);
  assert.match(mount().textContent!, /MIN-3/);
  assert.doesNotMatch(mount().textContent!, /MIN-4/);
  const workspaceLabel = (id: string) => mount().querySelector<HTMLElement>(
    `[data-issue-id="${id}"] .issues-workspace-label`,
  )!;
  const workspaceButton = (id: string, name: string) =>
    [...workspaceLabel(id).querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === name)!;
  assert.equal(workspaceLabel('MIN-1').textContent, 'apps/services/backend, frontend');
  assert.equal(workspaceLabel('MIN-1').title, 'C:/Coltiva/apps/services/backend\nC:/Coltiva/frontend');
  assert.equal(workspaceLabel('MIN-2').textContent, repoId);
  assert.equal(workspaceLabel('MIN-3').textContent, 'Coltiva');
  const subWorkspace = document.querySelector<HTMLButtonElement>('#btnIssuesSubWorkspace')!;
  assert.equal(subWorkspace.hidden, false);
  const route = window.location.hash;
  workspaceButton('MIN-1', 'frontend').click();
  assert.deepEqual([...mount().querySelectorAll<HTMLElement>('.issues-row')].map((row) => row.dataset.issueId), ['MIN-1']);
  assert.equal(subWorkspace.textContent?.trim(), 'frontend');
  assert.equal(workspaceButton('MIN-1', 'frontend').getAttribute('aria-pressed'), 'true');
  assert.equal(window.location.hash, route);
  workspaceButton('MIN-1', 'frontend').click();
  assert.match(mount().textContent!, /MIN-2/);
  const sync = document.querySelector<HTMLButtonElement>('#btnIssuesSyncAll')!;
  assert.equal(sync.hidden, false);
  assert.match(sync.textContent ?? '', /Import from GitHub/);
  subWorkspace.click();
  item('sub-workspace:apps/services').click();
  assert.match(subWorkspace.textContent ?? '', /apps\/services/);
  for (const view of ['issuesViewList', 'issuesViewBoard']) {
    document.getElementById(view)!.click();
    assert.match(mount().textContent!, /MIN-1/);
    assert.match(mount().textContent!, /MIN-2/);
    assert.doesNotMatch(mount().textContent!, /MIN-3|MIN-4/);
    assert.equal(workspaceLabel('MIN-1').textContent, 'apps/services/backend, frontend');
    assert.equal(workspaceLabel('MIN-2').textContent, repoId);
  }
  workspaceButton('MIN-1', 'frontend').click();
  assert.deepEqual([...mount().querySelectorAll<HTMLElement>('.issues-card')].map((card) => card.dataset.issueId), ['MIN-1']);
  document.querySelector<HTMLButtonElement>('[data-chip-id="sub-workspace"]')!.click();
  assert.match(mount().textContent!, /MIN-3/);
  subWorkspace.click();
  item('all-workspaces').click();
  assert.equal(workspaceLabel('MIN-2').textContent, 'Coltiva/apps/services/backend');
  assert.equal(workspaceLabel('MIN-4').textContent, 'Coltiva-other');
  workspaceButton('MIN-4', 'Coltiva-other').click();
  assert.deepEqual([...mount().querySelectorAll<HTMLElement>('.issues-card')].map((card) => card.dataset.issueId), ['MIN-4']);
  assert.equal(document.querySelector<HTMLSelectElement>('#issuesScope')?.value, 'all');
  assert.equal(subWorkspace.textContent?.trim(), 'Coltiva-other');
  subWorkspace.click();
  item('all-workspaces').click();
  assert.match(mount().textContent!, /MIN-1/);
});

test('Workspace header sorts by displayed repo in both directions', () => {
  const workspacePath = 'C:/Coltiva';
  store.setIssuesStateForTests({ version: 2, nextId: 4, issues: [
    { ...issue('MIN-1', 'todo'), workspacePath, repos: ['coltiva-frontend'] },
    { ...issue('MIN-2', 'todo'), workspacePath, repos: ['coltiva-backend'] },
    { ...issue('MIN-3', 'todo'), workspacePath, repos: ['coltiva-frontend'] },
  ] });
  document.getElementById('issuesViewList')!.click();
  const order = () => [...mount().querySelectorAll<HTMLElement>('.issues-row')].map((row) => row.dataset.issueId);
  const header = document.querySelector<HTMLButtonElement>('button[data-sort-key="workspace"]')!;
  header.click();
  assert.equal(header.dataset.sortDirection, 'ascending');
  assert.deepEqual(order(), ['MIN-2', 'MIN-1', 'MIN-3']);
  header.click();
  assert.equal(header.dataset.sortDirection, 'descending');
  assert.deepEqual(order(), ['MIN-1', 'MIN-3', 'MIN-2']);
});

test('the Workspace column is hidden for a single repo and available across workspaces', async (t) => {
  const { setWorkspaceFromServer } = await import('../../src/state/workspace.ts');
  const { fetchWorkspaceRepos } = await import('../../src/state/workspace-repos.ts');
  const workspacePath = 'C:/OneRepo';
  t.mock.method(globalThis, 'fetch', async () => Response.json({ ok: true, repos: [
    { id: '.', relPath: '.', absPath: workspacePath, isRoot: true, remote: null },
  ] }));
  store.setIssuesStateForTests({ version: 2, nextId: 3, issues: [
    { ...issue('MIN-1', 'todo'), workspacePath },
    { ...issue('MIN-2', 'todo'), workspacePath: 'C:/AnotherRepo' },
  ] });
  setWorkspaceFromServer({ path: workspacePath, label: 'One repo', isDefault: false });
  await openIssues();
  await fetchWorkspaceRepos({ workspacePath });
  const scope = document.querySelector<HTMLSelectElement>('#issuesScope')!;
  const header = document.querySelector<HTMLButtonElement>('[data-sort-key="workspace"]')!;
  scope.value = 'current_workspace';
  scope.dispatchEvent(new dom.Event('change', { bubbles: true }));
  assert.equal(header.hidden, true);
  assert.ok(header.closest('.is-workspace-column-hidden'));
  assert.equal(document.querySelector('[data-sort-key="created"]')?.getAttribute('data-sort-direction'), 'descending');
  scope.value = 'all';
  scope.dispatchEvent(new dom.Event('change', { bubbles: true }));
  assert.equal(header.hidden, false);
  assert.equal(header.dataset.sortDirection, 'descending');
});

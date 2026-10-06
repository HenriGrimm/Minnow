import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { Window } from 'happy-dom';

const dom = new Window({ url: 'http://localhost/' });
for (const name of ['window', 'document', 'HTMLElement', 'HTMLLabelElement', 'HTMLButtonElement', 'HTMLInputElement', 'HTMLSelectElement', 'HTMLTextAreaElement', 'HTMLFormElement', 'HTMLParagraphElement', 'Node', 'NodeFilter', 'Element', 'SVGElement', 'AbortController', 'AbortSignal'] as const) {
  (globalThis as Record<string, unknown>)[name] = name === 'window' ? dom : dom[name];
}
globalThis.localStorage = dom.localStorage;
globalThis.getComputedStyle = dom.getComputedStyle.bind(dom) as typeof getComputedStyle;
globalThis.matchMedia = dom.matchMedia.bind(dom) as typeof matchMedia;
const { setStorageModeForTests } = await import('../../src/config/storage-mode.ts');
setStorageModeForTests('localStorage');
document.body.innerHTML = `<aside id="fileSidebar"><span id="fileSidebarTitle">Files</span><button id="btnFileSidebarCollapse"></button><button id="btnIssuesPanelToggle"></button><button id="btnFileTreeRefresh"></button><div id="fileSidebarFilesView"></div><div id="gitPanelRoot" hidden></div><div id="issuesSidebarRoot" hidden></div></aside><div id="sDot"></div><div id="sText"></div>`;
const store = await import('../../src/state/issues-store.ts');
const { setWorkspaceFromServer } = await import('../../src/state/workspace.ts');
const { setLocalServerAvailableForTests } = await import('../../src/tools/config.ts');
const { resetFilePanelStateForTests } = await import('../../src/state/file-panel.ts');
const { openIssuesSidebar } = await import('../../src/ui/issues-sidebar.ts');
const { closeFileSidebar, closeMobileFileSidebar, toggleFileSidebarLayout } = await import('../../src/ui/file-layout.ts');
const { isIssuesSidebarActive } = await import('../../src/ui/file-sidebar-view.ts');
const { buildIssueRowMenuItems } = await import('../../src/ui/issues-page.ts');
setLocalServerAvailableForTests(false);
setWorkspaceFromServer({ path: 'C:/Projects/Minnow', label: 'Minnow', isDefault: false });
store.setIssuesStateForTests({ version: 2, schemaRevision: 3, nextId: 1, issues: [] });
const input = () => document.getElementById('issuesSidebarDraft') as HTMLTextAreaElement;
function type(text: string): void {
  input().value = text;
  input().dispatchEvent(new dom.Event('input', { bubbles: true }) as unknown as Event);
}
async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(check(), 'UI operation completed');
}
after(async () => { store.setIssuesStateForTests(null); resetFilePanelStateForTests(); await dom.happyDOM.close(); });

test('sidebar creates and expands in the background while capture stays ready', async () => {
  await openIssuesSidebar();
  assert.equal(isIssuesSidebarActive(), true);
  assert.equal(document.getElementById('fileSidebarFilesView')!.hasAttribute('hidden'), true);
  type('Preview loses focus\nReproduce by switching tabs.');
  const issuesButton = document.getElementById('btnIssuesPanelToggle')!;
  for (const mobile of [false, true]) {
    const originalMatchMedia = dom.matchMedia;
    dom.matchMedia = ((query: string) => ({ matches: mobile, media: query })) as typeof dom.matchMedia;
    try {
      await openIssuesSidebar();
      assert.equal(issuesButton.classList.contains('is-active'), true);
      assert.equal(issuesButton.getAttribute('aria-pressed'), 'true');
      if (mobile) closeMobileFileSidebar();
      else closeFileSidebar();
      assert.equal(issuesButton.classList.contains('is-active'), false);
      assert.equal(issuesButton.getAttribute('aria-pressed'), 'false');
      assert.equal(isIssuesSidebarActive(), true);
      await openIssuesSidebar();
      assert.equal(issuesButton.classList.contains('is-active'), true);
      assert.equal(issuesButton.getAttribute('aria-pressed'), 'true');
      assert.equal(input().value, 'Preview loses focus\nReproduce by switching tabs.');
    } finally {
      dom.matchMedia = originalMatchMedia;
    }
  }
  await toggleFileSidebarLayout();
  assert.equal(isIssuesSidebarActive(), false);
  await openIssuesSidebar();
  assert.equal(input().value, 'Preview loses focus\nReproduce by switching tabs.');
  const { setExpandIssueFetcherForTests } = await import('../../src/ui/issues-expand.ts');
  let finishExpansion!: () => void;
  setExpandIssueFetcherForTests(async () => {
    await new Promise<void>((resolve) => { finishExpansion = resolve; });
    return { draft: { title: 'Preview returns focus', type: 'bug' } };
  });
  document.querySelector<HTMLButtonElement>('[data-expand]')!.click();
  await until(() => input().value === '' && Boolean(finishExpansion));
  assert.equal(store.listIssues().length, 1);
  const issue = store.listIssues()[0];
  assert.equal(issue.title, 'Preview loses focus');
  assert.equal(issue.description, 'Reproduce by switching tabs.');
  assert.equal(issue.workspacePath, 'C:/Projects/Minnow');
  assert.equal(document.getElementById('issuesNewForm')?.classList.contains('is-open') ?? false, false);
  assert.equal(input().disabled, false);
  assert.equal(document.activeElement, input());
  type('Next issue');
  finishExpansion();
  await until(() => store.findIssueById(issue.id)?.title === 'Preview returns focus');
  setExpandIssueFetcherForTests(null);
  assert.equal(store.findIssueById(issue.id)?.type, 'bug');
  assert.equal(input().value, 'Next issue');
  assert.equal(document.activeElement, input());
  document.querySelector<HTMLFormElement>('.issues-sidebar__capture')!.dispatchEvent(new dom.Event('submit', { cancelable: true }) as unknown as Event);
  await until(() => input().value === '');
  assert.equal(store.listIssues().length, 2);
  document.querySelector<HTMLButtonElement>('[data-issue-id]')!.click();
  assert.match(document.querySelector('.issues-sidebar__detail')!.textContent ?? '', /Reproduce by switching tabs/);
  assert.equal(window.location.hash, '');
  let viewed = false;
  let edited = false;
  const items = await buildIssueRowMenuItems(issue, [issue.id], { view: () => { viewed = true; }, edit: () => { edited = true; } });
  items.find((item) => item.id === 'open')!.onSelect!();
  items.find((item) => item.id === 'edit')!.onSelect!();
  assert.ok(viewed && edited);
  for (const id of ['send-to-chat', 'change-status', 'change-priority', 'change-type', 'change-labels', 'change-project', 'change-assignee', 'delete']) assert.ok(items.some((item) => item.id === id), id);
  assert.equal(items.some((item) => item.id === 'select'), false);
});

test('sidebar shares editable detail and chips while preserving the main app selection', async () => {
  const { openIssueDetail, closeIssueDetail, getSelectedIssueId, refreshIssueDetailIfOpen } = await import('../../src/ui/issues-detail.ts');
  const { getIssuesTaxonomySync } = await import('../../src/state/issues-taxonomy-store.ts');
  const { createIssueTypeChip, createIssueStatusChip, createIssuePriorityChip } = await import('../../src/issues/type-icons.ts');
  const { getIssueLabelSwatch } = store;
  const original = store.listIssues()[0];
  store.updateIssue(original.id, { labels: ['onboarding'], priority: 'high' });
  const parent = store.addIssue({ title: 'Parent issue', type: 'task', workspacePath: 'C:/Projects/Minnow' });
  store.updateIssue(original.id, { parentId: parent.id });
  document.body.insertAdjacentHTML('beforeend', '<main id="issuesView" class="issues-page"><div class="issues-shell"><div class="issues-body"></div></div></main>');
  openIssueDetail(parent.id);
  const appEditor = document.querySelector('#issuesDetailHost .mn-editor');
  const sidebar = document.getElementById('issuesSidebarRoot')!;
  sidebar.querySelector<HTMLButtonElement>('.issues-sidebar__detail-toolbar button')!.click();
  const search = sidebar.querySelector<HTMLInputElement>('input[type="search"]')!;
  search.value = original.id;
  search.dispatchEvent(new dom.Event('input', { bubbles: true }) as unknown as Event);
  const row = sidebar.querySelector('.issues-sidebar__row')!;
  const taxonomy = getIssuesTaxonomySync();
  const issue = store.findIssueById(original.id)!;
  for (const [selector, chip] of [
    ['.issues-type-chip', createIssueTypeChip(issue.type, taxonomy.types.find((entry) => entry.id === issue.type))],
    ['.issues-status-chip', createIssueStatusChip(issue.status, taxonomy.statuses.find((entry) => entry.id === issue.status))],
    ['.issues-priority-chip', createIssuePriorityChip(issue.priority, taxonomy.priorities.find((entry) => entry.id === issue.priority))],
  ] as const) assert.equal(row.querySelector(selector)?.outerHTML, chip.outerHTML);
  assert.equal(row.querySelector<HTMLElement>('.issues-label-chip')?.dataset.swatch, getIssueLabelSwatch('onboarding'));
  const list = sidebar.querySelector<HTMLElement>('.issues-sidebar__list')!;
  list.scrollTop = 120;
  row.querySelector<HTMLButtonElement>('[data-issue-id]')!.click();
  const title = sidebar.querySelector<HTMLTextAreaElement>('.issues-detail__title')!;
  assert.ok(title);
  assert.ok(sidebar.querySelector('.issues-comments__composer'));
  assert.equal(getSelectedIssueId(), parent.id);
  assert.equal(document.querySelector('#issuesDetailHost .mn-editor'), appEditor);
  title.focus();
  title.value = 'Updated in Code';
  store.updateIssue(parent.id, { title: 'Background update' });
  assert.equal(sidebar.querySelector('.issues-detail__title'), title, 'background updates retain the active editor');
  title.dispatchEvent(new dom.Event('change') as unknown as Event);
  assert.equal(store.findIssueById(original.id)?.title, 'Updated in Code');
  sidebar.querySelector('.mn-editor__para')!.textContent = 'Edited without leaving Code.';
  sidebar.querySelector<HTMLButtonElement>('.issues-sidebar__detail-toolbar button')!.click();
  assert.equal(store.findIssueById(original.id)?.description, 'Edited without leaving Code.');
  assert.equal(search.value, original.id);
  assert.equal(list.scrollTop, 120);
  assert.equal((document.activeElement as HTMLElement).dataset.issueId, original.id);
  sidebar.querySelector<HTMLButtonElement>('[data-issue-id]')!.click();
  sidebar.querySelector<HTMLButtonElement>('.issues-detail__parent-line-btn')!.click();
  assert.equal(sidebar.querySelector<HTMLElement>('.issues-detail')?.dataset.issueId, parent.id);
  assert.equal(window.location.hash, '');
  const cards = store.listIssues().map((card) => card.id === parent.id ? { ...card, title: 'Expanded from shared action' } : card);
  store.setIssuesStateForTests({ version: 2, schemaRevision: 3, nextId: 20, issues: cards });
  refreshIssueDetailIfOpen();
  assert.equal(sidebar.querySelector<HTMLTextAreaElement>('.issues-detail__title')?.value, 'Expanded from shared action');
  assert.equal(document.querySelector<HTMLTextAreaElement>('#issuesDetailHost .issues-detail__title')?.value, 'Expanded from shared action');
  sidebar.querySelector<HTMLButtonElement>('.issues-detail__close')!.click();
  assert.equal(sidebar.querySelector<HTMLElement>('.issues-sidebar__detail')!.hidden, true);
  assert.equal(getSelectedIssueId(), parent.id, 'closing Code detail does not close the main app detail');
  closeIssueDetail();
});

test('View all issues navigates from Code to the Issues app', async () => {
  const { getRouterStateForTests, resetOsRouterForTests } = await import('../../src/os/router.ts');
  window.location.hash = '#/app/code/chat';
  await openIssuesSidebar();
  document.querySelector<HTMLButtonElement>('.issues-sidebar__all')!.click();
  await until(() => window.location.hash === '#/app/issues');
  assert.equal(getRouterStateForTests().foregroundAppId, 'issues');
  assert.equal(document.querySelector('.issues-page--embedded'), null);
  resetOsRouterForTests();
});

test('sidebar filter menus combine properties, remove chips and retain workspace-local selections', async () => {
  await openIssuesSidebar();
  const sidebar = document.getElementById('issuesSidebarRoot')!;
  const search = sidebar.querySelector<HTMLInputElement>('input[type="search"]')!;
  search.value = '';
  search.dispatchEvent(new dom.Event('input') as unknown as Event);
  const target = store.listIssues().find((issue) => issue.type === 'bug')!;
  const rows = () => [...sidebar.querySelectorAll<HTMLElement>('[data-issue-id]')].map((row) => row.dataset.issueId);
  const choose = (property: string, value: string) => {
    sidebar.querySelector<HTMLButtonElement>('[data-add-filter]')!.click();
    document.querySelector<HTMLButtonElement>(`[role="menuitem"][data-id="${property}"]`)!.click();
    document.querySelector<HTMLButtonElement>(`[role="menuitem"][data-id="${value}"]`)!.click();
  };
  choose('type', 'bug');
  assert.deepEqual(rows(), [target.id]);
  assert.equal(sidebar.querySelector('[data-chip-id="type"]')?.textContent, 'Type: Bug ×');
  choose('priority', 'low');
  assert.deepEqual(rows(), []);
  assert.match(sidebar.querySelector('.issues-sidebar__empty')!.textContent!, /Remove a filter/);
  const priority = sidebar.querySelector<HTMLButtonElement>('[data-chip-id="priority"]')!;
  priority.focus();
  priority.click();
  assert.equal(document.activeElement, sidebar.querySelector('[data-add-filter]'));
  choose('priority', 'high');
  choose('status', target.status);
  choose('projectId', 'no-project');
  assert.deepEqual(rows(), [target.id]);
  assert.equal(sidebar.querySelector('[data-count]')?.textContent, '1 issue');
  sidebar.querySelector<HTMLButtonElement>('[data-issue-id]')!.click();
  sidebar.querySelector<HTMLButtonElement>('.issues-sidebar__detail-toolbar button')!.click();
  assert.equal(sidebar.querySelectorAll('[data-chip-id]').length, 4);
  setWorkspaceFromServer({ path: 'C:/Projects/Other', label: 'Other', isDefault: false });
  await openIssuesSidebar();
  assert.equal(sidebar.querySelectorAll('[data-chip-id]').length, 0);
  setWorkspaceFromServer({ path: 'C:/Projects/Minnow', label: 'Minnow', isDefault: false });
  await openIssuesSidebar();
  assert.equal(sidebar.querySelectorAll('[data-chip-id]').length, 4);
  assert.deepEqual(rows(), [target.id]);
  for (const chip of sidebar.querySelectorAll<HTMLButtonElement>('[data-chip-id]')) chip.click();
  assert.equal(sidebar.querySelectorAll('[data-chip-id]').length, 0);
  assert.ok(rows().length > 1);
});

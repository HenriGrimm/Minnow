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
const { toggleFileSidebarLayout } = await import('../../src/ui/file-layout.ts');
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

test('sidebar capture, draft handoff, detail and shared actions work together', async () => {
  await openIssuesSidebar();
  assert.equal(isIssuesSidebarActive(), true);
  assert.equal(document.getElementById('fileSidebarFilesView')!.hasAttribute('hidden'), true);
  type('Preview loses focus\nReproduce by switching tabs.');
  await toggleFileSidebarLayout();
  assert.equal(isIssuesSidebarActive(), false);
  await openIssuesSidebar();
  assert.equal(input().value, 'Preview loses focus\nReproduce by switching tabs.');
  document.querySelector<HTMLButtonElement>('[data-expand]')!.click();
  await until(() => document.getElementById('issuesNewForm')?.classList.contains('is-open') ?? false);
  assert.equal((document.getElementById('issuesNewTitle') as HTMLInputElement).value, 'Preview loses focus');
  assert.equal(store.listIssues().length, 0);
  (document.getElementById('issuesNewTitle') as HTMLInputElement).value = 'Preview returns focus';
  (document.getElementById('issuesNewType') as HTMLInputElement).value = 'bug';
  document.getElementById('btnIssuesNewCancel')!.click();
  assert.equal(input().value, 'Preview returns focus\nReproduce by switching tabs.');
  document.querySelector<HTMLFormElement>('.issues-sidebar__capture')!.dispatchEvent(new dom.Event('submit', { cancelable: true }) as unknown as Event);
  await until(() => input().value === '');
  assert.equal(store.listIssues().length, 1);
  const issue = store.listIssues()[0];
  assert.equal(issue.type, 'bug');
  assert.equal(issue.description, 'Reproduce by switching tabs.');
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

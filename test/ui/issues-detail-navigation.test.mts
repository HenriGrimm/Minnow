import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { Window } from 'happy-dom';

const win = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: win, document: win.document, HTMLElement: win.HTMLElement, Element: win.Element,
  Node: win.Node, NodeFilter: win.NodeFilter, SVGElement: win.SVGElement,
  HTMLInputElement: win.HTMLInputElement, HTMLSelectElement: win.HTMLSelectElement,
  HTMLTextAreaElement: win.HTMLTextAreaElement, HTMLButtonElement: win.HTMLButtonElement,
  HTMLFormElement: win.HTMLFormElement, HTMLParagraphElement: win.HTMLParagraphElement,
  HTMLLabelElement: win.HTMLLabelElement, AbortController: win.AbortController, AbortSignal: win.AbortSignal,
  localStorage: win.localStorage, getComputedStyle: win.getComputedStyle.bind(win), CSS: win.CSS,
});
document.body.innerHTML = '<main id="issuesView" class="issues-page"></main><div id="sDot"></div><div id="sText"></div>';
localStorage.setItem('minnow.issues.uiState', JSON.stringify({
  viewMode: 'list', groupBy: 'priority', activeViewId: 'session:all', listSort: { key: 'title', direction: 'asc' },
  filters: { scope: 'all', type: 'all', status: 'all', priority: 'all', projectId: 'all', hideDone: true },
}));
const store = await import('../../src/state/issues-store.ts');
const detail = await import('../../src/ui/issues-detail.ts');
const page = await import('../../src/ui/issues-page.ts');
const { setLocalServerAvailableForTests } = await import('../../src/tools/config.ts');
const { isContextMenuOpen, closeContextMenu } = await import('../../src/ui/context-menu.ts');
const { setStorageModeForTests } = await import('../../src/config/storage-mode.ts');
setStorageModeForTests('localStorage');
setLocalServerAvailableForTests(false);
store.setIssuesStateForTests({ version: 2, nextId: 6, issues: [
  { id: 'MIN-3', title: 'Charlie' }, { id: 'MIN-1', title: 'Alpha' }, { id: 'MIN-2', title: 'Bravo' },
  { id: 'MIN-4', title: 'Closed', status: 'done' },
].map((issue) => ({ type: 'task', description: 'An editable issue', status: 'todo', priority: 'none', labels: [], workspacePath: '', createdAt: 1, updatedAt: 1, source: 'user', ...issue })), workspaces: {} });
await page.openIssues({ issueId: 'MIN-1' });
function key(value: string, target: Element = document.getElementById('issuesDetailHost')!, modifiers = {}) {
  const event = new win.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...modifiers });
  target.dispatchEvent(event); return event;
}
after(async () => { page.closeIssues({ skipNavigate: true }); store.setIssuesStateForTests(null); await win.happyDOM.abort(); await win.close(); });

test('Up/Down traverse actual sorted list, update route, and stop at endpoints', () => {
  const ids = [...document.querySelectorAll('.issues-row[data-issue-id]')].map((row) => (row as HTMLElement).dataset.issueId);
  assert.deepEqual(ids, ['MIN-1', 'MIN-2', 'MIN-3']);
  assert.equal(key('ArrowUp').defaultPrevented, true);
  assert.equal(detail.getSelectedIssueId(), 'MIN-1');
  key('ArrowDown');
  assert.equal(detail.getSelectedIssueId(), 'MIN-2');
  assert.equal(window.location.hash, '#/app/issues/MIN-2');
  assert.equal(document.querySelector('.issues-detail__position')!.textContent, '2 / 3');
  (document.querySelector('[data-issue-step="1"]') as HTMLButtonElement).click();
  assert.equal(detail.getSelectedIssueId(), 'MIN-3');
  key('ArrowDown'); assert.equal(detail.getSelectedIssueId(), 'MIN-3');
  key('ArrowUp'); assert.equal(detail.getSelectedIssueId(), 'MIN-2');
});

test('editing controls, composition and modifier keys never navigate', () => {
  for (const selector of ['.issues-detail__title', '.mn-editor__body', '.issues-comments__input']) {
    const field = document.querySelector<HTMLElement>(selector)!;
    field.focus();
    assert.equal(key('ArrowDown', field).defaultPrevented, false);
    assert.equal(detail.getSelectedIssueId(), 'MIN-2');
  }
  for (const modifiers of [{ isComposing: true }, { altKey: true }, { ctrlKey: true }, { metaKey: true }, { shiftKey: true }]) {
    key('ArrowDown', document.getElementById('issuesDetailHost')!, modifiers);
    assert.equal(detail.getSelectedIssueId(), 'MIN-2');
  }
});

test('property menus own arrow keys and do not move to another issue', () => {
  (document.querySelector('.issues-detail__prop') as HTMLElement).click();
  assert.equal(isContextMenuOpen(), true);
  key('ArrowDown', document.activeElement!);
  assert.equal(detail.getSelectedIssueId(), 'MIN-2');
  closeContextMenu();
});

test('chat-mode menu owns arrows and Escape, then returns focus to its trigger', () => {
  const trigger = document.querySelector<HTMLButtonElement>('.issues-workflow-menu__trigger')!;
  // No live provider is needed to exercise menu keyboard ownership.
  trigger.disabled = false;
  trigger.click();
  const first = document.activeElement;
  key('ArrowDown', first!);
  assert.notEqual(document.activeElement, first);
  assert.equal(detail.getSelectedIssueId(), 'MIN-2');
  key('Escape', document.activeElement!);
  assert.equal(detail.getSelectedIssueId(), 'MIN-2');
  assert.equal(document.activeElement, trigger);
  assert.equal(document.querySelector('.issues-workflow-menu'), null);
});

test('comment drafts survive previous/next browsing', () => {
  const input = document.querySelector<HTMLTextAreaElement>('.issues-comments__input')!;
  input.value = 'Draft review feedback';
  input.dispatchEvent(new win.Event('input', { bubbles: true }));
  key('ArrowDown'); key('ArrowUp');
  assert.equal(detail.getSelectedIssueId(), 'MIN-2');
  assert.equal(document.querySelector<HTMLTextAreaElement>('.issues-comments__input')!.value, 'Draft review feedback');
});

test('navigation follows changed search filters and excludes hidden matches', () => {
  detail.closeIssueDetail();
  const search = document.getElementById('issuesSearch') as HTMLInputElement;
  search.value = 'Charlie'; search.dispatchEvent(new win.Event('input', { bubbles: true }));
  detail.openIssueDetail('MIN-3');
  assert.equal(document.querySelector('.issues-detail__position')!.textContent, '1 / 1');
  assert.equal((document.querySelector('[data-issue-step="1"]') as HTMLButtonElement).disabled, true);
  key('ArrowDown'); assert.equal(detail.getSelectedIssueId(), 'MIN-3');
  key('Escape', document.querySelector('.issues-detail__title')!);
  assert.equal(detail.getSelectedIssueId(), undefined);
  assert.equal(window.location.hash, '#/app/issues');
});

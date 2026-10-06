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

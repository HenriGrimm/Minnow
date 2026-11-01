import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { Window } from 'happy-dom';
import type { GitChangeSelectionEntry } from '../../src/ui/git-change-selection.ts';

let confirm: (message: string) => Promise<boolean> = async () => true;
mock.module('../../src/ui/app-dialog.ts', { namedExports: { appConfirm: (message: string) => confirm(message), appChoice: async () => null, appAlert: async () => {}, appPrompt: async () => null, isAppDialogOpen: () => false } });
const { installHappyDomGlobals } = await import('../os/dom-helpers.mts');
const { setLocalServerAvailable } = await import('../../src/tools/config.ts');
const { createGitChangeSelection } = await import('../../src/ui/git-change-selection.ts');
const { closeContextMenu } = await import('../../src/ui/context-menu.ts');
const originalFetch = globalThis.fetch;
let win: Window;
let root: HTMLElement;
let cwd: string;
let requests: Record<string, unknown>[];
let selection: ReturnType<typeof createGitChangeSelection>;
let rows: HTMLElement[];
let copied: string[];
let opened: GitChangeSelectionEntry[];
const entries: GitChangeSelectionEntry[] = [
  { path: 'staged.ts', bucket: 'staged' },
  { path: 'a.ts', bucket: 'unstaged' },
  { path: 'b.json', bucket: 'unstaged' },
  { path: 'new folder/c.ts', bucket: 'untracked' },
];
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const picked = () => rows.filter((row) => row.classList.contains('is-selected')).map((row) => row.dataset.path);
function click(index: number, modifiers = {}): void {
  rows[index]!.dispatchEvent(new win.MouseEvent('click', { bubbles: true, ...modifiers }));
}
function menu(index: number): void {
  rows[index]!.dispatchEvent(new win.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 }));
}
function action(label: string): HTMLButtonElement {
  const result = [...document.querySelectorAll<HTMLButtonElement>('.mn-menu__item')].find((item) => item.textContent?.startsWith(label));
  assert.ok(result, `Missing menu item: ${label}`);
  return result;
}
function render(): void {
  selection.setEntries(entries);
  rows = entries.map((entry) => {
    const row = document.createElement('div');
    row.textContent = entry.path;
    selection.bindRow(row, entry);
    return row;
  });
  root.replaceChildren(...rows);
}

beforeEach(() => {
  win = new Window({ url: 'http://localhost/' });
  installHappyDomGlobals(win);
  cwd = '/worktree';
  requests = []; copied = []; opened = [];
  confirm = async () => true;
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { copied.push(text); } } });
  setLocalServerAvailable(true);
  globalThis.fetch = (async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ ok: true }));
  }) as typeof fetch;
  root = document.createElement('div');
  document.body.append(root);
  selection = createGitChangeSelection({ root, getCwd: () => cwd, run: async (fn) => fn(), onOpen: (entry) => opened.push(entry) });
  render();
});
afterEach(async () => {
  selection.destroy();
  closeContextMenu();
  globalThis.fetch = originalFetch;
  await win.happyDOM.close();
});

test('click, modifier click and range selection only highlight existing rows, without checkboxes', () => {
  click(0);
  click(2, { shiftKey: true });
  assert.deepEqual(picked(), ['staged.ts', 'a.ts', 'b.json']);
  click(1, { metaKey: true });
  assert.deepEqual(picked(), ['staged.ts', 'b.json']);
  click(3, { ctrlKey: true });
  assert.deepEqual(picked(), ['staged.ts', 'b.json', 'new folder/c.ts']);
  assert.equal(opened.length, 1, 'range and modifier selection only highlight the rows');
  assert.equal(root.querySelector('input, [role="checkbox"]'), null);
  assert.equal(rows[0]!.getAttribute('aria-selected'), 'true');
  assert.equal(root.getAttribute('aria-multiselectable'), 'true');
  render();
  assert.deepEqual(picked(), ['staged.ts', 'b.json', 'new folder/c.ts']);
  click(1);
  assert.deepEqual(picked(), ['a.ts']);
});

test('right-click retains the selected range and stages only selected non-staged paths in the captured checkout', async () => {
  click(0); click(2, { shiftKey: true }); menu(1);
  assert.deepEqual(picked(), ['staged.ts', 'a.ts', 'b.json']);
  assert.match(document.querySelector('.mn-menu')!.textContent!, /Discard 3 selected changes/);
  action('Stage selected').click();
  await tick();
  assert.deepEqual(requests, [{ op: 'stage', paths: ['a.ts', 'b.json'], cwd: '/worktree' }]);
  assert.deepEqual(picked(), ['staged.ts', 'a.ts', 'b.json']);
});

test('right-click outside the selection targets that row and ignore extensions use a dedicated batch operation', async () => {
  click(0); click(1, { metaKey: true }); menu(2);
  assert.deepEqual(picked(), ['b.json']);
  assert.equal(opened.length, 1, 'right-click selects without opening a diff or stealing menu focus');
  action('Ignore all .json').click();
  await tick();
  assert.deepEqual(requests, [{ op: 'ignore', extensions: ['.json'], cwd: '/worktree' }]);
});

test('mixed staged and untracked discard confirms once and sends exact paths with staged scope', async () => {
  let confirmations = 0;
  confirm = async (message) => { confirmations++; assert.match(message, /deleted.*cannot be undone/); return true; };
  click(0); click(3, { metaKey: true }); menu(0);
  action('Discard 2').click(); await tick();
  assert.equal(confirmations, 1);
  assert.deepEqual(requests, [{ op: 'discard', paths: ['staged.ts', 'new folder/c.ts'], stagedPaths: ['staged.ts'], cwd: '/worktree' }]);
});

test('cancelled and stale confirmations cannot discard files in a new checkout', async () => {
  confirm = async () => false;
  await selection.discard(entries);
  assert.equal(requests.length, 0);
  let resolve!: (value: boolean) => void;
  confirm = () => new Promise((done) => { resolve = done; });
  const pending = selection.discard(entries);
  cwd = '/other';
  render();
  resolve(true);
  await pending;
  assert.equal(requests.length, 0);
  assert.deepEqual(picked(), []);
});

test('menu actions are invalidated even after switching away and back to the same checkout', async () => {
  menu(1);
  const ignore = action('Ignore file');
  selection.clear();
  cwd = '/other'; render(); cwd = '/worktree'; render();
  ignore.click(); await tick();
  assert.equal(requests.length, 0);
});

test('copy actions include all selected paths and retain relative paths', async () => {
  click(1); click(3, { shiftKey: true }); menu(1);
  action('Copy paths').click(); await tick();
  assert.deepEqual(copied, ['/worktree/a.ts\n/worktree/b.json\n/worktree/new folder/c.ts']);
  menu(1); action('Copy relative paths').click(); await tick();
  assert.equal(copied[1], 'a.ts\nb.json\nnew folder/c.ts');
});

test('keyboard range selection, Select All and keyboard menus work without changing commit input behavior', () => {
  rows[0]!.focus();
  rows[0]!.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowDown', shiftKey: true, bubbles: true }));
  rows[1]!.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowDown', shiftKey: true, bubbles: true }));
  assert.deepEqual(picked(), ['staged.ts', 'a.ts', 'b.json']);
  rows[2]!.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'a', metaKey: true, bubbles: true }));
  assert.equal(picked().length, 4);
  rows[2]!.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true }));
  assert.match(document.querySelector('.mn-menu')!.textContent!, /Discard 4 selected/);
  closeContextMenu();
  const input = document.createElement('textarea'); root.append(input);
  const event = new win.KeyboardEvent('keydown', { key: 'a', metaKey: true, cancelable: true, bubbles: true });
  input.dispatchEvent(event);
  assert.equal(event.defaultPrevented, false);
});

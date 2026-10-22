import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { Window } from 'happy-dom';
import { createGitCheckoutPicker, type CheckoutPickerState } from '../../src/ui/git-checkout-picker.ts';
import type { GitCheckoutSwitchInput, GitOpResult } from '../../src/state/git-api.ts';

let win: Window;
let picker: ReturnType<typeof createGitCheckoutPicker>;
let state: CheckoutPickerState;
let calls: GitCheckoutSwitchInput[];
let worktrees: string[];
let restores: unknown[];
let result: GitOpResult;
let resolveSwitch: ((r: GitOpResult) => void) | undefined;
const originals = { window: globalThis.window, document: globalThis.document };
const tick = () => new Promise((r) => setTimeout(r, 0));
const click = (text: string) => {
  const button = [...document.querySelectorAll('button')].find((b) => b.textContent?.includes(text));
  assert.ok(button, `Missing button: ${text}`); button.click();
};
beforeEach(() => {
  win = new Window();
  Object.assign(globalThis, { window: win, document: win.document });
  calls = []; worktrees = []; restores = []; resolveSwitch = undefined;
  result = { ok: false, needsChoice: true, branch: 'main', fileCount: 3 };
  state = {
    cwd: '/workspace', workspace: '/workspace', branch: 'main', branches: ['main', 'feature', 'occupied'],
    worktrees: [{ path: '/workspace', branch: 'main', head: 'abc', detached: false }, { path: '/other', branch: 'occupied', head: 'def', detached: false }],
    savedChanges: [],
  };
  picker = createGitCheckoutPicker({
    onSwitch: async (input) => {
      calls.push(input);
      if (input.branch === 'pending') return new Promise((resolve) => { resolveSwitch = resolve; });
      return input.dirtyHandling ? { ok: true } : result;
    },
    onWorktree: (path) => worktrees.push(path),
    onRestore: async (input) => { restores.push(input); return { ok: false, error: 'Conflict. Saved stash retained.' }; },
    onNewBranch() {}, onNewWorktree() {}, onDeleteBranch() {}, onRemoveWorktree() {},
  });
  document.body.append(picker.root);
  picker.update(state);
});
afterEach(async () => {
  picker.dispose(); await win.close(); Object.assign(globalThis, originals);
});

for (const choice of ['bring', 'leave'] as const) {
  test(`dirty switch waits for explicit ${choice} choice; repeated clicks cannot double submit`, async () => {
    click('main'); click('feature'); await tick();
    assert.equal(calls.length, 1);
    assert.match(document.body.textContent ?? '', /3 uncommitted files on main/);
    const action = [...document.querySelectorAll<HTMLButtonElement>('.git-checkout__choice')][choice === 'bring' ? 0 : 1];
    action.click(); action.click(); await tick();
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1], { branch: 'feature', cwd: '/workspace', expectedBranch: 'main', dirtyHandling: choice });
    assert.equal(document.getElementById('gitCheckoutMenu')?.hidden, true);
  });
}

test('cancel and Escape keep branch and files untouched and restore trigger focus', async () => {
  click('main'); click('feature'); await tick(); click('Cancel switch');
  assert.equal(calls.length, 1);
  assert.equal(document.activeElement?.id, 'gitCheckoutTrigger');
  click('main');
  picker.root.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }) as unknown as KeyboardEvent);
  assert.equal(document.getElementById('gitCheckoutMenu')?.hidden, true);
});

test('branch checked out elsewhere opens its worktree without a checkout or dirty prompt', () => {
  click('main'); click('occupied');
  assert.deepEqual(worktrees, ['/other']); assert.equal(calls.length, 0);
});

test('worktree tab browses checkouts without moving uncommitted changes', () => {
  click('main'); click('Worktrees'); click('occupied');
  assert.deepEqual(worktrees, ['/other']); assert.equal(calls.length, 0);
});

test('branch search, arrow navigation and polling preserve focused input', () => {
  click('main');
  const input = document.querySelector('input')!;
  input.focus(); input.value = 'feat'; input.dispatchEvent(new win.Event('input') as unknown as Event);
  assert.equal(document.querySelectorAll('.git-checkout__item').length, 1);
  picker.update({ ...state, savedChanges: [{ sha: 'abc', branch: 'feature', fileCount: 1, createdAt: 'today' }] });
  assert.equal(document.activeElement, input); assert.equal(input.value, 'feat');
  input.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }) as unknown as KeyboardEvent);
  assert.match(document.activeElement?.textContent ?? '', /feature/);
});

test('saved changes are offered only on their branch and restoration errors remain visible', async () => {
  const saved = { sha: 'save-sha', branch: 'feature', fileCount: 3, createdAt: 'today' };
  picker.update({ ...state, savedChanges: [saved] });
  assert.equal(document.querySelector('.git-checkout__restore'), null);
  picker.update({ ...state, branch: 'feature', savedChanges: [saved] });
  click('Restore changes'); await tick();
  assert.deepEqual(restores, [{ cwd: '/workspace', expectedBranch: 'feature', sha: 'save-sha' }]);
  assert.match(document.querySelector('[role="alert"]')?.textContent ?? '', /retained/);
});

test('a late dirty response cannot paint a prompt over a different worktree', async () => {
  const request = picker.requestSwitch({ cwd: '/workspace', branch: 'pending' });
  picker.update({ ...state, cwd: '/other', branch: 'occupied' });
  resolveSwitch!({ ok: false, needsChoice: true, branch: 'main', fileCount: 4 });
  await request;
  assert.equal(document.querySelector('.git-checkout__choice'), null);
  assert.match(document.getElementById('gitCheckoutTrigger')?.textContent ?? '', /occupied/);
});

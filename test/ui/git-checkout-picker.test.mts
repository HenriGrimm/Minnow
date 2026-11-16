import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { Window } from 'happy-dom';
import { readFileSync } from 'node:fs';
import { createGitCheckoutPicker, resetRecentCheckoutsForTests, type CheckoutPickerState } from '../../src/ui/git-checkout-picker.ts';
import type { GitCheckoutSwitchInput, GitOpResult } from '../../src/state/git-api.ts';
import { isLocalServerAvailable, setLocalServerAvailable } from '../../src/tools/config.ts';

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
  resetRecentCheckoutsForTests();
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

test('dropdown floats outside layout flow and marks only the open menu as a preview occluder', () => {
  const style = document.createElement('style');
  style.textContent = readFileSync(new URL('../../src/styles/git-checkout-picker.css', import.meta.url), 'utf8');
  document.head.append(style);
  const menu = document.getElementById('gitCheckoutMenu')!;
  assert.equal(win.getComputedStyle(picker.root).position, 'relative');
  click('main');
  assert.equal(win.getComputedStyle(menu).position, 'absolute');
  assert.equal(menu.classList.contains('mn-occludes-preview'), true);
  picker.close();
  assert.equal(menu.hidden, true);
  assert.equal(menu.classList.contains('mn-occludes-preview'), false);
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

test('remote branches appear with badges, remain searchable, and retain their start point through a dirty switch', async () => {
  picker.update({ ...state, remoteBranches: [
    'remotes/origin/fix/search', 'upstream/fix/search', 'remotes/origin/HEAD -> origin/main', 'upstream/HEAD',
  ] });
  click('main');
  const rows = [...document.querySelectorAll('.git-checkout__item')];
  assert.deepEqual(rows.map((row) => row.querySelector('.git-checkout__branch')?.textContent),
    ['main', 'feature', 'occupied', 'origin/fix/search', 'upstream/fix/search']);
  assert.equal(rows[3].querySelector('.git-checkout__tag')?.textContent, 'remote');
  const input = document.querySelector('input')!;
  input.value = 'upstream'; input.dispatchEvent(new win.Event('input') as unknown as Event);
  assert.equal(document.querySelectorAll('.git-checkout__item').length, 1);
  click('upstream/fix/search'); await tick();
  assert.deepEqual(calls[0], { branch: 'fix/search', create: true, startPoint: 'upstream/fix/search', cwd: '/workspace', expectedBranch: 'main' });
  click('Bring my changes'); await tick();
  assert.deepEqual(calls[1], { ...calls[0], dirtyHandling: 'bring' });
});

test('remote rows reuse local branches and open occupied worktrees', async () => {
  picker.update({ ...state, remoteBranches: ['origin/feature', 'origin/occupied', 'origin/main'] });
  click('main'); click('origin/occupied');
  assert.deepEqual(worktrees, ['/other']);
  assert.equal(calls.length, 0);
  result = { ok: true };
  click('main'); click('origin/feature'); await tick();
  assert.deepEqual(calls, [{ branch: 'feature', cwd: '/workspace', expectedBranch: 'main' }]);
  click('main'); click('origin/main');
  assert.equal(calls.length, 1);
});

test('polling adds remote branches while preserving the open search and focus', () => {
  click('main');
  const input = document.querySelector('input')!;
  input.focus(); input.value = 'remote'; input.dispatchEvent(new win.Event('input') as unknown as Event);
  picker.update({ ...state, remoteBranches: ['origin/remote-new'] });
  assert.equal(document.activeElement, input);
  assert.equal(input.value, 'remote');
  assert.equal(document.querySelector('.git-checkout__branch')?.textContent, 'main');
  assert.equal(document.querySelector('.git-checkout__item .git-checkout__branch')?.textContent, 'origin/remote-new');
});

test('worktree tab browses checkouts without moving uncommitted changes', () => {
  click('main'); click('Worktrees');
  const input = document.querySelector('input')!;
  assert.equal(input.getAttribute('aria-label'), 'Search worktrees');
  assert.equal(input.parentElement?.textContent, '');
  click('occupied');
  assert.deepEqual(worktrees, ['/other']); assert.equal(calls.length, 0);
});

test('pull requests load on demand, keep search focus, and switch by PR identity through the dirty prompt', async (t) => {
  const available = isLocalServerAvailable();
  setLocalServerAvailable(true);
  t.after(() => setLocalServerAvailable(available));
  const url = 'https://github.com/owner/repo/pull/42';
  const list = t.mock.method(globalThis, 'fetch', async (_url, init) => {
    assert.deepEqual(JSON.parse(init.body), { op: 'prList', cwd: '/workspace', state: 'open', limit: 200 });
    return Response.json({ ok: true, prs: [
      { number: 42, title: 'Fix keyboard focus', headRef: 'feature', url },
      { number: 43, title: 'Update layout', headRef: 'design', draft: true },
    ] });
  });
  click('main');
  assert.equal(list.mock.callCount(), 0);
  click('Pull requests');
  const input = document.querySelector('input')!;
  assert.equal(input.getAttribute('aria-label'), 'Search pull requests');
  await tick();
  assert.equal(document.activeElement === input, true);
  assert.match(document.querySelector('.git-checkout__list')?.textContent ?? '', /#43 Update layoutdesignDraft/);

  for (const query of ['#42', 'keyboard', 'feature']) {
    input.value = query;
    input.dispatchEvent(new win.Event('input') as unknown as Event);
    assert.equal(document.querySelectorAll('.git-checkout__item').length, 1);
  }
  click('#42 Fix keyboard focus'); await tick();
  assert.equal(document.querySelector('.git-checkout__heading')?.textContent, 'Switch to PR #42?');
  assert.deepEqual(calls[0], {
    branch: 'feature', cwd: '/workspace', expectedBranch: 'main', pullRequest: { number: 42, url, headRef: 'feature' },
  });
  click('Leave changes on main'); await tick();
  assert.deepEqual(calls[1], { ...calls[0], dirtyHandling: 'leave' });
  assert.equal(list.mock.callCount(), 1);
});

test('a PR whose branch lives in another worktree routes there; a fork PR found by the server offers to open it', async (t) => {
  const available = isLocalServerAvailable();
  setLocalServerAvailable(true);
  t.after(() => setLocalServerAvailable(available));
  t.mock.method(globalThis, 'fetch', async () => Response.json({ ok: true, prs: [
    { number: 7, title: 'Occupied work', headRef: 'occupied', url: 'https://github.com/owner/repo/pull/7' },
    { number: 8, title: 'Fork work', headRef: 'main', crossRepository: true, url: 'https://github.com/owner/repo/pull/8' },
  ] }));
  click('main'); click('Pull requests'); await tick();
  assert.match(document.querySelector('.git-checkout__list')?.textContent ?? '', /occupied · Open in other/);
  assert.match(document.querySelector('.git-checkout__list')?.textContent ?? '', /Fork/);
  click('#7 Occupied work');
  assert.deepEqual(worktrees, ['/other']); assert.equal(calls.length, 0);

  // A fork head named `main` is not this checkout's main branch.
  click('main'); click('Pull requests'); await tick();
  result = { ok: false, code: 'in_worktree', worktreePath: '/other', branch: 'main', error: 'PR #8 is already checked out' };
  click('#8 Fork work'); await tick();
  assert.equal(calls.at(-1)?.pullRequest?.crossRepository, true);
  assert.match(document.querySelector('.git-checkout__notices')?.textContent ?? '', /PR #8 is open in other/);
  click('Open worktree');
  await tick();
  assert.deepEqual(worktrees, ['/other', '/other']);
});

test('known checkout failures read as plain language with technical details', async () => {
  result = { ok: false, code: 'overwrite', branch: 'main', error: 'error: Your local changes would be overwritten by checkout:\n\ta.txt' };
  click('main'); click('feature'); await tick();
  assert.match(document.querySelector('.git-checkout__error')?.textContent ?? '', /^Local changes would be overwritten\./);
  assert.match(document.querySelector('.git-checkout__details pre')?.textContent ?? '', /a\.txt/);
});

test('recent branches lead the list after a switch and hide while searching; keyboard hints are shown', async () => {
  result = { ok: true, branch: 'feature' };
  click('main'); click('feature'); await tick();
  picker.update({ ...state, branch: 'feature' });
  click('feature');
  const list = document.querySelector('.git-checkout__list')!;
  const labels = [...list.children].map((node) => node.querySelector('.git-checkout__branch')?.textContent ?? node.textContent);
  assert.deepEqual(labels.slice(0, 3), ['Recent', 'main', 'All branches'], 'the branch just left is one click away');
  assert.match(document.querySelector('.git-checkout__hint')?.textContent ?? '', /Enter switch/);
  const input = document.querySelector('input')!;
  input.value = 'mai';
  input.dispatchEvent(new win.Event('input') as unknown as Event);
  assert.equal(document.querySelector('.git-checkout__group'), null);
});

test('a checkout held by a local action names it and can stop it, then switch', async (t) => {
  const available = isLocalServerAvailable();
  setLocalServerAvailable(true);
  t.after(() => setLocalServerAvailable(available));
  const cancels: unknown[] = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    cancels.push(JSON.parse(init.body));
    return Response.json({ ok: true });
  });
  result = { ok: false, code: 'busy', busyRunId: 'local-1', busyLabel: 'Unit tests', error: 'A local action is running in this worktree.' };
  click('main'); click('feature'); await tick();
  assert.match(document.querySelector('.git-checkout__notices')?.textContent ?? '', /Waiting for Unit tests/);
  assert.equal(document.querySelector('.git-checkout__error'), null, 'no raw lock error');
  result = { ok: true, branch: 'feature' };
  click('Stop and switch'); await tick(); await tick();
  assert.deepEqual(cancels, [{ op: 'localRunCancel', cwd: '/workspace', id: 'local-1' }]);
  assert.equal(calls.length, 2);
  assert.doesNotMatch(document.querySelector('.git-checkout__notices')?.textContent ?? '', /Waiting for/);
});

test('branch search keeps main first and orders the other names naturally', () => {
  picker.update({
    ...state,
    branch: 'pr-10',
    branches: ['pr-10', 'feature', 'main', 'pr-2'],
    remoteBranches: ['origin/pr-10', 'origin/pr-2'],
  });
  click('pr-10');
  const names = () => [...document.querySelectorAll('.git-checkout__item .git-checkout__branch')]
    .map((row) => row.textContent);
  const input = document.querySelector('input')!;
  assert.equal(input.getAttribute('aria-label'), 'Search branches');
  assert.equal(input.parentElement?.textContent, '');
  assert.deepEqual(names(), ['main', 'feature', 'pr-2', 'pr-10', 'origin/pr-2', 'origin/pr-10']);

  input.value = 'pr-';
  input.dispatchEvent(new win.Event('input') as unknown as Event);
  assert.deepEqual(names(), ['pr-2', 'pr-10', 'origin/pr-2', 'origin/pr-10']);
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

test('the embedded checkout picker stays open through dirty switches and worktree selection', async () => {
  const inline = createGitCheckoutPicker({
    inline: true,
    onSwitch: async input => {
      if (!input.dirtyHandling) return { ok: false, needsChoice: true, branch: 'main', fileCount: 3 };
      inline.update({ ...state, branch: input.branch });
      return { ok: true };
    },
    onWorktree: async cwd => { inline.update({ ...state, cwd, branch: 'occupied' }); },
    onRestore: async () => ({ ok: true }),
  });
  document.body.append(inline.root);
  try {
    inline.update(state);
    const menu = document.getElementById('threadCheckoutMenu')!;
    assert.equal(menu.hidden, false);
    click('feature'); await tick(); click('Bring my changes'); await tick();
    assert.equal(menu.hidden, false);
    assert.match(menu.querySelector('[aria-current="true"]')?.textContent ?? '', /feature/);
    click('Worktrees'); click('occupied'); await tick();
    assert.equal(menu.hidden, false);
    assert.match(menu.querySelector('.git-checkout__item:has(.git-checkout__tag)')?.textContent ?? '', /occupied.*Current/);
  } finally {
    inline.dispose();
  }
});

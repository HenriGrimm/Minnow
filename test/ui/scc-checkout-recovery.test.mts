import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { Window } from 'happy-dom';
import { installHappyDomGlobals } from '../os/dom-helpers.mts';
import { setLocalServerAvailable } from '../../src/tools/config.ts';
import { checkoutBranchWithChoice, runCheckoutFlow } from '../../src/ui/git-checkout-confirm.ts';
import { resetAppDialogForTests } from '../../src/ui/app-dialog.ts';

const originalFetch = globalThis.fetch;
let win: Window;

function setup(branch = 'main') {
  win = new Window({ url: 'http://localhost/' });
  installHappyDomGlobals(win);
  setLocalServerAvailable(true);
  const calls: Record<string, unknown>[] = [];
  globalThis.fetch = async (_url, init) => {
    const input = JSON.parse(String(init?.body));
    calls.push(input);
    return Response.json(input.dirtyHandling
      ? { ok: true, branch: 'review' }
      : { ok: false, needsChoice: true, branch, fileCount: 2 });
  };
  return calls;
}

function choose(label: string) {
  const button = [...document.querySelectorAll<HTMLButtonElement>('#appDialogPanel button')]
    .find((control) => control.textContent === label);
  assert.ok(button, label);
  button.click();
}

async function waitForDialog() {
  for (let attempt = 0; attempt < 20 && !document.querySelector('#appDialogPanel'); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.match(document.querySelector('#appDialogPanel')?.textContent ?? '', /Switch to review\?/);
}

afterEach(async () => {
  resetAppDialogForTests();
  setLocalServerAvailable(false);
  globalThis.fetch = originalFetch;
  await win?.happyDOM.close();
});

test('dirty branch checkout offers Bring, Leave and a safe Cancel, then retries the same checkout', async () => {
  const calls = setup();
  const pending = checkoutBranchWithChoice({ cwd: '/repo', expectedBranch: 'main', branch: 'review' });
  await waitForDialog();
  assert.equal(document.activeElement?.textContent, 'Cancel');
  assert.match(document.querySelector('#appDialogPanel')?.textContent ?? '', /Bring my changes/);
  choose('Leave changes on main');
  assert.equal((await pending).ok, true);
  assert.deepEqual(calls, [
    { op: 'checkoutSwitch', cwd: '/repo', expectedBranch: 'main', branch: 'review' },
    { op: 'checkoutSwitch', cwd: '/repo', expectedBranch: 'main', branch: 'review', dirtyHandling: 'leave' },
  ]);
});

test('a detached checkout cannot leave changes, and a stale workspace cannot retry', async () => {
  const calls = setup('HEAD');
  let current = true;
  const pending = checkoutBranchWithChoice({ cwd: '/repo', branch: 'review' }, () => current);
  await waitForDialog();
  assert.doesNotMatch(document.querySelector('#appDialogPanel')?.textContent ?? '', /Leave changes/);
  current = false;
  choose('Bring my changes');
  assert.equal((await pending).error, 'cancelled');
  assert.equal(calls.length, 1);
});

test('a target in another worktree offers to open it instead of failing', async () => {
  win = new Window({ url: 'http://localhost/' });
  installHappyDomGlobals(win);
  setLocalServerAvailable(true);
  const calls: Record<string, unknown>[] = [];
  globalThis.fetch = async (_url, init) => {
    const input = JSON.parse(String(init?.body));
    calls.push(input);
    return Response.json({ ok: false, code: 'in_worktree', worktreePath: '/repo/.worktrees/review', worktreeBranch: 'review', branch: 'main', error: 'review is already checked out' });
  };
  const opened: string[] = [];
  const pending = runCheckoutFlow({ cwd: '/repo', branch: 'review' }, { openWorktree: (path) => { opened.push(path); } });
  for (let attempt = 0; attempt < 20 && !document.querySelector('#appDialogPanel'); attempt++) await new Promise((r) => setTimeout(r, 0));
  assert.match(document.querySelector('#appDialogPanel')?.textContent ?? '', /review is open in another worktree/);
  choose('Open worktree');
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(result.location, 'worktree');
  assert.deepEqual(opened, ['/repo/.worktrees/review']);
  assert.equal(calls.length, 1);
});

test('a shared workspace folder defaults to a new worktree before any checkout', async () => {
  win = new Window({ url: 'http://localhost/' });
  installHappyDomGlobals(win);
  setLocalServerAvailable(true);
  const ops: string[] = [];
  globalThis.fetch = async (_url, init) => {
    const input = JSON.parse(String(init?.body));
    ops.push(input.op);
    return Response.json(input.op === 'checkoutPlan' ? { ok: true, location: 'here', branch: 'main', fileCount: 0 } : { ok: true, branch: 'review' });
  };
  let isolated = 0;
  const pending = runCheckoutFlow({ cwd: '/repo', branch: 'review' }, {
    shared: { otherChats: 2, switchInNewWorktree: async () => { isolated += 1; return { ok: true, branch: 'review', location: 'worktree' }; } },
  });
  for (let attempt = 0; attempt < 20 && !document.querySelector('#appDialogPanel'); attempt++) await new Promise((r) => setTimeout(r, 0));
  assert.match(document.querySelector('#appDialogPanel')?.textContent ?? '', /2 other chats use the workspace folder/);
  assert.equal(document.activeElement?.textContent, 'Switch in a new worktree');
  choose('Switch in a new worktree');
  assert.equal((await pending).location, 'worktree');
  assert.equal(isolated, 1);
  assert.deepEqual(ops, ['checkoutPlan']);
});

test('switching the shared folder anyway runs the ordinary checkout', async () => {
  win = new Window({ url: 'http://localhost/' });
  installHappyDomGlobals(win);
  setLocalServerAvailable(true);
  const ops: string[] = [];
  globalThis.fetch = async (_url, init) => {
    const input = JSON.parse(String(init?.body));
    ops.push(input.op);
    return Response.json(input.op === 'checkoutPlan' ? { ok: true, location: 'here', branch: 'main', fileCount: 0 } : { ok: true, branch: 'review' });
  };
  const pending = runCheckoutFlow({ cwd: '/repo', branch: 'review' }, { shared: { otherChats: 1 } });
  for (let attempt = 0; attempt < 20 && !document.querySelector('#appDialogPanel'); attempt++) await new Promise((r) => setTimeout(r, 0));
  assert.doesNotMatch(document.querySelector('#appDialogPanel')?.textContent ?? '', /new worktree/);
  choose('Switch workspace anyway');
  assert.equal((await pending).ok, true);
  assert.deepEqual(ops, ['checkoutPlan', 'checkoutSwitch']);
});

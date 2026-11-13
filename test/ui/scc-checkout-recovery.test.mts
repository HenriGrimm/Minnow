import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { Window } from 'happy-dom';
import { installHappyDomGlobals } from '../os/dom-helpers.mts';
import { setLocalServerAvailable } from '../../src/tools/config.ts';
import { checkoutBranchWithChoice } from '../../src/ui/git-checkout-confirm.ts';
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

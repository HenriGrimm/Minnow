import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { Window } from 'happy-dom';
import type { GitOpResult } from '../../src/state/git-api.ts';
import { setLocalServerAvailable } from '../../src/tools/config.ts';
import { resetAppDialogForTests } from '../../src/ui/app-dialog.ts';
import { pullWithStrategyChoice } from '../../src/ui/git-pull-choice.ts';
import { installHappyDomGlobals } from '../os/dom-helpers.mts';

const originalFetch = globalThis.fetch;
const target = { cwd: '/repo', branch: 'main', head: '123', upstream: 'origin/main' };
let win: Window;

function setup(first: GitOpResult = { ok: false, pullTarget: target }) {
  win = new Window({ url: 'http://localhost/' });
  installHappyDomGlobals(win);
  setLocalServerAvailable(true);
  const calls: Record<string, unknown>[] = [];
  globalThis.fetch = async (_url, init) => {
    calls.push(JSON.parse(String(init?.body)));
    return Response.json(calls.length === 1 ? first : { ok: true });
  };
  return calls;
}

afterEach(async () => {
  resetAppDialogForTests();
  globalThis.fetch = originalFetch;
  await win.happyDOM.close();
});

async function dialog() {
  for (let i = 0; i < 20 && !document.querySelector('#appDialogPanel'); i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  const panel = document.querySelector('#appDialogPanel');
  assert.ok(panel);
  return panel;
}

for (const [label, strategy] of [['Merge once', 'merge'], ['Rebase once', 'rebase']]) {
  test(`${label} retries exactly once in the affected checkout`, async () => {
    const calls = setup();
    const pending = pullWithStrategyChoice(undefined, 'Frontend');
    const panel = await dialog();
    assert.match(panel.textContent ?? '', /Frontend/);
    assert.match(panel.textContent ?? '', /main and origin\/main/);
    assert.equal(document.activeElement?.textContent, 'Cancel');
    const button = [...panel.querySelectorAll('button')].find((item) => item.textContent === label);
    assert.ok(button);
    button.click();
    assert.deepEqual(await pending, { ok: true });
    assert.deepEqual(calls, [{ op: 'pull' }, { op: 'pull', cwd: target.cwd, strategy, expectedTarget: target }]);
  });
}

test('Escape cancels without a strategy retry', async () => {
  const calls = setup();
  const pending = pullWithStrategyChoice(target.cwd);
  await dialog();
  document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.deepEqual(await pending, { ok: false, error: 'cancelled' });
  assert.equal(calls.length, 1);
});

test('switching scope before choosing prevents a strategy retry', async () => {
  const calls = setup();
  let current = true;
  const pending = pullWithStrategyChoice(target.cwd, undefined, () => current);
  const panel = await dialog();
  current = false;
  const merge = [...panel.querySelectorAll('button')].find((item) => item.textContent === 'Merge once');
  assert.ok(merge);
  merge.click();
  assert.deepEqual(await pending, { ok: false, error: 'cancelled' });
  assert.equal(calls.length, 1);
});

test('an unrelated pull error does not open the dialog', async () => {
  const error = { ok: false, error: 'There is no tracking information for the current branch.' };
  const calls = setup(error);
  assert.deepEqual(await pullWithStrategyChoice(), error);
  assert.equal(document.querySelector('#appDialogPanel'), null);
  assert.equal(calls.length, 1);
});

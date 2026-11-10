import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { Window } from 'happy-dom';
import { listRailApps } from '../../src/os/app-preferences.ts';
import { parseOsHash, hashForRoute } from '../../src/os/router.ts';
import { installHappyDomGlobals, seedMinimalSession, teardownHappyDomAsync } from './dom-helpers.mts';

test('Source Control follows Code in the rail and has its own route', () => {
  assert.deepEqual(listRailApps().slice(0, 2).map((app) => app.id), ['code', 'source-control']);
  const route = parseOsHash('#/app/source-control');
  assert.equal(route.appId, 'source-control');
  assert.equal(hashForRoute(route), '#/app/source-control');
});

test('mounting and leaving Source Control preserves the chat DOM', async () => {
  const win = new Window();
  win.fetch = async () => new Response(JSON.stringify({ ok: false, error: 'not a git repository' }), {
    headers: { 'Content-Type': 'application/json' },
  });
  installHappyDomGlobals(win, { fetch: win.fetch });
  seedMinimalSession('chat-1');
  document.body.innerHTML = '<div id="mainColumn"><div id="chatArea"><p>Keep this chat</p></div></div><main id="sourceControlView"></main>';
  const transcript = document.querySelector('#chatArea p');
  const { launchInstance, resetInstancesForTests } = await import('../../src/os/instances.ts');
  const scc = await import('../../src/ui/source-control-center.ts');
  try {
    launchInstance('source-control');
    await scc.mountSourceControlCenter();
    assert.ok(document.querySelector('#sourceControlView #sourceControlCenterRoot'));
    assert.equal(document.querySelector('#chatArea p'), transcript);
    assert.equal(scc.isSourceControlCenterOpen(), true);
    launchInstance('code');
    assert.equal(scc.isSourceControlCenterOpen(), false);
    assert.equal(document.querySelector('#chatArea p'), transcript);
    assert.equal(document.getElementById('mainColumn')?.className, '');
  } finally {
    scc.resetSourceControlCenterForTests();
    resetInstancesForTests();
    await teardownHappyDomAsync(win);
  }
});

test('Pull and Push show their commit counts and sync the selected worktree with a clean working tree', async () => {
  const win = new Window();
  const cwd = '/repo/feature-worktree';
  const requests: { op: string; cwd?: string }[] = [];
  let behind = 1;
  let ahead = 2;
  installHappyDomGlobals(win, {
    fetch: async (_input, init) => {
      const request = JSON.parse(String(init?.body ?? '{}'));
      requests.push(request);
      if (request.op === 'pull') behind = 0;
      if (request.op === 'push') ahead = 0;
      return new Response(JSON.stringify({
        ok: true, ahead, behind, current: 'feature', local: ['feature'],
        branches: [{ name: 'feature', upstream: 'origin/feature' }],
      }));
    },
  });
  const { setLocalServerAvailableForTests } = await import('../../src/tools/config.ts');
  const { launchInstance, resetInstancesForTests } = await import('../../src/os/instances.ts');
  const { resetToastsForTests } = await import('../../src/ui/toast.ts');
  const scc = await import('../../src/ui/source-control-center.ts');
  setLocalServerAvailableForTests(true);
  seedMinimalSession('sync-chat');
  document.body.innerHTML = '<main id="sourceControlView"></main>';

  try {
    launchInstance('source-control');
    await scc.openSourceControlCenter({ cwd });
    await scc.mountSourceControlCenter();
    const pull = document.querySelector<HTMLButtonElement>('.scc-head__pull')!;
    const push = document.querySelector<HTMLButtonElement>('.scc-head__push')!;
    const pullCount = pull.querySelector<HTMLElement>('.scc-head__sync-count')!;
    const pushCount = push.querySelector<HTMLElement>('.scc-head__sync-count')!;
    assert.deepEqual([pullCount.textContent, pushCount.textContent], ['1', '2']);
    assert.deepEqual([pullCount.hidden, pushCount.hidden], [false, false]);
    assert.equal(pull.getAttribute('aria-label'), 'Pull, 1 commit');
    assert.equal(push.getAttribute('aria-label'), 'Push, 2 commits');

    pull.click();
    await setImmediate();
    assert.equal(pullCount.hidden, true);
    assert.equal(pushCount.hidden, false);
    push.click();
    await setImmediate();
    assert.equal(pushCount.hidden, true);
    assert.deepEqual(requests.filter(({ op }) => op === 'pull' || op === 'push'), [
      { op: 'pull', cwd }, { op: 'push', cwd },
    ]);
  } finally {
    scc.resetSourceControlCenterForTests();
    resetInstancesForTests();
    resetToastsForTests();
    setLocalServerAvailableForTests(false);
    await teardownHappyDomAsync(win);
  }
});

test('change selection keys reach the list and Escape dismisses its menu without leaving Source Control', async () => {
  const win = new Window();
  const fetch = async () => new Response(JSON.stringify({ ok: true, unstaged: [{ path: 'a.ts', status: 'M' }, { path: 'b.ts', status: 'M' }] }));
  installHappyDomGlobals(win, { fetch });
  Object.assign(globalThis, { HTMLInputElement: win.HTMLInputElement, HTMLTextAreaElement: win.HTMLTextAreaElement });
  const { setLocalServerAvailable } = await import('../../src/tools/config.ts');
  setLocalServerAvailable(true);
  seedMinimalSession('chat-1');
  document.body.innerHTML = '<div id="mainColumn"><div id="chatArea"></div></div><main id="sourceControlView"></main>';
  const { launchInstance, resetInstancesForTests } = await import('../../src/os/instances.ts');
  const scc = await import('../../src/ui/source-control-center.ts');
  try {
    launchInstance('source-control');
    await scc.mountSourceControlCenter();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const row = document.querySelector<HTMLElement>('.scc-filerow')!;
    assert.ok(row);
    row.focus();
    row.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'a', metaKey: true, bubbles: true, cancelable: true }));
    assert.equal(document.querySelectorAll('.scc-filerow.is-selected').length, 2);
    row.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true }));
    assert.ok(document.querySelector('.mn-menu'));
    document.activeElement!.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    assert.equal(document.querySelector('.mn-menu'), null);
    assert.equal(scc.isSourceControlCenterOpen(), true);
    assert.equal(document.querySelectorAll('.scc-filerow.is-selected').length, 2);
  } finally {
    scc.resetSourceControlCenterForTests();
    resetInstancesForTests();
    await teardownHappyDomAsync(win);
  }
});

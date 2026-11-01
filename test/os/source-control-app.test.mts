import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Window } from 'happy-dom';
import { listRailApps } from '../../src/os/app-preferences.ts';
import { parseOsHash, hashForRoute } from '../../src/os/router.ts';
import { installHappyDomGlobals, seedMinimalSession, teardownHappyDomAsync } from './dom-helpers.mts';

test('Source Control follows Code and Dashboard in the rail and has its own route', () => {
  assert.deepEqual(listRailApps().slice(0, 3).map((app) => app.id), ['code', 'home', 'source-control']);
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

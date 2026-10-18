import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { Window } from 'happy-dom';
import { getForegroundAppId, launchInstance, resetInstancesForTests, showWorkspaces } from '../../src/os/instances.ts';
import { resetOsRouterForTests } from '../../src/os/router.ts';
import { seedMinimalSession } from './dom-helpers.mts';
import { sessionState } from '../../src/state/sessions.ts';

function setupShellDom() {
  const window = new Window();
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.performance = window.performance;
  globalThis.HTMLElement = window.HTMLElement;
  return window;
}

const { isPageReload } = await import('../../src/boot/page-navigation.ts');

const {
  beginWorkspaceGateForBoot,
  finishWorkspaceGateSwitch,
  isHoldingWorkspaceGateForAppReady,
  isWorkspaceGateOpen,
  mountWorkspaceGateDom,
  onWorkspaceGateChosen,
  openWorkspaceGate,
  revealAppAfterWorkspaceGate,
  resetWorkspaceGateForTests,
  shouldBlockBootOnWorkspaceGate,
} = await import('../../src/os/workspace-gate.ts');

const { resetWorkspaceStateForTests, setWorkspaceFromServer } = await import(
  '../../src/state/workspace.ts'
);

describe('page-navigation', () => {
  test('isPageReload is false without a navigation entry', () => {
    setupShellDom();
    assert.equal(isPageReload(), false);
  });
});

describe('workspace-gate boot', { concurrency: false }, () => {
  test('shouldBlockBootOnWorkspaceGate is false on reload', () => {
    setupShellDom();
    resetWorkspaceGateForTests();
    resetWorkspaceStateForTests();
    setWorkspaceFromServer({
      path: '/projects/app',
      label: 'app',
      isDefault: false,
    });

    performance.getEntriesByType = () => [{ type: 'reload' }];

    assert.equal(shouldBlockBootOnWorkspaceGate(), false);
  });

  test('shouldBlockBootOnWorkspaceGate is true on cold launch', () => {
    setupShellDom();
    resetWorkspaceGateForTests();
    resetWorkspaceStateForTests();
    setWorkspaceFromServer({
      path: '/projects/app',
      label: 'app',
      isDefault: false,
    });

    performance.getEntriesByType = () => [{ type: 'navigate' }];

    assert.equal(shouldBlockBootOnWorkspaceGate(), true);
  });

  test('finishWorkspaceGateSwitch closes an open gate without holding for initApp', async () => {
    const window = setupShellDom();
    resetWorkspaceGateForTests();
    // happy-dom does not pump rAF unless we shim it (finishWorkspaceGateSwitch waits for paint).
    const rafShim = (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    };
    window.requestAnimationFrame = rafShim;
    globalThis.requestAnimationFrame = rafShim;
    window.document.body.innerHTML = `
      <div id="osWorkspaceGate" hidden></div>
      <div id="welcomeView" hidden></div>
    `;
    mountWorkspaceGateDom();
    openWorkspaceGate({ switch: true });
    assert.equal(isWorkspaceGateOpen(), true);

    await finishWorkspaceGateSwitch();

    assert.equal(isWorkspaceGateOpen(), false);
    assert.equal(
      document.documentElement.classList.contains('os-workspace-gate-holding'),
      false,
    );
  });

  test('late workspace pick after reload closes without holding for app ready', async () => {
    const window = setupShellDom();
    resetWorkspaceGateForTests();
    const rafShim = (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    };
    window.requestAnimationFrame = rafShim;
    globalThis.requestAnimationFrame = rafShim;
    globalThis.fetch = async () => new Response('{}');
    window.document.body.innerHTML = `
      <div id="osWorkspaceGate" hidden></div>
      <div id="welcomeView" hidden></div>
    `;
    mountWorkspaceGateDom();
    openWorkspaceGate();

    await onWorkspaceGateChosen();

    assert.equal(isHoldingWorkspaceGateForAppReady(), false);
    assert.equal(isWorkspaceGateOpen(), false);
    assert.equal(getForegroundAppId(), 'code');
    assert.equal(window.location.hash, '#/app/code/chat');
  });

  test('cold project pick opens Code under the gate without replacing its saved session', async () => {
    const window = setupShellDom();
    resetWorkspaceGateForTests(); resetInstancesForTests(); resetOsRouterForTests();
    const codeChat = seedMinimalSession('existing-project-chat');
    codeChat.name = 'Work in progress';
    window.requestAnimationFrame = globalThis.requestAnimationFrame = cb => { cb(0); return 1; };
    globalThis.fetch = async () => new Response(JSON.stringify({ path: '/projects/app', label: 'app', isDefault: false }));
    performance.getEntriesByType = () => [{ type: 'navigate' }];
    window.location.hash = '#/workspaces'; showWorkspaces();
    document.body.innerHTML = '<div id="osWorkspaceGate" hidden></div><div id="welcomeView" hidden></div>';
    const gate = await beginWorkspaceGateForBoot();
    assert.ok(gate);
    await onWorkspaceGateChosen(); await gate.whenChosen;
    assert.equal(getForegroundAppId(), 'code');
    assert.equal(window.location.hash, '#/app/code/chat');
    assert.equal(isHoldingWorkspaceGateForAppReady(), true);
    assert.equal(sessionState.activeId, codeChat.id);
    assert.deepEqual(sessionState.chats, [codeChat]);
    await revealAppAfterWorkspaceGate();
    assert.equal(isWorkspaceGateOpen(), false);
    resetInstancesForTests(); resetOsRouterForTests();
  });

  test('switching project from Dashboard returns to Code without starting another chat', async () => {
    const window = setupShellDom();
    resetWorkspaceGateForTests(); resetInstancesForTests(); resetOsRouterForTests();
    const codeChat = seedMinimalSession('existing-project-chat');
    window.requestAnimationFrame = globalThis.requestAnimationFrame = cb => { cb(0); return 1; };
    globalThis.fetch = async () => new Response('{}');
    document.body.innerHTML = '<div id="osWorkspaceGate" hidden></div><div id="welcomeView" hidden></div>';
    launchInstance('home'); window.location.hash = '#/app/home';
    openWorkspaceGate({ switch: true });
    await onWorkspaceGateChosen();
    assert.equal(getForegroundAppId(), 'code');
    assert.equal(window.location.hash, '#/app/code/chat');
    assert.equal(isWorkspaceGateOpen(), false);
    assert.equal(isHoldingWorkspaceGateForAppReady(), false);
    assert.equal(sessionState.activeId, codeChat.id);
    assert.deepEqual(sessionState.chats, [codeChat]);
    resetInstancesForTests(); resetOsRouterForTests();
  });
});

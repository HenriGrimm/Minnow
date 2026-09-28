import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { Window } from 'happy-dom';

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
  finishWorkspaceGateSwitch,
  isHoldingWorkspaceGateForAppReady,
  isWorkspaceGateOpen,
  mountWorkspaceGateDom,
  onWorkspaceGateChosen,
  openWorkspaceGate,
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
  });
});

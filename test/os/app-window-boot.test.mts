import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { Window } from 'happy-dom';
import { installHappyDomGlobals, teardownHappyDomAsync } from './dom-helpers.mts';

let win: InstanceType<typeof Window> | undefined;

function setupDom(): void {
  win = new Window();
  installHappyDomGlobals(win);
}

afterEach(async () => {
  if (win) {
    delete (globalThis.window as Window & { minnow?: unknown }).minnow;
    await teardownHappyDomAsync(win);
    win = undefined;
  }
});

describe('app-window boot', { concurrency: false }, () => {
  test('stamps data-app-window and resolves the boot hash', async () => {
    setupDom();
    window.location.hash = '#/workspaces';
    (window as Window & { minnow?: unknown }).minnow = {
      viewContext: { workspacePath: '/repo', viewId: 'view-1', hosted: false, appId: 'issues' },
    };

    const {
      applyAppWindowBoot,
      resolveAppWindowBootHash,
      isHashInAppWindow,
    } = await import('../../src/os/app-window.ts');

    assert.equal(resolveAppWindowBootHash('issues'), '#/app/issues');
    const bound = applyAppWindowBoot();
    assert.equal(bound, 'issues');
    assert.equal(document.documentElement.dataset.appWindow, 'issues');
    assert.equal(window.location.hash, '#/app/issues');
    assert.equal(isHashInAppWindow('#/app/issues/ISS-1', 'issues'), true);
    assert.equal(isHashInAppWindow('#/app/code', 'issues'), false);
  });

  test('leaves a normal shell window unchanged', async () => {
    setupDom();
    window.location.hash = '#/workspaces';
    document.documentElement.dataset.appWindow = 'stale';
    (window as Window & { minnow?: unknown }).minnow = {
      viewContext: { workspacePath: '/repo', viewId: 'view-1', hosted: false },
    };

    const { applyAppWindowBoot, getAppWindowId } = await import('../../src/os/app-window.ts');
    assert.equal(getAppWindowId(), null);
    assert.equal(applyAppWindowBoot(), null);
    assert.ok(!document.documentElement.dataset.appWindow);
    assert.equal(window.location.hash, '#/workspaces');
  });

  test('Back to chat sends the return to the workspace window', async () => {
    setupDom();
    window.location.hash = '#/app/issues';
    const commands: unknown[] = [];
    (window as Window & { minnow?: unknown }).minnow = {
      viewContext: { workspacePath: '/repo', viewId: 'issues-1', hosted: false, appId: 'issues' },
      window: { sendCodeCommand: async (command: unknown) => {
        commands.push(command);
        return { ok: true };
      } },
    };

    const { returnToChat } = await import('../../src/os/router.ts');
    await returnToChat();
    assert.deepEqual(commands, [{ kind: 'chat', workspacePath: '/repo' }]);
    assert.equal(window.location.hash, '#/app/issues');
  });
});

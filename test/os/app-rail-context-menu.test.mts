import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { Window } from 'happy-dom';
import { installHappyDomGlobals, teardownHappyDomAsync } from './dom-helpers.mts';
import { resetAppPreferencesForTests } from '../../src/os/app-preferences.ts';
import { resetInstancesForTests } from '../../src/os/instances.ts';

let win: InstanceType<typeof Window> | undefined;
let opened: string[] = [];

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function setupRail(bridge: boolean, alreadyOpen = false): HTMLElement {
  win = new Window();
  installHappyDomGlobals(win);
  opened = [];
  resetAppPreferencesForTests();
  resetInstancesForTests();
  if (bridge) {
    (window as Window & { minnow?: unknown }).minnow = {
      window: {
        openAppWindow: async (appId: string) => {
          opened.push(appId);
          return { ok: true, focused: alreadyOpen };
        },
        hasAppWindow: async () => ({ open: alreadyOpen }),
      },
    };
  }
  const root = document.createElement('nav');
  document.body.appendChild(root);
  return root;
}

afterEach(async () => {
  resetAppPreferencesForTests();
  resetInstancesForTests();
  if (win) {
    delete (window as Window & { minnow?: unknown }).minnow;
    await teardownHappyDomAsync(win);
    win = undefined;
  }
});

describe('app rail context menu', { concurrency: false }, () => {
  beforeEach(() => {
    opened = [];
  });

  test('offers Open in new window on an eligible tile', async () => {
    const root = setupRail(true, false);
    const { initAppRail } = await import('../../src/os/app-rail.ts');
    initAppRail(root);

    const issues = root.querySelector('[data-app-id="issues"]');
    assert.ok(issues);
    issues.dispatchEvent(
      new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 12, clientY: 20 }),
    );
    await tick();
    await tick();

    const labels = [...document.querySelectorAll('.mn-menu__label')].map((el) => el.textContent);
    assert.deepEqual(labels, ['Open in new window']);

    const item = document.querySelector('.mn-menu__item');
    assert.ok(item);
    (item as HTMLButtonElement).click();
    await tick();
    assert.deepEqual(opened, ['issues']);
  });

  test('labels Focus window when that app window already exists', async () => {
    const root = setupRail(true, true);
    const { initAppRail } = await import('../../src/os/app-rail.ts');
    initAppRail(root);

    const issues = root.querySelector('[data-app-id="issues"]');
    assert.ok(issues);
    issues.dispatchEvent(
      new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 8, clientY: 8 }),
    );
    await tick();
    await tick();

    const labels = [...document.querySelectorAll('.mn-menu__label')].map((el) => el.textContent);
    assert.deepEqual(labels, ['Focus window']);
  });

  test('does not open a custom menu on Code', async () => {
    const root = setupRail(true, false);
    const { initAppRail } = await import('../../src/os/app-rail.ts');
    initAppRail(root);

    const code = root.querySelector('[data-app-id="code"]');
    assert.ok(code);
    const event = new window.MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: 4,
      clientY: 4,
    });
    code.dispatchEvent(event);
    await tick();
    assert.equal(document.querySelector('.mn-menu'), null);
  });

  test('does not open a custom menu without the Electron bridge', async () => {
    const root = setupRail(false);
    const { initAppRail } = await import('../../src/os/app-rail.ts');
    initAppRail(root);

    const issues = root.querySelector('[data-app-id="issues"]');
    assert.ok(issues);
    issues.dispatchEvent(
      new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 4, clientY: 4 }),
    );
    await tick();
    assert.equal(document.querySelector('.mn-menu'), null);
  });
});

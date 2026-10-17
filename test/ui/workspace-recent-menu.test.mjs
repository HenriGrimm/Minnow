import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { Window } from 'happy-dom';
import {
  installHappyDomGlobals,
  teardownHappyDomAsync,
} from '../os/dom-helpers.mts';

/** @type {import('happy-dom').Window | undefined} */
let win;

function setupDom() {
  win = new Window();
  installHappyDomGlobals(win);
  document.body.innerHTML =
    '<span id="sDot" class="s-dot"></span><span id="sText"></span>';
  globalThis.fetch = async (url, init) => {
    const path = String(url);
    if (path.includes('/api/workspace/recent') && init?.method === 'DELETE') {
      return {
        ok: true,
        json: async () => ({ ok: true, recent: [] }),
      };
    }
    if (path.includes('/api/workspace')) {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          path: '/projects/current',
          label: 'current',
          isDefault: false,
          recent: [
            {
              path: '/projects/current',
              label: 'current',
              exists: true,
              isCurrent: true,
            },
            {
              path: '/projects/missing',
              label: 'missing',
              exists: false,
              isCurrent: false,
            },
          ],
        }),
      };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
}

const {
  closeWorkspaceMenu,
  isWorkspaceMenuOpen,
  renderWorkspaceMenuForTest,
  resetWorkspaceMenuForTests,
  setWorkspaceMenuDeps,
  toggleWorkspaceMenu,
} = await import('../../src/ui/workspace-recent-menu.ts');

setWorkspaceMenuDeps({
  isServerAvailable: () => true,
  reportStatus: () => {},
});

describe('workspace-recent-menu', { concurrency: false }, () => {
  afterEach(async () => {
    resetWorkspaceMenuForTests();
    closeWorkspaceMenu();
    if (win) {
      await teardownHappyDomAsync(win);
      win = undefined;
    }
  });

  test('render list marks current row with aria-current', async () => {
    setupDom();
    const menu = document.createElement('ul');
    await renderWorkspaceMenuForTest(menu);

    const current = menu.querySelector('[aria-current="true"]');
    assert.ok(current);
    const check = current.querySelector('.workspace-menu__check');
    assert.equal(check?.textContent, '✓');
  });

  test('missing path row is disabled and does not call setWorkspacePath on click', async () => {
    setupDom();
    let putCalled = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      if (init?.method === 'PUT') {
        putCalled = true;
      }
      return originalFetch(url, init);
    };

    const menu = document.createElement('ul');
    await renderWorkspaceMenuForTest(menu);
    const disabled = menu.querySelector('.workspace-menu__item--disabled');
    assert.ok(disabled);
    assert.equal(disabled.getAttribute('aria-disabled'), 'true');
    disabled.click();
    assert.equal(putCalled, false);
  });

  test('Escape closes menu and clears aria-expanded', async () => {
    setupDom();
    const btn = document.createElement('button');
    btn.id = 'btnWorkspace';
    document.body.appendChild(btn);

    await toggleWorkspaceMenu(btn);
    assert.equal(isWorkspaceMenuOpen(), true);
    assert.equal(btn.getAttribute('aria-expanded'), 'true');

    const winView = document.defaultView;
    document.dispatchEvent(
      new winView.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    assert.equal(isWorkspaceMenuOpen(), false);
    assert.equal(btn.getAttribute('aria-expanded'), 'false');
    closeWorkspaceMenu();
  });

  test('pointerdown on the folder-name label keeps the menu open; outside closes it', async () => {
    setupDom();
    const control = document.createElement('div');
    control.className = 'workspace-control';
    const btn = document.createElement('button');
    btn.id = 'btnWorkspace';
    const label = document.createElement('span');
    label.id = 'workspacePathLabel';
    label.textContent = 'current';
    control.append(btn, label);
    const outside = document.createElement('div');
    document.body.append(control, outside);

    await toggleWorkspaceMenu(btn);
    assert.equal(isWorkspaceMenuOpen(), true);

    const winView = document.defaultView;
    label.dispatchEvent(new winView.PointerEvent('pointerdown', { bubbles: true }));
    assert.equal(isWorkspaceMenuOpen(), true, 'label press is handled by the control click');

    outside.dispatchEvent(new winView.PointerEvent('pointerdown', { bubbles: true }));
    assert.equal(isWorkspaceMenuOpen(), false);
  });
});

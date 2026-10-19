/**
 * Issues / composer shared run-target picker: current workspace, Worktree…, New worktree.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { Window } from 'happy-dom';
import { installHappyDomGlobals, teardownHappyDomAsync } from '../os/dom-helpers.mts';
import { setLocalServerAvailableForTests } from '../../src/tools/config.ts';
import { setWorkspaceFromServer } from '../../src/state/workspace.ts';
import {
  closeRunTargetPicker,
  fillRunTargetMenu,
  openRunTargetPicker,
} from '../../src/ui/composer-run-target-menu.ts';
import type { ChatRunTargetChoice } from '../../src/state/chat-worktree.ts';

const PORCELAIN = [
  'worktree /repo/main',
  'HEAD abc',
  'branch refs/heads/main',
  '',
  'worktree /repo/feature-wt',
  'HEAD def',
  'branch refs/heads/feat/login',
  '',
].join('\n');

describe('composer run-target picker', () => {
  let win: InstanceType<typeof Window>;

  beforeEach(() => {
    win = new Window();
    installHappyDomGlobals(win, {
      fetch: (async () =>
        ({
          ok: true,
          json: async () => ({ ok: true, output: PORCELAIN }),
        }) as Response) as typeof fetch,
    });
    setLocalServerAvailableForTests(true);
    setWorkspaceFromServer({ path: '/repo/main', label: 'Minnow', isDefault: false });
    const anchor = win.document.createElement('button');
    anchor.id = 'anchor';
    win.document.body.appendChild(anchor);
  });

  afterEach(async () => {
    closeRunTargetPicker();
    setLocalServerAvailableForTests(false);
    await teardownHappyDomAsync(win);
  });

  test('fillRunTargetMenu lists the workspace name, Worktree…, and New worktree', async () => {
    const menu = win.document.createElement('div');
    win.document.body.appendChild(menu);
    const anchor = win.document.getElementById('anchor') as HTMLButtonElement;
    await fillRunTargetMenu({
      menu,
      repoRoot: '/repo/main',
      popoverAnchor: anchor,
      closeMenu: () => {},
      reopenMenu: () => {},
      onPick: () => {},
    });
    const labels = [...menu.querySelectorAll('.composer-run-target-menu__item')].map(
      (el) => el.textContent,
    );
    assert.ok(labels.includes('Minnow'));
    assert.ok(labels.includes('Worktree…'));
    assert.ok(labels.includes('New worktree'));
  });

  test('the current workspace emits a local choice', async () => {
    const picked: ChatRunTargetChoice[] = [];
    const menu = win.document.createElement('div');
    win.document.body.appendChild(menu);
    const anchor = win.document.getElementById('anchor') as HTMLButtonElement;
    await fillRunTargetMenu({
      menu,
      repoRoot: '/repo/main',
      popoverAnchor: anchor,
      closeMenu: () => {},
      reopenMenu: () => {},
      onPick: (choice) => {
        picked.push(choice);
      },
    });
    const local = [...menu.querySelectorAll('button')].find((btn) =>
      btn.textContent === 'Minnow',
    );
    local?.click();
    assert.deepEqual(picked, [{ kind: 'local' }]);
  });

  test('Enable worktree emits an automatic choice without a name popover', async () => {
    const picked: ChatRunTargetChoice[] = [];
    const anchor = win.document.getElementById('anchor') as HTMLButtonElement;
    await openRunTargetPicker({ anchor, repoRoot: '/repo/main', onPick: choice => { picked.push(choice); } });
    const enable = [...win.document.querySelectorAll('button')].find(btn => btn.textContent === 'Enable worktree');
    assert.ok(enable);
    enable.click();
    assert.deepEqual(picked, [{ kind: 'automatic' }]);
    assert.equal(win.document.querySelector('.git-panel-name-popover'), null);
  });

  test('the expanded composer menu exposes branch selection and marks the current worktree', async () => {
    const menu = win.document.createElement('div');
    win.document.body.append(menu);
    let branchOpened = false;
    await fillRunTargetMenu({
      menu, repoRoot: '/repo/main', currentPath: '/repo/feature-wt',
      currentName: 'Login worktree', currentBranch: 'feat/login',
      popoverAnchor: win.document.getElementById('anchor') as HTMLButtonElement,
      closeMenu: () => {}, reopenMenu: () => {}, onPick: () => {},
      onSelectBranch: () => { branchOpened = true; },
    });
    const buttons = [...menu.querySelectorAll('button')];
    assert.ok(buttons.some(button => button.textContent === 'Back to Local'));
    assert.equal(buttons.some(button => button.textContent === 'Enable worktree'), false);
    buttons.find(button => button.textContent === 'Switch branch · feat/login')!.click();
    assert.equal(branchOpened, true);
    buttons.find(button => button.textContent === 'Change worktree…')!.click();
    const current = [...menu.querySelectorAll('button')].find(button => button.textContent?.includes('feat/login'))!;
    assert.equal(current.disabled, true, 'the attached checkout cannot be selected again');
  });

  test('openRunTargetPicker cancel (Escape) does not pick', async () => {
    const picked: ChatRunTargetChoice[] = [];
    let cancelled = false;
    const anchor = win.document.getElementById('anchor') as HTMLButtonElement;
    await openRunTargetPicker({
      anchor,
      onPick: (choice) => {
        picked.push(choice);
      },
      onCancel: () => {
        cancelled = true;
      },
    });
    assert.ok(win.document.querySelector('.composer-run-target-menu'));
    win.document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(picked.length, 0);
    assert.equal(cancelled, true);
    assert.equal(win.document.querySelector('.composer-run-target-menu'), null);
  });
});

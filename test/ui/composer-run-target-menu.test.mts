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

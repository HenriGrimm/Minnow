/**
 * MIN-659: git name popover auto-fixes invalid branch/worktree names.
 * Start-from / check-out row for New branch and Add worktree.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { Window } from 'happy-dom';
import { installHappyDomGlobals, teardownHappyDomAsync } from '../os/dom-helpers.mts';
import {
  closeGitPanelNamePopover,
  openGitBranchSwitchPopover,
  openGitPanelNamePopover,
  openGitRefNamePopover,
  type GitBranchSwitchChoice,
  type GitRefCreateResult,
} from '../../src/ui/git-panel-name-popover.ts';

const BRANCH_LISTS = {
  current: 'feature/open',
  local: ['main', 'feature/open'],
  remote: ['remotes/origin/main'],
  lockedLocal: ['locked-elsewhere'],
};

describe('git-panel-name-popover slug preview (MIN-659)', () => {
  let win: InstanceType<typeof Window>;

  beforeEach(() => {
    win = new Window();
    installHappyDomGlobals(win);
    const anchor = win.document.createElement('button');
    anchor.id = 'anchor';
    win.document.body.appendChild(anchor);
  });

  afterEach(async () => {
    closeGitPanelNamePopover();
    await teardownHappyDomAsync(win);
  });

  test('defaults to a title slug and previews Test Worktree as test-worktree', () => {
    const submitted: GitRefCreateResult[] = [];
    const anchor = win.document.getElementById('anchor') as HTMLButtonElement;
    openGitRefNamePopover({
      anchor,
      title: 'New worktree',
      kind: 'worktree',
      defaultTitle: 'Fix login bug',
      defaultPath: '/tmp/opaque-chat-id',
      reserved: ['main'],
      branchLists: BRANCH_LISTS,
      onSubmit: (result) => {
        submitted.push(result);
      },
    });

    const input = win.document.querySelector(
      '.git-panel-name-popover__input',
    ) as HTMLInputElement;
    const preview = win.document.querySelector(
      '.git-panel-name-popover__preview',
    ) as HTMLElement;
    assert.equal(input.value, 'fix-login-bug');
    assert.equal(preview.hidden, true);

    input.value = 'Test Worktree';
    input.dispatchEvent(new win.Event('input', { bubbles: true }));
    assert.equal(preview.hidden, false);
    assert.equal(preview.textContent, 'Will use test-worktree');

    const create = [...win.document.querySelectorAll('button')].find(
      (btn) => btn.textContent === 'Create',
    );
    create?.click();
    assert.deepEqual(submitted, [
      { name: 'test-worktree', startPoint: 'feature/open', checkoutExisting: false },
    ]);
  });

  test('illegal-only input submits the worktree fallback instead of erroring', () => {
    const submitted: GitRefCreateResult[] = [];
    const anchor = win.document.getElementById('anchor') as HTMLButtonElement;
    openGitRefNamePopover({
      anchor,
      title: 'Add worktree',
      kind: 'worktree',
      branchLists: BRANCH_LISTS,
      onSubmit: (result) => {
        submitted.push(result);
      },
    });

    const input = win.document.querySelector(
      '.git-panel-name-popover__input',
    ) as HTMLInputElement;
    input.value = '***';
    input.dispatchEvent(new win.Event('input', { bubbles: true }));
    const preview = win.document.querySelector(
      '.git-panel-name-popover__preview',
    ) as HTMLElement;
    assert.equal(preview.textContent, 'Will use worktree');

    const create = [...win.document.querySelectorAll('button')].find(
      (btn) => btn.textContent === 'Create',
    );
    create?.click();
    assert.deepEqual(submitted, [
      { name: 'worktree', startPoint: 'feature/open', checkoutExisting: false },
    ]);
  });

  test('stash-style popover without normalize still requires a non-empty name', () => {
    const submitted: string[] = [];
    const anchor = win.document.getElementById('anchor') as HTMLButtonElement;
    openGitPanelNamePopover({
      anchor,
      title: 'Stash changes',
      label: 'Description',
      onSubmit: (name) => {
        submitted.push(name);
      },
    });

    const create = [...win.document.querySelectorAll('button')].find(
      (btn) => btn.textContent === 'Create',
    );
    create?.click();
    assert.deepEqual(submitted, []);
    assert.ok(win.document.querySelector('.git-panel-name-popover'));
  });

  test('worktree check out hides the name field and submits the selected ref', () => {
    const submitted: GitRefCreateResult[] = [];
    const anchor = win.document.getElementById('anchor') as HTMLButtonElement;
    openGitRefNamePopover({
      anchor,
      title: 'Add worktree',
      kind: 'worktree',
      branchLists: BRANCH_LISTS,
      onSubmit: (result) => {
        submitted.push(result);
      },
    });

    const checkoutBtn = [...win.document.querySelectorAll('button')].find(
      (btn) => btn.textContent === 'Check out',
    );
    assert.ok(checkoutBtn);
    checkoutBtn.click();

    const nameField = win.document.querySelector(
      '.git-panel-name-popover__name',
    ) as HTMLElement;
    assert.equal(nameField.hasAttribute('hidden'), true);

    const select = win.document.querySelector(
      '.git-panel-name-popover__select',
    ) as HTMLSelectElement;
    assert.equal(select.value, 'main');
    assert.equal(select.querySelector('option[value="feature/open"]')?.disabled, true);
    assert.equal(select.querySelector('option[value="locked-elsewhere"]')?.disabled, true);

    const create = [...win.document.querySelectorAll('button')].find(
      (btn) => btn.textContent === 'Create',
    );
    create?.click();
    assert.deepEqual(submitted, [
      { name: 'main', startPoint: 'main', checkoutExisting: true },
    ]);
  });

  test('new branch has a start-from select and no checkout toggle', () => {
    const submitted: GitRefCreateResult[] = [];
    const anchor = win.document.getElementById('anchor') as HTMLButtonElement;
    openGitRefNamePopover({
      anchor,
      title: 'New branch',
      kind: 'branch',
      branchLists: BRANCH_LISTS,
      onSubmit: (result) => {
        submitted.push(result);
      },
    });

    assert.equal(
      [...win.document.querySelectorAll('button')].some((btn) => btn.textContent === 'Check out'),
      false,
    );
    const select = win.document.querySelector(
      '.git-panel-name-popover__select',
    ) as HTMLSelectElement;
    assert.equal(select.value, 'feature/open');
    assert.ok(select.querySelector('option[value="origin/main"]'));

    const create = [...win.document.querySelectorAll('button')].find(
      (btn) => btn.textContent === 'Create',
    );
    create?.click();
    assert.equal(submitted[0]?.startPoint, 'feature/open');
    assert.equal(submitted[0]?.checkoutExisting, false);
  });

  test('branch switcher lists branches and switches on click', () => {
    const submitted: GitBranchSwitchChoice[] = [];
    const anchor = win.document.getElementById('anchor') as HTMLButtonElement;
    openGitBranchSwitchPopover({
      anchor,
      branchLists: {
        ...BRANCH_LISTS,
        remote: ['remotes/origin/HEAD -> origin/main', 'remotes/origin/main', 'remotes/origin/fix/remote-only'],
      },
      onSubmit: (choice) => {
        submitted.push(choice);
      },
    });

    const options = [
      ...win.document.querySelectorAll('.git-panel-name-popover__option'),
    ] as HTMLElement[];
    // Current first, remotes that already have a local branch are not repeated.
    assert.deepEqual(
      options.map((node) => node.querySelector('.git-panel-name-popover__option-name')?.textContent),
      ['feature/open', 'main', 'locked-elsewhere', 'origin/fix/remote-only'],
    );
    assert.equal(options[0]?.getAttribute('aria-disabled'), 'true');
    assert.equal(options[2]?.getAttribute('aria-disabled'), 'true');

    options[0]?.click();
    assert.deepEqual(submitted, []);

    options[1]?.click();
    assert.deepEqual(submitted, [{ name: 'main', kind: 'local' }]);
    assert.equal(win.document.querySelector('.git-panel-name-popover'), null);
  });

  test('branch switcher filters, tracks a remote on Enter, and offers Create for new names', () => {
    const submitted: GitBranchSwitchChoice[] = [];
    const anchor = win.document.getElementById('anchor') as HTMLButtonElement;
    const openSwitcher = (): HTMLInputElement => {
      openGitBranchSwitchPopover({
        anchor,
        branchLists: { ...BRANCH_LISTS, remote: ['remotes/origin/fix/remote-only'] },
        onSubmit: (choice) => {
          submitted.push(choice);
        },
      });
      return win.document.querySelector('.git-panel-name-popover__input') as HTMLInputElement;
    };
    const names = (): (string | null | undefined)[] =>
      [...win.document.querySelectorAll('.git-panel-name-popover__option-name')].map(
        (node) => node.textContent,
      );
    const press = (input: HTMLInputElement, key: string): void => {
      input.dispatchEvent(new win.KeyboardEvent('keydown', { key, bubbles: true }));
    };

    let input = openSwitcher();
    press(input, 'Enter');
    assert.deepEqual(submitted, [], 'Enter with nothing highlighted does not switch');

    input.value = 'remote';
    input.dispatchEvent(new win.Event('input', { bubbles: true }));
    assert.deepEqual(names(), ['origin/fix/remote-only', 'Create branch remote']);
    press(input, 'Enter');
    assert.deepEqual(submitted, [
      { name: 'fix/remote-only', kind: 'remote', startPoint: 'origin/fix/remote-only' },
    ]);

    input = openSwitcher();
    input.value = 'New Idea';
    input.dispatchEvent(new win.Event('input', { bubbles: true }));
    assert.deepEqual(names(), ['Create branch new-idea']);
    press(input, 'Enter');
    assert.deepEqual(submitted[1], { name: 'new-idea', kind: 'create' });

    input = openSwitcher();
    input.value = 'main';
    input.dispatchEvent(new win.Event('input', { bubbles: true }));
    assert.deepEqual(names(), ['main'], 'an existing branch name does not offer Create');
    press(input, 'ArrowDown');
    press(input, 'Enter');
    assert.deepEqual(submitted[2], { name: 'main', kind: 'local' });
  });

  test('git-graph fixed start point hides the start-from select', () => {
    const submitted: GitRefCreateResult[] = [];
    const anchor = win.document.getElementById('anchor') as HTMLButtonElement;
    openGitRefNamePopover({
      anchor,
      title: 'Create branch',
      kind: 'branch',
      fixedStartPoint: 'abc1234',
      branchLists: BRANCH_LISTS,
      onSubmit: (result) => {
        submitted.push(result);
      },
    });

    assert.equal(win.document.querySelector('.git-panel-name-popover__select'), null);
    const create = [...win.document.querySelectorAll('button')].find(
      (btn) => btn.textContent === 'Create',
    );
    create?.click();
    assert.equal(submitted[0]?.startPoint, 'abc1234');
    assert.equal(submitted[0]?.checkoutExisting, false);
  });
});

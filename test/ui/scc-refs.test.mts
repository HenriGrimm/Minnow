import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Window } from 'happy-dom';
import { installHappyDomGlobals } from '../os/dom-helpers.mts';
import { setLocalServerAvailable } from '../../src/tools/config.ts';
import { buildBranchForest, createBranchesView, createWorktreesView } from '../../src/ui/scc-refs.ts';
import type { GitBranchTreeEntry } from '../../src/state/git-api.ts';
import type { SccContext, SccView } from '../../src/ui/scc-shared.ts';
import { isUnmergedBranchDelete } from '../../src/ui/git-branch-delete.ts';
import { resetAppDialogForTests } from '../../src/ui/app-dialog.ts';

test('force deletion is offered only for an unmerged-branch refusal', () => {
  assert.equal(isUnmergedBranchDelete({ ok: false, error: "error: the branch 'feature' is not fully merged\nhint: run git branch -D" }), true);
  for (const error of ['Cannot delete the current branch', 'branch is checked out at /trees/a', 'permission denied', 'server_off']) {
    assert.equal(isUnmergedBranchDelete({ ok: false, error }), false);
  }
});

for (const bulk of [false, true]) {
  test(`${bulk ? 'multi-select' : 'single'} branch deletion confirms before retrying with force`, async () => {
    const win = new Window();
    installHappyDomGlobals(win);
    setLocalServerAvailable(true);
    const calls: Record<string, any>[] = [];
    let locals = ['main', 'feature/a', 'feature/b', 'feature/locked'];
    let view: SccView;
    globalThis.fetch = (async (_url, init) => {
      const args = JSON.parse(String(init?.body));
      calls.push(args);
      let result: object = { ok: true };
      if (args.op === 'branchTree') result = { ok: true, current: 'main', trunk: 'main', branches: locals.map((name) => treeEntry(name, name === 'main' ? null : 'main')) };
      if (args.op === 'deleteBranch') {
        if (args.branch === 'feature/locked') result = { ok: false, error: 'permission denied' };
        else if (!args.force) result = { ok: false, error: `error: the branch '${args.branch}' is not fully merged` };
        else locals = locals.filter((name) => name !== args.branch);
      }
      return new Response(JSON.stringify(result));
    }) as typeof fetch;
    const ctx: SccContext = {
      getCwd: () => '/repo', getBranch: () => 'main', refreshAll: async () => view.refresh(),
      refreshSection: async () => view.refresh(), goTo() {}, setBadge() {},
    };
    const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 1)); };
    const confirm = (label: string) => {
      const panel = document.querySelector('#appDialogPanel')!;
      const button = [...panel.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent === label);
      assert.ok(button, label);
      button.click();
    };
    try {
      view = createBranchesView(ctx);
      document.body.append(view.root);
      await settle();
      const row = (name: string) => view.root.querySelector<HTMLElement>(`.scc-btree__row[data-branch="${name}"]`)!;
      if (bulk) {
        for (const name of locals.slice(1)) row(name).dispatchEvent(new win.MouseEvent('click', { bubbles: true, ctrlKey: true }) as unknown as MouseEvent);
        view.root.querySelector<HTMLButtonElement>('.scc-list-view__bulk-delete')!.click();
      } else row('feature/a').querySelector<HTMLButtonElement>('[title="Delete feature/a"]')!.click();
      await settle();
      confirm('Delete');
      await settle();
      const panel = document.querySelector('#appDialogPanel')!;
      assert.match(panel.textContent ?? '', /feature\/a/);
      assert.match(panel.textContent ?? '', /not (?:fully )?merged/);
      if (bulk) {
        assert.match(panel.textContent ?? '', /feature\/b/);
        assert.doesNotMatch(panel.textContent ?? '', /feature\/locked/);
      }
      assert.equal(calls.some((call) => call.force), false);
      assert.equal(document.querySelector('#mnGitActivityOverlay.mn-git-activity--error'), null);
      confirm('Force delete');
      await settle();
      assert.deepEqual(calls.filter((call) => call.force).map((call) => [call.branch, call.cwd]),
        (bulk ? ['feature/a', 'feature/b'] : ['feature/a']).map((branch) => [branch, '/repo']));
      assert.equal(row('feature/a'), null);
      if (bulk) {
        assert.equal(row('feature/b'), null);
        assert.equal(row('feature/locked').getAttribute('aria-selected'), 'true');
        assert.match(view.root.textContent ?? '', /permission denied/);
      }
      view.destroy();
    } finally {
      resetAppDialogForTests();
      await win.happyDOM.close();
    }
  });
}

function treeEntry(name: string, parent: string | null, extra: Partial<GitBranchTreeEntry> = {}): GitBranchTreeEntry {
  return {
    name, sha: `${name}-sha`, subject: `tip of ${name}`, date: '2026-09-01T00:00:00Z', parent,
    ahead: parent ? 1 : 0, behind: 0, merged: false, upstream: null,
    upstreamAhead: 0, upstreamBehind: 0, upstreamGone: false, worktree: false, ...extra,
  };
}

test('buildBranchForest puts the trunk first and orders siblings by recent commit', () => {
  const forest = buildBranchForest([
    treeEntry('orphan', null, { date: '2026-09-10T00:00:00Z' }),
    treeEntry('old', 'main', { date: '2026-08-01T00:00:00Z' }),
    treeEntry('main', null),
    treeEntry('new', 'main', { date: '2026-09-05T00:00:00Z' }),
    treeEntry('stacked', 'old'),
  ], 'main');
  assert.deepEqual(forest.map((node) => node.entry.name), ['main', 'orphan']);
  assert.deepEqual(forest[0]!.children.map((node) => node.entry.name), ['new', 'old']);
  assert.deepEqual(forest[0]!.children[1]!.children.map((node) => node.entry.name), ['stacked']);
});

test('branches render as a collapsible tree with ancestors kept for filter matches', async () => {
  const win = new Window();
  installHappyDomGlobals(win);
  setLocalServerAvailable(true);
  globalThis.fetch = (async (_url, init) => {
    const args = JSON.parse(String(init?.body));
    const result = args.op === 'branchTree'
      ? { ok: true, current: 'feature', trunk: 'main', branches: [
          treeEntry('main', null),
          treeEntry('feature', 'main', { ahead: 3, behind: 2, upstream: 'origin/feature', upstreamAhead: 1, date: '2026-09-09T00:00:00Z' }),
          treeEntry('stacked', 'feature'),
          treeEntry('done', 'main', { merged: true }),
        ] }
      : { ok: true };
    return new Response(JSON.stringify(result));
  }) as typeof fetch;
  let view: SccView;
  const ctx: SccContext = {
    getCwd: () => '/tree-repo', getBranch: () => 'feature', refreshAll: async () => view.refresh(),
    refreshSection: async () => view.refresh(), goTo() {}, setBadge() {},
  };
  const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 1)); };
  const names = () => [...view.root.querySelectorAll<HTMLElement>('.scc-btree__row')].map((row) => row.dataset.branch);
  try {
    view = createBranchesView(ctx);
    document.body.append(view.root);
    await settle();
    assert.deepEqual(names(), ['main', 'feature', 'stacked', 'done']);
    const row = (name: string) => view.root.querySelector<HTMLElement>(`.scc-btree__row[data-branch="${name}"]`)!;
    assert.equal(row('main').getAttribute('aria-level'), '1');
    assert.equal(row('stacked').getAttribute('aria-level'), '3');
    assert.ok(row('feature').classList.contains('is-current'));
    assert.ok(row('done').classList.contains('is-merged'));
    assert.equal(row('feature').querySelector('.scc-btree__sync')?.textContent, '↑3↓2');
    assert.equal(row('feature').querySelector('.scc-btree__remote')?.textContent, '1 to push');
    // feature continues its parent's line past itself because `done` follows it.
    assert.equal(row('stacked').querySelectorAll('.scc-btree__guide.is-line').length, 1);
    assert.equal(row('done').querySelectorAll('.scc-btree__guide.is-last').length, 1);

    row('feature').querySelector<HTMLButtonElement>('.scc-btree__twisty')!.click();
    await settle();
    assert.deepEqual(names(), ['main', 'feature', 'done']);
    assert.equal(row('feature').getAttribute('aria-expanded'), 'false');

    const search = view.root.querySelector<HTMLInputElement>('.scc-search')!;
    search.value = 'stack';
    search.dispatchEvent(new win.Event('input') as unknown as Event);
    await settle();
    assert.deepEqual(names(), ['main', 'feature', 'stacked']);
    assert.ok(row('main').classList.contains('is-context'));
    assert.ok(!row('stacked').classList.contains('is-context'));
    view.destroy();
  } finally {
    await win.happyDOM.close();
  }
});

test('remote-only branches appear by default, support search, and omit symbolic HEAD refs', async () => {
  const win = new Window();
  installHappyDomGlobals(win);
  setLocalServerAvailable(true);
  globalThis.fetch = (async (_url, init) => {
    const args = JSON.parse(String(init?.body));
    return new Response(JSON.stringify(args.op === 'branchTree'
      ? { ok: true, branches: [] }
      : { ok: true, remote: ['remotes/origin/feature/a', 'upstream/feature/b', 'upstream/HEAD', 'remotes/origin/HEAD -> origin/main'] }));
  }) as typeof fetch;
  let badge: unknown;
  let view: SccView;
  const ctx: SccContext = {
    getCwd: () => '/remote-repo', getBranch: () => '', refreshAll: async () => view.refresh(),
    refreshSection: async () => view.refresh(), goTo() {}, setBadge: (_section, value) => { badge = value; },
  };
  try {
    view = createBranchesView(ctx);
    document.body.append(view.root);
    await view.refresh();
    assert.deepEqual(badge, { kind: 'count', value: 2 });
    assert.equal(view.root.querySelectorAll('.scc-chip--remote').length, 2);
    assert.doesNotMatch(view.root.textContent ?? '', /HEAD|No branches yet/);
    const search = view.root.querySelector<HTMLInputElement>('.scc-search')!;
    search.value = 'upstream';
    search.dispatchEvent(new win.Event('input') as unknown as Event);
    await view.refresh();
    assert.equal(view.root.querySelectorAll('.scc-refrow').length, 1);
    assert.equal(view.root.querySelector('.scc-refrow__name')?.textContent, 'upstream/feature/b');
    view.destroy();
  } finally {
    await win.happyDOM.close();
  }
});

test('branch and worktree selection confirms batches and retains failures', async () => {
  const win = new Window();
  installHappyDomGlobals(win);
  setLocalServerAvailable(true);
  const calls: Record<string, any>[] = [];
  let locals = ['main', 'feature/a', 'feature/b'];
  let view: SccView;
  let cwd: string | undefined = '/repo';
  let finishRemoval: (() => void) | undefined;
  globalThis.fetch = (async (_url, init) => {
    const args = JSON.parse(String(init?.body));
    calls.push(args);
    let result: object = { ok: true };
    if (args.op === 'branches') result = { ok: true, current: 'main', local: locals,
      remote: ['remotes/origin/feature/a', 'remotes/origin/main', 'remotes/origin/HEAD -> origin/main'] };
    if (args.op === 'branchTree') result = { ok: true, current: 'main', trunk: 'main', branches: locals.map((name) => treeEntry(name, name === 'main' ? null : 'main')) };
    if (args.op === 'deleteBranch') {
      if (args.branch === 'feature/b') result = { ok: false, error: 'not fully merged' };
      else locals = locals.filter((name) => name !== args.branch);
    }
    if (args.op === 'worktreeRemove') await new Promise<void>((resolve) => { finishRemoval = resolve; });
    if (args.op === 'list') result = { ok: true, output:
      'worktree /repo\nHEAD abc\nbranch refs/heads/main\n\nworktree /trees/a\nHEAD abc\nbranch refs/heads/a\n\nworktree /trees/b\nHEAD abc\nbranch refs/heads/b\n' };
    return new Response(JSON.stringify(result));
  }) as typeof fetch;
  const ctx: SccContext = {
    getCwd: () => cwd, getBranch: () => 'main', refreshAll: async () => view.refresh(),
    refreshSection: async () => view.refresh(), goTo() {}, setBadge() {},
  };
  const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 1)); };
  const clickButton = (label: string, root: ParentNode = view.root) => {
    const btn = [...root.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent === label);
    assert.ok(btn, label);
    btn.click();
  };
  try {
    view = createBranchesView(ctx);
    document.body.append(view.root);
    await settle();
    assert.equal(view.root.querySelectorAll('input[type="checkbox"]').length, 0);
    const branchRow = (name: string) => [...view.root.querySelectorAll<HTMLElement>('.scc-refrow')]
      .find((row) => row.querySelector('.scc-refrow__name')?.textContent === name)!;
    const clickRow = (row: HTMLElement, modifiers: MouseEventInit = {}) =>
      row.dispatchEvent(new win.MouseEvent('click', { bubbles: true, ...modifiers }) as unknown as MouseEvent);
    const selectedNames = () => [...view.root.querySelectorAll('.scc-refrow.is-selected .scc-refrow__name')]
      .map((node) => node.textContent);
    clickRow(branchRow('feature/a'));
    clickRow(branchRow('feature/b'), { shiftKey: true });
    assert.deepEqual(selectedNames(), ['feature/a', 'feature/b']);
    clickRow(branchRow('feature/a'), { ctrlKey: true });
    assert.deepEqual(selectedNames(), ['feature/b']);
    clickRow(branchRow('feature/a'), { metaKey: true });
    assert.deepEqual(selectedNames(), ['feature/a', 'feature/b']);
    clickRow(branchRow('main'));
    assert.deepEqual(selectedNames(), ['main']);
    assert.equal(view.root.querySelector<HTMLButtonElement>('.scc-list-view__bulk-delete')!.disabled, true);
    branchRow('main').dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }) as unknown as KeyboardEvent);
    assert.deepEqual(selectedNames(), []);
    branchRow('main').dispatchEvent(new win.KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true }) as unknown as KeyboardEvent);
    assert.deepEqual(selectedNames(), ['main', 'feature/a', 'feature/b', 'origin/feature/a', 'origin/main']);
    assert.equal(view.root.querySelector<HTMLButtonElement>('.scc-list-view__bulk-delete')!.textContent, 'Delete selected (3)');
    assert.equal(branchRow('origin/feature/a').querySelector('.scc-chip--remote')?.textContent, 'remote');
    clickRow(branchRow('feature/a'));
    clickRow(branchRow('origin/feature/a'), { shiftKey: true });
    assert.deepEqual(selectedNames(), ['feature/a', 'feature/b', 'origin/feature/a']);
    await view.refresh();
    clickButton('Delete selected (3)');
    await settle();
    assert.equal(calls.filter((call) => call.op.startsWith('delete')).length, 0);
    clickButton('Delete', document.querySelector('#appDialogPanel')!);
    await settle();
    assert.deepEqual(calls.filter((call) => call.op.startsWith('delete')).map((call) => [call.op, call.branch]), [
      ['deleteBranch', 'feature/a'], ['deleteBranch', 'feature/b'], ['deleteRemoteBranch', 'origin/feature/a'],
    ]);
    assert.match(document.querySelector('#appDialogPanel')!.textContent ?? '', /not fully merged/);
    clickButton('Cancel', document.querySelector('#appDialogPanel')!);
    await settle();
    assert.match(view.root.textContent ?? '', /feature\/b: Not deleted \(not fully merged\)/);
    assert.equal(branchRow('feature/b').getAttribute('aria-selected'), 'true');
    const search = view.root.querySelector<HTMLInputElement>('.scc-search')!;
    search.value = 'feature/a';
    search.dispatchEvent(new win.Event('input') as unknown as Event);
    await settle();
    assert.deepEqual(selectedNames(), []);
    view.destroy();
    cwd = '/trees/a';
    view = createWorktreesView(ctx, { onSelectWorktree: (value) => { cwd = value; } });
    document.body.append(view.root);
    await settle();
    assert.equal(view.root.querySelectorAll('input[type="checkbox"]').length, 0);
    const worktreeRows = [...view.root.querySelectorAll<HTMLElement>('.scc-refrow')];
    clickRow(worktreeRows[1]!);
    clickRow(worktreeRows[2]!, { shiftKey: true });
    clickButton('Delete selected (2)');
    await settle();
    clickButton('Cancel', document.querySelector('#appDialogPanel')!);
    await settle();
    assert.equal(calls.filter((call) => call.op === 'worktreeRemove').length, 0);
    clickButton('Delete selected (2)');
    await settle();
    clickButton('Delete', document.querySelector('#appDialogPanel')!);
    await settle();
    const progress = view.root.querySelector<HTMLElement>('.scc-list-view__progress')!;
    assert.equal(progress.hidden, false);
    // The overlay shows after GIT_ACTIVITY_SHOW_DELAY_MS; Windows timer granularity hides that on a fast settle.
    for (let i = 0; i < 40 && !document.querySelector('#mnGitActivityOverlay')?.textContent; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.match(document.querySelector('#mnGitActivityOverlay')?.textContent ?? '', /Deleting 2 worktrees/);
    assert.match(progress.textContent!, /Deleting worktrees: 1 of 2.*trees\/a/);
    assert.equal(view.root.getAttribute('aria-busy'), 'true');
    assert.equal(view.root.querySelector<HTMLButtonElement>('.scc-list-view__bulk-delete')!.disabled, true);
    clickRow(worktreeRows[0]!);
    assert.deepEqual(selectedNames(), ['a', 'b']);
    worktreeRows[2]!.querySelector<HTMLButtonElement>('[title="Remove this worktree"]')!.click();
    assert.equal(calls.filter((call) => call.op === 'worktreeRemove').length, 1);
    assert.equal(document.querySelector<HTMLElement>('#appDialogOverlay')!.hidden, true);
    finishRemoval!();
    await settle();
    assert.match(progress.textContent!, /Deleting worktrees: 2 of 2.*trees\/b/);
    finishRemoval!();
    await settle();
    assert.equal(progress.hidden, true);
    assert.equal(view.root.getAttribute('aria-busy'), 'false');
    assert.deepEqual(calls.filter((call) => call.op === 'worktreeRemove').map((call) => call.path), ['/trees/a', '/trees/b']);
    assert.equal(cwd, undefined);
    view.destroy();
  } finally {
    await win.happyDOM.close();
  }
});

test('worktree rows show uncommitted and sync counts, offer Open chat, and only a dirty refusal offers Force remove', async () => {
  const win = new Window();
  installHappyDomGlobals(win);
  setLocalServerAvailable(true);
  const { resetAppDialogForTests } = await import('../../src/ui/app-dialog.ts');
  resetAppDialogForTests();
  const { createEmptyChatObject, setSessionStateForTests } = await import('../../src/state/sessions.ts');
  const { setWorkspaceFromServer } = await import('../../src/state/workspace.ts');
  setWorkspaceFromServer({ path: '/repo', label: 'repo', isDefault: false });
  const bound = createEmptyChatObject('model', '/repo');
  bound.name = 'Login fix';
  bound.worktreeRoot = '/trees/a';
  setSessionStateForTests({ chats: [bound], activeId: bound.id });
  const calls: Record<string, any>[] = [];
  let removal: object = { ok: false, code: 'locked', error: "fatal: '/trees/a' is locked" };
  globalThis.fetch = (async (_url, init) => {
    const args = JSON.parse(String(init?.body));
    calls.push(args);
    let result: object = { ok: true };
    if (args.op === 'list') result = { ok: true, output: 'worktree /repo\nHEAD abc\nbranch refs/heads/main\n\nworktree /trees/a\nHEAD abc\nbranch refs/heads/a\n' };
    if (args.op === 'status') result = args.cwd === '/trees/a'
      ? { ok: true, branch: 'a', ahead: 2, behind: 1, unstaged: [{ path: 'x.ts', status: 'M' }], untracked: [{ path: 'y.ts', status: '?' }] }
      : { ok: true, branch: 'main' };
    if (args.op === 'worktreeRemove') result = args.force ? { ok: true } : removal;
    return new Response(JSON.stringify(result));
  }) as typeof fetch;
  let view: SccView | undefined;
  const ctx: SccContext = {
    getCwd: () => undefined, getBranch: () => 'main', refreshAll: async () => view?.refresh(),
    refreshSection: async () => view?.refresh(), goTo() {}, setBadge() {},
  };
  const settle = async () => { for (let i = 0; i < 30; i++) await new Promise((resolve) => setTimeout(resolve, 1)); };
  const dialogButton = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('#appDialogPanel button')].find((b) => b.textContent === label);
  try {
    view = createWorktreesView(ctx, { onSelectWorktree() {} });
    document.body.append(view.root);
    await settle();
    const row = [...view.root.querySelectorAll<HTMLElement>('.scc-refrow')].find((r) => r.querySelector('.scc-refrow__name')?.textContent === 'a')!;
    assert.match(row.textContent ?? '', /2 changed/);
    assert.match(row.textContent ?? '', /↑2 ↓1/);
    assert.match(row.textContent ?? '', /1 chat/);
    assert.ok([...row.querySelectorAll('button')].some((b) => b.textContent === 'Open chat'));

    row.querySelector<HTMLButtonElement>('[title="Remove this worktree"]')!.click();
    await settle();
    assert.match(document.querySelector('#appDialogPanel')?.textContent ?? '', /1 chat uses it \(Login fix\); it returns to Local/);
    dialogButton('Remove')!.click();
    await settle();
    assert.equal(dialogButton('Force remove'), undefined, 'a locked worktree is not offered --force');
    assert.equal(calls.filter((c) => c.op === 'worktreeRemove').length, 1);
    assert.equal(bound.worktreeRoot, '/trees/a', 'a failed removal leaves the chat bound');

    removal = { ok: false, code: 'dirty', error: "fatal: '/trees/a' contains modified or untracked files, use --force to delete it" };
    row.querySelector<HTMLButtonElement>('[title="Remove this worktree"]')!.click();
    await settle();
    dialogButton('Remove')!.click();
    await settle();
    dialogButton('Force remove')!.click();
    await settle();
    assert.deepEqual(calls.filter((c) => c.op === 'worktreeRemove').map((c) => Boolean(c.force)), [false, false, true]);
    assert.equal(bound.worktreeRoot, undefined, 'the removed worktree\'s chat returns to Local');
  } finally {
    view?.destroy();
    setSessionStateForTests(null as never);
    await win.happyDOM.close();
  }
});

test('missing and locked worktrees explain themselves on the row and offer the fix', async () => {
  const win = new Window();
  installHappyDomGlobals(win);
  setLocalServerAvailable(true);
  resetAppDialogForTests();
  const { setWorkspaceFromServer } = await import('../../src/state/workspace.ts');
  setWorkspaceFromServer({ path: '/repo', label: 'repo', isDefault: false });
  const calls: Record<string, any>[] = [];
  let entries = [
    { path: '/home/me/.codex/worktrees/d60f/repo', lock: 'initializing', missing: true },
    { path: '/home/me/.codex/worktrees/94d3/repo', lock: 'initializing', missing: true },
    { path: '/home/me/.codex/worktrees/1d36/repo', lock: 'initializing', missing: false },
  ];
  globalThis.fetch = (async (_url, init) => {
    const args = JSON.parse(String(init?.body));
    calls.push(args);
    let result: object = { ok: true };
    if (args.op === 'list') result = { ok: true,
      output: ['worktree /repo\nHEAD abc\nbranch refs/heads/main\n',
        ...entries.map((e) => `worktree ${e.path}\nHEAD abc\ndetached\nlocked ${e.lock}\n`)].join('\n'),
      missing: entries.filter((e) => e.missing).map((e) => e.path) };
    if (args.op === 'status') result = { ok: true, branch: '' };
    if (args.op === 'worktreeRemove') {
      const entry = entries.find((e) => e.path === args.path)!;
      if (!args.unlock) result = { ok: false, code: 'locked', lockReason: entry.lock, missing: entry.missing,
        error: `fatal: cannot remove a locked working tree, lock reason: ${entry.lock}\nuse 'remove -f -f' to override or unlock first` };
      else entries = entries.filter((e) => e !== entry);
    }
    return new Response(JSON.stringify(result));
  }) as typeof fetch;
  let view: SccView | undefined;
  const ctx: SccContext = {
    getCwd: () => undefined, getBranch: () => 'main', refreshAll: async () => view?.refresh(),
    refreshSection: async () => view?.refresh(), goTo() {}, setBadge() {},
  };
  const settle = async () => { for (let i = 0; i < 30; i++) await new Promise((resolve) => setTimeout(resolve, 1)); };
  const buttonIn = (root: ParentNode, label: string) =>
    [...root.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === label);
  const rowFor = (leaf: string) => [...view!.root.querySelectorAll<HTMLElement>('.scc-refrow')]
    .find((r) => r.textContent?.includes(`/${leaf}/`))!;
  try {
    view = createWorktreesView(ctx, { onSelectWorktree() {} });
    document.body.append(view.root);
    await settle();
    const notice = view.root.querySelector<HTMLElement>('.scc-wtnotice')!;
    assert.equal(notice.hidden, false);
    assert.match(notice.textContent ?? '', /2 worktrees point to a deleted folder \(left by Codex\)/);
    assert.match(rowFor('d60f').textContent ?? '', /Codex.*folder missing.*locked/);
    assert.equal(buttonIn(rowFor('d60f'), 'Work here'), undefined, 'nothing to work in');
    assert.equal(rowFor('1d36').querySelector('.scc-wtissue'), null, 'a live locked worktree is just labelled');

    // Bulk delete auto-unlocks the missing ones and explains the live locked one.
    for (const leaf of ['d60f', '94d3', '1d36']) {
      rowFor(leaf).dispatchEvent(new win.MouseEvent('click', { bubbles: true, ctrlKey: true }) as unknown as MouseEvent);
    }
    buttonIn(view.root, 'Delete selected (3)')!.click();
    await settle();
    buttonIn(document.querySelector('#appDialogPanel')!, 'Delete')!.click();
    await settle();
    assert.deepEqual(calls.filter((c) => c.op === 'worktreeRemove').map((c) => Boolean(c.unlock)), [true, true, false]);
    assert.equal(entries.length, 1);
    assert.equal(view.root.querySelector('.scc-error'), null, 'no wall of git output');
    assert.match(notice.textContent ?? '', /1 worktree was not removed/);
    const issue = rowFor('1d36').querySelector<HTMLElement>('.scc-wtissue--locked')!;
    assert.match(issue.textContent ?? '', /Locked by Codex \("initializing"\)/);
    assert.match(issue.querySelector('pre')?.textContent ?? '', /remove -f -f/);

    buttonIn(issue, 'Unlock and remove')!.click();
    await settle();
    buttonIn(document.querySelector('#appDialogPanel')!, 'Unlock and remove')!.click();
    await settle();
    assert.equal(calls.filter((c) => c.op === 'worktreeRemove').at(-1)?.unlock, true);
    assert.equal(entries.length, 0);
    assert.equal(notice.hidden, true);
  } finally {
    view?.destroy();
    await win.happyDOM.close();
  }
});

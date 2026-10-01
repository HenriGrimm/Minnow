import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Window } from 'happy-dom';
import { installHappyDomGlobals } from '../os/dom-helpers.mts';
import { setLocalServerAvailable } from '../../src/tools/config.ts';
import { buildBranchForest, createBranchesView, createWorktreesView } from '../../src/ui/scc-refs.ts';
import type { GitBranchTreeEntry } from '../../src/state/git-api.ts';
import type { SccContext, SccView } from '../../src/ui/scc-shared.ts';

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
    assert.deepEqual(selectedNames(), ['main', 'feature/a', 'feature/b']);
    assert.equal(view.root.querySelector<HTMLButtonElement>('.scc-list-view__bulk-delete')!.textContent, 'Delete selected (2)');
    clickButton('Remote');
    await settle();
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
    assert.match(view.root.textContent ?? '', /feature\/b: not fully merged/);
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

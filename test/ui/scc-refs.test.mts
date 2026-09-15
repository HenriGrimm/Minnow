import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Window } from 'happy-dom';
import { installHappyDomGlobals } from '../os/dom-helpers.mts';
import { setLocalServerAvailable } from '../../src/tools/config.ts';
import { createBranchesView, createWorktreesView } from '../../src/ui/scc-refs.ts';
import type { SccContext, SccView } from '../../src/ui/scc-shared.ts';

test('branch and worktree selection confirms batches and retains failures', async () => {
  const win = new Window();
  installHappyDomGlobals(win);
  setLocalServerAvailable(true);
  const calls: Record<string, any>[] = [];
  let locals = ['main', 'feature/a', 'feature/b'];
  let view: SccView;
  let cwd: string | undefined = '/repo';
  globalThis.fetch = (async (_url, init) => {
    const args = JSON.parse(String(init?.body));
    calls.push(args);
    let result: object = { ok: true };
    if (args.op === 'branches') result = { ok: true, current: 'main', local: locals,
      remote: ['remotes/origin/feature/a', 'remotes/origin/main', 'remotes/origin/HEAD -> origin/main'] };
    if (args.op === 'deleteBranch') {
      if (args.branch === 'feature/b') result = { ok: false, error: 'not fully merged' };
      else locals = locals.filter((name) => name !== args.branch);
    }
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
    assert.equal(view.root.querySelectorAll('.scc-refrow__select').length, 2);
    clickButton('Remote');
    await settle();
    assert.equal(view.root.querySelectorAll('.scc-refrow__select').length, 3);
    view.root.querySelector<HTMLInputElement>('[aria-label="Select all deletable branches"]')!.click();
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
    assert.equal(view.root.querySelector<HTMLInputElement>('[aria-label="Select Local: feature/b"]')!.checked, true);
    view.destroy();
    cwd = '/trees/a';
    view = createWorktreesView(ctx, { onSelectWorktree: (value) => { cwd = value; } });
    document.body.append(view.root);
    await settle();
    assert.equal(view.root.querySelectorAll('.scc-refrow__select').length, 2);
    view.root.querySelector<HTMLInputElement>('[aria-label="Select all deletable worktrees"]')!.click();
    clickButton('Delete selected (2)');
    await settle();
    clickButton('Cancel', document.querySelector('#appDialogPanel')!);
    await settle();
    assert.equal(calls.filter((call) => call.op === 'worktreeRemove').length, 0);
    clickButton('Delete selected (2)');
    await settle();
    clickButton('Delete', document.querySelector('#appDialogPanel')!);
    await settle();
    assert.deepEqual(calls.filter((call) => call.op === 'worktreeRemove').map((call) => call.path), ['/trees/a', '/trees/b']);
    assert.equal(cwd, undefined);
    view.destroy();
  } finally {
    await win.happyDOM.close();
  }
});

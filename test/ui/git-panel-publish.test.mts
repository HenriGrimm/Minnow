import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { Window } from 'happy-dom';

const unused = async () => ({ ok: true });
let confirmed = true;
const calls: unknown[] = [];
mock.module('../../src/state/git-api.ts', { namedExports: {
  gitBranches: unused, gitCheckout: unused, gitDiff: unused, gitDiscard: unused,
  gitPull: unused, gitStage: unused, gitStatus: unused, gitUnstage: unused,
  gitDeleteBranch: unused, gitWorktreeAdd: unused, gitWorktreeRemove: unused,
  gitLog: unused, gitShow: unused, gitMerge: unused, gitRemoteUrl: unused,
  gitStageAll: unused, gitFetch: unused, gitCheckoutDetach: unused, gitCreateTag: unused,
  gitDeleteRemoteBranch: unused, gitDiffSummary: unused, gitRebase: unused,
  gitStashList: unused, gitStashPush: unused, gitStashPop: unused, gitStashApply: unused,
  gitStashDrop: unused, gitCherryPick: unused, gitSnapshotCreate: unused,
  gitSnapshotRestore: unused, gitSnapshotDiff: unused,
  gitBranchTree: async (cwd?: string) => {
    calls.push(['inspect', cwd]);
    return { ok: true, current: 'feature', branches: [{ name: 'feature', upstream: null }] };
  },
  gitPush: async (options: unknown) => { calls.push(['push', options]); return { ok: true }; },
  gitCommit: async (options: unknown) => { calls.push(['commit', options]); return { ok: true }; },
} });
mock.module('../../src/ui/app-dialog.ts', { namedExports: {
  appAlert: unused, appPrompt: async () => null, appChoice: async () => null,
  isAppDialogOpen: () => false,
  appConfirm: async () => { calls.push(['confirm']); return confirmed; },
} });
mock.module('../../src/ui/git-ui-op.ts', { namedExports: {
  inferGitUiLabel: () => 'Git',
  runGitUiOp: async (operation: () => Promise<unknown>) => operation(),
  showGitUiFailure() {},
  inferGitUiChatKind() {}, gitUiCtx() { return {}; },
} });
mock.module('../../src/ui/file-tree.ts', { namedExports: {
  syncFileTreeToPanelWorktree: async () => {}, initFileTreeIfNeeded: unused,
  refreshFileTree: unused, invalidateFileTreeCache() {}, renderFileTree() {},
  initFileTreeCrud() {}, refreshDirectories: unused, invalidateListingCacheForDirs() {},
  expandDir: unused, collapseDir() {}, syncFileSidebarTitleFromFileTree() {},
  setFileTreeGitStatus() {}, startFileTreeGitStatusPoll() {}, stopFileTreeGitStatusPollForTests() {},
} });

let win: Window;
const originals = { window: globalThis.window, document: globalThis.document, HTMLElement: globalThis.HTMLElement };
const panel = await import('../../src/ui/git-panel.ts');
beforeEach(() => {
  win = new Window({ url: 'http://localhost/' });
  Object.assign(globalThis, { window: win, document: win.document, HTMLElement: win.HTMLElement });
  document.body.innerHTML = '<div id="fileSidebar"><div id="gitPanelRoot"></div></div>';
  calls.length = 0;
  confirmed = true;
  panel.initGitPanel();
  panel.setGitPanelCwd('/selected-worktree');
});
afterEach(async () => {
  panel.resetGitPanelForTests();
  await win.close();
  Object.assign(globalThis, originals);
});

for (const label of ['Push', 'Commit & Push']) {
  for (const accept of [true, false]) {
    test(`Code sidebar ${label} ${accept ? 'publishes after confirmation' : 'does not push after cancellation'} (MIN-26)`, async () => {
      confirmed = accept;
      document.querySelector('textarea')!.value = 'Test commit';
      const button = [...document.querySelectorAll('button')].find((entry) => entry.textContent === label)!;
      assert.ok(button);
      button.click();
      await win.happyDOM.whenAsyncComplete();
      assert.deepEqual(calls, [
        ...(label === 'Commit & Push' ? [['commit', { message: 'Test commit', cwd: '/selected-worktree' }]] : []),
        ['inspect', '/selected-worktree'], ['confirm'],
        ...(accept ? [['push', { cwd: '/selected-worktree', setUpstream: true, branch: 'feature' }]] : []),
      ]);
    });
  }
}

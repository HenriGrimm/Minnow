import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { Window } from 'happy-dom';

const unused = async () => ({ ok: true });
let confirmed = true;
const calls: unknown[] = [];
let featureWorktreeExists = true;
let workspaceBranch = 'main';
let statusResult: { ok: boolean; error?: string; unstaged?: { path: string; status: string }[] } = { ok: true };
mock.module('../../src/state/worktree-service.ts', { namedExports: {
  ensureIntegration: unused, createWorktree: unused, mergeIntoIntegration: unused,
  commitWorktree: unused, checkWorktreeDirty: unused, checkMerged: unused,
  abortMerge: unused, checkMergeInProgress: unused, restoreIntegration: unused,
  verifyIntegrationMerge: unused, refreshIntegrationDeps: unused, removeWorktree: unused,
  cleanupBoardWorktrees: unused, cleanupBoardBranches: unused, integrationStats: unused,
  workspaceLandingStats: unused, mergeIntegrationIntoWorkspace: unused,
  openWorkspacePr: unused, commitIntegration: unused, pushIntegration: unused,
  openIntegrationPr: unused, createChatWorktree: unused, removeChatWorktree: unused,
  listWorktrees: async () => ({ ok: true, output:
    `worktree /workspace\nHEAD abc\nbranch refs/heads/${workspaceBranch}\n\n` +
    (featureWorktreeExists ? 'worktree /selected-worktree\nHEAD def\nbranch refs/heads/feature\n\n' : ''),
  }),
} });
mock.module('../../src/ui/git-graph.ts', { namedExports: {
  extractLocalBranchRefs: () => [],
  renderGitGraph: () => ({ refresh: unused, destroy() {}, setSelectedCommit() {} }),
} });
mock.module('../../src/state/git-api.ts', { namedExports: {
  gitBranches: async (cwd?: string) => ({
    ok: true, current: cwd === '/selected-worktree' ? 'feature' : workspaceBranch,
    local: ['main', 'feature'], remote: [], lockedLocal: [],
  }),
  gitCheckout: async (options: unknown) => { calls.push(['checkout', options]); return { ok: true }; },
  gitDiff: unused, gitDiscard: unused,
  gitPull: unused, gitStage: unused, gitStatus: async () => structuredClone(statusResult), gitUnstage: unused,
  gitDeleteBranch: unused, gitWorktreeAdd: unused,
  gitWorktreeRemove: async (options: unknown) => {
    calls.push(['remove', options]);
    featureWorktreeExists = false;
    return { ok: true };
  },
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
const workspace = await import('../../src/state/workspace.ts');
beforeEach(() => {
  win = new Window({ url: 'http://localhost/' });
  Object.assign(globalThis, { window: win, document: win.document, HTMLElement: win.HTMLElement });
  document.body.innerHTML = '<div id="fileSidebar"><div id="gitPanelRoot"></div></div>';
  calls.length = 0;
  confirmed = true;
  featureWorktreeExists = true;
  workspaceBranch = 'main';
  statusResult = { ok: true };
  workspace.setWorkspaceFromServer({ path: '/workspace', isDefault: false, label: 'Workspace' });
  panel.initGitPanel();
  panel.setGitPanelCwd('/selected-worktree');
});
afterEach(async () => {
  panel.resetGitPanelForTests();
  workspace.resetWorkspaceStateForTests();
  await win.close();
  Object.assign(globalThis, originals);
});

test('removing the active worktree selects the workspace HEAD while retaining the removed branch', async () => {
  await panel.openGitSidePanel();
  const branch = document.getElementById('gitPanelBranchSelect') as HTMLSelectElement;
  const cwd = document.getElementById('gitPanelCwdSelect') as HTMLSelectElement;
  assert.equal(branch.value, 'feature');
  assert.equal(cwd.value, '/selected-worktree');

  (document.querySelector('[aria-label="Remove worktree"]') as HTMLButtonElement).click();
  for (let attempt = 0; attempt < 100 && branch.value !== 'main'; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  panel.closeGitSidePanel();

  assert.equal(cwd.value, '/workspace');
  assert.equal(branch.value, 'main');
  assert.ok([...branch.options].some((option) => option.value === 'feature'));
  assert.ok(calls.some((call) => Array.isArray(call) && call[0] === 'remove'));
  assert.ok(!calls.some((call) => Array.isArray(call) && call[0] === 'checkout'));
});

test('refresh follows an external checkout even when the previous branch remains available', async () => {
  panel.setGitPanelCwd(undefined);
  await panel.openGitSidePanel();
  const branch = document.getElementById('gitPanelBranchSelect') as HTMLSelectElement;
  assert.equal(branch.value, 'main');
  workspaceBranch = 'feature';
  await panel.refreshGitPanel();
  assert.equal(branch.value, 'feature');
});

test('81 unchanged files survive polling without subtree deletion or lost collapse state', async () => {
  statusResult = { ok: true, unstaged: Array.from({ length: 81 }, (_, i) => ({ path: `src/file-${i}.ts`, status: 'M' })) };
  await panel.openGitSidePanel();
  const row = document.querySelector('.git-panel-file-row')!;
  const header = document.querySelector('.git-panel-section__hdr') as HTMLButtonElement;
  header.click();
  const body = row.parentElement!;
  let removed = 0;
  const observer = new win.MutationObserver((records) => {
    removed += records.reduce((sum, record) => sum + record.removedNodes.length, 0);
  });
  observer.observe(body.parentElement!.parentElement!, { childList: true, subtree: true });
  for (let i = 0; i < 3; i++) await panel.refreshGitPanel();
  removed += observer.takeRecords().reduce((sum, record) => sum + record.removedNodes.length, 0);
  observer.disconnect();
  assert.equal(removed, 0, `unchanged polls removed ${removed} DOM nodes`);
  assert.equal(document.querySelector('.git-panel-file-row'), row);
  assert.equal(body.hidden, true);

  statusResult = { ok: false, error: 'Temporary git failure' };
  await panel.refreshGitPanel();
  statusResult = { ok: true, unstaged: [{ path: 'src/file-0.ts', status: 'D' }] };
  await panel.refreshGitPanel();
  assert.equal(document.querySelectorAll('.git-panel-file-row').length, 1);
  assert.equal(document.querySelector('.git-panel-file-badge')?.textContent, 'D');
});



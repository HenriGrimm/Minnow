import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { Window } from 'happy-dom';

const unused = async () => ({ ok: true });
let confirmed = true;
const calls: unknown[] = [];
let featureWorktreeExists = true;
let workspaceBranch = 'main';
let remoteBranches: string[] = [];
let savedChanges: { sha: string; branch: string; fileCount: number; createdAt: string }[] = [];
let statusResult: import('../../src/state/git-api.ts').GitOpResult = { ok: true };
let pullResult: import('../../src/state/git-api.ts').GitOpResult = { ok: true };
let commitResult: import('../../src/state/git-api.ts').GitOpResult = { ok: true };
mock.module('../../src/ui/git-commit-diff-panel.ts', { namedExports: {
  closeGitCommitDiffPanel() {}, getOpenGitCommitDiffSha: () => null,
  GIT_COMMIT_DIFF_CLOSED_EVENT: 'minnow:git-commit-diff-closed',
  openGitCommitDiffPanel: unused,
} });
mock.module('../../src/ui/git-file-editor.ts', { namedExports: {
  openGitFileEditor: async (options: unknown) => { calls.push(['diff', options]); return { ok: true }; },
} });
mock.module('../../src/state/worktree-service.ts', { namedExports: {
  ensureIntegration: unused, createWorktree: unused, mergeIntoIntegration: unused,
  commitWorktree: unused, checkWorktreeDirty: unused, checkMerged: unused,
  abortMerge: unused, checkMergeInProgress: unused, restoreIntegration: unused,
  verifyIntegrationMerge: unused, refreshIntegrationDeps: unused, removeWorktree: unused,
  cleanupBoardWorktrees: unused, cleanupBoardBranches: unused, integrationStats: unused,
  workspaceLandingStats: unused, mergeIntegrationIntoWorkspace: unused,
  openWorkspacePr: unused, commitIntegration: unused, pushIntegration: unused,
  openIntegrationPr: unused, createChatWorktree: unused, enableChatWorktree: unused, removeChatWorktree: unused,
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
  gitCheckoutSwitch: async (input: { branch: string; cwd?: string; dirtyHandling?: string }) => {
    calls.push(['switch', input]);
    const dirty = (statusResult.staged?.length ?? 0) + (statusResult.unstaged?.length ?? 0) + (statusResult.untracked?.length ?? 0);
    if (dirty && !input.dirtyHandling) return { ok: false, needsChoice: true, branch: workspaceBranch, fileCount: dirty };
    if (input.dirtyHandling === 'leave') {
      savedChanges.push({ sha: 'saved-main', branch: workspaceBranch, fileCount: dirty, createdAt: 'today' });
      statusResult = { ok: true };
    }
    workspaceBranch = input.branch;
    return { ok: true, branch: input.branch };
  },
  gitCheckoutSavedChanges: async () => ({ ok: true, savedChanges }),
  gitCheckoutRestoreChanges: async (input: unknown) => {
    calls.push(['restore', input]); savedChanges = [];
    statusResult = { ok: true, unstaged: [{ path: 'work.ts', status: 'M' }] };
    return { ok: true };
  },
  gitBranches: async (cwd?: string) => ({
    ok: true, current: cwd === '/selected-worktree' ? 'feature' : workspaceBranch,
    local: ['main', 'feature'], remote: remoteBranches, lockedLocal: [],
  }),
  gitCheckout: async (options: unknown) => { calls.push(['checkout', options]); return { ok: true }; },
  gitDiff: async (input: unknown) => {
    calls.push(['patch', input]);
    return { ok: true, patch: '@@ -1 +1 @@\n-old\n+new\n' };
  },
  gitDiscard: unused, gitIgnore: unused, issueWorkOperation: unused, gitWorktreeStatus: unused,
  gitPull: async () => pullResult, gitStage: unused, gitStatus: async () => structuredClone(statusResult), gitUnstage: unused,
  gitDeleteBranch: unused, gitWorktreeAdd: unused,
  gitWorktreeRemove: async (options: unknown) => {
    calls.push(['remove', options]);
    featureWorktreeExists = false;
    return { ok: true };
  },
  gitLog: async (input: unknown) => { calls.push(['log', input]); return { ok: true, commits: [] }; },
  gitShow: unused, gitMerge: unused, gitRemoteUrl: unused,
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
  gitCommit: async (options: unknown) => { calls.push(['commit', options]); return commitResult; },
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
const sessions = await import('../../src/state/sessions.ts');
beforeEach(() => {
  win = new Window({ url: 'http://localhost/' });
  Object.assign(globalThis, { window: win, document: win.document, HTMLElement: win.HTMLElement });
  document.body.innerHTML = '<div id="fileSidebar"><div id="gitPanelRoot"></div></div>';
  calls.length = 0;
  confirmed = true;
  featureWorktreeExists = true;
  workspaceBranch = 'main';
  remoteBranches = [];
  savedChanges = [];
  statusResult = { ok: true };
  pullResult = { ok: true };
  commitResult = { ok: true };
  workspace.setWorkspaceFromServer({ path: '/workspace', isDefault: false, label: 'Workspace' });
  panel.initGitPanel();
  panel.setGitPanelCwd('/selected-worktree');
});
afterEach(async () => {
  panel.resetGitPanelForTests();
  sessions.setSessionStateForTests(null);
  workspace.resetWorkspaceStateForTests();
  await win.close();
  Object.assign(globalThis, originals);
});

test('Graphite opens workspace changes from a worktree thread and loads history on demand', async () => {
  const chat = sessions.createEmptyChatObject('fixture', '/workspace');
  chat.worktreeRoot = '/selected-worktree';
  sessions.setSessionStateForTests({ version: 6, activeId: chat.id, sidebarCollapsed: false, chats: [chat] });
  statusResult = { ok: true, unstaged: [{ path: 'src/edited.ts', status: 'M' }] };
  panel.setGitSurfaceVisible(true, chat);
  await panel.openGitSurfaceTarget(chat, 'workspace');
  panel.syncPanelFromActiveChat();
  await waitForPanel(() => Boolean(document.querySelector('.git-panel-file-path')));

  assert.equal(panel.getGitPanelCwd(), '/workspace');
  assert.equal(panel.getGitPanelFileBrowseCwd(), '/selected-worktree');
  const root = document.getElementById('gitSidePanel')!;
  assert.equal(root.dataset.gitView, 'changes');
  assert.equal(root.lastElementChild?.className, 'git-panel-commit-box');
  assert.equal(calls.some(call => Array.isArray(call) && call[0] === 'log'), false);
  const filename = root.querySelector<HTMLButtonElement>('.git-panel-file-path')!;
  filename.click();
  await waitForPanel(() => Boolean(root.querySelector('.graphite-git-patch__row--addition')));
  assert.equal(filename.getAttribute('aria-expanded'), 'true');
  assert.deepEqual(calls.find(call => Array.isArray(call) && call[0] === 'patch'), [
    'patch', { path: 'src/edited.ts', cached: false, cwd: undefined },
  ]);
  filename.click();
  assert.equal(root.querySelector('.graphite-git-patch'), null);
  root.querySelector<HTMLButtonElement>('[data-git-view-choice="history"]')!.click();
  await waitForPanel(() => root.querySelector('#gitGraphMount')?.textContent === 'No commits yet');
  assert.equal(root.dataset.gitView, 'history');
  assert.deepEqual(calls.find(call => Array.isArray(call) && call[0] === 'log'), ['log', { cwd: undefined, count: 12 }]);

  await panel.openGitSurfaceTarget(chat, 'commit');
  assert.equal(root.dataset.gitView, 'changes');
  assert.equal(panel.getGitPanelCwd(), '/selected-worktree');
  await waitForPanel(() => Boolean(root.querySelector('.git-panel-file-path')));
});

test('removing the active worktree selects the workspace HEAD while retaining the removed branch', async () => {
  await panel.openGitSidePanel();
  const branch = document.getElementById('gitCheckoutTrigger') as HTMLButtonElement;

  assert.match(branch.textContent ?? '', /feature/);
  assert.equal(panel.getGitPanelCwd(), '/selected-worktree');

  branch.click();
  (document.getElementById('gitCheckoutTab-worktrees') as HTMLButtonElement).click();
  ([...document.querySelectorAll('.git-checkout__action')].find((el) => el.textContent?.startsWith('Remove current worktree')) as HTMLButtonElement).click();
  for (let attempt = 0; attempt < 100 && !branch.textContent?.includes('main'); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  panel.closeGitSidePanel();

  assert.ok(!panel.getGitPanelCwd() || panel.getGitPanelCwd() === '/workspace');
  assert.match(branch.textContent ?? '', /main/);
  branch.click();
  (document.getElementById('gitCheckoutTab-branches') as HTMLButtonElement).click();
  assert.match(document.querySelector('.git-checkout__list')?.textContent ?? '', /feature/);
  assert.ok(calls.some((call) => Array.isArray(call) && call[0] === 'remove'));
  assert.ok(!calls.some((call) => Array.isArray(call) && call[0] === 'checkout'));
});

test('refresh follows an external checkout even when the previous branch remains available', async () => {
  panel.setGitPanelCwd(undefined);
  await panel.openGitSidePanel();
  const branch = document.getElementById('gitCheckoutTrigger') as HTMLButtonElement;
  assert.match(branch.textContent ?? '', /main/);
  workspaceBranch = 'feature';
  await panel.refreshGitPanel();
  assert.match(branch.textContent ?? '', /feature/);
});

test('sidebar automatically lists remote branches and checks out their local tracking branch', async () => {
  panel.setGitPanelCwd(undefined);
  remoteBranches = ['remotes/origin/fix/remote-only', 'remotes/origin/HEAD -> origin/main'];
  await panel.openGitSidePanel();
  document.getElementById('gitCheckoutTrigger')!.click();
  const row = [...document.querySelectorAll<HTMLButtonElement>('.git-checkout__item')]
    .find((row) => row.querySelector('.git-checkout__branch')?.textContent === 'origin/fix/remote-only');
  assert.ok(row);
  assert.equal(row.querySelector('.git-checkout__tag')?.textContent, 'remote');
  assert.doesNotMatch(document.querySelector('.git-checkout__list')?.textContent ?? '', /HEAD/);
  row.click();
  await waitForPanel(() => workspaceBranch === 'fix/remote-only');
  assert.deepEqual(calls.find((call) => Array.isArray(call) && call[0] === 'switch'), ['switch', {
    branch: 'fix/remote-only', cwd: '/workspace', expectedBranch: 'main', create: true, startPoint: 'origin/fix/remote-only',
  }]);
});

test('sidebar saves changes on the source branch and offers restore after switching back', async () => {
  panel.setGitPanelCwd(undefined);
  featureWorktreeExists = false;
  statusResult = { ok: true, unstaged: [{ path: 'work.ts', status: 'M' }] };
  await panel.openGitSidePanel();
  const click = (selector: string, contains?: string) => {
    const el = [...document.querySelectorAll<HTMLButtonElement>(selector)].find((b) => !contains || b.textContent?.includes(contains));
    assert.ok(el); el.click();
  };
  const waitFor = async (condition: () => boolean) => {
    for (let i = 0; i < 100 && !condition(); i++) await new Promise((r) => setTimeout(r, 5));
    assert.ok(condition());
  };
  click('#gitCheckoutTrigger'); click('.git-checkout__item', 'feature');
  await waitFor(() => Boolean(document.querySelector('.git-checkout__choice')));
  assert.equal(workspaceBranch, 'main');
  click('.git-checkout__choice', 'Leave changes');
  await waitFor(() => workspaceBranch === 'feature' && !document.getElementById('gitCheckoutTrigger')?.hasAttribute('disabled'));
  assert.equal(savedChanges[0].branch, 'main');
  click('#gitCheckoutTrigger'); click('.git-checkout__item', 'main');
  await waitFor(() => Boolean(document.querySelector('.git-checkout__restore button')));
  click('.git-checkout__restore button');
  await waitFor(() => savedChanges.length === 0 && !document.querySelector('.git-checkout__restore'));
  assert.ok(calls.some((call) => Array.isArray(call) && call[0] === 'restore'));
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

for (const bucket of ['staged', 'unstaged', 'untracked'] as const) {
  test(`clicking a ${bucket} filename opens its diff in the viewer with the selected worktree`, async () => {
    statusResult = { ok: true, [bucket]: [{ path: 'src/example.ts', status: bucket === 'untracked' ? '?' : 'M' }] };
    await panel.openGitSidePanel();
    (document.querySelector('.git-panel-file-path') as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(calls.some((call) => Array.isArray(call) && call[0] === 'diff'));
    assert.deepEqual(calls.find((call) => Array.isArray(call) && call[0] === 'diff'), ['diff', {
      path: 'src/example.ts', staged: bucket === 'staged', cwd: '/selected-worktree',
    }]);
    assert.equal(document.querySelector('.git-panel-diff-host'), null);
    assert.equal(document.getElementById('gitPanelRoot')?.hidden, false);
  });
}



async function waitForPanel(ready: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100 && !ready(); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(ready(), 'panel action settled');
}

test('a failed pull opens recovery at the side panel and polling preserves the notice and commit draft', async () => {
  await panel.openGitSidePanel();
  const input = document.querySelector<HTMLTextAreaElement>('.git-panel-commit-input')!;
  input.value = 'Keep my commit draft';
  statusResult = { ok: true, branch: 'feature', operation: 'merge',
    conflicted: [{ path: 'src/search.ts', status: 'U' }],
    staged: [{ path: 'src/search.ts', status: 'U' }],
    unstaged: [{ path: 'src/search.ts', status: 'U' }] };
  pullResult = { ok: false, error: 'CONFLICT (content): src/search.ts' };
  [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Pull')!.click();
  await waitForPanel(() => Boolean(document.querySelector('.git-recovery-popover')));
  const popover = document.querySelector('.git-recovery-popover')!;
  assert.ok(popover);
  assert.match(popover.textContent!, /Pull paused by conflicts/);
  assert.equal(document.querySelectorAll('.git-panel-file-row').length, 1, 'unmerged path is not duplicated as staged and unstaged');
  assert.equal(document.querySelector('.git-panel-section__hdr')?.textContent, 'Merge conflicts (1)');
  assert.equal(input.value, 'Keep my commit draft');
  assert.equal([...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Commit')!.disabled, true);
  await panel.refreshGitPanel();
  assert.equal(document.querySelector('.git-recovery-popover'), popover);
  assert.equal(document.querySelector<HTMLElement>('.git-recovery-notice')!.hidden, false);
  (popover.querySelector('.git-recovery-popover__file') as HTMLButtonElement).click();
  await waitForPanel(() => calls.some(call => Array.isArray(call) && call[0] === 'diff'));
  assert.deepEqual(calls.find(call => Array.isArray(call) && call[0] === 'diff'),
    ['diff', { path: 'src/search.ts', staged: false, cwd: '/selected-worktree' }]);
  statusResult = { ok: true, branch: 'feature', operation: 'merge', conflicted: [], staged: [{ path: 'src/search.ts', status: 'M' }] };
  await panel.refreshGitPanel();
  assert.match(document.querySelector('.git-recovery-notice')!.textContent!, /ready for review/);
  assert.equal([...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Commit')!.disabled, false);
  assert.equal(input.value, 'Keep my commit draft');
  statusResult = { ok: true, branch: 'main' };
  panel.setGitPanelCwd('/workspace');
  await waitForPanel(() => document.querySelector<HTMLElement>('.git-recovery-notice')!.hidden);
  assert.equal(document.querySelector<HTMLElement>('.git-recovery-notice')!.hidden, true);
});

test('a failed commit keeps the draft and readable recovery details across polling', async () => {
  await panel.openGitSidePanel();
  commitResult = { ok: false, error: 'pre-commit hook failed: format src/search.ts' };
  const input = document.querySelector<HTMLTextAreaElement>('.git-panel-commit-input')!;
  input.value = 'Preserve this message';
  [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Commit')!.click();
  await waitForPanel(() => Boolean(document.querySelector('.git-recovery-popover')));
  assert.equal(input.value, 'Preserve this message');
  assert.match(document.querySelector('.git-recovery-popover')!.textContent!, /Git hook failed/);
  await panel.refreshGitPanel();
  assert.equal(document.querySelector<HTMLElement>('.git-recovery-notice')!.hidden, false);
  assert.match(document.querySelector('.git-recovery-notice')!.textContent!, /Git hook failed/);
});

test('sidebar range selection highlights existing rows and keeps the selected batch on right-click and refresh', async () => {
  statusResult = { ok: true, unstaged: ['a.ts', 'b.ts', 'c.ts'].map((path) => ({ path, status: 'M' })) };
  await panel.openGitSidePanel();
  const rows = [...document.querySelectorAll<HTMLElement>('.git-panel-file-row')];
  rows[0]!.querySelector<HTMLButtonElement>('.git-panel-file-path')!.click();
  rows[2]!.dispatchEvent(new win.MouseEvent('click', { bubbles: true, shiftKey: true }));
  assert.equal(document.querySelectorAll('.git-panel-file-row.is-selected').length, 3);
  assert.equal(rows[0]!.querySelectorAll('input, [role="checkbox"]').length, 0);
  assert.equal(rows[0]!.querySelectorAll('.git-panel-file-actions button').length, 3);
  await panel.refreshGitPanel();
  assert.equal(document.querySelector('.git-panel-file-row'), rows[0]);
  assert.equal(document.querySelectorAll('.git-panel-file-row.is-selected').length, 3);
  rows[1]!.dispatchEvent(new win.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  assert.match(document.querySelector('.mn-menu')?.textContent ?? '', /Discard 3 selected changes/);
  panel.closeGitSidePanel();
  assert.equal(document.querySelector('.mn-menu'), null);
});

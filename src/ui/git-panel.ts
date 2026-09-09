import { appAlert, appConfirm, appPrompt } from './app-dialog';
/**

 * Git source control view inside the file sidebar (MIN-198 P1/P3).

 */

import {

  formatWorktreeOptionLabel,

  filterUserFacingBranches,

  filterUserFacingWorktrees,

  getPrincipalWorktree,

  parseWorktreeListPorcelain,

  type ParsedWorktree,

} from '../lib/worktree-list-parse';

import {
  gitBranches,

  gitCheckout,

  gitCommit,

  gitDiff,

  gitDiscard,

  gitPull,

  gitPush,

  gitStage,

  gitStatus,

  gitUnstage,

  gitDeleteBranch,

  gitWorktreeAdd,

  gitWorktreeRemove,

  type GitFileEntry,

  type GitOpResult,

} from '../state/git-api';

import { getFilePanelState, patchFilePanelState } from '../state/file-panel';

import { renderGitGraph, type GitGraphOptions } from './git-graph';
import { iconHtml, createIcon } from './icon';

import {
  showGitGraphCommitContextMenu,
  type GitGraphContextMenuCtx,
} from './git-graph-context-menu';

import {
  applyFileSidebarVisuals,
  isMobileLayout,
  openMobileFileSidebar,
  syncFileSidebarFilesPaneButton,
} from './file-layout';

import { getActiveChat, sessionState } from '../state/sessions';

import { listWorktrees } from '../state/worktree-service';

import { getWorkspacePath } from '../state/workspace';

import {
  panelPathsEqual,
  resolvePanelBrowseCwd,
  resolvePanelWorktreeCwd,
  resolvePanelBrowseRunTargetSeed,
  normalizePanelCwdAfterWorktreeListChange,
  resolveKnownWorktreePath,
  type PanelBrowseRunTargetSeed,
} from './panel-worktree-cwd';

import { getFileTreeSidebarTitleSuffix } from './file-tree-listing-root';

import { parseUnifiedPatchToDiffLines } from './git-patch-parse';

import { renderUnifiedPromptDiff } from './prompt-diff-unified';

import {
  closeGitCommitDiffPanel,
  getOpenGitCommitDiffSha,
  GIT_COMMIT_DIFF_CLOSED_EVENT,
  openGitCommitDiffPanel,
  openGitWorkingFileDiffPanel,
} from './git-commit-diff-panel';

import { fetchGitCommitMessage } from './git-commit-message-client';

import { showToast } from './toast';
import { inferGitUiLabel, runGitUiOp, showGitUiFailure } from './git-ui-op';

import {
  closeGitPanelNamePopover,
  openGitRefNamePopover,
} from './git-panel-name-popover';
import { decorateGitSourceControlButton } from './git-source-control-icons';
import {
  isMissingGitRepositoryError,
  renderGitNoRepositoryState,
} from './git-no-repo-state';
import { isProtectedBranchName } from '../lib/git-trunk-branch';
import {
  mergeToMainButtonVisible,
  runMergeToMain,
} from './git-merge-to-main';
import {
  renderGitStatusWithSendToChat,
  type GitErrorChatContext,
  type GitErrorChatKind,
} from './git-error-to-chat';

const POLL_MS = 5000;

let panelRoot: HTMLElement | null = null;

let scrollMount: HTMLElement | null = null;

let noRepoMount: HTMLElement | null = null;

let bodyMount: HTMLElement | null = null;

let branchSelect: HTMLSelectElement | null = null;
let branchDeleteBtn: HTMLButtonElement | null = null;
let mergeToMainBtn: HTMLButtonElement | null = null;

let cwdSelect: HTMLSelectElement | null = null;
let worktreeDeleteBtn: HTMLButtonElement | null = null;

let cwdWrap: HTMLElement | null = null;

let aheadBehindEl: HTMLElement | null = null;

let commitInput: HTMLTextAreaElement | null = null;

let commitBtn: HTMLButtonElement | null = null;

let commitPushBtn: HTMLButtonElement | null = null;

let commitBusy = false;

let aiGenerateBtn: HTMLButtonElement | null = null;

let generateMessageAbort: AbortController | null = null;

let statusWrap: HTMLElement | null = null;
let statusMessageEl: HTMLElement | null = null;

let diffHost: HTMLElement | null = null;

let graphMount: HTMLElement | null = null;

let historySection: HTMLElement | null = null;

let historyBody: HTMLElement | null = null;

let pollTimer: number | undefined;

let bound = false;

let panelOpen = false;

let refreshing = false;

/** When true, run another refresh after the current one finishes. */
let refreshPending = false;

let refreshBtn: HTMLButtonElement | null = null;

/** Effective cwd for git ops; undefined means server workspace root. */
let panelCwd: string | undefined;

/** When true, manual worktree browse (dropdown / Git Center) is not overwritten by chat sync. */
let panelCwdUserOverride = false;

let knownWorktrees: ParsedWorktree[] = [];
let currentBranchName = '';
let cachedMergeBranchLists = {
  local: [] as string[],
  remote: [] as string[],
  lockedLocal: [] as string[],
};

let expandedDiffPath: string | null = null;

let expandedDiffStaged = false;

let selectedCommitSha: string | null = null;

let graphHandle: ReturnType<typeof renderGitGraph> | null = null;

const graphOptions: GitGraphOptions = {};

// ── Mount ────────────────────────────────────────────────────────────────────

function getFileSidebar(): HTMLElement | null {

  return document.getElementById('fileSidebar');

}

function getGitMount(): HTMLElement | null {

  return document.getElementById('gitPanelRoot');

}

// ── Cwd ──────────────────────────────────────────────────────────────────────

/** Clear browse override so the next chat/composer sync can drive panel cwd. */
export function clearPanelCwdUserOverride(): void {
  panelCwdUserOverride = false;
}

/** Composer run-target seed for new chats when the user manually picked a worktree in Source Control (browse override). */
export function getGitPanelNewChatRunTargetSeed(): PanelBrowseRunTargetSeed | null {
  return resolvePanelBrowseRunTargetSeed(panelCwd, panelCwdUserOverride, knownWorktrees);
}

/** Current cwd passed to git API calls (undefined → server default). */
export function getGitPanelCwd(): string | undefined {

  return panelCwd;

}

/** Set panel cwd (Git Center lightbox sync). */
export function setGitPanelCwd(cwd: string | undefined): void {
  panelCwdUserOverride = true;
  panelCwd = cwd;

  if (cwdSelect) {

    const target = cwd ?? getWorkspacePath();

    for (const opt of cwdSelect.options) {

      if (pathsEqual(opt.value, target)) {

        cwdSelect.value = opt.value;

        break;

      }

    }

    syncWorktreeDeleteButton();

  }

  if (panelOpen) {

    void refreshGitPanel();

  }

  void syncFileTreeGitPollCwd();

}

function pathsEqual(a: string, b: string): boolean {
  return panelPathsEqual(a, b);
}

// ── Branch actions ───────────────────────────────────────────────────────────

function createToolbarIconBtn(label: string, title: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'git-panel-toolbar-btn';
  btn.textContent = label;
  btn.title = title;
  btn.setAttribute('aria-label', title);
  return btn;
}

/** Circular refresh icon (matches #btnFileTreeRefresh in index.html). */
const GIT_PANEL_REFRESH_ICON = iconHtml('refresh');

/** Manual refresh from the toolbar button (status, branches, history graph). */
async function handleManualRefresh(): Promise<void> {
  if (!refreshBtn || refreshing) return;

  refreshBtn.classList.add('is-busy');
  refreshBtn.disabled = true;
  try {
    await refreshGitPanel();
    await syncFileTreeGitPollCwd(true);
  } finally {
    refreshBtn.classList.remove('is-busy');
    refreshBtn.disabled = false;
  }
}

function isMainWorktreePath(worktreePath: string): boolean {
  const ws = getWorkspacePath().trim();
  return Boolean(ws && pathsEqual(worktreePath, ws));
}

function syncBranchDeleteButton(): void {
  if (!branchDeleteBtn || !branchSelect) return;
  const selected = branchSelect.value.trim();
  branchDeleteBtn.disabled = !selected || isProtectedBranchName(selected);
}

function syncWorktreeDeleteButton(): void {
  if (!worktreeDeleteBtn || !cwdSelect) return;
  const selected = cwdSelect.value;
  const canDelete = Boolean(selected && !isMainWorktreePath(selected));
  worktreeDeleteBtn.disabled = !canDelete;
  syncMergeToMainButton();
}

function syncMergeToMainButton(
  localBranches?: string[],
  remoteBranches?: string[],
  lockedLocalBranches?: string[],
): void {
  if (!mergeToMainBtn) return;

  if (localBranches) {
    cachedMergeBranchLists = {
      local: localBranches,
      remote: remoteBranches ?? [],
      lockedLocal: lockedLocalBranches ?? [],
    };
  }

  const lists = localBranches
    ? {
        local: localBranches,
        remote: remoteBranches ?? [],
        lockedLocal: lockedLocalBranches ?? [],
      }
    : cachedMergeBranchLists;

  const ws = getWorkspacePath().trim();
  const panelPath = panelCwd ?? ws;
  const sourceBranch = currentBranchName || branchSelect?.value || '';
  const visible = mergeToMainButtonVisible({
    sourceBranch,
    mainWorkspaceCwd: ws,
    onMainWorktree: Boolean(ws && pathsEqual(panelPath, ws)),
    localBranches: lists.local,
    remoteBranches: lists.remote,
    lockedLocalBranches: lists.lockedLocal,
  });

  mergeToMainBtn.hidden = !visible;
  mergeToMainBtn.disabled = !visible;
}

function openAddBranchPopover(anchor: HTMLButtonElement): void {
  const cwd = getEffectiveCwdArg();
  openGitRefNamePopover({
    anchor,
    title: 'New branch',
    kind: 'branch',
    cwd,
    defaultPath: cwd || getWorkspacePath(),
    reserved: [currentBranchName, 'main', 'master'],
    onSubmit: async (result) => {
      await runGitOp(
        () =>
          gitCheckout({
            branch: result.name,
            create: true,
            startPoint: result.startPoint,
            cwd,
          }),
        { successMessage: `Created branch ${result.name}` },
      );
    },
  });
}

async function deleteBranchByName(name: string): Promise<void> {
  const branch = name.trim();
  if (!branch || isProtectedBranchName(branch)) return;

  const cwd = getEffectiveCwdArg();

  if (branch === currentBranchName) {
    const { resolveTrunkBranchName } = await import('../lib/git-trunk-branch');
    const trunk = resolveTrunkBranchName(
      cachedMergeBranchLists.local,
      cachedMergeBranchLists.remote,
      cachedMergeBranchLists.lockedLocal,
    );
    if (!trunk || trunk === branch) {
      showToast('Cannot delete the checked-out branch', 'error');
      return;
    }
    if (!await appConfirm(`Switch to "${trunk}" and delete "${branch}"?`)) return;
    const switched = await runGitOp(() => gitCheckout({ branch: trunk, cwd }), {
      successMessage: `Switched to ${trunk}`,
    });
    if (!switched) return;
  } else if (!await appConfirm(`Delete branch "${branch}"?`)) {
    return;
  }

  const ok = await runGitOp(() => gitDeleteBranch({ branch, cwd }), {
    successMessage: `Deleted branch ${branch}`,
  });
  if (ok) return;

  if (!await appConfirm(`Branch "${branch}" is not fully merged. Force delete?`)) return;
  await runGitOp(() => gitDeleteBranch({ branch, force: true, cwd }), {
    successMessage: `Deleted branch ${branch}`,
  });
}

async function handleDeleteBranch(): Promise<void> {
  if (!branchSelect) return;
  await deleteBranchByName(branchSelect.value);
}

function openAddWorktreePopover(anchor: HTMLButtonElement): void {
  const cwd = getEffectiveCwdArg();
  openGitRefNamePopover({
    anchor,
    title: 'Add worktree',
    kind: 'worktree',
    cwd,
    defaultPath: cwd || getWorkspacePath(),
    reserved: [currentBranchName, 'main', 'master'],
    onSubmit: async (result) => {
      const addResult = await runGitUiOp(
        () =>
          gitWorktreeAdd({
            branch: result.name,
            baseRef: result.checkoutExisting ? undefined : result.startPoint,
            checkoutExisting: result.checkoutExisting,
            cwd,
          }),
        {
          label: 'Adding worktree…',
          successMessage: `Worktree ${result.name} added`,
          ctx: gitErrorChatContext(),
        },
      );
      if (!addResult.ok) {
        const error = addResult.error ?? 'Could not add worktree';
        setStatus(error, true);
        return;
      }

      setStatus('');
      if (addResult.path) {
        panelCwd = addResult.path;
      }
      await refreshGitPanel();
      void syncFileTreeGitPollCwd();
    },
  });
}

async function handleMergeToMain(): Promise<void> {
  const ws = getWorkspacePath().trim();
  if (!ws) {
    setStatus('No workspace open', true);
    return;
  }

  const branchResult = await gitBranches(getEffectiveCwdArg());
  const localBranches = branchResult.ok ? (branchResult.local ?? []) : [];
  const remoteBranches = branchResult.ok ? (branchResult.remote ?? []) : [];
  const lockedLocalBranches = branchResult.ok ? (branchResult.lockedLocal ?? []) : [];
  const sourceBranch = currentBranchName || branchSelect?.value || '';
  const panelPath = panelCwd ?? ws;

  const ctx = {
    sourceBranch,
    mainWorkspaceCwd: ws,
    onMainWorktree: pathsEqual(panelPath, ws),
    localBranches,
    remoteBranches,
    lockedLocalBranches,
  };

  if (!mergeToMainButtonVisible(ctx)) return;

  const { resolveTrunkBranchName } = await import('../lib/git-trunk-branch');
  const trunk = resolveTrunkBranchName(localBranches, remoteBranches, lockedLocalBranches);
  if (!await appConfirm(`Merge branch "${sourceBranch}" into ${trunk}?`)) return;

  setStatus('Merging…');
  const result = await runGitUiOp(() => runMergeToMain(ctx), {
    label: 'Merging…',
    successMessage: `Merged ${sourceBranch} into ${trunk}`,
    chatKind: 'merge',
    ctx: gitErrorChatContext(),
  });
  if (!result.ok) {
    if (result.error === 'cancelled') {
      setStatus('');
      return;
    }
    const error = result.error ?? 'Merge failed';
    setStatus(error, true, result.conflict || /merge/i.test(error) ? 'merge' : undefined);
    return;
  }

  setStatus('');
  panelCwd = undefined;
  panelCwdUserOverride = true;
  await refreshGitPanel();
  void syncFileTreeGitPollCwd();
}

async function handleDeleteWorktree(): Promise<void> {
  if (!cwdSelect) return;
  const targetPath = cwdSelect.value;
  if (!targetPath || isMainWorktreePath(targetPath)) return;
  if (!await appConfirm(`Remove worktree at ${targetPath}?`)) return;

  const removeCwd = getEffectiveCwdArg();
  const ws = getWorkspacePath().trim();
  panelCwd = ws || undefined;

  const ok = await runGitOp(() => gitWorktreeRemove({ path: targetPath, cwd: removeCwd }), {
    successMessage: 'Worktree removed',
  });
  if (ok) return;

  if (!await appConfirm('Worktree has uncommitted changes. Force remove?')) return;
  await runGitOp(
    () => gitWorktreeRemove({ path: targetPath, force: true, cwd: removeCwd }),
    { successMessage: 'Worktree removed' },
  );
}

// ── Commit chrome ────────────────────────────────────────────────────────────

function gitErrorChatContext(): GitErrorChatContext {
  return {
    cwd: (getEffectiveCwdArg() ?? getWorkspacePath().trim()) || undefined,
    branch: currentBranchName || branchSelect?.value || undefined,
  };
}

function setStatus(
  message: string,
  isError = false,
  sendToChat?: GitErrorChatKind,
): void {
  if (!statusWrap || !statusMessageEl) return;
  renderGitStatusWithSendToChat(
    statusWrap,
    statusMessageEl,
    message,
    isError,
    sendToChat,
    gitErrorChatContext(),
  );
}

type CommitActionKind = 'commit' | 'commit-push';

function setCommitButtonBusy(btn: HTMLButtonElement, label: string): void {

  btn.disabled = true;

  btn.classList.add('is-busy');

  btn.setAttribute('aria-busy', 'true');

  btn.innerHTML =
    '<span class="git-panel-action-spinner" aria-hidden="true"></span>' +
    `<span class="git-panel-action-label">${label}</span>`;

}

function setCommitActionsBusy(active: CommitActionKind, progressLabel: string): void {

  commitBusy = true;

  setStatus(progressLabel);

  if (commitInput) commitInput.disabled = true;

  if (aiGenerateBtn) aiGenerateBtn.disabled = true;

  const activeBtn = active === 'commit-push' ? commitPushBtn : commitBtn;

  const idleBtn = active === 'commit-push' ? commitBtn : commitPushBtn;

  if (activeBtn) setCommitButtonBusy(activeBtn, progressLabel);

  if (idleBtn) idleBtn.disabled = true;

}

function clearCommitActionsBusy(): void {

  commitBusy = false;

  if (commitInput) commitInput.disabled = false;

  if (aiGenerateBtn) {

    aiGenerateBtn.disabled = false;

    aiGenerateBtn.removeAttribute('aria-busy');

  }

  if (commitBtn) {

    commitBtn.classList.remove('is-busy');

    commitBtn.removeAttribute('aria-busy');

    commitBtn.disabled = false;

    commitBtn.textContent = 'Commit';

  }

  if (commitPushBtn) {

    commitPushBtn.classList.remove('is-busy');

    commitPushBtn.removeAttribute('aria-busy');

    commitPushBtn.disabled = false;

    commitPushBtn.textContent = 'Commit & Push';

  }

}

function getEffectiveCwdArg(): string | undefined {
  return resolvePanelWorktreeCwd(panelCwd);
}

function syncSidebarChrome(): void {
  const sidebar = getFileSidebar();
  const filesView = document.getElementById('fileSidebarFilesView');
  const gitMount = getGitMount();
  const title = document.getElementById('fileSidebarTitle');
  const open = isGitSidePanelOpen();

  sidebar?.classList.toggle('file-sidebar--git', open);
  sidebar?.setAttribute('aria-label', open ? 'Source control' : 'Project files');

  if (filesView) {
    filesView.toggleAttribute('hidden', open);
  }
  if (gitMount) {
    gitMount.toggleAttribute('hidden', !open);
  }
  if (title) {
    title.textContent = open ? 'Source Control' : `Files${getFileTreeSidebarTitleSuffix()}`;
  }

  syncToggleButtonState();
}

// ── Panel DOM ────────────────────────────────────────────────────────────────

function ensurePanelDom(): HTMLElement {

  const mount = getGitMount();

  if (panelRoot?.isConnected && mount?.contains(panelRoot)) return panelRoot;

  panelRoot = document.createElement('div');

  panelRoot.id = 'gitSidePanel';

  panelRoot.className = 'git-panel-root__inner';

  panelRoot.setAttribute('role', 'region');

  panelRoot.setAttribute('aria-label', 'Source control');

  const toolbar = document.createElement('div');

  toolbar.className = 'git-panel-toolbar';

  const centerRow = document.createElement('div');

  centerRow.className = 'git-panel-center-row';

  const helpBtn = document.createElement('button');

  helpBtn.type = 'button';

  helpBtn.id = 'btnGitHelp';

  helpBtn.className = 'git-panel-help-btn icon-btn';

  helpBtn.title = 'How worktrees and branches work';

  helpBtn.setAttribute('aria-label', 'How worktrees and branches work');

  helpBtn.innerHTML = iconHtml('help');

  refreshBtn = document.createElement('button');
  refreshBtn.type = 'button';
  refreshBtn.id = 'btnGitPanelRefresh';
  refreshBtn.className = 'git-panel-help-btn icon-btn';
  refreshBtn.title = 'Refresh';
  refreshBtn.setAttribute('aria-label', 'Refresh source control');
  refreshBtn.innerHTML = GIT_PANEL_REFRESH_ICON;
  refreshBtn.addEventListener('click', () => void handleManualRefresh());

  const toolbarStart = document.createElement('div');
  toolbarStart.className = 'git-panel-center-row__start';
  toolbarStart.append(helpBtn, refreshBtn);

  const centerBtn = document.createElement('button');

  centerBtn.type = 'button';

  centerBtn.id = 'btnGitCenter';

  centerBtn.className = 'git-panel-center-btn';

  centerBtn.textContent = 'Open full view';

  centerBtn.title = 'Open the Source Control Center';

  centerBtn.setAttribute('aria-label', 'Open the Source Control Center');

  centerBtn.setAttribute('aria-pressed', 'false');

  centerRow.append(toolbarStart, centerBtn);

  toolbar.appendChild(centerRow);

  cwdWrap = document.createElement('div');

  cwdWrap.className = 'git-panel-cwd-wrap';

  cwdWrap.hidden = true;

  const cwdLabel = document.createElement('label');

  cwdLabel.className = 'git-panel-cwd-label';

  cwdLabel.textContent = 'Worktree';

  cwdLabel.htmlFor = 'gitPanelCwdSelect';

  const cwdFieldRow = document.createElement('div');

  cwdFieldRow.className = 'git-panel-field-row';

  cwdSelect = document.createElement('select');

  cwdSelect.id = 'gitPanelCwdSelect';

  cwdSelect.className = 'git-panel-cwd-select';

  cwdSelect.title = 'Git worktree root';

  cwdSelect.addEventListener('change', () => {
    const value = cwdSelect?.value ?? '';
    panelCwdUserOverride = true;
    const ws = getWorkspacePath().trim();
    panelCwd = value && !pathsEqual(value, ws) ? value : undefined;

    syncWorktreeDeleteButton();

    void refreshGitPanel();

    void syncFileTreeGitPollCwd();

  });

  const worktreeAddBtn = createToolbarIconBtn('+', 'Add worktree');

  worktreeAddBtn.addEventListener('click', () => openAddWorktreePopover(worktreeAddBtn));

  worktreeDeleteBtn = createToolbarIconBtn('−', 'Remove worktree');

  worktreeDeleteBtn.disabled = true;

  worktreeDeleteBtn.addEventListener('click', () => void handleDeleteWorktree());

  cwdFieldRow.append(cwdSelect, worktreeAddBtn, worktreeDeleteBtn);

  cwdWrap.append(cwdLabel, cwdFieldRow);

  const branchWrap = document.createElement('div');

  branchWrap.className = 'git-panel-branch-wrap';

  const branchLabel = document.createElement('label');

  branchLabel.className = 'git-panel-cwd-label';

  branchLabel.textContent = 'Branch';

  branchLabel.htmlFor = 'gitPanelBranchSelect';

  const branchFieldRow = document.createElement('div');

  branchFieldRow.className = 'git-panel-field-row';

  branchSelect = document.createElement('select');

  branchSelect.id = 'gitPanelBranchSelect';

  branchSelect.className = 'git-panel-branch-select';

  branchSelect.title = 'Current branch';

  branchSelect.addEventListener('change', () => {
    syncBranchDeleteButton();
    void handleBranchChange();
  });

  const branchAddBtn = createToolbarIconBtn('+', 'New branch');

  branchAddBtn.addEventListener('click', () => openAddBranchPopover(branchAddBtn));

  branchDeleteBtn = createToolbarIconBtn('−', 'Delete branch');

  branchDeleteBtn.disabled = true;

  branchDeleteBtn.addEventListener('click', () => void handleDeleteBranch());

  branchFieldRow.append(branchSelect, branchAddBtn, branchDeleteBtn);

  branchWrap.append(branchLabel, branchFieldRow);

  const branchRow = document.createElement('div');

  branchRow.className = 'git-panel-sync-row';

  aheadBehindEl = document.createElement('span');

  aheadBehindEl.className = 'git-panel-ahead-behind';

  const pullBtn = document.createElement('button');

  pullBtn.type = 'button';

  pullBtn.className = 'git-panel-action-btn';

  decorateGitSourceControlButton(pullBtn, 'Pull');

  pullBtn.addEventListener('click', () =>
    void runGitOp(() => gitPull(getEffectiveCwdArg()), { successMessage: 'Pulled changes' }),
  );

  const pushBtn = document.createElement('button');

  pushBtn.type = 'button';

  pushBtn.className = 'git-panel-action-btn';

  decorateGitSourceControlButton(pushBtn, 'Push');

  pushBtn.addEventListener('click', () =>
    void runGitOp(() => gitPush({ cwd: getEffectiveCwdArg() }), { successMessage: 'Pushed changes' }),
  );

  mergeToMainBtn = document.createElement('button');
  mergeToMainBtn.type = 'button';
  mergeToMainBtn.className = 'git-panel-action-btn git-panel-action-btn--merge-main';
  mergeToMainBtn.hidden = true;
  decorateGitSourceControlButton(mergeToMainBtn, 'Merge to main');
  mergeToMainBtn.addEventListener('click', () => void handleMergeToMain());

  branchRow.append(aheadBehindEl, pullBtn, pushBtn, mergeToMainBtn);

  toolbar.append(cwdWrap, branchWrap, branchRow);

  scrollMount = document.createElement('div');

  scrollMount.className = 'git-panel-scroll';

  statusWrap = document.createElement('div');
  statusWrap.className = 'git-panel-status-wrap';
  statusWrap.setAttribute('role', 'status');
  statusWrap.setAttribute('aria-live', 'polite');
  statusWrap.hidden = true;

  statusMessageEl = document.createElement('p');
  statusMessageEl.className = 'git-panel-status';
  statusWrap.appendChild(statusMessageEl);

  noRepoMount = document.createElement('div');

  noRepoMount.className = 'git-panel-no-repo-mount';

  noRepoMount.hidden = true;

  const commitBox = document.createElement('div');

  commitBox.className = 'git-panel-commit-box';

  commitInput = document.createElement('textarea');

  commitInput.className = 'git-panel-commit-input';

  commitInput.placeholder = 'Commit message';

  commitInput.rows = 3;

  commitInput.addEventListener('keydown', (e) => {

    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {

      e.preventDefault();

      void handleCommit(false);

    }

  });

  const commitActions = document.createElement('div');

  commitActions.className = 'git-panel-commit-actions';

  aiGenerateBtn = document.createElement('button');

  aiGenerateBtn.type = 'button';

  aiGenerateBtn.className = 'git-panel-action-btn git-panel-action-btn--ai git-panel-action-btn--icon';

  aiGenerateBtn.title = 'Generate commit message with AI';

  aiGenerateBtn.setAttribute('aria-label', 'Generate commit message with AI');

  aiGenerateBtn.append(createIcon('sparkles', { className: 'icon-svg git-panel-action-btn__icon', size: 12 }));

  aiGenerateBtn.addEventListener('click', () => void handleGenerateCommitMessage());

  commitBtn = document.createElement('button');

  commitBtn.type = 'button';

  commitBtn.className = 'git-panel-action-btn git-panel-action-btn--primary';

  commitBtn.textContent = 'Commit';

  commitBtn.addEventListener('click', () => void handleCommit(false));

  commitPushBtn = document.createElement('button');

  commitPushBtn.type = 'button';

  commitPushBtn.className = 'git-panel-action-btn';

  commitPushBtn.textContent = 'Commit & Push';

  commitPushBtn.addEventListener('click', () => void handleCommit(true));

  commitActions.append(commitBtn, commitPushBtn, aiGenerateBtn);

  commitBox.append(commitInput, commitActions);

  bodyMount = document.createElement('div');

  bodyMount.className = 'git-panel-sections';

  diffHost = document.createElement('div');

  diffHost.className = 'git-panel-diff-host';

  diffHost.hidden = true;

  historySection = document.createElement('section');

  historySection.className = 'git-panel-section git-panel-section--history';

  const historyHdr = document.createElement('button');

  historyHdr.type = 'button';

  historyHdr.className = 'git-panel-section__hdr';

  historyHdr.setAttribute('aria-expanded', 'true');

  const historyTitle = document.createElement('span');

  historyTitle.textContent = 'History';

  historyHdr.appendChild(historyTitle);

  historyBody = document.createElement('div');

  historyBody.className = 'git-panel-section__body git-panel-section__body--history';

  graphMount = document.createElement('div');

  graphMount.id = 'gitGraphMount';

  graphMount.className = 'git-panel-graph-mount';

  historyBody.appendChild(graphMount);

  historyHdr.addEventListener('click', () => {

    const open = historyHdr.getAttribute('aria-expanded') === 'true';

    historyHdr.setAttribute('aria-expanded', open ? 'false' : 'true');

    historyBody!.hidden = open;

  });

  historySection.append(historyHdr, historyBody);

  scrollMount.append(statusWrap, noRepoMount, commitBox, bodyMount, diffHost, historySection);

  panelRoot.append(toolbar, scrollMount);

  mount?.replaceChildren(panelRoot);

  return panelRoot;

}

async function syncFileTreeGitPollCwd(force?: boolean): Promise<void> {
  const { syncFileTreeToPanelWorktree } = await import('./file-tree');
  await syncFileTreeToPanelWorktree(panelCwd, { force });
}

async function handleBranchChange(): Promise<void> {
  if (!branchSelect) return;

  const value = branchSelect.value.trim();
  if (!value || value === currentBranchName) return;

  const ok = await runGitOp(() => gitCheckout({ branch: value, cwd: getEffectiveCwdArg() }), {
    successMessage: `Switched to ${value}`,
  });

  if (!ok && branchSelect && currentBranchName) {
    branchSelect.value = currentBranchName;
    syncBranchDeleteButton();
  }
}

// ── Commit ───────────────────────────────────────────────────────────────────

async function handleGenerateCommitMessage(): Promise<void> {

  if (!commitInput) return;

  generateMessageAbort?.abort();

  const controller = new AbortController();

  generateMessageAbort = controller;

  if (aiGenerateBtn) {

    aiGenerateBtn.disabled = true;

    aiGenerateBtn.setAttribute('aria-busy', 'true');

  }

  try {

    const cwd = getEffectiveCwdArg();

    const status = await gitStatus(cwd);

    if (!status.ok) {

      setStatus(status.error ?? 'Could not read git status', true);

      return;

    }

    const staged = status.staged ?? [];
    const unstaged = status.unstaged ?? [];
    const untracked = status.untracked ?? [];
    const allChanges = [...staged, ...unstaged, ...untracked];

    if (allChanges.length === 0) {
      setStatus('No changes to commit', true);
      return;
    }

    const useStagedOnly = staged.length > 0;
    const diffResult = useStagedOnly
      ? await gitDiff({ cached: true, cwd })
      : await gitDiff({ workingTree: true, cwd });

    if (!diffResult.ok || !diffResult.patch?.trim()) {
      setStatus(diffResult.error ?? 'Could not read diff', true);
      return;
    }

    const changedPaths = useStagedOnly
      ? staged.map((file) => file.path)
      : allChanges.map((file) => file.path);
    const excludedPaths = useStagedOnly
      ? [...unstaged, ...untracked].map((file) => file.path)
      : [];

    setStatus('Generating commit message…');

    const result = await fetchGitCommitMessage({
      changedPaths,
      excludedPaths,
      scope: useStagedOnly ? 'staged' : 'working-tree',
      patch: diffResult.patch,
      signal: controller.signal,
      onPartial: (text) => {
        commitInput!.value = text;
      },
    });

    if (controller.signal.aborted) return;

    if (result.error) {

      setStatus(result.error, true);

      return;

    }

    if (result.text) {

      commitInput.value = result.text;

      commitInput.focus();

      setStatus('');

      showToast('Commit message generated', 'success');

      return;

    }

    setStatus('No commit message generated', true);

  } finally {

    if (generateMessageAbort === controller) {

      generateMessageAbort = null;

    }

    if (aiGenerateBtn) {

      aiGenerateBtn.disabled = false;

      aiGenerateBtn.removeAttribute('aria-busy');

    }

  }

}

async function handleCommit(andPush: boolean): Promise<void> {

  if (commitBusy) return;

  const message = commitInput?.value.trim() ?? '';

  if (!message) {

    setStatus('Enter a commit message', true);

    return;

  }

  const cwd = getEffectiveCwdArg();

  const action: CommitActionKind = andPush ? 'commit-push' : 'commit';

  setCommitActionsBusy(action, 'Committing…');

  try {

    const ok = await runGitOp(() => gitCommit({ message, cwd }), {
      successMessage: andPush ? undefined : 'Committed changes',
      sendToChat: 'commit',
    });

    if (!ok) return;

    if (commitInput) commitInput.value = '';

    if (andPush) {

      setCommitActionsBusy(action, 'Pushing…');

      await runGitOp(() => gitPush({ cwd }), {
        successMessage: 'Committed and pushed',
        sendToChat: 'push',
        label: 'Pushing…',
      });

    }

  } finally {

    clearCommitActionsBusy();

  }

}

type RunGitOpOptions = {
  successMessage?: string;
  /** When set, failed ops show a Send to chat action beside the error. */
  sendToChat?: GitErrorChatKind;
  label?: string;
};

async function runGitOp(
  fn: () => Promise<GitOpResult>,
  options?: RunGitOpOptions,
): Promise<boolean> {
  const result = await runGitUiOp(fn, {
    label: options?.label ?? inferGitUiLabel(options?.successMessage, options?.sendToChat),
    successMessage: options?.successMessage,
    chatKind: options?.sendToChat,
    ctx: gitErrorChatContext(),
  });
  if (!result.ok) {
    const error = result.error ?? 'Git operation failed';
    setStatus(error, true, options?.sendToChat ?? 'generic');
    return false;
  }

  setStatus('');
  await refreshGitPanel();
  void syncFileTreeGitPollCwd();
  return true;
}

// ── File list ────────────────────────────────────────────────────────────────

function statusBadgeLetter(status: string): string {

  if (status === '?') return '?';

  if (status === 'A' || status === 'M' || status === 'D' || status === 'R' || status === 'C') {

    return status;

  }

  return status.slice(0, 1).toUpperCase() || 'M';

}

function buildFileRow(entry: GitFileEntry, staged: boolean): HTMLElement {

  const row = document.createElement('div');

  row.className = 'git-panel-file-row';

  const badge = document.createElement('span');

  badge.className = `git-panel-file-badge git-panel-file-badge--${entry.status === '?' ? 'untracked' : 'modified'}`;

  badge.textContent = statusBadgeLetter(entry.status);

  const path = document.createElement('button');

  path.type = 'button';

  path.className = 'git-panel-file-path';

  path.textContent = entry.path;

  path.title = entry.path;

  path.addEventListener('click', () => void showFileDiff(entry.path, staged));

  const actions = document.createElement('div');

  actions.className = 'git-panel-file-actions';

  const diffBtn = document.createElement('button');

  diffBtn.type = 'button';

  diffBtn.className = 'git-panel-file-btn';

  diffBtn.textContent = '↔';

  diffBtn.title = 'Open diff';

  diffBtn.addEventListener('click', () => void openFileDiffInViewer(entry.path, staged));

  const stageBtn = document.createElement('button');

  stageBtn.type = 'button';

  stageBtn.className = 'git-panel-file-btn';

  stageBtn.textContent = staged ? '−' : '+';

  stageBtn.title = staged ? 'Unstage' : 'Stage';

  stageBtn.addEventListener('click', () => {

    void runGitOp(

      () =>

        staged

          ? gitUnstage({ paths: [entry.path], cwd: getEffectiveCwdArg() })

          : gitStage({ paths: [entry.path], cwd: getEffectiveCwdArg() }),

      {

        successMessage: staged ? `Unstaged ${entry.path}` : `Staged ${entry.path}`,

      },

    );

  });

  const discardBtn = document.createElement('button');

  discardBtn.type = 'button';

  discardBtn.className = 'git-panel-file-btn git-panel-file-btn--danger';

  discardBtn.textContent = '↩';

  discardBtn.title = 'Discard changes';

  discardBtn.addEventListener('click', () => {
    void (async () => {
      if (!await appConfirm(`Discard changes to ${entry.path}?`)) return;
      await runGitOp(() => gitDiscard({ paths: [entry.path], cwd: getEffectiveCwdArg() }), {
        successMessage: `Discarded changes to ${entry.path}`,
      });
    })();
  });

  actions.append(diffBtn, stageBtn, discardBtn);

  row.append(badge, path, actions);

  return row;

}

function buildSection(

  title: string,

  files: GitFileEntry[],

  staged: boolean,

  bulkAction?: { label: string; fn: () => Promise<GitOpResult>; successMessage?: string },

): HTMLElement {

  const section = document.createElement('section');

  section.className = 'git-panel-section';

  const hdr = document.createElement('button');

  hdr.type = 'button';

  hdr.className = 'git-panel-section__hdr';

  hdr.setAttribute('aria-expanded', 'true');

  const hdrTitle = document.createElement('span');

  hdrTitle.textContent = `${title} (${files.length})`;

  hdr.appendChild(hdrTitle);

  if (bulkAction && files.length > 0) {

    const bulk = document.createElement('span');

    bulk.className = 'git-panel-section__bulk';

    bulk.textContent = bulkAction.label;

    bulk.addEventListener('click', (e) => {

      e.stopPropagation();

      void runGitOp(bulkAction.fn, { successMessage: bulkAction.successMessage });

    });

    hdr.appendChild(bulk);

  }

  const body = document.createElement('div');

  body.className = 'git-panel-section__body';

  for (const file of files) {

    body.appendChild(buildFileRow(file, staged));

  }

  hdr.addEventListener('click', () => {

    const open = hdr.getAttribute('aria-expanded') === 'true';

    hdr.setAttribute('aria-expanded', open ? 'false' : 'true');

    body.hidden = open;

  });

  section.append(hdr, body);

  return section;

}

// ── Graph ────────────────────────────────────────────────────────────────────

function syncGraphSelectedCommit(): void {
  graphOptions.selectedSha = selectedCommitSha;
  void graphHandle?.refresh();
}

function ensureGitGraph(): void {

  if (!graphMount || graphHandle) return;

  graphOptions.onSelectCommit = (sha) => void showCommitDiff(sha);

  graphOptions.onContextMenu = (visual, event) => {
    void showGitGraphCommitContextMenu(visual, event, buildGraphContextMenuCtx());
  };

  graphHandle = renderGitGraph(graphMount, graphOptions);

}

function buildGraphContextMenuCtx(): GitGraphContextMenuCtx {
  return {
    cwd: getEffectiveCwdArg(),
    onOpenChanges: (sha) => void showCommitDiff(sha),
    onRefresh: () => refreshGitPanel(),
    getCurrentBranch: () => currentBranchName,
        onConflict: (message) =>
          showGitUiFailure(message, { chatKind: 'merge', ctx: gitErrorChatContext() }),
  };
}

async function showCommitDiff(sha: string): Promise<void> {

  if (selectedCommitSha === sha && getOpenGitCommitDiffSha() === sha) {

    selectedCommitSha = null;

    closeGitCommitDiffPanel();

    syncGraphSelectedCommit();

    return;

  }

  const opened = await openGitCommitDiffPanel({ sha, cwd: getEffectiveCwdArg() });

  if (!opened.ok) {

    if ('cancelled' in opened && opened.cancelled) return;

    const message = 'error' in opened ? opened.error : 'Could not load commit';

    setStatus(message ?? 'Could not load commit', true);

    return;

  }

  expandedDiffPath = null;

  selectedCommitSha = sha;

  if (diffHost) {

    diffHost.hidden = true;

    diffHost.replaceChildren();

  }

  syncGraphSelectedCommit();

}

async function openFileDiffInViewer(path: string, staged: boolean): Promise<void> {
  selectedCommitSha = null;
  syncGraphSelectedCommit();

  const opened = await openGitWorkingFileDiffPanel({
    path,
    staged,
    cwd: getEffectiveCwdArg(),
  });

  if (!opened.ok) {
    if ('cancelled' in opened && opened.cancelled) return;
    const message = 'error' in opened ? opened.error : 'Could not load diff';
    setStatus(message ?? 'Could not load diff', true);
    return;
  }

  expandedDiffPath = null;
  if (diffHost) {
    diffHost.hidden = true;
    diffHost.replaceChildren();
  }
}

async function showFileDiff(path: string, staged: boolean): Promise<void> {

  if (!diffHost) return;

  if (expandedDiffPath === path && expandedDiffStaged === staged) {

    expandedDiffPath = null;

    diffHost.hidden = true;

    diffHost.replaceChildren();

    return;

  }

  selectedCommitSha = null;

  closeGitCommitDiffPanel();

  syncGraphSelectedCommit();

  const result = await gitDiff({ path, cached: staged, cwd: getEffectiveCwdArg() });

  if (!result.ok || !result.patch) {

    setStatus(result.error ?? 'Could not load diff', true);

    return;

  }

  expandedDiffPath = path;

  expandedDiffStaged = staged;

  diffHost.hidden = false;

  diffHost.replaceChildren();

  const label = document.createElement('p');

  label.className = 'git-panel-diff-label';

  label.textContent = `${staged ? 'Staged' : 'Unstaged'}: ${path}`;

  diffHost.appendChild(label);

  const mount = document.createElement('div');

  diffHost.appendChild(mount);

  renderUnifiedPromptDiff(mount, parseUnifiedPatchToDiffLines(result.patch));

  diffHost.scrollIntoView({ block: 'nearest', behavior: 'smooth' });

}

// ── Render ───────────────────────────────────────────────────────────────────

function renderSections(status: GitOpResult): void {

  if (!bodyMount) return;

  bodyMount.replaceChildren();

  const staged = status.staged ?? [];

  const unstaged = status.unstaged ?? [];

  const untracked = status.untracked ?? [];

  if (staged.length === 0 && unstaged.length === 0 && untracked.length === 0) {

    const empty = document.createElement('p');

    empty.className = 'git-panel-empty';

    empty.textContent = 'No changes';

    bodyMount.appendChild(empty);

    return;

  }

  if (staged.length > 0) {

    bodyMount.appendChild(

      buildSection('Staged Changes', staged, true, {

        label: 'Unstage All',

        fn: () => gitUnstage({ paths: staged.map((f) => f.path), cwd: getEffectiveCwdArg() }),

        successMessage: 'Unstaged all changes',

      }),

    );

  }

  if (unstaged.length > 0) {
    bodyMount.appendChild(buildSection('Changes', unstaged, false));
  }

  if (untracked.length > 0) {

    bodyMount.appendChild(buildSection('Untracked', untracked, false));

  }

}

function renderAheadBehind(status: GitOpResult): void {

  if (!aheadBehindEl) return;

  const ahead = status.ahead ?? 0;

  const behind = status.behind ?? 0;

  if (ahead === 0 && behind === 0) {

    aheadBehindEl.textContent = '';

    return;

  }

  const parts: string[] = [];

  if (ahead > 0) parts.push(`↑${ahead}`);

  if (behind > 0) parts.push(`↓${behind}`);

  aheadBehindEl.textContent = parts.join(' ');

}

function branchDropdownMatches(
  select: HTMLSelectElement,
  branches: string[],
  selectedBranch: string,
): boolean {
  if (select.options.length !== branches.length) return false;
  for (let i = 0; i < branches.length; i++) {
    if (select.options[i]?.value !== branches[i]) return false;
  }
  return select.value === selectedBranch;
}

/** Rebuild a native select after its option set has changed. */
function rebuildNativeSelect(
  select: HTMLSelectElement,
  options: { value: string; label: string }[],
  selectedValue: string,
): void {
  select.replaceChildren();

  for (const { value, label } of options) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    if (value === selectedValue) opt.selected = true;
    select.appendChild(opt);
  }

  select.value = selectedValue;
}

async function refreshBranchSelect(): Promise<void> {
  if (!branchSelect) return;

  const previousSelection = branchSelect.value.trim();
  const result = await gitBranches(getEffectiveCwdArg());

  if (!result.ok) return;

  currentBranchName = result.current ?? '';

  const visible = filterUserFacingBranches(result.local ?? []);
  const branches =
    currentBranchName && !visible.includes(currentBranchName)
      ? [currentBranchName, ...visible]
      : visible;

  if (branches.length === 0) return;

  const selectedBranch = branches.includes(previousSelection)
    ? previousSelection
    : branches.includes(currentBranchName)
      ? currentBranchName
      : branches[0]!;

  if (branchDropdownMatches(branchSelect, branches, selectedBranch)) {
    syncBranchDeleteButton();
    syncMergeToMainButton(
      filterUserFacingBranches(result.local ?? []),
      result.remote ?? [],
      result.lockedLocal ?? [],
    );
    return;
  }

  rebuildNativeSelect(
    branchSelect,
    branches.map((branch) => ({ value: branch, label: branch })),
    selectedBranch,
  );

  syncBranchDeleteButton();
  syncMergeToMainButton(
    filterUserFacingBranches(result.local ?? []),
    result.remote ?? [],
    result.lockedLocal ?? [],
  );
}

function worktreeDropdownMatches(select: HTMLSelectElement, worktrees: ParsedWorktree[]): boolean {
  if (select.options.length !== worktrees.length) return false;
  for (let i = 0; i < worktrees.length; i++) {
    if (!pathsEqual(select.options[i]?.value ?? '', worktrees[i]!.path)) return false;
  }
  return true;
}

function syncCwdSelectValue(): void {
  if (!cwdSelect) return;
  const ws = getWorkspacePath().trim();
  const selectedPath = resolveKnownWorktreePath(knownWorktrees, panelCwd ?? ws, ws);
  cwdSelect.value = selectedPath;
  panelCwd = panelPathsEqual(selectedPath, ws) ? undefined : selectedPath;
  syncWorktreeDeleteButton();
}

async function refreshWorktreeDropdown(): Promise<void> {

  if (!cwdSelect || !cwdWrap) return;

  const ws = getWorkspacePath().trim();

  const listResult = await listWorktrees();

  if (!listResult.ok || !listResult.output) {

    knownWorktrees = ws ? [{ path: ws, head: '', branch: undefined, detached: false }] : [];

    cwdWrap.hidden = knownWorktrees.length === 0;

    if (knownWorktrees.length > 0) {
      const wt = knownWorktrees[0]!;
      rebuildNativeSelect(
        cwdSelect,
        [{ value: wt.path, label: formatWorktreeOptionLabel(wt, ws) }],
        wt.path,
      );
      syncWorktreeDeleteButton();
    }

    return;

  }

  const parsed = parseWorktreeListPorcelain(listResult.output);
  const principal = getPrincipalWorktree(parsed);
  knownWorktrees = filterUserFacingWorktrees(parsed, ws);

  cwdWrap.hidden = knownWorktrees.length === 0;

  if (knownWorktrees.length === 0) return;

  panelCwd = normalizePanelCwdAfterWorktreeListChange(panelCwd, knownWorktrees, ws);
  const selectedPath = resolveKnownWorktreePath(knownWorktrees, panelCwd ?? ws, ws);

  if (worktreeDropdownMatches(cwdSelect, knownWorktrees)) {
    syncCwdSelectValue();
    return;
  }

  rebuildNativeSelect(
    cwdSelect,
    knownWorktrees.map((wt) => ({
      value: wt.path,
      label: formatWorktreeOptionLabel(wt, ws, { principalPath: principal?.path }),
    })),
    selectedPath,
  );
  panelCwd = panelPathsEqual(selectedPath, ws) ? undefined : selectedPath;

  syncWorktreeDeleteButton();

}

function setGitPanelNoRepoState(active: boolean): void {

  panelRoot?.classList.toggle('git-panel-root--no-repo', active);

  if (noRepoMount) {

    noRepoMount.hidden = !active;

    if (active) renderGitNoRepositoryState(noRepoMount);

    else noRepoMount.replaceChildren();

  }

}

// ── Lifecycle ────────────────────────────────────────────────────────────────

export async function refreshGitPanel(): Promise<void> {
  if (!panelOpen) return;

  if (refreshing) {
    refreshPending = true;
    return;
  }

  refreshing = true;

  try {
    await refreshWorktreeDropdown();

    const status = await gitStatus(getEffectiveCwdArg());

    void import('./composer-undo').then((m) => {
      m.invalidateComposerUndoGitCache();
      m.syncComposerUndoFromActiveChat();
    });

    if (!status.ok) {

      if (isMissingGitRepositoryError(status.error)) {

        setStatus('');

        setGitPanelNoRepoState(true);

        if (bodyMount) {
          bodyMount.replaceChildren();
        }

        return;

      }

      setGitPanelNoRepoState(false);

      setStatus(status.error ?? 'Could not read git status', true);

      if (bodyMount) {

        bodyMount.replaceChildren();

        const err = document.createElement('p');

        err.className = 'git-panel-empty';

        err.textContent = status.error ?? 'Could not load git status';

        bodyMount.appendChild(err);

      }

      return;

    }

    setGitPanelNoRepoState(false);

    setStatus('');

    renderAheadBehind(status);

    renderSections(status);

    await refreshBranchSelect();

    ensureGitGraph();

    graphOptions.cwd = getEffectiveCwdArg();

    await graphHandle?.refresh();

  } finally {
    refreshing = false;
    if (refreshPending) {
      refreshPending = false;
      void refreshGitPanel();
    }
  }
}

function startPolling(): void {

  stopPolling();

  pollTimer = window.setInterval(() => {

    void refreshGitPanel();

  }, POLL_MS);

}

function stopPolling(): void {

  if (pollTimer) {

    clearInterval(pollTimer);

    pollTimer = undefined;

  }

}

function syncToggleButtonState(): void {

  const toggleBtn = document.getElementById('btnGitPanelToggle');

  const open = isGitSidePanelOpen();

  if (toggleBtn) {
    toggleBtn.classList.toggle('is-active', open);
    toggleBtn.setAttribute('aria-pressed', open ? 'true' : 'false');
  }

  syncFileSidebarFilesPaneButton({ gitOpen: open });

}

function ensureSidebarExpandedForGit(): void {
  if (isMobileLayout()) {
    openMobileFileSidebar();
  }

  const state = getFilePanelState();

  if (!state.fileSidebarCollapsed) return;

  patchFilePanelState({ fileSidebarCollapsed: false });

  applyFileSidebarVisuals();
}

/** Whether the git view is visible in the file sidebar. */

export function isGitSidePanelOpen(): boolean {

  return panelOpen;

}

/** Open the git view in the file sidebar. */

export async function openGitSidePanel(): Promise<void> {

  ensurePanelDom();

  panelOpen = true;

  syncSidebarChrome();

  ensureSidebarExpandedForGit();

  await refreshGitPanel();

  startPolling();

  void syncFileTreeGitPollCwd();

}

/** Hide the git view and return to the file tree. */

export function closeGitSidePanel(): void {

  panelOpen = false;

  syncSidebarChrome();

  stopPolling();

}

/** Toggle git view visibility in the file sidebar. */

export function toggleGitSidePanel(): void {

  const state = getFilePanelState();

  if (state.fileSidebarCollapsed) {
    void openGitSidePanel();
    return;
  }

  if (isGitSidePanelOpen()) closeGitSidePanel();

  else void openGitSidePanel();

}

export function syncPanelFromActiveChat(options?: { forceFileTree?: boolean }): void {
  if (!sessionState) return;
  if (panelCwdUserOverride) return;

  const chat = getActiveChat();
  const nextCwd = resolvePanelBrowseCwd({
    chat,
    groups: sessionState.groups,
  });
  const ws = getWorkspacePath().trim();
  const worktree = resolvePanelWorktreeCwd(nextCwd);
  panelCwd = worktree ?? (ws || undefined);

  syncCwdSelectValue();
  void syncFileTreeGitPollCwd(options?.forceFileTree);
}

/** @deprecated Use syncPanelFromActiveChat — kept for existing dynamic imports. */
export function syncGitPanelFromOrchestrator(): void {
  syncPanelFromActiveChat();
}

/** Wire toggle button, polling, orchestrator subscriptions. */

export function initGitPanel(): void {

  if (bound) return;

  bound = true;

  ensurePanelDom();

  syncSidebarChrome();

  const toggleBtn = document.getElementById('btnGitPanelToggle');

  toggleBtn?.addEventListener('click', () => toggleGitSidePanel());

  window.addEventListener('focus', () => {
    if (panelOpen) void refreshGitPanel();
  });

  window.addEventListener(GIT_COMMIT_DIFF_CLOSED_EVENT, () => {

    selectedCommitSha = null;

    syncGraphSelectedCommit();

  });

  syncPanelFromActiveChat();
}

/** Reset module state (tests). */

export function resetGitPanelForTests(): void {

  bound = false;

  panelOpen = false;

  panelCwd = undefined;
  panelCwdUserOverride = false;

  knownWorktrees = [];
  currentBranchName = '';

  stopPolling();

  refreshPending = false;

  closeGitPanelNamePopover();

  panelRoot?.remove();

  panelRoot = null;

  scrollMount = null;

  noRepoMount = null;

  bodyMount = null;

  branchSelect = null;
  branchDeleteBtn = null;
  mergeToMainBtn = null;

  cwdSelect = null;
  worktreeDeleteBtn = null;

  cwdWrap = null;

  aheadBehindEl = null;

  commitInput = null;

  commitBtn = null;

  commitPushBtn = null;

  commitBusy = false;

  aiGenerateBtn = null;

  generateMessageAbort?.abort();

  generateMessageAbort = null;

  statusWrap = null;
  statusMessageEl = null;

  diffHost = null;

  graphMount = null;

  historySection = null;

  historyBody = null;

  graphHandle?.destroy();

  graphHandle = null;

  refreshBtn = null;

  selectedCommitSha = null;

  getFileSidebar()?.classList.remove('file-sidebar--git');

  document.getElementById('fileSidebarFilesView')?.removeAttribute('hidden');

  getGitMount()?.setAttribute('hidden', '');

  const titleEl = document.getElementById('fileSidebarTitle');
  if (titleEl) titleEl.textContent = 'Files';

  syncToggleButtonState();
}

import '../styles/source-control-center.css';

import {
  gitBranches,
  gitCheckout,
  gitCherryPick,
  gitCreateTag,
  gitFetch,
  gitPull,
  gitPush,
  gitStatus,
  type GitOpResult,
} from '../state/git-api';
import { forgeRefresh, forgeStatus, prList, type ForgeStatus } from '../state/forge-api';
import { matchPrForBranch } from '../chat/review/pr-review-target';
import { startPrReview } from '../chat/review/run-pr-review';
import { getWorkspacePath } from '../state/workspace';
import { filterUserFacingBranches } from '../lib/worktree-list-parse';
import { resolveTrunkBranchName } from '../lib/git-trunk-branch';
import { appPrompt } from './app-dialog';
import { createIcon, iconHtml, type IconName } from './icon';
import { stripMainColumnOverlayClasses } from './main-column-overlay';
import { showToast } from './toast';
import { gitUiCtx, inferGitUiLabel, runGitUiOp, showGitUiFailure } from './git-ui-op';
import {
  openCherryPickDialog,
  openMergeDialog,
  openRebaseDialog,
  openStashMenuDialog,
  openStashPushDialog,
} from './git-advanced-actions';
import { confirmDirtyCheckout } from './git-checkout-confirm';
import {
  isMissingGitRepositoryError,
  renderGitNoRepositoryState,
} from './git-no-repo-state';
import { openGitPanelNamePopover, openGitRefNamePopover } from './git-panel-name-popover';
import { slugifyGitRefName } from '../lib/git-branch-slug.mjs';
import { resolvePanelWorktreeCwd } from './panel-worktree-cwd';
import { createChangesView, focusCommitMessage } from './scc-changes';
import { createChecksView } from './scc-checks';
import { createHistoryView } from './scc-history';
import { createPullsView, requestPullsSelection } from './scc-pulls';
import { createBranchesView, createStashesView, createWorktreesView } from './scc-refs';
import { refreshForgeRailBadges, refreshGitRailBadges } from './scc-rail-badges';
import { isCommandPaletteOpen, openCommandPalette } from './command-palette';
import { registerCommandSource, type Command } from './command-registry';
import {
  button,
  el,
  stateDot,
  type SccBadge,
  type SccContext,
  type SccSectionId,
  type SccView,
} from './scc-shared';

const ROOT_ID = 'sourceControlCenterRoot';
const CHAT_AREA_CLASS = 'chat-area--source-control';
const MAIN_COLUMN_CLASS = 'main-column--source-control';

const GIT_POLL_MS = 5_000;
const FORGE_POLL_MS = 25_000;

interface SectionDef {
  id: SccSectionId;
  label: string;
  icon: IconName;
  group: 'Working tree' | 'Remote';
  create: (ctx: SccContext) => SccView;
}

let root: HTMLElement | null = null;
let railEl: HTMLElement | null = null;
let paneEl: HTMLElement | null = null;
let noRepoEl: HTMLElement | null = null;
let unregisterGlobalCommands: (() => void) | null = null;

let activeSection: SccSectionId = 'changes';
let activeView: SccView | null = null;
const badges = new Map<SccSectionId, SccBadge>();

let panelCwd: string | undefined;
let currentBranch = '';
let localBranches: string[] = [];
let remoteBranches: string[] = [];
let lockedLocalBranches: string[] = [];
let ahead = 0;
let behind = 0;
let forge: ForgeStatus | null = null;

let gitTimer: number | undefined;
let forgeTimer: number | undefined;
let keyHandler: ((event: KeyboardEvent) => void) | null = null;
let busy = false;

// Header elements, rebuilt only on open.
let repoNameEl: HTMLElement | null = null;
let branchBtn: HTMLButtonElement | null = null;
let worktreeBtn: HTMLButtonElement | null = null;
let syncEl: HTMLElement | null = null;
let forgeChipEl: HTMLElement | null = null;
let pullBtn: HTMLButtonElement | null = null;
let pushBtn: HTMLButtonElement | null = null;

// ── Open state ───────────────────────────────────────────────────────────────

/** Whether the center is mounted in the main column. */
export function isSourceControlCenterOpen(): boolean {
  return Boolean(document.getElementById(ROOT_ID));
}

/** Re-read git state after a workspace switch so worktree rows match the new repo. */
export function refreshSourceControlCenter(): void {
  if (!isSourceControlCenterOpen()) return;
  void refreshAll();
}

// ── Shell ────────────────────────────────────────────────────────────────────

function effectiveCwd(): string | undefined {
  return resolvePanelWorktreeCwd(panelCwd);
}

function sections(): SectionDef[] {
  return [
    {
      id: 'changes',
      label: 'Changes',
      icon: 'gitCommit',
      group: 'Working tree',
      create: (ctx) => createChangesView(ctx),
    },
    {
      id: 'history',
      label: 'History',
      icon: 'gitGraph',
      group: 'Working tree',
      create: (ctx) => createHistoryView(ctx),
    },
    {
      id: 'branches',
      label: 'Branches',
      icon: 'gitBranch',
      group: 'Working tree',
      create: (ctx) => createBranchesView(ctx),
    },
    {
      id: 'stashes',
      label: 'Stashes',
      icon: 'gitStash',
      group: 'Working tree',
      create: (ctx) => createStashesView(ctx),
    },
    {
      id: 'worktrees',
      label: 'Worktrees',
      icon: 'gitWorktree',
      group: 'Working tree',
      create: (ctx) =>
        createWorktreesView(ctx, {
          onSelectWorktree: (path) => void setCwd(path),
        }),
    },
    {
      id: 'pulls',
      label: 'Pull requests',
      icon: 'gitMerge',
      group: 'Remote',
      create: (ctx) => createPullsView(ctx, { getForgeStatus: () => forge }),
    },
    {
      id: 'checks',
      label: 'Checks',
      icon: 'statusRunning',
      group: 'Remote',
      create: (ctx) => createChecksView(ctx, { getForgeStatus: () => forge }),
    },
  ];
}

const context: SccContext = {
  getCwd: () => effectiveCwd(),
  getBranch: () => currentBranch,
  refreshAll: () => refreshAll(),
  refreshSection: async () => {
    await activeView?.refresh();
  },
  goTo: (section) => void showSection(section),
  setBadge: (section, badge) => applyRailBadge(section, badge),
};

function buildShell(): HTMLElement {
  const shell = el('div', 'scc-root');
  shell.id = ROOT_ID;

  shell.append(buildHeader(), buildBody());

  noRepoEl = el('div', 'scc-no-repo');
  noRepoEl.hidden = true;
  shell.appendChild(noRepoEl);

  return shell;
}

function buildHeader(): HTMLElement {
  const header = el('header', 'scc-head');

  const identity = el('div', 'scc-head__identity');

  repoNameEl = el('span', 'scc-head__repo');
  identity.appendChild(repoNameEl);

  branchBtn = button({
    icon: 'gitBranch',
    label: '—',
    title: 'Switch branch',
    className: 'scc-head__context-btn',
    onClick: () => openBranchSwitcher(),
  });
  identity.appendChild(branchBtn);

  worktreeBtn = button({
    icon: 'gitWorktree',
    label: 'Main worktree',
    title: 'Switch worktree',
    className: 'scc-head__context-btn',
    onClick: () => showSection('worktrees'),
  });
  identity.appendChild(worktreeBtn);

  forgeChipEl = el('span', 'scc-head__forge');
  forgeChipEl.hidden = true;
  identity.appendChild(forgeChipEl);

  const sync = el('div', 'scc-head__sync');

  syncEl = el('span', 'scc-head__gauge');
  syncEl.hidden = true;

  const fetchBtn = button({
    icon: 'gitFetch',
    title: 'Fetch from every remote',
    onClick: () => void runOp(() => gitFetch(effectiveCwd()), 'Fetched remotes'),
  });

  pullBtn = button({
    icon: 'gitPull',
    label: 'Pull',
    title: 'Pull from upstream',
    onClick: () => void runOp(() => gitPull(effectiveCwd()), 'Pulled changes'),
  });

  pushBtn = button({
    icon: 'gitPush',
    label: 'Push',
    variant: 'primary',
    title: 'Push to upstream',
    onClick: () => void runOp(() => gitPush({ cwd: effectiveCwd() }), 'Pushed changes'),
  });

  sync.append(syncEl, fetchBtn, pullBtn, pushBtn);

  const actions = el('div', 'scc-head__actions');

  const paletteBtn = button({
    icon: 'search',
    label: 'Commands',
    variant: 'ghost',
    title: 'Run a git command',
    className: 'scc-head__palette-btn',
    onClick: () => openCommandPalette(),
  });
  paletteBtn.appendChild(el('kbd', 'scc-head__kbd', modKeyLabel('K')));

  const closeBtn = button({
    icon: 'close',
    title: 'Close source control',
    variant: 'ghost',
    onClick: () => closeSourceControlCenter(),
  });

  actions.append(paletteBtn, closeBtn);

  header.append(identity, sync, actions);
  return header;
}

function buildBody(): HTMLElement {
  const body = el('div', 'scc-body');

  railEl = el('nav', 'scc-rail');
  railEl.setAttribute('aria-label', 'Source control sections');

  let lastGroup = '';
  for (const section of sections()) {
    if (section.group !== lastGroup) {
      lastGroup = section.group;
      railEl.appendChild(el('p', 'scc-rail__group', section.group));
    }

    const item = el('button', 'scc-rail__item');
    item.type = 'button';
    item.dataset.section = section.id;
    item.setAttribute('aria-current', String(section.id === activeSection));
    const badgeSlot = el('span', 'scc-rail__badge');
    badgeSlot.hidden = true;

    item.append(
      createIcon(section.icon, { className: 'scc-rail__icon', size: 16 }),
      el('span', 'scc-rail__label', section.label),
      badgeSlot,
    );
    item.addEventListener('click', () => void showSection(section.id));
    railEl.appendChild(item);
  }

  paneEl = el('div', 'scc-pane');
  paneEl.setAttribute('role', 'region');

  body.append(railEl, paneEl);
  return body;
}

function modKeyLabel(key: string): string {
  const mac = /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent);
  return mac ? `⌘${key}` : `Ctrl ${key}`;
}

// ── Navigation ───────────────────────────────────────────────────────────────

async function showSection(id: SccSectionId): Promise<void> {
  if (!paneEl) return;

  const def = sections().find((section) => section.id === id);
  if (!def) return;

  if (activeSection === id && activeView) {
    activeView.activate?.();
    return;
  }

  activeSection = id;
  activeView?.destroy();
  activeView = def.create(context);

  paneEl.replaceChildren(activeView.root);
  paneEl.setAttribute('aria-label', def.label);

  for (const item of railEl?.querySelectorAll<HTMLElement>('.scc-rail__item') ?? []) {
    const isActive = item.dataset.section === id;
    item.classList.toggle('is-active', isActive);
    item.setAttribute('aria-current', String(isActive));
  }

  activeView.activate?.();
}

function applyRailBadge(section: SccSectionId, badge: SccBadge | null): void {
  if (badge) badges.set(section, badge);
  else badges.delete(section);
  paintRailBadge(section);
}

function paintRailBadge(section: SccSectionId): void {
  const item = railEl?.querySelector<HTMLElement>(`.scc-rail__item[data-section="${section}"]`);
  const slot = item?.querySelector<HTMLElement>('.scc-rail__badge');
  if (!slot) return;

  const badge = badges.get(section);
  slot.replaceChildren();

  if (!badge) {
    slot.hidden = true;
    return;
  }

  slot.hidden = false;
  if (badge.kind === 'count') {
    slot.textContent = String(badge.value);
    slot.className = 'scc-rail__badge scc-rail__badge--count';
  } else {
    slot.className = 'scc-rail__badge scc-rail__badge--state';
    slot.appendChild(stateDot(badge.value));
  }
}

// ── Refresh ──────────────────────────────────────────────────────────────────

async function refreshGitState(): Promise<void> {
  const cwd = effectiveCwd();
  const status = await gitStatus(cwd);

  if (!status.ok) {
    if (isMissingGitRepositoryError(status.error)) {
      setNoRepo(true);
      return;
    }
    setNoRepo(false);
    return;
  }

  setNoRepo(false);
  ahead = status.ahead ?? 0;
  behind = status.behind ?? 0;

  const branchResult = await gitBranches(cwd);
  if (branchResult.ok) {
    currentBranch = branchResult.current ?? '';
    localBranches = filterUserFacingBranches(branchResult.local ?? []);
    remoteBranches = branchResult.remote ?? [];
    lockedLocalBranches = branchResult.lockedLocal ?? [];
  }

  paintHeader();

  await refreshGitRailBadges(applyRailBadge, {
    cwd,
    status,
    localBranchCount: localBranches.length,
  });
}

async function refreshForgeState(): Promise<void> {
  forge = await forgeStatus(effectiveCwd());
  paintForgeChip();
  await refreshForgeRailBadges(applyRailBadge, {
    cwd: effectiveCwd(),
    branch: currentBranch,
    forge,
  });
}

// ── Header ───────────────────────────────────────────────────────────────────

function paintHeader(): void {
  const workspace = getWorkspacePath().trim();

  if (repoNameEl) {
    const name = workspace.split(/[\\/]/).filter(Boolean).pop() ?? 'Repository';
    repoNameEl.textContent = name;
    repoNameEl.title = workspace;
  }

  if (branchBtn) {
    const label = branchBtn.querySelector('.scc-btn__label');
    if (label) label.textContent = currentBranch || 'detached';
    branchBtn.title = currentBranch ? `On ${currentBranch} — click to switch` : 'Detached HEAD';
  }

  if (worktreeBtn) {
    const label = worktreeBtn.querySelector('.scc-btn__label');
    const cwd = panelCwd;
    const name = cwd ? (cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd) : 'Main worktree';
    if (label) label.textContent = name;
    worktreeBtn.classList.toggle('is-secondary-worktree', Boolean(cwd));
    worktreeBtn.title = cwd ? `Working in ${cwd}` : 'Working in the main worktree';
  }

  if (syncEl) {
    syncEl.replaceChildren();
    if (ahead === 0 && behind === 0) {
      syncEl.hidden = true;
    } else {
      syncEl.hidden = false;
      if (behind > 0) {
        const el2 = el('span', 'scc-head__gauge-part scc-head__gauge-part--behind');
        el2.innerHTML = iconHtml('arrowDown', { size: 13 });
        el2.appendChild(el('span', undefined, String(behind)));
        el2.title = `${behind} commit${behind === 1 ? '' : 's'} to pull`;
        syncEl.appendChild(el2);
      }
      if (ahead > 0) {
        const el2 = el('span', 'scc-head__gauge-part scc-head__gauge-part--ahead');
        el2.innerHTML = iconHtml('arrowUp', { size: 13 });
        el2.appendChild(el('span', undefined, String(ahead)));
        el2.title = `${ahead} commit${ahead === 1 ? '' : 's'} to push`;
        syncEl.appendChild(el2);
      }
    }
  }

  if (pullBtn) pullBtn.classList.toggle('is-suggested', behind > 0);
  if (pushBtn) pushBtn.classList.toggle('is-suggested', ahead > 0);
}

function paintForgeChip(): void {
  if (!forgeChipEl) return;

  if (!forge || forge.host === 'none') {
    forgeChipEl.hidden = true;
    return;
  }

  forgeChipEl.hidden = false;
  forgeChipEl.replaceChildren();
  forgeChipEl.classList.toggle('is-inactive', !forge.supported);
  forgeChipEl.textContent = forge.repo || forge.hostname;
  forgeChipEl.title = forge.supported
    ? `Connected to ${forge.hostname} as the signed-in gh user`
    : forge.reason;
}

function setNoRepo(active: boolean): void {
  root?.classList.toggle('scc-root--no-repo', active);
  if (!noRepoEl) return;

  noRepoEl.hidden = !active;
  if (active && !noRepoEl.firstChild) renderGitNoRepositoryState(noRepoEl);
  if (!active) noRepoEl.replaceChildren();
}

async function refreshAll(): Promise<void> {
  await refreshGitState();
  await activeView?.refresh();
}

async function runOp(fn: () => Promise<GitOpResult>, successMessage?: string): Promise<boolean> {
  if (busy) return false;
  busy = true;
  root?.classList.add('is-busy');
  try {
    const result = await runGitUiOp(fn, {
      label: inferGitUiLabel(successMessage),
      successMessage,
      ctx: gitUiCtx(effectiveCwd(), currentBranch),
    });
    if (!result.ok) return false;
    await refreshAll();
    return true;
  } finally {
    busy = false;
    root?.classList.remove('is-busy');
  }
}

/** Point the center at a different worktree, and keep the sidebar in step. */
async function setCwd(path: string | undefined): Promise<void> {
  panelCwd = path;
  forge = null;
  const { setGitPanelCwd } = await import('./git-panel');
  setGitPanelCwd(path);
  await refreshAll();
  await refreshForgeState();
}

function openBranchSwitcher(): void {
  if (!branchBtn) return;
  openGitPanelNamePopover({
    anchor: branchBtn,
    title: 'Switch branch',
    label: 'Branch name',
    placeholder: currentBranch || 'main',
    submitLabel: 'Switch',
    onSubmit: async (name) => {
      const typed = name.trim();
      if (!typed || typed === currentBranch) return;

      const existsExact = localBranches.includes(typed);
      const branch = existsExact ? typed : slugifyGitRefName(typed);
      if (!branch || branch === currentBranch) return;
      if (!(await confirmDirtyCheckout(effectiveCwd()))) return;

      const exists = existsExact || localBranches.includes(branch);
      await runOp(
        () => gitCheckout({ branch, create: !exists, cwd: effectiveCwd() }),
        exists ? `Switched to ${branch}` : `Created and checked out ${branch}`,
      );
    },
  });
}

function advancedContext() {
  return {
    cwd: effectiveCwd(),
    branch: currentBranch,
    onSuccess: () => void refreshAll(),
    onConflict: (message: string) => showGitUiFailure(message, { chatKind: 'merge', ctx: gitUiCtx(effectiveCwd(), currentBranch) }),
  };
}

/** Review the open PR for the checked-out branch without focusing the review chat. */
async function reviewCurrentBranchPr(): Promise<void> {
  const repo = forge?.repo?.trim();
  if (!repo) {
    showToast('Repository is unknown', 'error');
    return;
  }
  const listed = await runGitUiOp(() => prList({ cwd: effectiveCwd(), state: 'open' }), {
    label: 'Listing pull requests…',
    chatKind: 'pr',
    ctx: gitUiCtx(effectiveCwd(), currentBranch),
    skipSuccessToast: true,
  });
  if (!listed.ok) {
    return;
  }
  const match = matchPrForBranch(listed.prs ?? [], currentBranch);
  if (!match) {
    showToast('No open pull request for this branch', 'error');
    return;
  }
  requestPullsSelection(match.number);
  await showSection('pulls');
  const result = await runGitUiOp(
    () =>
      startPrReview({
        cwd: effectiveCwd(),
        repo,
        number: match.number,
      }),
    {
      label: 'Starting review…',
      successMessage: `Reviewing #${match.number}`,
      chatKind: 'pr',
      ctx: gitUiCtx(effectiveCwd(), currentBranch),
    },
  );
  if (!result.ok) return;
}

// ── Commands ─────────────────────────────────────────────────────────────────

function buildCommands(): Command[] {
  const onGitHub = (): boolean => Boolean(forge?.supported);
  const conflictHost = paneEl ?? document.createElement('div');

  const jump = (id: SccSectionId, title: string, shortcut: string): Command => ({
    id: `go.${id}`,
    title,
    group: 'Go to',
    shortcut,
    run: () => void showSection(id),
  });

  return [
    jump('changes', 'Changes', modKeyLabel('1')),
    jump('history', 'History', modKeyLabel('2')),
    jump('branches', 'Branches', modKeyLabel('3')),
    jump('stashes', 'Stashes', modKeyLabel('4')),
    jump('worktrees', 'Worktrees', modKeyLabel('5')),
    jump('pulls', 'Pull requests', modKeyLabel('6')),
    jump('checks', 'Checks', modKeyLabel('7')),

    {
      id: 'sync.fetch',
      title: 'Fetch all remotes',
      group: 'Sync',
      keywords: 'remote update download',
      run: () => void runOp(() => gitFetch(effectiveCwd()), 'Fetched remotes'),
    },
    {
      id: 'sync.pull',
      title: 'Pull',
      group: 'Sync',
      keywords: 'download upstream merge remote',
      run: () => void runOp(() => gitPull(effectiveCwd()), 'Pulled changes'),
    },
    {
      id: 'sync.push',
      title: 'Push',
      group: 'Sync',
      keywords: 'upload upstream publish',
      run: () => void runOp(() => gitPush({ cwd: effectiveCwd() }), 'Pushed changes'),
    },
    {
      id: 'sync.pushUpstream',
      title: 'Push and set upstream',
      group: 'Sync',
      keywords: 'publish track -u new branch',
      run: () =>
        void runOp(
          () => gitPush({ cwd: effectiveCwd(), setUpstream: true, branch: currentBranch }),
          `Pushed ${currentBranch} and set upstream`,
        ),
    },

    {
      id: 'commit.focus',
      title: 'Write a commit message',
      group: 'Commit',
      keywords: 'stage message compose',
      run: () => {
        void showSection('changes').then(() => {
          if (activeView) focusCommitMessage(activeView.root);
        });
      },
    },

    {
      id: 'branch.new',
      title: 'New branch',
      group: 'Branch',
      keywords: 'create checkout -b',
      run: () => {
        void showSection('branches');
        const anchor = branchBtn ?? document.getElementById(ROOT_ID) ?? document.body;
        openGitRefNamePopover({
          anchor,
          title: 'New branch',
          kind: 'branch',
          cwd: effectiveCwd(),
          defaultPath: effectiveCwd() || getWorkspacePath(),
          reserved: [currentBranch, 'main', 'master'],
          onSubmit: async (result) => {
            if (!(await confirmDirtyCheckout(effectiveCwd()))) return;
            await runOp(
              () =>
                gitCheckout({
                  branch: result.name,
                  create: true,
                  startPoint: result.startPoint,
                  cwd: effectiveCwd(),
                }),
              `Created and checked out ${result.name}`,
            );
          },
        });
      },
    },
    {
      id: 'branch.switch',
      title: 'Switch branch',
      group: 'Branch',
      keywords: 'checkout change',
      run: () => openBranchSwitcher(),
    },
    {
      id: 'branch.merge',
      title: 'Merge a branch into this one',
      group: 'Branch',
      keywords: 'combine integrate',
      run: () => void openMergeDialog(localBranches, advancedContext(), conflictHost),
    },
    {
      id: 'branch.mergeTrunk',
      title: 'Merge trunk into this branch',
      group: 'Branch',
      keywords: 'main master update rebase catch up',
      available: () => Boolean(currentBranch) && currentBranch !== trunkName(),
      run: () => {
        const trunk = trunkName();
        void runOp(
          () =>
            import('../state/git-api').then((m) => m.gitMerge({ branch: trunk, cwd: effectiveCwd() })),
          `Merged ${trunk} into ${currentBranch}`,
        );
      },
    },
    {
      id: 'branch.rebase',
      title: 'Rebase onto a branch',
      group: 'Branch',
      keywords: 'replay linear history',
      run: () => void openRebaseDialog(localBranches, advancedContext(), conflictHost),
    },
    {
      id: 'branch.cherryPick',
      title: 'Cherry-pick a commit',
      group: 'Branch',
      keywords: 'copy commit apply single',
      run: () => void openCherryPickDialog(advancedContext(), conflictHost),
    },
    {
      id: 'branch.cherryPickAbort',
      title: 'Abort cherry-pick',
      group: 'Branch',
      keywords: 'cancel stop',
      run: () =>
        void runOp(() => gitCherryPick({ abort: true, cwd: effectiveCwd() }), 'Cherry-pick aborted'),
    },

    {
      id: 'stash.push',
      title: 'Stash changes',
      group: 'Stash',
      keywords: 'save shelve park wip',
      run: () => void openStashPushDialog(advancedContext()),
    },
    {
      id: 'stash.menu',
      title: 'Apply, pop, or drop a stash',
      group: 'Stash',
      keywords: 'restore unstash list',
      run: () => void openStashMenuDialog(advancedContext(), conflictHost),
    },

    {
      id: 'tag.create',
      title: 'Tag the current commit',
      group: 'Tag',
      keywords: 'release version annotate',
      run: () => void createTag(),
    },

    {
      id: 'worktree.add',
      title: 'Add a worktree',
      group: 'Worktree',
      keywords: 'isolate parallel checkout separate',
      run: () => void showSection('worktrees'),
    },
    {
      id: 'worktree.main',
      title: 'Return to the main worktree',
      group: 'Worktree',
      keywords: 'switch root workspace',
      available: () => Boolean(panelCwd),
      run: () => void setCwd(undefined),
    },

    {
      id: 'pr.create',
      title: 'Open a pull request',
      group: 'Pull requests',
      keywords: 'pr new github review',
      available: onGitHub,
      run: () => void showSection('pulls'),
    },
    {
      id: 'pr.list',
      title: 'Review open pull requests',
      group: 'Pull requests',
      keywords: 'pr github list',
      available: onGitHub,
      run: () => void showSection('pulls'),
    },
    {
      id: 'pr.review',
      title: 'Review the current branch PR',
      group: 'Pull requests',
      keywords: 'pr review agent findings',
      available: onGitHub,
      run: () => void reviewCurrentBranchPr(),
    },

    {
      id: 'ci.list',
      title: 'Show CI runs for this branch',
      group: 'Checks',
      keywords: 'ci actions workflow build test',
      available: onGitHub,
      run: () => void showSection('checks'),
    },
    {
      id: 'ci.recheck',
      title: 'Re-check GitHub connection',
      group: 'Checks',
      keywords: 'gh auth login reconnect status',
      run: async () => {
        forge = await forgeRefresh(effectiveCwd());
        paintForgeChip();
        if (forge.supported) {
          showToast(`Connected to ${forge.repo}`, 'success');
        } else {
          showGitUiFailure(forge.reason, {
            chatKind: 'github',
            ctx: gitUiCtx(effectiveCwd(), currentBranch),
          });
        }
        await activeView?.refresh();
      },
    },

    {
      id: 'view.refresh',
      title: 'Refresh everything',
      group: 'View',
      shortcut: 'R',
      keywords: 'reload update poll',
      run: () => void refreshAll(),
    },
    {
      id: 'view.close',
      title: 'Close source control',
      group: 'View',
      shortcut: 'Esc',
      keywords: 'exit back editor',
      run: () => closeSourceControlCenter(),
    },
  ];
}

function trunkName(): string {
  return resolveTrunkBranchName(localBranches, remoteBranches, lockedLocalBranches);
}

async function createTag(): Promise<void> {
  const name = await appPrompt('Tag name:', '', {
    title: 'Create tag',
    placeholder: 'v1.2.0',
    confirmLabel: 'Create tag',
  });
  if (!name?.trim()) return;
  await runOp(
    () => gitCreateTag({ name: name.trim(), sha: 'HEAD', cwd: effectiveCwd() }),
    `Tagged HEAD as ${name.trim()}`,
  );
}

const SECTION_ORDER: SccSectionId[] = [
  'changes',
  'history',
  'branches',
  'stashes',
  'worktrees',
  'pulls',
  'checks',
];

// ── Keys ─────────────────────────────────────────────────────────────────────

function handleKey(event: KeyboardEvent): void {
  if (!isSourceControlCenterOpen()) return;

  const mod = event.ctrlKey || event.metaKey;

  if (isCommandPaletteOpen()) return;

  if (mod && /^[1-7]$/.test(event.key)) {
    event.preventDefault();
    void showSection(SECTION_ORDER[Number(event.key) - 1]!);
    return;
  }

  if (event.key === 'Escape') {
    closeSourceControlCenter();
    return;
  }

  const target = event.target;
  const inField =
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLElement && target.isContentEditable);

  if (!inField && !mod && event.key.toLowerCase() === 'r') {
    event.preventDefault();
    void refreshAll();
    return;
  }

  if (activeView?.onKey?.(event)) event.stopPropagation();
}

function startPolling(): void {
  stopPolling();
  gitTimer = window.setInterval(() => {
    if (document.hidden || busy) return;
    void refreshGitState();
    void activeView?.refresh();
  }, GIT_POLL_MS);

  forgeTimer = window.setInterval(() => {
    if (document.hidden) return;
    void refreshForgeState();
    if (activeSection === 'pulls' || activeSection === 'checks') void activeView?.refresh();
  }, FORGE_POLL_MS);
}

function stopPolling(): void {
  if (gitTimer) window.clearInterval(gitTimer);
  if (forgeTimer) window.clearInterval(forgeTimer);
  gitTimer = undefined;
  forgeTimer = undefined;
}

async function closeCompetingMainColumnViews(): Promise<void> {
  const { closeOtherCodeStageViews } = await import('./main-column-overlay');
  await closeOtherCodeStageViews('source-control');
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

/** Mount the Source Control Center into the Code main column. */
export async function openSourceControlCenter(options?: {
  section?: SccSectionId;
  cwd?: string;
}): Promise<void> {
  if (isSourceControlCenterOpen()) {
    if (options?.section) await showSection(options.section);
    await refreshAll();
    return;
  }

  await closeCompetingMainColumnViews();

  const area = document.getElementById('chatArea');
  if (!area) return;

  const { getGitPanelCwd } = await import('./git-panel');
  panelCwd = options?.cwd ?? getGitPanelCwd();
  activeSection = options?.section ?? 'changes';
  badges.clear();

  root = buildShell();
  area.replaceChildren(root);
  stripMainColumnOverlayClasses();
  area.classList.add(CHAT_AREA_CLASS);
  document.getElementById('mainColumn')?.classList.add(MAIN_COLUMN_CLASS);

  unregisterGlobalCommands = registerCommandSource(
    'source-control',
    () => (isSourceControlCenterOpen() ? buildCommands() : []),
    { order: 20 },
  );

  keyHandler = handleKey;
  document.addEventListener('keydown', keyHandler, true);

  await showSection(activeSection);
  await refreshGitState();
  startPolling();

  void refreshForgeState().then(() => {
    if (activeSection === 'pulls' || activeSection === 'checks') void activeView?.refresh();
  });

  const { notifyAskQuestionDisplayContextChanged } = await import('../chat/ask-question-display');
  notifyAskQuestionDisplayContextChanged();
}

/** Tear the center down. Skip chat restore when another Code view is taking the column. */
export function closeSourceControlCenter(options?: { restoreChat?: boolean }): void {
  if (!isSourceControlCenterOpen()) return;

  stopPolling();
  if (keyHandler) {
    document.removeEventListener('keydown', keyHandler, true);
    keyHandler = null;
  }

  unregisterGlobalCommands?.();
  unregisterGlobalCommands = null;
  activeView?.destroy();
  activeView = null;

  document.getElementById(ROOT_ID)?.remove();
  stripMainColumnOverlayClasses();

  root = null;
  railEl = null;
  paneEl = null;
  noRepoEl = null;
  repoNameEl = null;
  branchBtn = null;
  worktreeBtn = null;
  syncEl = null;
  forgeChipEl = null;
  pullBtn = null;
  pushBtn = null;
  forge = null;
  badges.clear();

  if (options?.restoreChat === false) {
    void import('./main-column-overlay').then((m) => m.notifyCodeStageViewChanged());
    return;
  }

  void restoreChatColumn();
}

async function restoreChatColumn(): Promise<void> {
  const { sessionState } = await import('../state/sessions');
  const area = document.getElementById('chatArea');
  const chat = sessionState?.chats.find((entry) => entry.id === sessionState?.activeId);

  if (chat) {
    const messages = await import('./messages');
    void messages.renderChatFromHistory(chat);
  } else {
    area?.replaceChildren();
  }

  const { notifyAskQuestionDisplayContextChanged } = await import('../chat/ask-question-display');
  notifyAskQuestionDisplayContextChanged();
}

/** Toggle the center from the sidebar button. */
export function toggleSourceControlCenter(): void {
  if (isSourceControlCenterOpen()) closeSourceControlCenter();
  else void openSourceControlCenter();
}

/** Reset module state (tests). */
export function resetSourceControlCenterForTests(): void {
  stopPolling();
  if (keyHandler) {
    document.removeEventListener('keydown', keyHandler, true);
    keyHandler = null;
  }
  unregisterGlobalCommands?.();
  unregisterGlobalCommands = null;
  activeView?.destroy();
  activeView = null;
  document.getElementById(ROOT_ID)?.remove();
  stripMainColumnOverlayClasses();
  root = null;
  railEl = null;
  paneEl = null;
  noRepoEl = null;
  panelCwd = undefined;
  currentBranch = '';
  localBranches = [];
  remoteBranches = [];
  lockedLocalBranches = [];
  ahead = 0;
  behind = 0;
  forge = null;
  busy = false;
  activeSection = 'changes';
  badges.clear();
}

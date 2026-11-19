import { isContextMenuOpen } from './context-menu';
import { createPollingTask } from '../lib/polling-task';
import '../styles/source-control-center.css';
import '../styles/git-commit-diff.css';

import {
  gitBranches,
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
import { normalizeWorkspacePath } from '../lib/normalize-workspace-path';
import { filterUserFacingBranches, getPrincipalWorktree, parseWorktreeListPorcelain, worktreePathsEqual } from '../lib/worktree-list-parse';
import { resolveTrunkBranchName } from '../lib/git-trunk-branch';
import { displayRemoteRef, isSkippedRemoteRef } from '../lib/git-ref-start.mjs';
import { appAlert, appPrompt, isAppDialogOpen } from './app-dialog';
import { createGitHubMark, createIcon, type IconName } from './icon';
import { launchApp, navigateToCodeChat, returnToChat } from '../os/router';
import { createBackToChatButton } from './back-to-chat';
import { getForegroundAppId } from '../os/instances';
import { showToast } from './toast';
import { revealInTabStrip } from './mobile-layout';
import { gitUiCtx, inferGitUiLabel, runGitUiOp, showGitUiFailure, type RunGitUiOpOptions } from './git-ui-op';
import {
  openCherryPickDialog,
  openMergeDialog,
  openRebaseDialog,
  openStashMenuDialog,
  openStashPushDialog,
} from './git-advanced-actions';
import { checkoutBranchWithChoice, checkoutRecoveryActions } from './git-checkout-confirm';
import {
  isMissingGitRepositoryError,
  renderGitNoRepositoryState,
} from './git-no-repo-state';
import { openGitBranchSwitchPopover, openGitRefNamePopover } from './git-panel-name-popover';
import { resolvePanelBrowseCwd, resolvePanelWorktreeCwd } from './panel-worktree-cwd';
import { displayWorktreeTitle } from './worktree-display';
import { getActiveChat, sessionState } from '../state/sessions';
import { lookupWorkspaceRepos, type WorkspaceRepo } from '../state/workspace-repos';
import { listWorktrees } from '../state/worktree-service';
import { otherChatsUsingCheckout } from './chat-checkout-guard';
import {
  buildRepoMenuItems,
  pickDefaultRepo,
  readRememberedRepo,
  rememberRepo,
  repoForPanelCwd,
  repoLabel,
  repoPanelCwd,
} from './scc-repo-switcher';
import { openContextMenu } from './context-menu';
import { getActiveViewerTabPath } from './file-viewer-tab-store';
import { createChangesView, focusCommitMessage } from './scc-changes';
import { pushWithPublishPrompt } from './git-publish-push';
import { createActionsView } from './scc-actions';
import { createReleasesView } from './scc-releases';
import { createHistoryView } from './scc-history';
import { createPullsView, requestPullsSelection } from './scc-pulls';
import { createBranchesView, createStashesView, createWorktreesView } from './scc-refs';
import { refreshForgeRailBadges, refreshGitRailBadges } from './scc-rail-badges';
import { isCommandPaletteOpen, openCommandPalette } from './command-palette';
import { registerCommandSource, type Command } from './command-registry';
import { loadUtilityModelConfig } from '../config/utility-model-meta';
import {
  button,
  el,
  emptyState,
  stateDot,
  type SccBadge,
  type SccContext,
  type SccSectionId,
  type SccView,
} from './scc-shared';

const ROOT_ID = 'sourceControlCenterRoot';
let pendingOpenOptions: { section?: SccSectionId; cwd?: string } | undefined;

const GIT_POLL_MS = 5_000;
const FORGE_POLL_MS = 60_000;
const syncActions = {
  Fetch: { run: gitFetch, progress: 'Fetching', completed: 'Fetched', success: 'Fetched remotes' },
  Pull: { run: gitPull, progress: 'Pulling', completed: 'Pulled', success: 'Pulled changes' },
  Push: { run: (cwd?: string, repo?: string) => pushWithPublishPrompt(cwd, undefined, repo), progress: 'Pushing', completed: 'Pushed', success: 'Pushed changes' },
};
type SyncAction = keyof typeof syncActions;
const syncAllByWorkspace = new Map<string, boolean>();

interface SectionDef {
  id: SccSectionId;
  label: string;
  icon: IconName;
  group: 'Repository' | 'GitHub';
  create: (ctx: SccContext) => SccView;
}

let root: HTMLElement | null = null;
let railEl: HTMLElement | null = null;
let paneEl: HTMLElement | null = null;
let noRepoEl: HTMLElement | null = null;
let unregisterGlobalCommands: (() => void) | null = null;

let activeSection: SccSectionId = 'changes';
let activeView: SccView | null = null;
/**
 * Pages already visited for the current checkout. Switching back re-attaches
 * the page as it was (selection, scroll, loaded data) and refreshes it in the
 * background, instead of rebuilding it behind a skeleton.
 */
const viewCache = new Map<SccSectionId, SccView>();

/** Drop every kept page except the one on screen (a different checkout, or teardown). */
function dropCachedViews(): void {
  for (const view of viewCache.values()) view.destroy();
  viewCache.clear();
}
const badges = new Map<SccSectionId, SccBadge>();

let panelCwd: string | undefined;
let workspaceRepos: WorkspaceRepo[] = [];
let repoScopePath = '';
let selectedRepoId: string | undefined;
let discoveryFailed = false;
let checkoutWorkspace = '';
let checkoutVersion = 0;
let scopeRequest = 0;
let currentBranch = '';
let localBranches: string[] = [];
let remoteBranches: string[] = [];
let lockedLocalBranches: string[] = [];
let forge: ForgeStatus | null = null;

let gitTimer: number | undefined;
let forgeTimer: number | undefined;
let keyHandler: ((event: KeyboardEvent) => void) | null = null;
let busy = false;
let forgePollInFlight = false;
let gitPollInFlight = false;
const viewRefreshes = new WeakMap<SccView, Promise<void>>();

function refreshActiveView(): Promise<void> {
  const view = activeView;
  if (!view || !isSourceControlCenterOpen()) return Promise.resolve();
  const pending = viewRefreshes.get(view);
  if (pending) return pending;
  const refresh = Promise.resolve().then(() => {
    if (activeView === view && isSourceControlCenterOpen()) return view.refresh();
  }).finally(() => viewRefreshes.delete(view));
  viewRefreshes.set(view, refresh);
  return refresh;
}

// Header elements, rebuilt only on open.
let repoNameEl: HTMLElement | null = null;
let repoLabelEl: HTMLElement | null = null;
let repoBtn: HTMLButtonElement | null = null;
let branchBtn: HTMLButtonElement | null = null;
let worktreeBtn: HTMLButtonElement | null = null;
let followChatBtn: HTMLButtonElement | null = null;
let forgeChipEl: HTMLElement | null = null;
let fetchBtn: HTMLButtonElement | null = null;
let pullBtn: HTMLButtonElement | null = null;
let pushBtn: HTMLButtonElement | null = null;
let syncEl: HTMLElement | null = null;

// ── Open state ───────────────────────────────────────────────────────────────

/** Whether Source Control is the foreground app. */
export function isSourceControlCenterOpen(): boolean {
  return Boolean(document.getElementById(ROOT_ID)) && getForegroundAppId() === 'source-control';
}

/** Re-read git state after a workspace switch so worktree rows match the new repo. */
export function refreshSourceControlCenter(): void {
  if (!isSourceControlCenterOpen()) return;
  void mountSourceControlCenter();
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
      group: 'Repository',
      create: (ctx) => createChangesView(ctx),
    },
    {
      id: 'history',
      label: 'History',
      icon: 'gitGraph',
      group: 'Repository',
      create: (ctx) => createHistoryView(ctx),
    },
    {
      id: 'branches',
      label: 'Branches',
      icon: 'gitBranch',
      group: 'Repository',
      create: (ctx) => createBranchesView(ctx),
    },
    {
      id: 'stashes',
      label: 'Stashes',
      icon: 'gitStash',
      group: 'Repository',
      create: (ctx) => createStashesView(ctx),
    },
    {
      id: 'worktrees',
      label: 'Worktrees',
      icon: 'gitWorktree',
      group: 'Repository',
      create: (ctx) =>
        createWorktreesView(ctx, {
          onSelectWorktree: (path) => void ctx.openWorktree?.(path),
        }),
    },
    {
      id: 'pulls',
      label: 'Pull requests',
      icon: 'gitPullRequest',
      group: 'GitHub',
      create: (ctx) => createPullsView(ctx, { getForgeStatus: () => forge }),
    },
    {
      id: 'checks',
      label: 'Actions',
      icon: 'workflow',
      group: 'GitHub',
      create: (ctx) => createActionsView(ctx, { getForgeStatus: () => forge }),
    },
    { id: 'releases', label: 'Releases', icon: 'tags', group: 'GitHub', create: (ctx) => createReleasesView(ctx) },
  ];
}

function sectionContext(): SccContext {
  const workspace = getWorkspacePath().trim();
  const cwd = effectiveCwd() ?? (workspace || undefined);
  const repo = currentRepository();
  const version = checkoutVersion;
  const current = () => version === checkoutVersion;
  return {
    getCwd: () => cwd,
    getBranch: () => current() ? currentBranch : '',
    repoKey: repo ? `${workspace}\0${repo.id}` : cwd,
    sharedCheckout: () => current() && cwd ? sharedCheckout(cwd, workspace) : undefined,
    newThreadInCheckout: async (path, branch) => {
      if (!current()) return;
      const checkout = repo && worktreePathsEqual(path, repo.absPath) ? repoScopePath : path;
      const { createChatWithMode } = await import('./sidebar');
      if (!current() || getWorkspacePath() !== workspace) return;
      const result = await createChatWithMode({
        modeId: 'general', workspacePath: workspace, forceNewChat: true,
        ...(!worktreePathsEqual(checkout, workspace) ? { checkoutTarget: { cwd: checkout, branch } } : {}),
      });
      if (!result.ok) showToast(result.error ?? 'Could not start a thread in this checkout', 'error');
      else navigateToCodeChat();
    },
    refreshAll: async () => { if (current()) await refreshAll(); },
    refreshSection: async () => { if (current()) await activeView?.refresh(); },
    goTo: (section) => { if (current()) void showSection(section); },
    setBadge: (section, badge) => { if (current()) applyRailBadge(section, badge); },
    openWorktree: async (path) => { if (current()) await setCwd(path, repo?.id); },
  };
}

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
  header.dataset.appTitlebar = '';

  const identity = el('div', 'scc-head__identity');
  const repoContext = el('div', 'scc-head__context');
  const dragGap = el('div', 'scc-head__drag-gap');
  dragGap.setAttribute('aria-hidden', 'true');

  repoNameEl = el('span', 'scc-head__repo');
  repoLabelEl = el('span', 'scc-head__repo-label');
  identity.append(
    createBackToChatButton(closeSourceControlCenter),
    el('h1', 'scc-head__title', 'Source Control'),
    repoContext,
    dragGap,
  );

  repoBtn = button({
    icon: 'folder',
    label: '—',
    title: 'Switch repository',
    className: 'scc-head__context-btn scc-head__repo-switch',
    onClick: () => openRepoSwitcher(),
  });
  repoBtn.appendChild(createIcon('chevronDown', { className: 'scc-btn__icon', size: 12 }));
  repoBtn.hidden = true;

  branchBtn = button({
    icon: 'gitBranch',
    label: '—',
    title: 'Switch branch',
    className: 'scc-head__context-btn scc-head__branch',
    onClick: () => openBranchSwitcher(),
  });
  branchBtn.appendChild(createIcon('chevronDown', { className: 'scc-btn__icon', size: 12 }));

  worktreeBtn = button({
    icon: 'gitWorktree',
    label: 'Local',
    title: 'Browse worktrees',
    className: 'scc-head__context-btn scc-head__worktree',
    onClick: () => showSection('worktrees'),
  });

  forgeChipEl = el('span', 'scc-head__forge');
  forgeChipEl.hidden = true;
  followChatBtn = button({
    icon: 'appChat',
    label: 'Show chat’s checkout',
    variant: 'ghost',
    title: 'Show the checkout the active chat uses',
    className: 'scc-head__follow',
    onClick: () => {
      const chatCwd = activeChatCheckout();
      if (chatCwd !== null) void showCheckoutScope(chatCwd, false, selectedRepoId);
    },
  });
  followChatBtn.hidden = true;
  repoContext.append(repoNameEl, repoBtn, repoLabelEl, worktreeBtn, branchBtn, followChatBtn, forgeChipEl);

  const sync = el('div', 'scc-head__sync');
  syncEl = sync;
  sync.setAttribute('role', 'group');
  sync.setAttribute('aria-label', 'Remote sync');

  fetchBtn = button({
    icon: 'gitFetch',
    label: 'Fetch',
    title: 'Fetch from every remote',
    className: 'scc-head__fetch',
    onClick: () => void runPrimarySync('Fetch'),
  });

  pullBtn = button({
    icon: 'gitPull',
    label: 'Pull',
    title: 'Pull from upstream',
    className: 'scc-head__pull',
    onClick: () => void runPrimarySync('Pull'),
  });

  pushBtn = button({
    icon: 'gitPush',
    label: 'Push',
    title: 'Push to upstream',
    className: 'scc-head__push',
    onClick: () => void runPrimarySync('Push'),
  });

  for (const action of [pullBtn, pushBtn]) {
    const count = el('span', 'scc-head__sync-count');
    count.hidden = true;
    count.setAttribute('aria-hidden', 'true');
    action.appendChild(count);
  }
  const syncMenu = button({
    icon: 'chevronDown', title: 'Sync options', className: 'scc-head__sync-menu',
    onClick: () => openSyncMenu(syncMenu),
  });
  syncMenu.setAttribute('aria-haspopup', 'menu');
  sync.append(fetchBtn, pullBtn, pushBtn, syncMenu);

  const actions = el('div', 'scc-head__actions');

  const paletteBtn = button({
    icon: 'search',
    label: 'Commands',
    variant: 'ghost',
    title: 'Run a git command',
    className: 'scc-head__palette-btn',
    onClick: () => openCommandPalette(),
  });
  paletteBtn.setAttribute('aria-label', 'Commands');
  paletteBtn.appendChild(el('kbd', 'scc-head__kbd', modKeyLabel('K')));

  actions.append(paletteBtn);

  header.append(identity, sync, actions);
  return header;
}

function syncPreferenceKey(): string {
  const path = normalizeWorkspacePath(getWorkspacePath());
  return `minnow.scc.sync-all:${/^[A-Z]:\//i.test(path) ? path.toLowerCase() : path}`;
}

function mainButtonsSyncAll(): boolean {
  if (workspaceRepos.length < 2) return false;
  const key = syncPreferenceKey();
  const remembered = syncAllByWorkspace.get(key);
  if (remembered !== undefined) return remembered;
  let enabled = false;
  try { enabled = globalThis.localStorage?.getItem(key) === 'true'; } catch { /* Storage may be blocked. */ }
  syncAllByWorkspace.set(key, enabled);
  return enabled;
}

function setMainButtonsSyncAll(enabled: boolean): void {
  const key = syncPreferenceKey();
  syncAllByWorkspace.set(key, enabled);
  try { globalThis.localStorage?.setItem(key, String(enabled)); } catch { /* Keep the preference for this view. */ }
  paintSyncMode();
}

function syncTargets(): { label: string; cwd: string }[] {
  const selected = currentRepository();
  const checkout = effectiveCwd() ?? getWorkspacePath();
  return workspaceRepos.map(repo => ({
    label: repoLabel(repo).label,
    cwd: repo.id === selected?.id ? checkout : repo.absPath,
  }));
}

function openSyncMenu(dropdown: HTMLButtonElement): void {
  if (busy || workspaceRepos.length < 2) return;
  const version = checkoutVersion;
  const workspace = getWorkspacePath();
  const current = () => version === checkoutVersion && workspace === getWorkspacePath() && isSourceControlCenterOpen();
  const targets = syncTargets();
  const enabled = mainButtonsSyncAll();
  const menu = openContextMenu({
    anchor: dropdown,
    restoreFocus: dropdown,
    label: 'Sync options',
    items: [
      ...(Object.keys(syncActions) as SyncAction[]).map(action => ({
        id: `sync-all:${action}`,
        label: `${action} all`,
        onSelect: () => { if (current()) return runSyncAll(action, targets); },
      })),
      { kind: 'separator' },
      {
        id: 'sync-all:main-buttons', label: 'Main buttons sync all repos', checked: enabled,
        onSelect: () => { if (current()) setMainButtonsSyncAll(!enabled); },
      },
    ],
  });
  menu.root.classList.add('scc-sync-options');
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

  const footnote = el('p', 'scc-rail__footnote');
  const footnoteText = el('span', undefined, 'Commit messages and summaries use your utility model.');
  footnote.append(createIcon('sparkles', { size: 13 }), footnoteText);
  railEl.appendChild(footnote);
  void loadUtilityModelConfig().then(({ modelId }) => {
    const model = modelId.trim();
    if (!model) return;
    footnoteText.replaceChildren('Commit messages and summaries use ', el('strong', undefined, model), '.');
  }).catch(() => undefined);

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
  const cached = viewCache.get(id);
  activeView = cached ?? def.create(sectionContext());
  if (!cached) viewCache.set(id, activeView);

  paneEl.replaceChildren(activeView.root);
  paneEl.setAttribute('aria-label', def.label);

  for (const item of railEl?.querySelectorAll<HTMLElement>('.scc-rail__item') ?? []) {
    const isActive = item.dataset.section === id;
    item.classList.toggle('is-active', isActive);
    item.setAttribute('aria-current', String(isActive));
    if (isActive) revealInTabStrip(item);
  }

  activeView.activate?.();
  // A kept page shows what it had at once; bring it up to date behind the scenes.
  if (cached) void refreshActiveView();
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

const gitStatePoll = createPollingTask(async signal => {
  const version = checkoutVersion;
  const cwd = effectiveCwd();
  const current = () => !signal.aborted && isSourceControlCenterOpen() && version === checkoutVersion;
  const status = await gitStatus(cwd, signal);
  if (!current()) return;

  if (!status.ok) {
    if (discoveryFailed || isMissingGitRepositoryError(status.error)) {
      setNoRepo(true);
      return;
    }
    setNoRepo(false);
    return;
  }

  setNoRepo(false);
  const branchResult = await gitBranches(cwd, signal);
  if (!current()) return;
  if (branchResult.ok) {
    currentBranch = branchResult.current ?? '';
    localBranches = filterUserFacingBranches(branchResult.local ?? []);
    remoteBranches = branchResult.remote ?? [];
    lockedLocalBranches = branchResult.lockedLocal ?? [];
  }

  paintHeader();
  paintSyncCount(pullBtn, 'Pull', status.behind ?? 0);
  paintSyncCount(pushBtn, 'Push', status.ahead ?? 0);

  await refreshGitRailBadges((section, badge) => { if (current()) applyRailBadge(section, badge); }, {
    cwd,
    status,
    branchCount: localBranches.length + new Set(remoteBranches.filter((ref) => !isSkippedRemoteRef(ref)).map(displayRemoteRef)).size,
  });
});

function refreshGitState(): Promise<void> { return gitStatePoll.run(); }

let forgeStatePending: { version: number; promise: Promise<void> } | undefined;
function refreshForgeState(): Promise<void> {
  const version = checkoutVersion;
  if (forgeStatePending?.version === version) return forgeStatePending.promise;
  const promise = refreshForgeStateInner().finally(() => {
    if (forgeStatePending?.promise === promise) forgeStatePending = undefined;
  });
  forgeStatePending = { version, promise };
  return promise;
}

async function refreshForgeStateInner(): Promise<void> {
  const version = checkoutVersion;
  const cwd = effectiveCwd();
  const result = await forgeStatus(cwd);
  const current = () => isSourceControlCenterOpen() && checkoutVersion === version;
  if (!current()) return;
  forge = result;
  paintForgeChip();
  await refreshForgeRailBadges((section, badge) => { if (current()) applyRailBadge(section, badge); }, {
    cwd,
    branch: currentBranch,
    forge,
  });
}

// ── Header ───────────────────────────────────────────────────────────────────

function currentRepository(): WorkspaceRepo | null {
  return workspaceRepos.find(repo => repo.id === selectedRepoId) ?? null;
}

/** The full checkout folder a chat would use for the current Git target. */
function viewingCheckout(): string | undefined {
  return repoForPanelCwd(panelCwd, workspaceRepos, repoScopePath)
    ? resolvePanelWorktreeCwd(repoScopePath) : panelCwd;
}

function sharedCheckout(cwd: string, workspace: string) {
  const repo = repoForPanelCwd(cwd, workspaceRepos, repoScopePath);
  const folders = repo ? [cwd, repoScopePath] : [cwd];
  const active = sessionState ? getActiveChat() : null;
  const otherChats = otherChatsUsingCheckout({ id: active?.id ?? '' }, folders, workspace).length;
  return otherChats ? { otherChats } : undefined;
}

function paintHeader(): void {
  const workspace = getWorkspacePath().trim();
  syncEl?.toggleAttribute('data-multi-repo', workspaceRepos.length > 1);
  paintSyncMode();

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

  const currentRepo = currentRepository();
  const repositoryLabel = currentRepo ? repoLabel(currentRepo).label : 'Choose repository';
  if (repoBtn) {
    repoBtn.hidden = workspaceRepos.length < 2;
    const label = repoBtn.querySelector('.scc-btn__label');
    if (label) label.textContent = repositoryLabel;
    repoBtn.title = currentRepo ? `Switch repository · ${repositoryLabel}` : 'Switch repository';
    repoBtn.setAttribute('aria-haspopup', 'menu');
  }
  if (repoLabelEl) {
    repoLabelEl.hidden = !currentRepo || currentRepo.isRoot || workspaceRepos.length > 1;
    repoLabelEl.textContent = repositoryLabel;
  }

  const viewing = viewingCheckout();
  if (worktreeBtn) {
    const label = worktreeBtn.querySelector('.scc-btn__label');
    const name = viewing ? displayWorktreeTitle({ path: viewing, branch: currentBranch || undefined }) : 'Local';
    if (label) label.textContent = name;
    worktreeBtn.classList.toggle('is-secondary-worktree', Boolean(viewing));
    worktreeBtn.title = viewing ? `Browsing ${viewing}` : 'Browsing the Local checkout';
  }

  if (followChatBtn && worktreeBtn) {
    // Say when Source Control is not looking at the active chat's checkout.
    const chatCwd = activeChatCheckout();
    // A repo root inside the workspace counts as the main checkout here too.
    const differs = chatCwd !== null && !(chatCwd === undefined
      ? viewing === undefined || worktreePathsEqual(viewing, workspace)
      : viewing !== undefined && worktreePathsEqual(viewing, chatCwd));
    followChatBtn.hidden = !differs;
    if (differs) {
      const chatName = sessionState ? getActiveChat().name || 'The active chat' : 'The active chat';
      const where = chatCwd ? displayWorktreeTitle({ path: chatCwd }) : 'the Local checkout';
      followChatBtn.title = `${chatName} uses ${where}. Show that checkout.`;
      worktreeBtn.title = `${worktreeBtn.title}\n${chatName} uses ${where}, not this checkout.`;
    }
  }
}

/** Checkout the active chat runs in: undefined for the workspace, null without a chat. */
function activeChatCheckout(): string | undefined | null {
  if (!sessionState) return null;
  const chat = getActiveChat();
  const cwd = resolvePanelWorktreeCwd(resolvePanelBrowseCwd({ chat, groups: sessionState.groups }));
  return cwd && !worktreePathsEqual(cwd, getWorkspacePath()) ? cwd : undefined;
}

function openRepoSwitcher(): void {
  if (!repoBtn || workspaceRepos.length < 2) return;
  openContextMenu({
    anchor: repoBtn,
    restoreFocus: repoBtn,
    label: 'Switch repository',
    items: buildRepoMenuItems(workspaceRepos, selectedRepoId ?? null, (repo) => void selectRepo(repo)),
  });
}

async function selectRepo(repo: WorkspaceRepo): Promise<void> {
  if (repo.id === selectedRepoId) return;
  rememberRepo(getWorkspacePath(), repo.id);
  await setCwd(repoPanelCwd(repo) ?? repoScopePath, repo.id);
}

/**
 * Load the workspace's repos. When the center opens on the workspace itself
 * and the folder holds repos below it, point it at the right one first.
 */
async function loadWorkspaceRepos(cwd: string | undefined, refresh = false, preferredRepoId?: string): Promise<{ cwd?: string; repoId?: string } | null> {
  const request = ++scopeRequest;
  const workspace = getWorkspacePath();
  const discovered = await lookupWorkspaceRepos({ workspacePath: workspace, refresh });
  let repos = discovered ?? (checkoutWorkspace === workspace && repoScopePath === workspace ? workspaceRepos : []);
  const checkout = resolvePanelWorktreeCwd(cwd);
  let scope = workspace;
  let repo = repoForPanelCwd(checkout, repos, workspace);
  if (checkout && !repo) {
    const checkoutRepos = await lookupWorkspaceRepos({ checkoutPath: checkout, refresh });
    if (checkoutRepos?.some(repo => !repo.isRoot)) {
      repos = checkoutRepos;
      scope = checkout;
    } else if (checkoutRepos?.length) {
      const listed = await listWorktrees(checkout);
      const principal = getPrincipalWorktree(listed.worktrees ?? parseWorktreeListPorcelain(listed.output ?? ''));
      if (principal) repo = repoForPanelCwd(principal.path, repos, workspace);
    }
  }
  if (request !== scopeRequest || workspace !== getWorkspacePath()) return null;
  workspaceRepos = repos;
  repoScopePath = scope;
  discoveryFailed = discovered === null;
  if (checkout && scope === workspace) return { cwd: checkout, repoId: repo?.id };
  const pick = pickDefaultRepo(repos, {
    workspacePath: scope,
    activeFilePath: getActiveViewerTabPath(),
    remembered: preferredRepoId ?? readRememberedRepo(workspace),
  });
  return { cwd: pick?.isRoot ? resolvePanelWorktreeCwd(scope) : pick?.absPath ?? checkout, repoId: pick?.id };
}

function paintSyncCount(action: HTMLButtonElement | null, label: 'Pull' | 'Push', count: number): void {
  if (!action) return;
  const badge = action.querySelector<HTMLElement>('.scc-head__sync-count')!;
  const text = count > 0 ? String(count) : '';
  const all = mainButtonsSyncAll();
  const commits = `${count} commit${count === 1 ? '' : 's'}`;
  if (badge.textContent !== text) badge.textContent = text;
  badge.hidden = all || !text;
  action.setAttribute('aria-label', all ? `${label} all repositories` : text ? `${label}, ${commits}` : label);
  const direction = label === 'Pull' ? 'from' : 'to';
  action.title = all ? `${label} all repositories` : text ? `${commits} to ${label.toLowerCase()}` : `${label} ${direction} upstream`;
}

function paintSyncMode(): void {
  const all = mainButtonsSyncAll();
  for (const [button, label] of [[fetchBtn, 'Fetch'], [pullBtn, 'Pull'], [pushBtn, 'Push']] as const) {
    const text = button?.querySelector('.scc-btn__label');
    const next = all ? `${label} all` : label;
    if (text && text.textContent !== next) text.textContent = next;
  }
  if (fetchBtn) {
    fetchBtn.title = all ? 'Fetch all repositories' : 'Fetch from every remote';
    fetchBtn.setAttribute('aria-label', all ? 'Fetch all repositories' : 'Fetch');
  }
  paintSyncCount(pullBtn, 'Pull', Number(pullBtn?.querySelector('.scc-head__sync-count')?.textContent ?? 0));
  paintSyncCount(pushBtn, 'Push', Number(pushBtn?.querySelector('.scc-head__sync-count')?.textContent ?? 0));
}

function paintForgeChip(): void {
  if (!forgeChipEl) return;

  if (!forge || forge.host === 'none') {
    forgeChipEl.hidden = true;
    return;
  }

  forgeChipEl.hidden = false;
  forgeChipEl.classList.toggle('is-inactive', !forge.supported);
  const isGitHub = forge.host === 'github' || forge.host === 'github-enterprise';
  forgeChipEl.replaceChildren(
    ...(isGitHub ? [createGitHubMark({ size: 13 })] : []),
    el('span', undefined, forge.repo || forge.hostname),
  );
  forgeChipEl.title = forge.supported
    ? `Connected to ${forge.hostname} as the signed-in gh user`
    : forge.reason;
}

function setNoRepo(active: boolean): void {
  root?.classList.toggle('scc-root--no-repo', active);
  if (!noRepoEl) return;

  noRepoEl.hidden = !active;
  const state = discoveryFailed ? 'failed' : 'empty';
  if (active && (!noRepoEl.firstChild || noRepoEl.dataset.state !== state)) {
    noRepoEl.dataset.state = state;
    if (discoveryFailed) {
      noRepoEl.replaceChildren(emptyState({
        icon: 'folder', title: 'Could not discover repositories',
        body: 'Minnow could not read the repositories in this workspace.',
        action: button({ label: 'Retry repository discovery', onClick: () => void showCheckoutScope(viewingCheckout(), true) }),
      }));
    } else renderGitNoRepositoryState(noRepoEl);
  }
  if (!active) noRepoEl.replaceChildren();
}

async function refreshAll(): Promise<void> {
  const version = checkoutVersion;
  await refreshGitState();
  if (version !== checkoutVersion) return;
  if (activeSection === 'pulls' || activeSection === 'checks') {
    const status = await forgeRefresh(effectiveCwd());
    if (version !== checkoutVersion) return;
    forge = status;
    paintForgeChip();
  }
  await refreshActiveView();
}

async function runOp(
  fn: () => Promise<GitOpResult>,
  successMessage?: string,
  recoveryActions?: RunGitUiOpOptions['recoveryActions'],
): Promise<boolean> {
  if (busy) return false;
  setSyncBusy(true);
  try {
    const result = await runGitUiOp(fn, {
      label: inferGitUiLabel(successMessage),
      successMessage,
      ctx: gitUiCtx(effectiveCwd(), currentBranch),
      recoveryActions,
    });
    if (!result.ok) return false;
    await refreshAll();
    return true;
  } finally {
    setSyncBusy(false);
  }
}

function setSyncBusy(value: boolean): void {
  busy = value;
  root?.classList.toggle('is-busy', value);
  for (const button of syncEl?.querySelectorAll<HTMLButtonElement>('button') ?? []) button.disabled = value;
}

async function runPrimarySync(action: SyncAction): Promise<void> {
  if (mainButtonsSyncAll()) return runSyncAll(action, syncTargets());
  const { run, success } = syncActions[action];
  await runOp(() => run(effectiveCwd(), undefined), success);
}

async function runSyncAll(action: SyncAction, targets: { label: string; cwd: string }[]): Promise<void> {
  if (busy) return;
  const { run, progress, completed } = syncActions[action];
  const issues: string[] = [];
  let succeeded = 0;
  setSyncBusy(true);
  try {
    await runGitUiOp(async () => {
      for (const { label, cwd } of targets) {
        try {
          const result = await run(cwd, label);
          if (result.ok) succeeded += 1;
          else issues.push(`${label}\n${result.error === 'cancelled' ? 'Skipped' : result.error || 'Git operation failed'}`);
        } catch (error) {
          issues.push(`${label}\n${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return { ok: true };
    }, { label: `${progress} ${targets.length} repositories…`, skipSuccessToast: true });
    const summary = `${completed} ${succeeded} of ${targets.length} repositories`;
    if (issues.length) void appAlert(issues.join('\n\n'), summary);
    else showToast(summary, 'success');
    await refreshAll();
  } finally {
    setSyncBusy(false);
  }
}

/** Point the center and its section views at a different checkout. */
function changeCwd(next: string | undefined, repoId?: string): void {
  const workspace = getWorkspacePath();
  if (workspace === checkoutWorkspace && selectedRepoId === repoId &&
    (next === panelCwd || (next && panelCwd && worktreePathsEqual(next, panelCwd)))) return;
  checkoutWorkspace = workspace;
  panelCwd = next;
  selectedRepoId = repoId;
  checkoutVersion += 1;
  gitStatePoll.cancel();
  forge = null;
  currentBranch = '';
  localBranches = [];
  remoteBranches = [];
  lockedLocalBranches = [];
  for (const section of badges.keys()) applyRailBadge(section, null);
  dropCachedViews();
  activeView = null;
  setNoRepo(false);
  paintHeader();
  paintForgeChip();
  paintSyncCount(pullBtn, 'Pull', 0);
  paintSyncCount(pushBtn, 'Push', 0);
}

async function setCwd(path: string | undefined, repoId?: string): Promise<void> {
  scopeRequest += 1;
  changeCwd(resolvePanelWorktreeCwd(path), repoId);
  const version = checkoutVersion;
  paintHeader();
  await showSection(activeSection);
  await refreshAll();
  if (version === checkoutVersion) await refreshForgeState();
}

async function showCheckoutScope(cwd: string | undefined, refresh = false, preferredRepoId?: string): Promise<void> {
  const next = await loadWorkspaceRepos(cwd, refresh, preferredRepoId);
  if (next) await setCwd(next.cwd, next.repoId);
}

function openBranchSwitcher(): void {
  if (!branchBtn) return;
  const { openWorktree, sharedCheckout: getGuard } = sectionContext();
  const cwd = effectiveCwd() ?? getWorkspacePath();
  const expectedBranch = currentBranch || undefined;
  openGitBranchSwitchPopover({
    anchor: branchBtn,
    title: 'Switch branch',
    cwd,
    // The poll keeps these fresh; before its first pass the popover fetches for itself.
    branchLists: localBranches.length
      ? {
          current: currentBranch,
          local: localBranches,
          remote: remoteBranches,
          lockedLocal: lockedLocalBranches,
        }
      : undefined,
    onSubmit: async ({ name, kind, startPoint }) => {
      if (!name || name === expectedBranch) return;

      await runOp(
        () => checkoutBranchWithChoice(
          { branch: name, create: kind !== 'local', startPoint, cwd, expectedBranch },
          () => worktreePathsEqual(cwd, effectiveCwd() ?? getWorkspacePath()),
          { openWorktree, shared: getGuard?.() },
        ),
        kind === 'local' ? `Switched to ${name}` : `Created and checked out ${name}`,
        (failed) => checkoutRecoveryActions(failed, { cwd, openWorktree }),
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
  const version = checkoutVersion;
  const cwd = effectiveCwd();
  const branch = currentBranch;
  const listed = await runGitUiOp(() => prList({ cwd, state: 'open' }), {
    label: 'Listing pull requests…',
    chatKind: 'pr',
    ctx: gitUiCtx(cwd, branch),
    skipSuccessToast: true,
  });
  if (!listed.ok || version !== checkoutVersion) {
    return;
  }
  const match = matchPrForBranch(listed.prs ?? [], branch);
  if (!match) {
    showToast('No open pull request for this branch', 'error');
    return;
  }
  requestPullsSelection(match.number, sectionContext().repoKey);
  await showSection('pulls');
  void refreshActiveView();
  const result = await runGitUiOp(
    () =>
      startPrReview({
        cwd,
        repo,
        number: match.number,
      }),
    {
      label: 'Starting review…',
      successMessage: `Reviewing #${match.number}`,
      chatKind: 'pr',
      ctx: gitUiCtx(cwd, branch),
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
    keywords: id === 'pulls' ? 'pr github review list' : id === 'checks' ? 'ci actions workflow build test' : id,
    available: id === 'pulls' || id === 'checks' ? onGitHub : undefined,
    run: () => void showSection(id),
  });

  return [
    jump('changes', 'Changes', modKeyLabel('1')),
    jump('history', 'History', modKeyLabel('2')),
    jump('branches', 'Branches', modKeyLabel('3')),
    jump('stashes', 'Stashes', modKeyLabel('4')),
    jump('worktrees', 'Worktrees', modKeyLabel('5')),
    jump('pulls', 'Pull requests', modKeyLabel('6')),
    jump('checks', 'Actions', modKeyLabel('7')),
    jump('releases', 'Releases', modKeyLabel('8')),

    {
      id: 'checkout.new-thread',
      title: 'New thread in this checkout',
      group: 'Worktrees',
      available: () => Boolean(viewingCheckout()),
      run: () => {
        const cwd = effectiveCwd();
        if (cwd) void sectionContext().newThreadInCheckout?.(cwd, currentBranch);
      },
    },

    ...(workspaceRepos.length > 1 ? workspaceRepos.map((repo): Command => ({
      id: `repo.${repo.id}`,
      title: `Switch to repository ${repoLabel(repo).label}`,
      group: 'Repository',
      keywords: `repo repository ${repo.id} ${repoLabel(repo).hint ?? ''}`,
      run: () => void selectRepo(repo),
    })) : []),

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
      run: () => void runOp(() => pushWithPublishPrompt(effectiveCwd()), 'Pushed changes'),
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
        const cwd = effectiveCwd() ?? getWorkspacePath();
        const expectedBranch = currentBranch || undefined;
        openGitRefNamePopover({
          anchor,
          title: 'New branch',
          kind: 'branch',
          cwd,
          defaultPath: cwd,
          reserved: [currentBranch, 'main', 'master'],
          onSubmit: async (result) => {
            await runOp(
              () =>
                checkoutBranchWithChoice(
                  { branch: result.name, create: true, startPoint: result.startPoint, cwd, expectedBranch },
                  () => worktreePathsEqual(cwd, effectiveCwd() ?? getWorkspacePath()),
                ),
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
      id: 'worktree.main',
      title: 'Return to the main worktree',
      group: 'Worktree',
      keywords: 'switch root workspace',
      available: () => Boolean(panelCwd),
      run: () => void setCwd(undefined),
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
  'releases',
];

// ── Keys ─────────────────────────────────────────────────────────────────────

function handleKey(event: KeyboardEvent): void {
  if (!isSourceControlCenterOpen()) return;

  const mod = event.ctrlKey || event.metaKey;

  if (isCommandPaletteOpen() || isContextMenuOpen() || isAppDialogOpen()) return;

  if (mod && /^[1-8]$/.test(event.key)) {
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
    if (document.hidden || busy || gitPollInFlight || !isSourceControlCenterOpen()) return;
    gitPollInFlight = true;
    void (async () => {
      try {
        await refreshGitState();
        if (activeSection !== 'pulls' && activeSection !== 'checks') await refreshActiveView();
      } finally { gitPollInFlight = false; }
    })().catch(() => {});
  }, GIT_POLL_MS);

  forgeTimer = window.setInterval(() => {
    if (document.hidden || busy || forgePollInFlight || !isSourceControlCenterOpen()) return;
    forgePollInFlight = true;
    void (async () => {
      try {
        await refreshForgeState();
        if (isSourceControlCenterOpen() && (activeSection === 'pulls' || activeSection === 'checks')) {
          await refreshActiveView();
        }
      } finally { forgePollInFlight = false; }
    })().catch(() => {});
  }, FORGE_POLL_MS);
}

function stopPolling(): void {
  if (gitTimer) window.clearInterval(gitTimer);
  if (forgeTimer) window.clearInterval(forgeTimer);
  gitTimer = undefined;
  forgeTimer = undefined;
}

/** Open the dedicated Source Control app from any existing entry point. */
export async function openSourceControlCenter(options?: {
  section?: SccSectionId;
  cwd?: string;
}): Promise<void> {
  pendingOpenOptions = options;
  if (isSourceControlCenterOpen()) {
    await mountSourceControlCenter();
    return;
  }
  launchApp('source-control');
}

/** Mount the full git surface in its own shell layer. */
export async function mountSourceControlCenter(): Promise<void> {
  const options = pendingOpenOptions;
  pendingOpenOptions = undefined;
  const workspaceChanged = checkoutWorkspace && checkoutWorkspace !== getWorkspacePath();
  const currentCheckout = root && !workspaceChanged ? viewingCheckout() : activeChatCheckout() ?? undefined;
  const next = await loadWorkspaceRepos(options?.cwd ?? currentCheckout);
  if (!next) return;
  changeCwd(next.cwd, next.repoId);
  if (root) {
    paintHeader();
    await showSection(options?.section ?? activeSection);
    await refreshAll();
    return;
  }
  const area = document.getElementById('sourceControlView');
  if (!area) return;

  activeSection = options?.section ?? 'changes';
  badges.clear();

  root = buildShell();
  area.replaceChildren(root);
  paintHeader();

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

  void refreshForgeState().then(async () => {
    if (activeSection === 'pulls' || activeSection === 'checks') await refreshActiveView();
  }).catch(() => {});

  const { notifyAskQuestionDisplayContextChanged } = await import('../chat/ask-question-display');
  notifyAskQuestionDisplayContextChanged();
}

/** Return to Code without replacing or rebuilding the chat transcript. */
export function closeSourceControlCenter(): void {
  gitStatePoll.cancel();
  if (isSourceControlCenterOpen()) void returnToChat();
}

/** Toggle the center from the sidebar button. */
export function toggleSourceControlCenter(): void {
  if (isSourceControlCenterOpen()) closeSourceControlCenter();
  else void openSourceControlCenter();
}

/** Reset module state (tests). */
export function resetSourceControlCenterForTests(): void {
  gitStatePoll.cancel();
  stopPolling();
  if (keyHandler) {
    document.removeEventListener('keydown', keyHandler, true);
    keyHandler = null;
  }
  unregisterGlobalCommands?.();
  unregisterGlobalCommands = null;
  dropCachedViews();
  activeView = null;
  document.getElementById(ROOT_ID)?.remove();
  root = null;
  railEl = null;
  paneEl = null;
  noRepoEl = null;
  pendingOpenOptions = undefined;
  panelCwd = undefined;
  workspaceRepos = [];
  repoScopePath = '';
  selectedRepoId = undefined;
  discoveryFailed = false;
  checkoutWorkspace = '';
  scopeRequest += 1;
  checkoutVersion += 1;
  repoBtn = null;
  syncEl = null;
  fetchBtn = pullBtn = pushBtn = null;
  syncAllByWorkspace.clear();
  currentBranch = '';
  localBranches = [];
  remoteBranches = [];
  lockedLocalBranches = [];
  forge = null;
  busy = false;
  forgePollInFlight = false;
  gitPollInFlight = false;
  activeSection = 'changes';
  badges.clear();
}

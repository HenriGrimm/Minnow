/**
 * Git state on sidebar rows: the worktree marker, then the furthest stage the
 * chat's work reached (uncommitted → committed → pull request → merged / closed),
 * plus PR checks. Branch facts come from `gitBranchTree`, PR facts from `prList`
 * (gh). Both are cached per workspace and refreshed in the background, so a
 * render only ever reads what is already known.
 */
import type { Chat } from '../types';
import { gitBranchTree, gitStatus, type GitBranchTreeEntry } from '../state/git-api';
import { prList, type CheckState, type PullRequestSummary } from '../state/forge-api';
import { getWorkspacePath, subscribeWorkspace } from '../state/workspace';
import { createIcon, type IconName } from './icon';

export type ChatGitStage = 'uncommitted' | 'committed' | 'pr-draft' | 'pr-open' | 'merged' | 'closed';

export interface ChatGitState {
  worktree: boolean;
  stage: ChatGitStage | null;
  additions: number;
  deletions: number;
  /** Commits on the branch not yet on its upstream (or not pushed at all). */
  unpushed: number;
  checks: CheckState;
  prNumber?: number;
}

interface WorkspaceGitFacts {
  current: string | null;
  trunk: string | null;
  branches: Map<string, GitBranchTreeEntry>;
  prs: Map<string, PullRequestSummary>;
  /** Checked-out branch against its upstream; null without one. */
  ahead: number | null;
  behind: number | null;
  /** Distinct paths with staged, unstaged or untracked changes. */
  changed: number;
  fetchedAt: number;
  prsFetchedAt: number;
}

/** What the sidebar header shows for the workspace checkout. */
export interface WorkspaceGitSummary {
  branch: string;
  ahead: number | null;
  behind: number | null;
  changed: number;
}

/** Branch and working-tree facts are cheap git calls; PRs go through gh and refresh slower. */
const STALE_MS = 30_000;
const PR_STALE_MS = 120_000;
const facts = new Map<string, WorkspaceGitFacts>();
const inflight = new Set<string>();
const listeners = new Set<() => void>();
let initialized = false;

/** Re-render hook for when fresh facts land. */
export function subscribeSidebarGitState(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Fetch branch and PR facts for a workspace unless they are still fresh. */
export function refreshSidebarGitFacts(cwd: string, force = false): void {
  if (!cwd || inflight.has(cwd)) return;
  const known = facts.get(cwd);
  if (!force && known && Date.now() - known.fetchedAt < STALE_MS) return;
  inflight.add(cwd);
  void (async () => {
    try {
      const refreshPrs = force || !known || Date.now() - known.prsFetchedAt >= PR_STALE_MS;
      const [tree, status, pulls] = await Promise.all([
        gitBranchTree(cwd).catch(() => null),
        gitStatus(cwd).catch(() => null),
        refreshPrs ? prList({ cwd, state: 'all', limit: 100 }).catch(() => null) : Promise.resolve(null),
      ]);
      const branches = new Map((tree?.ok ? tree.branches ?? [] : []).map(entry => [entry.name, entry] as const));
      // A branch can carry several PRs over time; the newest one is its state.
      let prs = known?.prs ?? new Map<string, PullRequestSummary>();
      if (refreshPrs) {
        prs = new Map();
        for (const pr of pulls?.ok ? pulls.prs ?? [] : []) {
          const prior = prs.get(pr.headRef);
          if (!prior || pr.number > prior.number) prs.set(pr.headRef, pr);
        }
      }
      const changedPaths = new Set(status?.ok ? [...status.staged ?? [], ...status.unstaged ?? [], ...status.untracked ?? []].map(file => file.path) : []);
      const current = tree?.ok ? tree.current ?? null : null;
      const upstream = current ? branches.get(current)?.upstream : null;
      facts.set(cwd, {
        current: current ?? (status?.ok ? status.branch ?? null : null),
        trunk: tree?.ok ? tree.trunk ?? null : null,
        branches,
        prs,
        ahead: status?.ok && upstream ? status.ahead ?? 0 : null,
        behind: status?.ok && upstream ? status.behind ?? 0 : null,
        changed: changedPaths.size,
        fetchedAt: Date.now(),
        prsFetchedAt: refreshPrs ? Date.now() : known?.prsFetchedAt ?? 0,
      });
      for (const listener of listeners) listener();
    } finally {
      inflight.delete(cwd);
    }
  })();
}

/** App-level wiring: refresh on start, workspace change, window focus and every 30 seconds (PRs every two minutes). */
export function initSidebarGitState(): void {
  if (initialized) return;
  initialized = true;
  const refresh = (force = false) => refreshSidebarGitFacts(getWorkspacePath(), force);
  refresh();
  subscribeWorkspace(() => refresh());
  window.addEventListener('focus', () => refresh());
  setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, STALE_MS);
}

/** The checkout the header shows, once known. */
export function getWorkspaceGitSummary(cwd: string): WorkspaceGitSummary | null {
  const known = facts.get(cwd);
  if (!known?.current) return null;
  return { branch: known.current, ahead: known.ahead, behind: known.behind, changed: known.changed };
}

export function resetSidebarGitStateForTests(next?: { cwd: string; current?: string; trunk?: string; branches?: GitBranchTreeEntry[]; prs?: PullRequestSummary[]; ahead?: number | null; behind?: number | null; changed?: number }): void {
  facts.clear();
  inflight.clear();
  if (next) {
    facts.set(next.cwd, {
      current: next.current ?? null,
      trunk: next.trunk ?? 'main',
      branches: new Map((next.branches ?? []).map(entry => [entry.name, entry] as const)),
      prs: new Map((next.prs ?? []).map(pr => [pr.headRef, pr] as const)),
      ahead: next.ahead ?? null,
      behind: next.behind ?? null,
      changed: next.changed ?? 0,
      fetchedAt: Date.now(),
      prsFetchedAt: Date.now(),
    });
  }
}

/**
 * Derive one chat's state. A PR outranks everything; unshipped line edits outrank
 * commits (that is the work in front of you); a branch tip already on trunk only
 * counts as merged once the chat shipped, so a fresh branch never reads as done.
 */
export function chatGitState(chat: Chat, cwd: string): ChatGitState {
  const additions = chat.codeChangeTotals?.additions ?? 0;
  const deletions = chat.codeChangeTotals?.deletions ?? 0;
  const state: ChatGitState = { worktree: Boolean(chat.worktreeRoot), stage: null, additions, deletions, unpushed: 0, checks: 'none' };
  const repo = facts.get(cwd);
  const branch = chat.gitBranch?.trim();
  const onTrunk = !branch || branch === repo?.trunk;
  const pr = !onTrunk ? repo?.prs.get(branch!) : undefined;
  if (pr) {
    state.prNumber = pr.number;
    state.stage = pr.state === 'merged' ? 'merged' : pr.state === 'closed' ? 'closed' : pr.draft ? 'pr-draft' : 'pr-open';
    if (state.stage === 'pr-open' || state.stage === 'pr-draft') state.checks = pr.checks;
    return state;
  }
  const entry = !onTrunk ? repo?.branches.get(branch!) : undefined;
  if ((additions || deletions) && !chat.codeChangeShipHandled) {
    state.stage = 'uncommitted';
    return state;
  }
  if (entry?.merged && chat.codeChangeShipHandled) {
    state.stage = 'merged';
    return state;
  }
  if (entry && entry.ahead > 0) {
    state.stage = 'committed';
    state.unpushed = entry.upstream ? entry.upstreamAhead : entry.ahead;
  } else if (chat.codeChangeShipHandled) {
    state.stage = 'committed';
  }
  return state;
}

/** Work that is finished as far as Git can tell: the PR merged or was closed. */
export function isChatWorkFinished(state: ChatGitState): boolean {
  return state.stage === 'merged' || state.stage === 'closed';
}

const STAGE_ICON: Partial<Record<ChatGitStage, { icon: IconName; tone: string; label: string }>> = {
  'pr-draft': { icon: 'gitPullRequestDraft', tone: 'muted', label: 'Draft pull request' },
  'pr-open': { icon: 'gitPullRequest', tone: 'open', label: 'Pull request open' },
  merged: { icon: 'gitMerge', tone: 'merged', label: 'Merged' },
  closed: { icon: 'gitPullRequestClosed', tone: 'closed', label: 'Pull request closed' },
};

function glyph(icon: IconName, tone: string, label: string): HTMLElement {
  const node = createIcon(icon, { className: 'chat-item-git__icon', size: 13 });
  node.dataset.tone = tone;
  node.title = label;
  return node;
}

/** Plain-words summary for the row's label and tooltip. */
export function describeChatGitState(state: ChatGitState): string {
  const parts: string[] = [];
  if (state.worktree) parts.push('worktree');
  if (state.stage === 'uncommitted') parts.push(`uncommitted +${state.additions} −${state.deletions}`);
  else if (state.stage === 'committed') parts.push(state.unpushed ? `committed, ${state.unpushed} not pushed` : 'committed');
  else if (state.stage) parts.push(`${STAGE_ICON[state.stage]!.label.toLowerCase()}${state.prNumber ? ` #${state.prNumber}` : ''}`);
  if (state.checks === 'failure') parts.push('checks failed');
  else if (state.checks === 'success') parts.push('checks passing');
  return parts.join(', ');
}

/**
 * At most two marks: the stage, preceded by the worktree marker — or followed by
 * the PR's checks, which matter more than where the files live.
 */
export function syncChatGitState(host: HTMLElement, state: ChatGitState): void {
  const key = JSON.stringify(state);
  if (host.dataset.gitKey === key) return;
  host.dataset.gitKey = key;
  const marks: HTMLElement[] = [];
  const checks = state.checks === 'failure' ? glyph('checksFailed', 'closed', 'Checks failed')
    : state.checks === 'success' ? glyph('checksPassed', 'open', 'Checks passing') : null;
  if (state.worktree && !checks) marks.push(glyph('gitWorktree', 'muted', 'Worktree'));
  if (state.stage === 'uncommitted') {
    const counts = document.createElement('span');
    counts.className = 'chat-item-git__counts';
    const add = document.createElement('span'); add.className = 'chat-item-git__add'; add.textContent = `+${state.additions}`;
    counts.append(add);
    if (state.deletions) {
      const del = document.createElement('span'); del.className = 'chat-item-git__del'; del.textContent = `−${state.deletions}`;
      counts.append(del);
    }
    marks.push(counts);
  } else if (state.stage === 'committed') {
    const commit = document.createElement('span');
    commit.className = 'chat-item-git__commit';
    commit.append(glyph('gitCommit', 'muted', state.unpushed ? `${state.unpushed} commits not pushed` : 'Committed'));
    if (state.unpushed) commit.append(`${state.unpushed}↑`);
    marks.push(commit);
  } else if (state.stage) {
    const { icon, tone, label } = STAGE_ICON[state.stage]!;
    marks.push(glyph(icon, tone, state.prNumber ? `${label} #${state.prNumber}` : label));
  }
  if (checks) marks.push(checks);
  host.replaceChildren(...marks);
  host.hidden = marks.length === 0;
  const described = describeChatGitState(state);
  if (described) host.setAttribute('aria-label', described); else host.removeAttribute('aria-label');
}

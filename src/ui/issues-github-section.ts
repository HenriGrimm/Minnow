/**
 * GitHub identity + sync controls that live inside the Issues peek Git section.
 *
 * Open always goes through `openExternal` (system browser). Sync/Push share
 * one click handler so the toolbar Push and the linked-row Sync cannot drift.
 */

import {
  getIssuesGithubMode,
  resolveSyncConflict,
  syncAllIssuesWithGithub,
  syncIssueWithGithub,
  type SyncConflict,
} from '../state/issues-github';
import {
  githubAutoConflictShouldUsePeek,
  githubAutoConflictToast,
} from '../issues/github-auto-conflict';
import { userFacingGithubError } from '../issues/github-error';
import { githubSyncCaption } from '../issues/github-sync-status';
import type { IssueCard } from '../types';
import { openExternalGitUrl } from '../chat/issues/git-actions';
import { createIcon } from './icon';
import {
  beginGitActivity,
  finishGitActivityError,
  finishGitActivitySuccess,
} from './git-activity-overlay';
import { showGitUiFailure } from './git-ui-op';
import { showToast } from './toast';

/** Called after any change so the panel re-renders from store state. */
export type GithubSectionChanged = () => void;

export type GithubSyncButtonOptions = {
  idleLabel: string;
  conflictHost: HTMLElement;
  onChanged: GithubSectionChanged;
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function truncate(text: string, max = 400): string {
  const clean = text.trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

let liveConflictTarget: {
  issueId: string;
  host: HTMLElement;
  onChanged: GithubSectionChanged;
} | null = null;
const pendingConflicts = new Map<string, SyncConflict>();
const conflictListeners = new Set<() => void>();

function notifyGithubSyncConflictListeners(): void {
  for (const listener of conflictListeners) {
    try {
      listener();
    } catch {
      /* ignore */
    }
  }
}

/** True when a GitHub sync conflict is waiting for the user on this card. */
export function hasGithubSyncConflict(issueId: string): boolean {
  return pendingConflicts.has(issueId);
}

/** Re-render list rows when conflicts are stored or cleared. */
export function subscribeGithubSyncConflicts(listener: () => void): () => void {
  conflictListeners.add(listener);
  return () => {
    conflictListeners.delete(listener);
  };
}

/** Test-only reset of in-memory conflict state. */
export function resetGithubSyncConflictsForTests(): void {
  pendingConflicts.clear();
  conflictListeners.clear();
}

/** Two-way mirror is the only mode that may contact GitHub. */
export function githubSyncEnabled(): boolean {
  return getIssuesGithubMode() === 'mirror';
}

const SYNC_ALL_IDLE_LABEL = 'Sync all';

let syncAllInFlight = false;

/** True while a header Sync all pass is running. */
export function isIssuesGithubSyncAllBusy(): boolean {
  return syncAllInFlight;
}

/** Show one conflict in the open peek or toast; batch callers pick which to surface first. */
async function surfaceGithubSyncConflict(conflict: SyncConflict): Promise<void> {
  let openIssueId: string | undefined;
  try {
    const detail = await import('./issues-detail');
    openIssueId = detail.getSelectedIssueId();
  } catch {
    openIssueId = undefined;
  }

  if (githubAutoConflictShouldUsePeek(conflict.issueId, openIssueId)) {
    if (presentGithubSyncConflict(conflict)) return;
  }

  showToast(githubAutoConflictToast(conflict.number), 'error', 6_000);
}

/** Surface conflicts from a bulk sync: peek for the open issue, toast the rest. */
async function surfaceGithubSyncConflicts(conflicts: SyncConflict[]): Promise<void> {
  if (conflicts.length === 0) return;

  if (conflicts.length === 1) {
    await surfaceGithubSyncConflict(conflicts[0]);
    return;
  }

  let openIssueId: string | undefined;
  try {
    const detail = await import('./issues-detail');
    openIssueId = detail.getSelectedIssueId();
  } catch {
    openIssueId = undefined;
  }

  const openConflict = conflicts.find((row) => row.issueId === openIssueId);
  if (openConflict) await surfaceGithubSyncConflict(openConflict);

  const rest = openConflict
    ? conflicts.filter((row) => row.issueId !== openConflict.issueId)
    : conflicts;
  if (rest.length === 0) return;

  const message =
    rest.length === 1
      ? githubAutoConflictToast(rest[0].number)
      : `Both sides changed on ${rest.length} issues. Open an issue to pick.`;
  showToast(message, 'error', 6_000);
}

/** Sync scope for header Sync all — follows the workspace scope control. */
export type IssuesGithubSyncAllScope = {
  scope: 'all' | 'current_workspace';
  workspacePath: string;
};

/** Sync every issue with GitHub (push unlinked, pull/push linked). */
export async function runIssuesGithubSyncAll(
  syncScope: IssuesGithubSyncAllScope,
): Promise<void> {
  if (!githubSyncEnabled()) {
    showToast('Turn on Two-way mirror in Settings → Issues → GitHub', 'error');
    return;
  }
  if (syncAllInFlight) return;

  const btn = document.getElementById('btnIssuesSyncAll') as HTMLButtonElement | null;
  syncAllInFlight = true;
  if (btn) {
    btn.disabled = true;
    setButtonLabel(btn, 'Syncing…');
  }

  const activity = beginGitActivity('Syncing with GitHub…');
  try {
    const { synced, conflicts, errors } = await syncAllIssuesWithGithub({
      scope: syncScope.scope,
      workspacePath: syncScope.workspacePath,
    });
    await surfaceGithubSyncConflicts(conflicts);

    if (errors.length > 0) {
      const first = userFacingGithubError(errors[0]);
      const extra = errors.length > 1 ? ` (+${errors.length - 1} more)` : '';
      finishGitActivityError(activity, {
        error: `${first}${extra}`,
        chatKind: 'github',
      });
    } else if (conflicts.length === 0) {
      if (synced > 0) {
        finishGitActivitySuccess(
          activity,
          synced === 1 ? 'Synced 1 issue with GitHub' : `Synced ${synced} issues with GitHub`,
        );
      } else {
        finishGitActivitySuccess(activity, 'Already in sync with GitHub');
      }
    } else {
      finishGitActivitySuccess(activity);
    }
  } catch {
    finishGitActivityError(activity, {
      error: 'Could not sync with GitHub',
      chatKind: 'github',
    });
  } finally {
    syncAllInFlight = false;
    syncIssuesGithubSyncAllButton();
  }
}

/** Show or hide the header Sync all control based on GitHub mode. */
export function syncIssuesGithubSyncAllButton(): void {
  const btn = document.getElementById('btnIssuesSyncAll');
  if (!btn) return;

  const enabled = githubSyncEnabled();
  btn.hidden = !enabled;
  btn.toggleAttribute('disabled', !enabled || syncAllInFlight);
  btn.textContent = syncAllInFlight ? 'Syncing…' : SYNC_ALL_IDLE_LABEL;
}

function showConflict(
  host: HTMLElement,
  conflict: SyncConflict,
  onChanged: GithubSectionChanged,
): void {
  host.replaceChildren(buildConflictPane(conflict, onChanged));
}

/** Peek Git section registers where Keep mine / Keep GitHub should mount. */
export function registerGithubConflictHost(
  issueId: string,
  host: HTMLElement,
  onChanged: GithubSectionChanged,
): void {
  liveConflictTarget = { issueId, host, onChanged };
  const pending = pendingConflicts.get(issueId);
  if (pending) showConflict(host, pending, onChanged);
}

/** Drop the live host when peek closes. Pending conflicts stay until resolved. */
export function clearGithubConflictHost(issueId?: string): void {
  if (!issueId || liveConflictTarget?.issueId === issueId) {
    liveConflictTarget = null;
  }
}

/**
 * Show the conflict pane when this issue's peek is open.
 * Returns false when the caller should toast instead.
 */
export function presentGithubSyncConflict(conflict: SyncConflict): boolean {
  pendingConflicts.set(conflict.issueId, conflict);
  notifyGithubSyncConflictListeners();
  if (liveConflictTarget?.issueId !== conflict.issueId) return false;
  if (!liveConflictTarget.host.isConnected) return false;
  showConflict(liveConflictTarget.host, conflict, liveConflictTarget.onChanged);
  return true;
}

function clearPendingConflict(issueId: string): void {
  if (!pendingConflicts.delete(issueId)) return;
  notifyGithubSyncConflictListeners();
}

// ── Conflict ─────────────────────────────────────────────────────────────────

function buildConflictPane(
  conflict: SyncConflict,
  onChanged: GithubSectionChanged,
): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'issues-github__conflict';
  wrap.setAttribute('role', 'group');
  wrap.setAttribute('aria-label', 'GitHub sync conflict');

  const head = document.createElement('p');
  head.className = 'issues-github__conflict-head';
  head.textContent =
    'Both sides changed since the last sync. Pick which to keep. Neither is overwritten until you do.';
  wrap.appendChild(head);

  const grid = document.createElement('div');
  grid.className = 'issues-github__conflict-grid';

  const side = (
    label: string,
    fields: SyncConflict['local'],
    keep: 'local' | 'remote',
  ): HTMLElement => {
    const column = document.createElement('div');
    column.className = 'issues-github__conflict-side';

    const title = document.createElement('h4');
    title.className = 'issues-github__conflict-label';
    title.textContent = label;
    column.appendChild(title);

    const heading = document.createElement('p');
    heading.className = 'issues-github__conflict-title';
    heading.textContent = fields.title;
    column.appendChild(heading);

    const body = document.createElement('pre');
    body.className = 'issues-github__conflict-body';
    body.textContent = truncate(fields.body) || '(no description)';
    column.appendChild(body);

    const meta = document.createElement('p');
    meta.className = 'issues-github__conflict-meta';
    meta.textContent = `${fields.closed ? 'closed' : 'open'}${
      fields.labels.length ? ` · ${fields.labels.join(', ')}` : ''
    }`;
    column.appendChild(meta);

    const keepBtn = document.createElement('button');
    keepBtn.type = 'button';
    keepBtn.className = 'issues-btn';
    keepBtn.textContent = keep === 'local' ? 'Keep mine' : 'Keep GitHub';
    keepBtn.addEventListener('click', () => {
      keepBtn.disabled = true;
      void resolveSyncConflict(conflict, keep)
        .then((outcome) => {
          if (!outcome.ok) {
            showGitUiFailure(outcome.error ?? 'Could not resolve the conflict', { chatKind: 'github' });
            keepBtn.disabled = false;
            return;
          }
          clearPendingConflict(conflict.issueId);
          showToast(keep === 'local' ? 'Pushed your version' : 'Took the GitHub version', 'success');
          onChanged();
        })
        .catch(() => {
          showGitUiFailure('Could not resolve the conflict', { chatKind: 'github' });
          keepBtn.disabled = false;
        });
    });
    column.appendChild(keepBtn);
    return column;
  };

  grid.append(side('Yours', conflict.local, 'local'), side('GitHub', conflict.remote, 'remote'));
  wrap.appendChild(grid);
  return wrap;
}

// ── Sync action ──────────────────────────────────────────────────────────────

/** Wire Push / Sync to the same forge path. Idle label is restored on failure. */
/** Rewrite a button's words without dropping its leading glyph. */
function setButtonLabel(btn: HTMLButtonElement, text: string): void {
  const label = btn.querySelector('span');
  if (label) label.textContent = text;
  else btn.textContent = text;
}

export function bindGithubSyncButton(
  btn: HTMLButtonElement,
  issue: IssueCard,
  options: GithubSyncButtonOptions,
): void {
  btn.addEventListener('click', () => {
    const idle = options.idleLabel;
    btn.disabled = true;
    setButtonLabel(btn, 'Syncing…');
    const activity = beginGitActivity('Syncing with GitHub…');
    void syncIssueWithGithub(issue.id)
      .then((outcome) => {
        if (outcome.conflict) {
          finishGitActivitySuccess(activity);
          btn.disabled = false;
          setButtonLabel(btn, idle);
          const shown = presentGithubSyncConflict(outcome.conflict);
          if (!shown && options.conflictHost.isConnected) {
            showConflict(options.conflictHost, outcome.conflict, options.onChanged);
          }
          return;
        }
        if (!outcome.ok) {
          btn.disabled = false;
          setButtonLabel(btn, idle);
          finishGitActivityError(activity, {
            error: outcome.error ?? 'Sync failed',
            chatKind: 'github',
          });
          return;
        }
        finishGitActivitySuccess(activity);
        if (outcome.droppedLabels) {
          const verb = outcome.action === 'create' ? 'Created on GitHub' : 'Pushed to GitHub';
          showToast(`${verb}. Some labels could not be applied there.`, 'success');
        } else if (outcome.action === 'noop') {
          showToast(outcome.error ?? 'Already in sync', 'success');
        } else {
          showToast(outcome.action === 'pull' ? 'Took the GitHub version' : 'Pushed to GitHub', 'success');
        }
        options.onChanged();
      })
      .catch(() => {
        btn.disabled = false;
        setButtonLabel(btn, idle);
        finishGitActivityError(activity, { error: 'Sync failed', chatKind: 'github' });
      });
  });
}

// ── Linked row ───────────────────────────────────────────────────────────────

/**
 * First Git-list row for a linked GitHub issue: `#n · synced …` / Needs push,
 * Open in the system browser, and Sync when Two-way mirror is on.
 */
export function buildGithubIssueChip(
  issue: IssueCard,
  options: { canSync: boolean; conflictHost: HTMLElement; onChanged: GithubSectionChanged },
): HTMLLIElement {
  const link = issue.github;
  const number = link?.number ?? 0;
  const url = link?.url?.trim() ?? '';
  const caption = githubSyncCaption(issue);
  const needsPush = caption === 'Needs push';

  const li = document.createElement('li');
  li.className = 'issues-detail__git-chip issues-detail__git-chip--github';

  const identity = document.createElement('span');
  identity.className = 'issues-detail__git-chip-label';

  identity.appendChild(createIcon('globe', { size: 12, className: 'issues-detail__git-chip-icon' }));

  const ref = document.createElement('span');
  ref.className = 'issues-detail__git-chip-ref';
  ref.textContent = `#${number}`;
  identity.appendChild(ref);

  if (caption) {
    const status = document.createElement('span');
    status.className = 'issues-detail__git-chip-status';
    if (needsPush) status.classList.add('is-needs-push');
    status.textContent = ` · ${caption}`;
    identity.appendChild(status);
  }
  li.appendChild(identity);

  const actions = document.createElement('span');
  actions.className = 'issues-detail__git-chip-actions';

  const openBtn = document.createElement('button');
  openBtn.type = 'button';
  openBtn.className = 'issues-btn issues-detail__act issues-detail__git-open';
  openBtn.appendChild(createIcon('externalLink', { size: 12, className: 'issues-detail__act-icon' }));
  const openLabel = document.createElement('span');
  openLabel.textContent = 'Open';
  openBtn.appendChild(openLabel);
  openBtn.title = 'Open on GitHub in your browser';
  openBtn.setAttribute('aria-label', `Open GitHub issue #${number} in your browser`);
  openBtn.disabled = !url;
  openBtn.addEventListener('click', () => {
    if (!url) {
      showToast('No web URL for this link', 'error');
      return;
    }
    openExternalGitUrl(url);
  });
  actions.appendChild(openBtn);

  if (options.canSync) {
    const syncBtn = document.createElement('button');
    syncBtn.type = 'button';
    syncBtn.className = 'issues-btn issues-detail__act issues-detail__git-open';
    syncBtn.appendChild(createIcon('sync', { size: 12, className: 'issues-detail__act-icon' }));
    const syncLabel = document.createElement('span');
    syncLabel.textContent = 'Sync';
    syncBtn.appendChild(syncLabel);
    syncBtn.title = 'Sync this issue with GitHub';
    bindGithubSyncButton(syncBtn, issue, {
      idleLabel: 'Sync',
      conflictHost: options.conflictHost,
      onChanged: options.onChanged,
    });
    actions.appendChild(syncBtn);
  }

  li.appendChild(actions);
  return li;
}

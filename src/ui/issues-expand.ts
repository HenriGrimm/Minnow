import { getIssuesTaxonomySync } from '../state/issues-taxonomy-store';
import { canExpandIssueDraft } from '../chat/issues/expand-issue-guards';
import {
  mergeExpandedIssue,
  type ExpandedIssueDraft,
  type IssueExpandCatalog,
  type IssueExpandSource,
} from '../chat/issues/expand-issue';
import { findIssueById, updateIssue, collectIssueLabelSuggestions } from '../state/issues-store';
import type {
  ExpandIssueRequest,
  ExpandIssueResult,
} from './issues-expand-client';
import {
  getIssueExpandUndo,
  isIssueDraftExpanding,
  setIssueExpandRun,
  setIssueExpandUndo,
} from './issues-expand-state';
import { syncIssueExpandButtons } from './issues-expand-controls';
import { setStatus } from './status';
import { notify, showToast } from './toast';
import { isIssueBackgroundExpanding, setIssueBackgroundExpanding } from './issues-background-activity';
import { releaseGithubSyncedFieldWrites } from '../state/issues-github-notify';

export { isIssueDraftExpanding };

type ExpandField = keyof ExpandedIssueDraft;
const EXPAND_FIELDS = ['title', 'description', 'type', 'priority', 'labels'] as const satisfies readonly ExpandField[];

interface ExpandRun {
  issueId: string;
  workspacePath?: string;
  controller: AbortController;
}

type ExpandIssueFetcher = (input: ExpandIssueRequest) => Promise<ExpandIssueResult>;

let activeRun: ExpandRun | null = null;
/** Test override; production loads the generations client on first expand. */
let expandFetchImpl: ExpandIssueFetcher | null = null;

// ── Fetcher ──────────────────────────────────────────────────────────────────

export function setExpandIssueFetcherForTests(impl: ExpandIssueFetcher | null): void {
  expandFetchImpl = impl;
}

/** Lazy-load the generations client so first paint does not pull it into the store chunk. */
async function resolveExpandFetcher(): Promise<ExpandIssueFetcher> {
  if (expandFetchImpl) return expandFetchImpl;
  const { fetchExpandedIssue } = await import('./issues-expand-client');
  return fetchExpandedIssue;
}

/** Expand an unsaved form draft without creating an issue or opening another overlay. */
export async function expandUnsavedIssueDraft(
  issue: IssueExpandSource,
  signal: AbortSignal,
): Promise<ExpandedIssueDraft | null> {
  const catalog: IssueExpandCatalog = {
    types: getIssuesTaxonomySync().types,
    priorities: getIssuesTaxonomySync().priorities,
    labels: collectIssueLabelSuggestions(issue.id, issue.workspacePath),
  };
  const fetchExpanded = await resolveExpandFetcher();
  if (signal.aborted) return null;
  const result = await fetchExpanded({ issue, catalog, signal });
  if (signal.aborted) return null;
  if (result.error) throw new Error(result.error);
  if (!result.draft) throw new Error(EXPAND_EMPTY_MESSAGE);
  return mergeExpandedIssue({ ...issue, description: issue.description ?? '' }, result.draft, catalog);
}

/** Keep toast copy aligned with composer-expand-client without a static import. */
const EXPAND_EMPTY_MESSAGE = 'Model returned no expanded prompt.';

/**
 * Expand a saved issue independently of the form that created it. Always ends
 * any GitHub sync deferral for the issue, so its first sync includes the result.
 */
export async function expandCreatedIssueInBackground(issueId: string): Promise<void> {
  try {
    await expandCreatedIssue(issueId);
  } finally {
    releaseGithubSyncedFieldWrites(issueId);
  }
}

async function expandCreatedIssue(issueId: string): Promise<void> {
  const issue = findIssueById(issueId);
  if (!issue || isIssueBackgroundExpanding(issueId, issue.workspacePath)) return;
  const original = {
    title: issue.title, description: issue.description ?? '', type: issue.type,
    priority: issue.priority, labels: [...issue.labels],
  };
  setIssueBackgroundExpanding(issueId, true, issue.workspacePath);
  try {
    const draft = await expandUnsavedIssueDraft({ ...original, id: issueId, workspacePath: issue.workspacePath }, new AbortController().signal);
    if (!draft) return;
    const current = findIssueById(issueId);
    if (!current) return;
    const patch: Partial<ExpandedIssueDraft> = {};
    for (const field of EXPAND_FIELDS) {
      if (JSON.stringify(current[field]) === JSON.stringify(original[field]) && draft[field] !== undefined) {
        Object.assign(patch, { [field]: draft[field] });
      }
    }
    if (!Object.keys(patch).length) return;
    updateIssue(issueId, patch);
    showToast(`${issueId} expanded`, 'success');
  } catch (error) {
    showToast(`${issueId} was created, but expansion failed: ${error instanceof Error ? error.message : 'Could not expand the issue'}`, 'error');
  } finally {
    setIssueBackgroundExpanding(issueId, false, issue.workspacePath);
  }
}
const EXPAND_FAILED_MESSAGE = 'Expand failed — check provider and model in Settings';

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * Re-render open detail surfaces so header controls pick up run/undo state.
 * Dynamic import: a static one would cycle through issues-detail →
 * issues-expand-controls → this module.
 */
function refreshDetail(): void {
  syncIssueExpandButtons();
  void import('./issues-detail').then((m) => m.refreshIssueDetailIfOpen());
}

function finishRun(run: ExpandRun): void {
  if (activeRun === run) {
    activeRun = null;
    setIssueExpandRun(null);
  }
  setIssueBackgroundExpanding(run.issueId, false, run.workspacePath);
  syncIssueExpandButtons();
}

/** Stop an in-flight in-place expansion; nothing has been written yet. */
export function cancelIssueExpand(): void {
  const run = activeRun;
  if (!run) return;
  run.controller.abort();
  finishRun(run);
  setStatus('ok', 'Expand cancelled');
}

/** True when the last in-place expansion of this issue can be undone. */
export function canUndoIssueExpand(issueId: string): boolean {
  return Boolean(getIssueExpandUndo(issueId));
}

/**
 * Restore the values the last expansion replaced. Fields edited since the
 * expansion landed keep the newer edit.
 */
export function undoIssueExpand(issueId: string): boolean {
  const undo = getIssueExpandUndo(issueId);
  setIssueExpandUndo(issueId, null);
  const current = findIssueById(issueId);
  if (!undo || !current) {
    refreshDetail();
    return false;
  }
  const patch: Partial<ExpandedIssueDraft> = {};
  for (const field of EXPAND_FIELDS) {
    if (!(field in undo.after)) continue;
    if (sameValue(current[field], undo.after[field])) Object.assign(patch, { [field]: undo.before[field] });
  }
  if (!Object.keys(patch).length) {
    refreshDetail();
    showToast(`${issueId} changed since it was expanded — nothing to undo`, 'error');
    return false;
  }
  updateIssue(issueId, patch);
  refreshDetail();
  setStatus('ok', 'Expansion undone');
  showToast(`${issueId} expansion undone`, 'success');
  return true;
}

/**
 * Expand a saved issue in place: the card shows an Expanding indicator, the
 * result is written straight to the issue, and Undo restores the previous
 * values. Fields the user edits while the model runs are left alone.
 */
export async function startIssueExpandFromUi(issueId: string): Promise<void> {
  const issue = findIssueById(issueId);
  if (!issue) {
    showToast('Issue not found', 'error');
    return;
  }
  if (!canExpandIssueDraft(issue)) {
    showToast('Nothing to expand', 'error');
    return;
  }
  if (activeRun) cancelIssueExpand();

  const original: ExpandedIssueDraft = {
    title: issue.title, description: issue.description ?? '',
    type: issue.type, labels: [...issue.labels], priority: issue.priority,
  };
  const catalog: IssueExpandCatalog = {
    types: [...getIssuesTaxonomySync().types],
    priorities: [...getIssuesTaxonomySync().priorities],
    labels: collectIssueLabelSuggestions(issue.id, issue.workspacePath),
  };
  if (!catalog.priorities.some((item) => item.id === issue.priority)) {
    catalog.priorities = [...catalog.priorities, { id: issue.priority, label: issue.priority }];
  }
  const run: ExpandRun = { issueId, workspacePath: issue.workspacePath, controller: new AbortController() };
  activeRun = run;
  setIssueExpandRun(issueId);
  setIssueExpandUndo(issueId, null);
  setIssueBackgroundExpanding(issueId, true, issue.workspacePath);
  refreshDetail();
  setStatus('spin', `Expanding ${issueId}…`);

  const stale = (): boolean => run.controller.signal.aborted || activeRun !== run;
  try {
    const fetchExpanded = await resolveExpandFetcher();
    if (stale()) return;
    const result = await fetchExpanded({ issue, catalog, signal: run.controller.signal } satisfies ExpandIssueRequest);
    if (stale()) return;
    finishRun(run);
    if (result.error) throw new Error(result.error);
    if (!result.draft) throw new Error(EXPAND_EMPTY_MESSAGE);

    const draft = mergeExpandedIssue(original, result.draft, catalog);
    const current = findIssueById(issueId);
    if (!current) return;
    const before: Partial<ExpandedIssueDraft> = {};
    const after: Partial<ExpandedIssueDraft> = {};
    for (const field of EXPAND_FIELDS) {
      const next = draft[field];
      if (next === undefined || sameValue(next, original[field])) continue;
      if (field === 'title' && !String(next).trim()) continue;
      // The user edited this field while the model ran; their edit wins.
      if (!sameValue(current[field], original[field])) continue;
      Object.assign(before, { [field]: original[field] });
      Object.assign(after, { [field]: next });
    }
    if (!Object.keys(after).length) {
      refreshDetail();
      setStatus('ok', 'Ready');
      showToast(`${issueId} is already detailed — nothing changed`, 'success');
      return;
    }
    updateIssue(issueId, after);
    setIssueExpandUndo(issueId, { before, after });
    refreshDetail();
    setStatus('ok', 'Issue expanded');
    notify({
      tone: 'success',
      message: `${issueId} expanded`,
      actions: [{ label: 'Undo', ariaLabel: `Undo expansion of ${issueId}`, run: () => { undoIssueExpand(issueId); } }],
    });
  } catch (err) {
    // Cancelled or replaced: cancelIssueExpand already cleared the run.
    if (run.controller.signal.aborted) return;
    finishRun(run);
    refreshDetail();
    const message = err instanceof Error && err.message.trim() ? err.message : EXPAND_FAILED_MESSAGE;
    setStatus('err', message);
    showToast(message, 'error');
  }
}

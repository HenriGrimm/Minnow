import { getIssuesTaxonomySync } from '../state/issues-taxonomy-store';
import { canExpandIssueDraft } from '../chat/issues/expand-issue-guards';
import {
  mergeExpandedIssue,
  type ExpandedIssueDraft,
  type IssueExpandCatalog,
  type IssueExpandSource,
} from '../chat/issues/expand-issue';
import { findIssueById, updateIssue, getIssuesSnapshot } from '../state/issues-store';
import type {
  ExpandIssueRequest,
  ExpandIssueResult,
} from './issues-expand-client';
import {
  ISSUES_EXPAND_BACKDROP_ID,
  ISSUES_EXPAND_FORM_ID,
  isIssueDraftExpanding,
  isIssueExpandOverlayOpen,
  setIssueExpandRun,
} from './issues-expand-state';
import { setStatus } from './status';
import { showToast } from './toast';

export { isIssueDraftExpanding, isIssueExpandOverlayOpen };

const OVERLAY_FORM_ID = ISSUES_EXPAND_FORM_ID;
const OVERLAY_BACKDROP_ID = ISSUES_EXPAND_BACKDROP_ID;

const IDLE_LABEL = 'Expand issue';
const IDLE_TITLE = 'Expand title, description, type, labels, and priority from the current card';
const BUSY_LABEL = 'Expanding issue — click to cancel';
const BUSY_TITLE = 'Expanding… click to cancel';

interface ExpandRun {
  issueId: string;
  controller: AbortController;
  original: ExpandedIssueDraft;
  catalog: IssueExpandCatalog;
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
    labels: (getIssuesSnapshot().labelCatalog ?? []).map((entry) => entry.name),
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
const EXPAND_FAILED_MESSAGE = 'Expand failed — check provider and model in Settings';

function clearActiveRun(): void {
  activeRun = null;
  setIssueExpandRun(null);
}

/** Keep sparkles controls in sync after the lazy expand module mutates run state. */
function syncExpandButtons(): void {
  document.querySelectorAll<HTMLButtonElement>('[data-issue-expand]').forEach((btn) => {
    const id = btn.dataset.issueExpand ?? '';
    const busy = isIssueDraftExpanding(id);
    btn.classList.toggle('composer-expand-btn--busy', busy);
    btn.setAttribute('aria-busy', busy ? 'true' : 'false');
    btn.setAttribute('aria-label', busy ? BUSY_LABEL : IDLE_LABEL);
    btn.title = busy ? BUSY_TITLE : IDLE_TITLE;
    if (!busy) {
      const issue = findIssueById(id);
      btn.disabled = !issue || !canExpandIssueDraft(issue);
    } else {
      btn.disabled = false;
    }
  });
}

// ── Overlay ──────────────────────────────────────────────────────────────────

function overlayEls(): {
  form: HTMLFormElement;
  backdrop: HTMLButtonElement;
  title: HTMLInputElement;
  description: HTMLTextAreaElement;
  labels: HTMLTextAreaElement;
  type: HTMLSelectElement;
  priority: HTMLSelectElement;
  apply: HTMLButtonElement;
  discard: HTMLButtonElement;
  status: HTMLParagraphElement;
} | null {
  const form = document.getElementById(OVERLAY_FORM_ID);
  const backdrop = document.getElementById(OVERLAY_BACKDROP_ID);
  const title = document.getElementById('issuesExpandTitle');
  const description = document.getElementById('issuesExpandDescription');
  const labels = document.getElementById('issuesExpandLabels');
  const type = document.getElementById('issuesExpandType');
  const priority = document.getElementById('issuesExpandPriority');
  const apply = document.getElementById('issuesExpandApply');
  const discard = document.getElementById('issuesExpandDiscard');
  const status = document.getElementById('issuesExpandStatus');
  if (
    !(form instanceof HTMLFormElement) ||
    !(backdrop instanceof HTMLButtonElement) ||
    !(title instanceof HTMLInputElement) ||
    !(description instanceof HTMLTextAreaElement) ||
    !(labels instanceof HTMLTextAreaElement) ||
    !(type instanceof HTMLSelectElement) ||
    !(priority instanceof HTMLSelectElement) ||
    !(apply instanceof HTMLButtonElement) ||
    !(discard instanceof HTMLButtonElement) ||
    !(status instanceof HTMLParagraphElement)
  ) {
    return null;
  }
  return { form, backdrop, title, description, labels, type, priority, apply, discard, status };
}

function ensureOverlay(): NonNullable<ReturnType<typeof overlayEls>> {
  const existing = overlayEls();
  if (existing) return existing;

  const backdrop = document.createElement('button');
  backdrop.type = 'button';
  backdrop.id = OVERLAY_BACKDROP_ID;
  backdrop.className = 'issues-new-form__backdrop';
  backdrop.setAttribute('aria-label', 'Discard expanded issue');

  const form = document.createElement('form');
  form.id = OVERLAY_FORM_ID;
  form.className = 'issues-new-form issues-expand-form';
  form.setAttribute('aria-label', 'Expand issue');
  form.setAttribute('role', 'dialog');
  form.setAttribute('aria-modal', 'true');

  const heading = document.createElement('h2');
  heading.className = 'issues-expand-form__heading';
  heading.id = 'issuesExpandHeading';
  heading.textContent = 'Expand issue';
  form.setAttribute('aria-labelledby', heading.id);

  const hint = document.createElement('p');
  hint.className = 'issues-expand-form__hint';
  hint.textContent =
    'Review the title, description, type, labels, and priority. Nothing is saved until you apply.';

  const titleLabel = document.createElement('label');
  titleLabel.className = 'issues-expand-form__title';
  titleLabel.append('Title');
  const title = document.createElement('input');
  title.type = 'text';
  title.id = 'issuesExpandTitle';
  title.autocomplete = 'off';
  title.setAttribute('aria-label', 'Expanded title');
  titleLabel.appendChild(title);

  const descLabel = document.createElement('label');
  descLabel.className = 'issues-expand-form__desc';
  descLabel.append('Description');
  const description = document.createElement('textarea');
  description.id = 'issuesExpandDescription';
  description.rows = 10;
  description.setAttribute('aria-label', 'Expanded description');
  descLabel.appendChild(description);

  const labelsLabel = document.createElement('label');
  labelsLabel.className = 'issues-expand-form__title';
  labelsLabel.append('Labels (one per line)');
  const labels = document.createElement('textarea');
  labels.id = 'issuesExpandLabels';
  labels.rows = 2;
  labels.setAttribute('aria-label', 'Expanded labels');
  labelsLabel.appendChild(labels);

  const typeLabel = document.createElement('label');
  typeLabel.className = 'issues-expand-form__title';
  typeLabel.append('Type');
  const type = document.createElement('select');
  type.id = 'issuesExpandType';
  type.setAttribute('aria-label', 'Expanded type');
  typeLabel.appendChild(type);

  const priorityLabel = document.createElement('label');
  priorityLabel.className = 'issues-expand-form__title';
  priorityLabel.append('Priority');
  const priority = document.createElement('select');
  priority.id = 'issuesExpandPriority';
  priority.setAttribute('aria-label', 'Expanded priority');
  priorityLabel.appendChild(priority);

  const status = document.createElement('p');
  status.id = 'issuesExpandStatus';
  status.className = 'issues-expand-form__status';

  const actions = document.createElement('div');
  actions.className = 'issues-new-form__actions';
  const discard = document.createElement('button');
  discard.type = 'button';
  discard.id = 'issuesExpandDiscard';
  discard.className = 'issues-btn';
  discard.textContent = 'Discard';
  const apply = document.createElement('button');
  apply.type = 'button';
  apply.id = 'issuesExpandApply';
  apply.className = 'issues-btn issues-btn--primary';
  apply.textContent = 'Apply';
  actions.append(discard, apply);

  form.append(heading, hint, titleLabel, descLabel, typeLabel, labelsLabel, priorityLabel, status, actions);
  document.body.append(backdrop, form);

  title.addEventListener('input', () => syncApplyEnabled());
  description.addEventListener('input', () => syncApplyEnabled());
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    applyExpand();
  });
  apply.addEventListener('click', () => applyExpand());
  discard.addEventListener('click', () => discardExpand());
  backdrop.addEventListener('click', () => discardExpand());
  form.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      discardExpand();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      applyExpand();
    }
  });

  return overlayEls()!;
}

function setOverlayOpen(open: boolean): void {
  const els = ensureOverlay();
  els.form.classList.toggle('is-open', open);
  els.backdrop.classList.toggle('is-open', open);
}

function setFieldsReadonly(readonly: boolean): void {
  const els = overlayEls();
  if (!els) return;
  els.title.readOnly = readonly;
  els.description.readOnly = readonly;
  els.labels.readOnly = readonly;
  els.type.disabled = readonly;
  els.priority.disabled = readonly;
  els.form.classList.toggle('is-expanding', readonly);
}

function setStatusLine(text: string): void {
  const els = overlayEls();
  if (!els) return;
  els.status.textContent = text;
  els.status.hidden = !text;
}

function paintDraft(draft: ExpandedIssueDraft): void {
  const els = overlayEls();
  if (!els) return;
  els.title.value = draft.title;
  els.description.value = draft.description;
  els.labels.value = (draft.labels ?? []).join('\n');
  els.type.value = draft.type ?? '';
  els.priority.value = draft.priority ?? 'none';
  syncApplyEnabled();
}

function syncApplyEnabled(): void {
  const els = overlayEls();
  if (!els) return;
  const streaming = Boolean(activeRun) && els.title.readOnly;
  els.apply.disabled = streaming || !els.title.value.trim();
}

function closeOverlay(): void {
  const els = overlayEls();
  if (!els) return;
  setOverlayOpen(false);
  els.title.value = '';
  els.description.value = '';
  els.labels.value = '';
  els.type.replaceChildren();
  els.priority.replaceChildren();
  setFieldsReadonly(false);
  setStatusLine('');
  els.apply.disabled = true;
}

/** Close without saving (tests + Discard). Aborts an in-flight generation. */
export function closeIssueExpandOverlay(): void {
  discardExpand();
}

// ── Apply ────────────────────────────────────────────────────────────────────

function discardExpand(): void {
  const run = activeRun;
  if (run) {
    run.controller.abort();
    clearActiveRun();
    syncExpandButtons();
    setStatus('ok', 'Expand cancelled');
  }
  closeOverlay();
}

function applyExpand(): void {
  const els = overlayEls();
  const run = activeRun;
  if (!els || !run) return;
  if (els.title.readOnly) return;

  const title = els.title.value.trim();
  if (!title) return;

  const description = els.description.value;
  const issueId = run.issueId;
  clearActiveRun();
  const labels = els.labels.value.split('\n').map((label) => label.trim()).filter(Boolean);
  const type = els.type.value || run.original.type;
  const priority = els.priority.value || run.original.priority;
  updateIssue(issueId, { title, description, type, labels, priority });
  closeOverlay();
  syncExpandButtons();
  // The store emit above landed while the overlay still owned the editing
  // guard, so the open detail never re-rendered; refresh it now that the
  // overlay is closed. Dynamic import: a static one would cycle through
  // issues-detail → issues-expand-controls → this module.
  void import('./issues-detail').then((m) => m.refreshIssueDetailIfOpen());
  setStatus('ok', 'Issue expanded');
  showToast('Issue expanded', 'success');
}

/** Open the review overlay and stream a proposal. */
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

  if (activeRun) {
    activeRun.controller.abort();
    clearActiveRun();
  }

  const original = {
    title: issue.title, description: issue.description ?? '',
    type: issue.type, labels: [...issue.labels], priority: issue.priority,
  };
  const catalog: IssueExpandCatalog = {
    types: [...getIssuesTaxonomySync().types],
    priorities: [...getIssuesTaxonomySync().priorities],
    labels: (getIssuesSnapshot().labelCatalog ?? []).map((entry) => entry.name),
  };
  if (!catalog.priorities.some((item) => item.id === issue.priority)) {
    catalog.priorities = [...catalog.priorities, { id: issue.priority, label: issue.priority }];
  }
  const controller = new AbortController();
  activeRun = { issueId, controller, original, catalog };
  setIssueExpandRun(issueId);

  const els = ensureOverlay();
  els.type.replaceChildren(...catalog.types.map((item) => {
    const option = document.createElement('option');
    option.value = item.id;
    option.textContent = item.label;
    return option;
  }));
  els.priority.replaceChildren(...catalog.priorities.map((item) => {
    const option = document.createElement('option');
    option.value = item.id;
    option.textContent = item.label;
    return option;
  }));
  setOverlayOpen(true);
  paintDraft(original);
  setFieldsReadonly(true);
  setStatusLine('Expanding…');
  els.apply.disabled = true;
  els.title.focus();
  syncExpandButtons();
  setStatus('spin', 'Expanding issue…');

  try {
    const fetchExpanded = await resolveExpandFetcher();
    const result = await fetchExpanded({
      issue,
      catalog,
      signal: controller.signal,
      onPartial: (draft: ExpandedIssueDraft) => {
        if (controller.signal.aborted || activeRun?.controller !== controller) return;
        paintDraft(mergeExpandedIssue(original, draft, catalog));
      },
    } satisfies ExpandIssueRequest);

    if (controller.signal.aborted || activeRun?.controller !== controller) return;

    if (result.error) {
      clearActiveRun();
      closeOverlay();
      syncExpandButtons();
      setStatus('err', result.error);
      showToast(result.error, 'error');
      return;
    }
    if (!result.draft) {
      clearActiveRun();
      closeOverlay();
      syncExpandButtons();
      setStatus('ok', 'Ready');
      showToast(EXPAND_EMPTY_MESSAGE, 'error');
      return;
    }

    paintDraft(mergeExpandedIssue(original, result.draft, catalog));
    setFieldsReadonly(false);
    setStatusLine('Edit if you want, then apply.');
    syncApplyEnabled();
    setStatus('ok', 'Issue expanded — review to apply');
    els.title.focus();
    els.title.select();
  } catch (err) {
    if (controller.signal.aborted || activeRun?.controller !== controller) return;
    clearActiveRun();
    closeOverlay();
    syncExpandButtons();
    const message = err instanceof Error && err.message.trim() ? err.message : EXPAND_FAILED_MESSAGE;
    setStatus('err', message);
    showToast(message, 'error');
  }
}

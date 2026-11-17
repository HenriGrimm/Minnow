import { canExpandIssueDraft } from '../chat/issues/expand-issue-guards';
import { findIssueById } from '../state/issues-store';
import type { IssueCard } from '../types';
import { iconHtml } from './icon';
import {
  getIssueExpandUndo,
  isIssueDraftExpanding,
} from './issues-expand-state';

export { isIssueDraftExpanding };

const IDLE_LABEL = 'Expand issue';
const IDLE_TITLE = 'Expand title, description, labels, and priority from the current card';
const BUSY_LABEL = 'Expanding issue — click to cancel';
const BUSY_TITLE = 'Expanding… click to cancel';

const EXPAND_MARKUP =
  iconHtml('sparkles', { className: 'composer-expand-btn__icon', size: 16 }) +
  '<span class="composer-expand-btn__spinner" aria-hidden="true"></span>';

export type IssueExpandButtonVariant = 'peek' | 'board';

function paintExpandButton(btn: HTMLButtonElement, busy: boolean): void {
  btn.classList.toggle('composer-expand-btn--busy', busy);
  btn.setAttribute('aria-busy', busy ? 'true' : 'false');
  btn.setAttribute('aria-label', busy ? BUSY_LABEL : IDLE_LABEL);
  btn.title = busy ? BUSY_TITLE : IDLE_TITLE;
}

/** Sparkles control matching the composer prompt expander icon. */
export function createIssueExpandButton(
  issue: IssueCard,
  variant: IssueExpandButtonVariant,
): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className =
    variant === 'peek'
      ? 'issues-detail__icon-btn composer-expand-btn issues-expand-btn'
      : 'issues-card__expand-btn composer-expand-btn issues-expand-btn';
  btn.dataset.issueExpand = issue.id;
  btn.innerHTML = EXPAND_MARKUP;
  const busy = isIssueDraftExpanding(issue.id);
  paintExpandButton(btn, busy);
  btn.disabled = busy ? false : !canExpandIssueDraft(issue);
  btn.addEventListener('click', (event) => {
    event.stopPropagation();
    void onExpandButtonClick(issue.id);
  });
  return btn;
}

/**
 * Inline Undo shown beside the sparkles control after an in-place expansion.
 * A stable element painted in place, so run state never remounts the editor.
 */
export function createIssueExpandUndoButton(issue: IssueCard): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'issues-btn issues-expand-undo';
  btn.dataset.issueExpandUndo = issue.id;
  btn.textContent = 'Undo';
  btn.title = 'Undo expansion';
  btn.setAttribute('aria-label', `Undo expansion of ${issue.id}`);
  btn.hidden = !getIssueExpandUndo(issue.id) || isIssueDraftExpanding(issue.id);
  btn.addEventListener('click', (event) => {
    event.stopPropagation();
    btn.hidden = true;
    void import('./issues-expand').then((m) => m.undoIssueExpand(issue.id));
  });
  return btn;
}

/** Refresh busy/disabled on every mounted sparkles control and its Undo. */
export function syncIssueExpandButtons(): void {
  document.querySelectorAll<HTMLButtonElement>('[data-issue-expand]').forEach((btn) => {
    const id = btn.dataset.issueExpand ?? '';
    const busy = isIssueDraftExpanding(id);
    paintExpandButton(btn, busy);
    if (!busy) {
      const issue = findIssueById(id);
      btn.disabled = !issue || !canExpandIssueDraft(issue);
    } else {
      btn.disabled = false;
    }
  });
  document.querySelectorAll<HTMLButtonElement>('[data-issue-expand-undo]').forEach((btn) => {
    const id = btn.dataset.issueExpandUndo ?? '';
    btn.hidden = !getIssueExpandUndo(id) || isIssueDraftExpanding(id);
  });
}

async function onExpandButtonClick(issueId: string): Promise<void> {
  const expand = await import('./issues-expand');
  if (isIssueDraftExpanding(issueId)) {
    expand.cancelIssueExpand();
    return;
  }
  await expand.startIssueExpandFromUi(issueId);
}

/** Expand in place (loads expand module on first use). */
export async function startIssueExpandFromUi(issueId: string): Promise<void> {
  const expand = await import('./issues-expand');
  await expand.startIssueExpandFromUi(issueId);
}

/** Stop an in-flight expansion without writing anything. */
export function cancelIssueExpand(): void {
  void import('./issues-expand').then((m) => m.cancelIssueExpand());
}

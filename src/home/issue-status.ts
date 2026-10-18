import type { IssueCard } from '../types';
import { sortedStatuses } from '../issues/taxonomy';
import { createIssueStatusChip, resolveIssueStatusIcon } from '../issues/type-icons';
import { findIssueById, updateIssue } from '../state/issues-store';
import { getIssuesTaxonomySync } from '../state/issues-taxonomy-store';
import { openContextMenu } from '../ui/context-menu';
import { createIcon } from '../ui/icon';

export function updateHomeIssueStatus(control: HTMLButtonElement, issue: IssueCard): void {
  const item = getIssuesTaxonomySync().statuses.find(status => status.id === issue.status);
  const chip = createIssueStatusChip(issue.status, item);
  control.replaceChildren(chip, createIcon('chevronDown', { size: 10 }));
  control.title = `Change status: ${item?.label || issue.status}`;
  control.setAttribute('aria-label', `${issue.id} status: ${item?.label || issue.status}`);
}

/** Issue workflow stays editable independently of the agent's worktree lifecycle. */
export function createHomeIssueStatus(issue: IssueCard): HTMLButtonElement {
  const control = document.createElement('button');
  control.type = 'button'; control.className = 'home-issue-status';
  control.setAttribute('aria-haspopup', 'menu');
  updateHomeIssueStatus(control, issue);
  control.onclick = event => {
    event.stopPropagation();
    const current = findIssueById(issue.id);
    if (!current) return;
    openContextMenu({
      anchor: control, restoreFocus: control, label: `${issue.id} status`,
      items: sortedStatuses(getIssuesTaxonomySync()).map(status => ({
        id: status.id, label: status.label, checked: status.id === current.status,
        iconClass: resolveIssueStatusIcon(status.id, status),
        onSelect: () => {
          if (findIssueById(issue.id)?.status === status.id) return;
          const updated = updateIssue(issue.id, {
            status: status.id,
            triagedAt: status.role === 'triage' ? null : current.triagedAt ?? Date.now(),
          });
          if (updated) updateHomeIssueStatus(control, updated);
        },
      })),
    });
  };
  return control;
}

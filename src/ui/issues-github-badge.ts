import type { IssueCard } from '../types';
import { issueNeedsGithubPush } from '../issues/github-sync-plan';

/** Local sync watermarks; remote changes become known when synchronization runs. */
export function createIssueGithubSyncBadge(
  issue: IssueCard,
  mirrorEnabled: boolean,
  hasConflict = false,
): HTMLElement | null {
  const caption = hasConflict ? 'Conflict'
    : issueNeedsGithubPush(issue) ? 'Needs push'
    : !issue.github && mirrorEnabled ? 'Not synced' : '';
  if (!caption) return null;
  const badge = document.createElement('span');
  badge.className = 'issues-github-sync-badge';
  badge.textContent = `GitHub · ${caption}`;
  badge.title = hasConflict ? 'GitHub sync conflict — open the issue to resolve'
    : issue.github ? 'Local changes have not been synced to GitHub'
    : 'This issue has not been synced to GitHub';
  badge.setAttribute('aria-label', badge.title);
  return badge;
}

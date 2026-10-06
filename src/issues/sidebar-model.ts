import { normalizeWorkspacePath } from '../lib/normalize-workspace-path';
import { isClosedStatus, type IssuesTaxonomy } from './taxonomy';
import type { IssueCard } from '../types';

export type SidebarIssueFilter = 'open' | 'all' | 'closed';

export function sidebarWorkspaceKey(path: string): string {
  const normalized = normalizeWorkspacePath(path);
  return /^[a-z]:\//i.test(normalized) ? normalized.toLowerCase() : normalized;
}

export function sidebarIssues(issues: readonly IssueCard[], workspacePath: string, taxonomy: IssuesTaxonomy, filter: SidebarIssueFilter, query: string): IssueCard[] {
  const workspace = sidebarWorkspaceKey(workspacePath);
  const needle = query.trim().toLowerCase();
  return issues.filter((issue) => {
    if (sidebarWorkspaceKey(issue.workspacePath) !== workspace) return false;
    const closed = isClosedStatus(taxonomy, issue.status);
    if (filter === 'open' && closed || filter === 'closed' && !closed) return false;
    return !needle || `${issue.id} ${issue.title}`.toLowerCase().includes(needle);
  }).sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
}

export function splitQuickIssue(text: string): { title: string; description: string } {
  const [title = '', ...body] = text.trim().split(/\r?\n/);
  return { title: title.trim(), description: body.join('\n').trim() };
}

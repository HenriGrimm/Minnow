import { normalizeWorkspacePath } from '../lib/normalize-workspace-path';
import { isClosedStatus, type IssuesTaxonomy } from './taxonomy';
import type { IssueCard } from '../types';

export type SidebarIssueFilter = 'open' | 'all' | 'closed';

export interface SidebarIssueProperties {
  type?: string;
  status?: string;
  priority?: string;
  projectId?: string | null;
}

export function sidebarWorkspaceKey(path: string): string {
  const normalized = normalizeWorkspacePath(path);
  return /^[a-z]:\//i.test(normalized) ? normalized.toLowerCase() : normalized;
}

export function sidebarIssues(issues: readonly IssueCard[], workspacePath: string, taxonomy: IssuesTaxonomy, filter: SidebarIssueFilter, query: string, properties: SidebarIssueProperties = {}): IssueCard[] {
  const workspace = sidebarWorkspaceKey(workspacePath);
  const needle = query.trim().toLowerCase();
  return issues.filter((issue) => {
    if (sidebarWorkspaceKey(issue.workspacePath) !== workspace) return false;
    const closed = isClosedStatus(taxonomy, issue.status);
    if (filter === 'open' && closed || filter === 'closed' && !closed) return false;
    if (properties.type !== undefined && issue.type !== properties.type) return false;
    if (properties.status !== undefined && issue.status !== properties.status) return false;
    if (properties.priority !== undefined && issue.priority !== properties.priority) return false;
    if (properties.projectId !== undefined && (issue.projectId ?? null) !== properties.projectId) return false;
    return !needle || `${issue.id} ${issue.title}`.toLowerCase().includes(needle);
  }).sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
}

export function splitQuickIssue(text: string): { title: string; description: string } {
  const [title = '', ...body] = text.trim().split(/\r?\n/);
  return { title: title.trim(), description: body.join('\n').trim() };
}

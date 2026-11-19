import { issueAssignedRepoIds, issueRepoPath } from '../issues/repo-scope';
import { normalizeWorkspacePath, relativeWorkspacePath, workspacePathsEqual } from '../lib/normalize-workspace-path';
import type { WorkspaceRepo } from '../state/workspace-repos';
import type { IssueCard } from '../types';

export type IssueWorkspaceFilter = { path: string; label: string; exact?: boolean };

export interface IssueWorkspaceContext {
  workspacePath: string;
  workspaceLabel: string;
  repos: readonly WorkspaceRepo[];
  qualifyLabels?: boolean;
}

export function issueWorkspaceTargets(issue: IssueCard, context: IssueWorkspaceContext): IssueWorkspaceFilter[] {
  const path = normalizeWorkspacePath(issue.workspacePath);
  if (!path) return [];
  const relative = relativeWorkspacePath(context.workspacePath, path);
  const rootLabel = context.workspaceLabel || normalizeWorkspacePath(context.workspacePath).split('/').at(-1) || context.workspacePath;
  const workspace = relative ? (relative === '.' ? rootLabel : `${rootLabel}/${relative}`) : path.split('/').at(-1) || path;
  const prefix = relative && !context.qualifyLabels ? (relative === '.' ? '' : relative) : workspace;
  const repos = issueAssignedRepoIds(issue, context.workspacePath, context.repos);
  return (repos.length ? repos : ['.']).map((repo) => ({
    label: repo === '.' ? (prefix || workspace) : prefix ? `${prefix}/${repo}` : repo,
    path: issueRepoPath(path, repo),
    exact: repos.length > 0,
  }));
}

export function issueWorkspaceSortLabel(issue: IssueCard, context: IssueWorkspaceContext): string {
  return issueWorkspaceTargets(issue, context).map((target) => target.label).join(', ') || 'No workspace';
}

export function createIssueWorkspaceLabel(
  targets: readonly IssueWorkspaceFilter[],
  className: string,
  selected: IssueWorkspaceFilter | undefined,
  onSelect: (filter?: IssueWorkspaceFilter) => void,
): HTMLElement {
  const label = document.createElement('span');
  label.className = `issues-workspace-label ${className}`;
  if (!targets.length) {
    label.textContent = 'No workspace';
    return label;
  }

  for (const [index, target] of targets.entries()) {
    const active = Boolean(selected && workspacePathsEqual(selected.path, target.path) &&
      Boolean(selected.exact) === Boolean(target.exact));
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'issues-workspace-label__filter';
    button.textContent = target.label;
    button.title = target.path;
    button.setAttribute('aria-label', `Filter by ${target.label}`);
    button.setAttribute('aria-pressed', String(active));
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      onSelect(active ? undefined : target);
    });
    if (index > 0) label.append(', ');
    label.appendChild(button);
  }
  label.title = targets.map((target) => target.path).join('\n');
  return label;
}

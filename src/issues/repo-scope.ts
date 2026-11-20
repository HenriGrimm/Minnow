/**
 * Which repos an issue targets in a multi-repo workspace.
 *
 * Issues stay workspace-scoped (one ISS-n numbering). `IssueCard.repos` lists
 * the workspace-relative repo ids the work explicitly targets. Links
 * (`IssueGitLink.repo`, `agent.prRepo`) record
 * which repo a PR, commit or branch lives in, so `#12` in one repo is never
 * mistaken for `#12` in another.
 */

import type { IssueCard, IssueGitLink } from '../types';
import { relativeWorkspacePath, workspacePathsEqual } from '../lib/normalize-workspace-path';
import type { WorkspaceRepo } from '../state/workspace-repos';

/** Trimmed, forward-slash, de-duplicated repo ids. */
export function normalizeIssueRepoIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const id = item.trim().replace(/\\/g, '/').replace(/(.)\/+$/, '$1');
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

/** Trim a link's `repo`, dropping it when empty; other keys pass through. */
export function normalizeIssueGitLinkRepo<T>(link: T): T {
  if (!link || typeof link !== 'object' || !('repo' in (link as object))) return link;
  const { repo, ...rest } = link as Record<string, unknown>;
  const id = typeof repo === 'string' ? repo.trim() : '';
  return (id ? { ...rest, repo: id } : rest) as T;
}

/**
 * Publishing targets for an unlinked issue: explicit repos, then the workspace
 * repo, then the only child repo if there is one. Never guess among siblings.
 */
export function issueRepoIds(issue: Pick<IssueCard, 'repos'>, repos: ReadonlyArray<{ id: string }>): string[] {
  if (issue.repos?.length) return [...issue.repos];
  const fallback = repos.find((repo) => repo.id === '.') ?? (repos.length === 1 ? repos[0] : undefined);
  return fallback ? [fallback.id] : [];
}

/** Older GitHub links may only have a URL. */
export function issueGithubSlug(issue: Pick<IssueCard, 'github'>): string {
  return (issue.github?.repo || issue.github?.url?.match(/^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/issues\/\d+/i)?.[1] || '').toLowerCase();
}

/** Assignments are workspace-relative. Legacy linked cards can be matched against repo discovery. */
export function issueAssignedRepoIds(
  issue: Pick<IssueCard, 'workspacePath' | 'repos' | 'github'>,
  root: string,
  repos: readonly WorkspaceRepo[],
): readonly string[] {
  if (issue.repos?.length) return issue.repos;
  if (!repos.length || !workspacePathsEqual(root, issue.workspacePath)) return [];
  const slug = issueGithubSlug(issue);
  return slug ? repos.filter((repo) => repo.remote?.slug.toLowerCase() === slug).map((repo) => repo.id) : [];
}

export function issueRepoPath(workspace: string, repo: string): string {
  return repo === '.' ? workspace : `${workspace.replace(/[\\/]$/, '')}/${repo}`;
}

export function issueInSubWorkspace(
  issue: Pick<IssueCard, 'workspacePath' | 'repos' | 'github'>,
  filter: { path: string; exact?: boolean; repoWorkspacePath: string; repos: readonly WorkspaceRepo[] },
): boolean {
  const matches = (path: string) => filter.exact
    ? workspacePathsEqual(filter.path, path)
    : relativeWorkspacePath(filter.path, path) !== null;
  const repos = issueAssignedRepoIds(issue, filter.repoWorkspacePath, filter.repos);
  return repos.length ? repos.some((repo) => matches(issueRepoPath(issue.workspacePath, repo))) : matches(issue.workspacePath);
}

/** Add or remove one repo id, keeping the workspace's repo order. */
export function toggleIssueRepo(selected: readonly string[], id: string, order: readonly string[]): string[] {
  const next = new Set(selected);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return [...order.filter((repo) => next.has(repo)), ...[...next].filter((repo) => !order.includes(repo))];
}

/** True when two links name the same repo, treating a missing repo as "the only one". */
export function sameLinkRepo(a: Pick<IssueGitLink, 'repo'>, b: Pick<IssueGitLink, 'repo'>): boolean {
  return (a.repo ?? '') === (b.repo ?? '');
}

/** `backend#12` in a multi-repo workspace, `#12` otherwise. */
export function repoQualifiedRef(ref: string, repo?: string): string {
  const id = repo?.trim();
  if (!id || id === '.') return ref;
  return ref.startsWith('#') ? `${id}${ref}` : `${id}@${ref}`;
}

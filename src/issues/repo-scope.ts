/**
 * Which repos an issue targets in a multi-repo workspace.
 *
 * Issues stay workspace-scoped (one ISS-n numbering). `IssueCard.repos` lists
 * the workspace-relative repo ids the work touches; absent means "the
 * workspace's only repo". Links (`IssueGitLink.repo`, `agent.prRepo`) record
 * which repo a PR, commit or branch lives in, so `#12` in one repo is never
 * mistaken for `#12` in another.
 */

import type { IssueCard, IssueGitLink } from '../types';
import { relativeWorkspacePath } from '../lib/normalize-workspace-path';
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
 * The repo ids an issue targets: its explicit `repos`, else the single repo
 * when the workspace has exactly one, else none.
 */
export function issueRepoIds(issue: Pick<IssueCard, 'repos'>, repos: ReadonlyArray<{ id: string }>): string[] {
  if (issue.repos?.length) return [...issue.repos];
  return repos.length === 1 ? [repos[0].id] : [];
}

/** Older GitHub links may only have a URL. */
export function issueGithubSlug(issue: Pick<IssueCard, 'github'>): string {
  return (issue.github?.repo || issue.github?.url?.match(/^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/issues\/\d+/i)?.[1] || '').toLowerCase();
}

/** A parent view includes cards filed in child workspaces and cards tagged for child repos. */
export function issueInSubWorkspace(
  issue: Pick<IssueCard, 'workspacePath' | 'repos' | 'github'>,
  root: string,
  subWorkspace: string,
  repos: readonly WorkspaceRepo[],
): boolean {
  const relative = relativeWorkspacePath(root, issue.workspacePath);
  if (relative === null) return false;
  const contains = (path: string) => relativeWorkspacePath(`${root}/${subWorkspace}`, `${root}/${path}`) !== null;
  if (relative !== '.') return contains(relative);
  if (issue.repos?.length) return issue.repos.some((id) => id !== '.' && contains(id));
  const slug = issueGithubSlug(issue);
  return Boolean(slug && repos.some((repo) => !repo.isRoot &&
    repo.remote?.slug.toLowerCase() === slug && contains(repo.id)));
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

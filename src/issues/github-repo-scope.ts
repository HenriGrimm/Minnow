/**
 * Which GitHub repository an issue syncs with.
 *
 * In a single-repo workspace every forge call runs in the workspace, exactly as
 * before. In a folder of several repos each call names the repo: a linked issue
 * follows its stored `github.repo` (`owner/name`); an unlinked one publishes to
 * the single repo it targets, and is held back when it targets none or several.
 */

import type { IssueCard } from '../types';
import type { WorkspaceRepo } from '../state/workspace-repos';
import { issueRepoIds } from './repo-scope';

export interface IssueForgeScope {
  /** Workspace the forge call is authorised against. */
  cwd: string;
  /** Repo id inside the workspace; absent in a single-repo workspace. */
  repo?: string;
  /** `owner/name` of that repo's remote, stored on the link. */
  slug?: string;
}

export const CHOOSE_REPO_ERROR = 'Choose a repo for this issue before publishing it to GitHub.';

export function repoSlug(repo: WorkspaceRepo): string {
  return repo.remote?.owner && repo.remote.name ? `${repo.remote.owner}/${repo.remote.name}` : '';
}

function scopeOf(cwd: string, repo: WorkspaceRepo): IssueForgeScope {
  const slug = repoSlug(repo);
  return { cwd, repo: repo.id, ...(slug ? { slug } : {}) };
}

/** Throws {@link CHOOSE_REPO_ERROR} (or a missing-repo error) when the target is unclear. */
export function resolveIssueForgeScope(
  issue: Pick<IssueCard, 'workspacePath' | 'repos' | 'github'>,
  repos: readonly WorkspaceRepo[],
): IssueForgeScope {
  const cwd = issue.workspacePath;
  if (repos.length < 2) return { cwd };
  const linkedSlug = issue.github?.repo?.toLowerCase();
  if (linkedSlug) {
    const hit = repos.find((repo) => repoSlug(repo).toLowerCase() === linkedSlug);
    if (!hit) throw new Error(`GitHub repo ${issue.github?.repo} is not in this workspace any more.`);
    return scopeOf(cwd, hit);
  }
  const ids = issueRepoIds(issue, repos).filter((id) => repos.some((repo) => repo.id === id));
  if (ids.length !== 1) throw new Error(CHOOSE_REPO_ERROR);
  return scopeOf(cwd, repos.find((repo) => repo.id === ids[0])!);
}

/** The `/api/git` args for a scope. */
export function forgeScopeArgs(scope: IssueForgeScope): { cwd: string; repo?: string } {
  return scope.repo ? { cwd: scope.cwd, repo: scope.repo } : { cwd: scope.cwd };
}

/** Grouping key for batch reads: one remote per key. */
export function forgeScopeKey(scope: IssueForgeScope): string {
  return `${scope.cwd}\u0000${scope.repo ?? ''}`;
}

/** Every remote an import should list issues from. */
export function importScopes(cwd: string, repos: readonly WorkspaceRepo[]): IssueForgeScope[] {
  if (repos.length < 2) return [{ cwd }];
  return repos.filter((repo) => repo.remote && repoSlug(repo)).map((repo) => scopeOf(cwd, repo));
}

/** True when a linked issue belongs to the scope's remote (legacy links without a repo match any). */
export function issueInScope(issue: Pick<IssueCard, 'github'>, scope: IssueForgeScope): boolean {
  if (!scope.slug || !issue.github?.repo) return true;
  return issue.github.repo.toLowerCase() === scope.slug.toLowerCase();
}

/**
 * Which GitHub repository an issue syncs with.
 *
 * In a single-repo workspace every forge call runs in the workspace, exactly as
 * before. In a folder of several repos each call names the repo: a linked issue
 * follows its stored remote identities and publishes missing copies to its targets.
 */

import type { IssueCard } from '../types';
import type { WorkspaceRepo } from '../state/workspace-repos';
import { issueGithubSlug, issueRepoIds } from './repo-scope';

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
  if (!repos.length || (repos.length === 1 && repos[0].isRoot && !issue.repos?.some((id) => id !== '.'))) {
    return { cwd };
  }
  const linkedSlug = issueGithubSlug(issue);
  if (linkedSlug) {
    const hit = repos.find((repo) => repoSlug(repo).toLowerCase() === linkedSlug);
    if (!hit) throw new Error(`GitHub repo ${issue.github?.repo} is not in this workspace any more.`);
    return scopeOf(cwd, hit);
  }
  // An unidentified legacy link cannot safely inherit a new publishing target.
  if (issue.github && !issue.repos?.length && repos.length > 1) throw new Error(CHOOSE_REPO_ERROR);
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
  if (!repos.length || (repos.length === 1 && repos[0].isRoot)) return [{ cwd }];
  return repos.filter((repo) => (repo.remote?.host === 'github' || repo.remote?.host === 'github-enterprise') && repoSlug(repo))
    .map((repo) => scopeOf(cwd, repo));
}

export function githubLinkInScope(issue: Pick<IssueCard, 'github' | 'githubReplicas' | 'repos'>, scope: IssueForgeScope) {
  const slug = issueGithubSlug(issue);
  if ((!scope.repo && !scope.slug) || (slug && slug === scope.slug?.toLowerCase()) ||
      (!slug && issue.repos?.length === 1 && issue.repos[0] === scope.repo)) return issue.github;
  if (scope.slug) {
    return issue.githubReplicas?.find((link) => issueGithubSlug({ github: link }) === scope.slug?.toLowerCase());
  }
}

export function resolveIssueForgeScopes(
  issue: Pick<IssueCard, 'workspacePath' | 'repos' | 'github' | 'githubReplicas'>,
  repos: readonly WorkspaceRepo[],
): IssueForgeScope[] {
  if (!issue.githubReplicas?.length && (!repos.length ||
      (repos.length === 1 && repos[0].isRoot && !issue.repos?.some((id) => id !== '.')))) {
    return [resolveIssueForgeScope(issue, repos)];
  }
  if (!issue.githubReplicas?.length &&
      ((issue.repos?.length ?? 0) < 2 && !(issue.github && issue.repos?.length))) {
    return [resolveIssueForgeScope(issue, repos)];
  }
  const linked = issue.github ? [resolveIssueForgeScope(issue, repos)] : [];
  for (const github of issue.githubReplicas ?? []) {
    linked.push(resolveIssueForgeScope({ ...issue, github }, repos));
  }
  const scopes = new Map(linked.map((scope) => [scope.slug?.toLowerCase() ?? forgeScopeKey(scope), scope]));
  for (const id of issue.repos ?? []) {
    const repo = repos.find((candidate) => candidate.id === id);
    if (!repo) throw new Error(`Repository ${id} is not in this workspace any more.`);
    const scope = scopeOf(issue.workspacePath, repo);
    const key = scope.slug?.toLowerCase() ?? forgeScopeKey(scope);
    if (!scopes.has(key)) scopes.set(key, scope);
  }
  return [...scopes.values()];
}

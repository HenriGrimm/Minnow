import { appendIssueLinks } from '../../state/issues-store.ts';
import { gitBranches, gitPush, gitRemoteUrl } from '../../state/git-api.ts';
import { forgeStatus, prCreate } from '../../state/forge-api.ts';
import { getWorkspacePath } from '../../state/workspace.ts';
import { lookupWorkspaceRepos, repoRemoteSlug } from '../../state/workspace-repos.ts';
import { issueGithubSlug } from '../../issues/repo-scope.ts';
import { issueWorkChat } from '../../issues/work-state.ts';
import { getChatMirrorBinding } from '../../state/chat-worktree.ts';
import { worktreePathsEqual } from '../../lib/worktree-list-parse.ts';
import { expandGitmojiShortcodes } from '../../lib/gitmoji-shortcodes.mjs';
import { commitUrl, githubIssueWebUrl, pullRequestUrl } from '../../lib/git-remote-url.ts';
import { executeTool } from '../../tools/client.ts';
import type { IssueCard, IssueGitLink } from '../../types.ts';
import { resolveIssuePrRef } from '../review/pr-review-target.ts';
import {
  buildIssueCommitGrepCommand,
  buildIssuePrBody,
  buildIssuePrTitle,
  draftIssueGitLink,
  extractFirstHttpUrl,
  normalizeCommitSha,
  parseGhVersionAvailable,
  parseGitHubIssueOrPrUrl,
  parseGitLogOneline,
  resolveIssueBranchName,
  type GitOnelineCommit,
} from './git-helpers.ts';

/** Cached `gh --version` probe (session lifetime). */
let ghAvailableCache: boolean | null = null;

export type IssueGitActionResult =
  | { ok: true; message?: string; url?: string; branch?: string }
  | { ok: false; error: string };

/** Reset gh cache (tests). */
export function resetGhAvailableCache(): void {
  ghAvailableCache = null;
}

// ── Detect ───────────────────────────────────────────────────────────────────

/** Detect GitHub CLI once; hide PR actions when false. */
export async function detectGhAvailable(force = false): Promise<boolean> {
  if (!force && ghAvailableCache != null) return ghAvailableCache;
  try {
    const { content } = await executeTool('execute_command', { command: 'gh --version' });
    ghAvailableCache = parseGhVersionAvailable(content);
  } catch {
    ghAvailableCache = false;
  }
  return ghAvailableCache;
}

/** Assigned repos are the only options. For an unassigned card, allow an explicit choice. */
export async function issueGitRepositories(issue: IssueCard) {
  const cwd = issue.workspacePath || getWorkspacePath();
  const repos = await lookupWorkspaceRepos({ workspacePath: cwd });
  if (!repos) throw new Error('Could not load the issue’s repositories. Try again.');
  if (!repos.length) throw new Error('This issue’s workspace has no Git repositories.');
  if (issue.repos?.length) {
    const assigned = repos.filter((repo) => issue.repos?.includes(repo.id));
    if (!assigned.length) throw new Error('The assigned repositories could not be found. Update the issue’s repositories.');
    return assigned;
  }
  const linkedSlug = issueGithubSlug(issue);
  const linked = linkedSlug ? repos.filter((repo) => repoRemoteSlug(repo).toLowerCase() === linkedSlug) : [];
  return linked.length ? linked : repos;
}

async function issueGitScope(issue: IssueCard, repoId?: string) {
  const repos = await issueGitRepositories(issue);
  const repo = repoId === undefined && repos.length === 1 ? repos[0] : repos.find((entry) => entry.id === repoId);
  if (!repo) throw new Error(repoId === undefined ? 'Choose a repository for this Git action.' : 'That repository is no longer available for this issue.');
  const linked = issueWorkChat(issue);
  const mirror = getChatMirrorBinding(linked);
  const source = linked?.workspacePreparation?.intent.source;
  const origin = source && 'repos' in source ? source.repos.find(row => worktreePathsEqual(row.path, repo.absPath)) : undefined;
  const checkout = mirror?.repos.find(row => row.id === origin?.id);
  return { cwd: issue.workspacePath || getWorkspacePath(), repo: repo.id,
    worktree: checkout && mirror ? { cwd: checkout.path, branch: mirror.branch, base: origin?.branch } : undefined };
}

/** Create/checkout `issue/iss-n-<slug>` and append a branch git link. */
export async function createBranchFromIssue(issue: IssueCard, repoId?: string): Promise<IssueGitActionResult> {
  return withIssueGitScope(issue, repoId, (scope) => checkoutIssueBranch(issue, scope));
}

type IssueGitScope = Awaited<ReturnType<typeof issueGitScope>>;

async function withIssueGitScope(
  issue: IssueCard,
  repoId: string | undefined,
  run: (scope: IssueGitScope) => Promise<IssueGitActionResult>,
): Promise<IssueGitActionResult> {
  try {
    return await run(await issueGitScope(issue, repoId));
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function checkoutIssueBranch(issue: IssueCard, scope: IssueGitScope): Promise<IssueGitActionResult> {
  const branch = scope.worktree?.branch ?? resolveIssueBranchName(issue, scope);
  const branches = await gitBranches(scope.worktree?.cwd ?? scope.cwd, undefined, scope.worktree ? undefined : scope.repo);
  if (!branches.ok) return { ok: false, error: branches.error ?? 'Could not list branches' };
  if (scope.worktree && branches.current !== branch) return { ok: false, error: `Restore ${branch} in the chat’s worktree before continuing.` };
  const existing = branches.current === branch || branches.local?.includes(branch) || branches.lockedLocal?.includes(branch);
  let checkedOut = branch;
  if (!scope.worktree) {
    // The shared flow asks about uncommitted files instead of carrying them silently.
    const { runCheckoutFlow } = await import('../../ui/git-checkout-confirm');
    const input = { cwd: scope.cwd, repo: scope.repo, branch };
    let result = await runCheckoutFlow({ ...input, create: !existing });
    if (!existing && !result.ok && /branch .+ already exists/i.test(result.error ?? '')) result = await runCheckoutFlow(input);
    if (!result.ok) return { ok: false, error: result.error ?? 'Could not create or check out the branch' };
    checkedOut = result.branch || branch;
  }
  const linked = issue.gitLinks?.some((link) => link.kind === 'branch' && link.ref === checkedOut &&
    (link.repo ?? '.') === scope.repo);
  if (!linked) {
    appendIssueLinks(issue.id, {
      gitLinks: [draftIssueGitLink('branch', checkedOut, { repo: scope.repo })],
    });
  }
  return { ok: true, message: scope.repo === '.' ? `On ${checkedOut}` : `On ${checkedOut} in ${scope.repo}`, branch: checkedOut };
}

/** Link a commit sha to the issue (manual). */
export async function linkCommitToIssue(
  issueId: string,
  shaInput: string,
): Promise<IssueGitActionResult> {
  const sha = normalizeCommitSha(shaInput);
  if (!sha) return { ok: false, error: 'Enter a valid commit sha (7–40 hex chars)' };

  let url: string | undefined;
  const remote = await gitRemoteUrl();
  if (remote.ok && remote.url) {
    url = commitUrl(remote.url, sha) ?? undefined;
  }

  appendIssueLinks(issueId, {
    gitLinks: [draftIssueGitLink('commit', sha, { url, title: sha.slice(0, 7) })],
  });
  return { ok: true, message: `Linked ${sha.slice(0, 7)}`, url };
}

/** Paste a GitHub issue/PR URL → git link chip. */
export async function linkGitHubUrlToIssue(
  issueId: string,
  urlInput: string,
): Promise<IssueGitActionResult> {
  const parsed = parseGitHubIssueOrPrUrl(urlInput);
  if (!parsed) {
    return { ok: false, error: 'Paste a GitHub issue or pull request URL' };
  }
  appendIssueLinks(issueId, {
    gitLinks: [
      draftIssueGitLink(parsed.kind, parsed.ref, { url: parsed.url, title: parsed.title }),
    ],
  });
  return { ok: true, message: `Linked ${parsed.kind === 'pr' ? 'PR' : 'issue'} #${parsed.ref}`, url: parsed.url };
}

/**
 * List commits that mention `[ISS-n]` via git log --grep, merged with manually linked shas.
 */
export async function listIssueCommits(issue: IssueCard): Promise<{
  ok: boolean;
  commits: GitOnelineCommit[];
  error?: string;
}> {
  const cmd = buildIssueCommitGrepCommand(issue.id);
  let grepped: GitOnelineCommit[] = [];
  try {
    const { content } = await executeTool('execute_command', { command: cmd });
    if (content.trimStart().startsWith('Error:')) {
      return { ok: false, commits: [], error: content.replace(/^Error:\s*/i, '').trim() };
    }
    grepped = parseGitLogOneline(content);
  } catch (err) {
    return {
      ok: false,
      commits: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const bySha = new Map<string, GitOnelineCommit>();
  for (const c of grepped) {
    bySha.set(c.sha.toLowerCase(), c);
  }
  for (const link of issue.gitLinks ?? []) {
    if (link.kind !== 'commit') continue;
    const key = link.ref.toLowerCase();
    const already = [...bySha.keys()].some((k) => k.startsWith(key) || key.startsWith(k));
    if (already) continue;
    bySha.set(key, {
      sha: link.ref,
      subject: link.title?.trim() || link.ref.slice(0, 7),
    });
  }

  return { ok: true, commits: [...bySha.values()] };
}

// ── PR ───────────────────────────────────────────────────────────────────────

/** Check out the issue branch, push it, and open its PR in the same repository. */
export async function createPrFromIssue(issue: IssueCard, repoId?: string): Promise<IssueGitActionResult> {
  return withIssueGitScope(issue, repoId, (scope) => openIssuePr(issue, scope));
}

async function openIssuePr(issue: IssueCard, scope: IssueGitScope): Promise<IssueGitActionResult> {
  const gitScope = scope.worktree ? { cwd: scope.worktree.cwd } : { cwd: scope.cwd, repo: scope.repo };
  const status = await forgeStatus(gitScope.cwd, gitScope.repo);
  if (!status.ok || !status.supported || !status.authenticated) {
    return { ok: false, error: status.reason || 'GitHub pull requests are unavailable in this repository' };
  }

  const branchResult = await checkoutIssueBranch(issue, scope);
  if (!branchResult.ok) return branchResult;

  const push = await gitPush({ ...gitScope, setUpstream: true, branch: branchResult.branch });
  if (!push.ok) return { ok: false, error: push.error ?? 'Push failed' };

  const title = buildIssuePrTitle(issue);
  const body = buildIssuePrBody(issue);
  const prRes = await prCreate({ ...gitScope, title, body, head: branchResult.branch, ...(scope.worktree?.base ? { base: scope.worktree.base } : {}) });
  if (!prRes.ok) {
    const detail = prRes.error || 'Could not create the pull request';
    return { ok: false, error: detail };
  }

  const url = prRes.url || extractFirstHttpUrl(prRes.stdout ?? '') || undefined;
  let ref = url ? (url.match(/\/pull\/(\d+)/)?.[1] ?? branchResult.branch ?? issue.id) : branchResult.branch ?? issue.id;
  if (url) {
    const parsed = parseGitHubIssueOrPrUrl(url);
    if (parsed) ref = parsed.ref;
  }

  appendIssueLinks(issue.id, {
    gitLinks: [draftIssueGitLink('pr', ref, { url, repo: scope.repo })],
  });

  return { ok: true, message: url ? `Opened PR ${url}` : 'Pull request created', url, branch: branchResult.branch };
}

export interface ResolvedIssuePr {
  number: number;
  url?: string;
  repo: string;
}

export async function resolveIssuePrNumber(issue: IssueCard): Promise<ResolvedIssuePr | null> {
  const stored = resolveIssuePrRef(issue);
  if (stored) {
    const repo = repoFromPrUrl(stored.url) || (await forgeRepo());
    if (!repo) return null;
    return { number: stored.number, url: stored.url, repo };
  }

  const hasGh = await detectGhAvailable();
  if (!hasGh) return null;

  const branch = resolveIssueBranchName(issue);
  const cmd = `gh pr list --head ${JSON.stringify(branch)} --json number,url --limit 1`;
  let content: string;
  try {
    const result = await executeTool('execute_command', { command: cmd });
    content = result.content;
  } catch {
    return null;
  }
  if (content.trimStart().startsWith('Error:')) return null;

  const parsed = parseGhPrListJson(content);
  if (!parsed) return null;

  const repo = repoFromPrUrl(parsed.url) || (await forgeRepo());
  if (!repo) return null;
  const { repoIdForRemoteSlug } = await import('../../state/workspace-repos.ts');
  const repoId = await repoIdForRemoteSlug(repo, issue.workspacePath);

  appendIssueLinks(issue.id, {
    gitLinks: [
      draftIssueGitLink('pr', String(parsed.number), {
        url: parsed.url,
        title: `PR #${parsed.number}`,
        ...(repoId ? { repo: repoId } : {}),
      }),
    ],
  });

  return { number: parsed.number, url: parsed.url, repo };
}

function repoFromPrUrl(url: string | undefined): string {
  if (!url) return '';
  const match = url.match(/github\.com\/([^/]+\/[^/]+)\/pull\//i);
  return match?.[1] ?? '';
}

async function forgeRepo(): Promise<string> {
  try {
    const status = await forgeStatus();
    return status.repo?.trim() ?? '';
  } catch {
    return '';
  }
}

function parseGhPrListJson(content: string): { number: number; url?: string } | null {
  const start = content.indexOf('[');
  const end = content.lastIndexOf(']');
  if (start < 0 || end <= start) return null;
  try {
    const rows = JSON.parse(content.slice(start, end + 1)) as unknown;
    if (!Array.isArray(rows) || !rows[0] || typeof rows[0] !== 'object') return null;
    const row = rows[0] as { number?: unknown; url?: unknown };
    const number = typeof row.number === 'number' ? row.number : Number(row.number);
    if (!Number.isFinite(number) || number <= 0) return null;
    return {
      number,
      url: typeof row.url === 'string' ? row.url : undefined,
    };
  } catch {
    return null;
  }
}

/** Resolve a web URL for a git link chip (stored url, or build from origin). */
export async function resolveGitLinkOpenUrl(link: IssueGitLink): Promise<string | null> {
  if (link.url?.trim()) return link.url.trim();
  const remote = await gitRemoteUrl();
  if (!remote.ok || !remote.url) return null;
  if (link.kind === 'commit') return commitUrl(remote.url, link.ref);
  if (link.kind === 'pr') return pullRequestUrl(remote.url, link.ref);
  if (link.kind === 'github-issue') return githubIssueWebUrl(remote.url, link.ref);
  return null;
}

// ── Open ─────────────────────────────────────────────────────────────────────

/** Open commit in the Code git side panel + commit diff (existing graph UX). */
export async function openIssueCommitInGitUi(sha: string, subject?: string): Promise<void> {
  const { openGitSidePanel } = await import('../../ui/git-panel.ts');
  await openGitSidePanel();
  const { openGitCommitDiffPanel } = await import('../../ui/git-commit-diff-panel.ts');
  await openGitCommitDiffPanel({
    sha,
    subject: subject ? expandGitmojiShortcodes(subject) : subject,
  });
}

/** Open a URL via Electron shell or browser tab (same pattern as git-graph context menu). */
export function openExternalGitUrl(url: string): void {
  if (typeof window !== 'undefined' && window.minnow?.app?.openExternal) {
    void window.minnow.app.openExternal(url);
    return;
  }
  if (typeof window !== 'undefined') {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}

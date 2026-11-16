import { appendIssueLinks } from '../../state/issues-store.ts';
import { gitPush, gitRemoteUrl } from '../../state/git-api.ts';
import { forgeStatus } from '../../state/forge-api.ts';
import { openWorkspacePr } from '../../state/worktree-service.ts';
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

// ── Branch ───────────────────────────────────────────────────────────────────

/** Create/checkout `issue/iss-n-<slug>` and append a branch git link. */
export async function createBranchFromIssue(issue: IssueCard): Promise<IssueGitActionResult> {
  const branch = resolveIssueBranchName(issue);
  const existing = (issue.gitLinks ?? []).some((l) => l.kind === 'branch' && l.ref === branch);
  // The shared flow asks about uncommitted files instead of carrying them silently.
  const { runCheckoutFlow } = await import('../../ui/git-checkout-confirm');
  const result = await runCheckoutFlow({ branch, create: !existing });
  if (!result.ok) {
    if (result.error === 'cancelled') return { ok: false, error: 'cancelled' };
    if (!existing) {
      const retry = await runCheckoutFlow({ branch });
      if (!retry.ok) {
        return { ok: false, error: retry.error ?? result.error ?? 'Could not create or checkout branch' };
      }
    } else {
      return { ok: false, error: result.error ?? 'Could not checkout branch' };
    }
  }

  appendIssueLinks(issue.id, {
    gitLinks: [draftIssueGitLink('branch', branch, { title: branch })],
  });
  return { ok: true, message: `On ${branch}`, branch };
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

/**
 * Checkout the issue branch (create if needed), push, then `gh pr create` via openWorkspacePr.
 */
export async function createPrFromIssue(issue: IssueCard): Promise<IssueGitActionResult> {
  const hasGh = await detectGhAvailable();
  if (!hasGh) {
    return { ok: false, error: 'GitHub CLI (gh) is not available' };
  }

  const branchResult = await createBranchFromIssue(issue);
  if (!branchResult.ok) return branchResult;

  const push = await gitPush({ setUpstream: true });
  if (!push.ok) {
    const still = push.error ?? 'Push failed';
    if (/server_off|no.?remote|does not appear to be a git|not a git repository/i.test(still)) {
      return { ok: false, error: still };
    }
  }

  const title = buildIssuePrTitle(issue);
  const body = buildIssuePrBody(issue);
  const prRes = await openWorkspacePr({ title, body });
  if (!prRes.ok) {
    const detail = prRes.output?.trim() || prRes.error || 'gh pr create failed';
    return { ok: false, error: detail };
  }

  const url = prRes.url || extractFirstHttpUrl(prRes.output ?? '') || undefined;
  let ref = url ? (url.match(/\/pull\/(\d+)/)?.[1] ?? branchResult.branch ?? issue.id) : branchResult.branch ?? issue.id;
  if (url) {
    const parsed = parseGitHubIssueOrPrUrl(url);
    if (parsed) ref = parsed.ref;
  }

  appendIssueLinks(issue.id, {
    gitLinks: [draftIssueGitLink('pr', ref, { url, title: title.slice(0, 80) })],
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

  appendIssueLinks(issue.id, {
    gitLinks: [
      draftIssueGitLink('pr', String(parsed.number), {
        url: parsed.url,
        title: `PR #${parsed.number}`,
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

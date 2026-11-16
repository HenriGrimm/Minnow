/**
 * Classify git / GitHub (`gh`) stderr into a title, summary, and raw details.
 * First matching kind wins; order is specific → generic.
 */

import { OPEN_MINNOW_RETRY } from '../copy/local-session';
import { isLocalServerOfflineError } from '../issues/github-error';

export type GitErrorKind =
  | 'auth'
  | 'gh_missing'
  | 'permission'
  | 'rejected'
  | 'protected_branch'
  | 'conflict'
  | 'hook'
  | 'timeout'
  | 'network'
  | 'nothing_to_commit'
  | 'worktree_in_use'
  | 'overwrite'
  | 'missing_ref'
  | 'lock_file'
  | 'busy'
  | 'stale'
  | 'partial'
  | 'server_off'
  | 'generic';

export interface ParsedGitError {
  kind: GitErrorKind;
  title: string;
  summary: string;
  details: string;
}

/** Lines shown in the popover `<pre>` before “Show more”. */
export const GIT_ERROR_DETAILS_PREVIEW_LINES = 12;

const KIND_COPY: Record<
  Exclude<GitErrorKind, 'generic' | 'server_off'>,
  { title: string; summary: string }
> = {
  auth: {
    title: 'Not signed in to GitHub',
    summary: 'Sign in with gh auth login, then try again.',
  },
  gh_missing: {
    title: 'GitHub CLI is not installed',
    summary: 'Install GitHub CLI (gh) and restart Minnow.',
  },
  permission: {
    title: 'Permission denied',
    summary: 'This account does not have permission to update the repository.',
  },
  rejected: {
    title: 'Push rejected',
    summary:
      'The remote has commits you do not have locally. Pull or rebase, then push again.',
  },
  protected_branch: {
    title: 'Protected branch',
    summary:
      'This branch is protected on GitHub. Push to a feature branch or open a pull request.',
  },
  conflict: {
    title: 'Merge conflict',
    summary:
      'Git stopped because files have conflicting changes. Resolve the conflicts, then continue.',
  },
  hook: {
    title: 'Git hook failed',
    summary: 'A local git hook blocked this operation. Check the hook output in Details.',
  },
  timeout: {
    title: 'GitHub timed out',
    summary: 'GitHub did not respond in time. Try again.',
  },
  network: {
    title: 'Could not reach the remote',
    summary: 'The remote could not be reached. Check your network and try again.',
  },
  nothing_to_commit: {
    title: 'Nothing to commit',
    summary: 'There are no staged changes to commit.',
  },
  worktree_in_use: {
    title: 'Checked out in another worktree',
    summary: 'Git allows a branch in one worktree at a time. Open that worktree, or use it for this chat.',
  },
  overwrite: {
    title: 'Local changes would be overwritten',
    summary: 'Some uncommitted files differ on the target branch. Leave your changes on this branch, or commit them first.',
  },
  missing_ref: {
    title: 'Branch not found',
    summary: 'Git could not find that branch or commit here. Fetch from the remote and try again.',
  },
  lock_file: {
    title: 'Git is busy in this checkout',
    summary: 'Another Git process holds the index lock. Wait for it to finish; remove .git/index.lock only if no Git command is running.',
  },
  busy: {
    title: 'A local action is using this checkout',
    summary: 'Stop the action or wait for it to finish, then try again.',
  },
  stale: {
    title: 'The branch changed',
    summary: 'This checkout moved to another branch since you opened the picker. Choose again.',
  },
  partial: {
    title: 'Switched, but the update failed',
    summary: 'The pull request branch is checked out, but GitHub could not finish updating it. Pull to retry; any saved changes stay on the previous branch.',
  },
};

/** Server `code` → error kind; codes win over English pattern matching. */
const CODE_KIND: Partial<Record<string, GitErrorKind>> = {
  in_worktree: 'worktree_in_use',
  overwrite: 'overwrite',
  missing_ref: 'missing_ref',
  lock_file: 'lock_file',
  busy: 'busy',
  stale_branch: 'stale',
  partial: 'partial',
};

/** True when the line is git/gh noise, not a useful first-line summary. */
function isNoiseLine(line: string): boolean {
  return /^(hint:|remote:|warning:|To https?:|To git@)/i.test(line);
}

/** First non-empty stderr line that is not a hint/remote prefix. */
export function firstMeaningfulGitErrorLine(text: string): string {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^[Xx✗]\s+/, '').trim();
    if (!line || isNoiseLine(line)) continue;
    return line;
  }
  return '';
}

/** Split raw details into the preview block and the overflow remainder. */
export function splitGitErrorDetails(details: string): { preview: string; rest: string } {
  const lines = details.split(/\n/);
  if (lines.length <= GIT_ERROR_DETAILS_PREVIEW_LINES) {
    return { preview: details, rest: '' };
  }
  return {
    preview: lines.slice(0, GIT_ERROR_DETAILS_PREVIEW_LINES).join('\n'),
    rest: lines.slice(GIT_ERROR_DETAILS_PREVIEW_LINES).join('\n'),
  };
}

function classify(text: string): GitErrorKind {
  if (isLocalServerOfflineError(text) || /^HTTP 50[023]$/i.test(text)) {
    return 'server_off';
  }
  if (
    /github cli is not installed/i.test(text) ||
    /could not find gh/i.test(text) ||
    /\bgh(?:\.exe)?\b.+(?:not found|not recognized|ENOENT)/i.test(text) ||
    /'gh' is not recognized/i.test(text) ||
    /exec:\s*"?gh"?/i.test(text)
  ) {
    return 'gh_missing';
  }
  if (
    /gh auth login/i.test(text) ||
    /not logged into any github/i.test(text) ||
    /not signed in/i.test(text) ||
    /authentication failed/i.test(text) ||
    /could not read Username/i.test(text) ||
    /Permission denied \(publickey\)/i.test(text)
  ) {
    return 'auth';
  }
  if (
    /protected branch/i.test(text) ||
    /\bGH006\b/i.test(text) ||
    /cannot force-push to this protected/i.test(text) ||
    /branch is currently locked/i.test(text)
  ) {
    return 'protected_branch';
  }
  if (/hook (?:declined|failed)/i.test(text) || /\bpre-commit\b/i.test(text) || /\bhusky\b/i.test(text)) {
    return 'hook';
  }
  if (
    /CONFLICT \(/i.test(text) ||
    /merge conflict/i.test(text) ||
    /Automatic merge failed/i.test(text) ||
    /pull request.+not mergeable.+(?:conflict|cannot be cleanly)/is.test(text) ||
    /mergeable:\s*CONFLICTING/i.test(text) ||
    /unmerged paths/i.test(text) ||
    // Git's own hint, not any line that mentions the words (e.g. a commit subject).
    /\bfix conflicts and then commit\b/i.test(text)
  ) {
    return 'conflict';
  }
  if (
    /non-fast-forward/i.test(text) ||
    /\[rejected\]/i.test(text) ||
    /failed to push some refs/i.test(text) ||
    /Updates were rejected/i.test(text)
  ) {
    return 'rejected';
  }
  if (
    /Permission to .+ denied/i.test(text) ||
    /write access/i.test(text) ||
    /\bHTTP 403\b/i.test(text) ||
    /ERROR: Permission denied/i.test(text)
  ) {
    return 'permission';
  }
  // A bare "timeout" also appears in file names, options and hook output.
  if (/timed out/i.test(text) || /\bETIMEDOUT\b/.test(text) || /\b(?:operation|connection|request|gateway|read) timeout\b/i.test(text)) {
    return 'timeout';
  }
  if (
    /Could not resolve host/i.test(text) ||
    /Failed to connect/i.test(text) ||
    /network is unreachable/i.test(text) ||
    /Connection refused/i.test(text)
  ) {
    return 'network';
  }
  if (/nothing to commit/i.test(text) || /nothing added to commit/i.test(text)) {
    return 'nothing_to_commit';
  }
  if (/already used by worktree|is already checked out at/i.test(text)) return 'worktree_in_use';
  if (/would be overwritten by checkout/i.test(text)) return 'overwrite';
  if (/index\.lock/i.test(text)) return 'lock_file';
  if (/A local action is running in this worktree/i.test(text)) return 'busy';
  // `missing_ref` comes only from the server code: the same pathspec text is
  // emitted by `git add` for missing files.
  return 'generic';
}

/** Parse git/`gh` stderr into structured copy for the error popover. */
export function parseGitError(error: string | undefined, fallback = 'Git operation failed', code?: string): ParsedGitError {
  const details = (error ?? '').trim() || fallback;
  const kind = (code && CODE_KIND[code]) || classify(details);

  if (kind === 'server_off') {
    return {
      kind,
      title: 'Minnow is not running',
      summary: OPEN_MINNOW_RETRY,
      details,
    };
  }

  if (kind !== 'generic') {
    const copy = KIND_COPY[kind];
    return { kind, title: copy.title, summary: copy.summary, details };
  }

  const meaningful = firstMeaningfulGitErrorLine(details);
  return {
    kind,
    title: 'Git operation failed',
    summary: meaningful || 'The git command failed. See Details for the full output.',
    details,
  };
}

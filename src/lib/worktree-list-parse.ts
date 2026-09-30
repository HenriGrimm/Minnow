/**
 * Parse `git worktree list --porcelain` output into structured entries (MIN-198 P3).
 */

export interface ParsedWorktree {
  path: string;
  head: string;
  /** Short branch name when checked out on a branch. */
  branch?: string;
  detached: boolean;
  bare?: boolean;
}

/** Parse porcelain blocks emitted by `git worktree list --porcelain`. */
export function parseWorktreeListPorcelain(output: string): ParsedWorktree[] {
  const worktrees: ParsedWorktree[] = [];
  let current: Partial<ParsedWorktree> | null = null;

  for (const rawLine of String(output ?? '').split('\n')) {
    const line = rawLine.trimEnd();
    if (!line) continue;

    if (line.startsWith('worktree ')) {
      if (current?.path) {
        worktrees.push(finishWorktreeEntry(current));
      }
      current = { path: line.slice('worktree '.length), detached: false };
      continue;
    }

    if (!current) continue;

    if (line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length);
    } else if (line.startsWith('branch ')) {
      const ref = line.slice('branch '.length);
      current.branch = ref.replace(/^refs\/heads\//, '');
    } else if (line === 'detached') {
      current.detached = true;
    } else if (line === 'bare') {
      current.bare = true;
    }
  }

  if (current?.path) {
    worktrees.push(finishWorktreeEntry(current));
  }

  return worktrees;
}

function finishWorktreeEntry(entry: Partial<ParsedWorktree>): ParsedWorktree {
  return {
    path: entry.path ?? '',
    head: entry.head ?? '',
    branch: entry.branch,
    detached: entry.detached === true,
    bare: entry.bare,
  };
}

/**
 * Normalize a worktree/workspace path for equality checks.
 * Mirrors `normalizePathForComparison` (slashes + Windows drive casing) without
 * importing the tools layer into this shared parse helper.
 */
export function normalizeWorktreePath(p: string): string {
  let path = String(p ?? '').trim().replace(/\\/g, '/');
  path = path.replace(/\/+/g, '/');
  if (/^[a-zA-Z]:\//.test(path)) {
    path = path.charAt(0).toUpperCase() + path.slice(1);
  }
  if (path.length > 1 && path.endsWith('/')) {
    path = path.slice(0, -1);
  }
  return path;
}

/** True when two worktree paths refer to the same directory (MIN-780). */
export function worktreePathsEqual(a: string, b: string): boolean {
  const na = normalizeWorktreePath(a);
  const nb = normalizeWorktreePath(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (/^[a-zA-Z]:\//.test(na) || /^[a-zA-Z]:\//.test(nb)) {
    return na.toLowerCase() === nb.toLowerCase();
  }
  return false;
}

/**
 * Git’s principal checkout — always the first `git worktree list --porcelain`
 * entry (same rule as server `resolveMainWorktreePath`).
 */
export function getPrincipalWorktree(
  worktrees: readonly ParsedWorktree[],
): ParsedWorktree | undefined {
  return worktrees[0];
}

/** True when `worktreePath` is the repo’s principal checkout. */
export function isPrincipalWorktreePath(
  worktreePath: string,
  worktrees: readonly ParsedWorktree[],
): boolean {
  const principal = getPrincipalWorktree(worktrees);
  if (!principal?.path) return false;
  return worktreePathsEqual(worktreePath, principal.path);
}

export interface FormatWorktreeOptionLabelOptions {
  /** Absolute path of the git principal worktree (first porcelain entry). */
  principalPath?: string;
}

/** Compact label for a worktree row in the git panel cwd dropdown. */
export function formatWorktreeOptionLabel(
  wt: ParsedWorktree,
  workspaceRoot: string,
  options?: FormatWorktreeOptionLabelOptions,
): string {
  const branchLabel = wt.branch
    ? wt.branch
    : wt.detached
      ? '(detached)'
      : '(unknown)';

  if (worktreePathsEqual(wt.path, workspaceRoot)) {
    return `${branchLabel} — workspace`;
  }

  if (options?.principalPath && worktreePathsEqual(wt.path, options.principalPath)) {
    return `${branchLabel} — main worktree`;
  }

  const normPath = normalizeWorktreePath(wt.path);
  const leaf = normPath.split('/').pop() ?? normPath;
  if (wt.branch && isMinnowBoardBranch(wt.branch) && wt.branch.split('/').pop() === leaf) {
    return branchLabel;
  }
  return `${branchLabel} — ${leaf}`;
}

/** Minnow orchestration branches created for board worktrees. */
export function isMinnowBoardBranch(name: string): boolean {
  return name.startsWith('minnow/board/');
}

function normalizePathForCompare(p: string): string {
  return normalizeWorktreePath(p).toLowerCase();
}

/** Branches checked out in a worktree other than `mainWorkspaceRoot`. */
export function branchesLockedToOtherWorktrees(
  worktrees: ParsedWorktree[],
  mainWorkspaceRoot: string,
): Set<string> {
  const main = normalizePathForCompare(mainWorkspaceRoot);
  const locked = new Set<string>();
  for (const wt of worktrees) {
    const branch = wt.branch?.trim();
    if (!branch) continue;
    if (normalizePathForCompare(wt.path) === main) continue;
    locked.add(branch);
  }
  return locked;
}

/**
 * Local branches suitable for user-facing checkout pickers.
 * Omits refs already checked out in another worktree (git will refuse).
 * Board branches stay listed once their worktree is gone (MIN-789).
 */
export function filterUserFacingBranches(
  local: string[],
  lockedElsewhere?: Iterable<string>,
): string[] {
  const locked = new Set(lockedElsewhere ?? []);
  return local.filter((b) => !locked.has(b));
}

function posixPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '');
}

/**
 * Repo key segment under `…/worktrees/<repoKey>/…`, or null when this is not
 * a Minnow-managed slot. The segment name is exactly `worktrees` — not the
 * repo-local `.worktrees` directory.
 */
export function minnowWorktreesRepoKeyFromPath(worktreePath: string): string | null {
  const parts = posixPath(worktreePath).split('/');
  const index = parts.findIndex((segment) => segment === 'worktrees');
  if (index === -1 || index === parts.length - 1) return null;
  const key = parts[index + 1];
  return key || null;
}

/**
 * User-facing worktree pickers.
 *
 * `git worktree list` is already scoped to this repository, so every porcelain
 * entry is a checkout of this git dir — including orchestrator slots under
 * `~/.minnow/worktrees/`. Dropping those by reconstructing a client-side repo
 * key hid this-repo board worktrees when the Code workspace was a linked
 * checkout or on Windows (MIN-789). `workspaceRoot` is kept on the signature
 * so callers stay stable.
 */
export function filterUserFacingWorktrees(
  worktrees: ParsedWorktree[],
  _workspaceRoot: string,
): ParsedWorktree[] {
  return worktrees.filter((wt, index) => index === 0 || Boolean(wt.path));
}

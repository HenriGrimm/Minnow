/**
 * User-facing worktree titles (MIN-14).
 *
 * Minnow-managed checkouts live in folders named after opaque ids
 * (`…/worktrees/<repo>/chat/<chatId>`) on generated branches
 * (`minnow/<slug>-<hash>`, `minnow/agent-<hash>`, `minnow/board/<id>/<slot>`).
 * Neither string is meant for people. Every surface that names a worktree
 * should go through {@link worktreeTitle} so the same checkout reads the same
 * way everywhere; raw paths and branches belong in tooltips or secondary text.
 *
 * Branches the user named themselves are shown verbatim — they are the name
 * the user typed and must stay recognisable in git.
 */

import {
  normalizeWorktreePath,
  worktreePathsEqual,
  type ParsedWorktree,
} from './worktree-list-parse';

export interface WorktreeTitleSource {
  path?: string;
  branch?: string;
  detached?: boolean;
}

export interface WorktreeTitleContext {
  /** Code workspace root. */
  workspaceRoot?: string;
  /** Git principal checkout (first `git worktree list` entry). */
  principalPath?: string;
  /** Title of the chat that owns this checkout, when one is known. */
  chatTitle?: string;
}

const MINNOW_BRANCH_PREFIX = 'minnow/';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * Uniqueness suffix on generated chat branches: `-<hex>` containing at least
 * one digit (so words such as `-deface` survive), plus an optional `-2`
 * collision counter.
 */
const GENERATED_HASH_SUFFIX = /-(?=[0-9a-f]*\d)[0-9a-f]{6,12}(?:-\d{1,3})?$/i;
/** Hash appended to over-long board slot ids (`slotIdForTask`). */
const BOARD_SLOT_HASH_SUFFIX = /-[0-9a-f]{12}$/i;

function stripHeads(branch: string | undefined): string {
  return String(branch ?? '').trim().replace(/^refs\/heads\//, '');
}

function pathLeaf(path: string | undefined): string {
  const normalized = normalizeWorktreePath(path ?? '');
  return normalized.split('/').filter(Boolean).pop() ?? '';
}

/** True for branches Minnow created (`minnow/…`), which are never typed by people. */
export function isMinnowGeneratedBranch(branch: string | undefined): boolean {
  return stripHeads(branch).startsWith(MINNOW_BRANCH_PREFIX);
}

/** Folder names that identify a slot but mean nothing to people (UUIDs, hashes). */
export function isOpaqueWorktreeName(name: string | undefined): boolean {
  const value = String(name ?? '').trim();
  if (!value) return true;
  return UUID.test(value)
    || /^(agent-)?[0-9a-f]{8,}$/i.test(value)
    || /[0-9a-f]{16,}/i.test(value);
}

function capitalize(value: string): string {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

/**
 * `min-14-improve-worktree-titling` → `MIN-14 Improve worktree titling`.
 * A leading `<letters>-<number>` pair reads as an issue key.
 */
export function humanizeWorktreeSlug(slug: string): string {
  const segments = String(slug ?? '').split('/').map((segment) => {
    const words = segment.split(/[-_\s]+/).filter(Boolean);
    if (!words.length) return '';
    let key = '';
    if (words.length > 1 && /^[a-z]{2,10}$/i.test(words[0]!) && /^\d+$/.test(words[1]!)) {
      key = `${words[0]!.toUpperCase()}-${words[1]}`;
      words.splice(0, 2);
    }
    const rest = capitalize(words.join(' '));
    return [key, rest].filter(Boolean).join(' ');
  }).filter(Boolean);
  return segments.join(' / ');
}

function humanizeBoardSlot(slot: string): string {
  if (slot === 'integration') return 'Board integration';
  const bare = slot.replace(BOARD_SLOT_HASH_SUFFIX, '');
  const match = /^(.*?)-wave(\d+)-(.+)$/i.exec(bare);
  if (match) {
    const board = humanizeWorktreeSlug(match[1]!) || 'Board';
    return `${board} · Wave ${match[2]} · ${match[3]}`;
  }
  const task = bare.split('/').filter(Boolean).pop();
  return task ? `Board task ${task}` : 'Board task';
}

/**
 * Readable title for a branch. Minnow-generated branches lose their prefix and
 * hash suffix; anything else is returned unchanged.
 */
export function humanizeWorktreeBranch(branch: string | undefined): string {
  const name = stripHeads(branch);
  if (!name.startsWith(MINNOW_BRANCH_PREFIX)) return name;
  const rest = name.slice(MINNOW_BRANCH_PREFIX.length);
  const board = /^board\/[^/]+\/(.+)$/.exec(rest);
  if (board) return humanizeBoardSlot(board[1]!);
  if (rest.startsWith('watch/')) return 'Watch checkout';
  if (/^agent-[0-9a-f]+$/i.test(rest)) return 'Sub-agent worktree';
  return humanizeWorktreeSlug(rest.replace(GENERATED_HASH_SUFFIX, '')) || 'Worktree';
}

/**
 * The one user-facing name for a checkout.
 *
 * Order: the principal checkout keeps its folder (repository) name; a
 * Minnow-managed checkout uses its owning chat's title, else its humanized
 * generated branch; a checkout the user made keeps its readable folder name,
 * else its branch; otherwise a generic label.
 */
export function worktreeTitle(wt: WorktreeTitleSource, ctx: WorktreeTitleContext = {}): string {
  const path = wt.path?.trim() ?? '';
  const leaf = pathLeaf(path);
  const branch = stripHeads(wt.branch);
  const generated = !branch || isMinnowGeneratedBranch(branch);
  const isPrincipal = Boolean(path && ctx.principalPath && worktreePathsEqual(path, ctx.principalPath));
  const isWorkspace = Boolean(path && ctx.workspaceRoot && worktreePathsEqual(path, ctx.workspaceRoot));

  if (isPrincipal || (isWorkspace && !isMinnowGeneratedBranch(branch) && !isOpaqueWorktreeName(leaf))) {
    return leaf && !isOpaqueWorktreeName(leaf) ? leaf : 'Main worktree';
  }
  const chatTitle = ctx.chatTitle?.trim();
  if (chatTitle && generated) return chatTitle;
  if (branch && isMinnowGeneratedBranch(branch)) return humanizeWorktreeBranch(branch);
  if (leaf && !isOpaqueWorktreeName(leaf)) return leaf;
  if (branch) return branch;
  return wt.detached ? 'Detached worktree' : 'Worktree';
}

/**
 * Branch worth showing next to a title: hidden when it is generated (the title
 * already says it) or identical to the title.
 */
export function worktreeBranchDetail(wt: WorktreeTitleSource, title: string): string {
  const branch = stripHeads(wt.branch);
  if (!branch) return wt.detached ? 'detached' : '';
  if (isMinnowGeneratedBranch(branch) || branch === title) return '';
  return branch;
}

export interface FormatWorktreeOptionLabelOptions {
  /** Absolute path of the git principal worktree (first porcelain entry). */
  principalPath?: string;
  /** Title of the chat that owns a checkout, by path. */
  chatTitleFor?: (path: string) => string | undefined;
}

/** Compact label for a worktree row in pickers and dropdowns. */
export function formatWorktreeOptionLabel(
  wt: ParsedWorktree,
  workspaceRoot: string,
  options?: FormatWorktreeOptionLabelOptions,
): string {
  const branchLabel = wt.branch
    ? humanizeWorktreeBranch(wt.branch)
    : wt.detached
      ? '(detached)'
      : '(unknown)';

  if (worktreePathsEqual(wt.path, workspaceRoot)) {
    return `${branchLabel} — workspace`;
  }
  if (options?.principalPath && worktreePathsEqual(wt.path, options.principalPath)) {
    return `${branchLabel} — main worktree`;
  }

  const title = worktreeTitle(wt, {
    workspaceRoot,
    principalPath: options?.principalPath,
    chatTitle: options?.chatTitleFor?.(wt.path),
  });
  const detail = worktreeBranchDetail(wt, title);
  return detail ? `${title} — ${detail}` : title;
}

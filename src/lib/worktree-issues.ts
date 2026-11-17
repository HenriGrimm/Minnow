/**
 * Plain-language diagnosis for worktrees Source Control could not remove, and
 * which tool made a worktree. Git's own refusals ("cannot remove a locked
 * working tree … use 'remove -f -f'") name a flag, not a fix.
 */

import { normalizeWorktreePath } from './worktree-list-parse';

export interface WorktreeOrigin {
  id: 'codex' | 'claude' | 'cursor' | 'minnow';
  label: string;
  /** Tooltip: what made it, so a stray checkout can be traced back. */
  hint: string;
}

/** Tools that create worktrees under their own home folder. */
export function worktreeOrigin(worktreePath: string): WorktreeOrigin | null {
  const p = `/${normalizeWorktreePath(worktreePath).toLowerCase()}/`;
  if (p.includes('/.codex/worktrees/')) {
    return { id: 'codex', label: 'Codex', hint: 'Made by the Codex app for one of its tasks' };
  }
  if (p.includes('/.claude/worktrees/')) {
    return { id: 'claude', label: 'Claude Code', hint: 'Made by a Claude Code worktree session' };
  }
  if (p.includes('/.cursor/worktrees/')) {
    return { id: 'cursor', label: 'Cursor', hint: 'Made by a Cursor agent' };
  }
  if (/\/\.minnow[^/]*\/worktrees\//.test(p)) {
    return {
      id: 'minnow',
      label: 'Minnow',
      hint: /\/worktrees\/[^/]+\/chat\//.test(p) ? 'Made by Minnow for a chat' : 'Made by Minnow for a board task',
    };
  }
  return null;
}

/** Map key for a worktree path: Windows paths compare case-insensitively. */
export function worktreeKey(worktreePath: string): string {
  const normalized = normalizeWorktreePath(worktreePath);
  return /^[a-zA-Z]:\//.test(normalized) ? normalized.toLowerCase() : normalized;
}

export type WorktreeIssueKind = 'stale' | 'locked' | 'dirty' | 'failed';

export interface WorktreeIssue {
  kind: WorktreeIssueKind;
  message: string;
  /** Raw git output, for the details disclosure. */
  detail?: string;
}

export interface WorktreeRemoveFailure {
  ok: boolean;
  error?: string;
  code?: string;
  lockReason?: string;
  missing?: boolean;
}

/**
 * What is wrong with a worktree row, or null when nothing needs fixing.
 * `missing`/`locked` come from the list; `failure` from the last removal attempt.
 */
export function describeWorktreeIssue(input: {
  path: string;
  missing?: boolean;
  locked?: boolean;
  lockReason?: string;
  failure?: WorktreeRemoveFailure;
}): WorktreeIssue | null {
  const { failure } = input;
  const origin = worktreeOrigin(input.path);
  const who = origin?.label ?? 'another tool';
  const lockReason = failure?.lockReason ?? input.lockReason;
  const locked = Boolean(input.locked || failure?.code === 'locked' || failure?.lockReason !== undefined);
  const detail = failure?.error?.trim() || undefined;

  if (input.missing || failure?.missing) {
    return {
      kind: 'stale',
      message: locked
        ? `Folder already deleted. ${who} left Git's record locked${lockReason ? ` ("${lockReason}")` : ''}, so Git can't clean it up on its own. Nothing on disk is left to lose.`
        : 'Folder already deleted. Only Git\'s record is left; nothing on disk is left to lose.',
      detail,
    };
  }
  if (!failure || failure.ok) return null;
  if (failure.code === 'dirty') {
    return {
      kind: 'dirty',
      message: 'Kept because it has uncommitted or untracked files. Review them, or force remove to delete them for good.',
      detail,
    };
  }
  if (locked) {
    return {
      kind: 'locked',
      message: `Locked by ${who}${lockReason ? ` ("${lockReason}")` : ''}. Unlock it only if ${who} is no longer working in it.`,
      detail,
    };
  }
  return {
    kind: 'failed',
    message: firstLine(detail) || 'Git could not remove this worktree.',
    detail,
  };
}

function firstLine(text: string | undefined): string {
  return (text ?? '').split(/\r?\n/).map((line) => line.replace(/^fatal:\s*/i, '').trim()).find(Boolean) ?? '';
}

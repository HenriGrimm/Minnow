import { streamingChatIds } from '../app-state';
import { normalizeModeId } from './modes/types';
import { truncateChatHistory } from './history-truncate';
import {
  gitLog,
  gitSnapshotDiff,
  gitSnapshotRestore,
} from '../state/git-api';
import {
  clearActiveBranch,
  getActiveRun,
  isBranchActivatable,
  listRunsAtFork,
  persistActiveBranchSuffix,
} from '../state/runs-store';
import {
  findChatById,
  getActiveChat,
  scheduleSaveSessions,
  touchChat,
} from '../state/sessions';
import type { Chat, TurnRunRecord } from '../types';
import { CANONICAL_HISTORY_HINT, supportsLocalHistoryMutation } from '../state/chat-relationships';

export type UndoBlockReason =
  | 'streaming'
  | 'orchestrate'
  | 'board'
  | 'worktree'
  | 'no_turn'
  | 'canonical_history'
  | 'not_found';

// ── Types ────────────────────────────────────────────────────────────────────

export interface UndoEligibility {
  ok: boolean;
  reason?: UndoBlockReason;
  /** Human tooltip / status */
  message?: string;
  target?: { runId: string; forkHistoryIndex: number };
}

export interface UndoConfirmInfo {
  /** Paths that would change when restoring the snapshot. */
  files: string[];
  /** True when HEAD tip moved since the turn's pre-snapshot. */
  divergentHead: boolean;
  /** undo → pre snapshot; redo → post snapshot. */
  kind: 'undo' | 'redo';
}

/** Injectable git helpers so unit tests need not mock the whole git-api module. */
export interface UndoGitDeps {
  snapshotDiff: typeof gitSnapshotDiff;
  snapshotRestore: typeof gitSnapshotRestore;
  log: typeof gitLog;
}

const defaultUndoGit: UndoGitDeps = {
  snapshotDiff: gitSnapshotDiff,
  snapshotRestore: gitSnapshotRestore,
  log: gitLog,
};

export interface UndoTurnOptions {
  /** Attempt file restore when snapshot SHAs are present (default true). */
  restoreFiles?: boolean;
  /** Confirm dialog hook (tests / custom UI); defaults to in-app appConfirm. */
  confirm?: (info: UndoConfirmInfo) => boolean | Promise<boolean>;
  /** Test seam — override git snapshot/log calls. */
  git?: Partial<UndoGitDeps>;
}

export interface UndoTurnResult {
  ok: boolean;
  error?: UndoBlockReason | 'truncate_failed' | 'restore_failed' | 'cancelled';
  forkHistoryIndex?: number;
  runId?: string;
  filesRestored?: boolean;
  safetySnapshotSha?: string;
}

/** Result of an optional file restore after undo or branch redo. */
export interface SnapshotRestoreOutcome {
  restored: boolean;
  cancelled?: boolean;
  skipped?: boolean;
  safetySnapshotSha?: string;
  error?: string;
}

const MSG_STREAMING = 'Finish or stop the current reply first';
const MSG_ORCHESTRATE = 'Undo isn’t available in Orchestrate mode yet';
const MSG_BOARD = 'Undo isn’t available for board-linked chats yet';
const MSG_WORKTREE = 'Undo isn’t available for worktree-isolated chats yet';
const MSG_NO_TURN = 'Nothing to undo yet';
const MSG_NOT_FOUND = 'Chat not found';

/** Shared status-bar copy for composer + message ⋮ undo actions. */
export const UNDO_STATUS = {
  cancelled: 'Cancelled — chat and files unchanged',
  failed: 'Could not undo the last turn',
  successChat: 'Turn undone — restore the reply from the branch picker',
  successFiles:
    'Turn undone — files restored. Restore the reply from the branch picker',
  branchRestored: 'Reply restored',
  branchRestoredFiles: 'Reply restored — files restored',
  branchRestoredFilesSkipped: 'Reply restored — files left as they are',
  branchSwitched: 'Branch switched',
  branchSwitchedFiles: 'Branch switched — files restored',
  branchSwitchedFilesSkipped: 'Branch switched — files left as they are',
} as const;

const FILE_CONFIRM_CAP = 20;

/** Title / button labels for the file-restore confirm dialog. */
export function snapshotRestoreConfirmLabels(info: UndoConfirmInfo): {
  title: string;
  confirmLabel: string;
  cancelLabel: string;
  danger: boolean;
} {
  return {
    title: info.kind === 'undo' ? 'Restore files before this turn?' : 'Restore files after this turn?',
    confirmLabel: 'Restore files',
    cancelLabel: 'Keep files',
    danger: info.divergentHead,
  };
}

/** Resolve the chat for undo helpers (session lookup + active fallback). */
function resolveChat(chatOrId: Chat | string): Chat | undefined {
  if (typeof chatOrId !== 'string') return chatOrId;
  return (
    findChatById(chatOrId) ??
    (getActiveChat().id === chatOrId ? getActiveChat() : undefined)
  );
}

/** True when the fork user row still has a non-user reply materialized after it. */
function hasMaterializedReplyAfterFork(chat: Chat, forkHistoryIndex: number): boolean {
  if (forkHistoryIndex < 0 || forkHistoryIndex >= chat.history.length) return false;
  if (chat.history[forkHistoryIndex]?.role !== 'user') return false;
  return chat.history.slice(forkHistoryIndex + 1).some((m) => m.role !== 'user');
}

// ── Eligibility ──────────────────────────────────────────────────────────────

export function resolveUndoTarget(
  chat: Chat,
): { runId: string; forkHistoryIndex: number } | undefined {
  const runs = chat.runs ?? [];
  if (runs.length === 0) return undefined;

  let bestFork = -1;
  for (const run of runs) {
    if (
      run.status !== 'completed' &&
      run.status !== 'stopped' &&
      run.status !== 'superseded'
    ) {
      continue;
    }
    const fork = run.forkHistoryIndex;
    if (!hasMaterializedReplyAfterFork(chat, fork)) continue;
    if (fork > bestFork) bestFork = fork;
  }
  if (bestFork < 0) return undefined;

  const active = getActiveRun(chat, bestFork);
  if (
    active &&
    (active.status === 'completed' ||
      active.status === 'stopped' ||
      active.status === 'superseded') &&
    hasMaterializedReplyAfterFork(chat, bestFork)
  ) {
    return { runId: active.runId, forkHistoryIndex: bestFork };
  }

  const atFork = listRunsAtFork(chat, bestFork);
  const pick =
    atFork.find(
      (r) =>
        (r.status === 'completed' || r.status === 'stopped') &&
        hasMaterializedReplyAfterFork(chat, bestFork),
    ) ??
    atFork.find(
      (r) => isBranchActivatable(chat, r) && hasMaterializedReplyAfterFork(chat, bestFork),
    );
  if (!pick) return undefined;
  return { runId: pick.runId, forkHistoryIndex: bestFork };
}

/** Block reason messages for tooltips / status. */
export function undoBlockMessage(reason: UndoBlockReason): string {
  switch (reason) {
    case 'streaming':
      return MSG_STREAMING;
    case 'canonical_history':
      return CANONICAL_HISTORY_HINT;
    case 'orchestrate':
      return MSG_ORCHESTRATE;
    case 'board':
      return MSG_BOARD;
    case 'worktree':
      return MSG_WORKTREE;
    case 'no_turn':
      return MSG_NO_TURN;
    case 'not_found':
      return MSG_NOT_FOUND;
    default:
      return MSG_NO_TURN;
  }
}

export function getUndoEligibility(chat: Chat): UndoEligibility {
  if (!supportsLocalHistoryMutation(chat)) return { ok: false, reason: 'canonical_history', message: CANONICAL_HISTORY_HINT };
  if (streamingChatIds.has(chat.id)) {
    return { ok: false, reason: 'streaming', message: MSG_STREAMING };
  }

  if (normalizeModeId(chat.modeId) === 'orchestrate') {
    return { ok: false, reason: 'orchestrate', message: MSG_ORCHESTRATE };
  }

  if (chat.boardTaskId?.trim() || chat.boardGroupId?.trim()) {
    return { ok: false, reason: 'board', message: MSG_BOARD };
  }

  if (chat.worktreeRoot?.trim()) {
    return { ok: false, reason: 'worktree', message: MSG_WORKTREE };
  }

  const target = resolveUndoTarget(chat);
  if (!target) {
    return { ok: false, reason: 'no_turn', message: MSG_NO_TURN };
  }

  return { ok: true, target };
}

export function canUndoTurn(chat: Chat): boolean {
  return getUndoEligibility(chat).ok;
}

/** Build a confirm dialog body listing changed paths (capped). */
export function formatSnapshotRestoreConfirm(info: UndoConfirmInfo): string {
  const lines: string[] = [];
  if (info.kind === 'undo') {
    lines.push('This rewinds the working tree to how it looked before the agent turn.');
  } else {
    lines.push('This restores the working tree to how it looked after the agent turn.');
  }
  if (info.divergentHead) {
    lines.push(
      '',
      'HEAD has moved since this turn (a real commit landed). Restoring rewrites files and the index, but does not move the branch tip.',
    );
  }
  if (info.files.length > 0) {
    lines.push('', 'Paths that will change:');
    for (const file of info.files.slice(0, FILE_CONFIRM_CAP)) {
      lines.push(`  ${file}`);
    }
    if (info.files.length > FILE_CONFIRM_CAP) {
      lines.push(`  …and ${info.files.length - FILE_CONFIRM_CAP} more`);
    }
  } else {
    lines.push('', 'No path differences detected (the index may still be rewritten).');
  }
  lines.push('', 'Staged changes will be replaced.');
  return lines.join('\n');
}

async function defaultConfirm(info: UndoConfirmInfo): Promise<boolean> {
  const labels = snapshotRestoreConfirmLabels(info);
  const message = formatSnapshotRestoreConfirm(info);

  try {
    const { appConfirm } = await import('../ui/app-dialog');
    return await appConfirm(message, labels);
  } catch {}

  const isElectron = globalThis.minnow?.app?.isElectron === true;
  if (!isElectron && typeof globalThis.confirm === 'function') {
    return globalThis.confirm(`${labels.title}\n\n${message}`);
  }

  return !info.divergentHead && info.files.length === 0;
}

/** Merge injectable git deps with production defaults. */
function resolveUndoGit(partial?: Partial<UndoGitDeps>): UndoGitDeps {
  return {
    snapshotDiff: partial?.snapshotDiff ?? defaultUndoGit.snapshotDiff,
    snapshotRestore: partial?.snapshotRestore ?? defaultUndoGit.snapshotRestore,
    log: partial?.log ?? defaultUndoGit.log,
  };
}

// ── Restore ──────────────────────────────────────────────────────────────────

export async function confirmAndRestoreTurnSnapshot(
  run: TurnRunRecord,
  which: 'pre' | 'post',
  options?: Pick<UndoTurnOptions, 'confirm' | 'git'>,
): Promise<SnapshotRestoreOutcome> {
  const targetSha =
    which === 'pre' ? run.preTurnSnapshotSha?.trim() : run.postTurnSnapshotSha?.trim();
  const cwd = run.snapshotCwd?.trim();
  if (!targetSha || !cwd) {
    return { restored: false, skipped: true };
  }

  const kind: 'undo' | 'redo' = which === 'pre' ? 'undo' : 'redo';
  const git = resolveUndoGit(options?.git);

  const diff = await git.snapshotDiff({ cwd, fromSha: targetSha });
  const files =
    diff.ok && Array.isArray(diff.files)
      ? diff.files.map((f) => f.path).filter(Boolean)
      : [];

  let divergentHead = false;
  if (run.headShaAtTurn?.trim()) {
    const tip = await git.log({ cwd, count: 1 });
    const currentHead = tip.ok ? tip.commits?.[0]?.hash : undefined;
    if (currentHead && currentHead !== run.headShaAtTurn.trim()) {
      divergentHead = true;
    }
  }

  const needsConfirm = divergentHead || files.length > 0;
  if (needsConfirm) {
    const confirmFn = options?.confirm ?? defaultConfirm;
    const allowed = await confirmFn({ files, divergentHead, kind });
    if (!allowed) {
      return { restored: false, cancelled: true };
    }
  }

  const restored = await git.snapshotRestore({ cwd, sha: targetSha });
  if (!restored.ok) {
    return {
      restored: false,
      error: restored.error || 'restore_failed',
      safetySnapshotSha: restored.safetySha,
    };
  }

  return {
    restored: true,
    safetySnapshotSha: restored.safetySha,
  };
}

export async function undoLastAgentTurn(
  chatId: string,
  options?: UndoTurnOptions,
): Promise<UndoTurnResult> {
  const chat = resolveChat(chatId);
  if (!chat) {
    return { ok: false, error: 'not_found' };
  }

  const eligibility = getUndoEligibility(chat);
  if (!eligibility.ok || !eligibility.target) {
    return { ok: false, error: eligibility.reason ?? 'no_turn' };
  }

  const { runId, forkHistoryIndex } = eligibility.target;
  const run: TurnRunRecord | undefined = (chat.runs ?? []).find((r) => r.runId === runId);
  const wantFiles = options?.restoreFiles !== false;
  const git = resolveUndoGit(options?.git);

  let pendingFileRestore = false;
  if (wantFiles && run?.preTurnSnapshotSha?.trim() && run.snapshotCwd?.trim()) {
    const targetSha = run.preTurnSnapshotSha.trim();
    const cwd = run.snapshotCwd.trim();
    const diff = await git.snapshotDiff({ cwd, fromSha: targetSha });
    const files =
      diff.ok && Array.isArray(diff.files)
        ? diff.files.map((f) => f.path).filter(Boolean)
        : [];

    let divergentHead = false;
    if (run.headShaAtTurn?.trim()) {
      const tip = await git.log({ cwd, count: 1 });
      const currentHead = tip.ok ? tip.commits?.[0]?.hash : undefined;
      if (currentHead && currentHead !== run.headShaAtTurn.trim()) {
        divergentHead = true;
      }
    }

    const needsConfirm = divergentHead || files.length > 0;
    if (needsConfirm) {
      const confirmFn = options?.confirm ?? defaultConfirm;
      const allowed = await confirmFn({ files, divergentHead, kind: 'undo' });
      if (!allowed) {
        return { ok: false, error: 'cancelled' };
      }
    }
    pendingFileRestore = true;
  }

  // The chat can acquire canonical ownership while a confirmation dialog is open.
  if (!supportsLocalHistoryMutation(chat)) return { ok: false, error: 'canonical_history' };
  persistActiveBranchSuffix(chat, forkHistoryIndex);

  if (run && (!run.outputMessages || run.outputMessages.length === 0)) {
    const suffix = chat.history.slice(forkHistoryIndex + 1);
    if (suffix.length > 0) {
      run.outputMessages = suffix.map((m) => ({ ...m }));
    }
  }

  const truncated = truncateChatHistory(chatId, forkHistoryIndex, 'inclusive');
  if (!truncated.ok) {
    return {
      ok: false,
      error: truncated.error === 'streaming' ? 'streaming' : 'truncate_failed',
    };
  }

  clearActiveBranch(chat, forkHistoryIndex);
  touchChat(chat);
  scheduleSaveSessions();

  let filesRestored = false;
  let safetySnapshotSha: string | undefined;

  if (pendingFileRestore && run) {
    const restored = await git.snapshotRestore({
      cwd: run.snapshotCwd!.trim(),
      sha: run.preTurnSnapshotSha!.trim(),
    });
    if (restored.ok) {
      filesRestored = true;
      safetySnapshotSha = restored.safetySha;
    }
  }

  return {
    ok: true,
    runId,
    forkHistoryIndex,
    filesRestored,
    ...(safetySnapshotSha ? { safetySnapshotSha } : {}),
  };
}

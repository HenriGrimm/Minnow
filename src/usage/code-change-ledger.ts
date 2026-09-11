/**
 * Per-chat and per-workspace cumulative line add/delete from agent mutations.
 */

import { normalizeWorkspacePath } from '../lib/normalize-workspace-path';
import type {
  Chat,
  ChatCodeChangeTotals,
  CodeChangeDiffLine,
  CodeChangeStats,
  SessionState,
  ToolResultMessage,
  TurnRunRecord,
} from '../types';

/** Per-file rollup for the code-change strip panel. */
export interface FileChangeSummary {
  path: string;
  additions: number;
  deletions: number;
  diffChunks: Array<{ lines: CodeChangeDiffLine[]; truncated: boolean }>;
}

export const EMPTY_CODE_CHANGE_TOTALS: ChatCodeChangeTotals = {
  additions: 0,
  deletions: 0,
};

/** Ensure chat has a totals object after session load. */
export function ensureCodeChangeTotals(chat: Chat): ChatCodeChangeTotals {
  if (!chat.codeChangeTotals || typeof chat.codeChangeTotals !== 'object') {
    chat.codeChangeTotals = { ...EMPTY_CODE_CHANGE_TOTALS };
  }
  const totals = chat.codeChangeTotals;
  if (!Number.isFinite(totals.additions)) totals.additions = 0;
  if (!Number.isFinite(totals.deletions)) totals.deletions = 0;
  return totals;
}

/** Reset totals when chat history is cleared. */
export function resetCodeChangeTotals(chat: Chat): void {
  chat.codeChangeTotals = { ...EMPTY_CODE_CHANGE_TOTALS };
  chat.codeChangeBackfillAt = undefined;
}

/**
 * Roll one tool's line stats into the chat total.
 * Skips when both counts are zero.
 */
export function recordCodeChange(chat: Chat, stats: CodeChangeStats): void {
  if (stats.additions === 0 && stats.deletions === 0) return;
  const totals = ensureCodeChangeTotals(chat);
  totals.additions += stats.additions;
  totals.deletions += stats.deletions;
  chat.codeChangeBackfillAt = Date.now();
}

/** Add stats into workspace rollup map on session state. */
export function recordWorkspaceCodeChange(
  state: SessionState,
  workspacePath: string | undefined,
  stats: CodeChangeStats,
): void {
  if (stats.additions === 0 && stats.deletions === 0) return;
  const key = normalizeWorkspacePath(workspacePath ?? '');
  if (!state.codeChangeTotalsByWorkspace) {
    state.codeChangeTotalsByWorkspace = {};
  }
  const bucket = state.codeChangeTotalsByWorkspace[key] ?? {
    ...EMPTY_CODE_CHANGE_TOTALS,
  };
  bucket.additions += stats.additions;
  bucket.deletions += stats.deletions;
  state.codeChangeTotalsByWorkspace[key] = bucket;
}

/** Sum chat totals for one workspace (used after backfill). */
export function sumChatCodeChangeTotalsForWorkspace(
  state: SessionState,
  workspacePath: string,
): ChatCodeChangeTotals {
  const key = normalizeWorkspacePath(workspacePath);
  let additions = 0;
  let deletions = 0;
  for (const chat of state.chats) {
    if (normalizeWorkspacePath(chat.workspacePath) !== key) continue;
    const t = chat.codeChangeTotals;
    if (!t) continue;
    additions += t.additions;
    deletions += t.deletions;
  }
  return { additions, deletions };
}

/** Rebuild workspace rollup from all chats bound to the workspace. */
export function recomputeWorkspaceCodeChangeTotals(
  state: SessionState,
  workspacePath: string | undefined,
): void {
  const key = normalizeWorkspacePath(workspacePath ?? '');
  if (!state.codeChangeTotalsByWorkspace) {
    state.codeChangeTotalsByWorkspace = {};
  }
  state.codeChangeTotalsByWorkspace[key] = sumChatCodeChangeTotalsForWorkspace(
    state,
    key,
  );
}

/** Workspace rollup for the active workspace path string. */
export function getWorkspaceCodeChangeTotals(
  state: SessionState | null,
  workspacePath: string,
): ChatCodeChangeTotals {
  if (!state?.codeChangeTotalsByWorkspace) return { ...EMPTY_CODE_CHANGE_TOTALS };
  const key = normalizeWorkspacePath(workspacePath);
  const row = state.codeChangeTotalsByWorkspace[key];
  if (!row) return { ...EMPTY_CODE_CHANGE_TOTALS };
  return {
    additions: Number.isFinite(row.additions) ? row.additions : 0,
    deletions: Number.isFinite(row.deletions) ? row.deletions : 0,
  };
}

/** Plain-text +/− for the composer strip (no HTML). */
export function formatCodeChangeTotalsText(totals: ChatCodeChangeTotals): string {
  return `+${totals.additions} −${totals.deletions}`;
}

/** True when the strip should be visible. */
export function hasCodeChangeTotals(totals: ChatCodeChangeTotals | undefined): boolean {
  if (!totals) return false;
  return totals.additions > 0 || totals.deletions > 0;
}

/** Resolve file paths from a single codeChange payload. */
function pathsFromCodeChange(stats: CodeChangeStats): string[] {
  if (stats.path) return [stats.path];
  if (stats.paths?.length) return stats.paths;
  return [];
}

/** True when a persisted tool row recorded line or path mutations. */
function toolMessageHasCodeChange(msg: ToolResultMessage): boolean {
  const codeChange = msg.codeChange;
  if (!codeChange) return false;
  return (
    codeChange.additions > 0 ||
    codeChange.deletions > 0 ||
    pathsFromCodeChange(codeChange).length > 0
  );
}

/**
 * Listing-safe: omitted/`true` means the transcript is in memory.
 * `false` is a summary placeholder — do not read `chat.history` (MIN-734).
 */
function isChatHistoryReady(chat: Chat): boolean {
  return chat.historyLoaded !== false;
}

/**
 * Whether an agent turn produced file mutations (tool codeChange rows in its output span).
 * Used to show strip Undo only when rewinding would touch the working tree.
 */
export function runHadCodeChanges(chat: Chat, run: TurnRunRecord): boolean {
  if (!isChatHistoryReady(chat)) return false;

  const start = run.outputHistoryStart;
  const end = run.outputHistoryEnd;
  if (start != null && end != null && end >= start) {
    for (let i = start; i <= end; i++) {
      const msg = chat.history[i];
      if (msg?.role === 'tool' && toolMessageHasCodeChange(msg as ToolResultMessage)) {
        return true;
      }
    }
    return false;
  }

  const fork = run.forkHistoryIndex;
  for (let i = fork + 1; i < chat.history.length; i++) {
    const msg = chat.history[i];
    if (msg.role === 'user') break;
    if (msg.role === 'tool' && toolMessageHasCodeChange(msg as ToolResultMessage)) {
      return true;
    }
  }
  return false;
}

/**
 * Aggregate per-file line stats and diff chunks from tool history.
 * Sorted by total changes descending (most-changed first).
 */
export function getPerFileChangeSummary(chat: Chat, start = 0, end?: number): FileChangeSummary[] {
  if (!isChatHistoryReady(chat)) return [];

  const byPath = new Map<string, FileChangeSummary>();

  for (let i = start; i <= (end ?? chat.history.length - 1); i++) {
    const msg = chat.history[i];
    if (!msg) continue;
    if (msg.role !== 'tool') continue;
    const toolMsg = msg as ToolResultMessage;
    const codeChange = toolMsg.codeChange;
    if (!codeChange) continue;

    const paths = pathsFromCodeChange(codeChange);
    if (paths.length === 0) continue;

    for (const path of paths) {
      let row = byPath.get(path);
      if (!row) {
        row = { path, additions: 0, deletions: 0, diffChunks: [] };
        byPath.set(path, row);
      }
      row.additions += codeChange.additions;
      row.deletions += codeChange.deletions;
      if (codeChange.diffLines?.length) {
        row.diffChunks.push({
          lines: codeChange.diffLines,
          truncated: Boolean(codeChange.diffTruncated),
        });
      }
    }
  }

  return [...byPath.values()].sort((a, b) => {
    const totalA = a.additions + a.deletions;
    const totalB = b.additions + b.deletions;
    if (totalB !== totalA) return totalB - totalA;
    return a.path.localeCompare(b.path);
  });
}

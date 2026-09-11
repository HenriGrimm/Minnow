import type { Chat, ChatCodeChangeTotals } from '../types';
import {
  formatCodeChangeTotalsText,
  getPerFileChangeSummary,
  hasCodeChangeTotals,
} from '../usage/code-change-ledger';

/** Append green + / red − spans (shared by composer strip and sidebar stats). */
export function appendCodeChangeTotalsSpans(
  parent: Node,
  totals: ChatCodeChangeTotals,
): void {
  const addSpan = document.createElement('span');
  addSpan.className = 'code-change-strip__add';
  addSpan.textContent = `+${totals.additions}`;
  const delSpan = document.createElement('span');
  delSpan.className = 'code-change-strip__del';
  delSpan.textContent = `−${totals.deletions}`;
  parent.appendChild(addSpan);
  parent.appendChild(document.createTextNode(' '));
  parent.appendChild(delSpan);
}

/** File count plus +/− totals (composer strip and chat sidebar). */
export function appendChatItemCodeChangeStats(
  parent: Node,
  chat: Chat,
  totals: ChatCodeChangeTotals,
): void {
  const fileCount = getPerFileChangeSummary(chat).length;
  if (fileCount > 0) {
    const filesSpan = document.createElement('span');
    filesSpan.className = 'code-change-strip__files';
    filesSpan.textContent = `${fileCount} file${fileCount === 1 ? '' : 's'}`;
    parent.appendChild(filesSpan);
    parent.appendChild(document.createTextNode(' · '));
  }
  appendCodeChangeTotalsSpans(parent, totals);
}

/** Screen-reader label for session row code-change stats. */
export function formatChatItemCodeChangeAria(chat: Chat): string {
  const totals = chat.codeChangeTotals;
  if (!hasCodeChangeTotals(totals) || !totals) return '';
  const fileCount = getPerFileChangeSummary(chat).length;
  const parts: string[] = [];
  if (fileCount > 0) {
    parts.push(`${fileCount} file${fileCount === 1 ? '' : 's'}`);
  }
  parts.push(formatCodeChangeTotalsText(totals));
  return parts.join(', ');
}

/** Legacy boot hook; turn-changes cards own the UI now. */
export function initCodeChangeStrip(): void {
  // No-op: the floating strip was removed in favor of chat-turn-changes.
}

/** Legacy no-op kept for callers that still invoke wrap visibility sync. */
export function syncCodeChangeStripWrapVisibility(): void {}

/** Refresh Commit / Create PR visibility on the primary turn-changes card. */
export function updateCodeChangeStrip(chat?: Chat | null): void {
  void import('./code-change-strip-actions').then((m) =>
    m.syncCodeChangeStripActionsVisibility(chat ?? null),
  );
  void import('./composer-undo').then((m) => m.syncComposerUndoFromActiveChat());
}

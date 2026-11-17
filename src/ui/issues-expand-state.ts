import type { ExpandedIssueDraft } from '../chat/issues/expand-issue';

interface ExpandRunState {
  issueId: string;
}

/** Fields an in-place expansion wrote, with the values it replaced. */
export interface IssueExpandUndo {
  before: Partial<ExpandedIssueDraft>;
  after: Partial<ExpandedIssueDraft>;
}

let activeRun: ExpandRunState | null = null;
const undoByIssue = new Map<string, IssueExpandUndo>();

/** True while a sparkles expansion is in flight for the issue (or any issue). */
export function isIssueDraftExpanding(issueId?: string): boolean {
  if (!activeRun) return false;
  return issueId ? activeRun.issueId === issueId : true;
}

export function getIssueExpandRunIssueId(): string | undefined {
  return activeRun?.issueId;
}

export function setIssueExpandRun(issueId: string | null): void {
  activeRun = issueId ? { issueId } : null;
}

export function getIssueExpandUndo(issueId: string): IssueExpandUndo | undefined {
  return undoByIssue.get(issueId);
}

export function setIssueExpandUndo(issueId: string, undo: IssueExpandUndo | null): void {
  if (undo) undoByIssue.set(issueId, undo);
  else undoByIssue.delete(issueId);
}

/** Test helper. */
export function resetIssueExpandStateForTests(): void {
  activeRun = null;
  undoByIssue.clear();
}

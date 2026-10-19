import { issueLaunchModel as readIssueModel, clearIssueLaunchModel as clearIssueModel, setIssueLaunchModel, launchModelLabel } from '../models/launch-selection';
import { readDefaultModelBinding } from '../models/selection';
import { decodeModelSelectKey } from '../lib/model-select-key';
/**
 * Issue launches use the inline worktree preference without another picker.
 */

import { findIssueById } from '../state/issues-store.ts';
import type { ChatRunTargetChoice } from '../state/chat-worktree.ts';
import { closeIssuesContextMenu } from './issues-context-menu.ts';
import { closeIssuesWorkflowMenu } from './issues-workflow-menu.ts';
import { closeRunTargetPicker } from './composer-run-target-menu.ts';

export function issueLaunchModel(issueId: string): string { return readIssueModel(issueKey(issueId)); }
export function clearIssueLaunchModel(issueId: string): void { clearIssueModel(issueKey(issueId)); }
export function issueLaunchModelLabel(issueId: string): string { return launchModelLabel(issueLaunchModel(issueId)); }
export function pickIssueLaunchModel(issueId: string, anchor: HTMLElement, onChanged: () => void): void {
  void import('./launch-model-picker').then(({ openLaunchModelPicker }) => openLaunchModelPicker(anchor, issueLaunchModel(issueId), (value) => { setIssueLaunchModel(issueKey(issueId), value); onChanged(); }));
}

const isolatedIssues = new Set<string>();

function issueKey(issueId: string): string {
  return `${findIssueById(issueId)?.workspacePath ?? ''}\0${issueId}`;
}

export function issueUsesWorktree(issueId: string): boolean {
  return isolatedIssues.has(issueKey(issueId));
}

export function toggleIssueWorktree(issueId: string): void {
  const key = issueKey(issueId);
  if (isolatedIssues.has(key)) isolatedIssues.delete(key);
  else isolatedIssues.add(key);
}

export interface PromptIssueChatRunTargetOptions {
  issueId: string;
  anchor?: HTMLElement | null;
  clientX?: number;
  clientY?: number;
  onPick: (choice: ChatRunTargetChoice) => void | Promise<void>;
}

/** Last row-menu pointer, used when the context menu has no button trigger. */
let lastMenuPoint: { x: number; y: number } | null = null;
let lastMenuAnchor: HTMLElement | null = null;

/** Remember where the issue row menu opened so the run-target panel can sit there. */
export function rememberIssueMenuAnchor(
  clientX: number,
  clientY: number,
  restoreFocus?: HTMLElement | null,
): void {
  lastMenuPoint = { x: clientX, y: clientY };
  lastMenuAnchor = restoreFocus ?? null;
}

/** Last remembered row-menu origin. */
export function lastIssueMenuOrigin(): {
  anchor: HTMLElement | null;
  clientX?: number;
  clientY?: number;
} {
  return {
    anchor: lastMenuAnchor,
    clientX: lastMenuPoint?.x,
    clientY: lastMenuPoint?.y,
  };
}

/**
 * Launch with the explicit preference. Setup errors must not fall back to Local.
 */
export function promptIssueChatRunTarget(options: PromptIssueChatRunTargetOptions): void {
  const issue = findIssueById(options.issueId);
  if (!issue) return;

  closeIssuesWorkflowMenu();
  closeIssuesContextMenu();
  closeRunTargetPicker();

  void options.onPick({ kind: issueUsesWorktree(issue.id) ? 'automatic' : 'local' });
}

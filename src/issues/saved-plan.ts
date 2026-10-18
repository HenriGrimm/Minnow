import type { IssueCard } from '../types';
import { readPlanType, type PlanType } from '../../server/orchestrator/core/plan-format.js';
import { readWorkspaceTextFile } from '../attachments/workspace-text-read';
import { findLastPlanSavePath } from '../chat/plans/plan-from-history';
import { ensureChatHistoryLoaded } from '../state/sessions';
import { linkedIssueChats } from './work-state';
import { inferIssuePlanPath } from './plan-attach';

export interface SavedIssuePlan { path: string; markdown: string; workspaceRoot: string; type: PlanType }

/** Resolve previews and approval actions against the same planning checkout. */
export async function readSavedIssuePlan(issue: IssueCard): Promise<SavedIssuePlan> {
  const chats = linkedIssueChats(issue);
  const chat = chats.find(c => c.id === issue.agent?.chatId) ?? [...chats].reverse().find(c => c.modeId === 'plan');
  if (chat) await ensureChatHistoryLoaded(chat.id);
  const path = inferIssuePlanPath(issue) || (chat && findLastPlanSavePath(chat.history));
  if (!path) throw new Error('No saved plan is linked yet. Open the planning conversation to locate the plan.');
  const workspaceRoot = chat?.worktreeRoot || issue.agent?.worktreePath || issue.workspacePath;
  const markdown = await readWorkspaceTextFile(path, workspaceRoot, Date.now());
  return { path, markdown, workspaceRoot, type: readPlanType(markdown) };
}

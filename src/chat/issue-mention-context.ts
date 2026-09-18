/**
 * Store-backed half of issue mentions: resolve typed ids against the loaded
 * issues store and attach their `<issue-ref>` blocks to an outgoing message.
 */

import { normalizeWorkspacePath } from '../lib/normalize-workspace-path.ts';
import { isIssuesStoreLoaded, listIssues } from '../state/issues-store.ts';
import { getWorkspacePath } from '../state/workspace.ts';
import type { IssueCard } from '../types';
import { appendIssueRefBlocks, findIssueIdTokens } from './issue-mentions.ts';

/**
 * Two workspaces can share a project key, so prefer the issue in the chat's
 * workspace and fall back to any workspace.
 */
function resolveIssueForMention(id: string, workspacePath: string): IssueCard | undefined {
  const wsKey = normalizeWorkspacePath(workspacePath);
  let fallback: IssueCard | undefined;
  for (const issue of listIssues()) {
    if (issue.id !== id) continue;
    if (normalizeWorkspacePath(issue.workspacePath) === wsKey) return issue;
    fallback ??= issue;
  }
  return fallback;
}

/** `content` plus an `<issue-ref>` block for each known issue id typed in `userText`. */
export function attachMentionedIssues(
  content: string,
  userText: string,
  workspacePath: string = getWorkspacePath(),
): string {
  if (!isIssuesStoreLoaded() || findIssueIdTokens(userText).length === 0) return content;
  return appendIssueRefBlocks(content, userText, (id) =>
    resolveIssueForMention(id, workspacePath),
  );
}

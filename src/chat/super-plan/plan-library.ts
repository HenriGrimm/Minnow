import { normalizeWorkspacePath } from '../../lib/normalize-workspace-path';
import { getWorkspacePath } from '../../state/workspace';
import type { Chat } from '../../types';

/** True when the chat row belongs to the given workspace folder. */
export function isChatInWorkspace(chat: Chat, workspacePath: string): boolean {
  const key = normalizeWorkspacePath(workspacePath);
  if (!key) return false;
  return normalizeWorkspacePath(chat.workspacePath ?? '') === key;
}

/** True when the chat belongs to the workspace folder Minnow has open right now. */
export function isChatInCurrentWorkspace(chat: Chat): boolean {
  return isChatInWorkspace(chat, getWorkspacePath());
}

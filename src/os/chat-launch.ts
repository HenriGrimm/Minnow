/**
 * Code app launch helper — switch workspace chat from OS deep-links.
 */

import { isMinnowSandboxWorkspacePath } from '../lib/workspace-sandbox';
import { sessionState } from '../state/sessions';
import { isCurrentWindowWorkspace } from '../state/workspace';
import { launchApp } from './router';

async function verifyLinkedChat(chatId: string): Promise<boolean> {
  const { isServerStorageMode } = await import('../config/storage-mode');
  if (!isServerStorageMode()) return true;
  const capability = await import('../config/agent-conversations-enabled');
  await capability.loadAgentConversationsCapability();
  if (capability.getConversationStorageCapabilitySync() === 'json') return true;
  try {
    const response = await fetch(`/api/chats/${encodeURIComponent(chatId)}?view=navigation`, { cache: 'no-store', signal: AbortSignal.timeout(5000) });
    if (response.ok) return true;
    const { showToast } = await import('../ui/toast');
    showToast(response.status === 404 ? 'This conversation is unavailable. It may have been deleted.' : 'This conversation is unavailable in the current workspace.', 'error');
  } catch {
    const { showToast } = await import('../ui/toast');
    showToast('Could not load this conversation. Reconnect and open its link again.', 'error');
  }
  return false;
}

/** A stale/deleted link never chooses an unrelated chat or constructs history. */
async function findLinkedChat(chatId: string): Promise<boolean> {
  const { ensureSessionsReady, refreshSessionsFromServer } = await import('../state/sessions');
  await ensureSessionsReady();
  try { if (!sessionState?.chats.some(chat => chat.id === chatId)) await refreshSessionsFromServer(); }
  catch {
    const { showToast } = await import('../ui/toast');
    showToast('Could not load this conversation. Reconnect and open its link again.', 'error');
    return false;
  }
  if (sessionState?.chats.some(chat => chat.id === chatId)) return true;
  const { showToast } = await import('../ui/toast');
  showToast('This conversation is unavailable. It may have been deleted or belong to another workspace.', 'error');
  return false;
}

/** True when the chat belongs to a user project folder (not a Minnow sandbox). */
function isProjectWorkspacePath(path: string): boolean {
  const trimmed = path.trim();
  if (!trimmed) return false;
  return !isMinnowSandboxWorkspacePath(trimmed);
}

/** Switch the Code workspace when a deep-linked chat lives in another project folder. */
async function ensureWorkspaceForCodeChat(chatId: string): Promise<boolean> {
  if (!await findLinkedChat(chatId)) return false;
  const chat = sessionState?.chats.find((row) => row.id === chatId);
  const chatWorkspace = chat?.workspacePath?.trim();
  if (!chat || !chatWorkspace || !isProjectWorkspacePath(chatWorkspace)) {
    return true;
  }

  const { routeCodeWindowCommand } = await import('./code-window-command');
  try {
    if (await routeCodeWindowCommand({ kind: 'chat', workspacePath: chatWorkspace, chatId })) return false;
  } catch (error) {
    const { showToast } = await import('../ui/toast');
    showToast(error instanceof Error ? error.message : 'Could not open this conversation.', 'error');
    return false;
  }

  if (isCurrentWindowWorkspace(chatWorkspace)) {
    return verifyLinkedChat(chatId);
  }

  const { executeWorkspaceSwitch } = await import('../ui/workspace-switch-guard');
  const info = await executeWorkspaceSwitch(chatWorkspace);
  return info !== null && await verifyLinkedChat(chatId);
}

/** Foreground Code and activate the given chat session. */
export async function launchCodeWithChat(chatId: string): Promise<void> {
  const trimmed = chatId.trim();
  if (!trimmed) {
    launchApp('code');
    return;
  }

  const allowed = await ensureWorkspaceForCodeChat(trimmed);
  if (!allowed) return;

  launchApp('code', { chatId: trimmed, codeSection: 'chat' });
  await switchToCodeChat(trimmed);
}

/** Foreground Code chat and activate the given assistant thread (legacy desktop/chat deep-links). */
export async function launchChatWithThread(chatId: string): Promise<void> {
  const trimmed = chatId.trim();
  if (!trimmed) {
    launchApp('code', { codeSection: 'chat' });
    return;
  }

  await launchCodeWithChat(trimmed);
}

/** Switch sidebar to a chat after Code app is foreground (app-host / deep-link). */
export async function switchToCodeChat(chatId: string): Promise<void> {
  const trimmed = chatId.trim();
  if (!trimmed) return;
  if (!await ensureWorkspaceForCodeChat(trimmed)) return;

  const { switchChat } = await import('../ui/sidebar');
  const trySwitch = async (attempt = 0): Promise<void> => {
    const chatList = document.getElementById('chatList');
    if (chatList || attempt >= 20) {
      await switchChat(trimmed);
      return;
    }
    await new Promise<void>(resolve => window.setTimeout(resolve, 50));
    await trySwitch(attempt + 1);
  };
  await trySwitch();
}

/** Tray / native entry: foreground Code chat (sessions already restore the last thread). */
export async function launchCodeChat(): Promise<void> {
  launchApp('code', { codeSection: 'chat' });
  const { ensureSessionsReady } = await import('../state/sessions');
  await ensureSessionsReady();
}

/** Activate an assistant thread after Code chat is active (notification deep-link). */
export async function switchToDesktopChatThread(chatId: string): Promise<void> {
  await switchToCodeChat(chatId);
}

/** @deprecated Legacy Chat app thread switch — routes to Code chat. */
export async function switchToChatAppThread(chatId: string): Promise<void> {
  await switchToDesktopChatThread(chatId);
}

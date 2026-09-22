/**
 * Apply concierge / router launch options when foregrounding the Code app.
 */

import { DEFAULT_MODE_ID, normalizeModeId } from '../chat/modes/types';
import { sendMessageWithTools } from '../chat/messaging';
import { normalizeWorkspacePath } from '../lib/normalize-workspace-path';
import { applyChatRunTargetChoice, parseChatRunTargetChoice } from '../state/chat-worktree';
import { findChatById, scheduleSaveSessions, touchChat } from '../state/sessions';
import { getWorkspacePath, isCurrentWindowWorkspace } from '../state/workspace';
import { clearForegroundSeed } from './instances';
import type { LaunchOptions } from './types';
import { executeWorkspaceSwitch } from '../ui/workspace-switch-guard';
import { createChatWithMode } from '../ui/sidebar';
import { syncComposerFromStreamingState } from '../ui/composer-send';

/** Repoint file tree / git panel to the Code project workspace. */
async function syncCodeFileTreeChrome(): Promise<void> {
  const { clearPanelCwdUserOverride, syncPanelFromActiveChat } = await import('../ui/git-panel');
  clearPanelCwdUserOverride();
  syncPanelFromActiveChat({ forceFileTree: true });
}

/** Re-render the Code transcript and sync chrome for the active workspace chat. */
async function refreshCodeChatSurface(): Promise<void> {
  const { ensureSessionsReady, ensureChatHistoryLoaded, getActiveChat } = await import(
    '../state/sessions'
  );
  await ensureSessionsReady();
  const chat = getActiveChat();
  await ensureChatHistoryLoaded(chat.id);
  const { renderChatFromHistory, renderStatsForChat } = await import('../ui/messages');
  const { renderSidebar } = await import('../ui/sidebar');
  const { syncModeSelectorFromActiveChat } = await import('../ui/mode-selector');
  const { syncComposerReasoningEffortFromActiveChat } = await import('../ui/composer-reasoning-effort');
  const { syncViewModeToggleFromActiveChat } = await import('../ui/view-mode-toggle');
  const { refreshChatJumpChipVisibility } = await import('../ui/chat-scroll');

  renderChatFromHistory(chat);
  renderStatsForChat(chat);
  syncModeSelectorFromActiveChat();
  syncComposerReasoningEffortFromActiveChat();
  syncViewModeToggleFromActiveChat();
  syncComposerFromStreamingState();
  renderSidebar();
  refreshChatJumpChipVisibility();
  await syncCodeFileTreeChrome();
  const { refreshContextUsageRing } = await import('../ui/context-usage-ring');
  refreshContextUsageRing();
  void import('../tools/stream-chat-dom').then((m) => m.remountStreamDomForChat(chat.id));
}

/**
 * Foreground Code with the project workspace chat — not the desktop assistant thread.
 * Desktop chat renders into `#desktopChatCol`; this restores `#chatArea` on Code open.
 */
export async function restoreCodeSessionOnForeground(): Promise<void> {
  const { getChatsWorkspacePath, isChatsWorkspacePath } = await import('../lib/chats-workspace');
  const {
    ensureSessionsReady,
    getActiveChat,
    resolveActiveChatIdForWorkspace,
    sessionState,
  } = await import('../state/sessions');

  await ensureSessionsReady();
  if (!sessionState) return;

  await getChatsWorkspacePath();

  const workspacePath = getWorkspacePath();
  const active = getActiveChat();
  const activeIsAssistant = isChatsWorkspacePath(active.workspacePath ?? '');
  const workspaceKey = normalizeWorkspacePath(workspacePath);
  const activeInCurrentWorkspace =
    !activeIsAssistant &&
    normalizeWorkspacePath(active.workspacePath ?? '') === workspaceKey;

  if (activeInCurrentWorkspace) {
    await refreshCodeChatSurface();
    return;
  }

  const targetId = resolveActiveChatIdForWorkspace(
    workspacePath,
    sessionState,
    active.modelId ?? '',
  );

  const { switchChat } = await import('../ui/sidebar');

  if (targetId !== sessionState.activeId) {
    await switchChat(targetId);
    await syncCodeFileTreeChrome();
    return;
  }

  if (activeIsAssistant) {
    await switchChat(targetId);
    await syncCodeFileTreeChrome();
    return;
  }

  await refreshCodeChatSurface();
}

/**
 * Switch workspace, create a mode-scoped chat, and auto-send the seed message.
 * Returns the created chat id when a seeded send was attempted.
 */
export async function applyCodeLaunchOptions(
  options: LaunchOptions,
  onChatCreated?: (chatId: string) => void,
): Promise<{ chatId?: string; error?: string }> {
  const seed = options.seed?.trim();
  const shouldSend = options.autoRun === true && Boolean(seed);

  if (!shouldSend && !options.modeId && !options.workspacePath?.trim() && !seed) return {};

  const welcome = await import('../ui/welcome-page');
  if (welcome.isWelcomePageOpen()) {
    welcome.closeWelcome({ skipHash: true });
  }

  const targetPath = options.workspacePath?.trim();
  // Issue cards store a normalized path; the live window path is OS-native.
  // A raw !== here retargeted (destroyed + recreated) the current window.
  if (targetPath && !isCurrentWindowWorkspace(targetPath)) {
    try {
      await executeWorkspaceSwitch(targetPath);
    } catch {}
  }

  if (!shouldSend) {
    if (seed) {
      const input = document.getElementById('msgInput') as HTMLTextAreaElement | null;
      if (input && !input.value.trim()) {
        input.value = seed;
        input.dispatchEvent(new window.Event('input', { bubbles: true }));
        syncComposerFromStreamingState();
      }
    }
    return {};
  }

  const modeId = normalizeModeId(options.modeId ?? DEFAULT_MODE_ID);
  const created = createChatWithMode({ modeId });
  if (!created.ok || !seed) return {};
  if (created.chatId) onChatCreated?.(created.chatId);

  // Paint the seed before run-target/worktree setup. A managed worktree can take
  // seconds to create; leaving the newly-created transcript and composer empty
  // during that await made the launch look stalled or as though the prompt was lost.
  const input = document.getElementById('msgInput') as HTMLTextAreaElement | null;
  if (input) {
    input.value = seed;
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    syncComposerFromStreamingState();
  }

  const runTarget = parseChatRunTargetChoice(options.runTarget);
  if (runTarget && created.chatId) {
    const chat = findChatById(created.chatId);
    if (chat) {
      const applied = await applyChatRunTargetChoice(chat, runTarget);
      if (!applied.ok) {
        return { chatId: created.chatId, error: applied.error ?? 'Could not set run target' };
      }
      touchChat(chat);
      scheduleSaveSessions();
      try {
        const { syncComposerRunTargetFromActiveChat } = await import('../ui/composer-run-target');
        syncComposerRunTargetFromActiveChat();
        await syncCodeFileTreeChrome();
      } catch {
      }
    }
  }

  const { addCodeReferenceToComposer } = await import('../attachments/code-ref');
  for (const ref of options.codeRefs ?? []) {
    const path = ref.path?.trim().replace(/\\/g, '/');
    if (!path) continue;
    const startLine = Math.max(1, ref.startLine ?? 1);
    const endLine = Math.max(startLine, ref.endLine ?? startLine);
    const text = ref.text?.trim() || `(code reference: ${path})`;
    addCodeReferenceToComposer({
      workspacePath: path,
      startLine,
      endLine,
      text,
    });
  }

  if (!input) return { chatId: created.chatId };

  try {
    await sendMessageWithTools({ issue: options.issue });
    clearForegroundSeed();
  } catch {} finally {
    syncComposerFromStreamingState();
  }

  return { chatId: created.chatId };
}

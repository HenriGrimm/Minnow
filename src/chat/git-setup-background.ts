import { applyDefaultModelToChat } from '../models/selection';
/**
 * Background /git-setup from the no-repo empty state (SCC, git panel, overview).
 *
 * The click must not steal `sessionState.activeId` (MIN-637). One chat per
 * workspace, found again through `backgroundKey`.
 */

import { reportBackgroundError } from '../boot/report-background-error.ts';
import { decodeModelSelectKey } from '../lib/model-select-key.ts';
import { normalizeWorkspacePath } from '../lib/normalize-workspace-path.ts';
import { ensureBackgroundChat, findBackgroundChat } from '../state/background-chat.ts';
import { touchChat } from '../state/sessions.ts';
import { getWorkspacePath } from '../state/workspace.ts';
import type { Chat } from '../types.ts';
import { isChatTurnSetupPending } from './chat-turn-guard.ts';
import { isChatStreaming } from './streaming-state.ts';

/** Same prompt the old composer-prefill used so skill behavior is unchanged. */
export const GIT_SETUP_USER_TEXT =
  '/git-setup Initialize git in this workspace (init, .gitignore, initial commit).';

/** Keys whose send was kicked off but has not settled yet. */
const launchingKeys = new Set<string>();

export type StartGitSetupBackgroundChatResult =
  | { ok: true; chatId: string; alreadyRunning?: boolean }
  | { ok: false; error: string; chatId?: string };

/** Stable background identity: one git-setup chat per workspace root. */
export function gitSetupBackgroundKey(workspacePath: string): string {
  return `git-setup:${normalizeWorkspacePath(workspacePath)}`;
}

function resolveWorkspacePath(workspacePath?: string): string {
  return workspacePath?.trim() || getWorkspacePath().trim();
}

/** Bind the picker model if this chat was created before a model was selected. */
function applyDefaultModelIfMissing(chat: Chat): void {
  if (chat.modelId?.trim()) return;
  applyDefaultModelToChat(chat);
  touchChat(chat);
}

/** True while this workspace's setup chat is launching or streaming. */
export function isGitSetupBackgroundBusy(workspacePath?: string): boolean {
  const ws = resolveWorkspacePath(workspacePath);
  if (!ws) return false;
  const key = gitSetupBackgroundKey(ws);
  if (launchingKeys.has(key)) return true;
  const chat = findBackgroundChat(key);
  if (!chat) return false;
  return isChatStreaming(chat.id) || isChatTurnSetupPending(chat.id);
}

/** Test helper — drop in-flight launch markers between cases. */
export function resetGitSetupBackgroundLaunchingForTests(): void {
  launchingKeys.clear();
}

/** Refresh git UIs after init so the no-repo overlay does not wait on the poll. */
async function refreshGitSurfacesAfterSetup(): Promise<void> {
  try {
    const [{ invalidateComposerUndoGitCache }, { refreshSourceControlCenter }, gitPanel] =
      await Promise.all([
        import('../ui/composer-undo.ts'),
        import('../ui/source-control-center.ts'),
        import('../ui/git-panel.ts'),
      ]);
    invalidateComposerUndoGitCache();
    refreshSourceControlCenter();
    await gitPanel.refreshGitPanel();
  } catch (err) {
    reportBackgroundError('git-setup-refresh', err);
  }
}

/**
 * Create-or-reuse the workspace git-setup chat and auto-send the slash skill.
 *
 * The send is fire-and-forget so a later GitHub `ask_question` does not block
 * the button handler. Early failures (no workspace, sessions, no model) return
 * before send so the CTA can re-enable.
 */
export async function startGitSetupBackgroundChat(
  workspacePath?: string,
): Promise<StartGitSetupBackgroundChatResult> {
  const ws = resolveWorkspacePath(workspacePath);
  if (!ws) return { ok: false, error: 'No workspace is open' };

  const key = gitSetupBackgroundKey(ws);
  const chat = ensureBackgroundChat({
    key,
    name: 'Set up git',
    workspacePath: ws,
    modeId: 'build',
  });
  if (!chat) return { ok: false, error: 'Sessions are not ready yet' };

  applyDefaultModelIfMissing(chat);

  const { showToast } = await import('../ui/toast.ts');

  if (isChatStreaming(chat.id) || isChatTurnSetupPending(chat.id) || launchingKeys.has(key)) {
    showToast('Git setup is already running');
    return { ok: true, chatId: chat.id, alreadyRunning: true };
  }

  if (!chat.modelId?.trim()) {
    showToast('Select a model first', 'error');
    return { ok: false, chatId: chat.id, error: 'Select a model first' };
  }

  launchingKeys.add(key);
  showToast('Setting up git in the background');

  const { sendProgrammaticChatText } = await import('./messaging.ts');
  void sendProgrammaticChatText(chat, GIT_SETUP_USER_TEXT, {
    ownsGlobalStreaming: false,
    reportStatus: (level, message) => {
      if (level !== 'err') return;
      void import('../ui/toast.ts').then((m) => m.showToast(message, 'error'));
    },
  })
    .catch((err) => reportBackgroundError('git-setup-send', err))
    .finally(() => {
      launchingKeys.delete(key);
      void refreshGitSurfacesAfterSetup();
    });

  return { ok: true, chatId: chat.id };
}

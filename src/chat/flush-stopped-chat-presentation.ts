import { setChatAbort, setStreaming, isAnyChatStreaming } from '../app-state';
import { clearStaleGenerationStatus } from '../ui/status';
import { clearMainTurnActivity } from './main-turn-activity';
import { clearChatResumeInterrupted } from './resume-interrupted';
import { notifyChatStreamEnded } from './streaming-state';
import { findChatById, scheduleSaveSessions, touchChat } from '../state/sessions';

export interface FlushStoppedChatPresentationOptions {
  /** Also clear the global streaming flag (stop-all only). */
  clearGlobalStreaming?: boolean;
  /** Keep `currentGenerationId` when the backend generation may still be resumable. */
  keepGenerationId?: boolean;
}

/** Drop activity rows, abort handles and generation ids for the given chats. */
export function flushStoppedChatPresentation(
  chatIds: Iterable<string>,
  options: FlushStoppedChatPresentationOptions = {},
): void {
  const ids = [...new Set(chatIds)].filter((id) => id.trim().length > 0);
  if (ids.length === 0 && !options.clearGlobalStreaming) return;

  let sessionsDirty = false;
  for (const chatId of ids) {
    clearMainTurnActivity(chatId);
    setChatAbort(chatId, null);
    notifyChatStreamEnded(chatId);
    setStreaming(false, chatId);
    const chat = findChatById(chatId);
    if (chat?.resumeInterrupted === true) {
      clearChatResumeInterrupted(chat);
      sessionsDirty = true;
    }
    if (options.keepGenerationId) continue;
    if (chat?.currentGenerationId?.trim()) {
      chat.currentGenerationId = undefined;
      touchChat(chat);
      sessionsDirty = true;
    }
  }

  if (options.clearGlobalStreaming) setStreaming(false);
  clearStaleGenerationStatus(isAnyChatStreaming());
  if (sessionsDirty) scheduleSaveSessions();

  scheduleStoppedChatRepaint(ids);
}

/*
 * Board teardown stops every task chat in a loop, so the repaint is coalesced
 * into one pass instead of one sidebar render per chat.
 */
const pendingRepaintChatIds = new Set<string>();
let repaintScheduled = false;

function scheduleStoppedChatRepaint(chatIds: readonly string[]): void {
  for (const chatId of chatIds) pendingRepaintChatIds.add(chatId);
  if (repaintScheduled) return;
  repaintScheduled = true;
  queueMicrotask(() => {
    repaintScheduled = false;
    const ids = [...pendingRepaintChatIds];
    pendingRepaintChatIds.clear();
    void runStoppedChatRepaint(ids);
  });
}

async function runStoppedChatRepaint(chatIds: readonly string[]): Promise<void> {
  try {
    const [dots, sidebar, composer] = await Promise.all([
      import('../ui/chat-item-dot'),
      import('../ui/sidebar'),
      import('../ui/composer-send'),
    ]);
    for (const chatId of chatIds) {
      dots.setSidebarStreamPhase(null, chatId);
    }
    dots.syncChatItemDotsInDom();
    sidebar.renderSidebar();
    composer.syncComposerFromStreamingState();
  } catch {}
}

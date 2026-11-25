import { getSharedChatHost } from '../ui/shared-chat-host-state';
import { expertsPageOpen } from '../app-state';
import { resolveIssueChatQuestionHost } from './issue-chat-host';
import { getForegroundAppId, subscribeInstances } from '../os/instances';
import { getActiveChat } from '../state/sessions';
import { isChatAppForeground } from '../ui/chat-mount';
import { isMainColumnOverlaySuppressingChatDom } from '../ui/main-column-overlay';
import { isCodeMapChatOpenForChat } from '../ui/code-map/chat-state';
import {
  runAskQuestionDisplayContextSync,
} from './ask-question-display-sync';

export { registerAskQuestionDisplayContextSync } from './ask-question-display-sync';

type AskQuestionDisplayListener = () => void;
const displayListeners = new Set<AskQuestionDisplayListener>();

/** Notify waiters and sync hooks when chat or foreground app context changes. */
export function notifyAskQuestionDisplayContextChanged(): void {
  for (const listener of displayListeners) {
    try {
      listener();
    } catch {}
  }
  runAskQuestionDisplayContextSync();
}

/** Subscribe to chat / app context changes that affect ask_question visibility. */
export function subscribeAskQuestionDisplayContext(
  listener: AskQuestionDisplayListener,
): () => void {
  displayListeners.add(listener);
  return () => {
    displayListeners.delete(listener);
  };
}

export function isAskQuestionDomVisible(chatId: string): boolean {
  const trimmed = chatId.trim();
  if (!trimmed) return false;
  if (getSharedChatHost(trimmed)) return true;
  if (resolveIssueChatQuestionHost(trimmed)) return true;

  const active = getActiveChat();
  if (active.id !== trimmed) return false;
  if (isCodeMapChatOpenForChat(trimmed)) return true;
  if (isMainColumnOverlaySuppressingChatDom()) return false;
  if (active.kind === 'expert-lab' && expertsPageOpen) return false;

  const foregroundAppId = getForegroundAppId();
  if (foregroundAppId == null || foregroundAppId === 'code') {
    if (isChatAppForeground()) return true;
    return true;
  }

  return false;
}

/**
 * Resolves when the owning chat becomes a valid display surface, or rejects on abort.
 */
export function waitForAskQuestionDisplayContext(
  chatId: string,
  signal?: AbortSignal,
): Promise<void> {
  if (isAskQuestionDomVisible(chatId)) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      cleanup();
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    };

    const check = (): void => {
      if (signal?.aborted) {
        onAbort();
        return;
      }
      if (isAskQuestionDomVisible(chatId)) {
        cleanup();
        resolve();
      }
    };

    const unsubDisplay = subscribeAskQuestionDisplayContext(check);
    const unsubInstances = subscribeInstances(check);

    const cleanup = (): void => {
      unsubDisplay();
      unsubInstances();
      signal?.removeEventListener('abort', onAbort);
    };

    signal?.addEventListener('abort', onAbort, { once: true });
    check();
  });
}

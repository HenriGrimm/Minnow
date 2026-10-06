import { expertsPageOpen } from '../app-state';
import { getForegroundAppId, subscribeInstances } from '../os/instances';
import { getActiveChat } from '../state/sessions';
import { isChatAppForeground } from '../ui/chat-mount';
import { isMainColumnOverlaySuppressingChatDom } from '../ui/main-column-overlay';
import { isCodeMapChatOpenForChat } from '../ui/code-map/chat-state';
import { isBoardChatEmbedOpenForChat } from '../ui/orchestrate-board-chat-state';
import { isBoardViewActive } from '../ui/view-mode-toggle';
import {
  runAskQuestionDisplayContextSync,
} from './ask-question-display-sync';

export { registerAskQuestionDisplayContextSync } from './ask-question-display-sync';

type AskQuestionDisplayListener = () => void;
const displayListeners = new Set<AskQuestionDisplayListener>();

type PlanQuestionHostResolver = (chatId: string) => HTMLElement | null;
type PlanScreenDomSuppressor = (chatId: string) => boolean;

const planScreenHooks: {
  resolveQuestionHost: PlanQuestionHostResolver | null;
  isSuppressingChatDom: PlanScreenDomSuppressor | null;
} = {
  resolveQuestionHost: null,
  isSuppressingChatDom: null,
};

/** Wired from app boot to avoid circular imports at module load time. */
export function bindAskQuestionPlanScreenHooks(hooks: {
  resolveQuestionHost: PlanQuestionHostResolver;
  isSuppressingChatDom: PlanScreenDomSuppressor;
}): void {
  planScreenHooks.resolveQuestionHost = hooks.resolveQuestionHost;
  planScreenHooks.isSuppressingChatDom = hooks.isSuppressingChatDom;
}

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

  if (planScreenHooks.resolveQuestionHost?.(trimmed)) {
    return true;
  }

  const active = getActiveChat();
  if (active.id !== trimmed) return false;
  if (isCodeMapChatOpenForChat(trimmed)) return true;
  if (isBoardChatEmbedOpenForChat(trimmed)) return true;
  if (planScreenHooks.isSuppressingChatDom?.(trimmed)) return false;
  if (isMainColumnOverlaySuppressingChatDom()) return false;
  if (active.kind === 'expert-lab' && expertsPageOpen) return false;
  if (isBoardViewActive()) return false;

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

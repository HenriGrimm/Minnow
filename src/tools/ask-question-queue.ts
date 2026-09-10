import { getChatAbort } from '../app-state';
import {
  pauseMainTurnActivityForQuestion,
  resumeMainTurnActivityFromQuestion,
} from '../chat/main-turn-activity';
import { getActiveChat } from '../state/sessions';
import { showQuestionCardsModal } from '../ui/question-cards-modal';
import type {
  QuestionCardsModalContext,
  QuestionCardsModalOptions,
} from '../ui/question-cards-modal';
import { resolveOrchestratePlanScreenQuestionHost } from '../ui/orchestrate-plan-screen';
import { resolveBoardOnboardingQuestionHost } from '../ui/orchestrate-board-onboarding-questions';
import { applyBrowserAllowlistFromAskQuestion } from './browser-navigation-gate';
import type { AskQuestionArgs } from './ask-question-types';
import { stringifyAskQuestionResult } from './ask-question-types';

interface Queued {
  args: AskQuestionArgs;
  context: QuestionCardsModalContext;
  /** Owning chat, snapshotted at enqueue so a later switch cannot rebind this item. */
  chatId: string;
  resolve: (content: string) => void;
}

/** FIFO of pending ask_question calls, isolated per chat. */
const queues = new Map<string, Queued[]>();
/** Chats whose modal is currently showing (or parked awaiting an answer). */
const draining = new Set<string>();

/** Resolve the owner immediately so drain never reads getActiveChat() later. */
function snapshotAskQuestionChatId(chatId?: string): string {
  const trimmed = chatId?.trim();
  return trimmed || getActiveChat().id;
}

function queueForChat(chatId: string): Queued[] {
  let q = queues.get(chatId);
  if (!q) {
    q = [];
    queues.set(chatId, q);
  }
  return q;
}

/**
 * Shows the question strip for this chat (or queues behind that chat's active strip).
 * Other chats drain independently — an open strip in chat A cannot block chat B.
 */
export function enqueueAskQuestion(
  args: AskQuestionArgs,
  context: QuestionCardsModalContext = {},
  chatId?: string,
): Promise<string> {
  const ownerId = snapshotAskQuestionChatId(chatId);
  return new Promise((resolve) => {
    queueForChat(ownerId).push({ args, context, chatId: ownerId, resolve });
    void drainQueue(ownerId);
  });
}

async function drainQueue(chatId: string): Promise<void> {
  if (draining.has(chatId)) return;
  const q = queues.get(chatId);
  const next = q?.shift();
  if (!next) return;
  draining.add(chatId);
  try {
    const abortSignal = getChatAbort(chatId)?.signal;
    if (abortSignal?.aborted) {
      next.resolve(stringifyAskQuestionResult({ status: 'cancelled', answers: [] }));
      return;
    }
    const planHost = resolveOrchestratePlanScreenQuestionHost(chatId);
    const boardHost = planHost ? null : resolveBoardOnboardingQuestionHost(chatId);
    const embedHost = planHost ?? boardHost;
    const modalOptions: QuestionCardsModalOptions = embedHost
      ? { host: embedHost, embedded: true, chatId }
      : { chatId };
    void import('../chat/issues/agent-watch')
      .then((m) => {
        try {
          m.markIssueAwaitingInput(chatId);
        } catch {
          // Issues store may be uninitialized outside the Issues app.
        }
      })
      .catch(() => {});

    pauseMainTurnActivityForQuestion(chatId);

    // Modal parks itself when this chat is not the visible surface.
    const result = await showQuestionCardsModal(
      next.args,
      next.context,
      modalOptions,
    );
    await applyBrowserAllowlistFromAskQuestion(next.args, result);
    void import('../chat/issues/agent-watch')
      .then((m) => {
        try {
          m.clearIssueAwaitingInput(chatId);
        } catch {
          // Issues store may be uninitialized outside the Issues app.
        }
      })
      .catch(() => {});
    next.resolve(stringifyAskQuestionResult(result));
  } catch {
    next.resolve(stringifyAskQuestionResult({ status: 'cancelled', answers: [] }));
  } finally {
    resumeMainTurnActivityFromQuestion(chatId);
    draining.delete(chatId);
    if ((queues.get(chatId)?.length ?? 0) > 0) {
      void drainQueue(chatId);
    } else {
      queues.delete(chatId);
    }
  }
}

/** Drop queued entries so tests do not leak across cases. */
export function resetAskQuestionQueueForTests(): void {
  queues.clear();
  draining.clear();
}

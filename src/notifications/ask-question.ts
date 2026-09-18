/**
 * Notification producer when ask_question UI opens — always alerts so the user
 * notices even when the chat is on screen but they are not looking.
 */

import { findChatById } from '../state/sessions';
import type { AskQuestionArgs } from '../tools/ask-question-types';
import { appIdForChat } from './app-for-chat';
import { truncatePreview } from './preview';
import { pushNotification } from './push';

/** Build a compact preview from the first question (and count when batched). */
export function buildAskQuestionPreview(args: AskQuestionArgs): string {
  const first = args.questions[0];
  if (!first?.prompt?.trim()) return 'Answer required';
  const prompt = truncatePreview(first.prompt);
  const extra = args.questions.length - 1;
  if (extra > 0) return `${prompt} (+${extra} more)`;
  return prompt;
}

/** Push inbox row + bell/sound whenever ask_question opens (Super Plan grill, etc.). */
export function notifyAskQuestionShown(chatId: string, args: AskQuestionArgs): void {
  const chat = findChatById(chatId);
  if (!chat) return;

  const title = chat.name?.trim() || 'Chat';
  const body = buildAskQuestionPreview(args);
  const preview = args.title?.trim() ? `${args.title.trim()} — ${body}` : body;
  const questionIds = args.questions.map((q) => q.id).join(',');

  pushNotification({
    kind: 'chat_question',
    title,
    preview,
    chatId,
    appId: appIdForChat(chat),
    dedupeKey: `ask:${chatId}:${questionIds}`,
    os: true,
  });
}

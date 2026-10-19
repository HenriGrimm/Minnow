/** One-line preview of a chat's latest message for list rows. */

import type { Chat } from '../types';

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === 'object' && 'text' in part ? String((part as { text: unknown }).text ?? '') : ''))
      .join(' ');
  }
  return '';
}

function clean(text: string): string {
  return text
    .replace(/<[^>]+>/g, ' ')
    .replace(/```[\s\S]*?```/g, ' code ')
    .replace(/[#*_`>~[\]()|-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Last visible line of the conversation, without markdown punctuation. */
export function chatPreview(chat: Chat, summaryPreview = ''): string {
  if (chat.historyLoaded === false || !Array.isArray(chat.history)) {
    if (summaryPreview) return clean(summaryPreview);
    return chat.messageCount ? `${chat.messageCount} messages` : '';
  }
  for (let i = chat.history.length - 1; i >= 0; i -= 1) {
    const entry = chat.history[i] as { role?: string; content?: unknown; hidden?: boolean };
    if (entry.hidden || (entry.role !== 'assistant' && entry.role !== 'user')) continue;
    const text = clean(textOf(entry.content));
    if (!text) continue;
    return entry.role === 'user' ? `You: ${text}` : text;
  }
  return chat.composerDraft?.trim() ? 'Draft' : '';
}

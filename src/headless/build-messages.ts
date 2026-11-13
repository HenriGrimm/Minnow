/**
 * Minimal ApiMessage builder for headless runs (no attachments / VLM).
 */

import { repairUnpairedToolCalls } from '../api/provider-message-normalize';
import type { ApiMessage, AssistantToolCallMessage, Chat } from '../types';

/** Serialize chat history for the generations API (headless). */
export function buildHeadlessApiMessages(
  chat: Chat,
  composedSystemPrompt: string,
): ApiMessage[] {
  const messages: ApiMessage[] = [];

  const composed = composedSystemPrompt.trim();
  if (composed) {
    messages.push({ role: 'system', content: composed });
  }

  for (const m of chat.history) {
    if (m.role === 'user') {
      messages.push({ role: 'user', content: m.content });
      continue;
    }
    if (m.role === 'tool') {
      messages.push({
        role: 'tool',
        tool_call_id: m.tool_call_id,
        content: m.content,
      });
      continue;
    }
    if (m.role === 'assistant') {
      const withTools = m as AssistantToolCallMessage;
      if (withTools.tool_calls?.length) {
        messages.push({
          role: 'assistant',
          content: withTools.content ?? null,
          tool_calls: withTools.tool_calls,
        });
      } else {
        messages.push({ role: 'assistant', content: m.content });
      }
    }
  }

  return repairUnpairedToolCalls(messages);
}

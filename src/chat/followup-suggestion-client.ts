import { applyUtilityThinkingOff } from '../agents/merge-thinking-body';
import type { ChatCompletionBody } from '../api/chat';
import { resolveLibraryRequestBinding } from '../models/library-request-binding';
import { completeNonStreamingViaGenerations } from '../providers/fetch-chat';
import { getActiveProvider } from '../providers/store';
import { recordChatCompletionUsage } from '../usage/record-chat-usage';
import type { Chat } from '../types';
import { buildFollowupSuggestionMessages, sanitizeFollowupSuggestion } from './followup-suggestion';

/** A short, tool-free request to the chat model. Suggestions never load a local model. */
export async function generateFollowupSuggestion(
  chat: Chat,
  signal: AbortSignal,
  complete = completeNonStreamingViaGenerations,
): Promise<string | null> {
  if (signal.aborted) return null;
  const messages = buildFollowupSuggestionMessages(chat);
  try {
    const selection = chat.agentExecution?.modelSelection;
    const sameSelection = !selection || selection.providerId === chat.providerId && selection.modelId === chat.modelId;
    const resolved = sameSelection ? chat.agentExecution?.resolvedModel : undefined;
    const modelId = resolved?.modelId || chat.modelId.trim();
    if (!modelId || signal.aborted) return null;
    const binding = await resolveLibraryRequestBinding(resolved?.providerId || chat.providerId || '', modelId);
    if (binding.kind === 'needsLoad' || signal.aborted) return null;
    const provider = await getActiveProvider(binding.providerId || undefined, { strict: true });
    if (signal.aborted) return null;
    const body = {
      model: binding.modelId,
      messages,
      temperature: 0.3,
      max_tokens: 100,
    } satisfies ChatCompletionBody;
    applyUtilityThinkingOff(body, provider);
    const result = await complete(provider, body, signal, { fallbackRole: 'utility' });
    if (result.usage) {
      void recordChatCompletionUsage(chat, {
        source: { kind: 'utility', task: 'followup-suggestion' },
        providerId: provider.id,
        modelId: binding.modelId,
        usage: result.usage,
      }).catch(() => {});
    }
    const content = result.choices?.[0]?.message?.content;
    return signal.aborted || typeof content !== 'string' ? null : sanitizeFollowupSuggestion(content);
  } catch {
    // Suggestions are optional; provider failures never interrupt composing.
    return null;
  }
}

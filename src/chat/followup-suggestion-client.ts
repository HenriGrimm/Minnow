import { thinkingToCompletionBody } from '../agents/thinking-to-body';
import { loadUtilityModelConfig, utilityModelOverride } from '../config/utility-model-meta';
import { resolveLibraryRequestBinding } from '../models/library-request-binding';
import { completeNonStreamingViaGenerations } from '../providers/fetch-chat';
import { getActiveProvider } from '../providers/store';
import { recordChatCompletionUsage } from '../usage/record-chat-usage';
import type { Chat } from '../types';
import { buildFollowupSuggestionMessages, sanitizeFollowupSuggestion } from './followup-suggestion';

/** A short, tool-free utility request. Optional suggestions never load a local model. */
export async function generateFollowupSuggestion(
  chat: Chat,
  signal: AbortSignal,
  complete = completeNonStreamingViaGenerations,
): Promise<string | null> {
  if (signal.aborted) return null;
  const messages = buildFollowupSuggestionMessages(chat);
  try {
    const override = utilityModelOverride(await loadUtilityModelConfig());
    const modelId = override?.modelId || chat.modelId.trim();
    if (!modelId || signal.aborted) return null;
    const binding = await resolveLibraryRequestBinding(override?.providerId || chat.providerId || '', modelId);
    if (binding.kind === 'needsLoad' || signal.aborted) return null;
    const provider = await getActiveProvider(binding.providerId || undefined, { strict: true });
    if (signal.aborted) return null;
    const { body: thinkingPatch } = thinkingToCompletionBody('off', provider.apiKind, undefined, null, binding.modelId);
    const result = await complete(provider, {
      model: binding.modelId,
      messages,
      temperature: 0.3,
      max_tokens: 100,
      ...thinkingPatch,
    }, signal, { fallbackRole: 'utility' });
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

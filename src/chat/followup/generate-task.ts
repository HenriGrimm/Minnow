/**
 * Agent-chosen follow-up task (MIN-206).
 *
 * Later links of a chain have no user prompt, so one short completion picks the next
 * task from the previous chat's summary. It rides the shared **Utility tasks** model
 * route (Models → Routing) exactly like chat titles, and every failure degrades to
 * `{ task: null }` so the caller can fall back instead of dropping the chain.
 */

import { ensureChatModelLoadedForTurn } from '../../api/ensure-chat-model-loaded';
import type { ChatCompletionBody } from '../../api/chat';
import { loadUtilityModelConfig, utilityModelOverride } from '../../config/utility-model-meta';
import { resolveLibraryRequestBinding } from '../../models/library-request-binding';
import { LIBRARY_MODEL_PROVIDER_ID } from '../../models/model-select-library';
import { getActiveProvider } from '../../providers/store';
import { hasMeasurableUsage } from '../../usage/pricing';
import { recordChatCompletionUsage } from '../../usage/record-chat-usage';
import type { Chat, ChatCompletionChunk, Usage } from '../../types';
import { createTitleProviderPort } from '../titles/provider-port';
import { buildFollowupTaskMessages } from './prompt';

/** Max stored generated task length. */
export const MAX_FOLLOWUP_TASK_CHARS = 400;

/** Non-streaming completion port (mocked in tests). */
export interface FollowupTaskProviderPort {
  complete(
    body: ChatCompletionBody,
    signal?: AbortSignal,
  ): Promise<ChatCompletionChunk>;
}

export interface FollowupTaskResult {
  task: string | null;
  usage?: Usage;
}

/** One imperative line, no list markers or wrapping quotes. */
export function sanitizeFollowupTask(raw: string): string {
  const line = raw
    .split('\n')
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0);
  if (!line) return '';
  return line
    .replace(/^(?:[-*•]|\d+[.)])\s*/, '')
    .replace(/^["'“”]+|["'“”]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_FOLLOWUP_TASK_CHARS);
}

function completionText(chunk: ChatCompletionChunk): string {
  const content = chunk.choices?.[0]?.message?.content;
  return typeof content === 'string' ? content : '';
}

/**
 * Pick the next task from a chat summary. Returns `{ task: null }` when no model is
 * bound, the model is not loaded, or the completion fails — never throws.
 */
export async function generateFollowupTask(
  summary: string,
  options: { chat: Chat; signal?: AbortSignal },
  port?: FollowupTaskProviderPort,
): Promise<FollowupTaskResult> {
  try {
    const utility = await loadUtilityModelConfig();
    const override = utilityModelOverride(utility);
    const modelId = override?.modelId || options.chat.modelId?.trim() || '';
    if (!modelId) return { task: null };

    const providerId = override?.providerId || options.chat.providerId?.trim() || '';

    let binding = await resolveLibraryRequestBinding(providerId, modelId);
    if (binding.kind === 'needsLoad') {
      await ensureChatModelLoadedForTurn(
        LIBRARY_MODEL_PROVIDER_ID,
        binding.libraryModelId,
        options.signal,
      );
      binding = await resolveLibraryRequestBinding(LIBRARY_MODEL_PROVIDER_ID, binding.libraryModelId);
      if (binding.kind === 'needsLoad') return { task: null };
    }

    const activeProvider = await getActiveProvider(binding.providerId);
    const completion = await (port ?? createTitleProviderPort(binding.providerId)).complete(
      {
        model: binding.modelId,
        messages: buildFollowupTaskMessages(summary),
        temperature: 0.3,
        max_tokens: 200,
      },
      options.signal,
    );

    const task = sanitizeFollowupTask(completionText(completion));
    const usage = completion.usage;

    if (hasMeasurableUsage(usage)) {
      void recordChatCompletionUsage(options.chat, {
        source: { kind: 'utility', task: 'followup-task' },
        providerId: activeProvider.id,
        modelId: binding.modelId,
        usage: usage!,
      });
    }

    return { task: task || null, ...(usage ? { usage } : {}) };
  } catch {
    return { task: null };
  }
}

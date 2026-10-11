import { loadSubAgentConfig } from '../agents/sub-agent-config';
import { resolveChatContextBudget } from '../chat/context/chat-context-budget';
import { contextLengthFromModelRow } from '../lib/context-length';
import type { TurnLimits } from '../../server/runner/run-turn.js';
import type { Chat } from '../types';

/** Use chat's saved context policy and the host's live model window. */
export async function resolveHeadlessContextLimits(chat: Chat, signal: AbortSignal): Promise<TurnLimits> {
  await loadSubAgentConfig();
  signal.throwIfAborted();
  let modelContextLimit = contextLengthFromModelRow({ id: chat.modelId }) ?? null;
  if (chat.providerId && chat.modelId) {
    try {
      const response = await fetch(
        `/api/providers/${encodeURIComponent(chat.providerId)}/context-window?modelId=${encodeURIComponent(chat.modelId)}`,
        { signal, cache: 'no-store' },
      );
      if (response.ok) {
        const body = await response.json() as { contextLength?: number | null };
        if (typeof body.contextLength === 'number' && Number.isFinite(body.contextLength) && body.contextLength > 0) {
          modelContextLimit = body.contextLength;
        }
      }
    } catch {
      // Offline metadata retains known-model resolution; unknown windows stay unknown.
      signal.throwIfAborted();
    }
  }
  return { contextBudget: resolveChatContextBudget(chat), modelContextLimit };
}

import { applyUtilityThinkingOff } from '../../agents/merge-thinking-body';
import { completeNonStreamingViaGenerations } from '../../providers/fetch-chat';
import { getActiveProvider } from '../../providers/store';
import type { ChatCompletionBody } from '../../api/chat';
import type { ApiKind } from '../../providers/types';
import type { TitleProviderPort } from './types';

/** Request prose while leaving required CLI reasoning at the model default. */
export function applyTitleThinkingOffPatch(
  body: ChatCompletionBody,
  apiKind: ApiKind,
): ChatCompletionBody {
  const patched = { ...body };
  applyUtilityThinkingOff(patched, { id: '', apiKind });
  return patched;
}

/** Build a port that resolves auth/URL via the active provider layer. */
export function createTitleProviderPort(providerId?: string): TitleProviderPort {
  return {
    async complete(body, signal) {
      const provider = await getActiveProvider(providerId);
      const abortSignal = signal ?? new AbortController().signal;
      return completeNonStreamingViaGenerations(
        provider,
        applyTitleThinkingOffPatch(body, provider.apiKind),
        abortSignal,
        { fallbackRole: 'chat-titles' },
      );
    },
  };
}

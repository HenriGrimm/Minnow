import { applyUtilityThinkingOff } from '../agents/merge-thinking-body';
import { createGeneration, cancelGeneration, subscribeToGeneration, formatGenerationErrorMessage } from '../api/generations';
import { StreamingContentAccumulator } from '../api/message-content';
import { ensureChatModelLoadedForTurn } from '../api/ensure-chat-model-loaded';
import { modelCache } from '../app-state';
import { loadUtilityModelConfig, utilityModelOverride } from '../config/utility-model-meta';
import { generateReleaseDraft } from '../chat/releases/draft-release-notes';
import { encodeModelSelectKey } from '../lib/model-select-key';
import { contextLengthFromModelRow } from '../lib/context-length';
import { resolveLibraryRequestBinding } from '../models/library-request-binding';
import { LIBRARY_MODEL_PROVIDER_ID } from '../models/model-select-library';
import { resolveProvider } from '../providers/store';
import type { ReleaseDraftContext } from '../state/actions-api';
import type { ApiMessage } from '../types';
import { readDefaultModelBinding } from './default-model';

export async function writeReleaseDraft(
  context: ReleaseDraftContext,
  signal: AbortSignal,
  onProgress: (message: string) => void,
): Promise<string> {
  signal.throwIfAborted();
  const utility = utilityModelOverride(await loadUtilityModelConfig());
  const picked = utility ?? readDefaultModelBinding();
  if (!picked.modelId.trim()) throw new Error('Choose a utility model in Settings or a default model in the top bar.');
  const providerId = picked.providerId || (await resolveProvider()).id;
  let binding = await resolveLibraryRequestBinding(providerId, picked.modelId);
  signal.throwIfAborted();
  if (binding.kind === 'needsLoad') {
    onProgress('Loading utility model…');
    await ensureChatModelLoadedForTurn(LIBRARY_MODEL_PROVIDER_ID, binding.libraryModelId, signal);
    binding = await resolveLibraryRequestBinding(LIBRARY_MODEL_PROVIDER_ID, binding.libraryModelId);
    if (binding.kind === 'needsLoad') throw new Error('Could not load the utility model. Try again.');
  }
  const provider = await resolveProvider(binding.providerId, { strict: true });
  const model = modelCache.get(encodeModelSelectKey(provider.id, binding.modelId));
  const complete = async (messages: ApiMessage[], maxTokens: number): Promise<string> => {
    signal.throwIfAborted();
    const body: Record<string, unknown> = {
      model: binding.modelId, messages, stream: true, temperature: 0.3, max_tokens: maxTokens,
    };
    applyUtilityThinkingOff(body, provider, model?.capabilities);
    const { generationId } = await createGeneration(provider.id, body, { persist: false, fallbackRole: 'utility' });
    if (signal.aborted) {
      await cancelGeneration(generationId).catch(() => {});
      signal.throwIfAborted();
    }
    return new Promise<string>((resolve, reject) => {
      const acc = new StreamingContentAccumulator();
      let incomplete = false;
      let settled = false;
      let unsubscribe = () => {};
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        unsubscribe();
        signal.removeEventListener('abort', abort);
        if (error) reject(error);
        else resolve(acc.getText());
      };
      const abort = () => {
        void cancelGeneration(generationId).catch(() => {});
        finish(new DOMException('Cancelled', 'AbortError'));
      };
      signal.addEventListener('abort', abort, { once: true });
      unsubscribe = subscribeToGeneration(generationId, {
        signal,
        onChunk: chunk => {
          acc.ingestChoice(chunk.choices?.[0]);
          const reason = chunk.choices?.[0]?.finish_reason;
          if (reason && reason !== 'stop') incomplete = true;
        },
        onEnd: event => {
          if (event?.status === 'cancelled') finish(new DOMException('Cancelled', 'AbortError'));
          else if (event?.status === 'error') finish(new Error(formatGenerationErrorMessage(event.errorMessage || 'Release draft generation failed.')));
          else if (incomplete) finish(new Error('The model returned incomplete release notes. Try again or choose another utility model.'));
          else finish();
        },
        onTransportError: error => {
          void cancelGeneration(generationId).catch(() => {});
          finish(new Error(formatGenerationErrorMessage(error instanceof Error ? error.message : String(error))));
        },
      });
      if (signal.aborted) abort();
    });
  };
  return generateReleaseDraft(context, { signal, onProgress, contextLimit: model ? contextLengthFromModelRow(model) : undefined, complete });
}

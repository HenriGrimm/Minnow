import {
  cancelGeneration,
  createGeneration,
  formatGenerationErrorMessage,
  subscribeToGeneration,
  type GenerationEndEvent,
} from '../api/generations';
import { StreamingContentAccumulator } from '../api/message-content';
import { thinkingToCompletionBody } from '../agents/thinking-to-body';
import { modelCache } from '../app-state';
import { getPendingAttachments } from '../attachments/store';
import {
  buildExpandPromptMessages,
  sanitizeExpandedPrompt,
} from '../chat/prompts/expand-prompt';
import { encodeModelSelectKey } from '../lib/model-select-key';
import { ensureChatModelLoadedForTurn } from '../api/ensure-chat-model-loaded';
import { resolveLibraryRequestBinding } from '../models/library-request-binding';
import { LIBRARY_MODEL_PROVIDER_ID } from '../models/model-select-library';
import { catalogCapabilitiesFromRow } from '../providers/model-capabilities';
import { loadPromptExpanderConfig } from '../config/prompt-expander-meta';
import { loadUtilityModelConfig, utilityModelOverride } from '../config/utility-model-meta';
import { resolveProvider } from '../providers/store';
import { getActiveChat } from '../state/sessions';
import { resolveExpandPromptBindingFromChat, type ExpandPromptBinding } from './composer-expand-binding';
import { setStatus } from './status';
import type { Attachment } from '../attachments/types';

/** Room for a paragraph or a short bullet list — not an essay. */
const EXPAND_MAX_TOKENS = 700;
const EXPAND_TEMPERATURE = 0.4;

export const EXPAND_NO_MODEL_MESSAGE =
  'No model assigned — pick a model before expanding.';
export const EXPAND_FAILED_MESSAGE =
  'Expand failed — check provider and model in Settings';
export const EXPAND_EMPTY_MESSAGE = 'Model returned no expanded prompt.';
export const EXPAND_MODEL_LOAD_FAILED_MESSAGE =
  'Could not start the selected model — load it in Models and try again.';

export type { ExpandPromptBinding };

export interface ExpandPromptRequest {
  draft: string;
  signal: AbortSignal;
  /** Files staged in the composer; defaults to the pending attachment list. */
  attachments?: readonly Attachment[];
  /** Called with sanitized text as it streams. */
  onPartial?: (text: string) => void;
}

export interface ExpandPromptResult {
  text: string | null;
  error?: string;
}

// ── Binding ──────────────────────────────────────────────────────────────────

/** Settings override when set, else the active chat's composer model (per-chat picker), else the default provider. */
export async function resolveExpandPromptBinding(): Promise<ExpandPromptBinding> {
  const [legacyConfig, utilityConfig] = await Promise.all([
    loadPromptExpanderConfig(),
    loadUtilityModelConfig(),
  ]);
  const config = utilityModelOverride(utilityConfig) ?? legacyConfig;
  const chat = getActiveChat();
  const fallbackProviderId = (await resolveProvider()).id;
  return resolveExpandPromptBindingFromChat(config, chat, fallbackProviderId);
}

/** Binding the completions request should carry. */
async function resolveExpandSendBinding(
  binding: ExpandPromptBinding,
  signal: AbortSignal,
): Promise<{ binding: ExpandPromptBinding } | { error: string }> {
  let resolved = await resolveLibraryRequestBinding(binding.providerId, binding.modelId);

  if (resolved.kind === 'needsLoad') {
    setStatus('spin', 'Loading model…');
    try {
      await ensureChatModelLoadedForTurn(
        LIBRARY_MODEL_PROVIDER_ID,
        resolved.libraryModelId,
        signal,
      );
    } catch (err) {
      if (signal.aborted) return { error: '' };
      return { error: errorMessageFrom(err) };
    }
    resolved = await resolveLibraryRequestBinding(
      LIBRARY_MODEL_PROVIDER_ID,
      resolved.libraryModelId,
    );
    if (resolved.kind === 'needsLoad') {
      return { error: EXPAND_MODEL_LOAD_FAILED_MESSAGE };
    }
    setStatus('spin', 'Expanding prompt…');
  }

  return {
    binding: { providerId: resolved.providerId, modelId: resolved.modelId },
  };
}

// ── Errors ───────────────────────────────────────────────────────────────────

function errorMessageFrom(err: unknown): string {
  if (err instanceof Error && err.message.trim()) {
    return formatGenerationErrorMessage(err.message);
  }
  return EXPAND_FAILED_MESSAGE;
}

function endErrorMessage(event?: GenerationEndEvent): string {
  const raw = event?.errorMessage?.trim();
  return raw ? formatGenerationErrorMessage(raw) : EXPAND_FAILED_MESSAGE;
}

/** Thinking is dead weight here — the answer is prose in `content`. */
function thinkingOffPatch(
  providerApiKind: Parameters<typeof thinkingToCompletionBody>[1],
  providerId: string,
  modelId: string,
): Record<string, unknown> {
  const modelRow = modelId
    ? modelCache.get(encodeModelSelectKey(providerId, modelId))
    : undefined;
  const capabilities =
    modelRow?.capabilities ??
    (modelRow ? catalogCapabilitiesFromRow(modelRow) : undefined);
  const { body } = thinkingToCompletionBody('off', providerApiKind, capabilities, null, modelId);
  return body as Record<string, unknown>;
}

// ── Fetch ────────────────────────────────────────────────────────────────────

/** Stream one expansion of `draft`; resolves with the final sanitized prompt. */
export async function fetchExpandedPrompt(
  input: ExpandPromptRequest,
): Promise<ExpandPromptResult> {
  const draft = input.draft.trim();
  if (!draft) return { text: null };
  const attachments = input.attachments ?? getPendingAttachments();

  const picked = await resolveExpandPromptBinding();
  if (!picked.modelId.trim()) {
    return { text: null, error: EXPAND_NO_MODEL_MESSAGE };
  }

  const send = await resolveExpandSendBinding(picked, input.signal);
  if ('error' in send) {
    return { text: null, error: send.error || undefined };
  }
  const binding = send.binding;

  let provider;
  try {
    provider = await resolveProvider(binding.providerId, { strict: true });
  } catch (err) {
    return { text: null, error: errorMessageFrom(err) };
  }
  const body: Record<string, unknown> = {
    model: binding.modelId,
    messages: buildExpandPromptMessages(draft, attachments),
    temperature: EXPAND_TEMPERATURE,
    max_tokens: EXPAND_MAX_TOKENS,
    stream: true,
    ...thinkingOffPatch(provider.apiKind, provider.id, binding.modelId),
  };

  let generationId: string;
  try {
    ({ generationId } = await createGeneration(provider.id, body, {
      persist: false,
      fallbackRole: 'utility',
    }));
  } catch (err) {
    return { text: null, error: errorMessageFrom(err) };
  }

  const acc = new StreamingContentAccumulator();

  return new Promise<ExpandPromptResult>((resolve) => {
    let settled = false;
    const finish = (text: string | null, error?: string): void => {
      if (settled) return;
      settled = true;
      resolve(error ? { text: null, error } : { text });
    };

    const unsubscribe = subscribeToGeneration(generationId, {
      signal: input.signal,
      onChunk: (chunk) => {
        acc.ingestChoice(chunk.choices?.[0]);
        const partial = sanitizeExpandedPrompt(acc.getText(), { partial: true });
        if (partial) input.onPartial?.(partial);
      },
      onEnd: (event?: GenerationEndEvent) => {
        unsubscribe();
        if (event?.status === 'error') {
          finish(null, endErrorMessage(event));
          return;
        }
        if (event?.status === 'cancelled') {
          finish(null);
          return;
        }
        const text = sanitizeExpandedPrompt(acc.getText());
        finish(text || null, text ? undefined : EXPAND_EMPTY_MESSAGE);
      },
      onTransportError: (err) => {
        unsubscribe();
        finish(null, errorMessageFrom(err));
      },
    });

    input.signal.addEventListener(
      'abort',
      () => {
        unsubscribe();
        void cancelGeneration(generationId).catch(() => {
        });
        finish(null);
      },
      { once: true },
    );
  });
}

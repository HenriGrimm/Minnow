import { applyUtilityThinkingOff } from '../agents/merge-thinking-body';
import {
  cancelGeneration,
  createGeneration,
  formatGenerationErrorMessage,
  subscribeToGeneration,
  type GenerationEndEvent,
} from '../api/generations';
import { StreamingContentAccumulator } from '../api/message-content';
import { modelCache } from '../app-state';
import { ensureChatModelLoadedForTurn } from '../api/ensure-chat-model-loaded';
import {
  buildExpandIssueMessages,
  parseExpandedIssue,
  type ExpandedIssueDraft,
  type IssueExpandSource,
  type IssueExpandCatalog,
} from '../chat/issues/expand-issue';
import { loadPromptExpanderConfig } from '../config/prompt-expander-meta';
import { loadUtilityModelConfig, utilityModelOverride } from '../config/utility-model-meta';
import { encodeModelSelectKey } from '../lib/model-select-key';
import { resolveLibraryRequestBinding } from '../models/library-request-binding';
import { LIBRARY_MODEL_PROVIDER_ID } from '../models/model-select-library';
import { catalogCapabilitiesFromRow } from '../providers/model-capabilities';
import { resolveProvider } from '../providers/store';
import {
  EXPAND_EMPTY_MESSAGE,
  EXPAND_FAILED_MESSAGE,
  EXPAND_MODEL_LOAD_FAILED_MESSAGE,
  EXPAND_NO_MODEL_MESSAGE,
} from './composer-expand-client';
import { readDefaultModelBinding } from './default-model';
import { resolveIssueExpandPromptBindingFromDefault, type ExpandPromptBinding } from './composer-expand-binding';
import { setStatus } from './status';

/** Room for a structured description — more than a prompt rewrite, still not an essay. */
const EXPAND_ISSUE_MAX_TOKENS = 1200;
const EXPAND_ISSUE_TEMPERATURE = 0.4;

export {
  EXPAND_EMPTY_MESSAGE,
  EXPAND_FAILED_MESSAGE,
  EXPAND_MODEL_LOAD_FAILED_MESSAGE,
  EXPAND_NO_MODEL_MESSAGE,
};

export interface ExpandIssueRequest {
  issue: IssueExpandSource;
  catalog?: IssueExpandCatalog;
  signal: AbortSignal;
  onPartial?: (draft: ExpandedIssueDraft) => void;
}

export interface ExpandIssueResult {
  draft: ExpandedIssueDraft | null;
  error?: string;
}

/** Issues expander binding: Settings override, else the top-bar default model, else the default provider. */
async function resolveIssueExpandPromptBinding(): Promise<ExpandPromptBinding> {
  const [legacyConfig, utilityConfig] = await Promise.all([
    loadPromptExpanderConfig(),
    loadUtilityModelConfig(),
  ]);
  const config = utilityModelOverride(utilityConfig) ?? legacyConfig;
  const { modelId, providerId } = readDefaultModelBinding();
  const fallbackProviderId = (await resolveProvider()).id;
  return resolveIssueExpandPromptBindingFromDefault(
    config,
    { providerId, modelId },
    fallbackProviderId,
  );
}

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
    setStatus('spin', 'Expanding issue…');
  }

  return {
    binding: { providerId: resolved.providerId, modelId: resolved.modelId },
  };
}

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

/** Stream one expansion of the issue card; resolves with the parsed title + description. */
export async function fetchExpandedIssue(
  input: ExpandIssueRequest,
): Promise<ExpandIssueResult> {
  const picked = await resolveIssueExpandPromptBinding();
  if (!picked.modelId.trim()) {
    return { draft: null, error: EXPAND_NO_MODEL_MESSAGE };
  }

  const send = await resolveExpandSendBinding(picked, input.signal);
  if ('error' in send) {
    return { draft: null, error: send.error || undefined };
  }
  const binding = send.binding;

  let provider;
  try {
    provider = await resolveProvider(binding.providerId, { strict: true });
  } catch (err) {
    return { draft: null, error: errorMessageFrom(err) };
  }

  const modelRow = binding.modelId
    ? modelCache.get(encodeModelSelectKey(provider.id, binding.modelId))
    : undefined;
  const capabilities =
    modelRow?.capabilities ?? (modelRow ? catalogCapabilitiesFromRow(modelRow) : undefined);

  const body: Record<string, unknown> = {
    model: binding.modelId,
    messages: buildExpandIssueMessages(input.issue, input.catalog),
    temperature: EXPAND_ISSUE_TEMPERATURE,
    max_tokens: EXPAND_ISSUE_MAX_TOKENS,
    stream: true,
  };
  applyUtilityThinkingOff(body, provider, capabilities);

  let generationId: string;
  try {
    ({ generationId } = await createGeneration(provider.id, body, {
      persist: false,
      fallbackRole: 'utility',
    }));
  } catch (err) {
    return { draft: null, error: errorMessageFrom(err) };
  }

  const acc = new StreamingContentAccumulator();

  return new Promise<ExpandIssueResult>((resolve) => {
    let settled = false;
    const finish = (draft: ExpandedIssueDraft | null, error?: string): void => {
      if (settled) return;
      settled = true;
      resolve(error ? { draft: null, error } : { draft });
    };

    const unsubscribe = subscribeToGeneration(generationId, {
      signal: input.signal,
      onChunk: (chunk) => {
        acc.ingestChoice(chunk.choices?.[0]);
        const partial = parseExpandedIssue(acc.getText(), { partial: true });
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
        const draft = parseExpandedIssue(acc.getText());
        finish(draft, draft ? undefined : EXPAND_EMPTY_MESSAGE);
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

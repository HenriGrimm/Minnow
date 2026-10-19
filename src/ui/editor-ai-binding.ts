import { readPersistedDefaultModelValue, resolveEffectiveChatModelBinding } from '../models/selection';
import type { EditorAiCompletionConfig } from '../config/editor-ai-completion';
import {
  LIBRARY_MODEL_NOT_LOADED_MESSAGE,
  resolveLibraryRequestBinding,
} from '../models/library-request-binding';
import { resolveProvider } from '../providers/store';
import { getActiveChat } from '../state/sessions';

export interface EditorAiBinding {
  providerId: string;
  modelId: string;
  /** Set when the binding cannot be sent as-is (My Models row with no serve). */
  error?: string;
}

/** Shown in the file viewer status bar and Quick Edit panel when modelId is empty. */
export const EDITOR_AI_NO_MODEL_MESSAGE =
  'No model assigned — pick a model in the composer or pin one in Settings → Editor.';

/** Generic fallback when the backend fails without a specific message. */
export const EDITOR_AI_REQUEST_FAILED_MESSAGE =
  'AI completion failed — check provider and model in Settings';

/** Shown when the model streams successfully but yields no insertable text. */
export const EDITOR_AI_EMPTY_COMPLETION_MESSAGE =
  'Model returned no completion text. Try a coder model or disable thinking in your provider.';

export const EDITOR_AI_COMPLETION_OVERSIZED_MESSAGE =
  'Completion too long for inline insert — lower max tokens or edit a smaller region.';

export const EDITOR_AI_COMPLETION_PROSE_MESSAGE =
  'Model returned explanation instead of code — try a coder model.';

export const EDITOR_AI_COMPLETION_PREFIX_ECHO_MESSAGE =
  'Model repeated existing text — no suggestion shown.';

export const EDITOR_AI_COMPLETION_FULL_REWRITE_MESSAGE =
  'Completion would replace most of the file — rejected.';

export type EditorAiBindingValidation =
  | { ok: true }
  | { ok: false; message: string };

/** Require a provider and model before editor AI requests (inline completion, Quick Edit). */
export function validateEditorAiBinding(
  binding: EditorAiBinding,
): EditorAiBindingValidation {
  if (!binding.providerId.trim()) {
    return {
      ok: false,
      message:
        'No provider configured for editor AI. Add one in Settings → Providers.',
    };
  }
  if (!binding.modelId.trim()) {
    return { ok: false, message: EDITOR_AI_NO_MODEL_MESSAGE };
  }
  if (binding.error) {
    return { ok: false, message: binding.error };
  }
  return { ok: true };
}

/** Compatibility accessor for the remembered chat selection. */
export function getActiveModelIdFromDom(): string {
  return readPersistedDefaultModelValue();
}

/** Return a user-facing error when binding has no model; null when ready. */
export function preflightEditorAiBinding(binding: EditorAiBinding): string | null {
  if (binding.modelId.trim()) return null;
  return EDITOR_AI_NO_MODEL_MESSAGE;
}

/** Remap a My Models row onto its running serve. */
async function applyLibraryBinding(binding: EditorAiBinding): Promise<EditorAiBinding> {
  if (!binding.modelId.trim()) return binding;
  const resolved = await resolveLibraryRequestBinding(
    binding.providerId,
    binding.modelId,
  );
  if (resolved.kind === 'needsLoad') {
    return { ...binding, error: LIBRARY_MODEL_NOT_LOADED_MESSAGE };
  }
  return { providerId: resolved.providerId, modelId: resolved.modelId };
}

/** Resolve provider/model from config + active chat. */
export async function resolveEditorAiBinding(
  config: EditorAiCompletionConfig,
): Promise<EditorAiBinding> {
  const chat = getActiveChat();
  const overrideProvider = config.providerId.trim();
  const overrideModel = config.modelId.trim();

  if (!config.useChatModel) {
    return applyLibraryBinding({ providerId: overrideProvider, modelId: overrideModel });
  }

  const binding = resolveEffectiveChatModelBinding(chat);
  const modelId = binding.modelId;
  const providerId = binding.providerId || (await resolveProvider()).id;
  return applyLibraryBinding({ providerId, modelId });
}

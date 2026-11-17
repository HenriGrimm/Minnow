/**
 * The user's favorite reasoning level per model (MIN-1047).
 *
 * Favorites share the persisted per-model reasoning store
 * (`~/.minnow/model-reasoning-defaults.json`): a starred level is the level new
 * chats, model switches and "Default" use for that model. The model's own
 * default applies only when no favorite is starred.
 */

import {
  getModelReasoningDefault,
  saveModelReasoningDefault,
} from '../config/model-reasoning-defaults';
import { encodeModelSelectKey } from '../lib/model-select-key';
import { getComposerReasoningLevelOptions } from '../lib/reasoning-effort';
import { resolveSendCapabilities } from '../providers/model-capabilities';
import type { ReasoningEffortOption } from '../types';

function selectKey(providerId: string | undefined, modelId: string | undefined): string {
  const provider = providerId?.trim();
  const model = modelId?.trim();
  return provider && model ? encodeModelSelectKey(provider, model) : '';
}

/** Saved favorite for a model, without checking what the model advertises. */
export function savedReasoningFavorite(
  providerId: string | undefined,
  modelId: string | undefined,
): ReasoningEffortOption | undefined {
  const key = selectKey(providerId, modelId);
  return key ? getModelReasoningDefault(key) : undefined;
}

/** The favorite level when the model still advertises it; otherwise undefined. */
export function favoriteReasoningLevel(
  providerId: string | undefined,
  modelId: string | undefined,
): ReasoningEffortOption | undefined {
  const saved = savedReasoningFavorite(providerId, modelId);
  if (!saved || !providerId || !modelId) return undefined;
  const caps = resolveSendCapabilities(providerId.trim(), modelId.trim());
  const levels = getComposerReasoningLevelOptions(caps?.reasoningAllowedOptions ?? []);
  return levels.includes(saved) ? saved : undefined;
}

/** Star a level for a model, or clear the favorite with `null`. */
export function saveReasoningFavorite(
  providerId: string | undefined,
  modelId: string | undefined,
  level: ReasoningEffortOption | null,
): Promise<void> {
  const key = selectKey(providerId, modelId);
  if (!key) return Promise.reject(new Error('Choose a model before starring a reasoning level.'));
  return saveModelReasoningDefault(key, level);
}

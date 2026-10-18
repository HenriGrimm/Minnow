import { showToast } from '../ui/toast';
import {
  mergeThinkingIntoCompletionBody as mergeThinkingIntoCompletionBodyShared,
  applyUtilityThinkingOff,
  type MergeThinkingResult,
} from '../../server/runner/merge-thinking-body.js';
import type { ProviderPublic, ApiKind } from '../providers/types';
import type { ModelCapabilities, ReasoningEffortOption } from '../types';
import type { ThinkingResolvedMode } from './thinking-types';

export { applyUtilityThinkingOff };
export type { MergeThinkingResult };

/** Restore the LM Studio toast that the shared package cannot own. */
export function mergeThinkingIntoCompletionBody<T extends Record<string, unknown>>(
  body: T,
  resolved: ThinkingResolvedMode,
  provider: Pick<ProviderPublic, 'id' | 'apiKind' | 'autoApi' | 'modelApiOverrides'>,
  modelCapabilities?: ModelCapabilities | null,
  reasoningEffort?: ReasoningEffortOption | null,
  modelApi?: ApiKind,
  budgetTokens?: number | null,
  options?: { llamaSupportsThinkingBudget?: boolean; modelId?: string },
): MergeThinkingResult<T> {
  return mergeThinkingIntoCompletionBodyShared(
    body,
    resolved,
    provider,
    modelCapabilities,
    reasoningEffort,
    modelApi,
    budgetTokens,
    {
      ...options,
      onStatusHint: (message) => showToast(message),
    },
  );
}

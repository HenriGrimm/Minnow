/**
 * Apply resolved thinking mode to a chat completion body and surface LM Studio hints.
 */
import type { ProviderPublic, ApiKind } from './provider-ids.js';
import type { ModelCapabilities, ReasoningEffortOption } from '../../src/types.js';
import type { ThinkingResolvedMode } from './thinking-types.js';
export interface MergeThinkingResult<T> {
    body: T;
    nativeBudgetApplied: boolean;
}
/**
 * Disable thinking/reasoning for short utility completions (git commit message, inline edit, etc.).
 * Ignores chat composer toggles; CLI models keep their default unless off is advertised.
 */
export declare function applyUtilityThinkingOff(body: Record<string, unknown>, provider: Pick<ProviderPublic, 'id' | 'apiKind' | 'autoApi' | 'modelApiOverrides'>, modelCapabilities?: ModelCapabilities | null, modelApi?: ApiKind): void;
/** Merge provider-specific thinking fields into an outbound completion body. */
export declare function mergeThinkingIntoCompletionBody<T extends Record<string, unknown>>(body: T, resolved: ThinkingResolvedMode, provider: Pick<ProviderPublic, 'id' | 'apiKind' | 'autoApi' | 'modelApiOverrides'>, modelCapabilities?: ModelCapabilities | null, reasoningEffort?: ReasoningEffortOption | null, modelApi?: ApiKind, budgetTokens?: number | null, options?: {
    llamaSupportsThinkingBudget?: boolean;
    modelId?: string;
    /** Renderer toast hook; omitted on the server. */
    onStatusHint?: (message: string) => void;
}): MergeThinkingResult<T>;

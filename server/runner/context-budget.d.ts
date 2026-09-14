import type { ApiMessage } from '../../src/types.js';
import type { ArchiveConfig } from '../../src/chat/archive/types.js';
import type { CompactionCheckpoint } from './compaction/index.js';
/** Retired values still stored in config and settings; at runtime they run as `compact`. */
export type LegacyContextEnforcementPolicy = 'summarize' | 'dropMiddle' | 'archive';
/**
 * How to fit outbound messages under a token ceiling. Runtime policies are
 * `compact` / `slide` / `truncate`; legacy values normalize to `compact`
 * ({@link normalizeContextEnforcementPolicy}).
 */
export type ContextEnforcementPolicy = 'compact' | 'slide' | 'truncate' | LegacyContextEnforcementPolicy;
/** Shipped default when a row omits policy (deterministic compaction). */
export declare const DEFAULT_CONTEXT_ENFORCEMENT_POLICY: ContextEnforcementPolicy;
/** Runtime policy for a stored value: legacy values map to `compact`, unknown values to null. */
export declare function normalizeContextEnforcementPolicy(value: unknown): 'compact' | 'slide' | 'truncate' | null;
export declare const SAFETY_MARGIN = 0.9;
/** Message-budget sanity floor used by tests; generation is not subtracted from the ceiling. */
export declare const LOCAL_PROMPT_FLOOR_TOKENS = 4096;
/** Least `max_tokens` a local request asks for when n_ctx is known (never 1). */
export declare const LOCAL_MIN_GENERATION_TOKENS = 4096;
/** Agent-level budget declaration (work agents + sub-agent types). */
export interface AgentContextBudgetConfig {
    enforcementPolicy: ContextEnforcementPolicy;
    /** Turns kept verbatim before rounds of the current turn fold (compact) / whole turns kept (slide). */
    minRecentTurns?: number;
    /** Share of the message ceiling that triggers compaction (default 0.8). */
    highWater?: number;
    /** Share of the ceiling a compaction aims for (default 0.5). */
    lowWater?: number;
    /** Summary budget in tokens; default `min(6k, 12% of window)`. */
    summaryBudgetTokens?: number;
    /** @deprecated LLM-summary reserve; the compactor ignores it. */
    summaryReserveTokens?: number;
    /** @deprecated Brain archive tuning (the archive policy runs as compact). */
    archive?: ArchiveConfig;
}
export interface ResolvedContextBudget {
    /** Ceiling for the *message* estimate — already net of {@link reservedTokens}. */
    effectiveLimit: number | null;
    modelLimit: number | null;
    policy: ContextEnforcementPolicy;
    /** Non-message payload sharing the window (tool schemas). */
    reservedTokens: number;
}
export interface ApplyContextBudgetResult {
    messages: ApiMessage[];
    applied: boolean;
    policy: ContextEnforcementPolicy;
    tokensBefore: number;
    tokensAfter: number;
    droppedMessageCount: number;
    /** Whole turns (user row + its rounds) dropped or folded. */
    droppedTurns: number;
    /** Rounds folded inside the kept turns once whole-turn drops were not enough. */
    droppedRounds: number;
    summaryInjected: boolean;
    /** Text sent to the model inside the summary user message, if any. */
    summaryText?: string;
    /** Checkpoint a stateless `compact` trim produced (row ids are indices). */
    checkpoint?: CompactionCheckpoint | null;
    statusMessage: string | null;
}
export interface TurnSlice {
    start: number;
    end: number;
}
export declare function serializeApiMessageForEstimate(msg: ApiMessage): string;
/**
 * Token estimate for one outbound message, priced per content class. Tool
 * results and serialized `tool_calls` are the bulk of an agent transcript and
 * tokenize far worse than prose, so they must not share prose's divisor.
 */
export declare function estimateApiMessageTokens(
    msg: ApiMessage,
    options?: {
        /** False for assistant turns before the last user message — templates drop that reasoning. */
        replaysReasoning?: boolean;
    },
): number;
/** Whole-request estimate; reasoning counts only after the last user message. */
export declare function estimateApiMessagesTokens(messages: ApiMessage[]): number;
export declare function agentContextBudgetFromWorkAgent(agent: {
    contextEnforcementPolicy?: ContextEnforcementPolicy | null;
    minRecentTurns?: number;
    highWater?: number;
    lowWater?: number;
    summaryBudgetTokens?: number;
    summaryReserveTokens?: number;
    archive?: ArchiveConfig;
}, resolvedPolicy?: ContextEnforcementPolicy): AgentContextBudgetConfig;
export declare function agentContextBudgetFromSubAgentType(type: Parameters<typeof agentContextBudgetFromWorkAgent>[0], resolvedPolicy?: ContextEnforcementPolicy): AgentContextBudgetConfig;
export declare function resolveContextBudget(params: {
    agentConfig: AgentContextBudgetConfig;
    modelLimit: number | null;
    /**
     * Tokens the request spends outside `messages` — tool schemas ride in
     * `body.tools`, share the same window, and are invisible to the message
     * estimate. Left uncounted, the whole enabled catalog (≈12k real tokens)
     * silently ate more than {@link SAFETY_MARGIN}.
     */
    reservedTokens?: number;
    /**
     * Force the message-estimate ceiling, bypassing margin and reserve. Set from
     * a provider's own overflow numbers so a compact-and-retry targets what the
     * server actually measured rather than what we guessed.
     */
    effectiveLimitOverride?: number | null;
}): ResolvedContextBudget;
export declare function isLocalKvCacheProvider(providerId: string | null | undefined): boolean;
export interface LocalGenerationReserveParams {
    providerId?: string | null;
    maxTokens?: number | null;
    modelLimit?: number | null;
    toolsReserveTokens?: number | null;
    messages?: ApiMessage[] | null;
}
export declare function localGenerationReserveTokens(params: LocalGenerationReserveParams): number;
export interface LocalRequestMaxTokensParams {
    providerId?: string | null;
    maxTokens?: number | null;
    modelLimit?: number | null;
    generationReserveTokens?: number | null;
}
export declare function localRequestMaxTokens(params: LocalRequestMaxTokensParams): number;
export interface LocalWindowReserves {
    generationReserveTokens: number;
    /** Tool-schema tokens only — do not add generation; that is requestMaxTokens. */
    reservedTokens: number;
    requestMaxTokens: number;
}
export declare function resolveLocalWindowReserves(params: LocalGenerationReserveParams & {
    maxTokens?: number | null;
}): LocalWindowReserves;
export declare function countPinnedSystemMessages(messages: ApiMessage[]): number;
/** A user row that is nothing but a compaction summary. */
export declare function isPriorContextSummary(msg: ApiMessage): boolean;
/** A user row the person typed: not a screenshot follow-up, not an injected summary. */
export declare function isRealUserMessage(msg: ApiMessage | null | undefined): boolean;
/** Index of the latest real user row at or after `systemEnd`, or -1. */
export declare function latestRealUserIndex(messages: ApiMessage[], systemEnd?: number): number;
/** Rounds: a user row alone, or an assistant row with its tool results and image follow-ups. */
export declare function partitionRounds(messages: ApiMessage[], systemEnd: number, end?: number): TurnSlice[];
/** Turns: one user row plus every assistant / tool row up to the next user row. */
export declare function partitionTurns(messages: ApiMessage[], systemEnd: number): TurnSlice[];
export declare function rebuildFromTurns(messages: ApiMessage[], systemEnd: number, turns: TurnSlice[]): ApiMessage[];
/** Drop orphaned tool calls / results so every call keeps its result and vice versa. */
export declare function sanitizeToolPairing(messages: ApiMessage[]): ApiMessage[];
/**
 * Drop whole turns oldest-first down to `minRecentTurns`, then fold rounds of the
 * kept turns. The latest real user row and the last round after it always stay.
 * `turns` are the kept slices in order.
 */
export declare function dropOldestTurnsUntilUnderLimit(messages: ApiMessage[], limit: number, systemEnd: number, minRecentTurns: number): {
    turns: TurnSlice[];
    droppedTurns: number;
    droppedRounds: number;
};
export declare function formatContextTrimStatus(policy: ContextEnforcementPolicy, droppedTurns: number, droppedRounds?: number): string;
export declare function applyContextBudget(messages: ApiMessage[], resolved: ResolvedContextBudget, agentConfig?: AgentContextBudgetConfig): ApplyContextBudgetResult;
/** `RunnerDeps.applyContextPolicy` for server runners: sync policies, honors `effectiveLimitOverride`. */
export declare function applyServerContextPolicy(input: {
    messages?: ApiMessage[];
    agentConfig?: AgentContextBudgetConfig;
    modelLimit?: number | null;
    reservedTokens?: number;
    effectiveLimitOverride?: number | null;
} | null | undefined, fallbackConfig?: AgentContextBudgetConfig): ApplyContextBudgetResult;

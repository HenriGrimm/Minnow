import type { ApiMessage } from '../../src/types.js';
import type { ArchiveConfig } from '../../src/chat/archive/types.js';
/** How to fit outbound messages under a token ceiling. */
export type ContextEnforcementPolicy = 'summarize' | 'dropMiddle' | 'slide' | 'truncate' | 'archive';
/** Shipped default when a row omits policy (LLM summarize). */
export declare const DEFAULT_CONTEXT_ENFORCEMENT_POLICY: ContextEnforcementPolicy;
export declare const SAFETY_MARGIN = 0.9;
/** Message-budget sanity floor used by tests; generation is not subtracted from the ceiling. */
export declare const LOCAL_PROMPT_FLOOR_TOKENS = 4096;
/** Least `max_tokens` a local request asks for when n_ctx is known (never 1). */
export declare const LOCAL_MIN_GENERATION_TOKENS = 4096;
/** Prefix injected before compressed prior-turn summaries (LLM or extractive). */
export declare const SUMMARY_HEADER = "## Prior context (compressed)\n";
/** Agent-level budget declaration (work agents + sub-agent types). */
export interface AgentContextBudgetConfig {
    enforcementPolicy: ContextEnforcementPolicy;
    minRecentTurns?: number;
    summaryReserveTokens?: number;
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
    /** Number of logical turns dropped (slide / summarize / dropMiddle). */
    droppedTurns: number;
    summaryInjected: boolean;
    /** Text sent to the model inside the summary user message, if any. */
    summaryText?: string;
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
export declare function partitionTurns(messages: ApiMessage[], systemEnd: number): TurnSlice[];
export declare function rebuildFromTurns(messages: ApiMessage[], systemEnd: number, turns: TurnSlice[]): ApiMessage[];
export declare function collectTurnText(messages: ApiMessage[], turn: TurnSlice): string;
export declare function buildExtractiveSummary(text: string, maxTokens: number): string;
/** Drop oldest turns until under limit; returns dropped turn text chunks. */
export declare function dropOldestTurnsUntilUnderLimit(messages: ApiMessage[], limit: number, systemEnd: number, minRecentTurns: number): {
    turns: TurnSlice[];
    droppedChunks: string[];
    droppedTurns: number;
};
export declare function injectSummaryMessage(messages: ApiMessage[], systemEnd: number, summaryBody: string): ApiMessage[];
export declare function formatContextTrimStatus(policy: ContextEnforcementPolicy, droppedTurns: number, summaryInjected: boolean): string;
export declare function applyContextBudget(messages: ApiMessage[], resolved: ResolvedContextBudget, agentConfig?: AgentContextBudgetConfig): ApplyContextBudgetResult;

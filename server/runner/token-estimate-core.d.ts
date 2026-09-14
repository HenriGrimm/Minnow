/**
 * Pure token estimate helpers (no DOM or compose imports — safe for Node tests).
 */
import type { ApiMessage, Message } from '../../src/types.js';
import type { OpenAIFunctionDefinition } from '../../src/tools/definitions.js';
/** Shared knobs for history estimators that must mirror `buildApiMessages`. */
export interface HistoryEstimateOptions {
    /** Mirrors `BuildApiMessagesOptions.replayPriorReasoning`. */
    replayPriorReasoning?: boolean;
    /** Active model id — some providers reject reasoning replay outright. */
    modelId?: string;
}
/**
 * Content class for {@link estimateTokensFromText}. Chars-per-token is not one
 * number: BPE eats repeated JSON keys and English words, and chokes on paths,
 * hashes, diffs, and terminal output.
 */
export type TokenEstimateKind = 'prose' | 'payload' | 'schema';
/** Chars-per-token divisor for a content class (token → char budgets). */
export declare function charsPerTokenFor(kind: TokenEstimateKind): number;
/** Rough token proxy; calibrated per content class, not model-accurate. */
export declare function estimateTokensFromText(text: string, kind?: TokenEstimateKind): number;
/**
 * Per-image fallback, used only when the intrinsic size cannot be read (a remote
 * URL, or a format we do not parse). Sized for a ~1 MP image.
 */
export declare const ESTIMATE_IMAGE_URL_TOKENS = 1400;
/**
 * Pixels per vision token. Modern VLMs bill images by patch count, so cost
 * scales with area: GPT-4o, Claude and Qwen-VL style patching all land within a
 * few percent of this divisor.
 */
export declare const PIXELS_PER_IMAGE_TOKEN = 750;
/** Intrinsic pixel size of a base64 `data:image/*` URL (PNG, JPEG, GIF, WebP). */
export declare function imageDimensionsFromDataUrl(dataUrl: string): {
    width: number;
    height: number;
} | null;
/**
 * Token cost of one `image_url` part, priced from its real pixel count. A flat
 * per-image constant under-counted an unresized Retina screenshot by well over
 * 10x, which is what let the context wheel read near-empty on a full window.
 */
export declare function estimateImageUrlTokens(dataUrl: string | undefined): number;
/** Summed {@link estimateImageUrlTokens} across every image in a message. */
export declare function estimateImageUrlsTokens(dataUrls: (string | undefined)[]): number;
/**
 * Filler that costs {@link estimateImageUrlsTokens} once run through
 * {@link estimateTokensFromText}. Image parts carry no text to measure, so every
 * estimator prices them by padding the serialized row — and the padding is in
 * *characters*, at the `prose` rate the row itself is measured with.
 */
export declare function imagePaddingForEstimate(dataUrls: (string | undefined)[]): string;
/** User-facing label for a token count. */
export declare function formatTokenEstimateLabel(tokens: number): string;
export declare const TOKEN_ESTIMATE_TOOLTIP = "Approximate size from character counts calibrated per content type. Real prompt tokens depend on the model tokenizer. Excludes pending composer text and attachments.";
/** Settings header tooltip — fixed prompt config only (no chat history). */
export declare const SETTINGS_PROMPT_CONFIG_ESTIMATE_TOOLTIP = "Approximate system prompt, rules, and tools from character counts calibrated per content type. Excludes chat history, pending composer text, and attachments.";
/**
 * Map persisted chat history to API messages for token estimate.
 * Mirrors `buildApiMessages` history rows — assistant `thinking` is UI-only and excluded.
 */
export declare function historyToApiMessagesForEstimate(history: Message[], options?: HistoryEstimateOptions): ApiMessage[];
/** Serialize one history row the same way outbound API messages count payload size. */
export declare function serializeMessageContentForEstimate(m: Message, options?: HistoryEstimateOptions): string;
/**
 * Token estimate for one persisted row, priced per content class: tool results
 * and serialized `tool_calls` are payload, everything the model wrote in prose
 * is prose. Mirrors the row shapes {@link serializeMessageContentForEstimate}
 * builds, including replayed reasoning on plain assistant rows.
 */
export declare function estimateMessageTokens(m: Message, options?: HistoryEstimateOptions): number;
/** Sum token estimate across all persisted chat turns (excludes context notices). */
export declare function estimateHistoryTokens(history: Message[], options?: HistoryEstimateOptions): number;
/** Token estimate for enabled tool JSON schemas. */
export declare function estimateToolsTokens(tools: OpenAIFunctionDefinition[]): number;
export interface OutboundPromptEstimate {
    total: number;
    composedSystem: number;
    userRules: number;
    history: number;
    tools: number;
    legacyFallback: boolean;
    /** Approximate tokens for injected Brain notes (subset of composedSystem). */
    brainNotesSystem?: number;
    /** Resolved on for this estimate (notes may still be loading). */
    brainNotesInjectionEnabled?: boolean;
    /** Approximate tokens for injected code map (subset of composedSystem). */
    codeMapSystem?: number;
    /** Resolved on for this estimate (map may still be loading). */
    codeMapInjectionEnabled?: boolean;
    /** Approximate tokens for injected context documents (subset of composedSystem). */
    contextDocumentsSystem?: number;
    contextDocumentsInjectionEnabled?: boolean;
    /** The next send takes a new trim or compaction checkpoint. */
    historyCompressed?: boolean;
    /** History on the wire differs from the transcript (a checkpoint applies or a trim fires). */
    historyCompacted?: boolean;
    /** Tokens of the compaction summary; `history` excludes them. */
    compressedContextEstimate?: number;
    /** Share of the message ceiling at which the policy fires (compact: high water). */
    trimAtShare?: number;
}
/** System + rules + tools — excludes chat history (settings prompt config display). */
export declare function computePromptConfigTokenTotal(est: Pick<OutboundPromptEstimate, 'composedSystem' | 'userRules' | 'tools'>): number;
/** Pure breakdown from resolved strings. */
export declare function computeOutboundPromptEstimateFromParts(parts: {
    systemText: string;
    history: Message[];
    tools: OpenAIFunctionDefinition[];
    userRulesText?: string;
    legacyFallback?: boolean;
}): OutboundPromptEstimate;

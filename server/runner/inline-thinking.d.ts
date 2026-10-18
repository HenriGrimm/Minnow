/**
 * Inline thinking extraction and stream routing for models that embed reasoning in `content`.
 * Handles think-block stripping, thinking normalization/extraction, and stream routing.
 */
export type RoutedContentPart = readonly [text: string, thinking: boolean];
/** Canonicalize supported thinking wrappers to `<think>` / `</think>` markup. */
export declare function normalizeThinkingMarkup(text: string): string;
/**
 * Batch-split inline thinking from assistant `content`.
 * Only splits when both thinking and reply are non-empty; reasoning-only turns stay intact.
 */
export declare function extractInlineThinkingFromContent(text: string): {
    thinking: string[];
    reply: string;
};
/** Models that may emit inline `<think>` markup or stray closing tags in `content`. */
export declare function modelLikelyUsesInlineThinking(modelId: string): boolean;
/**
 * Stateful stream splitter for `delta.content` when reasoning is embedded in prose/tags.
 * Routes inside `<think>` blocks, repairs stray `</think>` openers, and switches on reasoning prefixes.
 */
export declare class InlineContentThinkingRouter {
    private thinkingModel;
    private firstContentSent;
    private inThinkTag;
    private thinkOpenStripped;
    private inReasoningProse;
    private proseBuffer;
    private openTagBuffer;
    /** Trailing bytes withheld because they may be the start of a think tag. */
    private tagTail;
    /** Set during `flush()` so an incomplete opener is emitted instead of re-buffered. */
    private finalizing;
    /** Latched once a buffered opener is released, so it is never re-buffered. */
    private openTagAbandoned;
    /**
     * Candidate second (or later) think span after visible prose, including its opener.
     * Held until a matching close arrives so a code sample that merely mentions
     * `<think>` is not committed as reasoning.
     */
    private midStreamThinkBuffer;
    constructor(options?: {
        thinkingModel?: boolean;
    });
    feed(text: string): RoutedContentPart[];
    flush(): RoutedContentPart[];
    private drainMidStreamThink;
    private routeChunk;
}
/** Route gpt-oss harmony channels without leaking control tokens into user prose. */
export declare class HarmonyChannelRouter {
    private buffer;
    private seenHarmony;
    private channel;
    private inMessage;
    /** Commentary-channel text (tool-call headers + JSON) for post-stream parsing. */
    private commentaryParseText;
    feed(text: string): RoutedContentPart[];
    flush(): RoutedContentPart[];
    /** Buffered Harmony commentary segments (tool-call payloads). */
    getCommentaryParseText(): string;
    /** Complete recipient name while commentary tool arguments are still arriving. */
    peekStreamingToolName(): string;
    private appendText;
    private handleMarker;
    private drain;
}

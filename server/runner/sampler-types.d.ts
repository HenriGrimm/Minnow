/**
 * Per-agent sampler presets (temperature, nucleus, penalties) for completion bodies.
 */
/** Partial preset; omitted keys inherit from lower merge layers. */
export interface SamplerPreset {
    temperature?: number;
    /** Nucleus sampling; 1 = effectively off. */
    topP?: number;
    /** Top-k cap; omitted when unset (not sent upstream). */
    topK?: number;
    /** Min-p threshold; omitted when unset. */
    minP?: number;
    /** Repeat penalty; 1 = no penalty. */
    repetitionPenalty?: number;
    /**
     * Presence penalty (0–2); 0 = no penalty. Qwen's recommended knob for curbing
     * endless repetitions in non-thinking/instruct mode (~1.5). Omitted when unset.
     */
    presencePenalty?: number;
    /** Sub-agent output cap when set on type defaults or user override. */
    maxTokens?: number;
    /**
     * OpenAI-style stop sequences. Accepts a string or string[] on input;
     * clamp/normalize always stores a trimmed string[] (max 8).
     */
    stop?: string | string[];
}
/** OpenAI-compatible sampler fields merged into a completion body. */
export interface SamplerCompletionFields {
    temperature: number;
    max_tokens: number;
    top_p?: number;
    top_k?: number;
    min_p?: number;
    repetition_penalty?: number;
    presence_penalty?: number;
    stop?: string[];
}
/**
 * Shipped Settings → Sampler maxTokens. Last-ditch when a caller omits
 * `model.sampler` so a missed wrap cannot cap completions at 2048.
 */
export declare const DEFAULT_AGENT_MAX_TOKENS: 131072;
/** Provider-neutral values shown in Settings and omitted from completion bodies. */
export declare const SAMPLER_NEUTRAL: {
    readonly minP: 0;
    readonly repetitionPenalty: 1;
    readonly presencePenalty: 0;
};
/** Field-level merge: later layers override earlier keys when defined. */
export declare function mergeSamplerLayers(...layers: Array<SamplerPreset | null | undefined>): SamplerPreset;
/** Normalize and clamp a partial preset (strips invalid fields). */
export declare function clampSamplerPreset(raw: SamplerPreset | null | undefined): SamplerPreset;
/** Map internal preset to outbound completion JSON keys (omit unset fields). */
export declare function samplerToCompletionFields(preset: SamplerPreset, maxTokens: number): SamplerCompletionFields;
/** Apply sampler fields onto an existing completion body object. */
export declare function applySamplerToBody<T extends Record<string, unknown>>(body: T, preset: SamplerPreset, maxTokens: number): T & SamplerCompletionFields;

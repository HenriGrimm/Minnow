/**
 * Reasoning effort resolution for composer controls and completion send path.
 */
import type { ThinkingResolvedMode } from './thinking-types.js';
import type { ApiKind } from './provider-ids.js';
import type { Chat, ModelCapabilities, ReasoningEffortOption } from '../../src/types.js';
export type { ReasoningEffortOption } from '../../src/types.js';
/** Canonical ordered list for UI option rendering. */
export declare const REASONING_EFFORT_OPTIONS: readonly ReasoningEffortOption[];
/** Composer / send options for Qwen3.8 (`xhigh` is mapped to High). */
export declare const QWEN38_REASONING_OPTIONS: readonly ReasoningEffortOption[];
/**
 * GLM-5.3 family: thinking is always on. Z.ai accepts `low` | `high` | `max` only
 * (no off / medium / xhigh). Default on the wire is `max`.
 */
export declare const GLM53_REASONING_OPTIONS: readonly ReasoningEffortOption[];
/** DeepSeek V4 Chat Completions supports Off, Low, High, and Max. */
export declare const DEEPSEEK_V4_REASONING_OPTIONS: readonly ReasoningEffortOption[];
export declare function isDeepSeekV4ModelId(modelId: string | null | undefined): boolean;
/**
 * Qwen3.8 ids (`qwen3.8` / `qwen3_8`) — not Qwen3-8B (`qwen3-8b`).
 * Used for 262K defaults, wire `xhigh`, and `preserve_thinking`.
 */
export declare function isQwen38ModelId(modelId: string | null | undefined): boolean;
/**
 * GLM-5.3 / GLM-5.3-Flash ids (`glm-5.3`, `z-ai/glm-5.3-flash`, GGUF names).
 * Does not match GLM-4.x, GLM-5, GLM-5.1, or GLM-5.2.
 */
export declare function isGlm53ModelId(modelId: string | null | undefined): boolean;
/** True when `value` is a composer effort level (not off/on). */
export declare function isComposerReasoningLevel(value: unknown): value is ReasoningEffortOption;
/**
 * Map catalog aliases onto composer options.
 * Qwen `xhigh` -> High; GLM-5.3 `xhigh` / `extra_high` -> Max; `none` -> Off.
 */
export declare function normalizeReasoningCatalogValue(value: unknown, modelId?: string | null): ReasoningEffortOption | undefined;
/** Type guard for upstream catalog / session values. */
export declare function isReasoningEffortOption(value: unknown): value is ReasoningEffortOption;
/** Filter and validate upstream `allowed_options`; preserve canonical order. */
export declare function normalizeReasoningAllowedOptions(raw: unknown[], modelId?: string | null): ReasoningEffortOption[];
/** True when the header reasoning effort dropdown should be shown. */
export declare function modelHasSelectableReasoningEffort(caps?: ModelCapabilities | null): boolean;
/** True when allowed options include low / medium / high / max effort levels. */
export declare function modelHasReasoningEffortLevels(caps?: ModelCapabilities | null): boolean;
/**
 * Composer shows a level dropdown (not the brain toggle) when effort levels are available.
 */
export declare function modelUsesComposerReasoningDropdown(caps?: ModelCapabilities | null): boolean;
/** Composer shows the brain on/off toggle when model offers off/on without level options. */
export declare function modelUsesComposerThinkingToggle(caps?: ModelCapabilities | null): boolean;
/**
 * True when thinking cannot be turned off (GLM-5.3: Low / High / Max, no Off).
 * Driven by the forced catalog, not a leftover off/on probe row.
 */
export declare function modelUsesAlwaysOnReasoning(caps?: ModelCapabilities | null): boolean;
/** True when the composer brain icon should be shown (level dropdown and/or off/on models). */
export declare function modelShowsComposerBrainToggle(caps?: ModelCapabilities | null): boolean;
/** Level options for the composer effort dropdown (excludes off/on). */
export declare function getComposerReasoningLevelOptions(allowed: ReasoningEffortOption[]): ReasoningEffortOption[];
/** Off/on options for models that use thinking.type instead of reasoning_effort levels. */
export declare function getComposerReasoningBinaryOptions(allowed: ReasoningEffortOption[]): ReasoningEffortOption[];
/** Composer shows low/medium/high select beside the brain toggle. */
export declare function modelUsesComposerReasoningLevelDropdown(caps?: ModelCapabilities | null): boolean;
/** Binary off/on models use the brain tri-state toggle only (no separate Off/On select). */
export declare function modelUsesComposerReasoningBinaryDropdown(_caps?: ModelCapabilities | null): boolean;
/** Default level when turning reasoning back on from the composer brain toggle. */
export declare function defaultComposerReasoningLevel(caps?: ModelCapabilities | null): ReasoningEffortOption | undefined;
/** Human-readable label for composer `<select>` options. */
export declare function formatReasoningEffortLabel(option: ReasoningEffortOption): string;
/**
 * Fallback allowed options when catalog lacks reasoning metadata.
 * Qwen3.8 always gets levels (any provider). Other models only infer on openai-v1.
 *
 * Bare `{ id }` catalogs (llama.cpp, mlx_lm.server, MTPLX) carry no reasoning block,
 * so this is the *only* signal for every model they serve. Levels stay the default
 * here deliberately: narrowing it to an id allowlist of effort-trained families hid
 * the dropdown on MTPLX models whose ids the list did not anticipate, and hiding a
 * control the model can use is a worse failure than showing one it ignores. An
 * effort the model was not trained on is inert, not harmful. A catalog
 * `allowed_options` block always wins over this inference.
 */
export declare function inferReasoningOptionsFromModelId(modelId: string, apiKind?: ApiKind): ReasoningEffortOption[];
/**
 * Qwen3.8 always offers Low/Medium/High even when LM Studio advertises off/on
 * or My Models rows have no catalog reasoning block.
 */
export declare function ensureQwen38ReasoningAllowedOptions(modelId: string | null | undefined, allowed: ReasoningEffortOption[]): ReasoningEffortOption[];
/**
 * GLM-5.3 always offers Low/High/Max. Catalog off/on or low/medium/high rows
 * still 400 on Z.ai, so this replacement always wins.
 */
export declare function ensureGlm53ReasoningAllowedOptions(modelId: string | null | undefined, allowed: ReasoningEffortOption[]): ReasoningEffortOption[];
/** Upgrade stale Off/On catalog rows for DeepSeek V4 while retaining explicit levels. */
export declare function ensureDeepSeekV4ReasoningAllowedOptions(modelId: string | null | undefined, allowed: ReasoningEffortOption[]): ReasoningEffortOption[];
/**
 * Merge chat override, inherited thinking mode, catalog default, and fallbacks into one effort.
 * Resolution order: chat override → inherited on → catalog default → inherited off → first allowed.
 */
export declare function resolveEffectiveReasoningEffort(chat: Pick<Chat, 'reasoningEffort'>, caps: ModelCapabilities | null | undefined, inheritedResolved: ThinkingResolvedMode): ReasoningEffortOption | undefined;

/**
 * Shared sampler preset normalization for work-agents and sub-agents APIs.
 */

import { DEFAULT_AGENT_MAX_TOKENS } from '../runner/sampler-types.js';

const TEMP_MIN = 0;
const TEMP_MAX = 2;
const TOP_P_MIN = 0;
const TOP_P_MAX = 1;
const MIN_P_MIN = 0;
const MIN_P_MAX = 1;
const REP_MIN = 1;
const REP_MAX = 2;
const PRESENCE_MIN = 0;
const PRESENCE_MAX = 2;
const TOP_K_MIN = 1;
const TOP_K_MAX = 200;
const MAX_TOKENS_MIN = 1;
const MAX_TOKENS_MAX = 131072;
/** Same cap Anthropic mapping uses — enough for chat, not a dump of the prompt. */
const MAX_STOP_SEQUENCES = 8;

function clampTemperature(value) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return undefined;
  return Math.min(TEMP_MAX, Math.max(TEMP_MIN, n));
}

function clampTopP(value) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return undefined;
  return Math.min(TOP_P_MAX, Math.max(TOP_P_MIN, n));
}

function clampTopK(value) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n < TOP_K_MIN) return undefined;
  return Math.min(TOP_K_MAX, Math.floor(n));
}

function clampMinP(value) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.min(MIN_P_MAX, Math.max(MIN_P_MIN, n));
}

function clampRepetitionPenalty(value) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n < REP_MIN) return undefined;
  return Math.min(REP_MAX, n);
}

function clampPresencePenalty(value) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n < PRESENCE_MIN) return undefined;
  return Math.min(PRESENCE_MAX, n);
}

function clampMaxTokens(value) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n < MAX_TOKENS_MIN) return undefined;
  return Math.min(MAX_TOKENS_MAX, Math.floor(n));
}

/**
 * Accept a string or string[], trim, drop empties, cap at 8.
 * Why 8: Anthropic's stop_sequences mapping uses the same ceiling.
 * @param {unknown} value
 * @returns {string[] | undefined}
 */
function clampStopSequences(value) {
  const raw = typeof value === 'string' ? [value] : Array.isArray(value) ? value : null;
  if (!raw) return undefined;
  const out = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed) continue;
    out.push(trimmed);
    if (out.length >= MAX_STOP_SEQUENCES) break;
  }
  return out.length > 0 ? out : undefined;
}

/**
 * @param {unknown} raw
 * @returns {Record<string, unknown>|null}
 */
export function normalizeSamplerPreset(raw) {
  if (raw === null) return null;
  if (!raw || typeof raw !== 'object') return null;

  const src = /** @type {Record<string, unknown>} */ (raw);
  const out = {};

  if ('temperature' in src) {
    const v = clampTemperature(src.temperature);
    if (v !== undefined) out.temperature = v;
  }
  if ('topP' in src) {
    const v = clampTopP(src.topP);
    if (v !== undefined) out.topP = v;
  }
  if ('topK' in src) {
    const v = clampTopK(src.topK);
    if (v !== undefined) out.topK = v;
  }
  if ('minP' in src) {
    const v = clampMinP(src.minP);
    if (v !== undefined) out.minP = v;
  }
  if ('repetitionPenalty' in src) {
    const v = clampRepetitionPenalty(src.repetitionPenalty);
    if (v !== undefined) out.repetitionPenalty = v;
  }
  if ('presencePenalty' in src) {
    const v = clampPresencePenalty(src.presencePenalty);
    if (v !== undefined) out.presencePenalty = v;
  }
  if ('maxTokens' in src) {
    const v = clampMaxTokens(src.maxTokens);
    if (v !== undefined) out.maxTokens = v;
  }
  if ('stop' in src) {
    const v = clampStopSequences(src.stop);
    if (v !== undefined) out.stop = v;
  }

  return Object.keys(out).length > 0 ? out : {};
}

/**
 * Wrap a flat sampler row as `{ preset, maxTokens }` for `runTurn`.
 * `runTurn` substitutes this object for `deps.resolveSamplerPreset`; a flat
 * `{ temperature, topP }` row would make `applySamplerToBody` read `.preset`
 * on undefined.
 *
 * Rows that omit `maxTokens` inherit `fallbackMaxTokens` (Settings global),
 * not the old 2048 sub-agent cap.
 *
 * @param {unknown} raw
 * @param {number} [fallbackMaxTokens]
 * @returns {{ preset: Record<string, unknown>, maxTokens: number }}
 */
export function wrapSamplerForTurn(raw, fallbackMaxTokens) {
  const fallback =
    typeof fallbackMaxTokens === 'number' &&
    Number.isFinite(fallbackMaxTokens) &&
    fallbackMaxTokens >= MAX_TOKENS_MIN
      ? Math.min(MAX_TOKENS_MAX, Math.floor(fallbackMaxTokens))
      : DEFAULT_AGENT_MAX_TOKENS;
  if (!raw || typeof raw !== 'object') {
    return { preset: {}, maxTokens: fallback };
  }
  const src = /** @type {Record<string, unknown>} */ (raw);
  const explicit = clampMaxTokens(src.maxTokens);
  const { maxTokens: _drop, ...rest } = src;
  return { preset: rest, maxTokens: explicit ?? fallback };
}

/**
 * Settings → Sampler from `config.json`, shaped for `runTurn`.
 * Dynamic-import store so this module does not cycle through validators.
 *
 * @returns {Promise<{ preset: Record<string, unknown>, maxTokens: number }>}
 */
export async function readGlobalSamplerForTurn() {
  try {
    const { readResource } = await import('../config/store.js');
    const meta = await readResource('meta');
    const block = meta && typeof meta === 'object' ? /** @type {Record<string, unknown>} */ (meta) : null;
    const sampler =
      block?.sampler && typeof block.sampler === 'object' ? block.sampler : null;
    return wrapSamplerForTurn(sampler, DEFAULT_AGENT_MAX_TOKENS);
  } catch {
    return wrapSamplerForTurn(null, DEFAULT_AGENT_MAX_TOKENS);
  }
}

export { DEFAULT_AGENT_MAX_TOKENS };

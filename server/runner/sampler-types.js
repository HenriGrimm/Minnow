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
const MAX_STOP_SEQUENCES = 8;
/**
 * Shipped Settings → Sampler maxTokens (`config.json` / `DEFAULT_SAMPLER_GLOBAL`).
 * Safety net when a caller omits `model.sampler` so main-chat-equivalent turns
 * cannot silently cap every provider at 2048 (`finish_reason: length`).
 */
const DEFAULT_AGENT_MAX_TOKENS = 131072;
const SAMPLER_NEUTRAL = {
  minP: 0,
  repetitionPenalty: 1,
  presencePenalty: 0
};
function mergeSamplerLayers(...layers) {
  const out = {};
  for (const layer of layers) {
    if (!layer) continue;
    if (layer.temperature !== void 0) out.temperature = layer.temperature;
    if (layer.topP !== void 0) out.topP = layer.topP;
    if (layer.topK !== void 0) out.topK = layer.topK;
    if (layer.minP !== void 0) out.minP = layer.minP;
    if (layer.repetitionPenalty !== void 0) {
      out.repetitionPenalty = layer.repetitionPenalty;
    }
    if (layer.presencePenalty !== void 0) {
      out.presencePenalty = layer.presencePenalty;
    }
    if (layer.maxTokens !== void 0) out.maxTokens = layer.maxTokens;
    if (layer.stop !== void 0) out.stop = layer.stop;
  }
  return out;
}
function clampTemperature(value) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return void 0;
  return Math.min(TEMP_MAX, Math.max(TEMP_MIN, n));
}
function clampTopP(value) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return void 0;
  return Math.min(TOP_P_MAX, Math.max(TOP_P_MIN, n));
}
function clampTopK(value) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < TOP_K_MIN) return void 0;
  return Math.min(TOP_K_MAX, Math.floor(n));
}
function clampMinP(value) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return void 0;
  return Math.min(MIN_P_MAX, Math.max(MIN_P_MIN, n));
}
function clampRepetitionPenalty(value) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < REP_MIN) return void 0;
  return Math.min(REP_MAX, n);
}
function clampPresencePenalty(value) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < PRESENCE_MIN) return void 0;
  return Math.min(PRESENCE_MAX, n);
}
function clampMaxTokens(value) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < MAX_TOKENS_MIN) return void 0;
  return Math.min(MAX_TOKENS_MAX, Math.floor(n));
}
function clampStopSequences(value) {
  const raw = typeof value === "string" ? [value] : Array.isArray(value) ? value : null;
  if (!raw) return void 0;
  const out = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (!trimmed) continue;
    out.push(trimmed);
    if (out.length >= MAX_STOP_SEQUENCES) break;
  }
  return out.length > 0 ? out : void 0;
}
function clampSamplerPreset(raw) {
  if (!raw || typeof raw !== "object") return {};
  const out = {};
  const temperature = clampTemperature(raw.temperature);
  if (temperature !== void 0) out.temperature = temperature;
  const topP = clampTopP(raw.topP);
  if (topP !== void 0) out.topP = topP;
  const topK = clampTopK(raw.topK);
  if (topK !== void 0) out.topK = topK;
  const minP = clampMinP(raw.minP);
  if (minP !== void 0) out.minP = minP;
  const repetitionPenalty = clampRepetitionPenalty(raw.repetitionPenalty);
  if (repetitionPenalty !== void 0) out.repetitionPenalty = repetitionPenalty;
  const presencePenalty = clampPresencePenalty(raw.presencePenalty);
  if (presencePenalty !== void 0) out.presencePenalty = presencePenalty;
  const maxTokens = clampMaxTokens(raw.maxTokens);
  if (maxTokens !== void 0) out.maxTokens = maxTokens;
  const stop = clampStopSequences(raw.stop);
  if (stop !== void 0) out.stop = stop;
  return out;
}
function samplerToCompletionFields(preset, maxTokens) {
  const temperature = preset.temperature !== void 0 && Number.isFinite(preset.temperature) ? preset.temperature : 0.7;
  const fields = {
    temperature,
    max_tokens: maxTokens
  };
  if (preset.topP !== void 0) fields.top_p = preset.topP;
  if (preset.topK !== void 0) fields.top_k = preset.topK;
  if (preset.minP !== void 0 && preset.minP > SAMPLER_NEUTRAL.minP) {
    fields.min_p = preset.minP;
  }
  if (preset.repetitionPenalty !== void 0 && preset.repetitionPenalty !== SAMPLER_NEUTRAL.repetitionPenalty) {
    fields.repetition_penalty = preset.repetitionPenalty;
  }
  if (preset.presencePenalty !== void 0 && preset.presencePenalty !== SAMPLER_NEUTRAL.presencePenalty) {
    fields.presence_penalty = preset.presencePenalty;
  }
  if (Array.isArray(preset.stop) && preset.stop.length > 0) {
    fields.stop = preset.stop;
  }
  return fields;
}
function applySamplerToBody(body, preset, maxTokens) {
  const mapped = samplerToCompletionFields(preset, maxTokens);
  const out = { ...body, ...mapped };
  // Ask OpenAI-compatible servers for a final usage block on streamed turns.
  if (out.stream === true) {
    const existing =
      out.stream_options && typeof out.stream_options === 'object' ? out.stream_options : {};
    out.stream_options = {
      ...existing,
      include_usage: existing.include_usage ?? true,
    };
  }
  return out;
}
export {
  DEFAULT_AGENT_MAX_TOKENS,
  SAMPLER_NEUTRAL,
  applySamplerToBody,
  clampSamplerPreset,
  mergeSamplerLayers,
  samplerToCompletionFields
};

import { normalizeExtraArgs } from '../../src/models/argv-tokenize.mjs';

export const MTPLX_SETTING_ENUMS = {
  profile: ['auto', 'sustained', 'turbo', 'performance-cold'],
  generation_mode: ['mtp', 'ar', 'auto'], paged_kv_quantization: ['off', 'q8', 'q4'],
  reasoning: ['auto', 'on', 'off'], reasoning_effort: ['auto', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh'],
  preserve_thinking: ['auto', 'on', 'off', 'scoped'], tool_prompt_mode: ['hybrid', 'native'],
  reasoning_parser: ['qwen3', 'step3p5', 'gemma4', 'poolside_v1', 'none'],
  scheduler_mode: ['serial', 'ar_batch', 'mtp_batch'], batching_preset: ['solo', 'latency', 'agent', 'throughput'],
  ssd_session_cache: ['off', 'on', 'write-only'], fan_mode: ['default', 'smart', 'max'],
};
const numbers = {
  depth: [1, 64, true], context_window: [1, 1048576, true], max_tokens: [1, 1048576, true],
  max_active_requests: [1, 1024, true], prefill_chunk_tokens: [1, 1048576, true], stream_interval: [1, 65536, true],
  ssd_session_cache_min_prefix_tokens: [1, 1048576, true], warmup_tokens: [0, 1048576, true],
  stream_stall_deadline_s: [0, 86400], rate_limit: [0, 1000000, true], idle_ttl_ms: [0, Number.MAX_SAFE_INTEGER, true],
  default_temperature: [0, 10], default_top_p: [0, 1], default_top_k: [0, 1000000, true],
  default_presence_penalty: [-2, 2], default_frequency_penalty: [-2, 2],
  draft_temperature: [0, 10], draft_top_p: [0, 1], draft_top_k: [0, 1000000, true],
};
const texts = ['ssd_session_cache_max_size', 'ngram_prewarm', 'model_id', 'cache_dir'];
const booleans = ['enable_thermal_poll', 'allow_swap'];
export const MTPLX_LAUNCH_SETTING_KEYS = [...Object.keys(MTPLX_SETTING_ENUMS), ...Object.keys(numbers), ...texts, ...booleans, 'extra_args', 'env'];

export function normalizeMtplxSettings(raw, descriptor, warnings = []) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const [key, choices] of Object.entries(MTPLX_SETTING_ENUMS)) {
    const allowed = key === 'paged_kv_quantization' ? descriptor?.kvQuant?.modes ?? choices
      : key === 'reasoning' ? descriptor?.reasoning?.modes ?? choices
      : key === 'reasoning_effort' ? ['auto', ...(descriptor?.reasoning?.effortLevels ?? choices)] : choices;
    if (typeof raw[key] !== 'string') continue;
    if (allowed.includes(raw[key])) out[key] = raw[key];
    else if (key === 'paged_kv_quantization') {
      out[key] = allowed[0] ?? 'off'; warnings.push(`${key} changed to ${out[key]} for this model.`);
    }
  }
  for (const [key, [min, max, integer]] of Object.entries(numbers)) {
    if (typeof raw[key] !== 'number' || !Number.isFinite(raw[key])) continue;
    const bound = key === 'depth' ? descriptor?.draft : key === 'context_window' ? descriptor?.contextWindow : null;
    const lo = bound?.minimum ?? min, hi = bound?.maximum ?? max, step = bound?.step ?? 1;
    let value = Math.max(lo, Math.min(hi, raw[key]));
    if (integer) value = Math.trunc(value);
    if (bound?.step) value = lo + Math.min(Math.floor((hi - lo) / step), Math.round((value - lo) / step)) * step;
    out[key] = value;
    if (value !== raw[key]) warnings.push(`${key} clamped from ${raw[key]} to ${value} for this model.`);
  }
  for (const key of texts) if (typeof raw[key] === 'string' && !raw[key].includes('\0')) out[key] = raw[key].trim();
  for (const key of booleans) if (typeof raw[key] === 'boolean') out[key] = raw[key];
  if (raw.extra_args != null) out.extra_args = normalizeExtraArgs(raw.extra_args);
  if (raw.env && typeof raw.env === 'object' && !Array.isArray(raw.env)) {
    out.env = Object.fromEntries(Object.entries(raw.env).filter(([key, value]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && typeof value === 'string' && !value.includes('\0')));
  }
  return out;
}

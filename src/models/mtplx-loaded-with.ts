import type { MtplxServeSettings } from './mtplx-settings';
import type { LoadedWithRow } from './mlx-loaded-with';

const LABELS: Record<keyof MtplxServeSettings, string> = {
  profile: 'Performance profile', generation_mode: 'Generation mode', depth: 'Draft depth',
  context_window: 'Context window', max_tokens: 'Output limit', paged_kv_quantization: 'KV cache',
  reasoning: 'Reasoning', reasoning_effort: 'Reasoning effort', reasoning_parser: 'Reasoning parser',
  preserve_thinking: 'Keep reasoning', tool_prompt_mode: 'Tool prompts', scheduler_mode: 'Scheduler',
  batching_preset: 'Batching preset', max_active_requests: 'Concurrent requests',
  prefill_chunk_tokens: 'Prompt chunk size', stream_interval: 'Stream interval',
  ssd_session_cache: 'SSD session cache', ssd_session_cache_max_size: 'SSD cache limit',
  ssd_session_cache_min_prefix_tokens: 'Minimum cached prefix', ngram_prewarm: 'N-gram warmup',
  default_temperature: 'Temperature', default_top_p: 'Top P', default_top_k: 'Top K',
  default_presence_penalty: 'Presence penalty', default_frequency_penalty: 'Frequency penalty',
  draft_temperature: 'Draft temperature', draft_top_p: 'Draft top P', draft_top_k: 'Draft top K',
  fan_mode: 'Fan mode', enable_thermal_poll: 'Thermal monitoring', warmup_tokens: 'Warmup tokens',
  stream_stall_deadline_s: 'Stream timeout', allow_swap: 'Allow swap', rate_limit: 'Rate limit',
  model_id: 'Model identifier', cache_dir: 'Cache folder', idle_ttl_ms: 'Unload when idle',
  extra_args: 'Extra arguments', env: 'Environment variables',
};

const MODE_LABELS: Record<string, string> = {
  auto: 'Automatic', on: 'On', off: 'Off', mtp: 'Multi-token prediction', ar: 'Autoregressive',
  ar_batch: 'Autoregressive batching', mtp_batch: 'MTP batching',
  'performance-cold': 'Performance (cold)', 'write-only': 'Write only',
  q8: '8-bit', q4: '4-bit',
};

/** Readable facts from the actual MTPLX launch, without exposing environment values. */
export function mtplxLoadedWithRows(settings: MtplxServeSettings | null | undefined): LoadedWithRow[] {
  if (!settings) return [];
  const rows: LoadedWithRow[] = [];
  for (const key of Object.keys(LABELS) as Array<keyof MtplxServeSettings>) {
    const raw = settings[key];
    if (raw == null || raw === '') continue;
    let value: string;
    if (key === 'env') {
      const count = Object.keys(raw).length;
      if (!count) continue;
      value = `${count} configured`;
    } else if (Array.isArray(raw)) {
      if (!raw.length) continue;
      value = raw.join(' ');
    } else if (typeof raw === 'boolean') {
      value = raw ? 'On' : 'Off';
    } else if (typeof raw === 'number') {
      if (key === 'idle_ttl_ms') value = raw === 0 ? 'Never' : `${raw / 60_000} minutes`;
      else if (key === 'stream_stall_deadline_s') value = `${raw} seconds`;
      else value = raw.toLocaleString('en-US');
      if (['context_window', 'max_tokens', 'prefill_chunk_tokens', 'ssd_session_cache_min_prefix_tokens', 'warmup_tokens'].includes(key)) value += ' tokens';
    } else {
      value = MODE_LABELS[String(raw)] ?? String(raw);
    }
    rows.push({ label: LABELS[key], value });
  }
  return rows;
}

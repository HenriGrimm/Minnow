import type { MtplxServeSettings } from './mtplx-settings';
import type { LoadedWithRow } from './mlx-loaded-with';

// Titles match the MTPLX app's Settings tab and Inference popover.
const LABELS: Record<keyof MtplxServeSettings, string> = {
  profile: 'Profile', generation_mode: 'Generation mode', load_mtp: 'Load MTP head', depth: 'Depth',
  adaptive_depth: 'Adaptive depth', context_window: 'Context window', max_tokens: 'Output limit',
  paged_kv_quantization: 'KV quantization', memory_limit_gb: 'Memory limit', allow_swap: 'Allow swap',
  reasoning: 'Reasoning', reasoning_effort: 'Reasoning effort', reasoning_parser: 'Reasoning parser',
  preserve_thinking: 'Preserve thinking', tool_prompt_mode: 'Tool prompts', scheduling_preset: 'Mode',
  scheduler_mode: 'Scheduler', batching_preset: 'Batching preset', max_active_requests: 'Concurrency cap',
  experimental_mtp_cohorts: 'Experimental MTP cohorts', decode_batch_max: 'Decode batch max',
  batch_wait_ms: 'Admission window', prefill_chunk_tokens: 'Batch step size', stream_interval: 'Stream interval',
  ssd_session_cache: 'SSD cache policy', ssd_session_cache_max_size: 'SSD cache max size',
  ssd_session_cache_min_prefix_tokens: 'Save prompts ≥', ngram_prewarm: 'N-gram prewarm',
  default_temperature: 'Temperature', default_top_p: 'Top P', default_top_k: 'Top K',
  default_presence_penalty: 'Presence Penalty', default_frequency_penalty: 'Frequency Penalty',
  draft_temperature: 'Draft temperature', draft_top_p: 'Draft top P', draft_top_k: 'Draft top K',
  fan_mode: 'Fan Mode', enable_thermal_poll: 'Thermal polling', warmup_tokens: 'Warmup tokens',
  stream_stall_deadline_s: 'Stall watchdog', rate_limit: 'Rate limit',
  model_id: 'Model identifier', cache_dir: 'Cache folder', idle_ttl_ms: 'Unload when idle',
  extra_args: 'Extra arguments', env: 'Environment variables',
};

const MODE_LABELS: Record<string, string> = {
  auto: 'Auto', on: 'On', off: 'Off', mtp: 'MTP', ar: 'Baseline',
  ar_batch: 'Autoregressive batching', mtp_batch: 'MTP batching',
  turbo: 'Turbo', sustained: 'Sustained', 'performance-cold': 'Performance Cold (Burst)', 'write-only': 'Write-only',
  default: 'Default', smart: 'Smart', max: 'Max', q8: 'q8', q4: 'q4',
};
const SCHEDULING_LABELS: Record<string, string> = {
  auto: 'Auto', latency: 'Fastest response', throughput: 'Handle multiple at once', agent: 'Long agent tasks',
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
      else if (key === 'batch_wait_ms') value = `${raw} ms`;
      else if (key === 'memory_limit_gb') value = `${raw} GB`;
      else value = raw.toLocaleString('en-US');
      if (['context_window', 'max_tokens', 'prefill_chunk_tokens', 'ssd_session_cache_min_prefix_tokens', 'warmup_tokens'].includes(key)) value += ' tokens';
    } else {
      value = (key === 'scheduling_preset' ? SCHEDULING_LABELS : MODE_LABELS)[String(raw)] ?? String(raw);
    }
    rows.push({ label: LABELS[key], value });
  }
  return rows;
}

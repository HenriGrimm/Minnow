export interface MtplxServeSettings {
  profile?: 'auto' | 'sustained' | 'turbo' | 'performance-cold';
  generation_mode?: 'mtp' | 'ar' | 'auto';
  depth?: number;
  context_window?: number;
  max_tokens?: number;
  paged_kv_quantization?: 'off' | 'q8' | 'q4';
  reasoning?: 'auto' | 'on' | 'off';
  reasoning_effort?: string;
  reasoning_parser?: string;
  preserve_thinking?: 'auto' | 'on' | 'off' | 'scoped';
  tool_prompt_mode?: 'hybrid' | 'native';
  scheduler_mode?: 'serial' | 'ar_batch' | 'mtp_batch';
  batching_preset?: 'solo' | 'latency' | 'agent' | 'throughput';
  max_active_requests?: number;
  prefill_chunk_tokens?: number;
  stream_interval?: number;
  ssd_session_cache?: 'off' | 'on' | 'write-only';
  ssd_session_cache_max_size?: string;
  ssd_session_cache_min_prefix_tokens?: number;
  ngram_prewarm?: string;
  default_temperature?: number;
  default_top_p?: number;
  default_top_k?: number;
  default_presence_penalty?: number;
  default_frequency_penalty?: number;
  draft_temperature?: number;
  draft_top_p?: number;
  draft_top_k?: number;
  fan_mode?: 'default' | 'smart' | 'max';
  enable_thermal_poll?: boolean;
  warmup_tokens?: number;
  stream_stall_deadline_s?: number;
  allow_swap?: boolean;
  rate_limit?: number;
  model_id?: string;
  cache_dir?: string;
  idle_ttl_ms?: number;
  extra_args?: string[] | string;
  env?: Record<string, string>;
}

export interface MtplxModelDescriptor {
  modelPath: string;
  canRun: boolean;
  mtpSupported: boolean;
  recommendedProfile: string | null;
  source: 'inspect' | 'health' | 'fallback';
  fetchedAt: number;
  draft: { supported: boolean; minimum: number; maximum: number; default: number; valueLabels: string[] };
  contextWindow: { supported: boolean; minimum: number; maximum: number; default: number; step: number };
  kvQuant: { supported: boolean; modes: string[]; restartRequired: boolean };
  reasoning: { supported: boolean; parser: string; modes: string[]; defaultMode: string; effortLevels: string[]; defaultEffort: string | null } | null;
  sampling: { temperature: number; top_p: number; top_k: number } | null;
}

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getMinnowHome } from '../config/home.js';
import { fallbackMtplxDescriptor } from './mtplx-descriptor.js';
import { normalizeMtplxSettings } from './mtplx-settings.js';
import { SERVE_IDLE_TTL_MS } from './admit-serve.js';

export async function readMtplxConfig() {
  try {
    const raw = JSON.parse(await fsp.readFile(path.join(getMinnowHome(), 'mtplx.json'), 'utf8'));
    return normalizeMtplxSettings(raw.defaults ?? raw);
  }
  catch { return {}; }
}
export function extraHasFlag(extra, flag) { return extra.some((arg) => arg === flag || arg.startsWith(`${flag}=`)); }
/** MTPLX app Performance › Mode choices, as the scheduler and batching flags each one launches with. */
export const MTPLX_SCHEDULING_PRESETS = {
  latency: { scheduler_mode: 'serial', batching_preset: 'latency' },
  throughput: { scheduler_mode: 'ar_batch', batching_preset: 'throughput' },
  agent: { scheduler_mode: 'ar_batch', batching_preset: 'agent' },
};
/** Engine batching presets (`mtplx/batching/state.py`): what Concurrency cap, Decode batch max and Admission window fall back to. */
export const MTPLX_BATCHING_DEFAULTS = {
  solo: { max_active_requests: 1, decode_batch_max: 1, batch_wait_ms: 0 },
  latency: { max_active_requests: 1, decode_batch_max: 1, batch_wait_ms: 0 },
  agent: { max_active_requests: 4, decode_batch_max: 4, batch_wait_ms: 50 },
  throughput: { max_active_requests: 8, decode_batch_max: 8, batch_wait_ms: 20 },
};
/** Settings that are not `--key value` flags; each is translated below. */
const LAUNCH_ONLY_KEYS = ['extra_args', 'env', 'idle_ttl_ms', 'scheduling_preset', 'memory_limit_gb', 'load_mtp', 'adaptive_depth'];
function translatedFlags(settings, extra) {
  const args = [];
  if (settings.memory_limit_gb != null && !extraHasFlag(extra, '--memory-limit')) args.push('--memory-limit', `${settings.memory_limit_gb}G`);
  if (settings.load_mtp === false && !extraHasFlag(extra, '--load-mtp') && !extraHasFlag(extra, '--no-load-mtp')) args.push('--no-load-mtp');
  // The engine picks a depth policy per model family; only an explicit choice is passed.
  if (typeof settings.adaptive_depth === 'boolean' && !extraHasFlag(extra, '--adaptive-policy')) {
    args.push('--adaptive-policy', settings.adaptive_depth ? 'expected_value' : 'none');
  }
  return args;
}
function resolveSettings(descriptor, defaults, saved, settings, warnings = []) {
  return normalizeMtplxSettings({
    ...(descriptor.draft?.supported ? { depth: descriptor.draft.default } : {}),
    ...(descriptor.contextWindow?.supported ? { context_window: descriptor.contextWindow.default } : {}),
    ...(descriptor.recommendedProfile ? { profile: descriptor.recommendedProfile } : {}),
    ...(descriptor.reasoning?.supported ? { reasoning: descriptor.reasoning.defaultMode,
      reasoning_effort: descriptor.reasoning.defaultEffort, reasoning_parser: descriptor.reasoning.parser } : {}),
    ...(descriptor.sampling ? { default_temperature: descriptor.sampling.temperature, default_top_p: descriptor.sampling.top_p, default_top_k: descriptor.sampling.top_k } : {}),
    ...defaults, ...saved, ...settings,
  }, descriptor, warnings);
}

/** Display-only MTPLX 2.12 defaults; automatic policies are not launch arguments. */
export function getMtplxLoadDefaults(descriptor, defaults = {}) {
  const settings = resolveSettings(descriptor, defaults);
  Object.assign(settings, MTPLX_SCHEDULING_PRESETS[settings.scheduling_preset]);
  const batching = MTPLX_BATCHING_DEFAULTS[settings.batching_preset] ?? MTPLX_BATCHING_DEFAULTS.latency;
  const values = {
    profile: 'Automatic model profile', generation_mode: 'Model recommendation (MTP fallback)',
    paged_kv_quantization: 'off', reasoning: 'auto', reasoning_effort: 'Model default (resolved at load)',
    reasoning_parser: 'Model parser (detected at load)', preserve_thinking: 'auto (model history policy)',
    tool_prompt_mode: 'hybrid (unless model requires native)', scheduler_mode: 'serial', batching_preset: 'latency',
    ssd_session_cache: 'on', fan_mode: 'default (system managed)',
    max_tokens: 'Model response limit (resolved at load)',
    scheduling_preset: 'auto', ...batching, experimental_mtp_cohorts: false,
    prefill_chunk_tokens: 'Automatic for model and batching preset',
    stream_interval: 1, ssd_session_cache_max_size: 'auto (based on RAM and free disk)',
    ssd_session_cache_min_prefix_tokens: 512, ngram_prewarm: 'auto (available memory)',
    default_temperature: 'Model sampler (0.6 fallback)', default_top_p: 'Model sampler (0.95 fallback)', default_top_k: 'Model sampler (20 fallback)',
    default_presence_penalty: 0, default_frequency_penalty: 0,
    enable_thermal_poll: false, warmup_tokens: 16,
    stream_stall_deadline_s: '300 (or MTPLX_STREAM_STALL_DEADLINE_S)',
    allow_swap: 'off (or MTPLX_ALLOW_SWAP)', rate_limit: 0,
    memory_limit_gb: "Engine plan (about 75% of this Mac's memory)", load_mtp: true,
    adaptive_depth: 'Model family policy',
    model_id: 'Loaded model identity', cache_dir: '~/.mtplx/models', idle_ttl_ms: SERVE_IDLE_TTL_MS,
  };
  for (const [key, value] of Object.entries(settings)) {
    if (['string', 'number', 'boolean'].includes(typeof value)) values[key] = value;
  }
  for (const key of Object.keys(values)) {
    const flag = `--${key.replaceAll('_', '-')}`;
    if (extraHasFlag(settings.extra_args ?? [], flag) || extraHasFlag(settings.extra_args ?? [], `--no-${key.replaceAll('_', '-')}`)) {
      values[key] = 'Overridden by configured extra arguments';
    }
  }
  for (const [draft, target] of [['draft_temperature', 'default_temperature'], ['draft_top_p', 'default_top_p'], ['draft_top_k', 'default_top_k']]) {
    values[draft] ??= `${values[target]} (follows request sampling)`;
  }
  return values;
}

export function buildMtplxServeLaunch(opts) {
  const descriptor = opts.descriptor ?? fallbackMtplxDescriptor(opts.modelPath);
  const warning = [];
  const settings = resolveSettings(descriptor, opts.defaults, opts.saved, opts.settings, warning);
  Object.assign(settings, MTPLX_SCHEDULING_PRESETS[settings.scheduling_preset]);
  const extra = settings.extra_args ?? [];
  // Identity, transcript semantics and auth are controlled here, not by argv order.
  const reserved = ['--model', '--port', '--stats-footer', '--no-stats-footer', '--agent-rewrites', '--no-auth', '--api-key', '--api-key-file', '--yes'];
  if (extra.includes('--') || extra.some((arg) => arg.startsWith('--') && reserved.some((flag) => flag.startsWith(arg.split('=')[0])))) throw new Error('Extra MTPLX arguments cannot override model, port, authentication, stats footer, or agent rewrites.');
  if (extra.some((arg) => arg.startsWith('--') && arg.split('=')[0] !== '--host' && '--host'.startsWith(arg.split('=')[0]))) throw new Error('Use the full --host option for MTPLX bind addresses.');
  const hostIndex = extra.findLastIndex((arg) => arg === '--host' || arg.startsWith('--host='));
  const host = hostIndex < 0 ? '127.0.0.1' : extra[hostIndex].includes('=') ? extra[hostIndex].slice(7) : extra[hostIndex + 1];
  if (!host || host.startsWith('--')) throw new Error('--host requires a bind address');
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(host);
  const apiKeyFile = loopback ? null : path.join(os.homedir(), '.mtplx', 'api-key');
  const args = ['serve', '--model', opts.modelPath, '--port', String(opts.port)];
  if (hostIndex < 0) args.push('--host', host);
  for (const [key, value] of Object.entries(settings)) {
    if (LAUNCH_ONLY_KEYS.includes(key)) continue;
    const flag = `--${key.replaceAll('_', '-')}`;
    if (extraHasFlag(extra, flag) || extraHasFlag(extra, `--no-${key.replaceAll('_', '-')}`)) continue;
    if (typeof value === 'boolean') { if (value) args.push(flag); }
    else args.push(flag, String(value));
  }
  args.push(...translatedFlags(settings, extra), ...extra, '--no-stats-footer', '--agent-rewrites', 'off', '--yes');
  args.push(...(apiKeyFile ? ['--api-key-file', apiKeyFile] : ['--no-auth']));
  return { args, warning: warning.join('\n'), settings, apiKeyFile, host };
}

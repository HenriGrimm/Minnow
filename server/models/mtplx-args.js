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
  const values = {
    profile: 'Automatic model profile', generation_mode: 'Model recommendation (MTP fallback)',
    paged_kv_quantization: 'off', reasoning: 'auto', reasoning_effort: 'Model default (resolved at load)',
    reasoning_parser: 'Model parser (detected at load)', preserve_thinking: 'auto (model history policy)',
    tool_prompt_mode: 'hybrid (unless model requires native)', scheduler_mode: 'serial', batching_preset: 'latency',
    ssd_session_cache: 'on', fan_mode: 'default (system managed)',
    max_tokens: 'Model response limit (resolved at load)',
    max_active_requests: 'Automatic for scheduler and batching preset',
    prefill_chunk_tokens: 'Automatic for model and batching preset',
    stream_interval: 1, ssd_session_cache_max_size: 'auto (based on RAM and free disk)',
    ssd_session_cache_min_prefix_tokens: 512, ngram_prewarm: 'auto (available memory)',
    default_temperature: 'Model sampler (0.6 fallback)', default_top_p: 'Model sampler (0.95 fallback)', default_top_k: 'Model sampler (20 fallback)',
    default_presence_penalty: 0, default_frequency_penalty: 0,
    enable_thermal_poll: false, warmup_tokens: 16,
    stream_stall_deadline_s: '300 (or MTPLX_STREAM_STALL_DEADLINE_S)',
    allow_swap: 'off (or MTPLX_ALLOW_SWAP)', rate_limit: 0,
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
    if (['extra_args', 'env', 'idle_ttl_ms'].includes(key)) continue;
    const flag = `--${key.replaceAll('_', '-')}`;
    if (extraHasFlag(extra, flag) || extraHasFlag(extra, `--no-${key.replaceAll('_', '-')}`)) continue;
    if (typeof value === 'boolean') { if (value) args.push(flag); }
    else args.push(flag, String(value));
  }
  args.push(...extra, '--no-stats-footer', '--agent-rewrites', 'off', '--yes');
  args.push(...(apiKeyFile ? ['--api-key-file', apiKeyFile] : ['--no-auth']));
  return { args, warning: warning.join('\n'), settings, apiKeyFile, host };
}

import { el } from './dom';
import { enginesForModel, defaultEngineFor } from '../../models/engine-support';
import { ENGINE_LABELS, type EngineId } from '../../models/engine-ids.mjs';
import { getLibraryLaunchSettingsForId, saveLibraryLaunchSettings } from '../../config/library-launch-meta';
import { fetchMtplxDescriptor } from '../../models/api-client';
import type { LibraryModel } from '../../models/library';
import type { MtplxModelDescriptor, MtplxServeSettings } from '../../models/mtplx-settings';

type Field = [keyof MtplxServeSettings, string, string[] | 'number' | 'text' | 'boolean'];
const sectionOpen = new Map<string, boolean>();
const scrollPositions = new Map<string, number>();
const BASIC_KEYS = new Set<keyof MtplxServeSettings>(['profile', 'context_window', 'paged_kv_quantization', 'reasoning', 'reasoning_effort']);
// Titles, choices and captions follow the MTPLX app (Settings tab and Inference popover) so settings carry over by name.
const FIELD_HELP: Partial<Record<keyof MtplxServeSettings, string>> = {
  profile: 'Auto picks the recommended profile for the selected model — Turbo for the 27B and Flash-Next models.',
  generation_mode: 'MTP predicts several tokens at a time. Baseline generates one token at a time.',
  context_window: 'How much conversation the model can keep in memory. A larger window uses more unified memory.',
  load_mtp: 'Disable to fall back to baseline (no speculation).',
  depth: 'How many tokens to draft together. Availability and limits come from this model.',
  adaptive_depth: 'Stops a draft early when the next token is unlikely to be accepted. Off drafts to the full depth every cycle.',
  default_presence_penalty: 'Discourages reusing tokens the reply already contains. 0 is exact and best for coding; try 0.5–1.5 for creative or repetitive output.',
  reasoning: 'Auto lets the model decide per turn. On always reasons before answering; Off skips reasoning.',
  reasoning_effort: 'More effort can improve difficult answers, but takes longer.',
  scheduling_preset: 'Auto uses the engine default (Fastest response). Changing Mode resets the overrides below to its preset.',
  max_active_requests: 'Max parallel completions in flight.',
  experimental_mtp_cohorts: 'Batch MTP verify steps across requests. Off = solo MTP (exactness preserved), on = experimental cohort batching.',
  decode_batch_max: 'Requests in a single decode step.',
  batch_wait_ms: 'How long the scheduler waits for peers before firing, in milliseconds.',
  stream_stall_deadline_s: 'Seconds a response may wait on a model that is making no progress before it is cancelled. 0 turns the watchdog off.',
  prefill_chunk_tokens: 'Prompt tokens processed per prefill step. Leave blank for the engine choice.',
  memory_limit_gb: "Empty uses the engine's own plan, about three quarters of this Mac's memory. Raise it to serve longer contexts on a Mac with headroom.",
  allow_swap: 'Serve contexts larger than what fits in memory. macOS pages to SSD, so speed drops sharply, but long sessions stop being refused.',
  paged_kv_quantization: 'Paged-attention KV cache precision. Off is the speed path; q8 saves memory when this model supports it.',
  ssd_session_cache: 'Cached prompts survive an engine restart.',
  ssd_session_cache_max_size: "Auto scales with your Mac's RAM tier (16 GB to 100 GB). Old entries are evicted to stay under the cap.",
  ssd_session_cache_min_prefix_tokens: "Shorter prompts aren't worth the write churn.",
  fan_mode: "Default uses Apple's curve. Smart boosts during requests. Max pins verified fans.",
  idle_ttl_ms: 'Unload after this many idle milliseconds. Set 0 to keep the model loaded.',
  extra_args: 'Additional MTPLX command-line arguments. These can override the controls above.',
};
const OPTION_LABELS: Partial<Record<keyof MtplxServeSettings, Record<string, string>>> = {
  profile: { auto: 'Auto (recommended)', turbo: 'Turbo', sustained: 'Sustained', 'performance-cold': 'Performance Cold (Burst)' },
  generation_mode: { auto: 'Auto', mtp: 'MTP', ar: 'Baseline' },
  scheduling_preset: { auto: 'Auto', latency: 'Fastest response', throughput: 'Handle multiple at once', agent: 'Long agent tasks' },
  paged_kv_quantization: { off: 'Off' },
  reasoning: { auto: 'Auto', on: 'On', off: 'Off' },
  ssd_session_cache: { off: 'Off', on: 'Read + write', 'write-only': 'Write-only' },
  ssd_session_cache_max_size: { auto: 'Auto', '10GB': '10 GB', '50GB': '50 GB', '100GB': '100 GB', '250GB': '250 GB', '500GB': '500 GB', '1TB': '1 TB' },
  fan_mode: { default: 'Default', smart: 'Smart', max: 'Max' },
};
/** Per-Mode fallbacks for the batching overrides, mirroring `MTPLX_BATCHING_DEFAULTS` on the server. */
const MODE_BATCHING: Record<string, Partial<Record<keyof MtplxServeSettings, number>>> = {
  latency: { max_active_requests: 1, decode_batch_max: 1, batch_wait_ms: 0 },
  throughput: { max_active_requests: 8, decode_batch_max: 8, batch_wait_ms: 20 },
  agent: { max_active_requests: 4, decode_batch_max: 4, batch_wait_ms: 50 },
};
const BATCHING_KEYS = ['max_active_requests', 'decode_batch_max', 'batch_wait_ms'] as const;
const LEGACY_MODE_PAIRS: Record<string, MtplxServeSettings['scheduling_preset']> = { 'serial/latency': 'latency', 'ar_batch/throughput': 'throughput', 'ar_batch/agent': 'agent' };
type Bounds = { minimum: number; maximum: number; step: number; default?: number };
/** Input limits from the MTPLX app's steppers; a step of 0 accepts any value in range. */
const NUMBER_BOUNDS: Partial<Record<keyof MtplxServeSettings, Bounds>> = {
  max_active_requests: { minimum: 1, maximum: 16, step: 1 }, decode_batch_max: { minimum: 1, maximum: 16, step: 1 },
  batch_wait_ms: { minimum: 0, maximum: 500, step: 0 }, memory_limit_gb: { minimum: 1, maximum: 2048, step: 1 },
};
const groups: Array<[string, Field[]]> = [
  ['Model', [['profile', 'Profile', ['auto', 'turbo', 'sustained', 'performance-cold']], ['generation_mode', 'Generation mode', ['mtp', 'ar']], ['context_window', 'Context window', 'number'], ['max_tokens', 'Maximum output tokens', 'number'], ['load_mtp', 'Load MTP head', 'boolean']]],
  ['MTP heads', [['depth', 'Depth', 'number'], ['adaptive_depth', 'Adaptive depth', 'boolean']]],
  ['Sampling', [['default_temperature', 'Temperature', 'number'], ['default_top_p', 'Top P', 'number'], ['default_top_k', 'Top K', 'number'], ['default_presence_penalty', 'Presence Penalty', 'number'], ['default_frequency_penalty', 'Frequency Penalty', 'number'], ['draft_temperature', 'Draft temperature', 'number'], ['draft_top_p', 'Draft top P', 'number'], ['draft_top_k', 'Draft top K', 'number']]],
  ['Reasoning', [['reasoning', 'Reasoning', ['auto', 'on', 'off']], ['reasoning_effort', 'Reasoning effort', ['auto', 'low', 'medium', 'high', 'xhigh']], ['reasoning_parser', 'Reasoning parser', ['qwen3', 'step3p5', 'gemma4', 'poolside_v1', 'none']], ['preserve_thinking', 'Preserve thinking', ['auto', 'on', 'off', 'scoped']], ['tool_prompt_mode', 'Tool prompts', ['native', 'hybrid']]]],
  ['Performance', [['scheduling_preset', 'Mode', ['latency', 'throughput', 'agent']], ['max_active_requests', 'Concurrency cap', 'number'], ['experimental_mtp_cohorts', 'Experimental MTP cohorts', 'boolean'], ['decode_batch_max', 'Decode batch max', 'number'], ['batch_wait_ms', 'Admission window', 'number'], ['prefill_chunk_tokens', 'Batch step size', 'number'], ['stream_stall_deadline_s', 'Stall watchdog', 'number']]],
  ['Memory', [['memory_limit_gb', 'Memory limit (GB)', 'number'], ['allow_swap', 'Allow swap', 'boolean'], ['paged_kv_quantization', 'KV quantization', ['off', 'q8', 'q4']]]],
  ['Persistent Cache (SSD)', [['ssd_session_cache', 'Policy', ['off', 'on', 'write-only']], ['ssd_session_cache_max_size', 'Max size', ['auto', '10GB', '50GB', '100GB', '250GB', '500GB', '1TB']], ['ssd_session_cache_min_prefix_tokens', 'Save prompts ≥ (tokens)', 'number']]],
  ['Thermal', [['fan_mode', 'Fan Mode', ['default', 'smart', 'max']], ['enable_thermal_poll', 'Enable thermal polling', 'boolean']]],
  ['Advanced', [['stream_interval', 'Stream interval', 'number'], ['ngram_prewarm', 'N-gram prewarm (auto, all, off, or GiB)', 'text'], ['warmup_tokens', 'Warmup tokens', 'number'], ['rate_limit', 'Requests per minute', 'number'], ['model_id', 'Model API name', 'text'], ['cache_dir', 'Cache directory', 'text'], ['idle_ttl_ms', 'Idle unload (milliseconds, 0 disables)', 'number'], ['extra_args', 'Extra arguments', 'text'], ['env', 'Environment (JSON object)', 'text']]],
];
const optionLabel = (key: keyof MtplxServeSettings, value: string) => OPTION_LABELS[key]?.[value]
  ?? (key === 'reasoning_effort' ? value.charAt(0).toUpperCase() + value.slice(1) : value);
/** The saved Mode, or the MTPLX app Mode an older scheduler/batching pair corresponds to. */
function savedMode(saved: MtplxServeSettings | undefined): string {
  if (saved?.scheduling_preset) return saved.scheduling_preset === 'auto' ? '' : saved.scheduling_preset;
  return LEGACY_MODE_PAIRS[`${saved?.scheduler_mode}/${saved?.batching_preset}`] ?? '';
}

export function renderModelEngineSettings(model: LibraryModel, body: HTMLElement, redraw: () => void, advanced?: HTMLElement): boolean {
  const engines = enginesForModel(model);
  const saved = getLibraryLaunchSettingsForId(model.id);
  const engine = saved?.engine && engines.includes(saved.engine) ? saved.engine : defaultEngineFor(model);
  const label = el('label', 'models-field');
  label.append(el('span', 'models-field__label', 'Engine'));
  const select = el('select', 'models-field__input');
  for (const id of engines) {
    const option = el('option', undefined, id === 'mtplx' ? 'Powered by MTPLX' : id === 'mlx-lm' && engines.includes('mtplx') ? 'MLX (no MTP acceleration)' : ENGINE_LABELS[id]);
    option.value = id;
    select.append(option);
  }
  select.value = engine ?? '';
  select.disabled = engines.length <= 1;
  select.addEventListener('change', () => {
    void saveLibraryLaunchSettings({ libraryId: model.id, settings: { ...getLibraryLaunchSettingsForId(model.id), engine: select.value as EngineId } })
      .then(redraw).catch((err: unknown) => {
        select.value = engine ?? '';
        label.append(el('p', 'models-hint models-error', err instanceof Error ? err.message : 'Could not save engine selection'));
      });
  });
  label.append(select); body.append(label);
  if (engine === 'mlx-lm') {
    body.append(el('p', 'models-muted', 'MLX loads this snapshot with its runtime defaults. No llama.cpp settings apply.'));
    advanced?.append(el('p', 'models-muted', 'This engine uses its runtime defaults.'));
    return true;
  }
  if (engine !== 'mtplx') return false;
  body.addEventListener('scroll', () => {
    if (body.isConnected) scrollPositions.set(model.id, body.scrollTop);
  });
  const content = el('div', 'models-mtplx-controls');
  content.append(el('p', 'models-muted', 'Reading model controls…'));
  body.append(content);
  void fetchMtplxDescriptor(model.id).then((descriptor) => {
    if (!content.isConnected) return;
    renderControls(model, content, descriptor, advanced);
    body.scrollTop = scrollPositions.get(model.id) ?? 0;
  }).catch((err: unknown) => { content.textContent = err instanceof Error ? err.message : 'Could not read MTPLX controls. Refresh to retry.'; });
  return true;
}

function renderControls(model: LibraryModel, content: HTMLElement, descriptor: MtplxModelDescriptor, advanced?: HTMLElement): void {
  content.replaceChildren();
  content.append(el('p', 'models-muted', descriptor.source === 'fallback'
    ? 'Using conservative controls. MTPLX must validate this model before it can load.'
    : 'Controls come from this model. Changes apply on the next Minnow-owned load. An existing daemon keeps its settings.'));
  const message = el('p', 'models-hint'); message.setAttribute('role', 'status');
  const memory = el('p', 'models-hint', 'Estimating unified memory…');
  memory.setAttribute('role', 'status'); content.append(memory);
  let estimateRevision = 0;
  const updateMemory = async () => {
    const revision = ++estimateRevision;
    try {
      const response = await fetch('/api/models/mtplx/estimate', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ libraryId: model.id, mtplx: getLibraryLaunchSettingsForId(model.id)?.mtplx }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Memory estimate unavailable');
      if (revision !== estimateRevision || !memory.isConnected) return;
      memory.textContent = `Estimated unified memory: ${Number(result.estimateGb).toFixed(1)} GiB${result.budgetGb > 0 ? ` / ${Number(result.budgetGb).toFixed(1)} GiB budget` : ''}. ${result.estimateSource === 'weights-only' ? 'Weights only; KV geometry is unknown.' : 'Conservative estimate; MTPLX reports actual memory after loading.'}`;
      if (result.warning) memory.textContent += ` ${result.warning}`;
    } catch (err) { if (revision === estimateRevision && memory.isConnected) memory.textContent = err instanceof Error ? err.message : 'Memory estimate unavailable'; }
  };
  void updateMemory();
  const persist = (patch: Partial<Record<keyof MtplxServeSettings, unknown>>) => {
    const existing = getLibraryLaunchSettingsForId(model.id);
    const mtplx: Record<string, unknown> = { ...existing?.mtplx, ...patch };
    for (const [key, value] of Object.entries(patch)) if (value === undefined) delete mtplx[key];
    void saveLibraryLaunchSettings({ libraryId: model.id, settings: { ...existing, engine: 'mtplx', mtplx } })
      .catch((err: unknown) => { message.textContent = err instanceof Error ? err.message : 'Could not save MTPLX settings'; });
    void updateMemory();
  };
  const defaultFor = (key: keyof MtplxServeSettings, bounds: Bounds | null) => {
    const mode = savedMode(getLibraryLaunchSettingsForId(model.id)?.mtplx);
    return MODE_BATCHING[mode]?.[key] ?? descriptor.loadDefaults?.[key] ?? bounds?.default;
  };
  const defaultText = (key: keyof MtplxServeSettings, value: string | number | boolean | undefined) => typeof value === 'boolean'
    ? value ? 'On' : 'Off' : value == null ? 'Default unavailable until load' : optionLabel(key, String(value));
  // Picking a Mode resets the batching overrides to that preset, as it does in the MTPLX app.
  const batchingInputs = new Map<keyof MtplxServeSettings, HTMLInputElement>();
  const resetBatching = () => {
    for (const [key, input] of batchingInputs) { input.value = ''; input.placeholder = defaultText(key, defaultFor(key, null)); }
  };
  const basicFields = advanced ? el('div', 'models-mtplx-basic-fields') : null;
  if (basicFields) content.appendChild(basicFields);
  const advancedStack = el('div', 'models-advanced-stack');
  for (const [title, fields] of groups) {
    const section = el('details', 'models-advanced');
    const sectionKey = `${model.id}:${title}`;
    section.open = sectionOpen.get(sectionKey) ?? title === 'Model';
    section.addEventListener('toggle', () => {
      if (section.isConnected) sectionOpen.set(sectionKey, section.open);
    });
    section.append(el('summary', 'models-advanced__summary', title));
    const fieldsBody = el('div', 'models-advanced__body'); section.append(fieldsBody);
    for (const [key, fieldName, kind] of fields) {
      if (['depth', 'adaptive_depth'].includes(key) && !descriptor.draft.supported) continue;
      if (key === 'paged_kv_quantization' && !descriptor.kvQuant.supported) continue;
      if (key === 'context_window' && descriptor.contextWindow.supported === false) continue;
      if (['reasoning', 'reasoning_effort', 'reasoning_parser'].includes(key) && !descriptor.reasoning?.supported) continue;
      if (key === 'reasoning_effort' && !descriptor.reasoning?.effortLevels.length) continue;
      let options = Array.isArray(kind) ? kind : null;
      if (key === 'paged_kv_quantization') options = descriptor.kvQuant.modes;
      if (key === 'reasoning' && descriptor.reasoning) options = descriptor.reasoning.modes;
      if (key === 'reasoning_effort' && descriptor.reasoning) options = ['auto', ...descriptor.reasoning.effortLevels];
      if (kind === 'boolean') options = ['on', 'off'];
      const name = key === 'depth' ? descriptor.draft.displayLabel ?? fieldName : fieldName;
      const label = el('label', 'models-field'); label.append(el('span', 'models-field__label', name));
      const input = options ? el('select', 'models-field__input') : el('input', 'models-field__input');
      const savedSettings = getLibraryLaunchSettingsForId(model.id)?.mtplx;
      const saved = key === 'scheduling_preset' ? savedMode(savedSettings) || undefined : savedSettings?.[key];
      const bounds: Bounds | null = key === 'depth' ? { ...descriptor.draft, step: 1 }
        : key === 'context_window' ? descriptor.contextWindow : NUMBER_BOUNDS[key] ?? null;
      const defaultValue = defaultFor(key, bounds);
      const defaultLabel = defaultText(key, defaultValue);
      if (options) {
        const inherit = el('option', undefined, defaultValue == null ? defaultLabel : `${defaultLabel} (default)`); inherit.value = ''; input.append(inherit);
        if (typeof saved === 'string' && !options.includes(saved)) options = [...options, saved];
        for (const value of options) {
          const option = el('option', undefined, kind === 'boolean' ? (value === 'on' ? 'On' : 'Off') : optionLabel(key, value));
          option.value = value; input.append(option);
        }
      } else {
        (input as HTMLInputElement).type = kind === 'number' ? 'number' : 'text';
        if (kind === 'number') (input as HTMLInputElement).step = 'any';
        (input as HTMLInputElement).placeholder = defaultValue == null ? '' : defaultLabel;
      }
      if (bounds) {
        const number = input as HTMLInputElement;
        number.min = String(bounds.minimum); number.max = String(bounds.maximum);
        if (bounds.step) number.step = String(bounds.step);
      }
      if ((BATCHING_KEYS as readonly string[]).includes(key)) batchingInputs.set(key, input as HTMLInputElement);
      if (kind === 'boolean') input.value = saved == null ? '' : saved ? 'on' : 'off';
      else input.value = saved == null ? '' : key === 'env' || Array.isArray(saved) ? JSON.stringify(saved) : String(saved);
      input.addEventListener('change', () => {
        message.textContent = '';
        try {
          let value: unknown = input.value || undefined;
          if (key === 'scheduling_preset') {
            persist({ scheduling_preset: value, scheduler_mode: undefined, batching_preset: undefined,
              ...Object.fromEntries(BATCHING_KEYS.map((batchKey) => [batchKey, undefined])) });
            resetBatching();
            return;
          }
          if (kind === 'boolean' && value !== undefined) value = value === 'on';
          else if (kind === 'number' && value !== undefined) {
            value = Number(value);
            if (bounds) {
              const { step } = bounds;
              const clamped = step ? bounds.minimum + Math.min(Math.floor((bounds.maximum - bounds.minimum) / step), Math.max(0, Math.round((Number(value) - bounds.minimum) / step))) * step
                : Math.max(bounds.minimum, Math.min(bounds.maximum, Number(value)));
              if (value !== clamped) message.textContent = `${name} adjusted to ${clamped} for this model.`;
              value = clamped; input.value = String(value);
            }
            if (!(input as HTMLInputElement).checkValidity()) throw new Error(`${name} is outside this model's range.`);
          } else if (key === 'env' && value) {
            value = JSON.parse(String(value));
            if (!value || Array.isArray(value) || typeof value !== 'object' || Object.values(value).some((v) => typeof v !== 'string')) throw new Error('Environment must be a JSON object of strings.');
          } else if (key === 'extra_args' && String(value).startsWith('[')) value = JSON.parse(String(value));
          persist({ [key]: value });
        } catch (err) { message.textContent = err instanceof Error ? err.message : 'Invalid setting'; }
      });
      label.append(input);
      input.setAttribute('aria-label', name);
      if (FIELD_HELP[key]) {
        const inheritHint = key === 'context_window' && typeof defaultValue === 'number'
          ? ` Leave blank to use ${defaultValue.toLocaleString()} tokens.` : '';
        const help = el('span', 'models-field__help', FIELD_HELP[key] + inheritHint);
        help.id = `modelsMtplxHelp-${key}`;
        input.setAttribute('aria-describedby', help.id);
        label.append(help);
      }
      if (basicFields && BASIC_KEYS.has(key)) basicFields.appendChild(label);
      else fieldsBody.appendChild(label);
    }
    if (fieldsBody.childElementCount) advancedStack.appendChild(section);
  }
  (advanced ?? content).appendChild(advancedStack);
  (advanced?.parentElement ?? content).appendChild(message);
}

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
const FIELD_HELP: Partial<Record<keyof MtplxServeSettings, string>> = {
  profile: 'Auto follows the model recommendation. Sustained favors longer sessions; turbo favors speed.',
  context_window: 'How much conversation the model can keep in memory. A larger window uses more unified memory.',
  paged_kv_quantization: 'Compress conversation memory to save space. Leave the default unless you need more room.',
  reasoning: 'Let the model decide whether to think, or explicitly turn thinking on or off when supported.',
  reasoning_effort: 'More effort can improve difficult answers, but takes longer.',
  generation_mode: 'Auto chooses the supported generation method. MTP predicts several tokens at a time.',
  depth: 'How many tokens to draft together. Availability and limits come from this model.',
  allow_swap: 'Allow disk-backed memory when RAM is tight. This can slow generation substantially.',
  idle_ttl_ms: 'Unload after this many idle milliseconds. Set 0 to keep the model loaded.',
  extra_args: 'Additional MTPLX command-line arguments. These can override the controls above.',
};
const groups: Array<[string, Field[]]> = [
  ['Runtime', [['profile', 'Profile', ['auto', 'sustained', 'turbo', 'performance-cold']], ['generation_mode', 'Generation', ['auto', 'mtp', 'ar']], ['depth', 'MTP depth', 'number'], ['context_window', 'Context window', 'number'], ['max_tokens', 'Maximum output tokens', 'number'], ['paged_kv_quantization', 'KV quantization', ['off', 'q8', 'q4']]]],
  ['Reasoning', [['reasoning', 'Reasoning', ['auto', 'on', 'off']], ['reasoning_effort', 'Effort', ['auto', 'low', 'medium', 'high', 'xhigh']], ['reasoning_parser', 'Parser', ['qwen3', 'step3p5', 'gemma4', 'poolside_v1', 'none']], ['preserve_thinking', 'Preserve thinking', ['auto', 'on', 'off', 'scoped']], ['tool_prompt_mode', 'Tool prompts', ['native', 'hybrid']]]],
  ['Scheduling', [['scheduler_mode', 'Scheduler', ['serial', 'ar_batch', 'mtp_batch']], ['batching_preset', 'Batching', ['solo', 'latency', 'agent', 'throughput']], ['max_active_requests', 'Active requests', 'number'], ['prefill_chunk_tokens', 'Prefill chunk tokens', 'number'], ['stream_interval', 'Stream interval', 'number']]],
  ['Caching', [['ssd_session_cache', 'SSD session cache', ['off', 'on', 'write-only']], ['ssd_session_cache_max_size', 'SSD cache size', 'text'], ['ssd_session_cache_min_prefix_tokens', 'Minimum prefix tokens', 'number'], ['ngram_prewarm', 'N-gram prewarm (auto, all, off, or GiB)', 'text']]],
  ['Sampling defaults', [['default_temperature', 'Temperature', 'number'], ['default_top_p', 'Top P', 'number'], ['default_top_k', 'Top K', 'number'], ['default_presence_penalty', 'Presence penalty', 'number'], ['default_frequency_penalty', 'Frequency penalty', 'number'], ['draft_temperature', 'Draft temperature', 'number'], ['draft_top_p', 'Draft top P', 'number'], ['draft_top_k', 'Draft top K', 'number']]],
  ['System', [['fan_mode', 'Fans', ['default', 'smart', 'max']], ['enable_thermal_poll', 'Thermal polling', 'boolean'], ['warmup_tokens', 'Warmup tokens', 'number'], ['stream_stall_deadline_s', 'Stream stall deadline (seconds)', 'number'], ['allow_swap', 'Allow swap', 'boolean'], ['rate_limit', 'Requests per minute', 'number'], ['model_id', 'Model API name', 'text'], ['cache_dir', 'Cache directory', 'text'], ['idle_ttl_ms', 'Idle unload (milliseconds, 0 disables)', 'number'], ['extra_args', 'Extra arguments', 'text'], ['env', 'Environment (JSON object)', 'text']]],
];

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
  const persist = (key: keyof MtplxServeSettings, value: unknown) => {
    const existing = getLibraryLaunchSettingsForId(model.id);
    const mtplx = { ...existing?.mtplx, [key]: value };
    if (value === undefined) delete mtplx[key];
    void saveLibraryLaunchSettings({ libraryId: model.id, settings: { ...existing, engine: 'mtplx', mtplx } })
      .catch((err: unknown) => { message.textContent = err instanceof Error ? err.message : 'Could not save MTPLX settings'; });
    void updateMemory();
  };
  const basicFields = advanced ? el('div', 'models-mtplx-basic-fields') : null;
  if (basicFields) content.appendChild(basicFields);
  const advancedStack = el('div', 'models-advanced-stack');
  for (const [title, fields] of groups) {
    const section = el('details', 'models-advanced');
    const sectionKey = `${model.id}:${title}`;
    section.open = sectionOpen.get(sectionKey) ?? title === 'Runtime';
    section.addEventListener('toggle', () => {
      if (section.isConnected) sectionOpen.set(sectionKey, section.open);
    });
    section.append(el('summary', 'models-advanced__summary', basicFields && title === 'Runtime' ? 'Generation' : title));
    const fieldsBody = el('div', 'models-advanced__body'); section.append(fieldsBody);
    for (const [key, name, kind] of fields) {
      if (key === 'depth' && !descriptor.draft.supported) continue;
      if (key === 'paged_kv_quantization' && !descriptor.kvQuant.supported) continue;
      if (key === 'context_window' && descriptor.contextWindow.supported === false) continue;
      if (['reasoning', 'reasoning_effort', 'reasoning_parser'].includes(key) && !descriptor.reasoning?.supported) continue;
      if (key === 'reasoning_effort' && !descriptor.reasoning?.effortLevels.length) continue;
      let options = Array.isArray(kind) ? kind : null;
      if (key === 'paged_kv_quantization') options = descriptor.kvQuant.modes;
      if (key === 'reasoning' && descriptor.reasoning) options = descriptor.reasoning.modes;
      if (key === 'reasoning_effort' && descriptor.reasoning) options = ['auto', ...descriptor.reasoning.effortLevels];
      if (kind === 'boolean') options = ['on', 'off'];
      const label = el('label', 'models-field'); label.append(el('span', 'models-field__label', name));
      const input = options ? el('select', 'models-field__input') : el('input', 'models-field__input');
      const saved = getLibraryLaunchSettingsForId(model.id)?.mtplx?.[key];
      const bounds = key === 'depth' ? descriptor.draft : key === 'context_window' ? descriptor.contextWindow : null;
      const defaultValue = descriptor.loadDefaults?.[key] ?? bounds?.default;
      const defaultLabel = typeof defaultValue === 'boolean' ? defaultValue ? 'on' : 'off' : defaultValue == null ? 'Default unavailable until load' : String(defaultValue);
      if (options) {
        const inherit = el('option', undefined, defaultValue == null ? defaultLabel : `${defaultLabel} (default)`); inherit.value = ''; input.append(inherit);
        for (const value of options) { const option = el('option', undefined, value); option.value = value; input.append(option); }
      } else {
        (input as HTMLInputElement).type = kind === 'number' ? 'number' : 'text';
        if (kind === 'number') (input as HTMLInputElement).step = 'any';
        (input as HTMLInputElement).placeholder = defaultValue == null ? '' : defaultLabel;
      }
      if (bounds) {
        const number = input as HTMLInputElement;
        number.min = String(bounds.minimum); number.max = String(bounds.maximum);
        number.step = String('step' in bounds ? bounds.step : 1);
      }
      if (kind === 'boolean') input.value = saved == null ? '' : saved ? 'on' : 'off';
      else input.value = saved == null ? '' : key === 'env' || Array.isArray(saved) ? JSON.stringify(saved) : String(saved);
      input.addEventListener('change', () => {
        message.textContent = '';
        try {
          let value: unknown = input.value || undefined;
          if (kind === 'boolean' && value !== undefined) value = value === 'on';
          else if (kind === 'number' && value !== undefined) {
            value = Number(value);
            if (bounds) {
              const step = 'step' in bounds ? bounds.step : 1;
              const clamped = bounds.minimum + Math.min(Math.floor((bounds.maximum - bounds.minimum) / step), Math.max(0, Math.round((Number(value) - bounds.minimum) / step))) * step;
              if (value !== clamped) message.textContent = `${name} adjusted to ${clamped} for this model.`;
              value = clamped; input.value = String(value);
            }
            if (!(input as HTMLInputElement).checkValidity()) throw new Error(`${name} is outside this model's range.`);
          } else if (key === 'env' && value) {
            value = JSON.parse(String(value));
            if (!value || Array.isArray(value) || typeof value !== 'object' || Object.values(value).some((v) => typeof v !== 'string')) throw new Error('Environment must be a JSON object of strings.');
          } else if (key === 'extra_args' && String(value).startsWith('[')) value = JSON.parse(String(value));
          persist(key, value);
        } catch (err) { message.textContent = err instanceof Error ? err.message : 'Invalid setting'; }
      });
      label.append(input);
      if (FIELD_HELP[key]) {
        const inheritHint = key === 'context_window' && typeof defaultValue === 'number'
          ? ` Leave blank to use ${defaultValue.toLocaleString()} tokens.` : '';
        const help = el('span', 'models-field__help', FIELD_HELP[key] + inheritHint);
        help.id = `modelsMtplxHelp-${key}`;
        input.setAttribute('aria-label', name);
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

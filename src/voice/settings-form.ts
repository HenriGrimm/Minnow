/**
 * Capability-gated STT settings form for Models → Voice.
 */

import type {
  VoiceConfig,
  VoiceSttLocalConfig,
  VoiceTtsLocalConfig,
} from '../config/voice-meta';
import type { SttCatalogEntry } from './catalog-stt';
import type { TtsCatalogEntry } from './catalog-tts';
import { createSettingsRadioRow } from '../ui/settings-controls';
import { createSettingsToggleRow } from '../ui/settings-switch';

type FieldGroup = 'basic' | 'advanced';

interface FieldSpec {
  key: keyof VoiceSttLocalConfig;
  label: string;
  group: FieldGroup;
  type: 'text' | 'number' | 'select' | 'checkbox';
  options?: Array<{ value: string; label: string }>;
  min?: number;
  max?: number;
  step?: number;
  hint?: string;
  showWhen?: (config: VoiceSttLocalConfig, catalog?: SttCatalogEntry) => boolean;
}

// ── STT fields ───────────────────────────────────────────────────────────────

const COMPOSER_MIC_FIELDS: FieldSpec[] = [
  {
    key: 'streamingEnabled',
    label: 'Live dictation (streaming)',
    group: 'basic',
    type: 'checkbox',
    hint:
      'Show words in the composer while the mic is open. Local Whisper only — requires the voice worker to be running. Disable to transcribe after recording stops (batch).',
  },
];

const BASIC_FIELDS: FieldSpec[] = [
  {
    key: 'modelId',
    label: 'Model',
    group: 'basic',
    type: 'text',
    hint: 'HuggingFace model id (set via catalog download)',
  },
  {
    key: 'language',
    label: 'Language',
    group: 'basic',
    type: 'text',
    hint: 'ISO code or empty for auto-detect',
  },
  {
    key: 'task',
    label: 'Task',
    group: 'basic',
    type: 'select',
    options: [
      { value: 'transcribe', label: 'Transcribe' },
      { value: 'translate', label: 'Translate to English' },
    ],
    showWhen: (_c, catalog) => catalog?.capabilities.translate !== false,
  },
  {
    key: 'device',
    label: 'Device',
    group: 'basic',
    type: 'select',
    options: [
      { value: 'auto', label: 'Auto' },
      { value: 'cuda', label: 'CUDA GPU' },
      { value: 'cpu', label: 'CPU' },
    ],
  },
  {
    key: 'computeType',
    label: 'Compute type',
    group: 'basic',
    type: 'select',
    options: [
      { value: 'auto', label: 'Auto' },
      { value: 'float16', label: 'float16' },
      { value: 'bfloat16', label: 'bfloat16' },
      { value: 'float32', label: 'float32' },
    ],
  },
  {
    key: 'chunkLengthSeconds',
    label: 'Chunk length (s)',
    group: 'basic',
    type: 'number',
    min: 10,
    max: 30,
    step: 1,
    showWhen: (_c, catalog) => catalog?.capabilities.longForm !== false,
  },
  {
    key: 'batchSize',
    label: 'Batch size',
    group: 'basic',
    type: 'number',
    min: 1,
    max: 16,
    step: 1,
  },
];

const ADVANCED_FIELDS: FieldSpec[] = [
  {
    key: 'longFormAlgorithm',
    label: 'Long-form algorithm',
    group: 'advanced',
    type: 'select',
    options: [
      { value: 'chunked', label: 'Chunked' },
      { value: 'sequential', label: 'Sequential' },
    ],
    showWhen: (_c, catalog) => catalog?.capabilities.longForm !== false,
  },
  {
    key: 'returnTimestamps',
    label: 'Return timestamps',
    group: 'advanced',
    type: 'checkbox',
    showWhen: (_c, catalog) => catalog?.capabilities.timestamps !== false,
  },
  {
    key: 'timestampGranularity',
    label: 'Timestamp granularity',
    group: 'advanced',
    type: 'select',
    options: [
      { value: 'segment', label: 'Segment' },
      { value: 'word', label: 'Word' },
    ],
    showWhen: (c) => c.returnTimestamps,
  },
  {
    key: 'maxNewTokens',
    label: 'Max new tokens',
    group: 'advanced',
    type: 'number',
    min: 1,
    max: 448,
    step: 1,
  },
  {
    key: 'numBeams',
    label: 'Beam search width',
    group: 'advanced',
    type: 'number',
    min: 1,
    max: 5,
    step: 1,
  },
  {
    key: 'conditionOnPrevTokens',
    label: 'Condition on previous tokens',
    group: 'advanced',
    type: 'checkbox',
  },
  {
    key: 'compressionRatioThreshold',
    label: 'Compression ratio threshold',
    group: 'advanced',
    type: 'number',
    min: 0.5,
    max: 2,
    step: 0.05,
  },
  {
    key: 'temperatureFallback',
    label: 'Temperature fallback',
    group: 'advanced',
    type: 'checkbox',
  },
  {
    key: 'temperature',
    label: 'Temperature',
    group: 'advanced',
    type: 'number',
    min: 0,
    max: 1,
    step: 0.05,
  },
  {
    key: 'logprobThreshold',
    label: 'Logprob threshold',
    group: 'advanced',
    type: 'number',
    min: -2,
    max: 0,
    step: 0.1,
  },
  {
    key: 'noSpeechThreshold',
    label: 'No-speech threshold',
    group: 'advanced',
    type: 'number',
    min: 0,
    max: 1,
    step: 0.05,
  },
  {
    key: 'attnImplementation',
    label: 'Attention',
    group: 'advanced',
    type: 'select',
    options: [
      { value: 'auto', label: 'Auto' },
      { value: 'sdpa', label: 'SDPA' },
      { value: 'flash_attention_2', label: 'Flash Attention 2' },
    ],
    showWhen: (_c, catalog) => catalog?.capabilities.flashAttention === true,
  },
  {
    key: 'useSafetensors',
    label: 'Use safetensors',
    group: 'advanced',
    type: 'checkbox',
  },
  {
    key: 'lowCpuMemUsage',
    label: 'Low CPU memory usage',
    group: 'advanced',
    type: 'checkbox',
  },
  {
    key: 'torchCompile',
    label: 'Torch compile',
    group: 'advanced',
    type: 'checkbox',
  },
];

function fieldId(key: string): string {
  return `voiceSttLocal_${key}`;
}

function renderField(
  spec: FieldSpec,
  config: VoiceSttLocalConfig,
  catalog: SttCatalogEntry | undefined,
  mount: HTMLElement,
): void {
  if (spec.showWhen && !spec.showWhen(config, catalog)) return;

  const value = config[spec.key];

  if (spec.type === 'checkbox') {
    const { row, input } = createSettingsToggleRow(spec.label, {
      id: fieldId(spec.key),
      checked: Boolean(value),
      description: spec.hint,
    });
    input.dataset.voiceSttKey = spec.key;
    row.classList.add('models-voice-field');
    mount.appendChild(row);
    return;
  }

  const wrap = document.createElement('div');
  wrap.className = 'settings-row models-voice-field';

  const labelCol = document.createElement('div');
  labelCol.className = 'settings-row__label';

  const label = document.createElement('label');
  label.className = 'settings-row__title';
  label.htmlFor = fieldId(spec.key);
  label.textContent = spec.label;
  labelCol.appendChild(label);
  if (spec.hint) {
    const desc = document.createElement('span');
    desc.className = 'settings-row__desc';
    desc.textContent = spec.hint;
    labelCol.appendChild(desc);
  }
  wrap.appendChild(labelCol);

  const controlWrap = document.createElement('div');
  controlWrap.className = 'settings-row__control';

  let control: HTMLInputElement | HTMLSelectElement;

  if (spec.type === 'select') {
    const select = document.createElement('select');
    select.className = 'settings-select';
    for (const opt of spec.options ?? []) {
      const option = document.createElement('option');
      option.value = opt.value;
      option.textContent = opt.label;
      if (String(value) === opt.value) option.selected = true;
      select.appendChild(option);
    }
    control = select;
  } else {
    const textInput = document.createElement('input');
    textInput.className = 'settings-input';
    textInput.type = spec.type;
    if (spec.type === 'number') {
      if (spec.min != null) textInput.min = String(spec.min);
      if (spec.max != null) textInput.max = String(spec.max);
      if (spec.step != null) textInput.step = String(spec.step);
    }
    textInput.value = String(value ?? '');
    if (spec.key === 'modelId') {
      textInput.readOnly = true;
    }
    control = textInput;
  }

  control.id = fieldId(spec.key);
  control.dataset.voiceSttKey = spec.key;
  controlWrap.appendChild(control);
  wrap.appendChild(controlWrap);

  mount.appendChild(wrap);
}

/** Read STT local config from rendered form controls. */
export function readSttLocalFromForm(base: VoiceSttLocalConfig): VoiceSttLocalConfig {
  const out = { ...base };
  const fields = [...COMPOSER_MIC_FIELDS, ...BASIC_FIELDS, ...ADVANCED_FIELDS];
  for (const spec of fields) {
    const el = document.getElementById(fieldId(spec.key)) as
      | HTMLInputElement
      | HTMLSelectElement
      | null;
    if (!el) continue;
    if (spec.type === 'checkbox') {
      (out as Record<string, unknown>)[spec.key] = (el as HTMLInputElement).checked;
    } else if (spec.type === 'number') {
      const n = Number((el as HTMLInputElement).value);
      if (Number.isFinite(n)) (out as Record<string, unknown>)[spec.key] = n;
    } else {
      (out as Record<string, unknown>)[spec.key] = el.value;
    }
  }
  return out;
}

export interface RenderSttSettingsFormOptions {
  mount: HTMLElement;
  config: VoiceConfig;
  catalogEntry?: SttCatalogEntry;
  onBackendChange?: (backend: 'builtin' | 'local' | 'provider') => void;
}

// ── STT form ─────────────────────────────────────────────────────────────────

/** Render backend toggle + capability-gated STT settings groups. */
export function renderSttSettingsForm(options: RenderSttSettingsFormOptions): void {
  const { mount, config, catalogEntry, onBackendChange } = options;
  mount.replaceChildren();

  const { row: backendRow } = createSettingsRadioRow('Backend', {
    name: 'voiceSttBackend',
    options: [
      { value: 'builtin', label: 'Built-in' },
      { value: 'local', label: 'Advanced local' },
      { value: 'provider', label: 'External API' },
    ],
    value: config.stt.backend,
    onChange: (value) => onBackendChange?.(value as 'builtin' | 'local' | 'provider'),
    searchKey: 'models.voice.stt.backend',
  });
  mount.appendChild(backendRow);

  const builtinHint = document.createElement('p');
  builtinHint.id = 'modelsVoiceSttBuiltinHint';
  builtinHint.className = 'settings-field-hint';
  builtinHint.hidden = config.stt.backend !== 'builtin';
  builtinHint.textContent = 'Runs on your device. A compact speech model downloads automatically on first use, then stays cached. No Python, GPU or API key required.';
  mount.appendChild(builtinHint);

  const providerPanel = document.createElement('div');
  providerPanel.className = 'models-voice-provider-panel';
  providerPanel.id = 'modelsVoiceSttProviderPanel';
  providerPanel.hidden = config.stt.backend !== 'provider';
  providerPanel.innerHTML = `
    <div class="settings-row models-voice-field">
      <div class="settings-row__label"><label class="settings-row__title" for="voiceSttProviderId">Provider</label></div>
      <div class="settings-row__control"><select class="settings-select" id="voiceSttProviderId"></select></div>
    </div>
    <div class="settings-row models-voice-field">
      <div class="settings-row__label"><label class="settings-row__title" for="voiceSttProviderModel">Model</label></div>
      <div class="settings-row__control"><input class="settings-input" id="voiceSttProviderModel" type="text" /></div>
    </div>
    <div class="settings-row models-voice-field">
      <div class="settings-row__label"><label class="settings-row__title" for="voiceSttProviderLanguage">Language</label></div>
      <div class="settings-row__control"><input class="settings-input" id="voiceSttProviderLanguage" type="text" /></div>
    </div>
  `;
  mount.appendChild(providerPanel);

  const localPanel = document.createElement('div');
  localPanel.className = 'models-voice-local-panel';
  localPanel.id = 'modelsVoiceSttLocalPanel';
  localPanel.hidden = config.stt.backend !== 'local';

  const composerMic = document.createElement('fieldset');
  composerMic.className = 'models-voice-fieldset';
  const composerLegend = document.createElement('legend');
  composerLegend.textContent = 'Composer mic';
  composerMic.appendChild(composerLegend);
  for (const spec of COMPOSER_MIC_FIELDS) {
    renderField(spec, config.stt.local, catalogEntry, composerMic);
  }
  localPanel.appendChild(composerMic);

  const basic = document.createElement('fieldset');
  basic.className = 'models-voice-fieldset';
  const basicLegend = document.createElement('legend');
  basicLegend.textContent = 'Decoding';
  basic.appendChild(basicLegend);
  for (const spec of BASIC_FIELDS) {
    renderField(spec, config.stt.local, catalogEntry, basic);
  }
  localPanel.appendChild(basic);

  const advanced = document.createElement('fieldset');
  advanced.className = 'models-voice-fieldset models-voice-fieldset--advanced';
  const advLegend = document.createElement('legend');
  advLegend.textContent = 'Advanced';
  advanced.appendChild(advLegend);
  for (const spec of ADVANCED_FIELDS) {
    renderField(spec, config.stt.local, catalogEntry, advanced);
  }
  localPanel.appendChild(advanced);

  mount.appendChild(localPanel);
}

/** Sync provider panel values from config. */
export function fillSttProviderPanel(config: VoiceConfig): void {
  const providerSelect = document.getElementById('voiceSttProviderId') as HTMLSelectElement | null;
  const modelInput = document.getElementById('voiceSttProviderModel') as HTMLInputElement | null;
  const langInput = document.getElementById('voiceSttProviderLanguage') as HTMLInputElement | null;
  if (providerSelect) providerSelect.value = config.stt.provider.providerId;
  if (modelInput) modelInput.value = config.stt.provider.model;
  if (langInput) langInput.value = config.stt.provider.language;
}

/** Read provider fields from the STT provider panel. */
export function readSttProviderFromForm(config: VoiceConfig): VoiceConfig['stt']['provider'] {
  const providerSelect = document.getElementById('voiceSttProviderId') as HTMLSelectElement | null;
  const modelInput = document.getElementById('voiceSttProviderModel') as HTMLInputElement | null;
  const langInput = document.getElementById('voiceSttProviderLanguage') as HTMLInputElement | null;
  return {
    ...config.stt.provider,
    providerId: providerSelect?.value?.trim() ?? config.stt.provider.providerId,
    model: modelInput?.value?.trim() ?? config.stt.provider.model,
    language: langInput?.value?.trim() ?? config.stt.provider.language,
  };
}

/** Toggle local vs provider panels after backend change. */
export function setSttBackendUi(backend: 'builtin' | 'local' | 'provider'): void {
  document.getElementById('modelsVoiceSttBuiltinHint')?.toggleAttribute('hidden', backend !== 'builtin');
  const providerPanel = document.getElementById('modelsVoiceSttProviderPanel');
  const localPanel = document.getElementById('modelsVoiceSttLocalPanel');
  providerPanel?.toggleAttribute('hidden', backend !== 'provider');
  localPanel?.toggleAttribute('hidden', backend !== 'local');
  for (const input of document.querySelectorAll<HTMLInputElement>('input[name="voiceSttBackend"]')) {
    const active = input.value === backend;
    input.checked = active;
    input.closest('label')?.classList.toggle('is-active', active);
  }
}

// ── TTS form ─────────────────────────────────────────────────────────────────

type TtsBackend = 'local' | 'provider' | 'browser';

interface TtsFieldSpec {
  id: string;
  label: string;
  type: 'text' | 'number' | 'select' | 'checkbox' | 'file';
  options?: Array<{ value: string; label: string }>;
  min?: number;
  max?: number;
  step?: number;
  hint?: string;
  panel?: 'customVoice' | 'voiceDesign' | 'voiceClone' | 'generation' | 'runtime' | 'streaming';
  readOnly?: boolean;
}

function ttsFieldId(id: string): string {
  return `voiceTts_${id}`;
}

function renderTtsControl(spec: TtsFieldSpec, value: unknown, mount: HTMLElement): void {
  if (spec.type === 'checkbox') {
    const { row, input } = createSettingsToggleRow(spec.label, {
      id: ttsFieldId(spec.id),
      checked: Boolean(value),
      description: spec.hint,
    });
    input.dataset.voiceTtsKey = spec.id;
    row.classList.add('models-voice-field');
    if (spec.panel) row.dataset.ttsPanel = spec.panel;
    mount.appendChild(row);
    return;
  }

  const wrap = document.createElement('div');
  wrap.className = 'settings-row models-voice-field';
  wrap.dataset.ttsPanel = spec.panel ?? '';

  const labelCol = document.createElement('div');
  labelCol.className = 'settings-row__label';
  const label = document.createElement('label');
  label.className = 'settings-row__title';
  label.htmlFor = ttsFieldId(spec.id);
  label.textContent = spec.label;
  labelCol.appendChild(label);
  if (spec.hint) {
    const desc = document.createElement('span');
    desc.className = 'settings-row__desc';
    desc.textContent = spec.hint;
    labelCol.appendChild(desc);
  }
  wrap.appendChild(labelCol);

  const controlWrap = document.createElement('div');
  controlWrap.className = 'settings-row__control';

  let control: HTMLInputElement | HTMLSelectElement;
  if (spec.type === 'select') {
    const select = document.createElement('select');
    select.className = 'settings-select';
    for (const opt of spec.options ?? []) {
      const option = document.createElement('option');
      option.value = opt.value;
      option.textContent = opt.label;
      if (String(value) === opt.value) option.selected = true;
      select.appendChild(option);
    }
    control = select;
  } else if (spec.type === 'file') {
    const fileInput = document.createElement('input');
    fileInput.className = 'settings-input';
    fileInput.type = 'file';
    fileInput.accept = 'audio/*';
    control = fileInput;
  } else {
    const textInput = document.createElement('input');
    textInput.className = 'settings-input';
    textInput.type = spec.type;
    if (spec.type === 'number') {
      if (spec.min != null) textInput.min = String(spec.min);
      if (spec.max != null) textInput.max = String(spec.max);
      if (spec.step != null) textInput.step = String(spec.step);
    }
    textInput.value = String(value ?? '');
    if (spec.readOnly) textInput.readOnly = true;
    control = textInput;
  }

  control.id = ttsFieldId(spec.id);
  control.dataset.voiceTtsKey = spec.id;
  controlWrap.appendChild(control);
  wrap.appendChild(controlWrap);

  mount.appendChild(wrap);
}

function setTtsModePanels(mode: VoiceTtsLocalConfig['mode']): void {
  for (const panel of document.querySelectorAll('[data-tts-mode-panel]')) {
    const el = panel as HTMLElement;
    el.hidden = el.dataset.ttsModePanel !== mode;
  }
}

export interface RenderTtsSettingsFormOptions {
  mount: HTMLElement;
  config: VoiceConfig;
  catalogEntry?: TtsCatalogEntry;
  clonePrompts?: Array<{ id: string; label: string }>;
  onBackendChange?: (backend: TtsBackend) => void;
  onModeChange?: (mode: VoiceTtsLocalConfig['mode']) => void;
}

/** Render backend toggle + mode-gated TTS settings groups. */
export function renderTtsSettingsForm(options: RenderTtsSettingsFormOptions): void {
  const { mount, config, catalogEntry, clonePrompts, onBackendChange, onModeChange } = options;
  mount.replaceChildren();

  const { row: backendRow } = createSettingsRadioRow('Backend', {
    name: 'voiceTtsBackend',
    options: [
      { value: 'local', label: 'Local' },
      { value: 'provider', label: 'External API' },
      { value: 'browser', label: 'System voice' },
    ],
    value: config.tts.backend,
    onChange: (value) => onBackendChange?.(value as TtsBackend),
    searchKey: 'models.voice.tts.backend',
  });
  mount.appendChild(backendRow);

  const providerPanel = document.createElement('div');
  providerPanel.id = 'modelsVoiceTtsProviderPanel';
  providerPanel.hidden = config.tts.backend !== 'provider';
  providerPanel.innerHTML = `
    <div class="settings-row models-voice-field">
      <div class="settings-row__label"><label class="settings-row__title" for="voiceTtsProviderId">Provider</label></div>
      <div class="settings-row__control"><select class="settings-select" id="voiceTtsProviderId"></select></div>
    </div>
    <div class="settings-row models-voice-field">
      <div class="settings-row__label"><label class="settings-row__title" for="voiceTtsProviderModel">Model</label></div>
      <div class="settings-row__control"><input class="settings-input" id="voiceTtsProviderModel" type="text" /></div>
    </div>
    <div class="settings-row models-voice-field">
      <div class="settings-row__label"><label class="settings-row__title" for="voiceTtsProviderVoice">Voice</label></div>
      <div class="settings-row__control"><input class="settings-input" id="voiceTtsProviderVoice" type="text" /></div>
    </div>
    <div class="settings-row models-voice-field">
      <div class="settings-row__label"><label class="settings-row__title" for="voiceTtsProviderSpeed">Speed</label></div>
      <div class="settings-row__control"><input class="settings-input" id="voiceTtsProviderSpeed" type="number" min="0.25" max="4" step="0.05" /></div>
    </div>
    <div class="settings-row models-voice-field">
      <div class="settings-row__label"><label class="settings-row__title" for="voiceTtsProviderFormat">Format</label></div>
      <div class="settings-row__control"><select class="settings-select" id="voiceTtsProviderFormat">
        <option value="mp3">mp3</option>
        <option value="wav">wav</option>
        <option value="opus">opus</option>
        <option value="aac">aac</option>
        <option value="flac">flac</option>
      </select></div>
    </div>
  `;
  mount.appendChild(providerPanel);

  const browserPanel = document.createElement('div');
  browserPanel.id = 'modelsVoiceTtsBrowserPanel';
  browserPanel.hidden = config.tts.backend !== 'browser';
  browserPanel.innerHTML = `
    <div class="settings-row models-voice-field">
      <div class="settings-row__label"><label class="settings-row__title" for="voiceTtsBrowserVoice">speechSynthesis voice</label></div>
      <div class="settings-row__control"><select class="settings-select" id="voiceTtsBrowserVoice"></select></div>
    </div>
    <div class="settings-row models-voice-field">
      <div class="settings-row__label"><label class="settings-row__title" for="voiceTtsBrowserRate">Rate</label></div>
      <div class="settings-row__control"><input class="settings-input" id="voiceTtsBrowserRate" type="number" min="0.25" max="4" step="0.05" /></div>
    </div>
    <div class="settings-row models-voice-field">
      <div class="settings-row__label"><label class="settings-row__title" for="voiceTtsBrowserPitch">Pitch</label></div>
      <div class="settings-row__control"><input class="settings-input" id="voiceTtsBrowserPitch" type="number" min="0" max="2" step="0.05" /></div>
    </div>
    <div class="settings-row models-voice-field">
      <div class="settings-row__label"><label class="settings-row__title" for="voiceTtsBrowserVolume">Volume</label></div>
      <div class="settings-row__control"><input class="settings-input" id="voiceTtsBrowserVolume" type="number" min="0" max="1" step="0.05" /></div>
    </div>
  `;
  mount.appendChild(browserPanel);

  const localPanel = document.createElement('div');
  localPanel.id = 'modelsVoiceTtsLocalPanel';
  localPanel.hidden = config.tts.backend !== 'local';

  const runtime = document.createElement('fieldset');
  runtime.className = 'models-voice-fieldset';
  runtime.dataset.ttsModePanel = 'runtime';
  runtime.appendChild(Object.assign(document.createElement('legend'), { textContent: 'Runtime' }));
  const speakers = catalogEntry?.speakers ?? [];
  renderTtsControl(
    {
      id: 'modelId',
      label: 'Model',
      type: 'text',
      panel: 'runtime',
      readOnly: true,
    },
    config.tts.local.modelId,
    runtime,
  );
  renderTtsControl(
    {
      id: 'deviceMap',
      label: 'Device map',
      type: 'select',
      panel: 'runtime',
      options: [
        { value: 'auto', label: 'Auto' },
        { value: 'cuda:0', label: 'CUDA GPU' },
        { value: 'cpu', label: 'CPU' },
      ],
    },
    config.tts.local.deviceMap,
    runtime,
  );
  renderTtsControl(
    {
      id: 'dtype',
      label: 'Dtype',
      type: 'select',
      panel: 'runtime',
      options: [
        { value: 'auto', label: 'Auto' },
        { value: 'bfloat16', label: 'bfloat16' },
        { value: 'float16', label: 'float16' },
        { value: 'float32', label: 'float32' },
      ],
    },
    config.tts.local.dtype,
    runtime,
  );
  renderTtsControl(
    {
      id: 'attnImplementation',
      label: 'Attention',
      type: 'select',
      panel: 'runtime',
      options: [
        { value: 'auto', label: 'Auto' },
        { value: 'flash_attention_2', label: 'Flash Attention 2' },
        { value: 'sdpa', label: 'SDPA' },
        { value: 'eager', label: 'Eager' },
      ],
    },
    config.tts.local.attnImplementation,
    runtime,
  );
  const streamingRow = document.createElement('div');
  streamingRow.className = 'settings-row models-voice-field';
  streamingRow.innerHTML = `
    <div class="settings-row__label"><label class="settings-row__title" for="voiceTtsStreaming">Streaming</label></div>
    <div class="settings-row__control"><input type="checkbox" id="voiceTtsStreaming" ${config.tts.streaming ? 'checked' : ''} /></div>
  `;
  runtime.appendChild(streamingRow);
  localPanel.appendChild(runtime);

  const modePanel = document.createElement('div');
  modePanel.className = 'settings-row models-voice-field';
  const modeLabel = document.createElement('div');
  modeLabel.className = 'settings-row__label';
  const modeLabelText = document.createElement('label');
  modeLabelText.className = 'settings-row__title';
  modeLabelText.htmlFor = 'voiceTtsMode';
  modeLabelText.textContent = 'Mode';
  modeLabel.appendChild(modeLabelText);
  modePanel.appendChild(modeLabel);
  const modeControl = document.createElement('div');
  modeControl.className = 'settings-row__control';
  const modeSelect = document.createElement('select');
  modeSelect.id = 'voiceTtsMode';
  modeSelect.className = 'settings-select';
  for (const value of ['custom_voice', 'voice_design', 'voice_clone'] as const) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent =
      value === 'custom_voice'
        ? 'Custom voice'
        : value === 'voice_design'
          ? 'Voice design'
          : 'Voice clone';
    if (config.tts.local.mode === value) opt.selected = true;
    modeSelect.appendChild(opt);
  }
  modeSelect.addEventListener('change', () => {
    const mode = modeSelect.value as VoiceTtsLocalConfig['mode'];
    setTtsModePanels(mode);
    onModeChange?.(mode);
  });
  modeControl.appendChild(modeSelect);
  modePanel.appendChild(modeControl);
  localPanel.appendChild(modePanel);

  const customPanel = document.createElement('fieldset');
  customPanel.className = 'models-voice-fieldset';
  customPanel.dataset.ttsModePanel = 'custom_voice';
  customPanel.appendChild(Object.assign(document.createElement('legend'), { textContent: 'Custom voice' }));
  renderTtsControl(
    {
      id: 'customVoice.speaker',
      label: 'Speaker',
      type: speakers.length ? 'select' : 'text',
      panel: 'customVoice',
      options: speakers.map((s) => ({ value: s, label: s })),
    },
    config.tts.local.customVoice.speaker,
    customPanel,
  );
  renderTtsControl(
    { id: 'customVoice.language', label: 'Language', type: 'text', panel: 'customVoice' },
    config.tts.local.customVoice.language,
    customPanel,
  );
  if (catalogEntry?.instructControl) {
    renderTtsControl(
      {
        id: 'customVoice.instruct',
        label: 'Instruct',
        type: 'text',
        panel: 'customVoice',
        hint: 'Style control (1.7B CustomVoice only)',
      },
      config.tts.local.customVoice.instruct,
      customPanel,
    );
  }
  localPanel.appendChild(customPanel);

  const designPanel = document.createElement('fieldset');
  designPanel.className = 'models-voice-fieldset';
  designPanel.dataset.ttsModePanel = 'voice_design';
  designPanel.appendChild(Object.assign(document.createElement('legend'), { textContent: 'Voice design' }));
  renderTtsControl(
    { id: 'voiceDesign.language', label: 'Language', type: 'text', panel: 'voiceDesign' },
    config.tts.local.voiceDesign.language,
    designPanel,
  );
  renderTtsControl(
    {
      id: 'voiceDesign.instruct',
      label: 'Instruct',
      type: 'text',
      panel: 'voiceDesign',
      hint: 'Natural-language voice description (required)',
    },
    config.tts.local.voiceDesign.instruct,
    designPanel,
  );
  localPanel.appendChild(designPanel);

  const clonePanel = document.createElement('fieldset');
  clonePanel.className = 'models-voice-fieldset';
  clonePanel.dataset.ttsModePanel = 'voice_clone';
  clonePanel.appendChild(Object.assign(document.createElement('legend'), { textContent: 'Voice clone' }));
  renderTtsControl(
    {
      id: 'voiceClone.refAudioUpload',
      label: 'Reference audio',
      type: 'file',
      panel: 'voiceClone',
      hint: 'Upload 3+ seconds of reference speech',
    },
    '',
    clonePanel,
  );
  renderTtsControl(
    { id: 'voiceClone.refAudioPath', label: 'Saved ref path', type: 'text', panel: 'voiceClone', readOnly: true },
    config.tts.local.voiceClone.refAudioPath,
    clonePanel,
  );
  renderTtsControl(
    { id: 'voiceClone.refText', label: 'Reference transcript', type: 'text', panel: 'voiceClone' },
    config.tts.local.voiceClone.refText,
    clonePanel,
  );
  renderTtsControl(
    {
      id: 'voiceClone.xVectorOnlyMode',
      label: 'X-vector only mode',
      type: 'checkbox',
      panel: 'voiceClone',
    },
    config.tts.local.voiceClone.xVectorOnlyMode,
    clonePanel,
  );
  renderTtsControl(
    { id: 'voiceClone.language', label: 'Language', type: 'text', panel: 'voiceClone' },
    config.tts.local.voiceClone.language,
    clonePanel,
  );
  const promptRow = document.createElement('div');
  promptRow.className = 'settings-row models-voice-field';
  const promptLabelCol = document.createElement('div');
  promptLabelCol.className = 'settings-row__label';
  const promptLabel = document.createElement('label');
  promptLabel.className = 'settings-row__title';
  promptLabel.htmlFor = 'voiceClone.savedPromptId';
  promptLabel.textContent = 'Saved prompt';
  promptLabelCol.appendChild(promptLabel);
  promptRow.appendChild(promptLabelCol);
  const promptControl = document.createElement('div');
  promptControl.className = 'settings-row__control';
  const promptSelect = document.createElement('select');
  promptSelect.id = 'voiceClone.savedPromptId';
  promptSelect.className = 'settings-select';
  const emptyOpt = document.createElement('option');
  emptyOpt.value = '';
  emptyOpt.textContent = 'None';
  promptSelect.appendChild(emptyOpt);
  for (const prompt of clonePrompts ?? []) {
    const opt = document.createElement('option');
    opt.value = prompt.id;
    opt.textContent = prompt.label;
    if (config.tts.local.voiceClone.savedPromptId === prompt.id) opt.selected = true;
    promptSelect.appendChild(opt);
  }
  promptControl.appendChild(promptSelect);
  promptRow.appendChild(promptControl);
  clonePanel.appendChild(promptRow);
  localPanel.appendChild(clonePanel);

  const generation = document.createElement('fieldset');
  generation.className = 'models-voice-fieldset models-voice-fieldset--advanced';
  generation.appendChild(Object.assign(document.createElement('legend'), { textContent: 'Generation (advanced)' }));
  renderTtsControl(
    { id: 'generation.maxNewTokens', label: 'Max new tokens', type: 'number', min: 256, max: 4096, step: 1, panel: 'generation' },
    config.tts.local.generation.maxNewTokens,
    generation,
  );
  renderTtsControl(
    { id: 'generation.topP', label: 'Top P', type: 'number', min: 0, max: 1, step: 0.05, panel: 'generation' },
    config.tts.local.generation.topP,
    generation,
  );
  renderTtsControl(
    { id: 'generation.topK', label: 'Top K', type: 'number', min: 1, max: 200, step: 1, panel: 'generation' },
    config.tts.local.generation.topK,
    generation,
  );
  renderTtsControl(
    { id: 'generation.temperature', label: 'Temperature', type: 'number', min: 0, max: 2, step: 0.05, panel: 'generation' },
    config.tts.local.generation.temperature,
    generation,
  );
  renderTtsControl(
    { id: 'generation.repetitionPenalty', label: 'Repetition penalty', type: 'number', min: 0.5, max: 2, step: 0.05, panel: 'generation' },
    config.tts.local.generation.repetitionPenalty,
    generation,
  );
  localPanel.appendChild(generation);

  const streaming = document.createElement('fieldset');
  streaming.className = 'models-voice-fieldset models-voice-fieldset--advanced';
  streaming.appendChild(
    Object.assign(document.createElement('legend'), { textContent: 'Advanced streaming' }),
  );
  renderTtsControl(
    {
      id: 'streaming.emitEveryFrames',
      label: 'Emit every frames',
      type: 'number',
      min: 1,
      max: 32,
      step: 1,
      panel: 'streaming',
      hint: 'PCM chunk cadence during stable-phase decode',
    },
    config.tts.local.streaming.emitEveryFrames,
    streaming,
  );
  renderTtsControl(
    {
      id: 'streaming.decodeWindowFrames',
      label: 'Decode window frames',
      type: 'number',
      min: 16,
      max: 256,
      step: 1,
      panel: 'streaming',
    },
    config.tts.local.streaming.decodeWindowFrames,
    streaming,
  );
  renderTtsControl(
    {
      id: 'streaming.firstChunkEmitEvery',
      label: 'First chunk emit every',
      type: 'number',
      min: 1,
      max: 32,
      step: 1,
      panel: 'streaming',
      hint: 'Faster first audible chunk (two-phase streaming)',
    },
    config.tts.local.streaming.firstChunkEmitEvery,
    streaming,
  );
  renderTtsControl(
    {
      id: 'streaming.firstChunkDecodeWindow',
      label: 'First chunk decode window',
      type: 'number',
      min: 16,
      max: 256,
      step: 1,
      panel: 'streaming',
    },
    config.tts.local.streaming.firstChunkDecodeWindow,
    streaming,
  );
  renderTtsControl(
    {
      id: 'streaming.overlapSamples',
      label: 'Overlap samples',
      type: 'number',
      min: 0,
      max: 4096,
      step: 64,
      panel: 'streaming',
      hint: 'Crossfade overlap between PCM chunks',
    },
    config.tts.local.streaming.overlapSamples,
    streaming,
  );
  renderTtsControl(
    {
      id: 'streaming.repetitionPenalty',
      label: 'Streaming repetition penalty',
      type: 'number',
      min: 0.5,
      max: 2,
      step: 0.05,
      panel: 'streaming',
    },
    config.tts.local.streaming.repetitionPenalty,
    streaming,
  );
  localPanel.appendChild(streaming);

  mount.appendChild(localPanel);
  setTtsModePanels(config.tts.local.mode);
}

// ── TTS readback ─────────────────────────────────────────────────────────────

function readTtsNestedValue(
  local: VoiceTtsLocalConfig,
  key: string,
): unknown {
  if (key === 'modelId') return local.modelId;
  if (key === 'deviceMap') return local.deviceMap;
  if (key === 'dtype') return local.dtype;
  if (key === 'attnImplementation') return local.attnImplementation;
  const parts = key.split('.');
  if (parts.length === 2) {
    const [group, field] = parts as [keyof VoiceTtsLocalConfig, string];
    const section = local[group];
    if (section && typeof section === 'object' && field in section) {
      return (section as unknown as Record<string, unknown>)[field];
    }
  }
  return undefined;
}

function setTtsNestedValue(local: VoiceTtsLocalConfig, key: string, value: unknown): void {
  if (key === 'modelId' && typeof value === 'string') local.modelId = value;
  else if (key === 'deviceMap' && typeof value === 'string') local.deviceMap = value as VoiceTtsLocalConfig['deviceMap'];
  else if (key === 'dtype' && typeof value === 'string') local.dtype = value as VoiceTtsLocalConfig['dtype'];
  else if (key === 'attnImplementation' && typeof value === 'string') {
    local.attnImplementation = value as VoiceTtsLocalConfig['attnImplementation'];
  } else {
    const parts = key.split('.');
    if (parts.length === 2) {
      const [group, field] = parts;
      if (group === 'customVoice' || group === 'voiceDesign' || group === 'voiceClone' || group === 'generation' || group === 'streaming') {
        (local[group] as unknown as Record<string, unknown>)[field] = value;
      }
    }
  }
}

/** Read local TTS config from rendered form controls. */
export function readTtsLocalFromForm(base: VoiceTtsLocalConfig): VoiceTtsLocalConfig {
  const out = structuredClone(base);
  for (const el of document.querySelectorAll('[data-voice-tts-key]')) {
    const key = (el as HTMLElement).dataset.voiceTtsKey;
    if (!key || key === 'voiceClone.refAudioUpload') continue;
    let value: unknown;
    if (el instanceof HTMLInputElement && el.type === 'checkbox') value = el.checked;
    else if (el instanceof HTMLInputElement && el.type === 'number') {
      const n = Number(el.value);
      value = Number.isFinite(n) ? n : readTtsNestedValue(out, key);
    } else value = (el as HTMLInputElement | HTMLSelectElement).value;
    setTtsNestedValue(out, key, value);
  }
  const modeSelect = document.getElementById('voiceTtsMode') as HTMLSelectElement | null;
  if (modeSelect?.value === 'custom_voice' || modeSelect?.value === 'voice_design' || modeSelect?.value === 'voice_clone') {
    out.mode = modeSelect.value;
  }
  const promptSelect = document.getElementById('voiceClone.savedPromptId') as HTMLSelectElement | null;
  if (promptSelect) out.voiceClone.savedPromptId = promptSelect.value;
  return out;
}

export function fillTtsProviderPanel(config: VoiceConfig): void {
  const providerSelect = document.getElementById('voiceTtsProviderId') as HTMLSelectElement | null;
  const modelInput = document.getElementById('voiceTtsProviderModel') as HTMLInputElement | null;
  const voiceInput = document.getElementById('voiceTtsProviderVoice') as HTMLInputElement | null;
  const speedInput = document.getElementById('voiceTtsProviderSpeed') as HTMLInputElement | null;
  const formatSelect = document.getElementById('voiceTtsProviderFormat') as HTMLSelectElement | null;
  if (providerSelect) providerSelect.value = config.tts.provider.providerId;
  if (modelInput) modelInput.value = config.tts.provider.model;
  if (voiceInput) voiceInput.value = config.tts.provider.voice;
  if (speedInput) speedInput.value = String(config.tts.provider.speed);
  if (formatSelect) formatSelect.value = config.tts.provider.format;
}

export function fillTtsBrowserPanel(config: VoiceConfig): void {
  const voiceSelect = document.getElementById('voiceTtsBrowserVoice') as HTMLSelectElement | null;
  const rateInput = document.getElementById('voiceTtsBrowserRate') as HTMLInputElement | null;
  const pitchInput = document.getElementById('voiceTtsBrowserPitch') as HTMLInputElement | null;
  const volumeInput = document.getElementById('voiceTtsBrowserVolume') as HTMLInputElement | null;
  if (rateInput) rateInput.value = String(config.tts.browser.rate);
  if (pitchInput) pitchInput.value = String(config.tts.browser.pitch);
  if (volumeInput) volumeInput.value = String(config.tts.browser.volume);
  if (!voiceSelect) return;
  voiceSelect.replaceChildren();
  const defaultOpt = document.createElement('option');
  defaultOpt.value = '';
  defaultOpt.textContent = 'System default';
  voiceSelect.appendChild(defaultOpt);
  if ('speechSynthesis' in window) {
    for (const voice of window.speechSynthesis.getVoices()) {
      const opt = document.createElement('option');
      opt.value = voice.voiceURI;
      opt.textContent = `${voice.name} (${voice.lang})`;
      voiceSelect.appendChild(opt);
    }
  }
  if (config.tts.browser.voiceUri) voiceSelect.value = config.tts.browser.voiceUri;
}

export function readTtsProviderFromForm(config: VoiceConfig): VoiceConfig['tts']['provider'] {
  const providerSelect = document.getElementById('voiceTtsProviderId') as HTMLSelectElement | null;
  const modelInput = document.getElementById('voiceTtsProviderModel') as HTMLInputElement | null;
  const voiceInput = document.getElementById('voiceTtsProviderVoice') as HTMLInputElement | null;
  const speedInput = document.getElementById('voiceTtsProviderSpeed') as HTMLInputElement | null;
  const formatSelect = document.getElementById('voiceTtsProviderFormat') as HTMLSelectElement | null;
  return {
    ...config.tts.provider,
    providerId: providerSelect?.value?.trim() ?? config.tts.provider.providerId,
    model: modelInput?.value?.trim() ?? config.tts.provider.model,
    voice: voiceInput?.value?.trim() ?? config.tts.provider.voice,
    speed: Number(speedInput?.value) || config.tts.provider.speed,
    format: (formatSelect?.value as VoiceConfig['tts']['provider']['format']) ?? config.tts.provider.format,
  };
}

export function readTtsBrowserFromForm(config: VoiceConfig): VoiceConfig['tts']['browser'] {
  const voiceSelect = document.getElementById('voiceTtsBrowserVoice') as HTMLSelectElement | null;
  const rateInput = document.getElementById('voiceTtsBrowserRate') as HTMLInputElement | null;
  const pitchInput = document.getElementById('voiceTtsBrowserPitch') as HTMLInputElement | null;
  const volumeInput = document.getElementById('voiceTtsBrowserVolume') as HTMLInputElement | null;
  return {
    ...config.tts.browser,
    voiceUri: voiceSelect?.value ?? config.tts.browser.voiceUri,
    rate: Number(rateInput?.value) || config.tts.browser.rate,
    pitch: Number(pitchInput?.value) || config.tts.browser.pitch,
    volume: Number(volumeInput?.value) || config.tts.browser.volume,
  };
}

export function setTtsBackendUi(backend: TtsBackend): void {
  document.getElementById('modelsVoiceTtsProviderPanel')?.toggleAttribute('hidden', backend !== 'provider');
  document.getElementById('modelsVoiceTtsBrowserPanel')?.toggleAttribute('hidden', backend !== 'browser');
  document.getElementById('modelsVoiceTtsLocalPanel')?.toggleAttribute('hidden', backend !== 'local');
  for (const input of document.querySelectorAll<HTMLInputElement>('input[name="voiceTtsBackend"]')) {
    const active = input.value === backend;
    input.checked = active;
    input.closest('label')?.classList.toggle('is-active', active);
  }
}

/** Return the ref-audio file input if the user selected a new upload. */
export function getTtsRefAudioUpload(): File | null {
  const el = document.getElementById(ttsFieldId('voiceClone.refAudioUpload')) as HTMLInputElement | null;
  const file = el?.files?.[0];
  return file ?? null;
}


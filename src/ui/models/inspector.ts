import { renderModelEngineSettings } from './mtplx-load';
import {
  getLibrarySamplerForId,
  loadLibraryInferencePrefs,
  saveLibraryInferenceSampler,
} from '../../config/library-inference-meta';
import {
  estimateLoadDurationMs,
  getLibraryLaunchSettingsForId,
  llamaSettingsFromLaunchPrefs,
  loadLibraryLaunchPrefs,
  saveLibraryLaunchSettings,
} from '../../config/library-launch-meta';
import {
  fetchGgufGeometry,
  fetchLlamaRuntime,
  LLAMA_ENGINE_CHANGED_EVENT,
  type GgufGeometryFacts,
  type LlamaServeSettings,
  type ServeRecord,
} from '../../models/api-client';
import {
  joinDeviceList,
  joinTensorSplit,
  parseDeviceList,
  parseTensorSplit,
  resolveLlamaDeviceInventory,
  tensorSplitPercents,
  toggleDeviceSelection,
  vramProportionalSplit,
  type LlamaGpuDevice,
} from '../../models/llama-devices.mjs';
import { mlxLoadedWithRows } from '../../models/mlx-loaded-with';
import { buildSamplerFieldInputs } from '../settings-sampler-fields';
import {
  estimateServeMemory,
  estimateTransformerLayerCount,
} from '../../models/serve-memory-estimate';
import { renderLaunchMemoryMeter } from './launch-memory-meter';
import { joinArgv, tokenizeArgv } from '../../models/argv-tokenize.mjs';
import {
  applyCacheTypeSideTouch,
  applyCacheTypeTouch,
  launchValidationError,
  applyCtxPerSlotTouch,
  applyGpuLayersAuto,
  applyGpuLayersTouch,
  applyPassThroughTouch,
  CONTEXT_SLIDER_MIN,
  CONTEXT_SLIDER_STEP,
  contextSliderMax,
  displayedLaunchFrom,
  inspectorLaunchPlan,
  settingsForDraft,
  snapCtxPerSlot,
  type DisplayedLaunch,
} from './inspector-launch';
import { capabilityLabel, type LibraryModel } from '../../models/library';
import { setStatus } from '../status';
import {
  chip,
  copyField,
  el,
  emptyState,
  formatBytes,
  formatContext,
  formatParams,
  icon,
  textButton,
} from './dom';
import { setModelsInspectorOpen } from './inspector-visibility';
import { ensureRuntimeForModel } from './runtime-install-prompt';
import { serveFailureBlock } from './serve-failure-view';
import {
  getInspectedServe,
  getModelsState,
  getSelectedModel,
  libraryModelForServe,
  loadModel,
  selectModel,
  selectServe,
  serveForModel,
  subscribeModelsStore,
  unloadServe,
} from './store';
import { isRetryableServeStatus, retryLabelForServe, settingsForServeRetry } from '../../models/serve-status';

type InspectorTab = 'info' | 'load' | 'inference';

const TAB_LABELS: Record<InspectorTab, { label: string; glyph: string }> = {
  info: { label: 'Info', glyph: 'list' },
  load: { label: 'Load', glyph: 'inbox-in' },
  inference: { label: 'Inference', glyph: 'chart-simple' },
};

let activeTab: InspectorTab = 'info';
let bound = false;
let inspectorRenderRaf: number | null = null;
/** Store / GGUF / runtime updates that arrived while a launch slider still had focus. */
let inspectorRenderDeferred = false;
/** Per-model launch settings, kept while the app is open. Empty = auto (server planner). */
const draftSettings = new Map<string, LlamaServeSettings>();
/** Slider `input` fires every tick — debounce PUT so we do not hammer config.json. */
const launchSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();
const LAUNCH_SAVE_DEBOUNCE_MS = 300;

let llamaVariant: string | null = null;
let llamaVariantFetched = false;
/** `--cache-type-k` values the active engine accepts beyond upstream's (turbo3 adds turbo2/3/4). */
let llamaExtraKvTypes: string[] = [];
let llamaEngineLabel = 'llama.cpp';
/** Active engine runs different K and V types without dropping prefill onto the CPU. */
let llamaAsymmetricKv = false;
/** GPU inventory from `--list-devices` or hardware fallback. */
let llamaDeviceInventory: LlamaGpuDevice[] = [];
/** Which advanced Load-tab groups are open, kept across re-renders after a slider touch. */
/** Memory and Sampling match the LM Studio default: open on first visit. */
const loadSectionOpen = new Set<string>(['memory', 'sampling']);

/** `--cache-type-k/v` values, ordered largest to smallest. */
const KV_CACHE_TYPE_OPTIONS = [
  { value: 'f32', label: 'f32 — full float' },
  { value: 'f16', label: 'f16 — full precision' },
  { value: 'bf16', label: 'bf16' },
  { value: 'q8_0', label: 'q8_0 — balanced' },
  { value: 'q5_1', label: 'q5_1' },
  { value: 'q5_0', label: 'q5_0' },
  { value: 'q4_1', label: 'q4_1' },
  { value: 'q4_0', label: 'q4_0 — smaller' },
  { value: 'iq4_nl', label: 'iq4_nl' },
];

/** Extra KV types from the active fork, labelled with the engine that provides them. */
function extraKvOptions(): Array<{ value: string; label: string }> {
  return llamaExtraKvTypes.map((value) => ({ value, label: `${value} — ${llamaEngineLabel}` }));
}

/** Idle unload windows. `''` inherits the 20-minute default; `0` keeps it loaded. */
const IDLE_TTL_OPTIONS = [
  { value: '', label: 'Default (20 minutes)' },
  { value: '0', label: 'Never — keep loaded' },
  { value: String(5 * 60_000), label: '5 minutes' },
  { value: String(10 * 60_000), label: '10 minutes' },
  { value: String(30 * 60_000), label: '30 minutes' },
  { value: String(60 * 60_000), label: '1 hour' },
];

/** `--spec-type` modes worth exposing. */
const SPEC_TYPE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'none', label: 'Off' },
  { value: 'draft-mtp', label: 'MTP — heads inside these weights' },
  { value: 'draft-simple', label: 'Draft model' },
  { value: 'draft-eagle3', label: 'Draft model (EAGLE-3)' },
  { value: 'ngram-simple', label: 'N-gram — from the prompt' },
  { value: 'ngram-mod', label: 'N-gram (mod)' },
];

/** Selected option value for the idle-unload select — `''` when nothing is pinned. */
function idleTtlValue(draft: LlamaServeSettings | undefined): string {
  return draft?.idle_ttl_ms == null ? '' : String(draft.idle_ttl_ms);
}

const ggufGeometry = new Map<string, GgufGeometryFacts | null>();
const ggufGeometryPending = new Set<string>();

/** Models → Engine switched binaries: re-read variant, devices and KV types on the next render. */
if (typeof window !== 'undefined') {
  window.addEventListener(LLAMA_ENGINE_CHANGED_EVENT, () => {
    llamaVariantFetched = false;
    scheduleInspectorRender();
  });
}

/** Installed variant when known, else the hardware probe — see comment on `llamaVariant`. */
function ensureLlamaVariant(): string | null {
  if (!llamaVariantFetched) {
    llamaVariantFetched = true;
    void fetchLlamaRuntime()
      .then((status) => {
        llamaVariant = status.variant;
        llamaDeviceInventory = Array.isArray(status.devices) ? status.devices : [];
        const known = new Set(KV_CACHE_TYPE_OPTIONS.map((o) => o.value));
        llamaExtraKvTypes = (status.kvCacheTypes ?? []).filter((t) => !known.has(t));
        llamaEngineLabel = status.engineLabel ?? 'llama.cpp';
        llamaAsymmetricKv = status.asymmetricKv === true;
      })
      .catch(() => {
        llamaVariant = null;
      })
      .finally(() => {
        scheduleInspectorRender();
      });
  }
  return llamaVariant || getModelsState().hardware?.backend || null;
}

/** Read the header for a model's weights, re-rendering once it lands. */
function ensureGgufGeometry(model: LibraryModel): GgufGeometryFacts | null {
  const filePath = model.path;
  if (!filePath || model.format !== 'GGUF') return null;
  if (ggufGeometry.has(filePath)) return ggufGeometry.get(filePath) ?? null;
  if (ggufGeometryPending.has(filePath)) return null;

  ggufGeometryPending.add(filePath);
  void fetchGgufGeometry(filePath)
    .catch(() => null)
    .then((facts) => {
      ggufGeometryPending.delete(filePath);
      ggufGeometry.set(filePath, facts);
      scheduleInspectorRender();
    });
  return null;
}

/** Geometry hints for the estimator: exact header first, catalog fields as the fallback. */
function memoryHints(model: LibraryModel): {
  gguf: GgufGeometryFacts | null;
  arch: string | null;
  name: string | null;
} {
  return {
    gguf: ensureGgufGeometry(model),
    arch: model.arch || null,
    name: model.name || null,
  };
}

/** Whether these weights can drive `--spec-type draft-mtp`. */
function mtpCapable(model: LibraryModel): boolean | null {
  const facts = ensureGgufGeometry(model);
  if (!facts) return null;
  return Number(facts.nextnPredictLayers) > 0;
}

function root(): HTMLElement | null {
  return document.getElementById('modelsInspector');
}

function isLaunchRange(node: EventTarget | null): node is HTMLInputElement {
  if (!node || typeof node !== 'object') return false;
  const candidate = node as HTMLInputElement;
  return (
    candidate.tagName === 'INPUT' &&
    candidate.type === 'range' &&
    Boolean(candidate.classList?.contains('models-field__range'))
  );
}

/** True while a Load-tab slider still has focus (mouse drag or arrow keys). */
function launchRangeHasFocus(): boolean {
  const host = root();
  const active = document.activeElement;
  return Boolean(host && isLaunchRange(active) && host.contains(active));
}

/** Replace only the occupancy cluster. */
function patchLaunchMemoryMeter(model: LibraryModel): void {
  const host = root();
  if (!host) return;
  const existing = host.querySelector('.models-launch-memory');
  if (!existing) return;
  existing.replaceWith(launchMemoryHint(model, displayedFor(model)));
}

/** After a deferred full render, wait a frame so the click that blurred the slider still hits the existing tab or footer button. */
function bindLaunchRangeLifecycle(range: HTMLInputElement): void {
  range.addEventListener('blur', () => {
    if (!inspectorRenderDeferred) return;
    window.requestAnimationFrame(() => {
      if (launchRangeHasFocus()) return;
      render();
    });
  });
}

/** Label/value row — the definition-list pattern from the Info tab. */
function infoRow(label: string, value: Node | string): HTMLElement {
  const row = el('div', 'models-info-row');
  row.append(el('dt', 'models-info-row__label', label));
  const dd = el('dd', 'models-info-row__value');
  dd.append(typeof value === 'string' ? chip(value) : value);
  row.appendChild(dd);
  return row;
}

function capabilityCluster(model: LibraryModel): Node {
  if (!model.capabilities.length) return chip('—', 'muted');
  const wrap = el('div', 'models-cap-cluster');
  for (const cap of model.capabilities.slice(0, 4)) {
    const pill = chip(capabilityLabel(cap));
    pill.prepend(icon(cap === 'vision' ? 'eye' : cap === 'reasoning' ? 'brain' : 'bolt'));
    wrap.appendChild(pill);
  }
  return wrap;
}

function renderInfoTab(model: LibraryModel, body: HTMLElement): void {
  const list = el('dl', 'models-info-list');
  list.append(
    infoRow('Model', model.repoId),
    infoRow('File', model.fileName ?? '—'),
    infoRow('Format', model.format),
    infoRow('Quantization', model.quant || '—'),
    infoRow('Arch', model.arch || '—'),
    infoRow('Parameters', formatParams(model.paramsB)),
    infoRow('Context', formatContext(model.contextLength)),
    infoRow('Capabilities', capabilityCluster(model)),
    infoRow('Domain', model.domain),
    infoRow('Size on disk', formatBytes(model.sizeBytes)),
  );

  const infoBlock = el('section', 'models-inspector__block');
  infoBlock.append(el('h3', 'models-block__label', 'Model information'), list);
  body.appendChild(infoBlock);

  const serve = serveForModel(model);
  const apiBlock = el('section', 'models-inspector__block');
  apiBlock.appendChild(el('h3', 'models-block__label', 'API usage'));
  if (serve && serve.status === 'running') {
    apiBlock.append(
      el('p', 'models-field-label', 'API model identifier'),
      copyField(serve.modelLabel, 'Copy model identifier'),
      el('p', 'models-field-label', 'Reachable at'),
      copyField(serve.baseUrl, 'Copy base URL'),
    );
  } else {
    apiBlock.appendChild(
      el('p', 'models-muted', 'Load this model to expose it on a local OpenAI-compatible endpoint.'),
    );
  }
  body.appendChild(apiBlock);

  if (model.path) {
    const pathBlock = el('section', 'models-inspector__block');
    pathBlock.append(el('h3', 'models-block__label', 'On disk'), copyField(model.path, 'Copy file path'));
    body.appendChild(pathBlock);
  }
}

function contextLengthField(
  displayed: DisplayedLaunch,
  onChange: (ctxPerSlot: number) => void,
): HTMLElement {
  const maxTokens = contextSliderMax(displayed.trainCtx);
  const minTokens = Math.min(CONTEXT_SLIDER_MIN, maxTokens);
  const ctxPerSlot = snapCtxPerSlot(displayed.ctxPerSlot, maxTokens);
  const wrap = el('div', 'models-field');
  const head = el('div', 'models-field__range-head');
  head.append(el('span', 'models-field__label', 'Context length'));
  const valueText =
    displayed.parallel > 1 ? `${ctxPerSlot.toLocaleString()} / slot` : ctxPerSlot.toLocaleString();
  const valueEl = el('span', 'models-field__range-value', valueText);
  head.appendChild(valueEl);
  wrap.appendChild(head);

  const range = el('input', 'models-field__range') as HTMLInputElement;
  range.type = 'range';
  range.min = String(minTokens);
  range.max = String(maxTokens);
  range.step = String(CONTEXT_SLIDER_STEP);
  range.value = String(ctxPerSlot);
  range.setAttribute('aria-valuemin', range.min);
  range.setAttribute('aria-valuemax', range.max);
  range.setAttribute('aria-valuenow', range.value);
  range.setAttribute('aria-label', 'Context length in tokens per slot');
  range.addEventListener('input', () => {
    const next = snapCtxPerSlot(Number(range.value), maxTokens);
    valueEl.textContent =
      displayed.parallel > 1 ? `${next.toLocaleString()} / slot` : next.toLocaleString();
    range.setAttribute('aria-valuenow', String(next));
    onChange(next);
  });
  bindLaunchRangeLifecycle(range);
  wrap.appendChild(range);

  if (displayed.trainCtx) {
    wrap.appendChild(
      el(
        'p',
        'models-hint',
        `Trained context: ${displayed.trainCtx.toLocaleString()}`,
      ),
    );
  }
  if (displayed.parallel > 1) {
    wrap.appendChild(
      el(
        'p',
        'models-hint',
        `Per slot. Total -c is ${(ctxPerSlot * displayed.parallel).toLocaleString()} (${ctxPerSlot.toLocaleString()} × ${displayed.parallel} slots).`,
      ),
    );
  }
  return wrap;
}

function numberField(
  label: string,
  value: number | undefined,
  hint: string,
  onChange: (value: number | undefined) => void,
): HTMLElement {
  const wrap = el('label', 'models-field');
  wrap.append(el('span', 'models-field__label', label));
  const input = el('input', 'models-field__input') as HTMLInputElement;
  input.type = 'number';
  input.inputMode = 'numeric';
  input.placeholder = hint;
  if (value != null) input.value = String(value);
  input.addEventListener('change', () => {
    const next = Number(input.value);
    onChange(input.value.trim() && Number.isFinite(next) ? next : undefined);
  });
  wrap.appendChild(input);
  return wrap;
}

function selectField(
  label: string,
  options: Array<{ value: string; label: string }>,
  value: string,
  onChange: (value: string) => void,
): HTMLElement {
  const wrap = el('label', 'models-field');
  wrap.append(el('span', 'models-field__label', label));
  const select = el('select', 'models-field__input') as HTMLSelectElement;
  for (const opt of options) {
    const option = el('option', undefined, opt.label) as HTMLOptionElement;
    option.value = opt.value;
    if (opt.value === value) option.selected = true;
    select.appendChild(option);
  }
  select.addEventListener('change', () => onChange(select.value));
  wrap.appendChild(select);
  return wrap;
}

/** Select whose empty option means "leave it to llama.cpp / the planner". */
function optionalSelectField(
  label: string,
  options: Array<{ value: string; label: string }>,
  value: string | undefined,
  autoLabel: string,
  onChange: (value: string | undefined) => void,
): HTMLElement {
  return selectField(
    label,
    [{ value: '', label: autoLabel }, ...options],
    value ?? '',
    (v) => onChange(v || undefined),
  );
}

function checkboxField(
  label: string,
  checked: boolean,
  onChange: (checked: boolean) => void,
): HTMLElement {
  const wrap = el('label', 'models-field models-field--check');
  const input = el('input') as HTMLInputElement;
  input.type = 'checkbox';
  input.checked = checked;
  input.addEventListener('change', () => onChange(input.checked));
  wrap.append(input, el('span', undefined, label));
  return wrap;
}

function textField(
  label: string,
  value: string | undefined,
  placeholder: string,
  onChange: (value: string | undefined) => void,
): HTMLElement {
  const wrap = el('label', 'models-field');
  wrap.append(el('span', 'models-field__label', label));
  const input = el('input', 'models-field__input') as HTMLInputElement;
  input.type = 'text';
  input.placeholder = placeholder;
  input.value = value ?? '';
  input.addEventListener('change', () => {
    const next = input.value.trim();
    onChange(next || undefined);
  });
  wrap.appendChild(input);
  return wrap;
}

/** One collapsible group in the Load tab's advanced area. */
function advancedSection(key: string, title: string, ...children: Node[]): HTMLElement {
  const section = el('details', 'models-advanced');
  section.open = loadSectionOpen.has(key);
  section.addEventListener('toggle', () => {
    if ((section as HTMLDetailsElement).open) loadSectionOpen.add(key);
    else loadSectionOpen.delete(key);
  });
  section.appendChild(el('summary', 'models-advanced__summary', title));
  const body = el('div', 'models-advanced__body');
  body.append(...children);
  section.appendChild(body);
  return section;
}

/** Launch payload for Load. */
export function settingsFor(model: LibraryModel): LlamaServeSettings {
  return settingsForDraft(draftFor(model.id));
}

/** In-memory draft, or the saved row after a reload. */
function draftFor(modelId: string): LlamaServeSettings | undefined {
  if (draftSettings.has(modelId)) return draftSettings.get(modelId);
  const saved = llamaSettingsFromLaunchPrefs(getLibraryLaunchSettingsForId(modelId));
  if (!saved) return undefined;
  draftSettings.set(modelId, saved);
  return saved;
}

function persistDraft(model: LibraryModel, next: LlamaServeSettings): void {
  draftSettings.set(model.id, next);
  const payload = settingsForDraft(next);
  const pending = launchSaveTimers.get(model.id);
  if (pending) clearTimeout(pending);

  let toSave: LlamaServeSettings = payload;
  if (Object.keys(payload).length === 0) {
    const savedLlama = llamaSettingsFromLaunchPrefs(getLibraryLaunchSettingsForId(model.id));
    if (!savedLlama) return;
    toSave = { fit_mode: 'auto' };
  }

  launchSaveTimers.set(
    model.id,
    setTimeout(() => {
      launchSaveTimers.delete(model.id);
      void saveLibraryLaunchSettings({
        libraryId: model.id,
        settings: toSave,
      }).catch(() => undefined);
    }, LAUNCH_SAVE_DEBOUNCE_MS),
  );
}

function displayedFor(model: LibraryModel): DisplayedLaunch {
  const draft = draftFor(model.id);
  const parallel = Math.max(1, draft?.parallel ?? 1);
  const gguf = ensureGgufGeometry(model);
  const plan = inspectorLaunchPlan({
    gguf,
    arch: model.arch,
    name: model.name,
    paramsB: model.paramsB,
    sizeBytes: model.sizeBytes,
    hardware: getModelsState().hardware,
    variant: ensureLlamaVariant(),
    parallel,
  });
  const trainCtx = Number(gguf?.trainCtx) > 0 ? Number(gguf?.trainCtx) : null;
  return displayedLaunchFrom(draft, plan, trainCtx);
}

/** llama.cpp offload slots for a model with `nLayers` repeating blocks. */
function offloadSlotCount(maxLayers: number): number {
  return maxLayers + 1;
}

function sliderValueFromNGpu(nGpuLayers: number | null | undefined, slots: number): number {
  if (nGpuLayers === 0) return 0;
  if (nGpuLayers == null) return slots;
  return Math.min(slots, Math.max(0, nGpuLayers));
}

function nGpuLayersFromSlider(sliderValue: number, slots: number): number {
  if (sliderValue <= 0) return 0;
  return Math.min(slots, sliderValue);
}

function formatGpuLayersSliderLabel(
  sliderValue: number,
  maxLayers: number,
  auto: boolean,
): string {
  if (auto) return 'Auto';
  if (sliderValue <= 0) return 'CPU only';
  if (sliderValue >= offloadSlotCount(maxLayers)) return `All (${maxLayers})`;
  return String(sliderValue);
}

/** Insert the Auto restore control without remounting the range (slider ticks must keep the thumb). */
function ensureGpuAutoRestoreButton(meta: HTMLElement, onAuto: () => void): void {
  if (meta.querySelector('.models-field__auto')) return;
  const autoBtn = el('button', 'models-field__auto', 'Auto') as HTMLButtonElement;
  autoBtn.type = 'button';
  autoBtn.setAttribute('aria-label', 'Restore GPU layers to Auto');
  autoBtn.addEventListener('click', () => {
    const range = meta.closest('.models-field')?.querySelector<HTMLInputElement>('.models-field__range');
    range?.blur();
    onAuto();
  });
  meta.appendChild(autoBtn);
}

function gpuLayersSlider(
  model: LibraryModel,
  displayed: DisplayedLaunch,
  onChange: (nGpuLayers: number | null) => void,
): HTMLElement {
  const maxLayers = estimateTransformerLayerCount(model.paramsB, memoryHints(model));
  const slots = offloadSlotCount(maxLayers);
  const auto = displayed.n_gpu_layers == null;
  const sliderValue = sliderValueFromNGpu(displayed.n_gpu_layers, slots);
  const wrap = el('div', 'models-field');
  const head = el('div', 'models-field__range-head');
  head.append(el('span', 'models-field__label', 'GPU layers'));
  const meta = el('div', 'models-field__range-meta');
  const valueEl = el(
    'span',
    'models-field__range-value',
    formatGpuLayersSliderLabel(sliderValue, maxLayers, auto),
  );
  meta.appendChild(valueEl);
  if (draftFor(model.id)?.n_gpu_layers != null) {
    ensureGpuAutoRestoreButton(meta, () => onChange(null));
  }
  head.appendChild(meta);
  wrap.appendChild(head);

  const range = el('input', 'models-field__range') as HTMLInputElement;
  range.type = 'range';
  range.min = '0';
  range.max = String(slots);
  range.step = '1';
  range.value = String(sliderValue);
  range.setAttribute('aria-valuemin', range.min);
  range.setAttribute('aria-valuemax', range.max);
  range.setAttribute('aria-valuenow', range.value);
  range.setAttribute(
    'aria-valuetext',
    auto ? 'Auto: llama.cpp sizes the GPU split' : formatGpuLayersSliderLabel(sliderValue, maxLayers, false),
  );
  range.setAttribute('aria-label', 'Transformer layers to offload to the GPU');
  range.addEventListener('input', () => {
    const nextSlider = Number(range.value);
    valueEl.textContent = formatGpuLayersSliderLabel(nextSlider, maxLayers, false);
    range.setAttribute('aria-valuenow', String(nextSlider));
    range.setAttribute(
      'aria-valuetext',
      formatGpuLayersSliderLabel(nextSlider, maxLayers, false),
    );
    wrap.querySelector('.models-field__auto-hint')?.remove();
    ensureGpuAutoRestoreButton(meta, () => onChange(null));
    onChange(nGpuLayersFromSlider(nextSlider, slots));
  });
  bindLaunchRangeLifecycle(range);
  wrap.appendChild(range);
  if (auto) {
    wrap.appendChild(
      el('p', 'models-hint models-field__auto-hint', 'Auto: llama.cpp sizes the GPU split.'),
    );
  }
  return wrap;
}

/** Occupancy meters for the current launch settings vs measured hardware. */
function launchMemoryHint(model: LibraryModel, displayed: DisplayedLaunch): HTMLElement {
  const weightsGb = model.sizeBytes > 0 ? model.sizeBytes / 1024 ** 3 : 0;
  const hw = getModelsState().hardware;
  const draft = draftFor(model.id);
  const estimate = estimateServeMemory({
    weightsGb,
    paramsB: model.paramsB,
    ctx: displayed.ctx,
    cacheType: {
      k: draft?.cache_type_k ?? displayed.cache_type,
      v: draft?.cache_type_v ?? displayed.cache_type,
    },
    swaFull: draft?.swa_full === true,
    nGpuLayers: displayed.n_gpu_layers ?? undefined,
    backend: hw?.backend ?? null,
    deviceCount: Math.max(1, parseDeviceList(draft?.device).length || (hw?.gpuCount ?? 1)),
    ...memoryHints(model),
  });
  return renderLaunchMemoryMeter({ estimate, hardware: hw });
}

/** Time-based estimate from the last successful load — not a fake percent. */
function loadDurationHint(model: LibraryModel): HTMLElement | null {
  const loading = getModelsState().loads.some((l) => l.modelId === model.id && !l.error);
  if (loading) return null;
  const saved = getLibraryLaunchSettingsForId(model.id);
  if (!saved) return null;
  const lastLoadMs = Number(saved.lastLoadMs);
  const lastWeightsBytes = Number(saved.lastWeightsBytes);
  const ms = estimateLoadDurationMs(model.sizeBytes, lastLoadMs, lastWeightsBytes);
  if (ms == null) return null;
  const seconds = Math.max(1, Math.round(ms / 1000));
  const label = seconds === 1 ? '1 second' : `${seconds} seconds`;
  const sameSize = lastWeightsBytes === model.sizeBytes;
  const text = sameSize
    ? `Last load took about ${label}.`
    : `About ${label} at the last observed rate.`;
  return el('p', 'models-muted', text);
}

/** Other GGUF weights on this machine that could act as a draft model. */
function draftModelOptions(model: LibraryModel): Array<{ value: string; label: string }> {
  return getModelsState()
    .library.filter(
      (row) =>
        row.id !== model.id &&
        row.format === 'GGUF' &&
        row.servable &&
        Boolean(row.path) &&
        row.sizeBytes > 0 &&
        (model.sizeBytes <= 0 || row.sizeBytes < model.sizeBytes),
    )
    .sort((a, b) => a.sizeBytes - b.sizeBytes)
    .map((row) => ({
      value: row.path as string,
      label: `${row.name} · ${formatBytes(row.sizeBytes)}`,
    }));
}

function formatGpuDeviceLabel(device: LlamaGpuDevice): string {
  const vramGb = device.memoryMiB > 0 ? Math.round((device.memoryMiB / 1024) * 10) / 10 : 0;
  const vram = vramGb > 0 ? ` · ${vramGb} GB` : '';
  return `${device.id} · ${device.name}${vram}`;
}

/** Saved --device order, or the first inventory row until the user opts in. */
function selectedDeviceIds(draft: LlamaServeSettings | undefined, inventory: LlamaGpuDevice[]): string[] {
  const saved = parseDeviceList(draft?.device);
  if (saved.length) return saved.filter((id) => inventory.some((row) => row.id === id));
  return inventory[0] ? [inventory[0].id] : [];
}

/** GPU fields stay auto-mode pass-through. Dropping to one card clears split flags. */
function persistGpuSettings(
  model: LibraryModel,
  patch: LlamaServeSettings,
  dropSplit = false,
): void {
  const displayed = displayedFor(model);
  const next = applyPassThroughTouch(draftFor(model.id), displayed, patch);
  if (dropSplit) {
    delete next.split_mode;
    delete next.tensor_split;
  }
  persistDraft(model, next);
}

function gpuRatioField(
  deviceId: string,
  value: number,
  percent: number,
  onChange: (value: number, remount: boolean) => void,
): HTMLElement {
  const wrap = el('div', 'models-field models-field--gpu-ratio');
  const head = el('div', 'models-field__range-head');
  head.append(el('span', 'models-field__label', deviceId));
  const percentEl = el('span', 'models-field__range-value', `${percent}%`);
  head.appendChild(percentEl);
  wrap.appendChild(head);

  const range = el('input', 'models-field__range') as HTMLInputElement;
  range.type = 'range';
  range.min = '1';
  range.max = '100';
  range.step = '1';
  range.value = String(Math.max(1, Math.min(100, Math.round(percent))));
  range.setAttribute('aria-label', `Tensor split share for ${deviceId}`);
  range.addEventListener('input', () => {
    percentEl.textContent = `${range.value}%`;
    onChange(Number(range.value), false);
  });
  // Same as context/GPU-layer sliders: keep the inspector from remounting mid-drag.
  bindLaunchRangeLifecycle(range);
  wrap.appendChild(range);

  const number = el('input', 'models-field__input') as HTMLInputElement;
  number.type = 'number';
  number.min = '0';
  number.step = '1';
  number.value = String(value);
  number.setAttribute('aria-label', `Tensor split weight for ${deviceId}`);
  number.addEventListener('change', () => {
    const next = Number(number.value);
    if (Number.isFinite(next) && next >= 0) onChange(next, true);
  });
  wrap.appendChild(number);
  return wrap;
}

function gpusSection(model: LibraryModel, refresh: () => void): HTMLElement | null {
  const variant = ensureLlamaVariant();
  const hw = getModelsState().hardware;
  const inventory = resolveLlamaDeviceInventory(
    llamaDeviceInventory,
    hw as unknown as Record<string, unknown>,
    variant,
  );
  const cpuOnly = String(variant ?? '').toLowerCase().startsWith('cpu') && inventory.length === 0;
  if (cpuOnly) return null;

  const draft = draftFor(model.id);
  const selected = selectedDeviceIds(draft, inventory);
  const children: Node[] = [];

  if (!inventory.length) {
    children.push(
      el(
        'p',
        'models-hint',
        'No GPU devices reported. Use Extra llama-server args for --device until the runtime is installed.',
      ),
    );
    return advancedSection('gpus', 'GPUs', ...children);
  }

  for (const device of inventory) {
    const checked = selected.includes(device.id);
    children.push(
      checkboxField(formatGpuDeviceLabel(device), checked, (nextChecked) => {
        const nextIds = toggleDeviceSelection(selected, device.id, nextChecked);
        persistGpuSettings(model, { device: joinDeviceList(nextIds) }, nextIds.length < 2);
        refresh();
      }),
    );
  }

  children.push(
    el(
      'p',
      'models-hint',
      selected.length
        ? `First checked is first in --device. Currently ${joinDeviceList(selected)}. Leave a card unchecked to keep it free.`
        : 'First checked is first in --device. Leave a card unchecked to keep it free.',
    ),
  );

  if (selected.length >= 2) {
    children.push(
      selectField(
        'Split mode',
        [
          { value: 'layer', label: 'Layer, pipeline (default)' },
          { value: 'tensor', label: 'Tensor, experimental' },
        ],
        draft?.split_mode === 'tensor' ? 'tensor' : 'layer',
        (v) => {
          persistGpuSettings(model, { split_mode: v === 'tensor' ? 'tensor' : 'layer' });
          refresh();
        },
      ),
    );
    if (draft?.split_mode === 'tensor') {
      children.push(
        el(
          'p',
          'models-hint models-hint--warning',
          'Experimental. Auto-fit turns off. Keep KV cache at full precision.',
        ),
      );
    }

    const selectedRows = selected
      .map((id) => inventory.find((row) => row.id === id))
      .filter((row): row is LlamaGpuDevice => Boolean(row));
    const customParts = parseTensorSplit(draft?.tensor_split);
    const parts =
      customParts.length === selectedRows.length ? customParts : vramProportionalSplit(selectedRows);
    const percents = tensorSplitPercents(parts);

    selectedRows.forEach((device, index) => {
      children.push(
        gpuRatioField(device.id, parts[index], percents[index] ?? 0, (value, remount) => {
          const next = [...parts];
          next[index] = value;
          persistGpuSettings(model, { tensor_split: joinTensorSplit(next) });
          if (remount) refresh();
        }),
      );
    });
    children.push(
      el(
        'p',
        'models-hint',
        `Share of the model: ${percents.map((p) => `${p}%`).join(' / ')}. Move a slider to send --tensor-split; until then llama.cpp splits by free VRAM. Values are proportions (5,5 is the same as 1,1).`,
      ),
    );
  }

  return advancedSection('gpus', 'GPUs', ...children);
}

/** Speculative decoding. */
function speculativeSection(
  model: LibraryModel,
  touch: (patch: LlamaServeSettings) => void,
  refresh: () => void,
): HTMLElement {
  const draft = draftFor(model.id);
  const specType = draft?.spec_type ?? 'none';
  const mtp = mtpCapable(model);
  const needsDraftModel = specType === 'draft-simple' || specType === 'draft-eagle3';

  const options = SPEC_TYPE_OPTIONS.filter(
    (opt) => opt.value !== 'draft-mtp' || mtp !== false || specType === 'draft-mtp',
  );

  const children: Node[] = [
    selectField('Mode', options, specType, (v) => {
      touch({ spec_type: v === 'none' ? undefined : (v as LlamaServeSettings['spec_type']) });
      refresh();
    }),
  ];

  if (mtp === false) {
    children.push(
      el(
        'p',
        'models-hint',
        'These weights carry no multi-token-prediction heads, so MTP is not available for this model.',
      ),
    );
  } else if (mtp === true) {
    children.push(
      el(
        'p',
        'models-hint',
        'These weights ship MTP heads — draft-mtp needs no second model and no extra weights in memory.',
      ),
    );
  }

  if (needsDraftModel) {
    const drafts = draftModelOptions(model);
    children.push(
      drafts.length
        ? optionalSelectField(
            'Draft model',
            drafts,
            draft?.spec_draft_model,
            'Choose a draft model…',
            (v) => {
              touch({ spec_draft_model: v });
              refresh();
            },
          )
        : el(
            'p',
            'models-hint models-hint--warning',
            'No installed GGUF is smaller than this model, so there is nothing worth drafting with. Download a small model of the same family first.',
          ),
      numberField('Draft GPU layers', draft?.spec_draft_ngl, 'all', (v) => {
        touch({ spec_draft_ngl: v });
      }),
    );
  }

  if (specType !== 'none') {
    children.push(
      numberField('Max draft tokens', draft?.spec_draft_n_max, '3', (v) => {
        touch({ spec_draft_n_max: v });
      }),
      numberField('Min draft tokens', draft?.spec_draft_n_min, '0', (v) => {
        touch({ spec_draft_n_min: v });
      }),
      numberField('Draft probability', draft?.spec_draft_p_min, '0', (v) => {
        touch({ spec_draft_p_min: v });
      }),
    );
  }

  const blocked = launchValidationError(draft, mtp);
  if (blocked) {
    children.push(el('p', 'models-hint models-hint--warning', blocked));
  }

  return advancedSection('speculative', 'Speculative decoding', ...children);
}

function renderLoadTab(model: LibraryModel, body: HTMLElement): void {
  if (!model.servable) {
    body.appendChild(
      emptyState({
        glyph: 'triangle-warning',
        title: 'Not loadable here',
        body:
          model.unavailableReason ?? (model.format === 'GGUF'
            ? 'Minnow could not resolve a file path for these weights.'
            : `${model.format} weights need their own runtime. Minnow's local server loads GGUF through llama.cpp.`),
      }),
    );
    return;
  }

  if (model.source === 'ollama') {
    const block = el('section', 'models-inspector__block');
    block.append(
      el('h3', 'models-block__label', 'Runtime'),
      el('p', 'models-muted', 'Ollama manages this model. Minnow registers it as the active provider.'),
    );
    body.appendChild(block);
    return;
  }

  if (renderModelEngineSettings(model, body, render)) return;
  const displayed = displayedFor(model);
  const draft = draftFor(model.id);
  const serve = serveForModel(model);

  const configBlock = el('section', 'models-inspector__block');
  configBlock.appendChild(el('h3', 'models-block__label', 'Launch'));

  if (serve && (serve.status === 'error' || serve.status === 'crashed')) {
    const failure = serveFailureBlock(serve);
    if (failure) configBlock.appendChild(failure);
  }

  if (!displayed.plan.fits) {
    configBlock.appendChild(el('p', 'models-hint models-hint--warning', displayed.plan.reason));
  }

  const memoryHint = launchMemoryHint(model, displayed);

  const refreshAfterTouch = (): void => {
    render();
  };

  configBlock.append(
    memoryHint,
    contextLengthField(displayed, (ctxPerSlot) => {
      persistDraft(model, applyCtxPerSlotTouch(draftFor(model.id), displayed, ctxPerSlot));
      patchLaunchMemoryMeter(model);
    }),
    gpuLayersSlider(model, displayed, (nGpuLayers) => {
      persistDraft(
        model,
        nGpuLayers == null
          ? applyGpuLayersAuto(draftFor(model.id), displayed)
          : applyGpuLayersTouch(draftFor(model.id), displayed, nGpuLayers),
      );
      if (nGpuLayers == null) refreshAfterTouch();
      else patchLaunchMemoryMeter(model);
    }),
  );
  configBlock.appendChild(
    selectField(
      'KV cache',
      [
        { value: 'f16', label: 'f16 — full precision' },
        { value: 'q8_0', label: 'q8_0 — balanced' },
        { value: 'q4_0', label: 'q4_0 — smaller' },
        ...extraKvOptions(),
      ],
      displayed.cache_type,
      (v) => {
        persistDraft(model, applyCacheTypeTouch(draftFor(model.id), displayed, v));
        refreshAfterTouch();
      },
    ),
  );
  if (model.format === 'GGUF' && model.hasProjector) {
    configBlock.appendChild(
      checkboxField('Vision (load image projector)', draft?.no_mmproj !== true, (checked) => {
        persistDraft(
          model,
          applyPassThroughTouch(draftFor(model.id), displayed, {
            no_mmproj: checked ? undefined : true,
          }),
        );
      }),
    );
  }
  const durationHint = loadDurationHint(model);
  if (durationHint) configBlock.appendChild(durationHint);
  body.appendChild(configBlock);

  /** Pass-through touch that never leaves auto. */
  const touch = (patch: LlamaServeSettings): void => {
    persistDraft(model, applyPassThroughTouch(draftFor(model.id), displayed, patch));
  };

  const advancedStack = el('div', 'models-advanced-stack');

  const gpuBlock = gpusSection(model, refreshAfterTouch);
  if (gpuBlock) advancedStack.appendChild(gpuBlock);

  advancedStack.appendChild(
    advancedSection(
      'performance',
      'Performance',
      numberField('CPU thread pool size', draft?.threads, 'auto', (v) => {
        touch({ threads: v });
      }),
      numberField('Batch size', draft?.batch_size, 'auto', (v) => {
        touch({ batch_size: v });
      }),
      numberField('Micro-batch', draft?.ubatch_size, 'auto', (v) => {
        touch({ ubatch_size: v });
      }),
      numberField('Parallel slots', draft?.parallel, '1', (v) => {
        touch({ parallel: v });
        refreshAfterTouch();
      }),
      numberField('Context checkpoints', draft?.ctx_checkpoints, '32', (v) => {
        touch({ ctx_checkpoints: v });
      }),
      el(
        'p',
        'models-hint',
        'Checkpoints let a slot rewind instead of reprocessing the prompt. They cost host memory that the estimate above does not model.',
      ),
    ),
  );

  const resolvedK = draft?.cache_type_k || displayed.cache_type;
  const resolvedV = draft?.cache_type_v || displayed.cache_type;
  const kvMismatch = resolvedK !== resolvedV;

  const kvChildren: Node[] = [
    checkboxField('Unified KV cache', draft?.kv_unified === true, (checked) => {
      touch({ kv_unified: checked ? true : undefined });
    }),
    checkboxField('Offload KV cache to GPU memory', draft?.kv_offload !== false, (checked) => {
      touch({ kv_offload: checked ? undefined : false });
    }),
    optionalSelectField('K cache type', [...KV_CACHE_TYPE_OPTIONS, ...extraKvOptions()], draft?.cache_type_k, 'Match KV cache', (v) => {
      persistDraft(model, applyCacheTypeSideTouch(draftFor(model.id), displayed, 'k', v, llamaAsymmetricKv));
      refreshAfterTouch();
    }),
    optionalSelectField('V cache type', [...KV_CACHE_TYPE_OPTIONS, ...extraKvOptions()], draft?.cache_type_v, 'Match KV cache', (v) => {
      persistDraft(model, applyCacheTypeSideTouch(draftFor(model.id), displayed, 'v', v, llamaAsymmetricKv));
      refreshAfterTouch();
    }),
    llamaAsymmetricKv
      ? el(
          'p',
          'models-hint',
          `${llamaEngineLabel} runs different K and V types natively. On small models, q8_0 K with a turbo V type is the safe pairing.`,
        )
      : el(
          'p',
          kvMismatch ? 'models-hint models-hint--warning' : 'models-hint',
          kvMismatch
            ? 'K and V cache types differ. Mixed types collapse prompt processing onto the CPU. Load will use one type for both; set them equal here, or use KV cache above.'
            : 'K and V must use the same type. Mixed types (for example f16 K with q8_0 V) drop prompt processing onto the CPU on this llama.cpp build.',
        ),
    optionalSelectField(
      'Flash attention',
      [
        { value: 'on', label: 'On' },
        { value: 'off', label: 'Off' },
        { value: 'auto', label: 'Let llama.cpp decide' },
      ],
      draft?.flash_attn,
      `Minnow default (${displayed.plan.flash_attn})`,
      (v) => {
        touch({ flash_attn: v as LlamaServeSettings['flash_attn'] });
        refreshAfterTouch();
      },
    ),
    checkboxField('Full-size sliding-window cache', draft?.swa_full === true, (checked) => {
      touch({ swa_full: checked ? true : undefined });
      refreshAfterTouch();
    }),
  ];
  if (draft?.flash_attn === 'off') {
    kvChildren.push(
      el(
        'p',
        'models-hint models-hint--warning',
        'Without flash attention the compute buffer grows with context. The estimate above assumes it is on.',
      ),
    );
  }
  const kvSection = advancedSection('kv-cache', 'KV cache', ...kvChildren);
  advancedStack.appendChild(kvSection);

  advancedStack.appendChild(speculativeSection(model, touch, refreshAfterTouch));

  advancedStack.appendChild(
    advancedSection(
      'memory',
      'Memory',
      checkboxField('Keep model in memory (mlock)', draft?.mlock === true, (checked) => {
        touch({ mlock: checked ? true : undefined });
      }),
      checkboxField('Try mmap', draft?.no_mmap !== true, (checked) => {
        touch({ no_mmap: checked ? undefined : true });
      }),
      numberField('MoE layers on CPU', draft?.n_cpu_moe, '0', (v) => {
        touch({ n_cpu_moe: v });
        refreshAfterTouch();
      }),
      selectField('Auto unload after idle', IDLE_TTL_OPTIONS, idleTtlValue(draft), (v) => {
        touch({ idle_ttl_ms: v === '' ? undefined : Number(v) });
      }),
      checkboxField(
        'CUDA unified memory',
        Boolean(draft?.env?.GGML_CUDA_ENABLE_UNIFIED_MEMORY),
        (checked) => {
          touch({ env: checked ? { GGML_CUDA_ENABLE_UNIFIED_MEMORY: '1' } : undefined });
        },
      ),
    ),
  );

  advancedStack.appendChild(
    advancedSection(
      'sampling',
      'Sampling & template',
      numberField('Seed', draft?.seed, 'random', (v) => {
        touch({ seed: v });
      }),
      numberField('RoPE frequency base', draft?.rope_freq_base, 'from model', (v) => {
        touch({ rope_freq_base: v });
      }),
      numberField('RoPE frequency scale', draft?.rope_freq_scale, '1', (v) => {
        touch({ rope_freq_scale: v });
      }),
      checkboxField('Context shift on overflow', draft?.context_shift === true, (checked) => {
        touch({ context_shift: checked ? true : undefined });
      }),
      textField(
        'Reasoning budget message',
        draft?.reasoning_budget_message,
        'Injected when the thinking budget runs out',
        (v) => {
          touch({ reasoning_budget_message: v });
        },
      ),
      textField('Chat template', draft?.chat_template, "Model's own template", (v) => {
        touch({ chat_template: v });
      }),
      textField('Chat template file', draft?.chat_template_file, 'Path to a .jinja file', (v) => {
        touch({ chat_template_file: v });
      }),
    ),
  );

  const extraWrap = el('label', 'models-field');
  extraWrap.append(el('span', 'models-field__label', 'Extra llama-server args'));
  const extraInput = el('input', 'models-field__input') as HTMLInputElement;
  extraInput.placeholder = '--chat-template "..." --no-mmap';
  extraInput.value = joinArgv(draft?.extra_args ?? []);
  extraInput.addEventListener('change', () => {
    const raw = extraInput.value.trim();
    const tokens = raw ? tokenizeArgv(raw) : [];
    touch({ extra_args: tokens.length ? tokens : undefined });
  });
  extraWrap.appendChild(extraInput);
  advancedStack.appendChild(
    advancedSection(
      'escape-hatch',
      'Escape hatch',
      extraWrap,
      el('p', 'models-hint', 'Anything set here wins over every field above.'),
    ),
  );

  body.appendChild(advancedStack);
}

/** Flags the running (or failed) process was actually started with. */
function appendLoadedWithBlock(
  body: HTMLElement,
  settings: LlamaServeSettings | null | undefined,
  emptyHint: string,
): void {
  const block = el('section', 'models-inspector__block');
  block.appendChild(el('h3', 'models-block__label', 'Loaded with'));

  if (!settings) {
    block.appendChild(el('p', 'models-muted', emptyHint));
    body.appendChild(block);
    return;
  }

  const list = el('dl', 'models-info-list');
  list.append(
    infoRow('Context', settings.ctx != null ? String(settings.ctx) : '—'),
    infoRow(
      'GPU layers',
      settings.n_gpu_layers === 0
        ? 'CPU only'
        : settings.n_gpu_layers != null
          ? String(settings.n_gpu_layers)
          : settings.fit_mode === 'manual'
            ? '—'
            : 'Auto',
    ),
    infoRow(
      'KV cache',
      settings.cache_type_k || settings.cache_type_v
        ? `K ${settings.cache_type_k ?? settings.cache_type ?? 'f16'} / V ${settings.cache_type_v ?? settings.cache_type ?? 'f16'}`
        : (settings.cache_type ?? '—'),
    ),
    infoRow('Fit', settings.fit_mode === 'manual' ? 'Manual' : 'Auto'),
    infoRow('Parallel', String(settings.parallel ?? 1)),
  );
  const extras: Array<[string, string]> = [];
  if (settings.flash_attn) extras.push(['Flash attention', settings.flash_attn]);
  if (settings.threads != null) extras.push(['Threads', String(settings.threads)]);
  if (settings.batch_size != null) extras.push(['Batch', String(settings.batch_size)]);
  if (settings.ubatch_size != null) extras.push(['Micro-batch', String(settings.ubatch_size)]);
  if (settings.kv_unified != null) extras.push(['Unified KV', settings.kv_unified ? 'On' : 'Off']);
  if (settings.kv_offload === false) extras.push(['KV offload', 'Off']);
  if (settings.ctx_checkpoints != null) {
    extras.push(['Context checkpoints', String(settings.ctx_checkpoints)]);
  }
  if (settings.swa_full) extras.push(['SWA cache', 'Full size']);
  if (settings.context_shift != null) {
    extras.push(['Context shift', settings.context_shift ? 'On' : 'Off']);
  }
  if (settings.n_cpu_moe != null) extras.push(['MoE on CPU', String(settings.n_cpu_moe)]);
  if (settings.seed != null) extras.push(['Seed', String(settings.seed)]);
  if (settings.rope_freq_base != null) {
    extras.push(['RoPE base', String(settings.rope_freq_base)]);
  }
  if (settings.rope_freq_scale != null) {
    extras.push(['RoPE scale', String(settings.rope_freq_scale)]);
  }
  if (settings.spec_type && settings.spec_type !== 'none') {
    extras.push(['Speculative', settings.spec_type]);
    if (settings.spec_draft_model) {
      extras.push(['Draft model', settings.spec_draft_model.split(/[\/]/).pop() ?? '']);
    }
  }
  if (settings.device) extras.push(['Devices', settings.device]);
  if (settings.split_mode) extras.push(['Split', settings.split_mode]);
  if (settings.tensor_split) extras.push(['Tensor split', settings.tensor_split]);
  for (const [label, value] of extras) list.appendChild(infoRow(label, value));
  block.appendChild(list);
  body.appendChild(block);
}

/**
 * mlx-lm has no llamaSettings. Empty llamaSettings must not read as a broken serve.
 */
function appendMlxLoadedWithBlock(
  body: HTMLElement,
  serve: ServeRecord,
  model: LibraryModel | null | undefined,
): void {
  const block = el('section', 'models-inspector__block');
  block.appendChild(el('h3', 'models-block__label', 'Loaded with'));
  const rows = mlxLoadedWithRows(serve.mlxSettings, {
    quant: model?.quant ?? null,
    contextLength: model?.contextLength ?? null,
  });
  if (!rows.length) {
    block.appendChild(
      el('p', 'models-muted', 'Load the model to see the snapshot this serve is running.'),
    );
    body.appendChild(block);
    return;
  }
  const list = el('dl', 'models-info-list');
  for (const row of rows) list.appendChild(infoRow(row.label, row.value));
  block.appendChild(list);
  body.appendChild(block);
}

function appendMtplxLoadedWithBlock(body: HTMLElement, serve: ServeRecord): void {
  const block = el('section', 'models-inspector__block');
  block.append(
    el('h3', 'models-block__label', 'Powered by MTPLX'),
    el('p', 'models-muted', serve.ownership === 'external' ? 'External daemon. Eject disconnects Minnow and leaves it running.' : 'Managed by Minnow.'),
    el('pre', 'models-muted', JSON.stringify(serve.mtplxSettings, null, 2)),
  );
  body.append(block);
}

function renderInferenceTab(model: LibraryModel, body: HTMLElement): void {
  const serve = getInspectedServe() ?? serveForModel(model);
  if (serve?.runtime === 'mtplx') {
    appendMtplxLoadedWithBlock(body, serve);
  } else if (serve?.runtime === 'mlx-lm') {
    appendMlxLoadedWithBlock(body, serve, model);
  } else {
    appendLoadedWithBlock(
      body,
      serve?.llamaSettings as LlamaServeSettings | null | undefined,
      'Load the model to see the flags its process was started with.',
    );
  }

  const samplerBlock = el('section', 'models-inspector__block models-inspector__sampler');
  samplerBlock.append(
    el('h3', 'models-block__label', 'Sampling'),
    el(
      'p',
      'models-muted',
      'Override global sampler defaults for this model. Empty fields inherit from Settings → Sampler.',
    ),
  );

  const aliases = [
    serve?.modelLabel,
    model.name,
    model.fileName ?? undefined,
  ].filter((value): value is string => Boolean(value?.trim()));

  const stored = getLibrarySamplerForId(model.id);
  const samplerFields = buildSamplerFieldInputs(stored, {
    includeMaxTokens: true,
    emptyPlaceholder: 'Inherit',
  });
  samplerBlock.appendChild(samplerFields.root);

  let skipAutoSave = true;
  const persistSampler = (): void => {
    if (skipAutoSave) return;
    const patch = samplerFields.readPatch();
    void saveLibraryInferenceSampler({
      libraryId: model.id,
      sampler: patch,
      aliases,
    })
      .then(() => {
        setStatus('ok', 'Sampling settings saved');
      })
      .catch((err: unknown) => {
        setStatus('err', err instanceof Error ? err.message : 'Could not save sampling settings');
      });
  };
  samplerFields.root.addEventListener('change', persistSampler);
  queueMicrotask(() => {
    skipAutoSave = false;
  });

  const links = el('div', 'models-link-row');
  links.append(
    textButton('Global sampler', () => openSection('sampler')),
    textButton('Thinking', () => openSection('thinking')),
  );
  samplerBlock.appendChild(links);
  body.appendChild(samplerBlock);
}

function openSection(section: string): void {
  void import('../models-page').then((m) => {
    m.openModels(section as import('../models-page').ModelsSectionId);
  });
}

function renderFooter(model: LibraryModel, footer: HTMLElement): void {
  const serve = serveForModel(model);
  const state = getModelsState();
  const load = state.loads.find((l) => l.modelId === model.id);

  if (load && !load.error) {
    const btn = textButton('Cancel load', () => {
      void unloadServe(load.serveId).catch((err: unknown) => {
        setStatus('err', err instanceof Error ? err.message : 'Could not stop the runtime');
      });
    });
    footer.appendChild(btn);
    return;
  }

  if (serve && (serve.status === 'running' || serve.status === 'starting' || serve.status === 'unhealthy')) {
    footer.appendChild(
      textButton(
        'Eject',
        () => {
          void unloadServe(serve.id).catch((err: unknown) => {
            setStatus('err', err instanceof Error ? err.message : 'Eject failed');
          });
        },
        'danger',
      ),
    );
    return;
  }

  if (!model.servable) return;

  const blocked = model.format === 'GGUF' ? launchValidationError(draftFor(model.id), mtpCapable(model)) : null;
  if (blocked) {
    footer.appendChild(el('p', 'models-hint models-hint--warning', blocked));
  }

  const retry = Boolean(serve && isRetryableServeStatus(serve.status));
  const retryLabel = serve && retry ? retryLabelForServe(serve) : 'Retry';
  const loadBtn = textButton(
    retry ? retryLabel : 'Load model',
    () => {
      loadBtn.disabled = true;
      loadBtn.textContent = 'Starting…';
      void (async () => {
        try {
          if (!(await ensureRuntimeForModel(model))) {
            loadBtn.disabled = false;
            loadBtn.textContent = retry ? retryLabel : 'Load model';
            return;
          }
          const base = model.source === 'ollama' ? undefined : settingsFor(model);
          const payload =
            retry && serve ? settingsForServeRetry(serve, base ?? {}) : base;
          await loadModel(model, payload);
        } catch (err) {
          setStatus('err', err instanceof Error ? err.message : 'Load failed');
          loadBtn.disabled = false;
          loadBtn.textContent = retry ? retryLabel : 'Load model';
        }
      })();
    },
    'primary',
  );
  if (blocked) {
    loadBtn.disabled = true;
    loadBtn.title = blocked;
  }
  footer.appendChild(loadBtn);
}

/** Redraw the inspector from current store state. */
export function render(): void {
  const host = root();
  if (!host) return;

  if (launchRangeHasFocus()) {
    inspectorRenderDeferred = true;
    const focusedModel = getSelectedModel();
    if (focusedModel && activeTab === 'load') patchLaunchMemoryMeter(focusedModel);
    return;
  }
  inspectorRenderDeferred = false;

  const inspected = getInspectedServe();
  const model = getSelectedModel();

  if (!model && inspected) {
    host.classList.remove('is-empty');
    renderServeOnlyInspector(host, inspected);
    return;
  }

  host.classList.toggle('is-empty', !model);

  if (!model) {
    host.replaceChildren(
      emptyState({
        glyph: 'chip',
        title: 'No model selected',
        body: 'Pick a model to see its metadata, launch settings, and endpoint.',
      }),
    );
    return;
  }

  const head = el('header', 'models-inspector__head');
  const glyph = icon('chip', 'models-inspector__glyph');
  const title = el('h2', 'models-inspector__title', model.name);
  title.title = model.repoId;
  head.append(glyph, title);

  const serve = serveForModel(model);
  if (serve) {
    const dot = el('span', `models-dot models-dot--${serve.status}`);
    dot.title = `Runtime ${serve.status}`;
    head.appendChild(dot);
  }

  const tabs = el('div', 'models-inspector__tabs');
  tabs.setAttribute('role', 'tablist');
  for (const id of ['info', 'load', 'inference'] as InspectorTab[]) {
    const meta = TAB_LABELS[id];
    const tab = el('button', 'models-tab', meta.label);
    tab.type = 'button';
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', String(activeTab === id));
    tab.prepend(icon(meta.glyph));
    tab.addEventListener('click', () => {
      activeTab = id;
      render();
    });
    tabs.appendChild(tab);
  }

  const body = el('div', 'models-inspector__body');
  body.setAttribute('role', 'tabpanel');
  if (activeTab === 'info') renderInfoTab(model, body);
  else if (activeTab === 'load') renderLoadTab(model, body);
  else renderInferenceTab(model, body);

  const footer = el('footer', 'models-inspector__footer');
  renderFooter(model, footer);

  host.replaceChildren(head, tabs, body, footer);
}

/** Inspector for a serve that has no matching library row (JIT / path mismatch). */
function renderServeOnlyInspector(host: HTMLElement, serve: ServeRecord): void {
  const head = el('header', 'models-inspector__head');
  const glyph = icon('chip', 'models-inspector__glyph');
  const title = el('h2', 'models-inspector__title', serve.modelLabel);
  head.append(glyph, title);
  const dot = el('span', `models-dot models-dot--${serve.status}`);
  dot.title = `Runtime ${serve.status}`;
  head.appendChild(dot);

  const tabs = el('div', 'models-inspector__tabs');
  tabs.setAttribute('role', 'tablist');
  const tab = el('button', 'models-tab', TAB_LABELS.inference.label);
  tab.type = 'button';
  tab.setAttribute('role', 'tab');
  tab.setAttribute('aria-selected', 'true');
  tab.prepend(icon(TAB_LABELS.inference.glyph));
  tabs.appendChild(tab);

  const body = el('div', 'models-inspector__body');
  body.setAttribute('role', 'tabpanel');
  if (serve.runtime === 'mtplx') {
    appendMtplxLoadedWithBlock(body, serve);
  } else if (serve.runtime === 'mlx-lm') {
    appendMlxLoadedWithBlock(body, serve, libraryModelForServe(serve) ?? null);
  } else {
    appendLoadedWithBlock(
      body,
      serve.llamaSettings as LlamaServeSettings | null | undefined,
      'This serve has no stored launch flags.',
    );
  }

  const footer = el('footer', 'models-inspector__footer');
  footer.appendChild(
    textButton(
      'Eject',
      () => {
        void unloadServe(serve.id).catch((err: unknown) => {
          setStatus('err', err instanceof Error ? err.message : 'Eject failed');
        });
      },
      'danger',
    ),
  );

  host.replaceChildren(head, tabs, body, footer);
}

/** Coalesce re-renders onto the next frame. */
function scheduleInspectorRender(): void {
  if (inspectorRenderRaf != null) return;
  inspectorRenderRaf = window.requestAnimationFrame(() => {
    inspectorRenderRaf = null;
    render();
  });
}

/** Wire the inspector to the store (idempotent). */
export function initInspector(): void {
  void loadLibraryInferencePrefs();
  void loadLibraryLaunchPrefs().then(() => {
    scheduleInspectorRender();
  });
  if (bound) {
    render();
    return;
  }
  bound = true;
  subscribeModelsStore(scheduleInspectorRender);
  render();
}

/** Select a library row and show the inspector (opens the panel when hidden). */
export function showModelInInspector(modelId: string, tab: InspectorTab = 'info'): void {
  selectModel(modelId);
  activeTab = tab;
  setModelsInspectorOpen(true);
  render();
  queueMicrotask(() => {
    const host = root();
    if (!host) return;
    host.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')?.focus();
  });
}

/** Open the inspector on a Local Server card. */
export function showServeInInspector(serveId: string): void {
  selectServe(serveId);
  activeTab = 'inference';
  setModelsInspectorOpen(true);
  render();
  queueMicrotask(() => {
    const host = root();
    if (!host) return;
    host.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')?.focus();
  });
}

/** Open the inspector on a specific tab for the current selection. */
export function showInspectorTab(tab: InspectorTab): void {
  const id = getModelsState().selectedId;
  if (!id) {
    activeTab = tab;
    setModelsInspectorOpen(true);
    render();
    return;
  }
  showModelInInspector(id, tab);
}

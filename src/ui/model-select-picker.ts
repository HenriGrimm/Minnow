import { modelCache } from '../app-state';
import { isServerStorageMode } from '../config/storage-mode';
import { decodeModelSelectKey, encodeModelSelectKey } from '../lib/model-select-key';
import {
  isKnownLocalProviderId,
} from '../providers/provider-host';
import {
  formatCapabilityBadges,
  formatCapabilityTooltip,
} from '../providers/capability-badges';
import { getLastCapabilitiesProbedAt } from '../providers/model-capabilities';
import {
  modelProducerLogoSvg,
  producerDisplayName,
  producerSlugFromModelId,
  resolveModelProducer,
} from '../providers/model-producer';
import { isModelLoaded, resolveModelState, type ModelLoadState } from './model-state-dot';
import {
  getModelLoadUnloadTargetSelectValue,
  isModelLoadUnloadBusy,
} from './model-load-unload-button';
import {
  registerChromePopover,
  unregisterChromePopover,
} from './preview-electron-visibility';
import { activitySuffixForModelId } from '../models/serve-activity-feed';
import { iconHtml } from './icon';
import { MINNOW_GLYPH_HEADER_HTML } from './minnow-glyph';
import {
  resolveModelHostFilterLoadUnloadValue,
  setModelHostFilterLoadUnloadResolver,
  setModelMenuActionResolver,
} from './model-host-filter-context';
import {
  isLibraryModelProviderId,
  resolveLibraryModelIdForChatBinding,
} from '../models/model-select-library';
import {
  defaultComposerReasoningLevel,
  formatReasoningEffortLabel,
  getComposerReasoningLevelOptions,
} from '../lib/reasoning-effort';
import { resolveSendCapabilities } from '../providers/model-capabilities';
import {
  getModelReasoningDefault,
  saveModelReasoningDefault,
} from '../config/model-reasoning-defaults';
import type { ReasoningEffortOption } from '../types';

/** Refresh icon reused for compact refresh controls in model picker filter bars. */
const MODEL_REFRESH_ICON_HTML = iconHtml('refresh');

/** Flat list when catalog is small; larger catalogs get collapsible producer headers. */
const BROWSE_ALL_LIMIT = 12;

const COLLAPSED_STORAGE_KEY = 'minnow-model-producer-collapsed';
const HOST_FILTER_STORAGE_KEY = 'minnow-model-host-filter';
const LOCAL_LOAD_FILTER_STORAGE_KEY = 'minnow-model-local-load-filter';
const LIBRARY_FILTER_STORAGE_KEY = 'minnow-model-library-filter';
const MODEL_SEARCH_DEBOUNCE_MS = 150;

/** Filter models by provider host: all, loopback/local, or remote/cloud APIs. */
export type ModelHostFilter = 'all' | 'local' | 'cloud';

/** Icon for the loaded-only toggle (matches model load indicator). */
const MODEL_LOADED_TOGGLE_ICON_HTML = iconHtml('statusPass');

/** When host is Local: show only models loaded in memory. */
export type ModelLocalLoadFilter = 'all' | 'loaded';

/** When on: show only My Models (minnow-library) rows in the picker. */
export type ModelLibraryFilter = 'all' | 'library';

const HOST_FILTER_CHOICES: { id: ModelHostFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'local', label: 'Local' },
  { id: 'cloud', label: 'Cloud' },
];

let pickerBound = false;
let open = false;
let chromePopoverRegistered = false;
let auxiliaryChromePopoverRegistered = false;
let hostFilter: ModelHostFilter = loadModelHostFilter();
let localLoadFilter: ModelLocalLoadFilter = loadModelLocalLoadFilter();
let libraryFilter: ModelLibraryFilter = loadModelLibraryFilter();
let modelSearchQuery = '';
let modelSearchDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let modelMenuActiveIndex = -1;

/** List selectable option rows in an open model menu (skips producer headers). */
function listModelMenuOptions(menu: HTMLUListElement): HTMLLIElement[] {
  return [...menu.querySelectorAll<HTMLLIElement>('.model-select-option[role="option"]')];
}

function syncModelMenuActiveOption(menu: HTMLUListElement, index: number): void {
  const options = listModelMenuOptions(menu);
  if (options.length === 0) {
    modelMenuActiveIndex = -1;
    menu.removeAttribute('aria-activedescendant');
    return;
  }
  const clamped = Math.max(0, Math.min(index, options.length - 1));
  modelMenuActiveIndex = clamped;
  for (let i = 0; i < options.length; i += 1) {
    const selected = i === clamped;
    options[i].classList.toggle('model-select-option--active', selected);
    if (!options[i].id) {
      options[i].id = `model-opt-${i}-${options[i].dataset.value ?? 'x'}`;
    }
  }
  menu.setAttribute('aria-activedescendant', options[clamped].id);
  options[clamped].scrollIntoView({ block: 'nearest' });
}

function handleTopBarModelMenuKeydown(event: KeyboardEvent): void {
  if (!open) return;
  const { menu, sel } = getElements();
  if (!menu || !sel) return;

  const options = listModelMenuOptions(menu);
  if (options.length === 0) return;

  if (event.key === 'ArrowDown') {
    event.preventDefault();
    const start = modelMenuActiveIndex < 0 ? 0 : modelMenuActiveIndex + 1;
    syncModelMenuActiveOption(menu, start);
    return;
  }
  if (event.key === 'ArrowUp') {
    event.preventDefault();
    const start = modelMenuActiveIndex < 0 ? options.length - 1 : modelMenuActiveIndex - 1;
    syncModelMenuActiveOption(menu, start);
    return;
  }
  if (event.key === 'Enter' || event.key === ' ') {
    if (modelMenuActiveIndex < 0) return;
    event.preventDefault();
    const opt = options[modelMenuActiveIndex];
    const value = opt.dataset.value?.trim();
    if (value) pickModel(value);
    return;
  }
  if (event.key === 'Home') {
    event.preventDefault();
    syncModelMenuActiveOption(menu, 0);
    return;
  }
  if (event.key === 'End') {
    event.preventDefault();
    syncModelMenuActiveOption(menu, options.length - 1);
  }
}

/** Optional close hooks for composer / OS model menus that share the #modelSelect catalog. */
const externalModelMenuClosers = new Set<() => void>();

/** Register a handler that closes a secondary model menu when the top-bar picker opens. */
export function registerModelSelectExternalCloser(close: () => void): () => void {
  externalModelMenuClosers.add(close);
  return () => externalModelMenuClosers.delete(close);
}

function closeExternalModelMenus(): void {
  for (const close of externalModelMenuClosers) {
    try {
      close();
    } catch {
    }
  }
}

function getElements() {
  const root = document.querySelector('.model-select-inner');
  const sel = document.getElementById('modelSelect') as HTMLSelectElement | null;
  const trigger = document.getElementById('modelSelectTrigger') as HTMLButtonElement | null;
  const triggerText = document.getElementById('modelSelectTriggerText');
  const menu = document.getElementById('modelSelectMenu') as HTMLUListElement | null;
  return { root, sel, trigger, triggerText, menu };
}

function loadCollapsedProducers(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.filter((s) => typeof s === 'string') : []);
  } catch {
    return new Set();
  }
}

function saveCollapsedProducers(slugs: Set<string>): void {
  try {
    localStorage.setItem(COLLAPSED_STORAGE_KEY, JSON.stringify([...slugs]));
  } catch {
  }
}

function loadModelHostFilter(): ModelHostFilter {
  try {
    const raw = localStorage.getItem(HOST_FILTER_STORAGE_KEY);
    if (raw === 'all' || raw === 'local' || raw === 'cloud') return raw;
  } catch {
  }
  return 'all';
}

function loadModelLocalLoadFilter(): ModelLocalLoadFilter {
  try {
    const raw = localStorage.getItem(LOCAL_LOAD_FILTER_STORAGE_KEY);
    if (raw === 'loaded') return 'loaded';
    if (raw === 'unloaded') return 'all';
  } catch {
  }
  return 'all';
}

function loadModelLibraryFilter(): ModelLibraryFilter {
  try {
    const raw = localStorage.getItem(LIBRARY_FILTER_STORAGE_KEY);
    if (raw === 'library') return 'library';
  } catch {
  }
  return 'all';
}

/** Active local/cloud filter for model picker menus (persisted in localStorage). */
export function getModelHostFilter(): ModelHostFilter {
  return hostFilter;
}

export function setModelHostFilter(filter: ModelHostFilter): void {
  hostFilter = filter;
  try {
    localStorage.setItem(HOST_FILTER_STORAGE_KEY, filter);
  } catch {
  }
  syncAllModelHostFilterBars();
}

/** Active loaded-only filter when browsing local models (persisted in localStorage). */
export function getModelLocalLoadFilter(): ModelLocalLoadFilter {
  return localLoadFilter;
}

export function setModelLocalLoadFilter(filter: ModelLocalLoadFilter): void {
  localLoadFilter = filter;
  try {
    localStorage.setItem(LOCAL_LOAD_FILTER_STORAGE_KEY, filter);
  } catch {
  }
  syncAllModelHostFilterBars();
}

export function toggleModelLocalLoadFilter(): ModelLocalLoadFilter {
  const next: ModelLocalLoadFilter = localLoadFilter === 'loaded' ? 'all' : 'loaded';
  setModelLocalLoadFilter(next);
  return next;
}

/** Active My Models-only filter for model picker menus (persisted in localStorage). */
export function getModelLibraryFilter(): ModelLibraryFilter {
  return libraryFilter;
}

export function setModelLibraryFilter(filter: ModelLibraryFilter): void {
  libraryFilter = filter;
  try {
    localStorage.setItem(LIBRARY_FILTER_STORAGE_KEY, filter);
  } catch {
  }
  syncAllModelHostFilterBars();
}

export function toggleModelLibraryFilter(): ModelLibraryFilter {
  const next: ModelLibraryFilter = libraryFilter === 'library' ? 'all' : 'library';
  setModelLibraryFilter(next);
  return next;
}

/** Current model name search query (ephemeral; shared across picker menus). */
export function getModelSearchQuery(): string {
  return modelSearchQuery;
}

export function setModelSearchQuery(query: string): void {
  modelSearchQuery = query;
  syncAllModelHostFilterSearchInputs();
}

/** Clear search when a model menu closes. */
export function clearModelSearchQuery(): void {
  if (!modelSearchQuery) return;
  modelSearchQuery = '';
  if (modelSearchDebounceTimer) {
    clearTimeout(modelSearchDebounceTimer);
    modelSearchDebounceTimer = null;
  }
  syncAllModelHostFilterSearchInputs();
}

/** Focus the search field in the first visible host filter bar. */
export function focusModelHostFilterSearch(): void {
  for (const input of document.querySelectorAll<HTMLInputElement>(
    '.model-select-host-filter .model-host-filter-search',
  )) {
    if (!input.closest('.hidden')) {
      input.focus({ preventScroll: true });
      input.select();
      return;
    }
  }
}

function syncAllModelHostFilterSearchInputs(): void {
  const query = getModelSearchQuery();
  for (const input of document.querySelectorAll<HTMLInputElement>(
    '.model-select-host-filter .model-host-filter-search',
  )) {
    if (input.value !== query) input.value = query;
  }
}

function syncAllModelHostFilterBars(): void {
  const currentHost = getModelHostFilter();
  const loadedOnly = getModelLocalLoadFilter() === 'loaded';
  const libraryOnly = getModelLibraryFilter() === 'library';
  for (const bar of document.querySelectorAll('.model-select-host-filter')) {
    for (const btn of bar.querySelectorAll<HTMLButtonElement>('.model-host-filter-segment')) {
      const id = btn.dataset.filter as ModelHostFilter | undefined;
      if (id) btn.setAttribute('aria-checked', id === currentHost ? 'true' : 'false');
    }
    const loadedToggle = bar.querySelector<HTMLButtonElement>(
      '.model-host-filter-loaded-toggle',
    );
    if (loadedToggle) {
      loadedToggle.hidden = currentHost !== 'local';
      loadedToggle.setAttribute('aria-pressed', loadedOnly ? 'true' : 'false');
      loadedToggle.title = loadedOnly
        ? 'Showing loaded models only'
        : 'Show loaded models only';
    }
    const libraryToggle = bar.querySelector<HTMLButtonElement>(
      '.model-host-filter-library-toggle',
    );
    if (libraryToggle) {
      libraryToggle.setAttribute('aria-pressed', libraryOnly ? 'true' : 'false');
      libraryToggle.title = libraryOnly
        ? 'Showing My Models only'
        : 'Show My Models only';
    }
  }
}

function providerIdForOption(opt: HTMLOptionElement): string {
  const fromAttr = opt.getAttribute('data-provider-id')?.trim();
  if (fromAttr) return fromAttr;
  return decodeModelSelectKey(opt.value)?.providerId ?? '';
}

function isLocalProviderId(providerId: string, opt?: HTMLOptionElement): boolean {
  const hostAttr = opt?.getAttribute('data-provider-host');
  if (hostAttr === 'local') return true;
  if (hostAttr === 'cloud') return false;

  const id = providerId.trim();
  if (!id) return true;
  if (isKnownLocalProviderId(id)) return true;
  return false;
}

function optionMatchesHostFilter(opt: HTMLOptionElement, filter: ModelHostFilter): boolean {
  if (filter === 'all') return true;
  const isLocal = isLocalProviderId(providerIdForOption(opt), opt);
  return filter === 'local' ? isLocal : !isLocal;
}

function filterOptionsByHost(
  options: HTMLOptionElement[],
  filter: ModelHostFilter,
): HTMLOptionElement[] {
  if (filter === 'all') return options;
  return options.filter((opt) => optionMatchesHostFilter(opt, filter));
}

function optionMatchesLocalLoadFilter(
  opt: HTMLOptionElement,
  filter: ModelLocalLoadFilter,
): boolean {
  if (filter === 'all') return true;
  if (!isLocalProviderId(providerIdForOption(opt), opt)) return true;
  const cached = modelCache.get(opt.value.trim());
  return cached ? resolveModelState(cached) === 'loaded' : false;
}

function filterOptionsByLocalLoad(
  options: HTMLOptionElement[],
  filter: ModelLocalLoadFilter,
): HTMLOptionElement[] {
  if (filter === 'all') return options;
  return options.filter((opt) => optionMatchesLocalLoadFilter(opt, filter));
}

function optionMatchesLibraryFilter(
  opt: HTMLOptionElement,
  filter: ModelLibraryFilter,
): boolean {
  if (filter === 'all') return true;
  return isLibraryModelProviderId(providerIdForOption(opt));
}

function filterOptionsByLibrary(
  options: HTMLOptionElement[],
  filter: ModelLibraryFilter,
): HTMLOptionElement[] {
  if (filter === 'all') return options;
  return options.filter((opt) => optionMatchesLibraryFilter(opt, filter));
}

function optionMatchesSearch(opt: HTMLOptionElement, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const canonicalId = tooltipModelIdForOptionValue(opt.value);
  const producer = producerDisplayName(producerSlugFromModelId(canonicalId)).toLowerCase();
  const haystack = [
    opt.text,
    opt.value,
    canonicalId,
    opt.title ?? '',
    producer,
  ]
    .join(' ')
    .toLowerCase();
  return haystack.includes(q);
}

function filterOptionsBySearch(
  options: HTMLOptionElement[],
  query: string,
): HTMLOptionElement[] {
  if (!query.trim()) return options;
  return options.filter((opt) => optionMatchesSearch(opt, query));
}

function emptyFilterMessage(
  hostFilter: ModelHostFilter,
  loadFilter: ModelLocalLoadFilter,
  libraryFilter: ModelLibraryFilter,
  searchQuery: string,
): string {
  if (searchQuery.trim()) return 'No matching models';
  if (libraryFilter === 'library') return 'No My Models';
  if (hostFilter === 'local' && loadFilter === 'loaded') return 'No loaded local models';
  if (hostFilter === 'local') return 'No local models';
  if (hostFilter === 'cloud') return 'No cloud models';
  return 'No models';
}

/** Optional hooks after refresh from a host-filter action row. */
export interface ModelHostFilterBarOptions {
  onFilterChange: () => void;
  onAfterRefresh?: () => void;
  /** When set, Load/Unload in this bar targets this value instead of #modelSelect. */
  resolveLoadUnloadValue?: () => string;
}

function normalizeHostFilterBarOptions(
  callbacks: ModelHostFilterBarOptions | (() => void),
): ModelHostFilterBarOptions {
  return typeof callbacks === 'function' ? { onFilterChange: callbacks } : callbacks;
}

async function refreshModelsFromHostFilterBar(
  refreshBtn: HTMLButtonElement,
  onAfterRefresh?: () => void,
): Promise<void> {
  if (refreshBtn.disabled || isModelLoadUnloadBusy()) return;
  refreshBtn.disabled = true;
  try {
    const { fetchModels } = await import('../api/models');
    await fetchModels();
    onAfterRefresh?.();
  } finally {
    refreshBtn.disabled = false;
  }
}

function mountModelHostFilterActions(
  toolbarEnd: HTMLDivElement,
  options: ModelHostFilterBarOptions,
): void {
  const actions = document.createElement('div');
  actions.className = 'model-host-filter-actions';
  actions.setAttribute('role', 'group');
  actions.setAttribute('aria-label', 'Model actions');

  const refreshBtn = document.createElement('button');
  refreshBtn.type = 'button';
  refreshBtn.className = 'model-host-filter-action model-host-filter-action--refresh';
  refreshBtn.innerHTML = MODEL_REFRESH_ICON_HTML;
  refreshBtn.setAttribute('aria-label', 'Refresh models');
  refreshBtn.title = 'Refresh model list';
  refreshBtn.addEventListener('mousedown', (e) => e.preventDefault());
  refreshBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    await refreshModelsFromHostFilterBar(refreshBtn, options.onAfterRefresh);
  });

  actions.append(refreshBtn);
  toolbarEnd.appendChild(actions);
}

function scheduleModelSearchRerender(onFilterChange: () => void): void {
  if (modelSearchDebounceTimer) clearTimeout(modelSearchDebounceTimer);
  modelSearchDebounceTimer = setTimeout(() => {
    modelSearchDebounceTimer = null;
    onFilterChange();
  }, MODEL_SEARCH_DEBOUNCE_MS);
}

function mountModelHostFilterSearch(
  bar: HTMLDivElement,
  onFilterChange: () => void,
): void {
  const searchWrap = document.createElement('div');
  searchWrap.className = 'model-host-filter-search-wrap';

  const searchInput = document.createElement('input');
  searchInput.type = 'search';
  searchInput.className = 'model-host-filter-search';
  searchInput.placeholder = 'Search models…';
  searchInput.setAttribute('aria-label', 'Search models');
  searchInput.autocomplete = 'off';
  searchInput.spellcheck = false;
  searchInput.value = getModelSearchQuery();

  searchInput.addEventListener('mousedown', (e) => e.stopPropagation());
  searchInput.addEventListener('click', (e) => e.stopPropagation());
  searchInput.addEventListener('input', () => {
    setModelSearchQuery(searchInput.value);
    scheduleModelSearchRerender(onFilterChange);
  });
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      if (searchInput.value) {
        setModelSearchQuery('');
        onFilterChange();
      }
    }
  });

  searchWrap.appendChild(searchInput);
  bar.appendChild(searchWrap);
}

function mountModelHostFilterLibraryToggle(
  toolbarEnd: HTMLDivElement,
  onFilterChange: () => void,
): void {
  const libraryToggle = document.createElement('button');
  libraryToggle.type = 'button';
  libraryToggle.className =
    'model-host-filter-action model-host-filter-library-toggle';
  libraryToggle.innerHTML = MINNOW_GLYPH_HEADER_HTML;
  libraryToggle.setAttribute('aria-label', 'My Models only');
  libraryToggle.setAttribute('aria-pressed', 'false');
  libraryToggle.title = 'Show My Models only';
  libraryToggle.addEventListener('mousedown', (e) => e.preventDefault());
  libraryToggle.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleModelLibraryFilter();
    onFilterChange();
  });
  toolbarEnd.appendChild(libraryToggle);
}

function mountModelHostFilterLoadedToggle(
  toolbarEnd: HTMLDivElement,
  onFilterChange: () => void,
): void {
  const loadedToggle = document.createElement('button');
  loadedToggle.type = 'button';
  loadedToggle.className =
    'model-host-filter-action model-host-filter-loaded-toggle';
  loadedToggle.innerHTML = MODEL_LOADED_TOGGLE_ICON_HTML;
  loadedToggle.setAttribute('aria-label', 'Loaded models only');
  loadedToggle.setAttribute('aria-pressed', 'false');
  loadedToggle.hidden = getModelHostFilter() !== 'local';
  loadedToggle.title = 'Show loaded models only';
  loadedToggle.addEventListener('mousedown', (e) => e.preventDefault());
  loadedToggle.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleModelLocalLoadFilter();
    onFilterChange();
  });
  toolbarEnd.appendChild(loadedToggle);
}

/** Mount search, All / Local / Cloud segments, loaded toggle, and action icons. */
export function mountModelHostFilterBar(
  parent: HTMLElement,
  callbacks: ModelHostFilterBarOptions | (() => void),
  extraClass = '',
): HTMLDivElement {
  const options = normalizeHostFilterBarOptions(callbacks);
  const bar = document.createElement('div');
  bar.className = ['model-select-host-filter', extraClass].filter(Boolean).join(' ');
  bar.setAttribute('role', 'group');
  bar.setAttribute('aria-label', 'Model filters');

  mountModelHostFilterSearch(bar, options.onFilterChange);

  const controls = document.createElement('div');
  controls.className = 'model-host-filter-controls';

  const segments = document.createElement('div');
  segments.className = 'model-host-filter-segmented';

  for (const { id, label } of HOST_FILTER_CHOICES) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'model-host-filter-segment';
    btn.textContent = label;
    btn.dataset.filter = id;
    btn.setAttribute('role', 'radio');
    btn.setAttribute('aria-checked', getModelHostFilter() === id ? 'true' : 'false');
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      setModelHostFilter(id);
      options.onFilterChange();
    });
    segments.appendChild(btn);
  }

  const toolbarEnd = document.createElement('div');
  toolbarEnd.className = 'model-host-filter-toolbar-end';

  controls.appendChild(segments);
  controls.appendChild(toolbarEnd);
  mountModelHostFilterLibraryToggle(toolbarEnd, options.onFilterChange);
  mountModelHostFilterLoadedToggle(toolbarEnd, options.onFilterChange);
  mountModelHostFilterActions(toolbarEnd, options);
  bar.appendChild(controls);
  if (options.resolveLoadUnloadValue) {
    setModelHostFilterLoadUnloadResolver(bar, options.resolveLoadUnloadValue);
  }
  parent.appendChild(bar);
  syncAllModelHostFilterBars();
  return bar;
}

// ── Menu actions ─────────────────────────────────────────────────────────────

/** Options for the shared menu action row. */
export interface ModelMenuActionsOptions {
  /** Model select value the Load / Open settings actions target. */
  resolveSelectValue: () => string;
  /** Close the owning menu before the Models app takes over. */
  closeMenu?: () => void;
  /** Let the owning surface immediately adopt a changed per-model default. */
  onReasoningDefaultChange?: (
    selectValue: string,
    effort: ReasoningEffortOption | null,
  ) => void;
  /** Board menus keep their run-specific reasoning control in the board header. */
  showReasoningDefault?: boolean;
}

function reasoningLevelsForSelectValue(selectValue: string): {
  levels: ReasoningEffortOption[];
  catalogDefault?: ReasoningEffortOption;
} {
  const value = selectValue.trim();
  const decoded = decodeModelSelectKey(value);
  const cached = modelCache.get(value);
  const caps = decoded
    ? resolveSendCapabilities(decoded.providerId, decoded.modelId, cached?.api)
    : cached?.capabilities;
  const levels = getComposerReasoningLevelOptions(caps?.reasoningAllowedOptions ?? []);
  return { levels, catalogDefault: defaultComposerReasoningLevel(caps) };
}

/** Refresh the reasoning-default selector in one shared model-menu footer. */
export function syncModelMenuReasoningDefaultAction(row: HTMLElement): void {
  const wrap = row.querySelector<HTMLElement>('.model-menu-reasoning-default');
  const select = row.querySelector<HTMLSelectElement>('.model-menu-reasoning-default__select');
  if (!wrap || !select) return;
  if (wrap.dataset.disabled === 'true') {
    wrap.hidden = true;
    return;
  }
  const value = resolveModelHostFilterLoadUnloadValue(row);
  const { levels, catalogDefault } = reasoningLevelsForSelectValue(value);
  wrap.hidden = levels.length === 0;
  select.disabled = levels.length === 0;
  if (levels.length === 0) {
    select.replaceChildren();
    return;
  }

  const saved = getModelReasoningDefault(value);
  select.replaceChildren();
  const inherit = document.createElement('option');
  inherit.value = '';
  inherit.textContent = catalogDefault
    ? `Model default (${formatReasoningEffortLabel(catalogDefault)})`
    : 'Model default';
  select.appendChild(inherit);
  for (const level of levels) {
    const option = document.createElement('option');
    option.value = level;
    option.textContent = formatReasoningEffortLabel(level);
    select.appendChild(option);
  }
  select.value = saved && levels.includes(saved) ? saved : '';
}

/** Refresh every mounted model-menu footer after a target or catalog change. */
export function syncAllModelMenuReasoningDefaults(): void {
  for (const row of document.querySelectorAll<HTMLElement>('.model-menu-actions')) {
    syncModelMenuReasoningDefaultAction(row);
  }
}

/**
 * Open Models → My Models load settings for the model behind a picker select value.
 * Values with no My Models row (cloud providers) just land on the list.
 */
export async function openModelLoadSettings(selectValue: string): Promise<void> {
  const decoded = decodeModelSelectKey(selectValue.trim());

  const { openModels } = await import('./models-page');
  openModels('installed');

  const { getModelsState, refreshModels } = await import('./models/store');
  await refreshModels().catch(() => undefined);

  const target = decoded
    ? resolveLibraryModelIdForChatBinding(
        decoded.providerId,
        decoded.modelId,
        getModelsState().library,
      )
    : null;
  if (!target) return;

  const { showModelInInspector } = await import('./models/inspector');
  showModelInInspector(target, 'load');
}

/**
 * Mount the menu action row: Load / Unload for the targeted model, and a hand-off
 * into that model's My Models load settings. Rows never carry their own Load button.
 */
export function mountModelMenuActions(
  parent: HTMLElement,
  options: ModelMenuActionsOptions,
): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'model-menu-actions';
  row.setAttribute('role', 'group');
  row.setAttribute('aria-label', 'Model actions');
  setModelMenuActionResolver(row, options.resolveSelectValue);

  const reasoningWrap = document.createElement('label');
  reasoningWrap.className = 'model-menu-reasoning-default';
  reasoningWrap.hidden = true;
  if (options.showReasoningDefault === false) reasoningWrap.dataset.disabled = 'true';

  const reasoningLabel = document.createElement('span');
  reasoningLabel.className = 'model-menu-reasoning-default__label';
  reasoningLabel.textContent = 'Reasoning default';

  const reasoningSelect = document.createElement('select');
  reasoningSelect.className = 'model-menu-reasoning-default__select';
  reasoningSelect.setAttribute('aria-label', 'Default reasoning level for this model');
  reasoningSelect.addEventListener('mousedown', (e) => e.stopPropagation());
  reasoningSelect.addEventListener('click', (e) => e.stopPropagation());
  reasoningSelect.addEventListener('change', () => {
    const value = resolveModelHostFilterLoadUnloadValue(reasoningSelect);
    const effort = reasoningSelect.value
      ? reasoningSelect.value as ReasoningEffortOption
      : null;
    const saving = saveModelReasoningDefault(value, effort);
    options.onReasoningDefaultChange?.(value, effort);
    void saving
      .then(() => reasoningSelect.removeAttribute('title'))
      .catch(() => {
        reasoningSelect.title = 'Could not save reasoning default';
      });
  });
  reasoningWrap.append(reasoningLabel, reasoningSelect);

  const loadBtn = document.createElement('button');
  loadBtn.type = 'button';
  loadBtn.className = 'model-menu-action model-menu-action--load-unload';
  loadBtn.textContent = 'Load';
  loadBtn.hidden = true;
  loadBtn.addEventListener('mousedown', (e) => e.stopPropagation());
  loadBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    const value = resolveModelHostFilterLoadUnloadValue(loadBtn);
    if (!value) return;
    void import('../api/models').then((m) => m.toggleModelLoadForSelectValue(value));
  });

  const settingsBtn = document.createElement('button');
  settingsBtn.type = 'button';
  settingsBtn.className = 'model-menu-action model-menu-action--settings';
  settingsBtn.textContent = 'Open settings';
  settingsBtn.title = 'Open this model in Models → My models load settings';
  settingsBtn.addEventListener('mousedown', (e) => e.stopPropagation());
  settingsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    const value = resolveModelHostFilterLoadUnloadValue(settingsBtn);
    options.closeMenu?.();
    void openModelLoadSettings(value);
  });

  row.append(reasoningWrap, loadBtn, settingsBtn);
  parent.appendChild(row);
  if (options.showReasoningDefault !== false) syncModelMenuReasoningDefaultAction(row);
  return row;
}

function getTopBarModelPopover(): HTMLElement | null {
  return document.querySelector('.model-select-inner .model-select-popover');
}

/** Close the model list popover. */
export function closeModelSelectMenu(): void {
  closeAuxiliaryModelSelectMenu();
  clearModelSearchQuery();
  const { root, trigger, menu } = getElements();
  open = false;
  modelMenuActiveIndex = -1;
  menu?.removeAttribute('aria-activedescendant');
  root?.classList.remove('is-open');
  getTopBarModelPopover()?.classList.add('hidden');
  menu?.classList.add('hidden');
  trigger?.setAttribute('aria-expanded', 'false');
  if (chromePopoverRegistered) {
    unregisterChromePopover();
    chromePopoverRegistered = false;
  }
}

function openModelSelectMenu(): void {
  const { root, trigger, menu, sel } = getElements();
  if (!root || !trigger || !menu || !sel || trigger.disabled) return;
  closeAuxiliaryModelSelectMenu();
  closeExternalModelMenus();
  open = true;
  root.classList.add('is-open');
  getTopBarModelPopover()?.classList.remove('hidden');
  menu.classList.remove('hidden');
  trigger.setAttribute('aria-expanded', 'true');
  if (!chromePopoverRegistered) {
    registerChromePopover();
    chromePopoverRegistered = true;
  }
  void import('../api/models').then(({ updateModelLoadUnloadButtons }) => {
    updateModelLoadUnloadButtons();
  });
  focusModelHostFilterSearch();
  const selectedIndex = listModelMenuOptions(menu).findIndex(
    (li) => li.classList.contains('model-select-option--selected'),
  );
  syncModelMenuActiveOption(menu, selectedIndex >= 0 ? selectedIndex : 0);
}

function toggleModelSelectMenu(): void {
  if (open) closeModelSelectMenu();
  else openModelSelectMenu();
}

function resolveSelectOption(
  sel: HTMLSelectElement,
  modelIdOrKey: string,
): HTMLOptionElement | undefined {
  const key = modelIdOrKey.trim();
  if (!key) return sel.options[sel.selectedIndex];
  return [...sel.options].find((o) => o.value === key) ?? sel.options[sel.selectedIndex];
}

/** Keep the model popover open after pick when the provider supports load/unload and the model is not loaded yet (Load is the expected next action). */
export function shouldKeepModelMenuOpenAfterSelect(modelIdOrKey: string): boolean {
  if (!isServerStorageMode()) return false;
  const sel = document.getElementById('modelSelect') as HTMLSelectElement | null;
  if (!sel) return false;

  const key = modelIdOrKey.trim();
  if (!key) return false;

  const opt = resolveSelectOption(sel, key);
  if (opt?.getAttribute('data-supports-load-unload') !== '1') return false;

  const direct = modelCache.get(key);
  if (direct) return !isModelLoaded(direct);

  const decoded = decodeModelSelectKey(key);
  if (decoded) {
    const compositeKey = encodeModelSelectKey(decoded.providerId, decoded.modelId);
    const row = modelCache.get(compositeKey);
    if (row) return !isModelLoaded(row);
  }

  return true;
}

/** Select a model in the native picker and notify listeners (top bar or OS menubar). */
export function selectModelInPicker(modelId: string): void {
  const { sel } = getElements();
  if (!sel || !modelId) return;
  const keepOpen = shouldKeepModelMenuOpenAfterSelect(modelId);
  if (!keepOpen) closeModelSelectMenu();
  if (sel.value === modelId) {
    syncModelSelectPicker();
    return;
  }
  sel.value = modelId;
  sel.dispatchEvent(new Event('change', { bubbles: true }));
}

function pickModel(modelId: string): void {
  selectModelInPicker(modelId);
}

type ModelSelectPickHandler = (modelId: string) => void;

interface AuxiliaryModelSelectPicker {
  root: HTMLDivElement;
  trigger: HTMLButtonElement;
  triggerText: HTMLSpanElement;
  menu: HTMLUListElement;
}

const auxiliaryPickers = new WeakMap<HTMLSelectElement, AuxiliaryModelSelectPicker>();
let openAuxiliaryPicker: AuxiliaryModelSelectPicker | null = null;
let auxiliaryPickerGlobalsBound = false;

function closeAuxiliaryModelSelectMenu(): void {
  if (!openAuxiliaryPicker) return;
  openAuxiliaryPicker.root.classList.remove('is-open');
  openAuxiliaryPicker.menu.classList.add('hidden');
  openAuxiliaryPicker.trigger.setAttribute('aria-expanded', 'false');
  openAuxiliaryPicker = null;
  if (auxiliaryChromePopoverRegistered) {
    unregisterChromePopover();
    auxiliaryChromePopoverRegistered = false;
  }
}

function ensureAuxiliaryPickerGlobals(): void {
  if (auxiliaryPickerGlobalsBound) return;
  auxiliaryPickerGlobalsBound = true;

  document.addEventListener('mousedown', (e) => {
    if (!openAuxiliaryPicker) return;
    const target = e.target as Node;
    if (!openAuxiliaryPicker.root.contains(target)) closeAuxiliaryModelSelectMenu();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && openAuxiliaryPicker) closeAuxiliaryModelSelectMenu();
  });
}

/** Resolve the active option for a native model select (value is authoritative). */
function selectedOptionForSelect(select: HTMLSelectElement): HTMLOptionElement | undefined {
  const value = select.value.trim();
  if (value) {
    const match = [...select.options].find((o) => o.value === value);
    if (match) return match;
  }
  return select.options[select.selectedIndex];
}

/** Sync trigger label and custom menu rows for a mounted auxiliary model combobox. */
export function syncAuxiliaryModelSelectCombobox(select: HTMLSelectElement): void {
  const picker = auxiliaryPickers.get(select);
  if (!picker) return;

  const selectedOpt = selectedOptionForSelect(select);
  picker.triggerText.textContent =
    selectedOpt?.text?.trim() || selectedOpt?.label?.trim() || 'Select model';

  const triggerTitle = selectedOpt?.title?.trim() || select.value.trim() || '';
  if (triggerTitle) picker.triggerText.title = triggerTitle;
  else picker.triggerText.removeAttribute('title');

  const hasSelectable =
    [...select.options].some((o) => o.value.trim() !== '') && !select.disabled;
  picker.trigger.disabled = !hasSelectable;

  renderModelSelectMenuRows(picker.menu, select, (modelId) => {
    closeAuxiliaryModelSelectMenu();
    closeModelSelectMenu();
    if (select.value === modelId) {
      syncAuxiliaryModelSelectCombobox(select);
      return;
    }
    select.value = modelId;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

/** Wrap a native model &lt;select&gt; with the same custom list UI as the top-bar picker. */
export function mountAuxiliaryModelSelectCombobox(select: HTMLSelectElement): void {
  if (auxiliaryPickers.has(select)) return;
  ensureAuxiliaryPickerGlobals();

  const root = document.createElement('div');
  root.className = 'model-select-inner';

  const parent = select.parentElement;
  if (!parent) return;
  parent.insertBefore(root, select);
  root.appendChild(select);

  select.classList.add('model-select-native');
  select.tabIndex = -1;
  select.setAttribute('aria-hidden', 'true');

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'model-select-trigger';
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');

  const triggerText = document.createElement('span');
  triggerText.className = 'model-select-trigger-text';
  triggerText.textContent = 'Select model';
  trigger.appendChild(triggerText);

  const menu = document.createElement('ul');
  menu.className = 'model-select-menu hidden';
  menu.setAttribute('role', 'listbox');

  const labelledBy = select.getAttribute('aria-label')?.trim();
  if (labelledBy) menu.setAttribute('aria-label', labelledBy);

  root.appendChild(trigger);
  root.appendChild(menu);

  const picker: AuxiliaryModelSelectPicker = { root, trigger, triggerText, menu };
  auxiliaryPickers.set(select, picker);

  select.addEventListener('change', () => {
    syncAuxiliaryModelSelectCombobox(select);
  });

  trigger.addEventListener('click', () => {
    if (trigger.disabled) return;
    if (openAuxiliaryPicker === picker) {
      closeAuxiliaryModelSelectMenu();
      return;
    }
    closeModelSelectMenu();
    closeAuxiliaryModelSelectMenu();
    openAuxiliaryPicker = picker;
    picker.root.classList.add('is-open');
    picker.menu.classList.remove('hidden');
    picker.trigger.setAttribute('aria-expanded', 'true');
    if (!auxiliaryChromePopoverRegistered) {
      registerChromePopover();
      auxiliaryChromePopoverRegistered = true;
    }
    syncAuxiliaryModelSelectCombobox(select);
  });

  syncAuxiliaryModelSelectCombobox(select);
}

/** Canonical model id for capability tooltip lines (strip composite select encoding). */
function tooltipModelIdForOptionValue(value: string): string {
  return decodeModelSelectKey(value)?.modelId ?? value;
}

/** Build a small inline producer logo span when a pattern matches. */
function createProducerLogoSpan(modelId: string): HTMLSpanElement | null {
  const svg = modelProducerLogoSvg(modelId);
  if (!svg) return null;
  const logo = document.createElement('span');
  logo.className = 'model-producer-logo';
  logo.setAttribute('aria-hidden', 'true');
  logo.innerHTML = svg;
  return logo;
}

/** Append one selectable row for an <option> (shared by flat options and optgroup children). */
function appendModelOptionRow(
  menu: HTMLUListElement,
  opt: HTMLOptionElement,
  selectedValue: string,
  indented = false,
  onSelect?: ModelSelectPickHandler,
): void {
  const id = opt.value.trim();
  if (!id) return;

  const cached = modelCache.get(id);
  let loadState: ModelLoadState = cached ? resolveModelState(cached) : 'unknown';
  if (isModelLoadUnloadBusy() && id === getModelLoadUnloadTargetSelectValue()) {
    loadState = 'loading';
  }
  const canonicalModelId = tooltipModelIdForOptionValue(id);

  const li = document.createElement('li');
  li.className = 'model-select-option';
  if (indented) li.classList.add('model-select-option--grouped');
  if (id === selectedValue) {
    li.classList.add('model-select-option--selected');
    li.setAttribute('aria-selected', 'true');
  } else {
    li.setAttribute('aria-selected', 'false');
  }
  li.setAttribute('role', 'option');
  li.dataset.value = id;

  const caps = cached?.capabilities;
  const probedAt = getLastCapabilitiesProbedAt();
  const tipId = canonicalModelId;
  const rowTitle = caps
    ? formatCapabilityTooltip(tipId, caps, probedAt)
    : opt.title?.trim() || tipId;
  li.title = rowTitle;

  const logo = createProducerLogoSpan(canonicalModelId);

  const dot = document.createElement('span');
  dot.className = 'model-load-dot';
  dot.setAttribute('aria-hidden', 'true');
  dot.dataset.loadState = loadState;

  const label = document.createElement('span');
  label.className = 'model-select-option-label';
  label.textContent = opt.text;
  label.title = rowTitle;

  const activityEl = document.createElement('span');
  activityEl.className = 'model-select-option-activity';
  activityEl.dataset.activityFor = canonicalModelId;
  activityEl.setAttribute('aria-hidden', 'true');
  activityEl.textContent = activitySuffixForModelId(canonicalModelId);

  const badges = formatCapabilityBadges(caps);
  if (logo) li.appendChild(logo);
  if (badges.length > 0) {
    const badgeSpan = document.createElement('span');
    badgeSpan.className = 'model-cap-badges';
    badgeSpan.setAttribute('aria-hidden', 'true');
    for (const text of badges) {
      const chip = document.createElement('span');
      chip.className = 'model-cap-badge';
      chip.textContent = text;
      badgeSpan.appendChild(chip);
    }
    li.appendChild(dot);
    li.appendChild(label);
    li.appendChild(activityEl);
    li.appendChild(badgeSpan);
  } else {
    li.appendChild(dot);
    li.appendChild(label);
    li.appendChild(activityEl);
  }

  li.addEventListener('mousedown', (e) => {
    e.preventDefault();
    if (onSelect) onSelect(id);
    else pickModel(id);
  });

  menu.appendChild(li);
}

/** Flatten all selectable options from the native select (including optgroup children). */
function collectSelectOptions(sel: HTMLSelectElement): HTMLOptionElement[] {
  const options: HTMLOptionElement[] = [];
  for (const child of [...sel.children]) {
    const tag = child.tagName;
    if (tag === 'OPTGROUP') {
      for (const el of [...child.children]) {
        if (el.tagName === 'OPTION' && (el as HTMLOptionElement).value.trim()) {
          options.push(el as HTMLOptionElement);
        }
      }
    } else if (tag === 'OPTION' && (child as HTMLOptionElement).value.trim()) {
      options.push(child as HTMLOptionElement);
    }
  }
  return options;
}

/** Sort producer slugs alphabetically by display name; `other` always last. */
function sortProducerSlugs(slugs: string[]): string[] {
  return [...slugs].sort((a, b) => {
    if (a === 'other') return 1;
    if (b === 'other') return -1;
    return producerDisplayName(a).localeCompare(producerDisplayName(b));
  });
}

/** Append a collapsible producer group header. */
function appendProducerHeader(
  menu: HTMLUListElement,
  slug: string,
  count: number,
  sampleModelId: string,
  collapsed: Set<string>,
  onToggle: () => void,
): void {
  const isCollapsed = collapsed.has(slug);
  const producer = resolveModelProducer(sampleModelId);

  const header = document.createElement('li');
  header.className = 'model-select-producer-header';
  header.setAttribute('role', 'presentation');
  header.dataset.producerSlug = slug;

  const chevron = document.createElement('span');
  chevron.className = 'model-select-producer-chevron';
  if (isCollapsed) chevron.classList.add('model-select-producer-chevron--collapsed');
  chevron.setAttribute('aria-hidden', 'true');
  chevron.innerHTML = iconHtml('chevronDown', { size: 10 });

  if (producer.logoSvg) {
    const logo = document.createElement('span');
    logo.className = 'model-producer-logo';
    logo.setAttribute('aria-hidden', 'true');
    logo.innerHTML = producer.logoSvg;
    header.appendChild(chevron);
    header.appendChild(logo);
  } else {
    header.appendChild(chevron);
  }

  const name = document.createElement('span');
  name.className = 'model-select-producer-name';
  name.textContent = producer.displayName;

  const countEl = document.createElement('span');
  countEl.className = 'model-select-producer-count';
  countEl.textContent = String(count);

  header.appendChild(name);
  header.appendChild(countEl);

  header.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    onToggle();
  });

  menu.appendChild(header);
}

/** Rebuild model list rows into any menu element (shared by top bar and OS menubar). */
export function renderModelSelectMenuRows(
  menu: HTMLUListElement,
  sel: HTMLSelectElement,
  onSelect?: ModelSelectPickHandler,
  selectedValueOverride?: string,
): void {
  const selectedValue = selectedValueOverride?.trim() || sel.value;
  const scrollTop = menu.scrollTop;
  menu.innerHTML = '';

  const allOptions = collectSelectOptions(sel);
  if (allOptions.length === 0) return;

  const hostFilter = getModelHostFilter();
  const loadFilter = getModelLocalLoadFilter();
  const libraryFilter = getModelLibraryFilter();
  const searchQuery = getModelSearchQuery();
  let options = filterOptionsByHost(allOptions, hostFilter);
  if (hostFilter === 'local') {
    options = filterOptionsByLocalLoad(options, loadFilter);
  }
  options = filterOptionsByLibrary(options, libraryFilter);
  options = filterOptionsBySearch(options, searchQuery);
  if (options.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'model-select-empty-filter';
    empty.setAttribute('role', 'presentation');
    empty.textContent = emptyFilterMessage(hostFilter, loadFilter, libraryFilter, searchQuery);
    menu.appendChild(empty);
    return;
  }

  const collapsed = loadCollapsedProducers();

  const toggleCollapse = (slug: string): void => {
    if (collapsed.has(slug)) collapsed.delete(slug);
    else collapsed.add(slug);
    saveCollapsedProducers(collapsed);
    renderModelSelectMenuRows(menu, sel, onSelect);
    menu.scrollTop = scrollTop;
  };

  if (options.length <= BROWSE_ALL_LIMIT) {
    for (const opt of options) {
      appendModelOptionRow(menu, opt, selectedValue, false, onSelect);
    }
    void import('../api/models').then((m) => m.updateModelLoadUnloadButtons());
    return;
  }

  const groups = new Map<string, HTMLOptionElement[]>();
  for (const opt of options) {
    const modelId = tooltipModelIdForOptionValue(opt.value);
    const slug = producerSlugFromModelId(modelId);
    const list = groups.get(slug);
    if (list) list.push(opt);
    else groups.set(slug, [opt]);
  }

  for (const slug of sortProducerSlugs([...groups.keys()])) {
    const groupOptions = groups.get(slug);
    if (!groupOptions?.length) continue;

    const sampleModelId = tooltipModelIdForOptionValue(groupOptions[0].value);
    appendProducerHeader(menu, slug, groupOptions.length, sampleModelId, collapsed, () =>
      toggleCollapse(slug),
    );

    if (!collapsed.has(slug)) {
      for (const opt of groupOptions) {
        appendModelOptionRow(menu, opt, selectedValue, true, onSelect);
      }
    }
  }
  void import('../api/models').then((m) => m.updateModelLoadUnloadButtons());
}

/** Rebuild menu rows and trigger label from the native select + model cache. */
export function syncModelSelectPicker(): void {
  const { sel, trigger, triggerText, menu } = getElements();
  if (!sel || !trigger || !triggerText || !menu) return;

  const selectedValue = sel.value;
  const selectedOpt = sel.options[sel.selectedIndex];
  triggerText.textContent =
    selectedOpt?.text?.trim() || selectedOpt?.label?.trim() || 'Select model';

  const triggerTitle =
    selectedOpt?.title?.trim() || selectedValue.trim() || '';
  if (triggerTitle) triggerText.title = triggerTitle;
  else triggerText.removeAttribute('title');

  const hasSelectable =
    [...sel.options].some((o) => o.value.trim() !== '') && !sel.disabled;
  trigger.disabled = !hasSelectable;

  renderModelSelectMenuRows(menu, sel);
  syncAllModelMenuReasoningDefaults();
  const CustomEventCtor = document.defaultView?.CustomEvent ?? CustomEvent;
  document.dispatchEvent(new CustomEventCtor('minnow:model-select-synced'));
}

/** Bind trigger, outside click, and escape for the model combobox. */
function ensureTopBarHostFilterBar(): void {
  const root = document.querySelector('.model-select-inner');
  const menu = document.getElementById('modelSelectMenu');
  if (!root || !menu || root.querySelector('.model-select-popover')) return;

  const shell = document.createElement('div');
  shell.className = 'model-select-popover hidden';
  menu.parentNode?.insertBefore(shell, menu);
  shell.appendChild(menu);

  mountModelHostFilterBar(shell, {
    onFilterChange: () => {
      const { sel, menu: menuEl } = getElements();
      if (sel && menuEl) renderModelSelectMenuRows(menuEl, sel);
    },
    onAfterRefresh: () => {
      const { sel, menu: menuEl } = getElements();
      if (sel && menuEl) renderModelSelectMenuRows(menuEl, sel);
    },
  });

  mountModelMenuActions(shell, {
    resolveSelectValue: () => {
      const { sel } = getElements();
      return sel?.value.trim() ?? '';
    },
    closeMenu: closeModelSelectMenu,
    onReasoningDefaultChange: (selectValue) => {
      void import('./chat-model-ui').then((m) => {
        m.refreshActiveChatReasoningDefault(selectValue);
      });
    },
  });
}

export function initModelSelectPicker(): void {
  if (pickerBound) return;
  pickerBound = true;

  const { trigger } = getElements();
  if (!trigger) return;

  ensureTopBarHostFilterBar();

  trigger.addEventListener('click', () => {
    toggleModelSelectMenu();
  });

  document.addEventListener('mousedown', (e) => {
    if (!open) return;
    const target = e.target as Node;
    const { root } = getElements();
    if (root && !root.contains(target)) closeModelSelectMenu();
  });

  document.addEventListener('keydown', (e) => {
    if (!open) return;
    if (e.key === 'Escape') {
      closeModelSelectMenu();
      return;
    }
    handleTopBarModelMenuKeydown(e);
  });
}

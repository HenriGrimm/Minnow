import {
  cycleLibraryListSort,
  DEFAULT_LIBRARY_LIST_SORT,
  loadableLibrary,
  presetForSort,
  sortFromPreset,
  type LibraryListSort,
  type LibraryModel,
  type LibrarySortPreset,
  type LibraryTableSortKey,
} from '../../models/library';
import {
  prepareLibraryGroups,
  resolveActiveVariant,
  totalBytesForGroups,
  type LibraryVariantGroup,
} from '../../models/library-group';
import { ariaSortValue as libraryAriaSortValue } from '../../models/library-sort';
import type { ServeRecord } from '../../models/api-client';
import { modelProducerLogoSvg } from '../../providers/model-producer';
import { setStatus } from '../status';
import {
  el,
  emptyState,
  formatBytes,
  formatContext,
  formatParams,
  icon,
  iconButton,
  isModelsSearchInputFocused,
  restoreModelsSearchInputFocus,
  skeletonRows,
  textButton,
} from './dom';
import { settingsFor, showModelInInspector } from './inspector';
import { ensureRuntimeForModel } from './runtime-install-prompt';
import {
  getModelsState,
  loadForModel,
  loadModel,
  refreshModels,
  serveForModel,
  subscribeModelsStore,
  unloadServe,
} from './store';
import { isRetryableServeStatus, retryLabelForServe, serveStatusLabel, settingsForServeRetry } from '../../models/serve-status';

interface LibraryFilters {
  search: string;
  format: string;
  publisher: string;
  producer: string;
  listSort: LibraryListSort;
}

/** Data columns after the identity cell. Modifiers drive responsive hiding. */
const COLUMNS: Array<[modifier: string, value: (m: LibraryModel) => string]> = [
  ['maker', (m) => m.producerName],
  ['params', (m) => formatParams(m.paramsB)],
  ['quant', (m) => m.quant || m.format],
  ['context', (m) => formatContext(m.contextLength)],
  ['size', (m) => formatBytes(m.sizeBytes)],
];

const COLUMN_LABELS: Record<string, string> = {
  maker: 'Maker',
  params: 'Params',
  quant: 'Quant',
  context: 'Context',
  size: 'Size',
};

/** Maps table column modifiers to sort keys. */
const COLUMN_SORT_KEYS: Record<string, LibraryTableSortKey> = {
  maker: 'maker',
  params: 'params',
  quant: 'quant',
  context: 'context',
  size: 'size',
};

const filters: LibraryFilters = {
  search: '',
  format: '',
  publisher: '',
  producer: '',
  listSort: { ...DEFAULT_LIBRARY_LIST_SORT },
};
/** Per-group quant picker choice (survives re-renders). */
const variantPreferences = new Map<string, string>();
let bound = false;

function mount(): HTMLElement | null {
  return document.getElementById('modelsInstalledBody');
}

function totals(groups: LibraryVariantGroup[]): string {
  const modelCount = groups.length;
  const bytes = totalBytesForGroups(groups);
  const noun = modelCount === 1 ? 'model' : 'models';
  return `${modelCount} ${noun} · ${formatBytes(bytes)}`;
}

function uniqueValues(models: LibraryModel[], key: 'format' | 'publisher'): string[] {
  return [...new Set(models.map((m) => m[key]).filter(Boolean))].sort();
}

function uniqueProducers(models: LibraryModel[]): Array<{ slug: string; label: string }> {
  const bySlug = new Map<string, string>();
  for (const model of models) {
    if (!model.producerSlug) continue;
    if (!bySlug.has(model.producerSlug)) {
      bySlug.set(model.producerSlug, model.producerName);
    }
  }
  return [...bySlug.entries()]
    .sort((a, b) => a[1].localeCompare(b[1]))
    .map(([slug, label]) => ({ slug, label }));
}

function producerLogoSpan(logoId: string): HTMLSpanElement | null {
  const svg = modelProducerLogoSvg(logoId);
  if (!svg) return null;
  const logo = el('span', 'model-producer-logo') as HTMLSpanElement;
  logo.setAttribute('aria-hidden', 'true');
  logo.innerHTML = svg;
  return logo;
}

function renderMakerCell(model: LibraryModel): HTMLElement {
  const cell = el('span', 'models-row__cell models-row__cell--maker');
  const wrap = el('span', 'models-row__maker');
  const logo = producerLogoSpan(model.producerLogoId);
  if (logo) wrap.appendChild(logo);
  wrap.appendChild(el('span', 'models-row__maker-name', model.producerName));
  cell.appendChild(wrap);
  return cell;
}

function selectControl(
  ariaLabel: string,
  options: Array<{ value: string; label: string }>,
  value: string,
  onChange: (next: string) => void,
): HTMLSelectElement {
  const select = el('select', 'models-select') as HTMLSelectElement;
  select.setAttribute('aria-label', ariaLabel);
  for (const opt of options) {
    const option = el('option', undefined, opt.label) as HTMLOptionElement;
    option.value = opt.value;
    if (opt.value === value) option.selected = true;
    select.appendChild(option);
  }
  select.addEventListener('change', () => onChange(select.value));
  return select;
}

function renderToolbar(all: LibraryModel[], shownGroups: LibraryVariantGroup[]): HTMLElement {
  const bar = el('div', 'models-toolbar');

  const searchWrap = el('div', 'models-search');
  searchWrap.appendChild(icon('search', 'models-search__icon'));
  const search = el('input', 'models-search__input') as HTMLInputElement;
  search.type = 'search';
  search.placeholder = 'Filter by name, quant, or architecture';
  search.value = filters.search;
  search.setAttribute('aria-label', 'Filter models');
  search.addEventListener('input', () => {
    filters.search = search.value;
    render();
  });
  searchWrap.appendChild(search);
  bar.appendChild(searchWrap);

  bar.append(
    selectControl(
      'Filter by format',
      [
        { value: '', label: 'All formats' },
        ...uniqueValues(all, 'format').map((v) => ({ value: v, label: v })),
      ],
      filters.format,
      (next) => {
        filters.format = next;
        render();
      },
    ),
    selectControl(
      'Filter by publisher',
      [
        { value: '', label: 'All publishers' },
        ...uniqueValues(all, 'publisher').map((v) => ({ value: v, label: v })),
      ],
      filters.publisher,
      (next) => {
        filters.publisher = next;
        render();
      },
    ),
    selectControl(
      'Filter by maker',
      [
        { value: '', label: 'All makers' },
        ...uniqueProducers(all).map((p) => ({ value: p.slug, label: p.label })),
      ],
      filters.producer,
      (next) => {
        filters.producer = next;
        render();
      },
    ),
    selectControl(
      'Sort models',
      [
        { value: '', label: 'Column order' },
        { value: 'name', label: 'Name' },
        { value: 'size', label: 'Largest first' },
        { value: 'params', label: 'Most parameters' },
        { value: 'producer', label: 'Group by maker' },
        { value: 'publisher', label: 'Group by publisher' },
      ],
      presetForSort(filters.listSort) ?? '',
      (next) => {
        if (next) filters.listSort = sortFromPreset(next as LibrarySortPreset);
        render();
      },
    ),
  );

  bar.appendChild(el('span', 'models-toolbar__count', totals(shownGroups)));
  bar.appendChild(
    iconButton('refresh', 'Rescan local folders', () => {
      void refreshModels({ fresh: true });
    }),
  );
  return bar;
}

function startLoad(model: LibraryModel, trigger: HTMLButtonElement): void {
  trigger.disabled = true;
  void (async () => {
    try {
      if (!(await ensureRuntimeForModel(model))) {
        trigger.disabled = false;
        return;
      }
      const serve = serveForModel(model);
      const settings =
        serve && isRetryableServeStatus(serve.status)
          ? settingsForServeRetry(serve, settingsFor(model))
          : settingsFor(model);
      await loadModel(model, settings);
    } catch (err) {
      setStatus('err', err instanceof Error ? err.message : 'Load failed');
      trigger.disabled = false;
    }
  })();
}

function renderRowActions(model: LibraryModel): HTMLElement {
  const wrap = el('div', 'models-row__actions');
  const serve = serveForModel(model);
  const load = loadForModel(model);

  if (load && !load.error) {
    wrap.appendChild(el('span', 'models-row__loading', load.phase));
    return wrap;
  }

  if (serve && (serve.status === 'running' || serve.status === 'starting' || serve.status === 'unhealthy')) {
    wrap.appendChild(
      textButton('Eject', () => {
        void unloadServe(serve.id).catch((err: unknown) => {
          setStatus('err', err instanceof Error ? err.message : 'Eject failed');
        });
      }),
    );
    return wrap;
  }

  if (serve && isRetryableServeStatus(serve.status) && model.servable) {
    const btn = textButton(retryLabelForServe(serve), () => startLoad(model, btn), 'primary');
    wrap.appendChild(btn);
    return wrap;
  }

  if (!model.servable && model.unavailableReason) wrap.append(el('span', 'models-muted', model.unavailableReason));
  if (model.servable && !model.incomplete) {
    const btn = textButton('Load', () => startLoad(model, btn), 'primary');
    wrap.appendChild(btn);
  }
  wrap.appendChild(
    iconButton('settings-sliders', 'Launch settings', () => {
      showModelInInspector(model.id, 'load');
    }),
  );
  return wrap;
}

function renderQuantCell(group: LibraryVariantGroup, active: LibraryModel): HTMLElement {
  const cell = el('span', 'models-row__cell models-row__cell--quant');
  if (group.variants.length <= 1) {
    cell.textContent = active.quant || active.format;
    return cell;
  }
  const select = el('select', 'models-select models-row__quant-select') as HTMLSelectElement;
  select.setAttribute('aria-label', `Quantization for ${group.displayName}`);
  for (const variant of group.variants) {
    const quantLabel = variant.quant || variant.format;
    const option = el(
      'option',
      undefined,
      `${quantLabel} · ${formatBytes(variant.sizeBytes)}`,
    ) as HTMLOptionElement;
    option.value = variant.id;
    if (variant.id === active.id) option.selected = true;
    select.appendChild(option);
  }
  select.addEventListener('mousedown', (event) => event.stopPropagation());
  select.addEventListener('click', (event) => event.stopPropagation());
  select.addEventListener('change', () => {
    variantPreferences.set(group.key, select.value);
    showModelInInspector(select.value);
    render();
  });
  cell.appendChild(select);
  return cell;
}

function renderGroupRow(
  group: LibraryVariantGroup,
  active: LibraryModel,
  selectedId: string | null,
): HTMLElement {
  const row = el('div', 'models-row');
  row.setAttribute('role', 'row');
  row.tabIndex = 0;
  row.dataset.modelId = active.id;
  row.dataset.groupKey = group.key;
  if (group.variants.some((v) => v.id === selectedId)) row.classList.add('is-selected');

  const serve = serveForModel(active);
  if (serve?.status === 'running') row.classList.add('is-loaded');

  const identity = el('div', 'models-row__identity');
  const nameLine = el('div', 'models-row__name-line');
  nameLine.appendChild(el('span', 'models-row__name', group.displayName));
  if (serve?.status === 'running') {
    const badge = el('span', 'models-row__loaded-badge', 'Loaded');
    badge.prepend(el('span', 'models-dot models-dot--running'));
    nameLine.appendChild(badge);
  } else if (serve && (serve.status === 'crashed' || serve.status === 'unhealthy' || serve.status === 'error')) {
    const badge = el('span', `models-row__loaded-badge is-${serve.status}`, serveStatusLabel(serve.status));
    badge.prepend(el('span', `models-dot models-dot--${serve.status}`));
    nameLine.appendChild(badge);
  }
  if (group.variants.some((v) => v.incomplete)) {
    nameLine.appendChild(el('span', 'models-row__warn', 'Incomplete download'));
  }
  identity.append(nameLine, el('span', 'models-row__repo', active.repoId));
  row.appendChild(identity);

  for (const [modifier, value] of COLUMNS) {
    if (modifier === 'maker') {
      row.appendChild(renderMakerCell(active));
    } else if (modifier === 'quant') {
      row.appendChild(renderQuantCell(group, active));
    } else {
      row.appendChild(el('span', `models-row__cell models-row__cell--${modifier}`, value(active)));
    }
  }
  row.appendChild(renderRowActions(active));

  const select = () => showModelInInspector(active.id);
  row.addEventListener('click', select);
  row.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      select();
    }
  });
  return row;
}

function renderSortHeader(
  label: string,
  sortKey: LibraryTableSortKey,
  cellModifier?: string,
): HTMLButtonElement {
  const btn = el('button', 'models-table__sort') as HTMLButtonElement;
  btn.type = 'button';
  btn.dataset.sortKey = sortKey;
  if (cellModifier) btn.classList.add(`models-row__cell--${cellModifier}`);
  const aria = libraryAriaSortValue(filters.listSort, sortKey);
  btn.setAttribute('aria-sort', aria);
  btn.classList.toggle('is-active', aria !== 'none');
  const dirLabel =
    aria === 'ascending' ? 'ascending' : aria === 'descending' ? 'descending' : 'unsorted';
  btn.setAttribute('aria-label', `Sort by ${label}, ${dirLabel}`);
  btn.append(label, el('span', 'models-table__sort-indicator'));
  btn.addEventListener('click', (event) => {
    event.stopPropagation();
    filters.listSort = cycleLibraryListSort(filters.listSort, sortKey);
    render();
  });
  return btn;
}

function renderTable(
  groups: LibraryVariantGroup[],
  selectedId: string | null,
  serves: ServeRecord[],
): HTMLElement {
  const table = el('div', 'models-table');
  table.setAttribute('role', 'table');

  const head = el('div', 'models-table__head');
  head.setAttribute('role', 'row');
  head.appendChild(renderSortHeader('Model', 'name'));
  for (const [modifier] of COLUMNS) {
    const sortKey = COLUMN_SORT_KEYS[modifier];
    if (sortKey) {
      head.appendChild(renderSortHeader(COLUMN_LABELS[modifier], sortKey, modifier));
    } else {
      head.appendChild(
        el('span', `models-table__th models-row__cell--${modifier}`, COLUMN_LABELS[modifier]),
      );
    }
  }
  head.appendChild(el('span', 'models-table__th'));
  table.appendChild(head);

  let lastGroup = '';
  for (const group of groups) {
    const active = resolveActiveVariant(
      group,
      selectedId,
      serves,
      variantPreferences.get(group.key),
    );
    if (filters.listSort.key === 'publisher') {
      if (active.publisher !== lastGroup) {
        lastGroup = active.publisher;
        table.appendChild(el('div', 'models-table__group', lastGroup));
      }
    } else if (filters.listSort.key === 'maker') {
      if (active.producerName !== lastGroup) {
        lastGroup = active.producerName;
        const groupHeader = el('div', 'models-table__group');
        const logo = producerLogoSpan(active.producerLogoId);
        if (logo) groupHeader.appendChild(logo);
        groupHeader.appendChild(document.createTextNode(active.producerName));
        table.appendChild(groupHeader);
      }
    }
    table.appendChild(renderGroupRow(group, active, selectedId));
  }
  return table;
}

/** Redraw My Models from store state. */
export function render(): void {
  const host = mount();
  if (!host) return;

  const state = getModelsState();

  if (state.scanning && !state.library.length) {
    host.replaceChildren(
      el('div', 'models-toolbar models-toolbar--placeholder'),
      skeletonRows(6),
    );
    return;
  }

  if (state.error && !state.library.length) {
    host.replaceChildren(
      emptyState({
        glyph: 'triangle-warning',
        title: 'Could not scan local models',
        body: state.error,
        action: { label: 'Try again', onClick: () => void refreshModels({ fresh: true }) },
      }),
    );
    return;
  }

  const installable = loadableLibrary(state.library, { backend: state.hardware?.backend });

  if (!installable.length) {
    const hiddenFormatsBody =
      state.hardware?.backend === 'metal'
        ? 'This list shows GGUF weights Minnow can serve with llama-server, plus MLX repos it can serve with mlx-lm. Plain SafeTensors, Ollama-managed models, and other formats are hidden.'
        : 'This list only shows GGUF weights Minnow can serve with llama-server. SafeTensors, MLX, Ollama-managed models, and other formats are hidden.';
    host.replaceChildren(
      emptyState({
        glyph: state.library.length ? 'triangle-warning' : 'folder-open',
        title: state.library.length ? 'No loadable models here' : 'No local models yet',
        body: state.library.length
          ? hiddenFormatsBody
          : 'Minnow scans the Hugging Face cache, ~/.minnow/models, and any folders you add under Storage.',
        action: {
          label: 'Browse models to download',
          onClick: () => {
            void import('../models-page').then((m) => m.openModels('recommend'));
          },
        },
      }),
    );
    return;
  }

  const shownGroups = prepareLibraryGroups(
    installable,
    {
      search: filters.search,
      format: filters.format,
      publisher: filters.publisher,
      producer: filters.producer,
      listSort: filters.listSort,
    },
    state.selectedId,
    state.serves,
    variantPreferences,
  );
  const fragment = document.createDocumentFragment();
  fragment.appendChild(renderToolbar(installable, shownGroups));

  if (!shownGroups.length) {
    fragment.appendChild(
      emptyState({
        glyph: 'search',
        title: 'No matches',
        body: 'No local model matches these filters.',
        action: {
          label: 'Clear filters',
          onClick: () => {
            filters.search = '';
            filters.format = '';
            filters.publisher = '';
            filters.producer = '';
            render();
          },
        },
      }),
    );
  } else {
    fragment.appendChild(renderTable(shownGroups, state.selectedId, state.serves));
  }

  const refocusSearch = isModelsSearchInputFocused();
  host.replaceChildren(fragment);

  const toolbar = host.querySelector<HTMLElement>('.models-toolbar');
  if (toolbar) host.style.setProperty('--models-toolbar-h', `${toolbar.offsetHeight}px`);

  if (refocusSearch) restoreModelsSearchInputFocus(host);
}

/** Mount My Models (idempotent). */
export function mountLibrarySection(): void {
  if (!bound) {
    bound = true;
    subscribeModelsStore(() => {
      if (document.getElementById('modelsSection-installed')?.classList.contains('is-active')) {
        render();
      }
    });
  }
  render();
  void refreshModels();
}

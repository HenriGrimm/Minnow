import {
  cycleLibraryListSort,
  capabilityLabel,
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
import { appConfirm } from '../app-dialog';
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
  deleteModel,
  isDeletingModel,
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
  status: 'all' | 'loaded' | 'attention';
}

const filters: LibraryFilters = {
  search: '',
  format: '',
  publisher: '',
  producer: '',
  listSort: { ...DEFAULT_LIBRARY_LIST_SORT },
  status: 'all',
};
/** Per-group quant picker choice (survives re-renders). */
const variantPreferences = new Map<string, string>();
const confirmingDeletes = new Set<string>();
let bound = false;
let renderedHost: HTMLElement | null = null;
let structureKey = '';

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

function openSection(section: 'recommend' | 'settings' | 'server'): void {
  void import('../models-page').then((m) => m.openModels(section));
}

function renderHeading(groups: LibraryVariantGroup[]): HTMLElement {
  const head = el('header', 'models-workspace-heading');
  const title = el('div', 'models-workspace-heading__main');
  title.append(
    el('p', 'models-workspace-heading__eyebrow', 'On this machine'),
    el('h2', 'models-workspace-heading__title', 'My models'),
    el('p', 'models-workspace-heading__description', 'Choose the model that powers your next build.'),
  );
  const actions = el('div', 'models-workspace-heading__actions');
  const storage = textButton('Model folders', () => openSection('settings'));
  storage.prepend(icon('folder-open'));
  const discover = textButton('Discover models', () => openSection('recommend'), 'primary');
  discover.prepend(icon('plus-small'));
  actions.append(storage, discover);
  head.append(title, actions);
  const summary = el('div', 'models-library-summary');
  summary.append(icon('disk'), el('span', undefined, totals(groups)));
  const loaded = getModelsState().serves.filter((s) => s.status === 'running').length;
  if (loaded) {
    const server = textButton(`${loaded} serving`, () => openSection('server'));
    server.prepend(el('span', 'models-dot models-dot--running'));
    summary.appendChild(server);
  }
  head.appendChild(summary);
  return head;
}

function modelHasStatus(model: LibraryModel, status: LibraryFilters['status']): boolean {
  if (status === 'all') return true;
  const serve = serveForModel(model);
  return status === 'loaded'
    ? serve?.status === 'running'
    : Boolean(loadForModel(model)?.error) || Boolean(serve && ['error', 'crashed', 'unhealthy'].includes(serve.status));
}

function renderStatusFilters(groups: LibraryVariantGroup[]): HTMLElement {
  const bar = el('div', 'models-library-tabs');
  bar.setAttribute('role', 'group');
  bar.setAttribute('aria-label', 'Model status');
  for (const [value, label] of [['all', 'All models'], ['loaded', 'Loaded'], ['attention', 'Needs attention']] as const) {
    const count = groups.filter((group) => group.variants.some((model) => modelHasStatus(model, value))).length;
    const button = textButton(label, () => {
      filters.status = value;
      render();
    });
    button.className = 'models-library-tabs__button';
    button.setAttribute('aria-pressed', String(filters.status === value));
    button.appendChild(el('span', 'models-library-tabs__count', String(count)));
    bar.appendChild(button);
  }
  return bar;
}

function renderToolbar(all: LibraryModel[], shownGroups: LibraryVariantGroup[]): HTMLElement {
  const bar = el('div', 'models-toolbar');

  const searchWrap = el('div', 'models-search');
  searchWrap.appendChild(icon('search', 'models-search__icon'));
  const search = el('input', 'models-search__input') as HTMLInputElement;
  search.type = 'search';
  search.placeholder = 'Search your models';
  search.value = filters.search;
  search.setAttribute('aria-label', 'Filter models');
  search.addEventListener('input', () => {
    filters.search = search.value;
    render();
  });
  searchWrap.appendChild(search);
  bar.appendChild(searchWrap);

  const filterControls = el('div', 'models-library-filters');
  filterControls.append(
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
  );
  bar.appendChild(filterControls);
  bar.appendChild(selectControl(
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
    ));

  bar.appendChild(el('span', 'models-toolbar__count', `${shownGroups.length} ${shownGroups.length === 1 ? 'model' : 'models'} shown`));
  const rescan = iconButton('refresh', 'Rescan local folders', () => {
    void refreshModels({ fresh: true });
  });
  rescan.disabled = getModelsState().scanning;
  bar.appendChild(rescan);
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

  if (isDeletingModel(model)) {
    const progress = el('span', 'models-row__loading', 'Deleting…');
    progress.setAttribute('role', 'status');
    wrap.appendChild(progress);
    return wrap;
  }

  const remove = iconButton('trash', `Delete ${model.name}`, () => {
    if (confirmingDeletes.has(model.id)) return;
    confirmingDeletes.add(model.id);
    remove.disabled = true;
    structureKey = '';
    void (async () => {
      try {
        const variant = model.quant ? `${model.name} (${model.quant})` : model.name;
        const scope = model.format === 'MLX'
          ? 'This permanently deletes the model folder and its contents. For a Hugging Face cache model, all cached revisions are deleted.'
          : 'This permanently deletes the selected weights from disk, including every shard of a split GGUF. Other quantizations are kept.';
        const confirmed = await appConfirm(`${variant}\n\n${model.path}\n\n${scope}`, {
          title: 'Delete model?', confirmLabel: 'Delete model', danger: true,
        });
        if (!confirmed) return;
        await deleteModel(model);
        setStatus('ok', 'Model deleted');
      } catch (err) {
        setStatus('err', err instanceof Error ? err.message : 'Delete failed');
      } finally {
        confirmingDeletes.delete(model.id);
        render();
      }
    })();
  });
  const busy = Boolean(load && !load.error) || Boolean(serve && ['running', 'starting', 'unhealthy'].includes(serve.status));
  remove.disabled = busy || confirmingDeletes.has(model.id);
  if (busy) remove.title = 'Eject this model before deleting it';
  if (model.path) wrap.appendChild(remove);
  wrap.appendChild(
    iconButton('settings-sliders', 'Launch settings', () => {
      showModelInInspector(model.id, 'load');
    }),
  );

  if (load && !load.error) {
    const progress = el('span', 'models-row__loading', load.phase);
    progress.dataset.modelId = model.id;
    wrap.appendChild(progress);
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
  const identityMain = el('div', 'models-row__identity-main');
  const mark = el('span', 'models-row__mark');
  mark.appendChild(producerLogoSpan(active.producerLogoId) ?? icon('cube'));
  identity.append(mark, identityMain);
  const nameLine = el('div', 'models-row__name-line');
  const name = el('span', 'models-row__name', group.displayName);
  name.title = group.displayName;
  nameLine.appendChild(name);
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
  const repo = el('span', 'models-row__repo', active.repoId);
  repo.title = active.repoId;
  const details = el('div', 'models-row__details');
  details.appendChild(renderMakerCell(active));
  details.appendChild(el('span', 'models-row__format', active.format));
  for (const capability of [...new Set(active.capabilities.map(capabilityLabel))].slice(0, 2)) {
    details.appendChild(el('span', 'models-row__capability', capability));
  }
  identityMain.append(nameLine, repo, details);
  row.appendChild(identity);

  row.appendChild(renderQuantCell(group, active));
  const specs = el('div', 'models-row__specs');
  specs.append(
    el('span', 'models-row__size', formatBytes(active.sizeBytes)),
    el('span', 'models-row__cell models-row__cell--params', `${formatParams(active.paramsB)} parameters`),
    el('span', 'models-row__cell models-row__cell--context', `${formatContext(active.contextLength)} context`),
  );
  row.appendChild(specs);
  row.appendChild(renderRowActions(active));
  for (const cell of row.children) cell.setAttribute('role', 'cell');

  const select = () => showModelInInspector(active.id);
  row.addEventListener('click', select);
  row.addEventListener('keydown', (event) => {
    if (event.target !== row) return;
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
  btn.dataset.sortDirection = aria;
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
  table.setAttribute('aria-label', 'Local model library');

  const head = el('div', 'models-table__head');
  head.setAttribute('role', 'row');
  head.appendChild(renderSortHeader('Model', 'name'));
  head.appendChild(renderSortHeader('Quantization', 'quant', 'quant'));
  head.appendChild(renderSortHeader('Size', 'size', 'size'));
  head.appendChild(el('span', 'models-table__th', 'Actions'));
  for (const control of Array.from(head.children)) {
    const cell = el('div', 'models-library-column');
    cell.setAttribute('role', 'columnheader');
    const direction = (control as HTMLElement).dataset.sortDirection;
    if (direction && direction !== 'none') cell.setAttribute('aria-sort', direction);
    control.replaceWith(cell);
    cell.appendChild(control);
  }
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

/** Keep hovered rows and focused controls mounted while loading progress changes. */
function patchLoadingLabels(host: HTMLElement): void {
  const models = new Map(getModelsState().library.map((model) => [model.id, model]));
  for (const label of host.querySelectorAll<HTMLElement>('.models-row__loading[data-model-id]')) {
    const model = models.get(label.dataset.modelId!);
    const load = model && loadForModel(model);
    if (load && label.textContent !== load.phase) label.textContent = load.phase;
  }
}

/** Redraw My Models from store state. */
export function render(): void {
  const host = mount();
  if (!host) return;

  const state = getModelsState();
  host.classList.add('models-library');
  const nextKey = JSON.stringify({
    library: state.library,
    serves: state.serves.map((serve) => ({
      id: serve.id,
      status: serve.status,
      modelPath: serve.modelPath,
      modelLabel: serve.modelLabel,
      suggestedSettings: Boolean(serve.failure?.suggestedSettings),
    })),
    loads: state.loads.map((load) => [load.serveId, load.modelId, load.error]),
    backend: state.hardware?.backend,
    selectedId: state.selectedId,
    scanning: state.scanning,
    error: state.error,
    filters,
    variants: [...variantPreferences],
    confirmingDeletes: [...confirmingDeletes],
    deletingModels: state.library.filter(isDeletingModel).map((model) => model.id),
  });
  if (renderedHost === host && host.childElementCount && structureKey === nextKey) {
    patchLoadingLabels(host);
    return;
  }
  renderedHost = host;
  structureKey = nextKey;

  const installable = loadableLibrary(state.library, { backend: state.hardware?.backend });
  const allGroups = prepareLibraryGroups(installable, {}, state.selectedId, state.serves, variantPreferences);
  const heading = renderHeading(allGroups);

  if (state.scanning && !state.library.length) {
    host.replaceChildren(
      heading,
      skeletonRows(6),
    );
    return;
  }

  if (state.error && !state.library.length) {
    host.replaceChildren(
      heading,
      emptyState({
        glyph: 'triangle-warning',
        title: 'Could not scan local models',
        body: state.error,
        action: { label: 'Try again', onClick: () => void refreshModels({ fresh: true }) },
      }),
    );
    return;
  }

  if (!installable.length) {
    const hiddenFormatsBody =
      state.hardware?.backend === 'metal'
        ? 'This list shows GGUF weights Minnow can serve with llama-server, plus MLX repos it can serve with mlx-lm. Plain SafeTensors, Ollama-managed models, and other formats are hidden.'
        : 'This list only shows GGUF weights Minnow can serve with llama-server. SafeTensors, MLX, Ollama-managed models, and other formats are hidden.';
    host.replaceChildren(
      heading,
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
    installable.filter((model) => modelHasStatus(model, filters.status)),
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
  fragment.append(heading, renderStatusFilters(allGroups), renderToolbar(installable, shownGroups));

  if (!shownGroups.length) {
    const statusOnly = !filters.search && !filters.format && !filters.publisher && !filters.producer;
    const loadedEmpty = statusOnly && filters.status === 'loaded';
    const attentionEmpty = statusOnly && filters.status === 'attention';
    fragment.appendChild(
      emptyState({
        glyph: 'search',
        title: loadedEmpty ? 'No models loaded' : attentionEmpty ? 'All clear' : 'No matches',
        body: loadedEmpty ? 'Choose a model from All models to start serving.'
          : attentionEmpty ? 'Your local models have no reported runtime errors.'
          : 'No local model matches these filters.',
        action: {
          label: loadedEmpty || attentionEmpty ? 'Show all models' : 'Clear filters',
          onClick: () => {
            filters.search = '';
            filters.format = '';
            filters.publisher = '';
            filters.producer = '';
            filters.status = 'all';
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

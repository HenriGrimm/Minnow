import recommended from '../../models/recommended.json';
import {
  searchHubModels,
  type HubSearchResult,
  type ModelDownloadFormat,
} from '../../models/api-client';
import { discoverFit } from '../../models/discover-fit';
import { el, formatBytes, formatCount, textButton } from './dom';
import { getModelsState, refreshHardware, refreshModels, subscribeModelsStore } from './store';
import { createDiscoverInspector, type DiscoverSelection } from './discover-inspector';
import { syncDownloadShelf } from './discover-downloads';
import { createModelIdentity, resolveModelCreator } from './creator-logo';

let bound = false;
let dispose: (() => void) | null = null;
let updateStore: (() => void) | null = null;
const preferences = {
  source: 'recommended',
  query: '',
  purpose: '',
  fitsOnly: false,
  context: 16384,
  format: 'gguf' as ModelDownloadFormat,
  sort: 'downloads' as 'downloads' | 'likes' | 'lastModified',
};

function selectControl(
  label: string,
  options: Array<[string, string]>,
  value: string,
  change: (value: string) => void,
): HTMLElement {
  const wrap = el('label', 'discover-control');
  const select = el('select', 'models-select') as HTMLSelectElement;
  for (const [key, text] of options) {
    const option = el('option', undefined, text) as HTMLOptionElement;
    option.value = key;
    select.append(option);
  }
  select.value = value;
  select.addEventListener('change', () => change(select.value));
  wrap.append(el('span', undefined, label), select);
  return wrap;
}

export function render(): void {
  const host = document.getElementById('modelsRecommendBody');
  if (!host) return;
  dispose?.();
  host.classList.add('discover-hub');
  host.replaceChildren();
  let alive = true;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let request: AbortController | null = null;
  let results: HubSearchResult[] = [];
  let nextCursor: string | null = null;
  let busy = false;
  let searchError = '';
  let searchReason = '';
  let selectedRepo = '';
  let searchSequence = 0;

  const top = el('header', 'discover-heading');
  top.append(
    el('h2', undefined, 'Find a model for your machine'),
    el('p', 'models-muted', 'Choose a model, check its memory needs, and download the right file.'),
  );
  const hardware = el('div', 'discover-hardware');
  const workbench = el('div', 'discover-workbench');
  const browser = el('section', 'discover-browser');
  browser.setAttribute('aria-label', 'Browse models');
  const aside = el('aside', 'discover-inspector');
  const inspector = createDiscoverInspector(
    aside,
    () => ({ hardware: getModelsState().hardware, context: preferences.context }),
    () => {
      const target = browser.querySelector<HTMLElement>('.is-selected button') ?? search;
      target.focus();
      target.scrollIntoView({ block: 'center' });
    },
  );
  const tabs = el('div', 'discover-sources');
  tabs.setAttribute('role', 'group');
  tabs.setAttribute('aria-label', 'Model source');
  const toolbar = el('div', 'discover-toolbar');
  const search = el('input', 'models-search__input discover-search') as HTMLInputElement;
  search.type = 'search';
  search.value = preferences.query;
  search.placeholder = 'Search models or paste owner/repository';
  search.setAttribute('aria-label', 'Search models or Hugging Face repository');
  const controls = el('div', 'discover-controls');
  const title = el('h3', 'discover-results-title');
  const status = el('p', 'discover-result-status');
  status.setAttribute('role', 'status');
  const list = el('div', 'discover-results');
  const pagination = el('div', 'discover-pagination');
  const contextControl = selectControl(
    'Context tokens',
    [
      ['4096', '4,096'],
      ['8192', '8,192'],
      ['16384', '16,384'],
      ['32768', '32,768'],
      ['65536', '65,536'],
      ['131072', '131,072'],
    ],
    String(preferences.context),
    (value) => {
      preferences.context = Number(value);
      paintResults();
      inspector.refresh();
    },
  );
  top.append(contextControl);
  toolbar.append(search, controls);
  browser.append(tabs, toolbar, title, status, list, pagination);
  workbench.append(browser, aside);
  host.append(top, hardware, workbench);

  function choose(model: DiscoverSelection): void {
    selectedRepo = model.repoId;
    paintResults();
    void inspector.select(model).then(() => {
      if (alive && selectedRepo === model.repoId && workbench.getBoundingClientRect().width < 850)
        aside.scrollIntoView({ behavior: 'instant', block: 'start' });
    });
    if (workbench.getBoundingClientRect().width < 850)
      aside.scrollIntoView({ behavior: 'instant', block: 'start' });
  }

  function paintHardware(): void {
    hardware.replaceChildren();
    const hw = getModelsState().hardware;
    if (!hw) {
      hardware.append(
        el(
          'span',
          'models-muted',
          'Hardware unavailable. Browse models now, or retry detection for fit estimates.',
        ),
        textButton('Detect hardware', () => void refreshHardware().catch(() => {})),
      );
      return;
    }
    hardware.append(
      el('strong', undefined, 'Your machine'),
      el(
        'span',
        undefined,
        hw.gpuName
          ? `${hw.gpuName} · ${hw.gpuVramGb ?? '?'} GiB ${hw.unifiedMemory ? 'unified memory' : 'VRAM'}`
          : 'CPU execution',
      ),
      el(
        'span',
        undefined,
        `${hw.availableRamGb.toFixed(1)} / ${hw.totalRamGb.toFixed(1)} GiB RAM free`,
      ),
    );
    if (hw.gpuError) hardware.append(el('span', 'discover-error', hw.gpuError));
    hardware.append(textButton('Refresh', () => void refreshHardware().catch(() => {})));
  }

  function paintControls(): void {
    tabs.replaceChildren();
    for (const [key, label] of [
      ['recommended', 'Recommended'],
      ['hub', 'Hugging Face'],
    ]) {
      const btn = textButton(label, () => {
        if (preferences.source === key) return;
        preferences.source = key;
        paintControls();
        paintResults();
        tabs.querySelector<HTMLButtonElement>('[aria-pressed="true"]')?.focus();
        if (key === 'hub') void searchHub(false);
        else {
          request?.abort();
          busy = false;
        }
      });
      btn.setAttribute('aria-pressed', String(preferences.source === key));
      tabs.append(btn);
    }
    controls.replaceChildren();
    if (preferences.source === 'recommended') {
      controls.append(
        selectControl(
          'Purpose',
          [
            ['', 'All purposes'],
            ['coding', 'Coding'],
            ['general', 'Everyday work'],
            ['reasoning', 'Reasoning'],
          ],
          preferences.purpose,
          (value) => {
            preferences.purpose = value;
            paintResults();
          },
        ),
      );
      const fitLabel = el('label', 'models-check');
      const checkbox = el('input') as HTMLInputElement;
      checkbox.type = 'checkbox';
      checkbox.checked = preferences.fitsOnly;
      checkbox.addEventListener('change', () => {
        preferences.fitsOnly = checkbox.checked;
        paintResults();
      });
      fitLabel.append(checkbox, el('span', undefined, 'Within memory budget'));
      controls.append(fitLabel);
    } else {
      const mlx = getModelsState().hardware?.backend === 'metal';
      if (!mlx) preferences.format = 'gguf';
      controls.append(
        selectControl(
          'Format',
          mlx
            ? [
                ['gguf', 'GGUF'],
                ['mlx', 'MLX'],
              ]
            : [['gguf', 'GGUF']],
          preferences.format,
          (value) => {
            preferences.format = value as ModelDownloadFormat;
            void searchHub(false);
          },
        ),
      );
      controls.append(
        selectControl(
          'Sort',
          [
            ['downloads', 'Most downloaded'],
            ['likes', 'Most liked'],
            ['lastModified', 'Recently updated'],
          ],
          preferences.sort,
          (value) => {
            preferences.sort = value as typeof preferences.sort;
            void searchHub(false);
          },
        ),
      );
    }
  }

  function recommendedRow(pick: (typeof recommended)[number]): HTMLElement {
    const fit = discoverFit({
      name: pick.name,
      sizeBytes: pick.sizeBytes,
      params: pick.parameters,
      arch: pick.architecture,
      context: preferences.context,
      maxContext: pick.context,
      hardware: getModelsState().hardware,
    });
    const row = el('article', `discover-pick${selectedRepo === pick.repo ? ' is-selected' : ''}`);
    const copy = el('div', 'discover-pick__copy');
    const creator = resolveModelCreator(pick.repo, pick.name);
    copy.append(
      el('span', 'discover-eyebrow', pick.title),
      createModelIdentity(pick.name.split('/').pop()!, creator),
      el('p', 'models-muted', pick.reason),
      el(
        'span',
        'discover-pick__facts',
        `${pick.parameters}B parameters · Q4_K_M · ${formatBytes(pick.sizeBytes)}`,
      ),
    );
    const action = el('div', 'discover-pick__action');
    const estimate = el('span', `discover-fit discover-fit--${fit.tone}`, fit.label);
    estimate.title = fit.detail;
    action.append(
      estimate,
      el(
        'span',
        'models-muted',
        fit.memoryGb
          ? `~${fit.memoryGb.toFixed(1)} GiB at ${formatCount(preferences.context)} context`
          : 'Check hardware and context',
      ),
      textButton('Inspect files', () =>
        choose({
          repoId: pick.repo,
          name: pick.name.split('/').pop()!,
          reason: pick.reason,
          params: pick.parameters,
          arch: pick.architecture,
          maxContext: pick.context,
          format: 'gguf',
        }),
      ),
    );
    row.append(copy, action);
    return row;
  }

  function hubRow(model: HubSearchResult): HTMLElement {
    const row = el(
      'article',
      `discover-hub-row${selectedRepo === model.repoId ? ' is-selected' : ''}`,
    );
    const creator = resolveModelCreator(model.repoId);
    const copy = createModelIdentity(model.repoId.split('/').pop()!, creator);
    const facts = el(
      'div',
      'discover-hub-row__facts',
      `${model.format.toUpperCase()} · ${formatCount(model.downloads)} downloads${model.gated ? ' · Access required' : ''}`,
    );
    row.append(
      copy,
      facts,
      textButton('Inspect', () =>
        choose({
          repoId: model.repoId,
          name: model.repoId.split('/').pop()!,
          params: model.paramsB,
          arch: model.arch,
          format: model.format,
          sizeBytes: model.sizeBytes,
        }),
      ),
    );
    return row;
  }

  function paintResults(): void {
    if (!alive) return;
    list.replaceChildren();
    pagination.replaceChildren();
    if (preferences.source === 'recommended') {
      title.textContent = 'Recommended for your machine';
      const query = preferences.query.toLowerCase().trim();
      const picks = recommended
        .filter(
          (pick) =>
            (!preferences.purpose || pick.purpose === preferences.purpose) &&
            `${pick.name} ${pick.repo} ${pick.title}`.toLowerCase().includes(query),
        )
        .map((pick) => ({
          pick,
          fit: discoverFit({
            name: pick.name,
            sizeBytes: pick.sizeBytes,
            params: pick.parameters,
            arch: pick.architecture,
            context: preferences.context,
            maxContext: pick.context,
            hardware: getModelsState().hardware,
          }),
        }))
        .filter(({ fit }) => !preferences.fitsOnly || fit.fits)
        .sort((a, b) => Number(b.fit.fits) - Number(a.fit.fits));
      status.textContent = `${picks.length} curated models · Memory estimates, not performance benchmarks · Reviewed ${recommended[0].reviewedAt}`;
      for (const { pick } of picks) list.append(recommendedRow(pick));
      if (!picks.length) {
        list.append(
          el(
            'p',
            'discover-empty',
            preferences.fitsOnly
              ? 'No curated model fits these settings. Try a shorter context or show all memory budgets.'
              : 'No curated pick matches. Search Hugging Face for more models.',
          ),
          textButton('Search Hugging Face', () => {
            preferences.source = 'hub';
            paintControls();
            void searchHub(false);
          }),
        );
      }
      return;
    }
    title.textContent = 'Explore Hugging Face';
    status.textContent = busy
      ? 'Searching Hugging Face…'
      : `${results.length} repositories · Inspect a file to check memory`;
    list.setAttribute('aria-busy', String(busy));
    for (const result of results) list.append(hubRow(result));
    if (searchError) {
      const message = el('p', 'discover-error', searchError);
      message.setAttribute('role', 'alert');
      pagination.append(
        message,
        textButton('Try again', () => void searchHub(Boolean(nextCursor))),
      );
    } else if (searchReason) list.append(el('p', 'discover-empty', searchReason));
    else if (!busy && !results.length)
      list.append(
        el(
          'p',
          'discover-empty',
          'No repositories matched. Try a shorter model name or owner/repository.',
        ),
      );
    if (nextCursor && !searchError) {
      const more = textButton(busy ? 'Loading…' : 'Load more models', () => void searchHub(true));
      more.disabled = busy;
      pagination.append(more);
    }
  }

  async function searchHub(append: boolean): Promise<void> {
    request?.abort();
    const controller = new AbortController();
    request = controller;
    const sequence = ++searchSequence;
    if (!append) {
      results = [];
      nextCursor = null;
    }
    busy = true;
    searchError = '';
    searchReason = '';
    paintResults();
    try {
      const response = await searchHubModels({
        query: preferences.query.trim(),
        format: preferences.format,
        sort: preferences.sort,
        signal: controller.signal,
        cursor: append ? (nextCursor ?? undefined) : undefined,
        limit: 24,
      });
      if (!alive || sequence !== searchSequence || controller.signal.aborted) return;
      const seen = new Set(results.map((row) => row.repoId));
      results.push(...response.results.filter((row) => !seen.has(row.repoId)));
      nextCursor = response.nextCursor ?? null;
      searchReason = response.reason ?? '';
    } catch (err) {
      if (controller.signal.aborted || !alive || sequence !== searchSequence) return;
      searchError =
        err instanceof Error
          ? err.message
          : 'Could not search Hugging Face. Check your connection and try again.';
    } finally {
      if (alive && sequence === searchSequence && !controller.signal.aborted) {
        busy = false;
        paintResults();
      }
    }
  }

  search.addEventListener('input', () => {
    preferences.query = search.value;
    if (timer) clearTimeout(timer);
    request?.abort();
    if (preferences.source === 'hub') timer = setTimeout(() => void searchHub(false), 350);
    else paintResults();
  });
  search.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && preferences.source === 'hub') {
      if (timer) clearTimeout(timer);
      void searchHub(false);
    }
  });
  let fingerprint = '';
  updateStore = () => {
    if (!alive) return;
    syncDownloadShelf(host!);
    const state = getModelsState();
    const next = JSON.stringify([
      state.hardware,
      state.library.map((row) => row.id),
      state.downloads.map((job) => [job.id, job.status]),
    ]);
    if (fingerprint === next) return;
    fingerprint = next;
    paintHardware();
    paintResults();
    inspector.refresh();
  };
  dispose = () => {
    alive = false;
    request?.abort();
    inspector.dispose();
    if (timer) clearTimeout(timer);
  };
  paintControls();
  updateStore();
  if (preferences.source === 'hub') void searchHub(false);
}

export function mountDiscoverSection(): void {
  if (!bound) {
    bound = true;
    subscribeModelsStore(() => {
      if (document.getElementById('modelsSection-recommend')?.classList.contains('is-active'))
        updateStore?.();
    });
  }
  render();
  void refreshModels();
}

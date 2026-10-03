import '../styles/settings-general.css';

import {
  DEFAULT_SEARCH_CONFIG,
  loadSearchConfig,
  saveSearchConfig,
  type SearchConfig,
  type SearchFallbackProvider,
  type SearchProvider,
} from '../config/search-config';
import { detectConfigServer } from '../config/storage-mode';
import {
  fetchManagedServers,
  getManagedSearxngActiveUrl,
} from '../servers/client';
import {
  appendSettingsCrosslinks,
  appendSettingsGroup,
  linkToSettingsSection,
} from './settings-layout';
import {
  appendSettingsOfflineHint,
  createSettingsInputRow,
  createSettingsSelectRow,
} from './settings-controls';
import { setStatus } from './status';
import { isLocalServerAvailable } from '../tools/config';
import { isDeveloperReleased } from '../os/app-registry';

// ── Helpers ──────────────────────────────────────────────────────────────────

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const PROVIDER_OPTIONS: { value: SearchProvider; label: string }[] = [
  { value: 'searxng', label: 'SearXNG (local instance)' },
  { value: 'tavily', label: 'Tavily API' },
  { value: 'brave', label: 'Brave Search API' },
  { value: 'duckduckgo', label: 'DuckDuckGo (on this device)' },
  { value: 'disabled', label: 'Disabled' },
];

const FALLBACK_OPTIONS: { value: SearchFallbackProvider; label: string }[] = [
  { value: 'tavily', label: 'Tavily' },
  { value: 'brave', label: 'Brave' },
  { value: 'duckduckgo', label: 'DuckDuckGo' },
];

// ── Searxng ──────────────────────────────────────────────────────────────────

/** Managed SearXNG row: canonical label column + status panel in the control column. */
function appendManagedSearxngRow(container: HTMLElement): {
  managedWrap: HTMLElement;
  endpoint: HTMLElement;
} {
  const managedWrap = el('div', 'settings-search-url-managed hidden');

  const row = el('div', 'settings-row');
  row.dataset.settingsSearchKey = 'integrations.search.searxngUrl';

  const label = el('div', 'settings-row__label');
  const titleRow = el('div', 'settings-search-url-managed__title');
  titleRow.append(
    el('span', 'settings-row__title', 'SearXNG base URL'),
    el('span', 'settings-mcp-badge settings-mcp-badge--builtin', 'Managed'),
  );
  label.appendChild(titleRow);

  const desc = el('span', 'settings-row__desc');
  desc.append(
    document.createTextNode('Search uses the loopback instance from '),
    linkToSettingsSection('Servers', 'servers'),
    document.createTextNode('. Saved URL in search.json applies when managed SearXNG stops.'),
  );
  label.appendChild(desc);

  const control = el('div', 'settings-row__control');
  const managedUrlPanel = el('div', 'settings-search-managed-url');
  managedUrlPanel.setAttribute('role', 'status');
  const managedStatus = el('span', 'settings-mcp-status settings-mcp-status--ok');
  managedStatus.append(
    el('span', 'settings-mcp-status-dot'),
    el('span', 'settings-mcp-status-text', 'Running'),
  );
  const endpoint = el('code', 'settings-search-managed-url__endpoint');
  managedUrlPanel.append(managedStatus, endpoint);
  control.appendChild(managedUrlPanel);

  row.append(label, control);
  managedWrap.appendChild(row);
  container.appendChild(managedWrap);

  return { managedWrap, endpoint };
}

// ── Render ───────────────────────────────────────────────────────────────────

/** Render Settings → Search into the section mount. */
export async function renderSearchSettingsSection(mount: HTMLElement): Promise<void> {
  mount.replaceChildren();

  const shell = el('div', 'settings-general');
  mount.appendChild(shell);

  const lead = el('p', 'settings-section-lead');
  lead.append(
    'Choose how agents search the web. A running SearXNG instance from ',
    linkToSettingsSection('Servers', 'servers'),
    ' is used automatically.',
  );
  shell.appendChild(lead);

  const serverUp = await detectConfigServer();
  if (!serverUp) {
    appendSettingsOfflineHint(
      shell,
      'Open Minnow to load and save search settings (<code>search.json</code>).',
    );
  }

  const content = el('div', 'settings-general__content');
  shell.appendChild(content);

  const providerGroup = appendSettingsGroup(
    content,
    'Provider',
    'Choose a local search service or connect a search API.',
    'integrations.search.provider',
    { emphasis: true },
  );

  const providerSelect = document.createElement('select');
  providerSelect.id = 'settingsSearchProvider';
  providerSelect.className = 'settings-select';
  providerSelect.disabled = !serverUp;
  for (const opt of PROVIDER_OPTIONS) {
    const option = document.createElement('option');
    option.value = opt.value;
    option.textContent = opt.label;
    providerSelect.appendChild(option);
  }
  providerGroup.appendChild(
    createSettingsSelectRow('Search provider', {
      select: providerSelect,
      searchKey: 'integrations.search.provider',
    }).row,
  );

  const searxngEditable = el('div', 'settings-search-url-editable');
  const searxngInput = document.createElement('input');
  searxngInput.type = 'url';
  searxngInput.id = 'settingsSearxngUrl';
  searxngInput.className = 'settings-input';
  searxngInput.placeholder = 'http://localhost:8080';
  searxngInput.autocomplete = 'off';
  searxngInput.disabled = !serverUp;
  searxngEditable.appendChild(
    createSettingsInputRow('SearXNG base URL', {
      input: searxngInput,
      searchKey: 'integrations.search.searxngUrl',
      description: 'Used when SearXNG is the primary provider and no managed instance is running.',
    }).row,
  );
  providerGroup.appendChild(searxngEditable);

  const { managedWrap: searxngManaged, endpoint: managedEndpoint } =
    appendManagedSearxngRow(providerGroup);

  const keysGroup = appendSettingsGroup(
    content,
    'API keys',
    'Add a key for each search API you use.',
    'integrations.search.apiKeys',
    { emphasis: true },
  );

  const braveInput = document.createElement('input');
  braveInput.type = 'password';
  braveInput.id = 'settingsSearchBraveApiKey';
  braveInput.className = 'settings-input';
  braveInput.autocomplete = 'off';
  braveInput.disabled = !serverUp;
  keysGroup.appendChild(
    createSettingsInputRow('Brave Search API key', {
      input: braveInput,
      searchKey: 'integrations.search.braveApiKey',
    }).row,
  );

  const tavilyInput = document.createElement('input');
  tavilyInput.type = 'password';
  tavilyInput.id = 'settingsSearchTavilyApiKey';
  tavilyInput.className = 'settings-input';
  tavilyInput.autocomplete = 'off';
  tavilyInput.disabled = !serverUp;
  keysGroup.appendChild(
    createSettingsInputRow('Tavily API key', {
      input: tavilyInput,
      searchKey: 'integrations.search.tavilyApiKey',
    }).row,
  );

  const chainGroup = appendSettingsGroup(
    content,
    'Research fallback chain',
    'If the primary search provider fails, Deep Research tries these providers in order. Check each provider to include it.',
    'integrations.search.fallback',
    { emphasis: true },
  );
  chainGroup.parentElement!.hidden = !isDeveloperReleased('research');
  const chainList = el('div', 'settings-checklist');
  chainList.setAttribute('role', 'group');
  chainList.setAttribute('aria-label', 'Research fallback providers');
  const chainCheckboxes = new Map<SearchFallbackProvider, HTMLInputElement>();
  for (const opt of FALLBACK_OPTIONS) {
    const row = el('label', 'settings-checklist__option');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = opt.value;
    cb.dataset.fallbackProvider = opt.value;
    cb.disabled = !serverUp;
    chainCheckboxes.set(opt.value, cb);
    row.append(cb, el('span', 'settings-checklist__label-text', opt.label));
    chainList.appendChild(row);
  }
  chainGroup.appendChild(chainList);

  const limitsGroup = appendSettingsGroup(
    content,
    'Results',
    'Maximum structured results per query (1–50).',
    'integrations.search.resultCount',
    { emphasis: true },
  );
  const countInput = document.createElement('input');
  countInput.type = 'number';
  countInput.id = 'settingsSearchResultCount';
  countInput.className = 'settings-input';
  countInput.min = '1';
  countInput.max = '50';
  countInput.disabled = !serverUp;
  limitsGroup.appendChild(
    createSettingsInputRow('Result count', {
      input: countInput,
      searchKey: 'integrations.search.resultCount',
    }).row,
  );

  let current: SearchConfig = { ...DEFAULT_SEARCH_CONFIG };
  /** search.json URL (unchanged when managed SearXNG overrides display). */
  let configuredSearxngUrl = DEFAULT_SEARCH_CONFIG.searxngUrl;
  try {
    current = await loadSearchConfig();
    configuredSearxngUrl = current.searxngUrl;
  } catch {
    setStatus('err', 'Could not load search settings. Open or restart Minnow.');
  }

  const applyToForm = (config: SearchConfig): void => {
    providerSelect.value = config.provider;
    configuredSearxngUrl = config.searxngUrl;
    searxngInput.value = config.searxngUrl;
    braveInput.value = config.keys.braveApiKey;
    tavilyInput.value = config.keys.tavilyApiKey;
    countInput.value = String(config.resultCount);
    const chainSet = new Set(config.fallbackChain);
    for (const [id, cb] of chainCheckboxes) {
      cb.checked = chainSet.has(id);
    }
  };
  applyToForm(current);

  const setSearxngManagedMode = (managedUrl: string | null): void => {
    const managed = Boolean(managedUrl);
    searxngEditable.classList.toggle('hidden', managed);
    searxngManaged.classList.toggle('hidden', !managed);
    if (managedUrl) {
      managedEndpoint.textContent = managedUrl;
    }
  };

  if (isLocalServerAvailable()) {
    const servers = await fetchManagedServers();
    const managedUrl = servers ? getManagedSearxngActiveUrl(servers) : null;
    setSearxngManagedMode(managedUrl);
  }

  const readForm = (): SearchConfig => {
    const fallbackChain: SearchFallbackProvider[] = [];
    for (const opt of FALLBACK_OPTIONS) {
      const cb = chainCheckboxes.get(opt.value);
      if (cb?.checked) fallbackChain.push(opt.value);
    }
    const provider = providerSelect.value as SearchProvider;
    return {
      provider: PROVIDER_OPTIONS.some((o) => o.value === provider)
        ? provider
        : DEFAULT_SEARCH_CONFIG.provider,
      fallbackChain:
        fallbackChain.length > 0 ? fallbackChain : [...DEFAULT_SEARCH_CONFIG.fallbackChain],
      searxngUrl:
        searxngManaged.classList.contains('hidden')
          ? searxngInput.value.trim() || DEFAULT_SEARCH_CONFIG.searxngUrl
          : configuredSearxngUrl,
      keys: {
        braveApiKey: braveInput.value.trim(),
        tavilyApiKey: tavilyInput.value.trim(),
      },
      resultCount: Number(countInput.value) || DEFAULT_SEARCH_CONFIG.resultCount,
    };
  };

  const persist = (): void => {
    void (async () => {
      try {
        const saved = await saveSearchConfig(readForm());
        applyToForm(saved);
        setStatus('ok', 'Search settings saved');
      } catch {
        setStatus('err', 'Could not save search settings. Open or restart Minnow.');
      }
    })();
  };
  for (const control of [
    providerSelect,
    searxngInput,
    braveInput,
    tavilyInput,
    countInput,
    ...chainCheckboxes.values(),
  ]) {
    control.addEventListener('change', persist);
  }

  appendSettingsCrosslinks(content, [
    { label: 'Managed servers (SearXNG)', sectionId: 'servers' },
    { label: 'Tool permissions', sectionId: 'tools' },
  ]);
}

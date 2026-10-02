import '../styles/settings-general.css';

import {

  DEFAULT_RESEARCH_CONFIG,

  loadResearchConfig,

  saveResearchConfig,

  type ResearchConfig,

} from '../config/research-config';

import type { SearchProvider } from '../config/search-config';

import { detectConfigServer } from '../config/storage-mode';

import {

  appendProviderModelFields,

  fillModelSelect,

  fillProviderSelect,

} from './settings-model-binding';

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

/** Append a labeled numeric field for research.json limits. */

function appendNumberField(

  container: HTMLElement,

  id: string,

  label: string,

  hint: string,

  options: { min: number; max: number; step?: number; searchKey?: string; disabled?: boolean },

): HTMLInputElement {

  const input = document.createElement('input');

  input.type = 'number';

  input.id = id;

  input.className = 'settings-input';

  input.min = String(options.min);

  input.max = String(options.max);

  if (options.step) input.step = String(options.step);

  if (options.disabled) input.disabled = true;

  container.appendChild(

    createSettingsInputRow(label, {

      id: `label-${id}`,

      input,

      description: hint,

      searchKey: options.searchKey,

    }).row,

  );

  return input;

}

const SEARCH_OVERRIDE_OPTIONS: { value: SearchProvider | ''; label: string }[] = [

  { value: '', label: '(use Search section primary)' },

  { value: 'searxng', label: 'SearXNG' },

  { value: 'tavily', label: 'Tavily' },

  { value: 'brave', label: 'Brave' },

  { value: 'duckduckgo', label: 'DuckDuckGo' },

  { value: 'disabled', label: 'Disabled' },

];

/** Render Settings → Deep Research into the section mount. */

export async function renderDeepResearchSettingsSection(mount: HTMLElement): Promise<void> {

  mount.replaceChildren();

  const shell = el('div', 'settings-general');

  mount.appendChild(shell);

  const lead = el('p', 'settings-section-lead');

  lead.append(

    'Model binding and loop limits for the Research app (',

    el('code', undefined, 'research.json'),

    '). Search providers and API keys live under ',

    linkToSettingsSection('Search', 'search'),

    '; Super Plan research defaults under ',

    linkToSettingsSection('Super Plan', 'modes'),

    '.',

  );

  shell.appendChild(lead);

  const serverUp = await detectConfigServer();

  if (!serverUp) {

    appendSettingsOfflineHint(

      shell,

      'Open Minnow to load and save research settings (<code>research.json</code>).',

      { searchKey: 'integrations.deepResearch' },

    );

  }

  const content = el('div', 'settings-general__content');

  shell.appendChild(content);

  const modelGroup = appendSettingsGroup(

    content,

    'Research model',

    'Provider and model for plan, query, extraction, synthesis, and final report LLM calls.',

    'integrations.deepResearch.model',

    { emphasis: true },

  );

  const { providerSelect, modelSelect } = appendProviderModelFields(

    modelGroup,

    { provider: 'settingsResearchProvider', model: 'settingsResearchModel' },

    { provider: 'Provider', model: 'Model' },

  );

  providerSelect.disabled = !serverUp;

  modelSelect.disabled = !serverUp;

  const searchOverrideGroup = appendSettingsGroup(

    content,

    'Search override',

    'Optional primary provider override for research runs only.',

    'integrations.deepResearch.searchOverride',

    { emphasis: true },

  );

  const overrideSelect = document.createElement('select');

  overrideSelect.id = 'settingsResearchSearchProvider';

  overrideSelect.className = 'settings-select';

  overrideSelect.disabled = !serverUp;

  for (const opt of SEARCH_OVERRIDE_OPTIONS) {

    const option = document.createElement('option');

    option.value = opt.value;

    option.textContent = opt.label;

    overrideSelect.appendChild(option);

  }

  searchOverrideGroup.appendChild(

    createSettingsSelectRow('Research search provider', {

      select: overrideSelect,

      searchKey: 'integrations.deepResearch.searchOverride',

      description: 'Leave on Search primary unless a run needs a different backend.',

    }).row,

  );

  const loopGroup = appendSettingsGroup(

    content,

    'Research loop',

    'Round caps and wall-clock limits for the iterative engine.',

    'integrations.deepResearch.loop',

    { emphasis: true },

  );

  const maxRounds = appendNumberField(

    loopGroup,

    'settingsResearchMaxRounds',

    'Max rounds',

    '0 = Auto (engine decides), hard cap 20.',

    { min: 0, max: 20, step: 1, searchKey: 'integrations.deepResearch.maxRounds', disabled: !serverUp },

  );

  const minRounds = appendNumberField(

    loopGroup,

    'settingsResearchMinRounds',

    'Min rounds before stop question',

    'Stop decision is only asked after this many rounds (default 3).',

    { min: 1, max: 20, step: 1, searchKey: 'integrations.deepResearch.minRounds', disabled: !serverUp },

  );

  const maxTime = appendNumberField(

    loopGroup,

    'settingsResearchMaxTimeSeconds',

    'Max time per loop (seconds)',

    'Wall clock for one research loop iteration.',

    { min: 30, max: 3600, step: 30, searchKey: 'integrations.deepResearch.maxTimeSeconds', disabled: !serverUp },

  );

  const runTimeout = appendNumberField(

    loopGroup,

    'settingsResearchRunTimeoutSeconds',

    'Run timeout (seconds)',

    'Hard wall clock for the full run; 0 = unlimited.',

    { min: 0, max: 86400, step: 60, searchKey: 'integrations.deepResearch.runTimeoutSeconds', disabled: !serverUp },

  );

  const maxEmpty = appendNumberField(

    loopGroup,

    'settingsResearchMaxEmptyRounds',

    'Max empty rounds',

    'Consecutive rounds with no new findings before giving up.',

    { min: 1, max: 10, step: 1, searchKey: 'integrations.deepResearch.maxEmptyRounds', disabled: !serverUp },

  );

  const extractGroup = appendSettingsGroup(

    content,

    'Extraction & synthesis',

    'Per-page fetch limits and concurrent extraction.',

    'integrations.deepResearch.extraction',

    { emphasis: true },

  );

  const extractTimeout = appendNumberField(

    extractGroup,

    'settingsResearchExtractionTimeout',

    'Extraction timeout (seconds)',

    'Timeout for a single page extraction LLM call.',

    { min: 10, max: 600, step: 5, searchKey: 'integrations.deepResearch.extractionTimeout', disabled: !serverUp },

  );

  const extractConcurrency = appendNumberField(

    extractGroup,

    'settingsResearchExtractionConcurrency',

    'Extraction concurrency',

    'Max parallel page extractions per round.',

    { min: 1, max: 20, step: 1, searchKey: 'integrations.deepResearch.extractionConcurrency', disabled: !serverUp },

  );

  const maxUrls = appendNumberField(

    extractGroup,

    'settingsResearchMaxUrlsPerRound',

    'Max URLs per round',

    'New URLs to fetch each research round.',

    { min: 1, max: 20, step: 1, searchKey: 'integrations.deepResearch.maxUrlsPerRound', disabled: !serverUp },

  );

  const maxContent = appendNumberField(

    extractGroup,

    'settingsResearchMaxContentChars',

    'Max content chars per page',

    'Truncation limit before extraction prompt.',

    { min: 1000, max: 100000, step: 500, searchKey: 'integrations.deepResearch.maxContentChars', disabled: !serverUp },

  );

  const synthesisWindow = appendNumberField(

    extractGroup,

    'settingsResearchSynthesisWindow',

    'Synthesis window',

    'Number of recent findings merged per synthesize step.',

    { min: 1, max: 50, step: 1, searchKey: 'integrations.deepResearch.synthesisWindow', disabled: !serverUp },

  );

  const reportGroup = appendSettingsGroup(

    content,

    'Final report',

    'Token budget for the final report generation call.',

    'integrations.deepResearch.report',

    { emphasis: true },

  );

  const maxReportTokens = appendNumberField(

    reportGroup,

    'settingsResearchMaxReportTokens',

    'Max report tokens',

    'Upper bound for final report completion tokens.',

    { min: 1024, max: 131072, step: 256, searchKey: 'integrations.deepResearch.maxReportTokens', disabled: !serverUp },

  );

  let current: ResearchConfig = { ...DEFAULT_RESEARCH_CONFIG };

  try {

    current = await loadResearchConfig();

  } catch {

    setStatus('err', 'Could not load research settings. Open or restart Minnow.');

  }

  await fillProviderSelect(providerSelect, current.model.providerId, {

    includeEmptyOption: true,

  });

  await fillModelSelect(modelSelect, current.model.providerId, current.model.model);

  providerSelect.addEventListener('change', () => {

    void fillModelSelect(modelSelect, providerSelect.value, modelSelect.value);

  });

  const applyToForm = (config: ResearchConfig): void => {

    providerSelect.value = config.model.providerId || '';

    modelSelect.value = config.model.model || '';

    overrideSelect.value = config.searchProvider || '';

    maxRounds.value = String(config.maxRounds);

    minRounds.value = String(config.minRounds);

    maxTime.value = String(config.maxTimeSeconds);

    runTimeout.value = String(config.runTimeoutSeconds);

    maxEmpty.value = String(config.maxEmptyRounds);

    extractTimeout.value = String(config.extractionTimeoutSeconds);

    extractConcurrency.value = String(config.extractionConcurrency);

    maxUrls.value = String(config.maxUrlsPerRound);

    maxContent.value = String(config.maxContentChars);

    synthesisWindow.value = String(config.synthesisWindow);

    maxReportTokens.value = String(config.maxReportTokens);

  };

  applyToForm(current);

  const readForm = (): ResearchConfig => ({

    model: {

      providerId: providerSelect.value.trim(),

      model: modelSelect.value.trim(),

    },

    searchProvider: (overrideSelect.value || '') as ResearchConfig['searchProvider'],

    maxRounds: Number(maxRounds.value),

    minRounds: Number(minRounds.value),

    maxTimeSeconds: Number(maxTime.value),

    runTimeoutSeconds: Number(runTimeout.value),

    maxEmptyRounds: Number(maxEmpty.value),

    extractionTimeoutSeconds: Number(extractTimeout.value),

    extractionConcurrency: Number(extractConcurrency.value),

    maxUrlsPerRound: Number(maxUrls.value),

    maxContentChars: Number(maxContent.value),

    synthesisWindow: Number(synthesisWindow.value),

    maxReportTokens: Number(maxReportTokens.value),

  });

  const persist = (): void => {

    void (async () => {

      try {

        const saved = await saveResearchConfig(readForm());

        applyToForm(saved);

        if (saved.model.providerId) {

          await fillModelSelect(

            modelSelect,

            saved.model.providerId,

            saved.model.model,

          );

        }

        setStatus('ok', 'Deep Research settings saved');

      } catch {

        setStatus('err', 'Could not save research settings. Open or restart Minnow.');

      }

    })();

  };

  for (const control of [

    providerSelect,

    modelSelect,

    overrideSelect,

    maxRounds,

    minRounds,

    maxTime,

    runTimeout,

    maxEmpty,

    extractTimeout,

    extractConcurrency,

    maxUrls,

    maxContent,

    synthesisWindow,

    maxReportTokens,

  ]) {

    control.addEventListener('change', persist);

  }

  appendSettingsCrosslinks(content, [

    { label: 'Search providers & keys', sectionId: 'search' },

    { label: 'Chat model bindings', sectionId: 'model-routing' },

    { label: 'Super Plan pipeline', sectionId: 'modes' },

  ]);

}


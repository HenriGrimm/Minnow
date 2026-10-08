import '../styles/settings-general.css';
import '../styles/settings-providers.css';

import { detectConfigServer, isServerStorageMode } from '../config/storage-mode';
import { fetchModels } from '../api/models';
import {
  findLoadedModelIdForProvider,
  findProbeModelIdForProvider,
} from '../providers/model-capabilities';
import { getDefaultPaths, pathsForProvider } from '../providers/paths';
import type { ApiKind, AuthStyle, ProviderPublic } from '../providers/types';
import { createProviderLogo } from '../providers/identity';
import {
  listSettingsFeaturedPresets,
  listSettingsLocalPresets,
  listSettingsMorePresets,
  type ProviderPreset,
} from '../providers/presets';
import {
  probeProviderCapabilities,
  readProviderCapabilities,
  structuredOutputBadge,
  type ProviderCapabilities,
} from '../providers/capability-probe';
import {
  createProvider,
  deleteProvider,
  isProvidersApiAvailable,
  invalidateProviderCache,
  listProviders,
  updateProvider,
  updateProviderSecrets,
} from '../providers/store';
import { normalizeModelPricingRates, normalizeProviderPricing } from '../usage/pricing';
import type { ProviderPricing } from '../usage/types';
import {
  appendSettingsOfflineHint,
  createSettingsActionsRow,
  createSettingsSelectRow,
} from './settings-controls';
import { createSettingsToggleRow } from './settings-switch';
import { setStatus } from './status';
import { appConfirm } from './app-dialog';
import { readDefaultModelBinding, resolveEffectiveChatModelBinding } from './default-model';
import {
  appendSettingsCrosslinks,
} from './settings-layout';

/** Prefer the top-bar #modelSelect model for this provider, then the active chat binding. */
function resolveProbePreferredModelId(providerId: string): string | undefined {
  const fromDefault = readDefaultModelBinding();
  if (fromDefault.providerId === providerId && fromDefault.modelId) {
    return fromDefault.modelId;
  }
  return undefined;
}

async function resolveProbePreferredModelIdAsync(
  providerId: string,
): Promise<string | undefined> {
  const fromTopBar = resolveProbePreferredModelId(providerId);
  if (fromTopBar) return fromTopBar;

  const { getActiveChat } = await import('../state/sessions');
  const chat = getActiveChat();
  const binding = resolveEffectiveChatModelBinding(chat);
  if (binding.providerId === providerId && binding.modelId) {
    return binding.modelId;
  }
  return undefined;
}

// ── Parse ────────────────────────────────────────────────────────────────────

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

function apiKindFromValue(value: string | undefined | null): ApiKind {
  if (value === 'openai-v1') return 'openai-v1';
  if (value === 'anthropic-v1') return 'anthropic-v1';
  return 'lm-studio-v0';
}

function parseApiKind(select: HTMLSelectElement | null): ApiKind {
  return apiKindFromValue(select?.value);
}

function chatPathLabel(apiKind: ApiKind): string {
  return apiKind === 'anthropic-v1' ? 'Messages path' : 'Chat completions path';
}

function pathFieldsHint(apiKind: ApiKind): string {
  return apiKind === 'anthropic-v1'
    ? 'Paths appended to the server address for model discovery and messages.'
    : 'Paths appended to the server address for model discovery and completions.';
}

function parseAuthStyle(select: HTMLSelectElement | null): AuthStyle {
  if (select?.value === 'api-key') return 'api-key';
  if (select?.value === 'x-api-key') return 'x-api-key';
  return 'bearer';
}

const NO_LOADED_MODEL_PROBE_MSG =
  'No model is loaded for this provider. Load a model in LM Studio (or your backend), then refresh models from the chat bar before probing structured output.';

// ── Paths ────────────────────────────────────────────────────────────────────

/** Show or hide the provider edit form error line (probe / save failures). */
function setProviderEditFormError(providerId: string, message: string | null): void {
  const errEl = document.querySelector(
    `[data-provider-edit-error="${providerId}"]`,
  );
  if (!(errEl instanceof HTMLElement)) return;
  if (!message) {
    errEl.textContent = '';
    errEl.classList.add('hidden');
    return;
  }
  errEl.textContent = message;
  errEl.classList.remove('hidden');
}

/** Read models/chat/messages paths and gateway flags from a provider form. */
function parsePathFields(
  form: ParentNode,
):
  | {
      modelsPath: string;
      chatCompletionsPath: string;
      messagesPath?: string;
      autoApi?: boolean;
      modelApiOverrides?: Record<string, ApiKind>;
    }
  | { error: string } {
  const apiKind = parseApiKind(form.querySelector<HTMLSelectElement>('select[name="apiKind"]'));
  const chatLabel = chatPathLabel(apiKind);
  const models =
    form.querySelector<HTMLInputElement>('input[name="modelsPath"]')?.value.trim() ?? '';
  const chat =
    form.querySelector<HTMLInputElement>('input[name="chatCompletionsPath"]')?.value.trim() ??
    '';
  if (!models || !chat) {
    return { error: `Models path and ${chatLabel.toLowerCase()} are required.` };
  }
  if (!models.startsWith('/') || !chat.startsWith('/')) {
    return { error: 'Paths must start with / (e.g. /v1/models).' };
  }

  const autoApi =
    apiKind === 'openai-v1' &&
    form.querySelector<HTMLInputElement>('input[name="autoApi"]')?.checked === true;
  const messagesRaw =
    form.querySelector<HTMLInputElement>('input[name="messagesPath"]')?.value.trim() ?? '';
  let messagesPath: string | undefined;
  if (apiKind === 'anthropic-v1' || autoApi) {
    messagesPath = messagesRaw || getDefaultPaths(apiKind).messagesPath || '/v1/messages';
    if (!messagesPath.startsWith('/')) {
      return { error: 'Messages path must start with /.' };
    }
  }

  const overridesRaw =
    form.querySelector<HTMLTextAreaElement>('textarea[name="modelApiOverridesJson"]')?.value.trim();
  let modelApiOverrides: Record<string, ApiKind> | null | undefined;
  if (overridesRaw !== undefined) {
    if (!overridesRaw) {
      modelApiOverrides = null;
    } else {
      try {
        const parsed = JSON.parse(overridesRaw) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return { error: 'Per-model API overrides must be a JSON object.' };
        }
        modelApiOverrides = {};
        for (const [modelId, api] of Object.entries(parsed)) {
          if (typeof modelId !== 'string' || !modelId.trim()) continue;
          const kind = apiKindFromValue(String(api));
          modelApiOverrides[modelId.trim()] = kind;
        }
      } catch {
        return { error: 'Per-model API overrides JSON is invalid.' };
      }
    }
  }

  return {
    modelsPath: models,
    chatCompletionsPath: chat,
    ...(messagesPath ? { messagesPath } : {}),
    ...(autoApi ? { autoApi: true } : {}),
    ...(modelApiOverrides === undefined || modelApiOverrides === null
      ? {}
      : Object.keys(modelApiOverrides).length > 0
        ? { modelApiOverrides }
        : {}),
  };
}

/** Sync path field labels and hint text when API style changes. */
function updatePathFieldLabels(form: ParentNode, apiKind: ApiKind): void {
  const chatLabel = chatPathLabel(apiKind);
  const chatLabelEl = form.querySelector<HTMLElement>('[data-provider-chat-path-label]');
  if (chatLabelEl) chatLabelEl.textContent = chatLabel;

  const hintEl = form.querySelector<HTMLElement>('[data-provider-paths-hint]');
  if (hintEl) hintEl.textContent = pathFieldsHint(apiKind);
}

/** Default auth header when API style changes (Anthropic uses X-Api-Key). */
function applyAuthStyleDefaultForApiKind(form: ParentNode, apiKind: ApiKind): void {
  if (apiKind !== 'anthropic-v1') return;
  const authSel = form.querySelector<HTMLSelectElement>('select[name="authStyle"]');
  if (authSel) authSel.value = 'x-api-key';
}

/** Set models/chat/messages path inputs from apiKind defaults. */
function fillPathInputs(form: ParentNode, apiKind: ApiKind): void {
  const defaults = getDefaultPaths(apiKind);
  const modelsInput = form.querySelector<HTMLInputElement>('input[name="modelsPath"]');
  const chatInput = form.querySelector<HTMLInputElement>('input[name="chatCompletionsPath"]');
  const messagesInput = form.querySelector<HTMLInputElement>('input[name="messagesPath"]');
  if (modelsInput) modelsInput.value = defaults.modelsPath;
  if (chatInput) chatInput.value = defaults.chatCompletionsPath;
  if (messagesInput && defaults.messagesPath) messagesInput.value = defaults.messagesPath;
}

/** Show gateway-only fields when openai-v1 auto-routing is relevant. */
function syncGatewayFieldVisibility(form: ParentNode): void {
  const apiKind = parseApiKind(form.querySelector<HTMLSelectElement>('select[name="apiKind"]'));
  const autoApi = form.querySelector<HTMLInputElement>('input[name="autoApi"]')?.checked === true;
  const gatewayBlock = form.querySelector<HTMLElement>('[data-provider-gateway-fields]');
  const messagesField = form.querySelector<HTMLElement>('[data-provider-messages-path-field]');
  const showGateway = apiKind === 'openai-v1';
  const showMessages = apiKind === 'anthropic-v1' || (showGateway && autoApi);
  if (gatewayBlock) gatewayBlock.classList.toggle('hidden', !showGateway);
  if (messagesField) messagesField.classList.toggle('hidden', !showMessages);
}

/** Apply a one-click provider preset to the add-provider form. */
function applyProviderPreset(form: ParentNode, preset: ProviderPreset): void {
  const apiKind = preset.apiKind ?? 'openai-v1';
  const paths = getDefaultPaths(apiKind);
  const idInput = form.querySelector<HTMLInputElement>('input[name="id"]');
  const labelInput = form.querySelector<HTMLInputElement>('input[name="label"]');
  const baseUrlInput = form.querySelector<HTMLInputElement>('input[name="baseUrl"]');
  const apiKindSel = form.querySelector<HTMLSelectElement>('select[name="apiKind"]');
  const authSel = form.querySelector<HTMLSelectElement>('select[name="authStyle"]');
  const autoApiInput = form.querySelector<HTMLInputElement>('input[name="autoApi"]');
  if (idInput) idInput.value = preset.id;
  if (labelInput) labelInput.value = preset.label;
  if (baseUrlInput) baseUrlInput.value = preset.baseUrl;
  if (apiKindSel) apiKindSel.value = apiKind;
  if (apiKindSel) apiKindSel.dataset.prevApiKind = apiKind;
  if (authSel) authSel.value = preset.authStyle ?? 'bearer';
  if (autoApiInput) autoApiInput.checked = preset.autoApi === true;
  const modelsInput = form.querySelector<HTMLInputElement>('input[name="modelsPath"]');
  const chatInput = form.querySelector<HTMLInputElement>('input[name="chatCompletionsPath"]');
  const messagesInput = form.querySelector<HTMLInputElement>('input[name="messagesPath"]');
  if (modelsInput) modelsInput.value = paths.modelsPath;
  if (chatInput) chatInput.value = paths.chatCompletionsPath;
  if (messagesInput && paths.messagesPath) messagesInput.value = paths.messagesPath;
  applyAuthStyleDefaultForApiKind(form, apiKind);
  syncGatewayFieldVisibility(form);
  updatePathFieldLabels(form, apiKind);

  const hintEl = form.querySelector<HTMLElement>('[data-provider-preset-auth-hint]');
  if (hintEl) {
    if (preset.authHint) {
      hintEl.textContent = preset.authHint;
      hintEl.classList.remove('hidden');
    } else {
      hintEl.textContent = '';
      hintEl.classList.add('hidden');
    }
  }
}

// ── Add flow ─────────────────────────────────────────────────────────────────

/** Show preset picker and hide the add form. */
function showProvidersAddPicker(): void {
  const picker = document.getElementById('settingsProvidersAddPicker');
  const form = document.getElementById('settingsProvidersAddForm');
  picker?.classList.remove('hidden');
  form?.classList.add('hidden');
}

function suggestProviderId(label: string): string {
  const stem = label.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'provider';
  const existingIds = new Set(Array.from(
    document.querySelectorAll<HTMLElement>('.settings-providers-row[data-provider-id]'),
    (row) => row.dataset.providerId,
  ));
  let id = stem;
  for (let suffix = 2; existingIds.has(id); suffix++) id = `${stem}-${suffix}`;
  return id;
}

/** Open the add form for a preset or a blank custom provider. */
function showProvidersAddForm(form: ParentNode, mode: ProviderPreset | 'custom'): void {
  const picker = document.getElementById('settingsProvidersAddPicker');
  const addForm = document.getElementById('settingsProvidersAddForm');
  const modeLabel = document.getElementById('settingsProvidersAddModeLabel');
  picker?.classList.add('hidden');
  addForm?.classList.remove('hidden');

  clearProvidersAddForm();
  if (mode === 'custom') {
    if (modeLabel) modeLabel.textContent = 'Custom provider';
    const hintEl = form.querySelector<HTMLElement>('[data-provider-preset-auth-hint]');
    if (hintEl) {
      hintEl.textContent = '';
      hintEl.classList.add('hidden');
    }
  } else {
    applyProviderPreset(form, mode);
    if (modeLabel) modeLabel.textContent = mode.label;
    const idInput = form.querySelector<HTMLInputElement>('input[name="id"]');
    if (idInput) idInput.value = suggestProviderId(mode.id);
  }

  const advanced = form.querySelector<HTMLDetailsElement>('.settings-providers-advanced');
  if (advanced) advanced.open = false;
  const focusName = mode === 'custom' ? 'label' : mode.apiKind === 'lm-studio-v0' || mode.id === 'ollama' ? 'baseUrl' : 'apiKey';
  form.querySelector<HTMLInputElement>(`input[name="${focusName}"]`)?.focus();
}

/** Append a titled preset button grid to the add-provider picker. */
function appendPresetSection(
  parent: HTMLElement,
  title: string,
  presets: ProviderPreset[],
  form: ParentNode,
): void {
  if (presets.length === 0) return;
  const section = el('div', 'settings-providers-preset-section');
  section.append(el('h3', 'settings-providers-preset-section-title', title));
  const grid = el('div', 'settings-providers-preset-grid');
  for (const preset of presets) {
    const btn = el('button', 'settings-providers-preset-btn');
    btn.type = 'button';
    btn.append(createProviderLogo({ ...preset, apiKind: preset.apiKind ?? 'openai-v1' }), el('span', undefined, preset.label));
    if (preset.authHint) btn.title = preset.authHint;
    btn.addEventListener('click', () => showProvidersAddForm(form, preset));
    grid.append(btn);
  }
  section.append(grid);
  parent.append(section);
}

/** Build preset grid and custom entry for the first step of add-provider. */
function renderProvidersAddPicker(form: ParentNode): void {
  const picker = document.getElementById('settingsProvidersAddPicker');
  if (!picker || picker.dataset.rendered === '1') return;
  picker.dataset.rendered = '1';

  appendPresetSection(picker, 'Local servers', listSettingsLocalPresets(), form);
  appendPresetSection(picker, 'Cloud APIs', [...listSettingsFeaturedPresets(), ...listSettingsMorePresets()], form);

  const customBtn = el('button', 'settings-providers-add-custom');
  customBtn.type = 'button';
  customBtn.append(createProviderLogo({ id: 'custom', label: '+', baseUrl: '', apiKind: 'openai-v1' }));
  customBtn.append(el('span', 'settings-providers-add-custom-label', 'Custom endpoint'));
  customBtn.append(
    el(
      'span',
      'settings-providers-add-custom-desc',
      'Connect another API or local server',
    ),
  );
  customBtn.addEventListener('click', () => showProvidersAddForm(form, 'custom'));
  picker.append(customBtn);
}

/** Reset add-provider UI to the preset picker after save or panel close. */
function resetProvidersAddFlow(): void {
  clearProvidersAddForm();
  showProvidersAddPicker();
}

/** Build the add-provider form (picker is rendered separately on first bind). */
function buildProvidersAddForm(): HTMLFormElement {
  const form = document.createElement('form');
  form.id = 'settingsProvidersAddForm';
  form.className = 'settings-providers-form hidden';
  form.noValidate = true;
  form.dataset.settingsSearchKey = 'models.providers.add';

  const head = el('div', 'settings-providers-add-form-head');
  const backBtn = el('button', 'settings-inline-btn settings-providers-add-back', 'Back to presets');
  backBtn.type = 'button';
  backBtn.id = 'settingsProvidersAddBack';
  const modeLabel = el('p', 'settings-providers-add-mode-label field-hint');
  modeLabel.id = 'settingsProvidersAddModeLabel';
  modeLabel.setAttribute('aria-live', 'polite');
  const authHint = el('p', 'field-hint hidden');
  authHint.id = 'settingsProvidersAddPresetAuthHint';
  authHint.dataset.providerPresetAuthHint = '';
  head.append(backBtn, modeLabel, authHint);
  form.append(head);

  const idRow = el('div', 'field-row');
  const idField = el('div', 'field');
  idField.append(el('label', undefined, 'Provider id'));
  const idInput = document.createElement('input');
  idInput.type = 'text';
  idInput.id = 'settingsProvidersAddId';
  idInput.name = 'id';
  idInput.required = true;
  idInput.pattern = '[a-z0-9][a-z0-9_-]*';
  idInput.autocomplete = 'off';
  idInput.spellcheck = false;
  idInput.placeholder = 'ollama-local';
  idInput.className = 'settings-input';
  idField.append(idInput, el('p', 'field-hint', 'Lowercase letters, numbers, hyphens, underscores.'));
  idField.dataset.providerAdvancedField = '';
  idRow.append(idField);

  const labelField = el('div', 'field');
  labelField.append(el('label', undefined, 'Display name'));
  const labelInput = document.createElement('input');
  labelInput.type = 'text';
  labelInput.id = 'settingsProvidersAddLabel';
  labelInput.name = 'label';
  labelInput.required = true;
  labelInput.autocomplete = 'off';
  labelInput.placeholder = 'Ollama (local)';
  labelInput.className = 'settings-input';
  labelField.append(labelInput);
  idRow.append(labelField);
  form.append(idRow);

  const urlField = el('div', 'field');
  urlField.append(el('label', undefined, 'Base URL'));
  const baseUrlInput = document.createElement('input');
  baseUrlInput.type = 'url';
  baseUrlInput.id = 'settingsProvidersAddBaseUrl';
  baseUrlInput.name = 'baseUrl';
  baseUrlInput.required = true;
  baseUrlInput.autocomplete = 'off';
  baseUrlInput.spellcheck = false;
  baseUrlInput.placeholder = 'http://localhost:11434';
  baseUrlInput.className = 'settings-input';
  urlField.append(
    baseUrlInput,
    el(
      'p',
      'field-hint',
      'Server address, including any gateway prefix.',
    ),
  );
  form.append(urlField);

  const kindSel = appendApiFields(form, 'lm-studio-v0', 'bearer');
  kindSel.id = 'settingsProvidersAddApiKind';
  const authSel = form.querySelector<HTMLSelectElement>('select[name="authStyle"]');
  if (authSel) authSel.id = 'settingsProvidersAddAuthStyle';

  const defaultPaths = getDefaultPaths('lm-studio-v0');
  appendPathFields(form, defaultPaths.modelsPath, defaultPaths.chatCompletionsPath, 'lm-studio-v0');
  const modelsInput = form.querySelector<HTMLInputElement>('input[name="modelsPath"]');
  const chatInput = form.querySelector<HTMLInputElement>('input[name="chatCompletionsPath"]');
  if (modelsInput) modelsInput.id = 'settingsProvidersAddModelsPath';
  if (chatInput) chatInput.id = 'settingsProvidersAddChatPath';

  const keyField = el('div', 'field');
  keyField.append(el('label', undefined, 'API key (optional)'));
  const apiKeyInput = document.createElement('input');
  apiKeyInput.type = 'password';
  apiKeyInput.id = 'settingsProvidersAddApiKey';
  apiKeyInput.name = 'apiKey';
  apiKeyInput.autocomplete = 'off';
  apiKeyInput.spellcheck = false;
  apiKeyInput.placeholder = 'Leave empty if the server needs no key';
  apiKeyInput.className = 'settings-input';
  keyField.append(
    apiKeyInput,
    el(
      'p',
      'field-hint',
      'Stored encrypted on this machine.',
    ),
  );
  form.append(keyField);

  appendGatewayFields(form);

  const enabledLabel = el('label', 'settings-toggle-row');
  const enabledInput = document.createElement('input');
  enabledInput.type = 'checkbox';
  enabledInput.id = 'settingsProvidersAddEnabled';
  enabledInput.name = 'enabled';
  enabledInput.checked = true;
  enabledLabel.append(enabledInput, el('span', undefined, 'Enabled after adding'));
  form.append(enabledLabel);

  const err = el('p', 'settings-providers-form-error hidden');
  err.id = 'settingsProvidersAddError';
  err.setAttribute('role', 'alert');
  form.append(err);

  form.append(
    createSettingsActionsRow(
      [
        { label: 'Add provider', type: 'submit', variant: 'primary' },
        { label: 'Cancel', type: 'button', id: 'settingsProvidersAddReset' },
      ],
      { className: 'settings-providers-form-actions' },
    ),
  );

  organizeProviderForm(form, true);
  return form;
}

let providersShellReady = false;
let providersListEl: HTMLElement | null = null;
let providersOfflineEl: HTMLElement | null = null;
let providersAddGroupEl: HTMLElement | null = null;
let providersAddFormBound = false;
let providersListActionsBound = false;
let providersRenderRevision = 0;

// ── Fields ───────────────────────────────────────────────────────────────────

/** Build the settings-general shell once (matches Usage / Thinking layout). */
function ensureProvidersShell(): HTMLElement {
  const mount = document.getElementById('settingsProvidersBody');
  if (!mount) {
    throw new Error('settingsProvidersBody mount missing');
  }
  if (providersShellReady && providersListEl && mount.contains(providersListEl)) {
    return providersListEl;
  }

  mount.replaceChildren();
  providersAddFormBound = false;
  providersListActionsBound = false;

  const shell = el('div', 'settings-general settings-providers');
  mount.appendChild(shell);

  const toolbar = el('div', 'settings-providers-toolbar');
  toolbar.append(el('p', 'settings-section-lead', 'Connect the models you work with.'));
  const addButton = el('button', 'settings-action-btn', 'Add provider');
  addButton.type = 'button';
  addButton.id = 'settingsProvidersAddButton';
  addButton.setAttribute('aria-expanded', 'false');
  addButton.setAttribute('aria-controls', 'settingsProvidersAddPanel');
  toolbar.append(addButton);
  shell.append(toolbar);

  providersOfflineEl = appendSettingsOfflineHint(
    shell, 'Cannot reach Minnow’s tool server. Retry when it is running.',
    { id: 'settingsProvidersOffline', searchKey: 'models.providers', hidden: true },
  );

  const addPanel = el('section', 'settings-providers-add-panel hidden');
  addPanel.id = 'settingsProvidersAddPanel';
  addPanel.dataset.settingsSearchKey = 'models.providers.add';
  const addHead = el('div', 'settings-providers-add-panel-head');
  addHead.append(el('h2', undefined, 'Add provider'));
  const close = el('button', 'settings-inline-btn', 'Close');
  close.type = 'button';
  close.addEventListener('click', () => closeProvidersAddPanel());
  addHead.append(close);
  const picker = el('div', 'settings-providers-add-picker');
  picker.id = 'settingsProvidersAddPicker';
  picker.setAttribute('role', 'group');
  picker.setAttribute('aria-label', 'Provider presets');
  addPanel.append(addHead, picker, buildProvidersAddForm());
  providersAddGroupEl = addPanel;
  shell.append(addPanel);
  addButton.addEventListener('click', () => {
    if (!isServerStorageMode() || !isProvidersApiAvailable()) {
      addButton.disabled = true;
      addButton.textContent = 'Connecting…';
      void (async () => {
        try {
          await detectConfigServer();
          invalidateProviderCache();
          await renderProvidersSettingsSection();
        } finally {
          addButton.disabled = false;
        }
      })();
      return;
    }
    const opening = addPanel.classList.contains('hidden');
    if (!opening) { closeProvidersAddPanel(); return; }
    addPanel.classList.remove('hidden');
    addButton.setAttribute('aria-expanded', 'true');
    picker.querySelector<HTMLButtonElement>('button')?.focus();
  });

  const list = el('div', 'settings-providers-list');
  list.id = 'settingsProvidersList';
  list.dataset.settingsSearchKey = 'models.providers';
  list.setAttribute('role', 'list');
  list.setAttribute('aria-label', 'Configured providers');
  shell.append(list);
  providersListEl = list;

  appendSettingsCrosslinks(shell, [
    { label: 'Model routing', sectionId: 'model-routing' },
    { label: 'Usage', sectionId: 'usage' },
  ]);

  providersShellReady = true;
  return list;
}
function appendGatewayFields(parent: HTMLElement, provider?: ProviderPublic): void {
  const block = el('div', 'settings-providers-gateway-fields');
  block.dataset.providerGatewayFields = '';

  const autoRow = el('label', 'settings-toggle-row');
  const autoInput = document.createElement('input');
  autoInput.type = 'checkbox';
  autoInput.name = 'autoApi';
  autoInput.checked = provider?.autoApi === true;
  autoRow.append(autoInput);
  autoRow.append(el('span', undefined, 'Auto-detect API per model (gateway)'));
  block.append(autoRow);

  const messagesField = el('div', 'field');
  messagesField.dataset.providerMessagesPathField = '';
  messagesField.append(el('label', undefined, 'Messages path'));
  const messagesInput = document.createElement('input');
  messagesInput.type = 'text';
  messagesInput.className = 'settings-input';
  messagesInput.name = 'messagesPath';
  messagesInput.autocomplete = 'off';
  messagesInput.spellcheck = false;
  messagesInput.value =
    provider?.messagesPath ||
    getDefaultPaths(provider?.apiKind ?? 'openai-v1').messagesPath ||
    '/v1/messages';
  messagesField.append(messagesInput);
  block.append(messagesField);

  const hasOverrides =
    provider?.modelApiOverrides != null &&
    Object.keys(provider.modelApiOverrides).length > 0;
  const overridesPanel = document.createElement('details');
  overridesPanel.className = 'settings-providers-gateway-overrides-panel';
  overridesPanel.open = hasOverrides;
  const overridesSummary = document.createElement('summary');
  overridesSummary.textContent = 'Per-model API overrides (JSON)';
  overridesPanel.append(overridesSummary);

  const overridesField = el('div', 'field');
  const overridesArea = document.createElement('textarea');
  overridesArea.className = 'settings-input settings-providers-pricing-json';
  overridesArea.name = 'modelApiOverridesJson';
  overridesArea.rows = 4;
  overridesArea.spellcheck = false;
  overridesArea.placeholder =
    '{"claude-sonnet-4-5":"anthropic-v1","gpt-4o-mini":"openai-v1"}';
  if (hasOverrides && provider?.modelApiOverrides) {
    overridesArea.value = JSON.stringify(provider.modelApiOverrides, null, 2);
  }
  overridesField.append(overridesArea);
  overridesPanel.append(overridesField);
  block.append(overridesPanel);

  const hint = el(
    'p',
    'field-hint',
    'Use for OpenCode Zen and OpenRouter: GPT/Gemini use chat completions; Claude routes to the messages path automatically.',
  );
  block.append(hint);

  parent.append(block);
  autoInput.addEventListener('change', () => syncGatewayFieldVisibility(parent));
  syncGatewayFieldVisibility(parent);
}

/** When API style changes, refresh paths if they still match the previous kind's defaults. */
function wirePathSyncOnApiKindChange(form: HTMLElement, kindSel: HTMLSelectElement): void {
  kindSel.dataset.prevApiKind = kindSel.value;
  updatePathFieldLabels(form, parseApiKind(kindSel));
  kindSel.addEventListener('change', () => {
    const prevKind = apiKindFromValue(kindSel.dataset.prevApiKind);
    const nextKind = parseApiKind(kindSel);
    const modelsInput = form.querySelector<HTMLInputElement>('input[name="modelsPath"]');
    const chatInput = form.querySelector<HTMLInputElement>('input[name="chatCompletionsPath"]');
    if (!modelsInput || !chatInput) return;

    const prevDefaults = getDefaultPaths(prevKind);
    const models = modelsInput.value.trim();
    const chat = chatInput.value.trim();
    const matchesPrevDefaults =
      models === prevDefaults.modelsPath && chat === prevDefaults.chatCompletionsPath;

    if (!models || !chat || matchesPrevDefaults) {
      fillPathInputs(form, nextKind);
    }
    applyAuthStyleDefaultForApiKind(form, nextKind);
    updatePathFieldLabels(form, nextKind);
    syncGatewayFieldVisibility(form);
    kindSel.dataset.prevApiKind = kindSel.value;
  });
}

/** Optional per-model API pricing fields on provider edit form. */
function appendPricingFields(form: HTMLElement, pricing?: ProviderPricing): void {
  const details = document.createElement('details');
  details.className = 'settings-providers-pricing-panel';
  const summary = document.createElement('summary');
  summary.textContent = 'Model pricing (optional)';
  details.append(summary);

  const hint = el(
    'p',
    'field-hint',
    'USD per 1M tokens. Used for Usage & cost estimates; local providers can leave zeros.',
  );
  details.append(hint);

  const row = el('div', 'field-row');
  const inField = el('div', 'field');
  inField.append(el('label', undefined, 'Default input / 1M'));
  const inInput = document.createElement('input');
  inInput.type = 'number';
  inInput.min = '0';
  inInput.step = 'any';
  inInput.className = 'settings-input';
  inInput.name = 'pricingDefaultInput';
  inInput.value = String(pricing?.default?.inputPer1M ?? 0);
  inField.append(inInput);
  row.append(inField);

  const outField = el('div', 'field');
  outField.append(el('label', undefined, 'Default output / 1M'));
  const outInput = document.createElement('input');
  outInput.type = 'number';
  outInput.min = '0';
  outInput.step = 'any';
  outInput.className = 'settings-input';
  outInput.name = 'pricingDefaultOutput';
  outInput.value = String(pricing?.default?.outputPer1M ?? 0);
  outField.append(outInput);
  row.append(outField);
  details.append(row);

  const modelsField = el('div', 'field');
  modelsField.append(el('label', undefined, 'Per-model overrides (JSON)'));
  const modelsArea = document.createElement('textarea');
  modelsArea.className = 'settings-input settings-providers-pricing-json';
  modelsArea.name = 'pricingModelsJson';
  modelsArea.rows = 5;
  modelsArea.spellcheck = false;
  modelsArea.placeholder = '{"gpt-4o-mini":{"inputPer1M":0.15,"outputPer1M":0.6},"*":{"inputPer1M":1,"outputPer1M":3}}';
  if (pricing?.models && Object.keys(pricing.models).length > 0) {
    modelsArea.value = JSON.stringify(pricing.models, null, 2);
  }
  modelsField.append(modelsArea);
  details.append(modelsField);

  form.append(details);
}

function parsePricingFromForm(form: ParentNode): ProviderPricing | null | { error: string } {
  const inRaw = form.querySelector<HTMLInputElement>('input[name="pricingDefaultInput"]')?.value;
  const outRaw = form.querySelector<HTMLInputElement>('input[name="pricingDefaultOutput"]')?.value;
  const jsonRaw =
    form.querySelector<HTMLTextAreaElement>('textarea[name="pricingModelsJson"]')?.value.trim() ??
    '';

  const inputPer1M = Number(inRaw);
  const outputPer1M = Number(outRaw);
  if (!Number.isFinite(inputPer1M) || !Number.isFinite(outputPer1M)) {
    return { error: 'Default pricing must be valid numbers.' };
  }
  if (inputPer1M < 0 || outputPer1M < 0) {
    return { error: 'Default pricing cannot be negative.' };
  }

  let models: Record<string, { inputPer1M: number; outputPer1M: number }> | undefined;
  if (jsonRaw) {
    try {
      const parsed = JSON.parse(jsonRaw) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { error: 'Per-model pricing must be a JSON object.' };
      }
      models = {};
      for (const [key, value] of Object.entries(parsed)) {
        const rates = normalizeModelPricingRates(value);
        if (!rates) {
          return { error: `Invalid rates for model "${key}".` };
        }
        models[key] = rates;
      }
    } catch {
      return { error: 'Per-model pricing JSON is invalid.' };
    }
  }

  const hasDefault = inputPer1M > 0 || outputPer1M > 0;
  const hasModels = models && Object.keys(models).length > 0;
  if (!hasDefault && !hasModels) {
    return null;
  }

  const normalized = normalizeProviderPricing({
    currency: 'USD',
    default: { inputPer1M, outputPer1M },
    ...(hasModels ? { models } : {}),
  });
  if (!normalized) {
    return { error: 'Could not normalize pricing.' };
  }
  return normalized;
}

/** Append models + chat path inputs after API kind row. */
function appendPathFields(
  parent: HTMLElement,
  modelsPath: string,
  chatCompletionsPath: string,
  apiKind: ApiKind,
): void {
  const row = el('div', 'field-row');

  const modelsField = el('div', 'field');
  modelsField.append(el('label', undefined, 'Models path'));
  const modelsInput = document.createElement('input');
  modelsInput.type = 'text';
  modelsInput.className = 'settings-input';
  modelsInput.name = 'modelsPath';
  modelsInput.required = true;
  modelsInput.autocomplete = 'off';
  modelsInput.spellcheck = false;
  modelsInput.value = modelsPath;
  modelsField.append(modelsInput);
  row.append(modelsField);

  const chatField = el('div', 'field');
  const chatLabel = el('label', undefined, chatPathLabel(apiKind));
  chatLabel.dataset.providerChatPathLabel = '';
  chatField.append(chatLabel);
  const chatInput = document.createElement('input');
  chatInput.type = 'text';
  chatInput.className = 'settings-input';
  chatInput.name = 'chatCompletionsPath';
  chatInput.required = true;
  chatInput.autocomplete = 'off';
  chatInput.spellcheck = false;
  chatInput.value = chatCompletionsPath;
  chatField.append(chatInput);
  row.append(chatField);

  parent.append(row);
  const hint = el('p', 'field-hint', pathFieldsHint(apiKind));
  hint.dataset.providerPathsHint = '';
  parent.append(hint);
}

/** Append API kind + auth style selects; returns the kind select for path sync wiring. */
function appendApiFields(
  parent: HTMLElement,
  apiKind: ApiKind,
  authStyle: AuthStyle,
): HTMLSelectElement {
  const row = el('div', 'field-row');

  const kindField = el('div', 'field');
  kindField.append(el('label', undefined, 'API style'));
  const kindSel = document.createElement('select');
  kindSel.className = 'settings-select';
  kindSel.name = 'apiKind';
  for (const opt of [
    { value: 'lm-studio-v0', label: 'LM Studio v0 (/api/v0/...)' },
    { value: 'openai-v1', label: 'OpenAI v1 (/v1/...)' },
    { value: 'anthropic-v1', label: 'Anthropic Messages' },
  ]) {
    const o = document.createElement('option');
    o.value = opt.value;
    o.textContent = opt.label;
    kindSel.appendChild(o);
  }
  kindSel.value = apiKind;
  kindField.append(kindSel);
  row.append(kindField);

  const authField = el('div', 'field');
  authField.append(el('label', undefined, 'Auth header'));
  const authSel = document.createElement('select');
  authSel.className = 'settings-select';
  authSel.name = 'authStyle';
  for (const opt of [
    { value: 'bearer', label: 'Bearer token' },
    { value: 'api-key', label: 'Authorization: Api-Key' },
    { value: 'x-api-key', label: 'X-Api-Key' },
  ]) {
    const o = document.createElement('option');
    o.value = opt.value;
    o.textContent = opt.label;
    authSel.appendChild(o);
  }
  authSel.value = authStyle;
  authField.append(authSel);
  row.append(authField);

  parent.append(row);
  return kindSel;
}

// ── Edit ─────────────────────────────────────────────────────────────────────

/** Persist optional API key after profile create/update. */
async function saveApiKeyIfProvided(
  providerId: string,
  apiKey: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!apiKey) return { ok: true };
  return updateProviderSecrets(providerId, { apiKey });
}

/** Inline edit form for one provider (submitted via list delegation). */
function buildProviderEditForm(provider: ProviderPublic): HTMLFormElement {
  const form = document.createElement('form');
  form.className = 'settings-providers-form settings-providers-edit-form';
  form.dataset.providerId = provider.id;
  form.noValidate = true;

  const resolved = pathsForProvider(provider);

  const { row: enabledLabel, input: enabledInput } = createSettingsToggleRow('Enabled', {
    name: 'enabled',
    checked: provider.enabled !== false,
  });
  form.append(enabledLabel);

  const idField = el('div', 'field');
  idField.append(el('label', undefined, 'Provider id'));
  const idInput = document.createElement('input');
  idInput.type = 'text';
  idInput.className = 'settings-input';
  idInput.value = provider.id;
  idInput.readOnly = true;
  idInput.setAttribute('aria-readonly', 'true');
  idField.append(idInput);
  idField.dataset.providerAdvancedField = '';
  form.append(idField);

  const labelField = el('div', 'field');
  labelField.append(el('label', undefined, 'Display name'));
  const labelInput = document.createElement('input');
  labelInput.type = 'text';
  labelInput.className = 'settings-input';
  labelInput.name = 'label';
  labelInput.required = true;
  labelInput.autocomplete = 'off';
  labelInput.value = provider.label;
  labelField.append(labelInput);
  form.append(labelField);

  const urlField = el('div', 'field');
  urlField.append(el('label', undefined, 'Base URL'));
  const baseUrlInput = document.createElement('input');
  baseUrlInput.type = 'url';
  baseUrlInput.className = 'settings-input';
  baseUrlInput.name = 'baseUrl';
  baseUrlInput.required = true;
  baseUrlInput.autocomplete = 'off';
  baseUrlInput.spellcheck = false;
  baseUrlInput.value = provider.baseUrl;
  urlField.append(baseUrlInput);
  form.append(urlField);

  const kindSel = appendApiFields(form, provider.apiKind, provider.authStyle ?? 'bearer');
  appendPathFields(form, resolved.modelsPath, resolved.chatCompletionsPath, provider.apiKind);

  const keyField = el('div', 'field');
  keyField.append(el('label', undefined, 'API key'));
  const apiKeyInput = document.createElement('input');
  apiKeyInput.type = 'password';
  apiKeyInput.className = 'settings-input';
  apiKeyInput.name = 'apiKey';
  apiKeyInput.autocomplete = 'off';
  apiKeyInput.placeholder = provider.hasApiKey || provider.hasBearer
    ? 'Leave blank to keep current key'
    : 'Optional';
  keyField.append(apiKeyInput);
  const keyHint = el(
    'p',
    'field-hint',
    provider.hasApiKey || provider.hasBearer
      ? 'Key saved. Leave blank to keep it.'
      : 'Stored encrypted on this machine.',
  );
  keyHint.dataset.providerKeyHint = provider.id;
  keyField.append(keyHint);
  form.append(keyField);

  appendGatewayFields(form, provider);
  wirePathSyncOnApiKindChange(form, kindSel);

  const constrainedValue =
    provider.constrainedToolCalls === true
      ? 'on'
      : provider.constrainedToolCalls === false
        ? 'off'
        : 'inherit';
  const { row: constrainedRow, select: constrainedSel } = createSettingsSelectRow(
    'Constrained tool calls',
    {
      name: 'constrainedToolCalls',
      searchKey: `models.providers.${provider.id}.constrained`,
      description:
        'Attach JSON Schema response_format on tool turns when the provider probe reports structured output support.',
      options: [
        { value: 'inherit', label: 'Use global default' },
        { value: 'on', label: 'Enabled' },
        { value: 'off', label: 'Disabled' },
      ],
      value: constrainedValue,
    },
  );
  form.append(constrainedRow);

  appendPricingFields(form, provider.pricing);

  const needsLoadedModel = provider.apiKind === 'lm-studio-v0';
  const loadedModelId = findLoadedModelIdForProvider(provider.id);
  const probesBlocked = needsLoadedModel && !loadedModelId;

  const probeHint = needsLoadedModel
    ? 'Load a model before checking capabilities. Checks send a short test request.'
    : 'Check model capabilities with a short test request.';
  const diagnostics = el('div', 'settings-providers-diagnostics');
  diagnostics.dataset.providerAdvancedField = '';
  diagnostics.append(el('p', 'field-hint', probeHint));
  diagnostics.append(
    createSettingsActionsRow(
      [
        {
          label: 'Probe models',
          className: 'settings-inline-btn',
          disabled: probesBlocked,
          title: probesBlocked ? NO_LOADED_MODEL_PROBE_MSG : undefined,
          dataset: { providerModelProbe: provider.id },
        },
        {
          label: 'Probe structured output',
          className: 'settings-inline-btn',
          disabled: probesBlocked,
          title: probesBlocked ? NO_LOADED_MODEL_PROBE_MSG : undefined,
          dataset: { providerStructuredProbe: provider.id },
        },
      ],
      { className: 'settings-providers-form-actions' },
    ),
  );
  if (probesBlocked) {
    const noLoadedNotice = el('p', 'settings-providers-probe-notice');
    noLoadedNotice.setAttribute('role', 'status');
    noLoadedNotice.dataset.providerStructuredProbeNotice = provider.id;
    noLoadedNotice.textContent = NO_LOADED_MODEL_PROBE_MSG;
    diagnostics.append(noLoadedNotice);
  }

  form.append(diagnostics);

  const err = el('p', 'settings-providers-form-error hidden');
  err.setAttribute('role', 'alert');
  err.dataset.providerEditError = provider.id;
  form.append(err);

  const saveStatus = el(
    'p',
    'field-hint settings-providers-save-status',
    'Changes save when a field loses focus.',
  );
  saveStatus.setAttribute('role', 'status');
  saveStatus.dataset.providerEditStatus = provider.id;
  form.append(saveStatus);
  form.append(createSettingsActionsRow([], { className: 'settings-providers-form-actions' }));

  organizeProviderForm(form);
  return form;
}

// ── List ─────────────────────────────────────────────────────────────────────

function formatStructuredOutputBadge(
  caps: ProviderCapabilities | null,
  providerId?: string,
): { label: string; tone: 'ok' | 'muted' | 'warn' } {
  const modelId = providerId ? resolveProbePreferredModelId(providerId) : undefined;
  const badge = structuredOutputBadge(caps, modelId);
  if (badge === 'yes') return { label: 'Structured output', tone: 'ok' };
  if (badge === 'no') return { label: 'No structured output', tone: 'warn' };
  return { label: 'Structured output unknown', tone: 'muted' };
}

/** Compact connection summary, with configuration disclosed on demand. */
export function createProviderSettingsRow(
  provider: ProviderPublic,
  canRemove: boolean,
  capabilities: ProviderCapabilities | null = null,
): HTMLElement {
  const row = el('div', 'settings-providers-row');
  row.setAttribute('role', 'listitem');
  row.dataset.providerId = provider.id;
  const panel = el('details', 'settings-providers-edit-panel');
  const summary = el('summary', 'settings-providers-row-head');
  const identity = el('span', 'settings-providers-row-identity');
  identity.append(el('span', 'settings-providers-name', provider.label));
  identity.append(el('span', 'settings-providers-endpoint', provider.baseUrl));
  const state = el('span', 'settings-providers-state', provider.enabled === false ? 'Disabled' : 'Enabled');
  state.dataset.enabled = String(provider.enabled !== false);
  const chevron = el('span', 'settings-providers-chevron', '');
  chevron.setAttribute('aria-hidden', 'true');
  summary.append(createProviderLogo(provider), identity, state, chevron);
  summary.setAttribute('aria-label', `${provider.label}, ${state.textContent}. Connection settings`);
  panel.append(summary);
  const reveal = () => {
    if (!panel.open || panel.querySelector('form')) return;
    const body = el('div', 'settings-providers-card-body');
    const form = buildProviderEditForm(provider);
    const advanced = form.querySelector('.settings-providers-advanced');
    const structured = el('p', 'field-hint', formatStructuredOutputBadge(capabilities, provider.id).label);
    advanced?.append(structured);
    if (!capabilities) {
      void readProviderCapabilities(provider.id).then((caps) => {
        structured.textContent = formatStructuredOutputBadge(caps, provider.id).label;
      });
    }
    const actions = form.querySelector<HTMLElement>(':scope > .settings-providers-form-actions');
    const test = el('button', 'settings-action-btn', 'Test connection');
    test.type = 'button';
    test.dataset.providerTest = provider.id;
    actions?.append(test);
    if (canRemove) {
      const remove = el('button', 'settings-inline-btn settings-providers-remove', 'Remove provider');
      remove.type = 'button';
      remove.dataset.providerRemove = provider.id;
      remove.setAttribute('aria-label', `Remove ${provider.label}`);
      actions?.append(remove);
    }
    const status = el('p', 'settings-providers-connection-status hidden');
    status.dataset.providerConnectionStatus = '';
    status.setAttribute('role', 'status');
    form.append(status);
    body.append(form);
    panel.append(body);
  };
  panel.addEventListener('toggle', reveal);
  row.append(panel);
  return row;
}

/** CLI connections are configured in Models → CLIs, but still belong in Providers. */
export function createAgentCliProviderSettingsRow(provider: ProviderPublic): HTMLElement {
  const row = el('div', 'settings-providers-row settings-providers-row--cli');
  row.setAttribute('role', 'listitem');
  row.dataset.providerId = provider.id;
  const head = el('div', 'settings-providers-row-head');
  const identity = el('div', 'settings-providers-row-identity');
  identity.append(
    el('span', 'settings-providers-name', provider.label),
    el('span', 'settings-providers-endpoint', 'Agent CLI'),
  );
  const state = el('span', 'settings-providers-state', provider.enabled === false ? 'Disabled' : 'Enabled');
  state.dataset.enabled = String(provider.enabled !== false);
  const manage = el('button', 'settings-inline-btn', 'Manage CLI');
  manage.type = 'button';
  manage.addEventListener('click', () => {
    void import('./models-page').then((m) => m.openModels('clis'));
  });
  head.append(createProviderLogo(provider), identity, state, manage);
  row.append(head);
  return row;
}

function closeProvidersAddPanel(): void {
  providersAddGroupEl?.classList.add('hidden');
  const button = document.getElementById('settingsProvidersAddButton');
  button?.setAttribute('aria-expanded', 'false');
  button?.focus();
}

/** Keep the common connection fields upfront, with protocol details folded away. */
function organizeProviderForm(form: HTMLFormElement, adding = false): void {
  const advanced = el('details', 'settings-providers-advanced');
  advanced.append(el('summary', undefined, 'Advanced settings'));
  const content = el('div', 'settings-providers-advanced-content');
  const idField = form.querySelector<HTMLElement>('[data-provider-advanced-field]');
  if (idField) content.append(idField);
  const names = ['apiKind', 'authStyle', 'modelsPath', 'chatCompletionsPath', 'constrainedToolCalls'];
  for (const child of Array.from(form.children)) {
    if ((adding && child.querySelector('[name="enabled"]')) || child.matches('[data-provider-advanced-field], [data-provider-paths-hint], .settings-providers-gateway-fields, .settings-providers-pricing-panel') ||
      names.some((name) => child.querySelector(`[name="${name}"]`))) {
      content.append(child);
    }
  }
  advanced.append(content);
  const actions = form.querySelector(':scope > .settings-providers-form-actions');
  form.insertBefore(advanced, actions);
  for (const field of form.querySelectorAll<HTMLElement>('.field, .settings-field')) {
    const input = field.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input, select, textarea');
    const label = field.querySelector<HTMLLabelElement>('label');
    if (!input || !label) continue;
    if (!input.id) input.id = `provider-${adding ? 'add' : form.dataset.providerId}-${input.name || 'id'}`;
    if (!input.hasAttribute('aria-labelledby')) label.htmlFor = input.id;
  }
  for (const input of form.querySelectorAll<HTMLInputElement>('input')) {
    input.defaultValue = input.value;
    input.defaultChecked = input.checked;
  }
  for (const select of form.querySelectorAll<HTMLSelectElement>('select')) {
    for (const option of select.options) option.defaultSelected = option.selected;
  }
  for (const area of form.querySelectorAll<HTMLTextAreaElement>('textarea')) area.defaultValue = area.value;
  if (adding) {
    const name = form.querySelector<HTMLInputElement>('input[name="label"]');
    const id = form.querySelector<HTMLInputElement>('input[name="id"]');
    name?.addEventListener('input', () => {
      if (id && !id.dataset.manual) id.value = suggestProviderId(name.value);
    });
    id?.addEventListener('input', () => { id.dataset.manual = '1'; });
  }
}

function isProviderFormDirty(form: HTMLFormElement): boolean {
  return Array.from(form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input, select, textarea')).some((input) => {
    if (input instanceof HTMLInputElement) {
      return input.type === 'checkbox'
        ? input.checked !== input.defaultChecked
        : input.value !== input.defaultValue;
    }
    if (input instanceof HTMLTextAreaElement) return input.value !== input.defaultValue;
    return Array.from(input.options).some((option) => option.selected !== option.defaultSelected);
  });
}

async function testProviderConnection(button: HTMLButtonElement): Promise<void> {
  const form = button.closest('form');
  const status = form?.querySelector<HTMLElement>('[data-provider-connection-status]');
  if (!form || !status) return;
  status.classList.remove('hidden');
  status.dataset.tone = 'muted';
  if (isProviderFormDirty(form)) {
    status.textContent = 'Wait for changes to save before testing this connection.';
    return;
  }
  button.disabled = true;
  button.textContent = 'Testing…';
  status.textContent = 'Checking the saved connection…';
  status.dataset.tone = 'muted';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(`/api/providers/${encodeURIComponent(button.dataset.providerTest ?? '')}/models`, { cache: 'no-store', signal: controller.signal });
    const body = await response.json() as { data?: unknown[]; unreachable?: boolean; error?: string };
    if (!response.ok || body.unreachable || body.error) throw new Error(body.error || `Connection failed (HTTP ${response.status}).`);
    if (!Array.isArray(body.data)) throw new Error('The server returned an invalid model catalog.');
    const count = body.data.length;
    status.dataset.tone = 'ok';
    status.textContent = count ? `Connected. ${count} ${count === 1 ? 'model' : 'models'} available.` : 'Connected. No models available yet.';
  } catch (error) {
    status.dataset.tone = 'error';
    status.textContent = error instanceof Error && error.name === 'AbortError' ? 'Connection timed out. Check the server address and try again.' : error instanceof Error ? error.message : 'Could not connect.';
  } finally {
    clearTimeout(timer);
    button.disabled = false;
    button.textContent = 'Test connection';
  }
}

function clearProvidersAddForm(): void {
  const form = document.getElementById('settingsProvidersAddForm') as HTMLFormElement | null;
  form?.reset();
  const id = form?.querySelector<HTMLInputElement>('input[name="id"]');
  if (id) delete id.dataset.manual;
  const enabled = document.getElementById('settingsProvidersAddEnabled') as HTMLInputElement | null;
  if (enabled) enabled.checked = true;
  const apiKind = document.getElementById('settingsProvidersAddApiKind') as HTMLSelectElement | null;
  if (apiKind) apiKind.value = 'lm-studio-v0';
  const authStyle = document.getElementById('settingsProvidersAddAuthStyle') as HTMLSelectElement | null;
  if (authStyle) authStyle.value = 'bearer';
  if (form) fillPathInputs(form, 'lm-studio-v0');
  if (apiKind) apiKind.dataset.prevApiKind = 'lm-studio-v0';
  const err = document.getElementById('settingsProvidersAddError');
  err?.classList.add('hidden');
  if (err) err.textContent = '';
}

/** Prevent duplicate writes and keep failures next to the form. */
async function runProviderFormAction(form: HTMLFormElement, error: Element | null, action: () => Promise<void>): Promise<void> {
  if (form.dataset.saving === '1') return;
  form.dataset.saving = '1';
  form.setAttribute('aria-busy', 'true');
  const buttons = Array.from(form.querySelectorAll<HTMLButtonElement>('button'));
  const states = buttons.map((button) => button.disabled);
  const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]');
  const label = submit?.textContent;
  buttons.forEach((button) => { button.disabled = true; });
  if (submit) submit.textContent = 'Saving…';
  error?.classList.add('hidden');
  try {
    await action();
  } catch (failure) {
    if (error) {
      error.textContent = failure instanceof Error ? failure.message : 'Could not save the provider. Try again.';
      error.classList.remove('hidden');
    }
  } finally {
    delete form.dataset.saving;
    form.removeAttribute('aria-busy');
    buttons.forEach((button, index) => { button.disabled = states[index]; });
    if (submit) submit.textContent = label ?? 'Save changes';
  }
}

/** Wire add-provider form submit once. */
function bindProvidersAddForm(): void {
  if (providersAddFormBound) return;
  providersAddFormBound = true;

  const form = document.getElementById('settingsProvidersAddForm') as HTMLFormElement | null;
  const errEl = document.getElementById('settingsProvidersAddError');
  const resetBtn = document.getElementById('settingsProvidersAddReset');
  const apiKindInput = document.getElementById('settingsProvidersAddApiKind') as HTMLSelectElement | null;

  if (form && apiKindInput) {
    fillPathInputs(form, parseApiKind(apiKindInput));
    wirePathSyncOnApiKindChange(form, apiKindInput);
    renderProvidersAddPicker(form);
    showProvidersAddPicker();
  }

  const backBtn = document.getElementById('settingsProvidersAddBack');
  backBtn?.addEventListener('click', () => resetProvidersAddFlow());

  resetBtn?.addEventListener('click', () => closeProvidersAddPanel());

  form?.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!form) return;
    void runProviderFormAction(form, errEl, async () => {
      const idInput = document.getElementById('settingsProvidersAddId') as HTMLInputElement | null;
      const labelInput = document.getElementById('settingsProvidersAddLabel') as HTMLInputElement | null;
      const baseUrlInput = document.getElementById('settingsProvidersAddBaseUrl') as HTMLInputElement | null;
      const apiKindSel = document.getElementById('settingsProvidersAddApiKind') as HTMLSelectElement | null;
      const authStyleInput = document.getElementById('settingsProvidersAddAuthStyle') as HTMLSelectElement | null;
      const apiKeyInput = document.getElementById('settingsProvidersAddApiKey') as HTMLInputElement | null;
      const enabledInput = document.getElementById('settingsProvidersAddEnabled') as HTMLInputElement | null;

      const id = idInput?.value.trim().toLowerCase() ?? '';
      const label = labelInput?.value.trim() ?? '';
      const baseUrl = baseUrlInput?.value.trim() ?? '';
      if (!id || !label || !baseUrl) {
        if (errEl) {
          errEl.textContent = 'Provider id, display name, and base URL are required.';
          errEl.classList.remove('hidden');
        }
        return;
      }

      if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) {
        const advanced = form.querySelector<HTMLDetailsElement>('.settings-providers-advanced');
        if (advanced) advanced.open = true;
        idInput?.focus();
        throw new Error('Provider ID must use lowercase letters, numbers, hyphens, or underscores.');
      }
      if (!baseUrlInput?.validity.valid) { baseUrlInput?.focus(); throw new Error('Enter a valid server URL.'); }
      const paths = parsePathFields(form);
      if ('error' in paths) {
        if (errEl) {
          errEl.textContent = paths.error;
          errEl.classList.remove('hidden');
        }
        return;
      }

      const result = await createProvider({
        id,
        label,
        baseUrl,
        apiKind: parseApiKind(apiKindSel),
        authStyle: parseAuthStyle(authStyleInput),
        enabled: enabledInput?.checked !== false,
        modelsPath: paths.modelsPath,
        chatCompletionsPath: paths.chatCompletionsPath,
        messagesPath: paths.messagesPath,
        autoApi: paths.autoApi,
        modelApiOverrides: paths.modelApiOverrides,
      });

      if (result.ok === false) {
        if (errEl) {
          errEl.textContent = result.error;
          errEl.classList.remove('hidden');
        }
        setStatus('err', result.error);
        return;
      }

      const secretResult = await saveApiKeyIfProvided(id, apiKeyInput?.value.trim() ?? '');
      if (secretResult.ok === false) {
        if (errEl) {
          errEl.textContent = `Provider added but API key failed: ${secretResult.error}`;
          errEl.classList.remove('hidden');
        }
        setStatus('err', secretResult.error);
        const key = apiKeyInput?.value ?? '';
        await renderProvidersSettingsSection();
        const panel = Array.from(providersListEl?.querySelectorAll<HTMLDetailsElement>('.settings-providers-edit-panel') ?? []).find((entry) => entry.closest<HTMLElement>('[data-provider-id]')?.dataset.providerId === id);
        if (panel) {
          panel.open = true;
          panel.dispatchEvent(new Event('toggle'));
          const keyInput = panel.querySelector<HTMLInputElement>('input[name="apiKey"]');
          if (keyInput) keyInput.value = key;
          setProviderEditFormError(id, `Provider added. API key could not be saved: ${secretResult.error}. Press Enter in the key field to retry.`);
          closeProvidersAddPanel();
          resetProvidersAddFlow();
          keyInput?.focus();
        }
        return;
      }

      if (errEl) errEl.classList.add('hidden');
      resetProvidersAddFlow();
      closeProvidersAddPanel();
      setStatus('ok', `Added provider ${result.provider.label}`);
      await fetchModels();
      await renderProvidersSettingsSection();
    });
  });
}

/** Update the provider row header without rebuilding the list. */
function updateProviderRowSummary(form: HTMLFormElement, provider: ProviderPublic): void {
  const row = form.closest('.settings-providers-row');
  if (!row) return;
  const name = row.querySelector<HTMLElement>('.settings-providers-name');
  if (name) name.textContent = provider.label;
  const endpoint = row.querySelector<HTMLElement>('.settings-providers-endpoint');
  if (endpoint) endpoint.textContent = provider.baseUrl;
  const enabled = provider.enabled !== false;
  const state = row.querySelector<HTMLElement>('.settings-providers-state');
  if (state) {
    state.textContent = enabled ? 'Enabled' : 'Disabled';
    state.dataset.enabled = String(enabled);
  }
  row.querySelector('summary')?.setAttribute('aria-label', `${provider.label}, ${enabled ? 'Enabled' : 'Disabled'}. Connection settings`);
}

/** Persist one provider edit form in place, keeping the panel open. */
async function saveProviderEditForm(form: HTMLFormElement): Promise<void> {
  const id = form.dataset.providerId ?? '';
  const errEl = form.querySelector<HTMLElement>(`[data-provider-edit-error="${id}"]`);
  const statusEl = form.querySelector<HTMLElement>(`[data-provider-edit-status="${id}"]`);

  const labelInput = form.querySelector<HTMLInputElement>('input[name="label"]');
  const baseUrlInput = form.querySelector<HTMLInputElement>('input[name="baseUrl"]');
  const apiKindInput = form.querySelector<HTMLSelectElement>('select[name="apiKind"]');
  const authStyleInput = form.querySelector<HTMLSelectElement>('select[name="authStyle"]');
  const apiKeyInput = form.querySelector<HTMLInputElement>('input[name="apiKey"]');
  const enabledInput = form.querySelector<HTMLInputElement>('input[name="enabled"]');
  const keyValue = apiKeyInput?.value.trim() ?? '';

  const label = labelInput?.value.trim() ?? '';
  const baseUrl = baseUrlInput?.value.trim() ?? '';
  if (!label || !baseUrl) {
    if (errEl) {
      errEl.textContent = 'Display name and base URL are required.';
      errEl.classList.remove('hidden');
    }
    return;
  }

  if (!baseUrlInput?.validity.valid) { baseUrlInput?.focus(); throw new Error('Enter a valid server URL.'); }
  const paths = parsePathFields(form);
  if ('error' in paths) {
    const advanced = form.querySelector<HTMLDetailsElement>('.settings-providers-advanced');
    if (advanced) advanced.open = true;
    if (errEl) {
      errEl.textContent = paths.error;
      errEl.classList.remove('hidden');
    }
    return;
  }

  const pricingParsed = parsePricingFromForm(form);
  if (pricingParsed && 'error' in pricingParsed) {
    const advanced = form.querySelector<HTMLDetailsElement>('.settings-providers-advanced');
    if (advanced) advanced.open = true;
    if (errEl) {
      errEl.textContent = pricingParsed.error;
      errEl.classList.remove('hidden');
    }
    return;
  }

  const constrainedSel = form.querySelector<HTMLSelectElement>(
    'select[name="constrainedToolCalls"]',
  );
  let constrainedToolCalls: boolean | null = null;
  if (constrainedSel?.value === 'on') constrainedToolCalls = true;
  else if (constrainedSel?.value === 'off') constrainedToolCalls = false;

  const savedDefaults = Array.from(form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input, select, textarea')).map((control) => {
    if (control instanceof HTMLSelectElement) {
      const options = Array.from(control.options).map((option) => ({ option, selected: option.selected }));
      return () => { for (const { option, selected } of options) option.defaultSelected = selected; };
    }
    const value = control.name === 'apiKey' ? '' : control.value;
    const checked = control instanceof HTMLInputElement ? control.checked : false;
    return () => {
      control.defaultValue = value;
      if (control instanceof HTMLInputElement) control.defaultChecked = checked;
    };
  });

  const result = await updateProvider(id, {
    label,
    baseUrl,
    apiKind: parseApiKind(apiKindInput),
    authStyle: parseAuthStyle(authStyleInput),
    enabled: enabledInput?.checked === true,
    modelsPath: paths.modelsPath,
    chatCompletionsPath: paths.chatCompletionsPath,
    messagesPath: paths.messagesPath,
    autoApi: paths.autoApi ?? false,
    modelApiOverrides: paths.modelApiOverrides ?? undefined,
    constrainedToolCalls,
    pricing:
      pricingParsed === null
        ? null
        : (pricingParsed as ProviderPricing),
  });

  if (result.ok === false) {
    if (errEl) {
      errEl.textContent = result.error;
      errEl.classList.remove('hidden');
    }
    setStatus('err', result.error);
    return;
  }

  updateProviderRowSummary(form, result.provider);
  const secretResult = await saveApiKeyIfProvided(id, keyValue);
  if (secretResult.ok === false) {
    if (errEl) {
      errEl.textContent = `Saved profile but API key failed: ${secretResult.error}`;
      errEl.classList.remove('hidden');
    }
    setStatus('err', secretResult.error);
    await fetchModels();
    return;
  }

  if (errEl) errEl.classList.add('hidden');
  if (keyValue && apiKeyInput) {
    if (apiKeyInput.value.trim() === keyValue) apiKeyInput.value = '';
    apiKeyInput.placeholder = 'Leave blank to keep current key';
    const keyHint = form.querySelector<HTMLElement>(`[data-provider-key-hint="${id}"]`);
    if (keyHint) {
      keyHint.textContent = 'Key saved. Leave blank to keep it.';
    }
  }
  savedDefaults.forEach((apply) => apply());
  if (statusEl) statusEl.textContent = isProviderFormDirty(form) ? 'Changes pending…' : 'Saved';
  setStatus('ok', `Updated provider ${result.provider.label}`);
  await fetchModels();
}

const providerEditSaveTimers = new WeakMap<HTMLFormElement, ReturnType<typeof setTimeout>>();
const providerEditQueuedSaves = new WeakSet<HTMLFormElement>();

/** Coalesce provider edit saves so a blur and an Enter press write once. */
function scheduleProviderEditSave(form: HTMLFormElement): void {
  const pending = providerEditSaveTimers.get(form);
  if (pending) clearTimeout(pending);
  providerEditSaveTimers.set(
    form,
    setTimeout(() => {
      providerEditSaveTimers.delete(form);
      if (form.dataset.saving === '1') {
        providerEditQueuedSaves.add(form);
        return;
      }
      const error = form.querySelector('[data-provider-edit-error]');
      const status = form.querySelector('[data-provider-edit-status]');
      if (status) status.textContent = 'Saving…';
      void runProviderFormAction(form, error, () => saveProviderEditForm(form)).then(() => {
        if (error && !error.classList.contains('hidden') && status) status.textContent = 'Could not save changes.';
        if (providerEditQueuedSaves.delete(form)) scheduleProviderEditSave(form);
      });
    }, 200),
  );
}

/** Delegate remove, edit-form submit, and capability probe on the provider list. */
function bindProvidersListActions(listEl: HTMLElement): void {
  if (providersListActionsBound) return;
  providersListActionsBound = true;

  listEl.addEventListener('submit', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLFormElement)) return;
    if (!target.classList.contains('settings-providers-edit-form')) return;
    event.preventDefault();
    scheduleProviderEditSave(target);
  });

  // Edit forms save when a field loses focus.
  listEl.addEventListener('change', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const form = target.closest<HTMLFormElement>('form.settings-providers-edit-form');
    if (form) scheduleProviderEditSave(form);
  });

  listEl.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || !(event.target instanceof HTMLInputElement)) return;
    const form = event.target.closest<HTMLFormElement>('form.settings-providers-edit-form');
    if (!form) return;
    event.preventDefault();
    scheduleProviderEditSave(form);
  });

  listEl.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target.closest('button') : null;
    if (!(target instanceof HTMLButtonElement)) return;
    if (target.dataset.providerTest) { void testProviderConnection(target); return; }
    const form = target.closest('form');
    if (form && (target.dataset.providerModelProbe || target.dataset.providerStructuredProbe) && isProviderFormDirty(form)) {
      setProviderEditFormError(form.dataset.providerId ?? '', 'Wait for changes to save before checking capabilities.');
      return;
    }

    const modelProbeId = target.dataset.providerModelProbe;
    if (modelProbeId) {
      void (async () => {
        try {
          const { providers } = await listProviders();
          const provider = providers.find((p) => p.id === modelProbeId);
          const selectedModelId = await resolveProbePreferredModelIdAsync(modelProbeId);
          if (provider?.apiKind === 'lm-studio-v0') {
            const modelId = findProbeModelIdForProvider(
              modelProbeId,
              selectedModelId,
              provider.apiKind,
            );
            if (!modelId) {
              setProviderEditFormError(modelProbeId, NO_LOADED_MODEL_PROBE_MSG);
              setStatus('err', NO_LOADED_MODEL_PROBE_MSG);
              return;
            }
          }
          setProviderEditFormError(modelProbeId, null);
          setStatus('spin', `Probing models for ${modelProbeId}…`);
          const { runCapabilityProbeForProvider } = await import(
            '../providers/model-capabilities'
          );
          await runCapabilityProbeForProvider(modelProbeId, {
            selectedModelId,
            apiKind: provider?.apiKind,
            manual: true,
          });
          setStatus('ok', `Model capabilities probed for ${modelProbeId}`);
          await renderProvidersSettingsSection();
          await fetchModels();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          setProviderEditFormError(modelProbeId, msg);
          setStatus('err', msg);
        }
      })();
      return;
    }

    const structuredProbeId = target.dataset.providerStructuredProbe;
    if (structuredProbeId) {
      void (async () => {
        try {
          const { providers } = await listProviders();
          const provider = providers.find((p) => p.id === structuredProbeId);
          const selectedModelId = await resolveProbePreferredModelIdAsync(structuredProbeId);
          const modelId = findProbeModelIdForProvider(
            structuredProbeId,
            selectedModelId,
            provider?.apiKind,
          );
          if (!modelId && provider?.apiKind === 'lm-studio-v0') {
            setProviderEditFormError(structuredProbeId, NO_LOADED_MODEL_PROBE_MSG);
            setStatus('err', NO_LOADED_MODEL_PROBE_MSG);
            return;
          }
          setProviderEditFormError(structuredProbeId, null);
          setStatus(
            'spin',
            modelId
              ? `Probing structured output for ${structuredProbeId} (${modelId})…`
              : `Probing structured output for ${structuredProbeId}…`,
          );
          await probeProviderCapabilities(structuredProbeId, {
            ...(modelId ? { modelId } : {}),
            ...(selectedModelId || modelId
              ? { selectedModelId: selectedModelId ?? modelId ?? undefined }
              : {}),
          });
          setStatus('ok', `Structured output probed for ${structuredProbeId}`);
          await renderProvidersSettingsSection();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          setProviderEditFormError(structuredProbeId, msg);
          setStatus('err', msg);
        }
      })();
      return;
    }

    const removeId = target.dataset.providerRemove;
    if (!removeId) return;

    void (async () => {
      if (
        !(await appConfirm(
          `Remove provider "${removeId}"? This deletes ~/.minnow/providers/${removeId}/.`,
          { confirmLabel: 'Remove', danger: true },
        ))
      ) {
        return;
      }
      const result = await deleteProvider(removeId);
      if (result.ok === false) {
        setStatus('err', result.error);
        return;
      }
      setStatus('ok', `Removed provider ${removeId}`);
      await fetchModels();
      await renderProvidersSettingsSection();
    })();
  });
}

// ── Render ───────────────────────────────────────────────────────────────────

/** Agent CLI providers are managed exclusively from Models → CLIs. */
export function filterGenericProviderSettingsRows(
  providers: ProviderPublic[],
): ProviderPublic[] {
  return providers.filter((provider) => provider.apiKind !== 'agent-cli-v1');
}

/** Refresh Settings → Providers list and offline/add panel visibility. */
export async function renderProvidersSettingsSection(): Promise<void> {
  const revision = ++providersRenderRevision;
  let listEl: HTMLElement;
  try {
    listEl = ensureProvidersShell();
  } catch {
    return;
  }

  bindProvidersAddForm();
  bindProvidersListActions(listEl);
  const openIds = new Set(Array.from(listEl.querySelectorAll<HTMLDetailsElement>('.settings-providers-edit-panel[open]'), (panel) => panel.closest<HTMLElement>('[data-provider-id]')?.dataset.providerId));
  const { providers } = await listProviders().catch(() => ({ providers: [] }));
  if (revision !== providersRenderRevision || !listEl.isConnected) return;
  const online = isServerStorageMode() && isProvidersApiAvailable();
  providersOfflineEl?.classList.toggle('hidden', online);
  const addButton = document.getElementById('settingsProvidersAddButton') as HTMLButtonElement | null;
  if (addButton) {
    addButton.disabled = false;
    addButton.textContent = online ? 'Add provider' : 'Retry connection';
  }
  if (!online) providersAddGroupEl?.classList.add('hidden');

  if (!online) {
    listEl.removeAttribute('role');
    listEl.replaceChildren();
    return;
  }
  listEl.setAttribute('role', 'list');

  const configurableProviders = filterGenericProviderSettingsRows(providers);
  const cliProviders = providers.filter((provider) => provider.apiKind === 'agent-cli-v1');
  const canRemove = providers.length > 1;

  if (configurableProviders.length === 0 && cliProviders.length === 0) {
    listEl.setAttribute('role', 'status');
    listEl.replaceChildren(
      el(
        'p',
        'settings-providers-empty',
        'No connections yet. Add a provider to use your local or cloud models.',
      ),
    );
    return;
  }

  const rows = document.createDocumentFragment();
  configurableProviders.sort((a, b) => Number(b.enabled !== false) - Number(a.enabled !== false));
  configurableProviders.forEach((provider) => {
    const row = createProviderSettingsRow(provider, canRemove);
    rows.append(row);
    const panel = row.querySelector<HTMLDetailsElement>('.settings-providers-edit-panel');
    if (panel && openIds.has(provider.id)) panel.open = true;
  });
  for (const provider of cliProviders) {
    rows.appendChild(createAgentCliProviderSettingsRow(provider));
  }
  listEl.replaceChildren(rows);
}

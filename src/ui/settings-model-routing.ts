import '../styles/settings-general.css';
import '../styles/settings-routing.css';

import { patchWorkAgentOverride } from '../agents/work-agent-prompt-api';
import type { ThinkingTriState } from '../agents/thinking-types';
import { saveSubAgentConfigToServer, loadSubAgentConfig } from '../agents/sub-agent-config';
import { buildThinkingBudgetFieldInputs } from './settings-thinking-budget-fields';
import { saveUiDesignerConfig } from '../agents/ui-designer/config';
import { saveTitlesConfig } from '../config/titles-meta';
import { saveGoalEvalConfig } from '../config/goal-eval-meta';
import { saveUtilityModelConfig } from '../config/utility-model-meta';
import { populateMultiProviderModelSelect } from '../api/models';
import { decodeModelSelectKey, encodeModelSelectKey } from '../lib/model-select-key';
import {
  getFallbackCandidatesForKey,
  getGlobalFallbackCandidates,
  GLOBAL_FALLBACK_CHAIN_KEY,
  loadFallbackChainsConfig,
  saveFallbackChainsConfig,
  type FallbackChainCandidate,
  type FallbackChainsConfig,
} from '../config/fallback-chains-meta';
import { saveSamplerMeta } from '../config/sampler-meta';
import {
  detectConfigServer,
  isConfigServerMode,
  refreshConfigStorageBanner,
} from '../config/storage-mode';
import {
  loadModelRoutingCatalog,
  type ModelRoutingGroup,
  type ModelRoutingRow,
} from '../settings/model-routing-catalog';
import {
  getActiveChat,
  scheduleSaveSessions,
  touchChat,
} from '../state/sessions';
import { listProviders } from '../providers/store';
import {
  appendSettingsGroup,
  linkToSettingsSection,
} from './settings-layout';
import {
  appendProviderModelFields,
  fillModelSelect,
  fillProviderSelect,
} from './settings-model-binding';
import { buildSamplerFieldInputs } from './settings-sampler-fields';
import {
  appendSettingsOfflineHint,
  createSettingsInputRow,
  createSettingsSelectRow,
} from './settings-controls';
import { createSettingsToggleRow } from './settings-switch';
import { setStatus } from './status';
import {
  mountAuxiliaryModelSelectCombobox,
  syncAuxiliaryModelSelectCombobox,
} from './model-select-picker';

const GROUP_LABELS: Record<ModelRoutingGroup, string> = {
  'main-chat': 'Main chat',
  'work-agents': 'Work agents',
  'sub-agents': 'Sub-agents',
  background: 'Background jobs',
};

const GROUP_HINTS: Partial<Record<ModelRoutingGroup, string>> = {
  'main-chat':
    'Matches the top-bar picker for the active chat. Sampler fields here also update global defaults when changed.',
  background:
    'Rename jobs, goal checks, and skill runtimes that run outside the composer.',
};

type RoutingPersistOptions = {
  /** Re-render the section after persist (default true). */
  refresh?: boolean;
};

/** Routing groups shown on Models → Routing (agent roles live in Agents center). */
const ROUTING_PAGE_GROUPS: ModelRoutingGroup[] = ['main-chat', 'background'];

interface RowControls {
  row: ModelRoutingRow;
  providerSelect: HTMLSelectElement;
  modelSelect: HTMLSelectElement;
  /** Routing page rows use the composer-style combined provider/model picker. */
  combinedModelPicker?: boolean;
  fallbackCb?: HTMLInputElement;
  enabledCb?: HTMLInputElement;
  effectiveEl?: HTMLElement;
  samplerFields?: ReturnType<typeof buildSamplerFieldInputs>;
  thinkingSelect?: HTMLSelectElement;
  thinkingBudgetFields?: ReturnType<typeof buildThinkingBudgetFieldInputs>;
  fallbackEditor?: FallbackRowEditor;
}

interface FallbackRowEditor {
  rowId: string;
  list: HTMLElement;
  candidates: FallbackChainCandidate[];
  /** Persist fallback chain edits without a Save button. */
  onCandidatesChange?: () => void;
}

let mountedRows: RowControls[] = [];
let lastCatalogChatId: string | null = null;
let loadedFallbackConfig: FallbackChainsConfig | null = null;
let globalFallbackEnabledInput: HTMLInputElement | null = null;
let globalFallbackCooldownInput: HTMLInputElement | null = null;
let globalFallbackEditor: FallbackRowEditor | null = null;
let globalFallbackHealthHost: HTMLElement | null = null;
let routingModelOptionsPromise: Promise<string> | null = null;

// ── Advanced ─────────────────────────────────────────────────────────────────

function supportsAdvancedPanel(row: ModelRoutingRow): boolean {
  return (
    row.persistKind === 'main-chat' ||
    row.persistKind === 'work-agent' ||
    row.persistKind === 'sub-agent'
  );
}

function buildThinkingSelect(initial: ThinkingTriState): HTMLSelectElement {
  const select = el('select', 'settings-select');
  for (const mode of ['inherit', 'on', 'off'] as const) {
    const opt = document.createElement('option');
    opt.value = mode;
    opt.textContent = mode === 'inherit' ? 'Inherit' : mode === 'on' ? 'On' : 'Off';
    select.appendChild(opt);
  }
  select.value = initial;
  return select;
}

async function saveAdvanced(
  controls: RowControls,
  options?: RoutingPersistOptions,
): Promise<void> {
  const refresh = options?.refresh !== false;
  const { row, samplerFields, thinkingSelect, thinkingBudgetFields } = controls;
  if (!samplerFields || !thinkingSelect) return;

  switch (row.persistKind) {
    case 'main-chat': {
      const patch = samplerFields.readPatch();
      if (patch) await saveSamplerMeta(patch);
      const chat = getActiveChat();
      const mode = thinkingSelect.value as ThinkingTriState;
      if (mode === 'inherit') delete chat.thinkingMode;
      else chat.thinkingMode = mode;
      touchChat(chat);
      scheduleSaveSessions();
      setStatus('ok', 'Main chat sampler and thinking updated');
      if (refresh) void refreshModelRoutingSectionMount();
      break;
    }
    case 'work-agent': {
      const budgetRead = thinkingBudgetFields?.readValue();
      const agent = await patchWorkAgentOverride(row.id, {
        sampler: samplerFields.readPatch(),
        thinkingMode: thinkingSelect.value as ThinkingTriState,
        ...(thinkingBudgetFields
          ? {
              thinkingBudgetTokens:
                budgetRead === undefined ? null : budgetRead,
            }
          : {}),
      });
      setStatus(
        agent ? 'ok' : 'err',
        agent ? `${row.label} advanced settings updated` : 'Save failed',
      );
      if (agent && refresh) void refreshModelRoutingSectionMount();
      break;
    }
    case 'sub-agent': {
      const config = await loadSubAgentConfig();
      const existing = config.types[row.id];
      if (!existing) {
        setStatus('err', 'Unknown sub-agent type');
        return;
      }
      const samplerPatch = samplerFields.readPatch();
      const ok = await saveSubAgentConfigToServer({
        types: {
          [row.id]: {
            ...existing,
            ...(samplerPatch != null ? { sampler: samplerPatch } : {}),
            thinkingMode: thinkingSelect.value as ThinkingTriState,
            ...(thinkingBudgetFields
              ? {
                  thinkingBudgetTokens:
                    thinkingBudgetFields.readValue() === undefined
                      ? null
                      : thinkingBudgetFields.readValue(),
                }
              : {}),
          },
        },
      });
      setStatus(ok ? 'ok' : 'err', ok ? `${row.label} advanced settings updated` : 'Save failed');
      if (ok && refresh) void refreshModelRoutingSectionMount();
      break;
    }
    default:
      break;
  }
}

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

// ── Rows ─────────────────────────────────────────────────────────────────────

function formatEffective(row: ModelRoutingRow): string {
  if (row.persistKind === 'utility' && row.usesChatDefault) {
    return 'current model for each task';
  }
  if (row.usesChatDefault && row.persistKind !== 'ui-designer') {
    return `${row.effectiveModelId || '(chat default)'} · ${row.effectiveProviderId || '—'}`;
  }
  if (row.persistKind === 'ui-designer' && row.fallbackToChatModel && row.usesChatDefault) {
    return `chat default (${row.effectiveModelId || '—'})`;
  }
  return `${row.effectiveModelId || '—'} · ${row.effectiveProviderId || '—'}`;
}

function readControlsBinding(controls: RowControls): { providerId: string; modelId: string } {
  if (controls.combinedModelPicker) {
    const decoded = decodeModelSelectKey(controls.modelSelect.value.trim());
    return decoded ?? { providerId: '', modelId: '' };
  }
  return {
    providerId: controls.providerSelect.value.trim(),
    modelId: controls.modelSelect.value.trim(),
  };
}

async function populateRoutingModelSelect(
  select: HTMLSelectElement,
  selectedProviderId: string,
  selectedModelId: string,
  emptyLabel: '(use current model)' | '(select model)',
): Promise<void> {
  if (!routingModelOptionsPromise) {
    const catalogSelect = document.createElement('select');
    routingModelOptionsPromise = populateMultiProviderModelSelect(catalogSelect, {
      includeEmptyOption: false,
    }).then(() => catalogSelect.innerHTML);
  }

  const optionsHtml = await routingModelOptionsPromise;
  const empty = document.createElement('option');
  empty.value = '';
  empty.textContent = emptyLabel;
  select.innerHTML = optionsHtml;
  select.insertBefore(empty, select.firstChild);

  const providerId = selectedProviderId.trim();
  const modelId = selectedModelId.trim();
  const selectedValue = providerId && modelId
    ? encodeModelSelectKey(providerId, modelId)
    : '';
  select.value = [...select.options].some((option) => option.value === selectedValue)
    ? selectedValue
    : '';
  syncAuxiliaryModelSelectCombobox(select);
}

function setEffectiveText(controls: RowControls): void {
  if (!controls.effectiveEl) return;
  controls.effectiveEl.textContent = formatEffective(controls.row);
}

function syncRowBindingFromControls(controls: RowControls): void {
  const binding = readControlsBinding(controls);
  controls.row.providerId = binding.providerId;
  controls.row.modelId = binding.modelId;
  controls.row.usesChatDefault = !binding.modelId;
  if (binding.modelId) {
    controls.row.effectiveProviderId = binding.providerId;
    controls.row.effectiveModelId = binding.modelId;
  }
  if (controls.fallbackCb) {
    controls.row.fallbackToChatModel = controls.fallbackCb.checked;
  }
  if (controls.enabledCb) {
    controls.row.titlesEnabled = controls.enabledCb.checked;
  }
  setEffectiveText(controls);
}

/** Apply routing edits on change instead of explicit Save rows. */
function wireRoutingRowAutoSave(controls: RowControls): void {
  let hydrating = true;

  const flushBinding = (): void => {
    if (hydrating) return;
    void saveRow(controls, { refresh: false });
  };

  const flushAdvanced = (): void => {
    if (hydrating) return;
    void saveAdvanced(controls, { refresh: false });
  };

  controls.modelSelect.addEventListener('change', flushBinding);
  controls.fallbackCb?.addEventListener('change', flushBinding);
  controls.enabledCb?.addEventListener('change', flushBinding);
  controls.thinkingSelect?.addEventListener('change', flushAdvanced);
  controls.samplerFields?.root.addEventListener('change', flushAdvanced);
  controls.thinkingBudgetFields?.root.addEventListener('change', flushAdvanced);

  if (controls.fallbackEditor) {
    controls.fallbackEditor.onCandidatesChange = () => {
      if (hydrating) return;
      void saveRowFallbackChain(controls.fallbackEditor!);
      setStatus('ok', 'Fallback chain updated');
    };
  }

  queueMicrotask(() => {
    hydrating = false;
  });
}

async function wireProviderModelSelects(
  controls: RowControls,
  includeEmptyProvider: boolean,
): Promise<void> {
  const { row, providerSelect, modelSelect } = controls;
  if (controls.combinedModelPicker) {
    await populateRoutingModelSelect(
      modelSelect,
      row.providerId,
      row.modelId,
      '(use current model)',
    );
    return;
  }
  await fillProviderSelect(providerSelect, row.providerId, {
    includeEmptyOption: includeEmptyProvider,
  });
  const providerId =
    row.providerId ||
    (includeEmptyProvider ? '' : providerSelect.value) ||
    row.effectiveProviderId;
  await fillModelSelect(modelSelect, providerId, row.modelId);

  providerSelect.addEventListener('change', () => {
    void fillModelSelect(modelSelect, providerSelect.value, '');
  });
}

async function saveRowFallbackChain(editor: FallbackRowEditor): Promise<void> {
  const candidates = editor.candidates
    .map((row) => ({
      providerId: row.providerId.trim(),
      modelId: row.modelId.trim(),
    }))
    .filter((row) => row.providerId);
  await saveFallbackChainsConfig({
    roles: { [editor.rowId]: candidates },
  });
}

async function saveRow(controls: RowControls, options?: RoutingPersistOptions): Promise<void> {
  const refresh = options?.refresh !== false;
  const { row, fallbackCb, enabledCb, fallbackEditor } = controls;
  const { providerId, modelId } = readControlsBinding(controls);

  if (fallbackEditor) {
    await saveRowFallbackChain(fallbackEditor);
  }

  switch (row.persistKind) {
    case 'work-agent': {
      const agent = await patchWorkAgentOverride(row.id, {
        providerId: providerId || null,
        modelId: modelId || null,
      });
      if (!agent) {
        setStatus('err', 'Could not save work agent binding');
        return;
      }
      setStatus('ok', `${row.label} binding updated`);
      if (refresh) void refreshModelRoutingSectionMount();
      else syncRowBindingFromControls(controls);
      break;
    }
    case 'sub-agent': {
      const config = await loadSubAgentConfig();
      const existing = config.types[row.id];
      if (!existing) {
        setStatus('err', 'Unknown sub-agent type');
        return;
      }
      const ok = await saveSubAgentConfigToServer({
        types: {
          [row.id]: {
            ...existing,
            providerId,
            modelId,
          },
        },
      });
      setStatus(ok ? 'ok' : 'err', ok ? `${row.label} binding updated` : 'Save failed');
      if (ok) {
        if (refresh) void refreshModelRoutingSectionMount();
        else syncRowBindingFromControls(controls);
      }
      break;
    }
    case 'ui-designer': {
      await saveUiDesignerConfig({
        providerId,
        modelId,
        fallbackToChatModel: fallbackCb?.checked !== false,
      });
      setStatus('ok', 'UI Designer binding updated');
      if (refresh) void refreshModelRoutingSectionMount();
      else syncRowBindingFromControls(controls);
      break;
    }
    case 'utility': {
      await saveUtilityModelConfig({ providerId, modelId });
      await saveTitlesConfig({
        enabled: enabledCb?.checked !== false,
      });
      setStatus('ok', 'Utility model updated');
      if (refresh) void refreshModelRoutingSectionMount();
      else syncRowBindingFromControls(controls);
      break;
    }
    case 'goal-eval': {
      await saveGoalEvalConfig({
        providerId,
        modelId,
      });
      setStatus('ok', 'Goal evaluator binding updated');
      if (refresh) void refreshModelRoutingSectionMount();
      else syncRowBindingFromControls(controls);
      break;
    }
    case 'editor-completion': {
      const followChat = !providerId.trim() && !modelId.trim();
      const { saveEditorAiCompletionConfig } = await import('../config/editor-ai-completion');
      await saveEditorAiCompletionConfig(
        followChat
          ? { useChatModel: true, providerId: '', modelId: '' }
          : { useChatModel: false, providerId, modelId },
      );
      setStatus('ok', 'Editor completion binding updated');
      if (refresh) void refreshModelRoutingSectionMount();
      else syncRowBindingFromControls(controls);
      break;
    }
    case 'main-chat': {
      const chat = getActiveChat();
      chat.providerId = providerId || chat.providerId;
      chat.modelId = modelId || chat.modelId;
      touchChat(chat);
      scheduleSaveSessions();
      setStatus('ok', 'Main chat model updated for active session');
      if (refresh) void refreshModelRoutingSectionMount();
      else syncRowBindingFromControls(controls);
      break;
    }
    default:
      break;
  }
}

// ── Fallback ─────────────────────────────────────────────────────────────────

function appendRoutingRole(
  groupBody: HTMLElement,
  controls: RowControls,
  bindingHost: HTMLElement,
): void {
  const { row } = controls;
  const role = el('article', 'settings-routing-role');
  role.dataset.routingId = row.id;
  role.dataset.settingsSearchKey = `models.routing.${row.id}`;

  const head = el('div', 'settings-routing-role__head');
  head.appendChild(el('div', 'settings-routing-role__title', row.label));
  if (row.description) {
    head.appendChild(el('p', 'settings-routing-role__desc', row.description));
  }
  const meta = el('div', 'settings-routing-role__meta');
  if (row.disabled) {
    meta.appendChild(el('span', 'settings-badge', 'disabled'));
  }
  if (meta.childElementCount) head.appendChild(meta);
  role.appendChild(head);

  const fields = el('div', 'settings-routing-role__fields');
  fields.appendChild(bindingHost);

  const extras = el('div', 'settings-routing-row__extras');
  if (row.persistKind === 'ui-designer') {
    const { row: fallbackRow, input: fallbackInput } = createSettingsToggleRow(
      'Use chat model when unset',
      { checked: row.fallbackToChatModel !== false },
    );
    fallbackRow.classList.add('settings-toggle-row--compact');
    controls.fallbackCb = fallbackInput;
    extras.appendChild(fallbackRow);
  }
  if (row.persistKind === 'utility') {
    const { row: enabledRow, input: enabledInput } = createSettingsToggleRow(
      'Enable automatic chat titles',
      { checked: row.titlesEnabled !== false },
    );
    enabledRow.classList.add('settings-toggle-row--compact');
    controls.enabledCb = enabledInput;
    extras.appendChild(enabledRow);
  }
  if (extras.childElementCount) fields.appendChild(extras);

  const effective = el('p', 'settings-routing-effective');
  effective.appendChild(el('span', 'settings-routing-effective__label', 'Effective'));
  const value = el('span', 'settings-routing-effective__value', formatEffective(row));
  effective.appendChild(document.createTextNode(' '));
  effective.appendChild(value);
  controls.effectiveEl = value;
  fields.appendChild(effective);

  if (supportsAdvancedPanel(row)) {
    const advanced = document.createElement('details');
    advanced.className = 'settings-routing-advanced';
    const summary = document.createElement('summary');
    summary.className = 'settings-routing-advanced__summary';
    summary.textContent = 'Sampler and thinking';
    advanced.appendChild(summary);

    const panel = el('div', 'settings-routing-advanced__body');
    const samplerFields = buildSamplerFieldInputs(row.sampler ?? null, {
      includeMaxTokens: row.persistKind === 'main-chat' || row.persistKind === 'sub-agent',
      emptyPlaceholder: row.persistKind === 'main-chat' ? '' : 'Inherit',
    });
    samplerFields.setValues(row.sampler ?? null);
    controls.samplerFields = samplerFields;
    panel.appendChild(samplerFields.root);

    const thinkingInitial =
      row.persistKind === 'main-chat'
        ? (row.chatThinkingMode ?? 'inherit')
        : (row.thinkingMode ?? 'inherit');
    const thinkingSelect = buildThinkingSelect(thinkingInitial);
    controls.thinkingSelect = thinkingSelect;
    const { row: thinkingSettingsRow } = createSettingsSelectRow('Thinking', {
      select: thinkingSelect,
      searchKey: `models.routing.${row.id}.thinking`,
    });
    panel.appendChild(thinkingSettingsRow);

    if (row.persistKind === 'work-agent' || row.persistKind === 'sub-agent') {
      const budgetFields = buildThinkingBudgetFieldInputs(row.thinkingBudgetTokens ?? null);
      controls.thinkingBudgetFields = budgetFields;
      panel.appendChild(budgetFields.root);
    }

    advanced.appendChild(panel);
    fields.appendChild(advanced);
  }

  if (loadedFallbackConfig) {
    appendRowFallbackEditor(fields, controls, loadedFallbackConfig);
  }

  wireRoutingRowAutoSave(controls);
  role.appendChild(fields);
  groupBody.appendChild(role);
}

function appendRowFallbackEditor(
  bindingCell: HTMLElement,
  controls: RowControls,
  config: FallbackChainsConfig,
): void {
  const details = el('details', 'settings-routing-fallback');
  const summary = document.createElement('summary');
  summary.className = 'settings-routing-fallback__summary';
  summary.textContent = 'Fallback chain';
  details.appendChild(summary);

  const panel = el('div', 'settings-routing-fallback__body');
  panel.appendChild(
    el(
      'p',
      'settings-routing-fallback__hint',
      'When fallback is on, Minnow tries the next provider/model only before the first token. Leave model blank to keep the request model.',
    ),
  );

  const list = el('div', 'settings-routing-fallback__list');
  const editor: FallbackRowEditor = {
    rowId: controls.row.id,
    list,
    candidates: getFallbackCandidatesForKey(config, controls.row.id).map((candidate) => ({
      ...candidate,
    })),
  };
  controls.fallbackEditor = editor;
  panel.appendChild(list);
  renderFallbackCandidateRows(editor);

  const addBtn = el('button', 'settings-action-btn', 'Add fallback');
  addBtn.type = 'button';
  addBtn.addEventListener('click', () => {
    editor.candidates.push({ providerId: '', modelId: '' });
    renderFallbackCandidateRows(editor);
  });
  panel.appendChild(addBtn);
  details.appendChild(panel);
  bindingCell.appendChild(details);
}

async function saveGlobalFallbackSettings(): Promise<void> {
  if (!loadedFallbackConfig) return;
  const config = loadedFallbackConfig;
  const rolesPatch: Record<string, FallbackChainCandidate[]> = {};
  if (globalFallbackEditor) {
    rolesPatch[GLOBAL_FALLBACK_CHAIN_KEY] = globalFallbackEditor.candidates
      .map((row) => ({
        providerId: row.providerId.trim(),
        modelId: row.modelId.trim(),
      }))
      .filter((row) => row.providerId);
  }
  await saveFallbackChainsConfig({
    enabled: globalFallbackEnabledInput?.checked === true,
    cooldownSeconds: Number(globalFallbackCooldownInput?.value ?? config.cooldownSeconds),
    roles: rolesPatch,
  });
  setStatus('ok', 'Fallback settings updated');
  if (globalFallbackHealthHost) {
    void refreshHostHealthPanel(globalFallbackHealthHost);
  }
}

async function renderGlobalFallbackBar(mount: HTMLElement): Promise<void> {
  const config = await loadFallbackChainsConfig();
  loadedFallbackConfig = config;
  globalFallbackEditor = null;

  const body = appendSettingsGroup(
    mount,
    'Fallback',
    'Try alternate models when a host fails. Role chains run first; the global chain is the last resort.',
    'models.routing.fallback',
    { emphasis: true },
  );

  const { row: enabledRow, input: enabledInput } = createSettingsToggleRow(
    'Enable fallback chains',
    {
      checked: config.enabled,
      onChange: () => {
        void saveGlobalFallbackSettings();
      },
    },
  );
  enabledRow.classList.add('settings-toggle-row--compact');
  globalFallbackEnabledInput = enabledInput;
  body.appendChild(enabledRow);

  const { row: cooldownSettingsRow, input: cooldownInput } = createSettingsInputRow(
    'Cooldown after failure (seconds)',
    {
      type: 'number',
      inputClassName: 'settings-input settings-input--narrow',
      min: '10',
      max: '3600',
      step: '1',
      value: String(config.cooldownSeconds),
      searchKey: 'models.routing.fallback.cooldown',
    },
  );
  globalFallbackCooldownInput = cooldownInput;
  cooldownInput.addEventListener('change', () => {
    void saveGlobalFallbackSettings();
  });
  body.appendChild(cooldownSettingsRow);

  const globalChainSection = el('div', 'settings-fallback-global-chain');
  globalChainSection.appendChild(
    el('h4', 'settings-fallback-global-chain__title', 'Global fallback chain'),
  );
  globalChainSection.appendChild(
    el(
      'p',
      'settings-fallback-global-chain__hint',
      'Used when a role has no chain or every candidate failed. Leave model blank to keep the request model.',
    ),
  );
  const globalList = el('div', 'settings-routing-fallback__list');
  const editor: FallbackRowEditor = {
    rowId: GLOBAL_FALLBACK_CHAIN_KEY,
    list: globalList,
    candidates: getGlobalFallbackCandidates(config).map((candidate) => ({ ...candidate })),
  };
  globalFallbackEditor = editor;
  editor.onCandidatesChange = () => {
    void saveGlobalFallbackSettings();
  };
  globalChainSection.appendChild(globalList);
  renderFallbackCandidateRows(editor);
  const addGlobalBtn = el('button', 'settings-action-btn', 'Add global fallback');
  addGlobalBtn.type = 'button';
  addGlobalBtn.addEventListener('click', () => {
    editor.candidates.push({ providerId: '', modelId: '' });
    renderFallbackCandidateRows(editor);
  });
  globalChainSection.appendChild(addGlobalBtn);
  body.appendChild(globalChainSection);

  const healthHost = el('div', 'settings-fallback-health');
  globalFallbackHealthHost = healthHost;
  body.appendChild(healthHost);
  void refreshHostHealthPanel(healthHost);
}

function renderFallbackCandidateRows(editor: FallbackRowEditor): void {
  editor.list.replaceChildren();
  editor.candidates.forEach((candidate, index) => {
    const row = el('div', 'settings-fallback-candidate');
    const bindingHost = el('div', 'settings-routing-row__selects');
    const modelSelect = appendCombinedModelPickerField(
      bindingHost,
      `fallback-${editor.rowId}-${index}-model`,
      'Model',
      `Fallback model ${index + 1}`,
    );
    void populateRoutingModelSelect(
      modelSelect,
      candidate.providerId,
      candidate.modelId,
      '(select model)',
    );
    modelSelect.addEventListener('change', () => {
      const decoded = decodeModelSelectKey(modelSelect.value.trim());
      candidate.providerId = decoded?.providerId ?? '';
      candidate.modelId = decoded?.modelId ?? '';
      editor.onCandidatesChange?.();
    });

    const removeBtn = el('button', 'settings-action-btn', 'Remove');
    removeBtn.type = 'button';
    removeBtn.addEventListener('click', () => {
      editor.candidates.splice(index, 1);
      renderFallbackCandidateRows(editor);
      editor.onCandidatesChange?.();
    });

    row.appendChild(bindingHost);
    row.appendChild(removeBtn);
    editor.list.appendChild(row);
  });
}

function appendCombinedModelPickerField(
  container: HTMLElement,
  id: string,
  label: string,
  ariaLabel: string,
): HTMLSelectElement {
  const field = el('div', 'settings-field settings-field--inline');
  const fieldLabel = el('label', 'settings-field-label', label);
  fieldLabel.htmlFor = id;
  const select = document.createElement('select');
  select.id = id;
  select.className = 'settings-select';
  select.setAttribute('aria-label', ariaLabel);
  select.innerHTML = '<option value="">Loading models…</option>';
  field.append(fieldLabel, select);
  container.appendChild(field);
  mountAuxiliaryModelSelectCombobox(select);
  return select;
}

async function refreshHostHealthPanel(host: HTMLElement): Promise<void> {
  host.replaceChildren();
  host.appendChild(el('h4', 'settings-fallback-health__title', 'Hosts in cooldown'));
  try {
    const res = await fetch('/api/system/host-health', { cache: 'no-store' });
    if (!res.ok) {
      host.appendChild(el('p', 'settings-fallback-health__empty', 'Cooldown list unavailable.'));
      return;
    }
    const payload = (await res.json()) as { hosts?: { origin: string; expiresAt: string }[] };
    const hosts = payload.hosts ?? [];
    if (hosts.length === 0) {
      host.appendChild(el('p', 'settings-fallback-health__empty', 'No hosts in cooldown.'));
      return;
    }
    const list = el('ul', 'settings-fallback-health__list');
    for (const row of hosts) {
      const item = el('li', '', `${row.origin} — retry after ${row.expiresAt}`);
      list.appendChild(item);
    }
    host.appendChild(list);
  } catch {
    host.appendChild(el('p', 'settings-fallback-health__empty', 'Host health unavailable.'));
  }
}

function renderGroup(
  mount: HTMLElement,
  group: ModelRoutingGroup,
  rows: ModelRoutingRow[],
): void {
  const body = appendSettingsGroup(
    mount,
    GROUP_LABELS[group],
    GROUP_HINTS[group],
    `models.routing.${group}`,
    { emphasis: true },
  );
  body.classList.add('settings-routing-group__body');

  for (const row of rows) {
    const ids = {
      provider: `modelRouting-${row.id}-provider`,
      model: `modelRouting-${row.id}-model`,
    };
    const bindingHost = el('div', 'settings-routing-row__selects');
    const providerSelect = document.createElement('select');
    const modelSelect = appendCombinedModelPickerField(
      bindingHost,
      ids.model,
      'Model',
      `${row.label} model`,
    );
    const controls: RowControls = {
      row,
      providerSelect,
      modelSelect,
      combinedModelPicker: true,
    };

    mountedRows.push(controls);
    appendRoutingRole(body, controls, bindingHost);
    void wireProviderModelSelects(
      controls,
      row.persistKind === 'utility' ||
        row.persistKind === 'goal-eval' ||
        row.persistKind === 'editor-completion' ||
        row.persistKind === 'main-chat' ||
        row.persistKind === 'work-agent' ||
        row.persistKind === 'sub-agent',
    );
  }
}

// ── Render ───────────────────────────────────────────────────────────────────

/** Render the model routing settings section into #settingsModelRoutingBody. */
export async function renderModelRoutingSection(mount: HTMLElement): Promise<void> {
  mountedRows = [];
  routingModelOptionsPromise = null;
  mount.replaceChildren();
  mount.dataset.settingsSearchKey = 'models.routing';

  const shell = el('div', 'settings-general settings-routing');
  mount.appendChild(shell);

  const lead = el('p', 'settings-section-lead');
  lead.append(
    'Pick provider and model per role. Main chat follows the top-bar picker. Work agent and sub-agent bindings are in ',
    linkToSettingsSection('Agents', 'agent-center'),
    '. Global defaults live under ',
    linkToSettingsSection('Sampler', 'sampler'),
    ' and ',
    linkToSettingsSection('Thinking', 'thinking'),
    '.',
  );
  shell.appendChild(lead);

  const storageMode = await detectConfigServer();
  refreshConfigStorageBanner();

  if (!isConfigServerMode(storageMode)) {
    appendSettingsOfflineHint(
      shell,
      'Model routing needs Minnow running locally. Values below are read-only until then.',
      { searchKey: 'models.routing' },
    );
  }

  const content = el('div', 'settings-general__content settings-routing__content');
  shell.appendChild(content);

  try {
    const { providers } = await listProviders();
    const activeProvider =
      providers.find((p) => p.enabled !== false)?.id ?? 'lm-studio-local';

    const catalog = await loadModelRoutingCatalog({
      providerId: activeProvider,
      modelId: '',
    });

    lastCatalogChatId = catalog.activeChat.id;

    if (catalog.offline) {
      appendSettingsOfflineHint(
        shell,
        'Open Minnow to load bindings from <code>~/.minnow</code>.',
        { searchKey: 'models.routing' },
      );
      return;
    }

    await renderGlobalFallbackBar(content);

    for (const group of ROUTING_PAGE_GROUPS) {
      const groupRows = catalog.rows.filter((r) => r.group === group);
      if (groupRows.length === 0) continue;
      renderGroup(content, group, groupRows);
    }
  } catch (err) {
    console.error('[model-routing] render failed', err);
    appendSettingsOfflineHint(
      shell,
      'Could not load bindings. Switch tabs and back, or refresh the page.',
      { searchKey: 'models.routing' },
    );
  }
}

/** Mount provider/model binding (+ advanced + fallback) for one routing row in a panel. */
export async function mountStandaloneRoutingEditor(
  container: HTMLElement,
  rowId: string,
): Promise<boolean> {
  container.replaceChildren();
  const panel = el('div', 'agent-center-routing-panel');
  panel.dataset.settingsSearchKey = `models.routing.${rowId}`;
  container.appendChild(panel);

  const storageMode = await detectConfigServer();
  if (!isConfigServerMode(storageMode)) {
    appendSettingsOfflineHint(
      panel,
      'Model binding requires Minnow running locally.',
    );
    return false;
  }

  const fallbackConfig = await loadFallbackChainsConfig();
  loadedFallbackConfig = fallbackConfig;

  const { providers } = await listProviders();
  const activeProvider =
    providers.find((p) => p.enabled !== false)?.id ?? 'lm-studio-local';
  const catalog = await loadModelRoutingCatalog({
    providerId: activeProvider,
    modelId: '',
  });
  const row = catalog.rows.find((r) => r.id === rowId);
  if (!row) {
    panel.appendChild(el('p', 'settings-field-hint', 'Routing row not found.'));
    return false;
  }

  const ids = {
    provider: `agentCenterRouting-${row.id}-provider`,
    model: `agentCenterRouting-${row.id}-model`,
  };
  const bindingHost = el('div', 'settings-routing-row__selects');
  const { providerSelect, modelSelect } = appendProviderModelFields(
    bindingHost,
    ids,
    undefined,
    'stacked',
  );
  const controls: RowControls = { row, providerSelect, modelSelect };
  panel.appendChild(bindingHost);

  const effective = el('p', 'settings-routing-effective');
  effective.appendChild(el('span', 'settings-routing-effective__label', 'Effective'));
  const value = el('span', 'settings-routing-effective__value', formatEffective(row));
  effective.appendChild(document.createTextNode(' '));
  effective.appendChild(value);
  controls.effectiveEl = value;
  panel.appendChild(effective);

  if (supportsAdvancedPanel(row)) {
    const advanced = document.createElement('details');
    advanced.className = 'settings-routing-advanced';
    const summary = document.createElement('summary');
    summary.className = 'settings-routing-advanced__summary';
    summary.textContent = 'Sampler and thinking';
    advanced.appendChild(summary);

    const advancedBody = el('div', 'settings-routing-advanced__body');
    const samplerFields = buildSamplerFieldInputs(row.sampler ?? null, {
      includeMaxTokens: row.persistKind === 'sub-agent',
      emptyPlaceholder: 'Inherit',
    });
    samplerFields.setValues(row.sampler ?? null);
    controls.samplerFields = samplerFields;
    advancedBody.appendChild(samplerFields.root);

    const thinkingSelect = buildThinkingSelect(row.thinkingMode ?? 'inherit');
    controls.thinkingSelect = thinkingSelect;
    const { row: thinkingSettingsRow } = createSettingsSelectRow('Thinking', {
      select: thinkingSelect,
      searchKey: `models.routing.${row.id}.thinking`,
    });
    advancedBody.appendChild(thinkingSettingsRow);

    if (row.persistKind === 'work-agent' || row.persistKind === 'sub-agent') {
      const budgetFields = buildThinkingBudgetFieldInputs(row.thinkingBudgetTokens ?? null);
      controls.thinkingBudgetFields = budgetFields;
      advancedBody.appendChild(budgetFields.root);
    }

    advanced.appendChild(advancedBody);
    panel.appendChild(advanced);
  }

  appendRowFallbackEditor(panel, controls, fallbackConfig);

  await wireProviderModelSelects(
    controls,
    row.persistKind === 'work-agent' || row.persistKind === 'sub-agent',
  );
  wireRoutingRowAutoSave(controls);
  setEffectiveText(controls);
  return true;
}

/** Re-render when catalog may be stale (after save). */
export async function refreshModelRoutingSectionMount(): Promise<void> {
  const mount = document.getElementById('settingsModelRoutingBody');
  if (!mount) return;
  await renderModelRoutingSection(mount);
}

/** Called on chat switch when model-routing panel may be visible. */
export function onModelRoutingActiveChatChanged(chatId: string): void {
  if (chatId === lastCatalogChatId) return;
  lastCatalogChatId = chatId;
  const mount = document.getElementById('settingsModelRoutingBody');
  if (mount?.childElementCount) void refreshModelRoutingSectionMount();
}

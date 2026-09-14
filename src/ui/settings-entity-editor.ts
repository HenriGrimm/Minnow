import {
  fetchWorkAgentPrompt,
  patchWorkAgentOverride,
  resetWorkAgentPromptOverride,
  saveWorkAgentPromptOverride,
  type WorkAgentPromptProfile,
} from '../agents/work-agent-prompt-api';
import {
  fetchPromptFile,
  resetPromptFileOverride,
  savePromptFileOverride,
  type PromptFileFamily,
  type PromptFileProfile,
} from '../chat/prompts/prompt-file-api';
import {
  resolveFilePromptBuiltinBaseline,
  resolveWorkAgentBuiltinBaselineText,
} from '../chat/prompts/prompt-baseline-resolve';
import { mountPromptDiffControls } from './prompt-diff-panel';
import type { ContextEnforcementPolicy } from '../chat/context-budget';
import {
  INHERIT_CONTEXT_POLICY,
  type ContextPolicySelectValue,
} from '../chat/resolve-context-policy';
import {
  DEFAULT_ARCHIVE_CONFIG,
  normalizeArchiveConfig,
  type ArchiveConfig,
} from '../chat/archive/types';
import {
  clearArchiveDisabledReason,
  getArchiveDisabledReason,
} from '../chat/archive/index';
import { fetchBrainEmbeddingsStatus } from '../brain/client';
import { listSummarySchemaPresetIds } from '../agents/sub-agent-summary-schemas';
import { listProviders } from '../providers/store';
import { fillModelSelect } from './settings-model-binding';
import {
  createSettingsActionsRow,
  createSettingsInputRow,
  createSettingsSelectRow,
} from './settings-controls';
import { createSettingsToggleRow } from './settings-switch';
import { setStatus } from './status';
import { appConfirm } from './app-dialog';

const CONTEXT_POLICY_OPTIONS: { value: ContextEnforcementPolicy; label: string }[] = [
  // No policy calls a model any more; summarize and drop middle both compact.
  { value: 'summarize', label: 'Summarize (compact, default)' },
  { value: 'dropMiddle', label: 'Drop middle (compact)' },
  { value: 'slide', label: 'Slide (drop oldest turns)' },
  { value: 'truncate', label: 'Truncate (drop oldest messages)' },
  { value: 'archive', label: 'Archive (Brain wiki)' },
];

const CONTEXT_POLICY_HINT =
  'Uses the active model\'s context window (90% safety margin). Requires a known context length.';

// ── Selects ──────────────────────────────────────────────────────────────────

function buildSummarySchemaSelect(initial: string): HTMLSelectElement {
  const sel = document.createElement('select');
  sel.className = 'settings-select';
  for (const id of listSummarySchemaPresetIds()) {
    const node = document.createElement('option');
    node.value = id;
    node.textContent = id;
    sel.appendChild(node);
  }
  sel.value = initial;
  return sel;
}

function buildContextPolicySelect(
  initial: ContextPolicySelectValue,
  options?: { allowInherit?: boolean; inheritHint?: string },
): HTMLSelectElement {
  const sel = document.createElement('select');
  sel.className = 'settings-select';
  if (options?.allowInherit) {
    const inherit = document.createElement('option');
    inherit.value = INHERIT_CONTEXT_POLICY;
    inherit.textContent = options.inheritHint ?? 'Inherit global default';
    sel.appendChild(inherit);
  }
  for (const opt of CONTEXT_POLICY_OPTIONS) {
    const node = document.createElement('option');
    node.value = opt.value;
    node.textContent = opt.label;
    if (opt.value === 'archive') {
      node.title =
        'Requires Brain embeddings (local or provider). Configure in Brain settings.';
    }
    sel.appendChild(node);
  }
  sel.value = initial;
  return sel;
}

function contextPolicyFromSelect(
  sel: HTMLSelectElement,
): ContextEnforcementPolicy | null {
  if (sel.value === INHERIT_CONTEXT_POLICY) return null;
  return sel.value as ContextEnforcementPolicy;
}

/** Global Agents default select (no inherit row). */
export function createGlobalContextPolicySelect(
  initial: ContextEnforcementPolicy,
): HTMLSelectElement {
  return buildContextPolicySelect(initial);
}

/** Disable archive policy when Brain embeddings are off or unhealthy. */
export async function applyArchiveEmbeddingsGate(sel: HTMLSelectElement): Promise<void> {
  const archiveOpt = [...sel.options].find((o) => o.value === 'archive');
  if (!archiveOpt) return;
  const status = await fetchBrainEmbeddingsStatus();
  const ok = status?.enabled === true && status?.healthy === true;
  archiveOpt.disabled = !ok;
  archiveOpt.title = ok
    ? 'Offload stale turns to Brain wiki pages'
    : 'Requires Brain embeddings (local or provider). Configure in Brain settings.';
  if (!ok && sel.value === 'archive') {
    sel.value = 'summarize';
  }
}

// ── Archive ──────────────────────────────────────────────────────────────────

function buildArchiveNumberInput(
  value: number,
  min: number,
  max: number,
  step = '1',
): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'number';
  input.className = 'settings-select settings-kv-input';
  input.min = String(min);
  input.max = String(max);
  input.step = step;
  input.value = String(value);
  return input;
}

function mountArchiveDisabledBanner(container: HTMLElement, onDismiss: () => void): () => void {
  const banner = el('div', 'settings-field-hint settings-archive-disabled-banner');
  banner.hidden = true;
  const text = el('span', '', '');
  const dismiss = el('button', 'settings-action-btn', 'Dismiss');
  dismiss.type = 'button';
  dismiss.addEventListener('click', () => {
    clearArchiveDisabledReason();
    banner.hidden = true;
    onDismiss();
  });
  banner.appendChild(text);
  banner.appendChild(dismiss);
  container.prepend(banner);

  return () => {
    const reason = getArchiveDisabledReason();
    if (!reason) {
      banner.hidden = true;
      return;
    }
    text.textContent = `Archive self-disabled: ${reason}`;
    banner.hidden = false;
  };
}

function mountArchiveTuningBlock(
  container: HTMLElement,
  initial: ArchiveConfig,
  isSubAgent = false,
): {
  root: HTMLElement;
  readConfig: () => ArchiveConfig;
} {
  const root = el('details', 'settings-archive-tuning');
  const summary = document.createElement('summary');
  summary.textContent = 'Archive tuning';
  root.appendChild(summary);

  if (isSubAgent) {
    const hint = el(
      'p',
      'settings-field-hint',
      'Saved for reference — sub-agents still use slide at runtime.',
    );
    root.appendChild(hint);
  }

  const stalenessInput = buildArchiveNumberInput(initial.stalenessTurns, 1, 200);
  const pressureInput = buildArchiveNumberInput(initial.pressureThreshold, 0.1, 0.99, '0.01');
  const minRecentInput = buildArchiveNumberInput(initial.minRecentTurns, 1, 50);
  const topKInput = buildArchiveNumberInput(initial.retrievalTopK, 1, 20);
  const embeddingInput = document.createElement('input');
  embeddingInput.type = 'text';
  embeddingInput.className = 'settings-select settings-kv-input';
  embeddingInput.placeholder = 'Brain default';
  embeddingInput.value = initial.embeddingModelId ?? '';

  const grid = el('div', 'settings-model-row');
  grid.appendChild(el('label', 'settings-field-label', 'Staleness turns'));
  grid.appendChild(stalenessInput);
  grid.appendChild(el('label', 'settings-field-label', 'Pressure threshold'));
  grid.appendChild(pressureInput);
  grid.appendChild(el('label', 'settings-field-label', 'Min recent turns'));
  grid.appendChild(minRecentInput);
  grid.appendChild(el('label', 'settings-field-label', 'Retrieval top K'));
  grid.appendChild(topKInput);
  grid.appendChild(el('label', 'settings-field-label', 'Embedding model id'));
  grid.appendChild(embeddingInput);
  root.appendChild(grid);

  return {
    root,
    readConfig: () =>
      normalizeArchiveConfig({
        stalenessTurns: Number(stalenessInput.value),
        pressureThreshold: Number(pressureInput.value),
        minRecentTurns: Number(minRecentInput.value),
        retrievalTopK: Number(topKInput.value),
        embeddingModelId: embeddingInput.value.trim() || undefined,
        llmRerank: initial.llmRerank,
      }) ?? { ...DEFAULT_ARCHIVE_CONFIG },
  };
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

export interface EntityEditorRow {
  id: string;
  label: string;
  hint?: string;
  /** Optional type chip in expandable list headers (Prompts hub). */
  badge?: string;
  /** Scroll target for settings search / chat deep-link. */
  searchKey?: string;
}

interface ModelBindingState {
  providerId: string;
  modelId: string;
}

function buildProfileTabs(
  onChange: (profile: PromptFileProfile) => void,
): { root: HTMLElement; getProfile: () => PromptFileProfile } {
  const root = el('div','settings-profile-tabs');
  root.setAttribute('role', 'tablist');
  let active: PromptFileProfile = 'full';

  const makeTab = (profile: PromptFileProfile, label: string) => {
    const btn = el('button', 'settings-profile-tab', label);
    btn.type = 'button';
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', profile === active ? 'true' : 'false');
    if (profile === active) btn.classList.add('is-active');
    btn.addEventListener('click', () => {
      active = profile;
      root.querySelectorAll('.settings-profile-tab').forEach((tab) => {
        const elTab = tab as HTMLButtonElement;
        const isActive = elTab.textContent === label;
        elTab.classList.toggle('is-active', isActive);
        elTab.setAttribute('aria-selected', isActive ? 'true' : 'false');
      });
      onChange(profile);
    });
    root.appendChild(btn);
  };

  makeTab('full', 'Full');
  makeTab('lite', 'Lite');

  return {
    root,
    getProfile: () => active,
  };
}

interface PromptEditorOptions {
  family: PromptFileFamily;
  entityId: string;
}

// ── Prompt ───────────────────────────────────────────────────────────────────

/** Mode, expert, or sub-agent prompt editor (file API). */
export function mountPromptFileEditor(
  container: HTMLElement,
  options: PromptEditorOptions,
): void {
  const { family, entityId } = options;
  let currentProfile: PromptFileProfile = 'full';
  let lastSavedContent = '';
  let builtinBaseline = '';
  let sourceLabel = el('span', 'settings-badge', '…');
  const ta = document.createElement('textarea');
  ta.className = 'settings-part-editor';
  ta.rows = 12;
  ta.placeholder = 'System prompt body for this profile';

  const reloadBaseline = async () => {
    builtinBaseline = await resolveFilePromptBuiltinBaseline(
      family,
      entityId,
      currentProfile,
    );
    diffControls.setBaseline(builtinBaseline);
    diffControls.refresh();
  };

  const reload = async () => {
    const data = await fetchPromptFile(family, entityId, currentProfile);
    if (!data) {
      sourceLabel.textContent = 'unavailable';
      ta.value = '';
      ta.disabled = true;
      lastSavedContent = '';
      await reloadBaseline();
      return;
    }
    sourceLabel.textContent = data.source === 'override' ? 'Custom override' : 'Built-in default';
    ta.value = data.content;
    lastSavedContent = data.content;
    ta.disabled = false;
    await reloadBaseline();
  };

  const tabs = buildProfileTabs((profile) => {
    currentProfile = profile;
    void reload();
  });

  container.appendChild(tabs.root);
  const meta = el('p', 'settings-field-hint');
  meta.appendChild(document.createTextNode('Source: '));
  meta.appendChild(sourceLabel);
  container.appendChild(meta);
  container.appendChild(ta);

  const diffControls = mountPromptDiffControls(container, {
    getBaseline: () => builtinBaseline,
    getCurrent: () => ta.value,
    showOfflineHint: true,
  });
  ta.addEventListener('input', () => diffControls.refresh());

  const actions = el('div','settings-actions');
  const saveBtn = el('button', 'settings-action-btn', 'Save prompt');
  saveBtn.type = 'button';
  saveBtn.addEventListener('click', () => {
    void (async () => {
      const saved = await savePromptFileOverride(
        family,
        entityId,
        currentProfile,
        ta.value,
      );
      if (!saved) {
        setStatus('err', 'Could not save prompt (Minnow must be running)');
        return;
      }
      sourceLabel.textContent =
        saved.source === 'override' ? 'Custom override' : 'Built-in default';
      lastSavedContent = ta.value;
      diffControls.refresh();
      setStatus('ok', `Prompt saved (${currentProfile})`);
    })();
  });

  const resetBtn = el('button', 'settings-action-btn', 'Reset to built-in');
  resetBtn.type = 'button';
  resetBtn.addEventListener('click', () => {
    void (async () => {
      const dirty = ta.value !== lastSavedContent;
      if (dirty && !(await appConfirm('Discard unsaved edits and remove your override?'))) return;
      if (!dirty && !(await appConfirm('Remove your override and restore the shipped prompt?'))) return;
      const restored = await resetPromptFileOverride(
        family,
        entityId,
        currentProfile,
      );
      if (!restored) {
        setStatus('err', 'No override to reset or server unavailable');
        return;
      }
      ta.value = restored.content;
      lastSavedContent = restored.content;
      sourceLabel.textContent = 'Built-in default';
      await reloadBaseline();
      setStatus('ok', 'Prompt reset to built-in');
    })();
  });

  actions.appendChild(saveBtn);
  actions.appendChild(resetBtn);
  container.appendChild(actions);

  void reload();
}

interface WorkAgentEditorOptions {
  agentId: string;
  initialProviderId: string | null;
  initialModelId: string | null;
  initialDisabled: boolean;
  initialContextPolicy: ContextPolicySelectValue;
  initialArchive?: ArchiveConfig;
  onModelSaved?: () => void;
}

// ── Work agent ───────────────────────────────────────────────────────────────

/** Work agent Full/Lite prompt editor only (Models hub holds binding). */
export function mountWorkAgentPromptEditor(
  container: HTMLElement,
  options: Pick<WorkAgentEditorOptions, 'agentId'>,
): void {
  let currentProfile: WorkAgentPromptProfile = 'full';
  let lastSavedPromptContent = '';
  let builtinBaseline = '';

  const sourceLabel = el('span', 'settings-badge', '…');
  const ta = document.createElement('textarea');
  ta.className = 'settings-part-editor';
  ta.rows = 12;

  const reloadBaseline = async () => {
    builtinBaseline = await resolveWorkAgentBuiltinBaselineText(
      options.agentId,
      currentProfile,
    );
    diffControls.setBaseline(builtinBaseline);
    diffControls.refresh();
  };

  const reloadPrompt = async () => {
    const data = await fetchWorkAgentPrompt(options.agentId, currentProfile);
    if (!data) {
      sourceLabel.textContent = 'unavailable';
      ta.value = '';
      lastSavedPromptContent = '';
      await reloadBaseline();
      return;
    }
    sourceLabel.textContent =
      data.source === 'override' ? 'Custom override' : 'Built-in default';
    ta.value = data.content;
    lastSavedPromptContent = data.content;
    await reloadBaseline();
  };

  const tabs = buildProfileTabs((profile) => {
    currentProfile = profile;
    void reloadPrompt();
  });

  container.appendChild(tabs.root);

  const meta = el('p', 'settings-field-hint');
  meta.appendChild(document.createTextNode('Prompt source: '));
  meta.appendChild(sourceLabel);
  container.appendChild(meta);
  container.appendChild(ta);

  const diffControls = mountPromptDiffControls(container, {
    getBaseline: () => builtinBaseline,
    getCurrent: () => ta.value,
    showOfflineHint: true,
  });
  ta.addEventListener('input', () => diffControls.refresh());

  const actions = el('div', 'settings-actions');

  const savePromptBtn = el('button', 'settings-action-btn', 'Save prompt');
  savePromptBtn.type = 'button';
  savePromptBtn.addEventListener('click', () => {
    void (async () => {
      const ok = await saveWorkAgentPromptOverride(
        options.agentId,
        currentProfile,
        ta.value,
      );
      setStatus(
        ok ? 'ok' : 'err',
        ok ? `Prompt saved (${currentProfile})` : 'Save failed',
      );
      if (ok) {
        lastSavedPromptContent = ta.value;
        diffControls.refresh();
        await reloadPrompt();
      }
    })();
  });

  const resetBtn = el('button', 'settings-action-btn', 'Reset prompt to built-in');
  resetBtn.type = 'button';
  resetBtn.addEventListener('click', () => {
    void (async () => {
      const dirty = ta.value !== lastSavedPromptContent;
      if (dirty && !(await appConfirm('Discard unsaved edits and remove your override?'))) return;
      if (!dirty && !(await appConfirm('Remove prompt override for this profile?'))) return;
      const restored = await resetWorkAgentPromptOverride(
        options.agentId,
        currentProfile,
      );
      if (!restored) {
        setStatus('err', 'No override to reset or server unavailable');
        return;
      }
      ta.value = restored.content;
      lastSavedPromptContent = restored.content;
      sourceLabel.textContent = 'Built-in default';
      await reloadBaseline();
      setStatus('ok', 'Prompt reset to built-in');
    })();
  });

  actions.appendChild(savePromptBtn);
  actions.appendChild(resetBtn);
  container.appendChild(actions);

  void reloadPrompt();
}

/** Work agent structural settings (enable, context budget) without model binding. */
export function mountWorkAgentConfigEditor(
  container: HTMLElement,
  options: WorkAgentEditorOptions,
): void {
  const contextPolicySel = buildContextPolicySelect(options.initialContextPolicy, {
    allowInherit: true,
  });
  void applyArchiveEmbeddingsGate(contextPolicySel);

  const policyHint = el('p', 'settings-field-hint', CONTEXT_POLICY_HINT);

  const archiveInitial = {
    ...DEFAULT_ARCHIVE_CONFIG,
    ...(options.initialArchive ?? {}),
  };
  const archiveBlock = mountArchiveTuningBlock(container, archiveInitial);
  const initialPolicyIsArchive =
    options.initialContextPolicy !== INHERIT_CONTEXT_POLICY &&
    options.initialContextPolicy === 'archive';
  (archiveBlock.root as HTMLDetailsElement).open = initialPolicyIsArchive;
  archiveBlock.root.hidden = !initialPolicyIsArchive;

  const refreshArchiveBanner = mountArchiveDisabledBanner(container, () => {
    refreshArchiveBanner();
  });
  refreshArchiveBanner();

  contextPolicySel.addEventListener('change', () => {
    const isArchive = contextPolicySel.value === 'archive';
    archiveBlock.root.hidden = !isArchive;
    if (!isArchive) {
      clearArchiveDisabledReason();
      refreshArchiveBanner();
    }
  });

  const { row: disabledRow, input: disabledCb } = createSettingsToggleRow('Disabled', {
    checked: !!options.initialDisabled,
  });

  container.appendChild(
    createSettingsSelectRow('Context policy', { select: contextPolicySel }).row,
  );
  container.appendChild(policyHint);
  container.appendChild(archiveBlock.root);
  container.appendChild(disabledRow);

  container.appendChild(
    createSettingsActionsRow([
      {
        label: 'Save agent settings',
        onClick: () => {
          void (async () => {
            const policy = contextPolicyFromSelect(contextPolicySel);
            const patch: Parameters<typeof patchWorkAgentOverride>[1] = {
              disabled: disabledCb.checked,
              contextEnforcementPolicy: policy,
            };
            if (policy === 'archive') {
              patch.archive = archiveBlock.readConfig();
            } else if (policy === null) {
              patch.archive = null;
            }
            const agent = await patchWorkAgentOverride(options.agentId, patch);
            if (!agent) {
              setStatus('err', 'Could not save work agent settings');
              return;
            }
            if (policy !== 'archive') clearArchiveDisabledReason();
            refreshArchiveBanner();
            setStatus('ok', 'Work agent settings saved');
            options.onModelSaved?.();
          })();
        },
      },
    ]),
  );
}

/** @deprecated Use mountWorkAgentPromptEditor + mountWorkAgentConfigEditor + Models hub. */
export function mountWorkAgentEditor(
  container: HTMLElement,
  options: WorkAgentEditorOptions,
): void {
  let currentProfile: WorkAgentPromptProfile = 'full';
  let lastSavedPromptContent = '';
  let builtinBaseline = '';
  let binding: ModelBindingState = {
    providerId: options.initialProviderId ?? '',
    modelId: options.initialModelId ?? '',
  };

  const sourceLabel = el('span', 'settings-badge', '…');
  const ta = document.createElement('textarea');
  ta.className = 'settings-part-editor';
  ta.rows = 12;

  const providerSel = document.createElement('select');
  providerSel.className = 'settings-select';
  const modelSel = document.createElement('select');
  modelSel.className = 'settings-select';

  const maxInputTokensInput = document.createElement('input');
  maxInputTokensInput.type = 'hidden';
  maxInputTokensInput.value = '';

  const contextPolicySel = buildContextPolicySelect(options.initialContextPolicy);

  const reloadBaseline = async () => {
    builtinBaseline = await resolveWorkAgentBuiltinBaselineText(
      options.agentId,
      currentProfile,
    );
    diffControls.setBaseline(builtinBaseline);
    diffControls.refresh();
  };

  const reloadPrompt = async () => {
    const data = await fetchWorkAgentPrompt(options.agentId, currentProfile);
    if (!data) {
      sourceLabel.textContent = 'unavailable';
      ta.value = '';
      lastSavedPromptContent = '';
      await reloadBaseline();
      return;
    }
    sourceLabel.textContent =
      data.source === 'override' ? 'Custom override' : 'Built-in default';
    ta.value = data.content;
    lastSavedPromptContent = data.content;
    await reloadBaseline();
  };

  const fillProviders = async () => {
    providerSel.replaceChildren();
    const { providers } = await listProviders();
    for (const p of providers) {
      if (p.enabled === false) continue;
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.label;
      providerSel.appendChild(opt);
    }
    providerSel.value = binding.providerId || providers[0]?.id || '';
    binding.providerId = providerSel.value;
    await fillModelSelect(modelSel, binding.providerId, binding.modelId);
  };

  providerSel.addEventListener('change', () => {
    binding.providerId = providerSel.value;
    void fillModelSelect(modelSel, binding.providerId, '');
  });
  modelSel.addEventListener('change', () => {
    binding.modelId = modelSel.value;
  });

  const tabs = buildProfileTabs((profile) => {
    currentProfile = profile;
    void reloadPrompt();
  });

  container.appendChild(tabs.root);

  const modelBlock = el('div', 'settings-model-row');
  modelBlock.appendChild(el('label', 'settings-field-label', 'Provider'));
  modelBlock.appendChild(providerSel);
  modelBlock.appendChild(el('label', 'settings-field-label', 'Model'));
  modelBlock.appendChild(modelSel);

  const { row: disabledRow, input: disabledCb } = createSettingsToggleRow('Disabled', {
    checked: !!options.initialDisabled,
  });
  const budgetBlock = el('div', 'settings-model-row');
  budgetBlock.appendChild(el('label', 'settings-field-label', 'Context policy'));
  budgetBlock.appendChild(contextPolicySel);
  budgetBlock.appendChild(el('p', 'settings-field-hint', CONTEXT_POLICY_HINT));

  container.appendChild(modelBlock);
  container.appendChild(budgetBlock);
  container.appendChild(disabledRow);

  const meta = el('p', 'settings-field-hint');
  meta.appendChild(document.createTextNode('Prompt source: '));
  meta.appendChild(sourceLabel);
  container.appendChild(meta);
  container.appendChild(ta);

  const diffControls = mountPromptDiffControls(container, {
    getBaseline: () => builtinBaseline,
    getCurrent: () => ta.value,
    showOfflineHint: true,
  });
  ta.addEventListener('input', () => diffControls.refresh());

  const actions = el('div','settings-actions');

  const savePromptBtn = el('button', 'settings-action-btn', 'Save prompt');
  savePromptBtn.type = 'button';
  savePromptBtn.addEventListener('click', () => {
    void (async () => {
      const ok = await saveWorkAgentPromptOverride(
        options.agentId,
        currentProfile,
        ta.value,
      );
      setStatus(
        ok ? 'ok' : 'err',
        ok ? `Prompt saved (${currentProfile})` : 'Save failed',
      );
      if (ok) {
        lastSavedPromptContent = ta.value;
        diffControls.refresh();
        await reloadPrompt();
      }
    })();
  });

  const saveModelBtn = el('button', 'settings-action-btn', 'Save model binding');
  saveModelBtn.type = 'button';
  saveModelBtn.addEventListener('click', () => {
    void (async () => {
      binding.modelId = modelSel.value;
      const agent = await patchWorkAgentOverride(options.agentId, {
        providerId: binding.providerId || null,
        modelId: binding.modelId || null,
        disabled: disabledCb.checked,
        contextEnforcementPolicy: contextPolicySel.value as ContextEnforcementPolicy,
      });
      if (!agent) {
        setStatus('err', 'Could not save binding');
        return;
      }
      setStatus('ok', 'Model binding saved');
      options.onModelSaved?.();
    })();
  });

  const resetBtn = el('button', 'settings-action-btn', 'Reset prompt to built-in');
  resetBtn.type = 'button';
  resetBtn.addEventListener('click', () => {
    void (async () => {
      const dirty = ta.value !== lastSavedPromptContent;
      if (dirty && !(await appConfirm('Discard unsaved edits and remove your override?'))) return;
      if (!dirty && !(await appConfirm('Remove prompt override for this profile?'))) return;
      const restored = await resetWorkAgentPromptOverride(
        options.agentId,
        currentProfile,
      );
      if (!restored) {
        setStatus('err', 'No override to reset or server unavailable');
        return;
      }
      ta.value = restored.content;
      lastSavedPromptContent = restored.content;
      sourceLabel.textContent = 'Built-in default';
      await reloadBaseline();
      setStatus('ok', 'Prompt reset to built-in');
    })();
  });

  actions.appendChild(savePromptBtn);
  actions.appendChild(saveModelBtn);
  actions.appendChild(resetBtn);
  container.appendChild(actions);

  void fillProviders().then(() => reloadPrompt());
}

// ── List ─────────────────────────────────────────────────────────────────────

/** Sub-agent type structural settings (prompt/model live in hubs). */
export function mountSubAgentTypeEditor(
  container: HTMLElement,
  typeId: string,
  label: string,
  initial: {
    enabled: boolean;
    maxConcurrent: number;
    contextEnforcementPolicy: ContextPolicySelectValue;
    summarySchema: string;
  },
  onSaveConfig: (
    patch: Partial<{
      enabled: boolean;
      maxConcurrent: number;
      contextEnforcementPolicy: ContextEnforcementPolicy | null;
      summarySchema: string;
    }>,
  ) => Promise<boolean>,
): void {
  const extra = el('div', 'settings-subagent-extra');
  extra.appendChild(el('p', 'settings-field-hint', `Type id: ${typeId}`));

  const maxInput = document.createElement('input');
  maxInput.type = 'number';
  maxInput.className = 'settings-select';
  maxInput.min = '1';
  maxInput.max = '8';
  maxInput.value = String(initial.maxConcurrent);

  const contextPolicySel = buildContextPolicySelect(initial.contextEnforcementPolicy, {
    allowInherit: true,
  });
  const policyHint = el('p', 'settings-field-hint', CONTEXT_POLICY_HINT);
  const summarySchemaSel = buildSummarySchemaSelect(initial.summarySchema);

  const { row: enabledRow, input: enabledCb } = createSettingsToggleRow(`${label} enabled`, {
    checked: initial.enabled,
  });

  extra.appendChild(enabledRow);
  extra.appendChild(createSettingsInputRow('Max concurrent', { input: maxInput }).row);
  extra.appendChild(
    createSettingsSelectRow('Context policy', { select: contextPolicySel }).row,
  );
  extra.appendChild(policyHint);
  extra.appendChild(
    createSettingsSelectRow('Summary schema', { select: summarySchemaSel }).row,
  );

  extra.appendChild(
    createSettingsActionsRow([
      {
        label: 'Save type settings',
        onClick: () => {
          void (async () => {
            const ok = await onSaveConfig({
              enabled: enabledCb.checked,
              maxConcurrent: Math.max(1, Number(maxInput.value) || 1),
              contextEnforcementPolicy: contextPolicyFromSelect(contextPolicySel),
              summarySchema: summarySchemaSel.value,
            });
            setStatus(ok ? 'ok' : 'err', ok ? `${label} settings saved` : 'Save failed');
          })();
        },
      },
    ]),
  );

  container.appendChild(extra);
}

/** List of expandable entity cards. */
export function renderEntityEditorList(
  mount: HTMLElement,
  rows: EntityEditorRow[],
  renderBody: (id: string, body: HTMLElement) => void,
): void {
  const list = el('ul', 'settings-entity-list');
  for (const row of rows) {
    const item = el('li', 'settings-entity-list__item');
    if (row.searchKey) {
      item.dataset.settingsSearchKey = row.searchKey;
    }
    const details = document.createElement('details');
    details.className = 'settings-entity-details';

    const summary = document.createElement('summary');
    summary.className = 'settings-entity-list__head';
    if (row.badge) {
      const badge = el('span', 'settings-entity-list__badge', row.badge);
      summary.appendChild(badge);
    }
    summary.append(document.createTextNode(row.label));
    details.appendChild(summary);

    if (row.hint) {
      const hint = el('p', 'settings-field-hint', row.hint);
      details.appendChild(hint);
    }

    const body = el('div','settings-entity-editor-body');
    let loaded = false;
    details.addEventListener('toggle', () => {
      if (!details.open || loaded) return;
      loaded = true;
      renderBody(row.id, body);
    });
    details.appendChild(body);
    item.appendChild(details);
    list.appendChild(item);
  }
  mount.appendChild(list);
}


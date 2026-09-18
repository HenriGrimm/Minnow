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
import {
  normalizeContextEnforcementPolicy,
  type ContextCompactionDefaults,
  type ContextEnforcementPolicy,
} from '../chat/context-budget';
import {
  INHERIT_CONTEXT_POLICY,
  type ContextPolicySelectValue,
} from '../chat/resolve-context-policy';
import { listSummarySchemaPresetIds } from '../agents/sub-agent-summary-schemas';
import { listProviders } from '../providers/store';
import { fillModelSelect } from './settings-model-binding';
import {
  createSettingsActionsRow,
  createSettingsInputRow,
  createSettingsKvList,
  createSettingsSelectRow,
} from './settings-controls';
import { createSettingsToggleRow } from './settings-switch';
import { setStatus } from './status';
import { appConfirm } from './app-dialog';

const CONTEXT_POLICY_OPTIONS: { value: ContextEnforcementPolicy; label: string }[] = [
  { value: 'compact', label: 'Compact (default)' },
  { value: 'slide', label: 'Slide (drop oldest turns)' },
  { value: 'truncate', label: 'Truncate (drop oldest messages)' },
];

const CONTEXT_POLICY_HINT =
  'Compact folds older turns into a summary as the prompt nears the context window. Every message stays in the transcript, and the model can look details up with recall_history. Slide and Truncate drop old context instead. Needs a known context length.';

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
    sel.appendChild(node);
  }
  // Retired values (summarize, dropMiddle, archive) show as Compact.
  sel.value =
    initial === INHERIT_CONTEXT_POLICY && options?.allowInherit
      ? INHERIT_CONTEXT_POLICY
      : normalizeContextEnforcementPolicy(initial) ?? 'compact';
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
  initial: ContextEnforcementPolicy | null | undefined,
): HTMLSelectElement {
  return buildContextPolicySelect(initial ?? 'compact');
}

// ── Compaction knobs ─────────────────────────────────────────────────────────

/** What the runner uses when a knob is blank (server/runner/compaction/index.js). */
const COMPACTION_KNOB_DEFAULTS = { highWaterPct: 80, lowWaterPct: 50, minRecentTurns: 2 } as const;

function buildKnobInput(
  value: number | undefined,
  bounds: { min: number; max: number },
  placeholder: string,
  ariaLabel: string,
  suffix: string,
): { wrap: HTMLElement; input: HTMLInputElement } {
  const wrap = el('span', 'settings-kv-input-wrap');
  const input = document.createElement('input');
  input.type = 'number';
  input.className = 'settings-select settings-kv-input';
  input.min = String(bounds.min);
  input.max = String(bounds.max);
  input.step = '1';
  input.placeholder = placeholder;
  input.setAttribute('aria-label', ariaLabel);
  if (value != null && Number.isFinite(value)) input.value = String(value);
  wrap.appendChild(input);
  wrap.appendChild(el('span', 'settings-kv-suffix', suffix));
  return { wrap, input };
}

function readKnob(input: HTMLInputElement): number | undefined {
  if (!input.value.trim()) return undefined;
  const n = Number(input.value);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Knobs for the Compact policy: when compaction starts (high water), what it
 * aims for (low water), whole turns kept verbatim, and the summary budget.
 * Blank fields use the shipped defaults; `onSave` gets null when every field is blank.
 */
export function mountCompactionKnobs(
  container: HTMLElement,
  initial: ContextCompactionDefaults | null | undefined,
  onSave: (knobs: ContextCompactionDefaults | null) => Promise<boolean>,
): HTMLElement {
  const root = el('details', 'settings-compaction-knobs');
  const summary = document.createElement('summary');
  summary.className = 'settings-compaction-knobs__summary';
  summary.textContent = 'Compaction tuning';
  root.appendChild(summary);
  root.appendChild(
    el(
      'p',
      'settings-field-hint',
      'Applies to every agent that uses Compact. Leave a field blank for the default. A wider gap between the start and the target means fewer, larger compactions, so the prompt prefix and the model cache stay the same for longer.',
    ),
  );

  const pct = (share: number | undefined) => (share != null ? Math.round(share * 100) : undefined);
  const high = buildKnobInput(pct(initial?.highWater), { min: 30, max: 98 }, String(COMPACTION_KNOB_DEFAULTS.highWaterPct), 'Start compacting at this percent of the window', '%');
  const low = buildKnobInput(pct(initial?.lowWater), { min: 10, max: 93 }, String(COMPACTION_KNOB_DEFAULTS.lowWaterPct), 'Compact down to this percent of the window', '%');
  const recent = buildKnobInput(initial?.minRecentTurns, { min: 1, max: 50 }, String(COMPACTION_KNOB_DEFAULTS.minRecentTurns), 'Recent turns kept word for word', 'turns');
  const budget = buildKnobInput(initial?.summaryBudgetTokens, { min: 200, max: 32000 }, 'auto', 'Summary budget in tokens', 'tokens');

  root.appendChild(
    createSettingsKvList([
      { term: 'Start at', value: high.wrap },
      { term: 'Compact down to', value: low.wrap },
      { term: 'Recent turns kept word for word', value: recent.wrap },
      { term: 'Summary budget', value: budget.wrap },
    ]),
  );
  root.appendChild(
    el('p', 'settings-field-hint', 'Percentages are of the context window. Auto summary budget: 12% of the window, at most 6k tokens.'),
  );

  root.appendChild(
    createSettingsActionsRow([
      {
        label: 'Save compaction tuning',
        onClick: () => {
          void (async () => {
            const highPct = readKnob(high.input);
            const lowPct = readKnob(low.input);
            const effectiveHigh = highPct ?? COMPACTION_KNOB_DEFAULTS.highWaterPct;
            const effectiveLow = lowPct ?? COMPACTION_KNOB_DEFAULTS.lowWaterPct;
            if (effectiveLow > effectiveHigh - 5) {
              setStatus('err', 'Compact down to must be at least 5 points below Start at');
              return;
            }
            const knobs: ContextCompactionDefaults = {};
            if (highPct != null) knobs.highWater = highPct / 100;
            if (lowPct != null) knobs.lowWater = lowPct / 100;
            const recentTurns = readKnob(recent.input);
            if (recentTurns != null) knobs.minRecentTurns = Math.floor(recentTurns);
            const budgetTokens = readKnob(budget.input);
            if (budgetTokens != null) knobs.summaryBudgetTokens = Math.floor(budgetTokens);
            const ok = await onSave(Object.keys(knobs).length ? knobs : null);
            setStatus(ok ? 'ok' : 'err', ok ? 'Compaction tuning saved' : 'Could not save. Open or restart Minnow and try again.');
          })();
        },
      },
    ]),
  );
  container.appendChild(root);
  return root;
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
  /** Optional type chip in expandable list headers. */
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

  const policyHint = el('p', 'settings-field-hint', CONTEXT_POLICY_HINT);

  const { row: disabledRow, input: disabledCb } = createSettingsToggleRow('Disabled', {
    checked: !!options.initialDisabled,
  });

  container.appendChild(
    createSettingsSelectRow('Context policy', { select: contextPolicySel }).row,
  );
  container.appendChild(policyHint);
  container.appendChild(disabledRow);

  container.appendChild(
    createSettingsActionsRow([
      {
        label: 'Save agent settings',
        onClick: () => {
          void (async () => {
            const agent = await patchWorkAgentOverride(options.agentId, {
              disabled: disabledCb.checked,
              contextEnforcementPolicy: contextPolicyFromSelect(contextPolicySel),
            });
            if (!agent) {
              setStatus('err', 'Could not save work agent settings');
              return;
            }
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


import '../styles/model-routing-form.css';
import { iconHtml, type IconName } from './icon';
import { loadModelChoices, type ModelChoice } from '../models/model-choices';
import { decodeModelSelectKey, encodeModelSelectKey } from '../lib/model-select-key';
import { isKnownLocalProviderId } from '../providers/provider-host';
import { mountAuxiliaryModelSelectCombobox, syncAuxiliaryModelSelectCombobox, unmountAuxiliaryModelSelectCombobox } from './model-select-picker';
import { patchSubAgentUserOverrides, loadSubAgentConfig, setRuntimeSubAgentOverrides } from '../agents/sub-agent-config';
import { resetUtilityModelConfigCache } from '../config/utility-model-meta';
import { resetGoalEvalConfigCache } from '../config/goal-eval-meta';
import { resetEditorAiCompletionConfigCache, EDITOR_AI_CONFIG_CHANGED_EVENT } from '../config/editor-ai-completion';

interface RoutingRow { label: string; icon?: IconName; description?: string; value: string; saved: string; kind: string; typeId?: string; select?: HTMLSelectElement }
export interface RoutingForm { ready: Promise<void>; commit: () => Promise<void>; dispose: () => void }

export function fillModelChoices(select: HTMLSelectElement, choices: ModelChoice[], selected: string, emptyLabel: string): void {
  const option = (label: string, value: string) => { const node = select.ownerDocument.createElement('option'); node.textContent = label; node.value = value; return node; };
  const inherit = option(emptyLabel, ''); inherit.dataset.modelSelectReset = 'true';
  select.replaceChildren(inherit);
  const groups = new Map<string, HTMLOptGroupElement>();
  for (const choice of choices) {
    let group = groups.get(choice.group);
    if (!group) { group = document.createElement('optgroup'); group.label = choice.group; groups.set(choice.group, group); select.append(group); }
    const model = option(choice.label, choice.value);
    const providerId = decodeModelSelectKey(choice.value)?.providerId || '';
    model.dataset.providerId = providerId; model.dataset.providerLabel = choice.group;
    model.dataset.providerHost = choice.host ?? (isKnownLocalProviderId(providerId) ? 'local' : 'cloud');
    group.append(model);
  }
  if (selected && !choices.some((choice) => choice.value === selected)) select.append(option(`${decodeModelSelectKey(selected)?.modelId || selected} (unavailable)`, selected));
  select.value = selected;
}

/** Independent mounts share config APIs, not singleton Settings DOM. */
export function mountRoutingForm(host: HTMLElement, options: { autosave?: boolean; onReady?: () => void; layout?: 'page' | 'compact' } = {}): RoutingForm {
  const abort = new AbortController();
  let handle: RoutingForm;
  const rows: RoutingRow[] = [
    { label: 'Sub-agents', icon: 'appAgentActivity', description: 'Delegated work', kind: 'subagents', value: '', saved: '' },
    { label: 'Utility tasks', icon: 'sparkles', description: 'Titles & prompts', kind: 'utilityModel', value: '', saved: '' },
    { label: 'Editor assistance', icon: 'appCode', description: 'Completions & edits', kind: 'editorAiCompletion', value: '', saved: '' },
    { label: 'Goal evaluation', icon: 'loop', description: 'Progress checks', kind: 'goalEval', value: '', saved: '' },
  ];
  let pending = Promise.resolve();
  const status = document.createElement('p'); status.className = 'model-routing-form__status'; status.setAttribute('role', 'status'); status.textContent = 'Loading routing…';
  const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'model-routing-form__retry'; retry.textContent = 'Retry saving'; retry.hidden = true;
  host.classList.add('model-routing-form');
  host.classList.toggle('model-routing-form--page', options.layout === 'page');
  host.setAttribute('aria-busy', 'true');
  const advanced = document.createElement('details'); advanced.className = 'model-routing-form__advanced'; advanced.inert = true;
  const summary = document.createElement('summary'); summary.innerHTML = `${iconHtml('settings', { size: 14 })}<span>Advanced sub-agent routing</span>${iconHtml('chevronRight', { size: 12, className: 'model-routing-form__advanced-arrow' })}`; advanced.append(summary);
  const basicCount = rows.length;
  const pageDescriptions: Record<string, string> = {
    subagents: 'Delegated work inherits the parent chat model unless you choose an override.',
    utilityModel: 'Generate titles, expand prompts and issues, and write commit messages.',
    editorAiCompletion: 'Power inline completions, quick edits, and editor assistance.',
    goalEval: 'Check progress and decide whether a goal needs another iteration.',
  };
  if (options.layout === 'page') {
    const columns = document.createElement('div'); columns.className = 'model-routing-form__columns'; columns.setAttribute('aria-hidden', 'true');
    columns.innerHTML = '<span>Task</span><span>Assigned model</span>';
    host.append(columns);
    const hint = document.createElement('p'); hint.className = 'model-routing-form__advanced-hint';
    hint.textContent = 'Set a model for an individual agent type. These choices take precedence over the general Sub-agents setting above.';
    advanced.append(hint);
  }
  const renderRow = (row: RoutingRow, index: number): void => {
    const label = document.createElement('label'); label.className = 'model-routing-form__row';
    const text = document.createElement('span'); text.className = 'model-routing-form__label';
    const icon = document.createElement('span'); icon.className = 'model-routing-form__icon'; icon.innerHTML = iconHtml(row.icon || 'appAgentActivity', { size: options.layout === 'page' && index < basicCount ? 20 : 16 });
    const copy = document.createElement('span'); copy.className = 'model-routing-form__copy';
    const name = document.createElement('span'); name.textContent = row.label; copy.append(name);
    const descriptionText = options.layout === 'page' ? pageDescriptions[row.kind] || row.description : row.description;
    if (descriptionText) { const description = document.createElement('small'); description.textContent = descriptionText; copy.append(description); }
    text.append(icon, copy);
    const select = document.createElement('select'); select.setAttribute('aria-label', `${row.label} model`); row.select = select;
    select.disabled = true;
    const loading = document.createElement('option'); loading.textContent = 'Loading…'; select.append(loading);
    label.append(text, select); (index < basicCount ? host : advanced).append(label);
    mountAuxiliaryModelSelectCombobox(select, { searchable: true });
    select.onchange = () => {
      row.value = select.value;
      if (options.autosave) { pending = pending.catch(() => {}).then(commit); void pending.catch(() => {}); }
    };
  };
  rows.forEach(renderRow);
  host.append(advanced, status, retry);
  const valueOf = (block?: { providerId?: string; modelId?: string } | null) => block?.modelId ? encodeModelSelectKey(block.providerId || '', block.modelId) : '';
  const commit = async (): Promise<void> => {
    await ready;
    const dirty = rows.filter((row) => row.value !== row.saved).map((row) => ({ row, value: row.value }));
    if (!dirty.length) return;
    status.textContent = 'Saving routing…'; status.dataset.state = 'saving'; retry.hidden = true;
    try {
      for (const { row, value } of dirty) {
        const binding = decodeModelSelectKey(value);
        if (value && !binding) throw new Error('Choose a provider and model');
        if (row.kind === 'subagents' || row.kind === 'type') {
          const patch = row.kind === 'subagents'
            ? { defaultModel: binding }
            : { types: { [row.typeId!]: { providerId: binding?.providerId || '', modelId: binding?.modelId || '' } } };
          if (!await patchSubAgentUserOverrides(patch)) throw new Error('Could not save sub-agent routing');
        } else {
          const block = { providerId: binding?.providerId || '', modelId: binding?.modelId || '', ...(row.kind === 'editorAiCompletion' ? { useChatModel: !binding } : {}) };
          const response = await fetch('/api/config/meta', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ [row.kind]: block }) });
          if (!response.ok) throw new Error('Could not save model routing');
          resetUtilityModelConfigCache(); resetGoalEvalConfigCache(); resetEditorAiCompletionConfigCache();
          window.dispatchEvent(new window.Event(EDITOR_AI_CONFIG_CHANGED_EVENT));
        }
        row.saved = value;
      }
      if (!abort.signal.aborted) { status.textContent = 'Routing saved'; status.dataset.state = 'saved'; }
    } catch (error) {
      if (!abort.signal.aborted) { status.textContent = error instanceof Error ? error.message : 'Could not save routing'; status.dataset.state = 'error'; retry.hidden = false; }
      throw error;
    }
  };
  retry.onclick = () => { pending = pending.catch(() => {}).then(commit); void pending.catch(() => {}); };
  const ready = (async () => {
    const [metaResponse, choices, subResponse] = await Promise.all([fetch('/api/config/meta', { signal: abort.signal }), loadModelChoices(abort.signal), fetch('/api/config/sub-agents', { signal: abort.signal })]);
    if (!metaResponse.ok) throw new Error('Could not load model routing');
    if (!subResponse.ok) throw new Error('Could not load sub-agent routing');
    const fresh = await subResponse.json();
    if (abort.signal.aborted) return;
    setRuntimeSubAgentOverrides(fresh);
    const config = await loadSubAgentConfig();
    const meta = await metaResponse.json();
    if (abort.signal.aborted) return;
    for (const row of rows) row.value = row.kind === 'subagents' ? valueOf(config.defaultModel)
      : row.kind === 'editorAiCompletion' && meta.editorAiCompletion?.useChatModel !== false ? '' : valueOf(meta[row.kind]);
    for (const [typeId, type] of Object.entries(config.types)) rows.push({ label: type.label || typeId, kind: 'type', typeId, value: valueOf(type), saved: '' });
    rows.forEach((row, index) => {
      row.saved = row.value;
      if (!row.select) renderRow(row, index);
      const select = row.select!;
      fillModelChoices(select, choices, row.value, row.kind === 'type' ? 'Use sub-agent routing' : row.kind === 'subagents' ? 'Follow parent chat' : row.kind === 'utilityModel' ? 'Follow originating task' : 'Follow chat');
      select.disabled = false;
      syncAuxiliaryModelSelectCombobox(select);
    });
    advanced.inert = false; host.setAttribute('aria-busy', 'false');
    status.textContent = options.autosave ? 'Changes save automatically' : 'Settings apply across projects. Chat models are selected in the composer.'; status.dataset.state = 'idle';
    options.onReady?.();
  })().catch((error) => {
    if (!abort.signal.aborted) {
      host.setAttribute('aria-busy', 'false');
      status.textContent = error instanceof Error ? error.message : 'Could not load routing'; status.dataset.state = 'error';
      retry.hidden = false; retry.textContent = 'Reload routing';
      retry.onclick = () => { handle.dispose(); host.replaceChildren(); Object.assign(handle, mountRoutingForm(host, options)); };
    }
    throw error;
  });
  void ready.catch(() => {});
  handle = { ready, commit: async () => { await pending; await commit(); }, dispose: () => { abort.abort(); for (const row of rows) if (row.select) unmountAuxiliaryModelSelectCombobox(row.select); } };
  return handle;
}

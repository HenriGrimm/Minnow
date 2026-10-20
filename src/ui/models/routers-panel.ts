import { randomUUID } from '../../lib/random-id';
import '../../styles/model-routers.css';
import { formatModelLabel } from '../../lib/format-model-label';
import { decodeModelSelectKey, encodeModelSelectKey } from '../../lib/model-select-key';
import {
  fetchLibraryModelSelectMerge,
  LIBRARY_MODEL_PROVIDER_ID,
  libraryModelLoadState,
} from '../../models/model-select-library';
import {
  loadRouterConfig,
  remapRouterEntriesToLibrary,
  routerApi,
  routerEntryModelLabel,
  routerEntryProviderLabel,
  saveRouterConfig,
  type ModelRouter,
  type RouterActivity,
  type RouterConfig,
  type RouterEntry,
} from '../../models/routers';
import { fetchModelsForAllProviders } from '../../providers/fetch-all-models';
import { formatRouterTierLabel, guessRouterTier, isDecisionModelId, ROUTER_TIERS } from '../../models/router-tiers.mjs';
import { formatRouterTaskTypeLabel } from '../../models/router-task-types.mjs';
import { listProviders } from '../../providers/store';
import { sessionState as state } from '../../state/sessions';
import { listFillProviderOptions } from '../settings-model-binding';
import { mountAuxiliaryModelSelectCombobox, unmountAuxiliaryModelSelectCombobox } from '../model-select-picker';
import { closePoolTaskTypeChoices, createPoolEntry, poolStrategyChoices, poolTaskTypeChoices } from '../model-pool-fields';
import { iconHtml } from '../icon';
import { openContextMenu, type ContextMenuHandle } from '../context-menu';

function node<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = ''): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag); el.textContent = text; el.className = className; return el;
}
function button(text: string, action: () => void): HTMLButtonElement {
  const el = node('button', text); el.type = 'button'; el.addEventListener('click', action); return el;
}
function field(text: string, control: HTMLElement): HTMLLabelElement { const el = node('label', text); el.append(control); return el; }

/** Keep a persisted id selectable even when it dropped out of the live catalog. */
function ensureSelectValue(select: HTMLSelectElement, value: string, missingLabel: string): void {
  if (value && ![...select.options].some((option) => option.value === value)) {
    select.append(new Option(`${missingLabel} (unavailable)`, value));
  }
  select.value = value;
}

let dispose: (() => void) | undefined;

export async function mountRoutersPanel(): Promise<void> {
  dispose?.();
  const host = document.getElementById('modelsSection-routers');
  if (!host) return;
  host.replaceChildren(node('p', 'Loading model pools…'));
  let alive = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  dispose = () => {
    alive = false;
    if (timer) clearTimeout(timer);
    if (saveTimer) clearTimeout(saveTimer);
  };
  try {
    let config: RouterConfig = structuredClone(await loadRouterConfig());
    if (!alive) return;
    const { providers } = await listProviders();
    const providerChoices = listFillProviderOptions(providers, {
      includeLibraryProvider: true,
      omitLocalRuntimeProviders: true,
      libraryProviderFirst: true,
    });
    const catalogs = await fetchModelsForAllProviders(providers.filter((p) => p.enabled), new AbortController().signal);
    const libraryMerge = await fetchLibraryModelSelectMerge().catch(() => null);
    const library = libraryMerge?.library ?? [];
    if (!alive) return;
    let remapped = false;
    for (const router of config.routers) {
      if (remapRouterEntriesToLibrary(router.entries, library)) remapped = true;
    }
    let selected = config.routers[0]?.id || '';
    let dirty = false;
    let saving = false;
    let adding = false;
    let searchQuery = '';
    let draggedEntry = '';
    let entryMenu: ContextMenuHandle | undefined;
    const releasePickers = (container: HTMLElement): void => {
      container.querySelectorAll<HTMLSelectElement>('.model-select-native').forEach(unmountAuxiliaryModelSelectCombobox);
    };
    const previousDispose = dispose;
    dispose = () => { previousDispose?.(); releasePickers(root); closePoolTaskTypeChoices(root); entryMenu?.close(); };
    /** Bumped on every edit so a save that lands mid-edit cannot clobber it. */
    let revision = 0;
    const root = node('div', '', 'router-panel');
    const bar = node('div', '', 'router-toolbar');
    const picker = node('select'); picker.setAttribute('aria-label', 'Model pool');
    const message = node('p', '', 'router-message'); message.setAttribute('role', 'status');
    const retry = button('Retry save', () => { void commit(); }); retry.hidden = true;
    const editor = node('div', '', 'router-editor');
    const live = node('div', '', 'router-live');
    let liveEpoch = 0;
    /** Edits save themselves: coalesce for a moment, then persist. */
    const markDirty = (): void => {
      dirty = true;
      revision += 1;
      message.textContent = 'Unsaved changes';
      retry.hidden = true;
      scheduleSave();
    };
    const scheduleSave = (): void => {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => { saveTimer = undefined; void commit(); }, 400);
    };
    const syncPickerLabels = (): void => {
      [...picker.options].forEach((option, index) => {
        const router = config.routers[index];
        if (router) option.text = router.name;
      });
    };
    /**
     * Copy server-normalized values onto the live objects the editor holds.
     * Replacing `config` wholesale would leave every open input handler
     * mutating an orphaned router.
     */
    const applySavedConfig = (saved: RouterConfig): void => {
      config.revision = saved.revision;
      config.defaultRouterId = saved.defaultRouterId;
      const savedRouters = new Map(saved.routers.map((r) => [r.id, r]));
      for (const router of [...config.routers]) {
        const savedRouter = savedRouters.get(router.id);
        if (!savedRouter) {
          config.routers = config.routers.filter((r) => r !== router);
          continue;
        }
        router.name = savedRouter.name;
        router.enabled = savedRouter.enabled;
        router.policy = savedRouter.policy;
        router.evaluator = savedRouter.evaluator;
        const savedEntries = new Map(savedRouter.entries.map((e) => [e.id, e]));
        for (const entry of [...router.entries]) {
          const savedEntry = savedEntries.get(entry.id);
          if (!savedEntry) {
            router.entries = router.entries.filter((e) => e !== entry);
            continue;
          }
          entry.providerId = savedEntry.providerId;
          entry.modelId = savedEntry.modelId;
          entry.enabled = savedEntry.enabled;
          entry.concurrencyLimit = savedEntry.concurrencyLimit;
          entry.tier = savedEntry.tier;
          entry.taskTypes = savedEntry.taskTypes;
        }
      }
    };
    if (remapped) markDirty();
    async function commit(): Promise<void> {
      if (saving) { scheduleSave(); return; }
      const target = revision;
      if (config.routers.some((router) => !router.name.trim())) {
        message.textContent = 'Give your pool a name to save changes.';
        return;
      }
      saving = true; root.setAttribute('aria-busy', 'true');
      try {
        const saved = await saveRouterConfig(structuredClone(config));
        config.revision = saved.revision;
        if (revision === target) {
          applySavedConfig(saved);
          dirty = false;
          message.textContent = 'Saved';
          syncPickerLabels();
        }
      } catch (error) { message.textContent = `Could not save: ${(error as Error).message}`; retry.hidden = false; }
      finally {
        saving = false; root.removeAttribute('aria-busy');
        if (revision !== target) scheduleSave();
      }
    }
    const current = (): ModelRouter | undefined => config.routers.find((r) => r.id === selected);
    picker.onchange = () => { selected = picker.value; adding = false; render(); };
    const heading = node('div', '', 'router-heading');
    heading.append(node('h2', 'Model pools'), node('p', 'Shared across projects. Choose how your models take on the work.'));
    const create = button('New model pool', () => {
      const router: ModelRouter = { id: randomUUID(), name: 'New model pool', enabled: true, policy: 'priority', entries: [] };
      config.routers.push(router); selected = router.id; adding = true; searchQuery = ''; markDirty(); render();
      editor.querySelector<HTMLInputElement>('[aria-label="Pool name"]')?.select();
    });
    create.className = 'router-primary';
    bar.append(heading, picker, create);
    const saveStatus = node('div', '', 'router-save-status'); saveStatus.append(message, retry);
    root.append(bar, saveStatus, editor, live); host.replaceChildren(root);

    type ModelChoice = { providerId: string; modelId: string; label: string; providerLabel: string; detail: string };
    const choices: ModelChoice[] = providerChoices.flatMap((provider) => {
      if (provider.id === LIBRARY_MODEL_PROVIDER_ID) return library.map((model) => ({
        providerId: provider.id, modelId: model.id, providerLabel: provider.label,
        label: routerEntryModelLabel({ providerId: provider.id, modelId: model.id } as RouterEntry, library),
        detail: libraryModelLoadState(model, libraryMerge?.serves ?? []) || 'Loads when needed',
      }));
      return (catalogs.find((catalog) => catalog.provider.id === provider.id)?.models || [])
        .filter((model) => model.type === 'llm' || model.type === 'vlm' || !model.type || isDecisionModelId(model.id))
        .map((model) => ({ providerId: provider.id, modelId: model.id, providerLabel: provider.label,
          label: formatModelLabel({ id: model.id, quantization: model.quantization }).optionText,
          detail: isDecisionModelId(model.id) ? 'Task evaluator' : formatRouterTierLabel(guessRouterTier(model.id)),
        }));
    });
    const key = (binding: { providerId: string; modelId: string }): string => encodeModelSelectKey(binding.providerId, binding.modelId);

    function modelPicker(label: string, binding: { providerId: string; modelId: string } | undefined,
      available: ModelChoice[], onPick: (binding: { providerId: string; modelId: string } | null) => void,
      emptyLabel?: string, includeProvider = true): HTMLElement {
      const wrap = node('div', '', 'router-model-picker');
      const select = node('select'); select.setAttribute('aria-label', label);
      if (emptyLabel) {
        const reset = new Option(emptyLabel, ''); reset.dataset.modelSelectReset = 'true'; select.append(reset);
      }
      for (const provider of providerChoices) {
        const group = node('optgroup'); group.label = provider.label;
        for (const model of available.filter((choice) => choice.providerId === provider.id)) {
          const option = new Option(includeProvider ? `${model.label} · ${model.providerLabel}` : model.label, key(model));
          option.dataset.providerId = model.providerId;
          option.dataset.providerLabel = model.providerLabel;
          option.dataset.modelLabel = model.label;
          option.title = `${model.label} · ${model.providerLabel} · ${model.detail}`;
          group.append(option);
        }
        if (group.children.length) select.append(group);
      }
      ensureSelectValue(select, binding ? key(binding) : '', binding ? `${binding.modelId} · ${binding.providerId}` : '');
      select.onchange = () => onPick(decodeModelSelectKey(select.value));
      wrap.append(select);
      mountAuxiliaryModelSelectCombobox(select, { searchable: true });
      return wrap;
    }

    function evaluatorFields(router: ModelRouter): HTMLElement {
      const wrap = node('section', '', 'router-evaluator');
      const heading = node('div', '', 'router-section-heading');
      heading.append(node('h3', 'Who chooses the model?'), node('span', 'Task evaluator', 'router-caption'));
      const hint = node('p', router.evaluator
        ? isDecisionModelId(router.evaluator.modelId) ? 'This decision model chooses a task type, tier, and reasoning level when a chat starts.'
          : 'This model chooses once per chat. A small, fast model works well here.'
        : 'Choose an evaluator to pick a model for each new chat. Until then, the pool uses your model order.');
      wrap.append(heading, modelPicker('Task evaluator model', router.evaluator,
        choices.filter((choice) => choice.providerId !== LIBRARY_MODEL_PROVIDER_ID), (binding) => {
          if (binding) router.evaluator = binding; else delete router.evaluator;
          markDirty(); render();
          editor.querySelector<HTMLButtonElement>('.router-evaluator .model-select-trigger')?.focus();
        }, 'No evaluator (use model order)'), hint,
        node('p', 'Assign specialties below. Matching models come first; Any task models provide a fallback.', 'router-caption'));
      const custom = node('details', '', 'router-custom-evaluator');
      custom.append(node('summary', 'Use a model ID not listed here'));
      const fields = node('div', '', 'router-fields');
      const provider = node('select'); provider.setAttribute('aria-label', 'Custom evaluator provider');
      provider.append(new Option('Choose provider', ''), ...providerChoices
        .filter((choice) => choice.id !== LIBRARY_MODEL_PROVIDER_ID).map((choice) => new Option(choice.label, choice.id)));
      ensureSelectValue(provider, router.evaluator?.providerId || '', router.evaluator?.providerId || '');
      const model = node('input'); model.setAttribute('aria-label', 'Custom evaluator model ID');
      model.placeholder = 'typesafe/jev-1.13'; model.maxLength = 500; model.value = router.evaluator?.modelId || '';
      const apply = button('Use evaluator', () => {
        if (!provider.value || !model.value.trim()) { model.reportValidity(); return; }
        router.evaluator = { providerId: provider.value, modelId: model.value.trim() }; markDirty(); render();
      });
      model.required = true;
      fields.append(field('Provider', provider), field('Model ID', model), apply);
      custom.append(fields); wrap.append(custom);
      return wrap;
    }

    function renderModelBrowser(router: ModelRouter): HTMLElement {
      const browser = node('section', '', 'router-model-browser');
      browser.setAttribute('aria-label', 'Add models to pool');
      const heading = node('div', '', 'router-section-heading');
      heading.append(node('h3', 'Choose models to add'), button('Done', () => {
        adding = false; render(); editor.querySelector<HTMLButtonElement>('.router-add-models')?.focus();
      }));
      const search = node('input'); search.type = 'search'; search.placeholder = 'Search models or providers…';
      search.value = searchQuery; search.setAttribute('aria-label', 'Search available models');
      const results = node('div', '', 'router-browser-results');
      const count = node('p', '', 'router-caption'); count.setAttribute('role', 'status');
      const draw = (): void => {
        results.replaceChildren();
        const query = search.value.toLowerCase().trim();
        const matches = choices.filter((choice) => !isDecisionModelId(choice.modelId) &&
          `${choice.label} ${choice.providerLabel}`.toLowerCase().includes(query));
        count.textContent = `${matches.length} model${matches.length === 1 ? '' : 's'} available · ${router.entries.length} in this pool`;
        for (const provider of providerChoices) {
          const group = matches.filter((choice) => choice.providerId === provider.id);
          if (!group.length) continue;
          results.append(node('h4', provider.label));
          for (const choice of group) {
            const included = router.entries.some((entry) => key(entry) === key(choice));
            const add = button('', () => {
              router.entries.push(createPoolEntry({ providerId: choice.providerId, modelId: choice.modelId }));
              markDirty(); render();
              const refreshed = editor.querySelector<HTMLInputElement>('[aria-label="Search available models"]');
              refreshed?.focus(); refreshed?.setSelectionRange(searchQuery.length, searchQuery.length);
            });
            add.className = 'router-browser-model'; add.disabled = included;
            add.setAttribute('aria-label', `${included ? 'Included' : 'Add'} ${choice.label} from ${choice.providerLabel}`);
            const identity = node('span', '', 'router-browser-identity');
            identity.append(node('strong', choice.label), node('span', choice.detail, 'router-caption'));
            add.append(identity, node('span', included ? '✓ Added' : '+ Add', 'router-browser-action'));
            results.append(add);
          }
        }
        if (!matches.length) results.append(node('p', choices.length
          ? 'No models match this search. Try a different model or provider name.'
          : 'No models are available yet. Download one in My Models or connect a provider in Models → Providers.'));
        for (const catalog of catalogs.filter((catalog) => catalog.error && providerChoices.some((choice) => choice.id === catalog.provider.id))) {
          results.append(node('p', `${catalog.provider.label}: could not load models. Check the provider connection.`, 'router-caption'));
        }
      };
      search.oninput = () => { searchQuery = search.value; draw(); };
      draw(); browser.append(heading, search, count, results);
      return browser;
    }

    function render(): void {
      closePoolTaskTypeChoices(editor); entryMenu?.close(); entryMenu = undefined;
      liveEpoch++;
      releasePickers(editor); releasePickers(live);
      picker.replaceChildren(...config.routers.map((router) => new Option(router.name, router.id)));
      picker.value = selected; picker.disabled = !config.routers.length;
      editor.replaceChildren(); live.replaceChildren();
      const router = current();
      if (!router) {
        const empty = node('div', '', 'router-empty');
        empty.append(node('h3', 'A shared model lineup'),
          node('p', 'Pool local and connected models, arrange your favorites, and let chats share their capacity.'),
          button('Create your first pool', () => create.click()));
        editor.append(empty); return;
      }
      const header = node('div', '', 'router-pool-header router-fields');
      const name = node('input'); name.value = router.name; name.maxLength = 100;
      name.className = 'router-pool-name'; name.setAttribute('aria-label', 'Pool name');
      name.oninput = () => { router.name = name.value; syncPickerLabels(); markDirty(); };
      const enabled = button(router.enabled ? 'Pool active' : 'Pool paused', () => {
        router.enabled = !router.enabled;
        if (!router.enabled && config.defaultRouterId === router.id) config.defaultRouterId = null;
        markDirty(); render(); editor.querySelector<HTMLButtonElement>('.router-pool-enabled')?.focus();
      });
      enabled.className = 'router-pool-enabled router-toggle'; enabled.setAttribute('aria-pressed', String(router.enabled));
      header.append(name, enabled); editor.append(header);

      const routing = node('section', '', 'router-routing');
      routing.append(node('h3', 'How should this pool choose?'));
      const modes = poolStrategyChoices(router.policy, (policy) => {
        router.policy = policy; markDirty(); render();
        editor.querySelector<HTMLButtonElement>(`[data-policy="${policy}"]`)?.focus();
      });
      routing.append(modes); editor.append(routing);
      const auto = router.policy === 'evaluate';
      if (auto) editor.append(evaluatorFields(router));

      const lineup = node('section', '', 'router-lineup');
      const title = node('div', '', 'router-section-heading');
      const label = node('div'); label.append(node('h3', `Model lineup · ${router.entries.length}`), node('p', auto
        ? 'Match by tier and task. Drag models to set fallback order.'
        : 'Drag models to set their priority.'));
      const add = button(adding ? 'Choosing models…' : '+ Add models', () => {
        adding = !adding; render(); editor.querySelector<HTMLInputElement>('[aria-label="Search available models"]')?.focus();
      });
      add.className = 'router-add-models'; add.setAttribute('aria-expanded', String(adding));
      title.append(label, add); lineup.append(title);
      if (adding) lineup.append(renderModelBrowser(router));
      const list = node('ol', '', 'router-entry-list'); list.setAttribute('aria-label', 'Models in priority order');
      router.entries.forEach((entry, index) => {
        const row = node('li', '', entry.enabled ? 'router-entry' : 'router-entry is-paused'); row.dataset.entryId = entry.id;
        const moveTo = (target: number): void => {
          const from = router.entries.findIndex((item) => item.id === entry.id);
          if (target < 0 || target >= router.entries.length || from === target) return;
          router.entries.splice(from, 1); router.entries.splice(target, 0, entry);
          markDirty(); render(); editor.querySelector<HTMLButtonElement>(`[data-entry-id="${entry.id}"] .router-drag-handle`)?.focus();
          message.textContent = `Moved ${routerEntryModelLabel(entry, library)} to rank ${target + 1}. Saving…`;
        };
        const handle = button('⠿', () => {}); handle.className = 'router-drag-handle'; handle.draggable = true;
        handle.setAttribute('aria-label', `Reorder rank ${index + 1}`); handle.title = 'Drag to reorder, or press Alt + Arrow Up / Down';
        handle.ondragstart = (event) => {
          draggedEntry = entry.id; event.dataTransfer?.setData('text/plain', entry.id);
          if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'; row.classList.add('is-dragging');
        };
        handle.ondragend = () => { draggedEntry = ''; list.querySelectorAll('.is-drop-target, .is-dragging').forEach((item) => item.classList.remove('is-drop-target', 'is-dragging')); };
        row.ondragover = (event) => { if (draggedEntry && draggedEntry !== entry.id) { event.preventDefault(); row.classList.add('is-drop-target'); } };
        row.ondragleave = () => row.classList.remove('is-drop-target');
        row.ondrop = (event) => {
          event.preventDefault(); const from = router.entries.findIndex((item) => item.id === draggedEntry);
          if (from < 0 || from === index) return;
          const moved = router.entries.splice(from, 1)[0]; router.entries.splice(index, 0, moved);
          draggedEntry = ''; markDirty(); render();
          editor.querySelector<HTMLButtonElement>(`[data-entry-id="${moved.id}"] .router-drag-handle`)?.focus();
        };
        row.onkeydown = (event) => { if (event.altKey && ['ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); moveTo(index + (event.key === 'ArrowUp' ? -1 : 1)); } };
        const head = node('div', '', 'router-entry-header');
        const rank = node('div', '', 'router-entry-rank'); rank.append(handle, node('span', String(index + 1).padStart(2, '0'), 'router-rank'));
        const identity = node('div', '', 'router-entry-identity');
        const alternatives = choices.filter((choice) => !isDecisionModelId(choice.modelId) &&
          !router.entries.some((other) => other !== entry && key(other) === key(choice)));
        identity.append(modelPicker(`Model for rank ${index + 1}`, entry, alternatives, (binding) => {
          if (!binding || router.entries.some((other) => other !== entry && key(other) === key(binding))) return;
          entry.providerId = binding.providerId; entry.modelId = binding.modelId; markDirty(); render();
          editor.querySelector<HTMLButtonElement>(`[data-entry-id="${entry.id}"] .model-select-trigger`)?.focus();
        }, undefined, false), node('span', `${routerEntryProviderLabel(entry, providerChoices)}${entry.providerId === LIBRARY_MODEL_PROVIDER_ID ? ' · Loads when needed' : ''}`, 'router-caption'));
        const slots = node('input'); slots.type = 'number'; slots.min = '1'; slots.max = '100'; slots.step = '1'; slots.value = String(entry.concurrencyLimit);
        slots.setAttribute('aria-label', `Concurrent slots for rank ${index + 1}`);
        slots.oninput = () => {
          const limit = Number(slots.value);
          if (!Number.isInteger(limit) || limit < 1 || limit > 100) return;
          entry.concurrencyLimit = limit; markDirty();
        };
        slots.onchange = () => { if (!slots.checkValidity()) slots.reportValidity(); };
        const sharedLimit = Math.min(...config.routers.filter((pool) => pool.enabled).flatMap((pool) => pool.entries.filter((candidate) => candidate.enabled && key(candidate) === key(entry)).map((candidate) => candidate.concurrencyLimit)), entry.concurrencyLimit);
        const capacity = field('Slots', slots); capacity.className = 'router-entry-slots';
        capacity.title = `Simultaneous generations, shared across projects and pools. Current shared limit: ${sharedLimit}.`;
        if (sharedLimit < entry.concurrencyLimit) capacity.append(node('small', `Shared: ${sharedLimit}`));
        const pause = button(entry.enabled ? 'Enabled' : 'Paused', () => {
          entry.enabled = !entry.enabled; markDirty(); render(); editor.querySelector<HTMLButtonElement>(`[data-entry-id="${entry.id}"] .router-entry-toggle`)?.focus();
        });
        pause.className = 'router-entry-toggle router-toggle'; pause.setAttribute('aria-pressed', String(entry.enabled));
        const actions = node('div', '', 'router-entry-actions');
        const menu = button('', () => {
          entryMenu = openContextMenu({ anchor: menu, restoreFocus: menu, label: `Actions for rank ${index + 1}`, items: [
            { id: 'up', label: 'Move up', disabled: index === 0, onSelect: () => moveTo(index - 1) },
            { id: 'down', label: 'Move down', disabled: index === router.entries.length - 1, onSelect: () => moveTo(index + 1) },
            { kind: 'separator' },
            { id: 'remove', label: 'Remove from pool', onSelect: () => { router.entries.splice(index, 1); markDirty(); render(); editor.querySelector<HTMLButtonElement>('.router-add-models')?.focus(); } },
          ] });
        });
        menu.className = 'router-entry-menu'; menu.innerHTML = iconHtml('more', { size: 16 });
        menu.setAttribute('aria-label', `Actions for rank ${index + 1}`); menu.setAttribute('aria-haspopup', 'menu');
        actions.append(pause, menu); head.append(rank, identity, actions); row.append(head);
        const matching = node('div', '', 'router-entry-routing');
        if (auto) {
          const tier = node('select'); tier.setAttribute('aria-label', `Tier for rank ${index + 1}`);
          tier.append(new Option(`Auto: ${formatRouterTierLabel(guessRouterTier(routerEntryModelLabel(entry, library)))}`, ''),
            ...ROUTER_TIERS.map((value) => new Option(formatRouterTierLabel(value), value)));
          tier.value = entry.tier || '';
          tier.onchange = () => { if (tier.value) entry.tier = tier.value as RouterEntry['tier']; else delete entry.tier; markDirty(); };
          const tierField = field('Tier', tier); tierField.className = 'router-entry-tier';
          matching.append(tierField, poolTaskTypeChoices(entry, `rank ${index + 1}`, markDirty));
        }
        matching.append(capacity); row.append(matching);
        list.append(row);
      });
      lineup.append(list);
      if (!router.entries.length) {
        const empty = node('div', '', 'router-lineup-empty');
        empty.append(node('strong', 'Start with a model you trust'), node('p', 'Add local or connected models. You can mix providers and change the order anytime.'));
        lineup.append(empty);
      }
      if (router.entries.length && !router.entries.some((entry) => entry.enabled)) lineup.append(node('p', 'All models are paused. Activate a model so this pool can answer requests.', 'router-warning'));
      lineup.append(node('p', auto
        ? 'Choices stay with the chat. Use Re-evaluate in its model menu to choose again.'
        : 'Chats keep their assigned model. If it fails, another model takes over.', 'router-caption router-lineup-note'));
      editor.append(lineup);
      const footer = node('div', '', 'router-pool-footer');
      footer.append(node('span', 'Changes save automatically across projects.', 'router-caption'));
      const remove = button('Delete pool', () => {
        const actions = node('div', '', 'router-pool-actions');
        const cancel = button('Cancel', () => { render(); editor.querySelector<HTMLButtonElement>('.router-pool-delete')?.focus(); });
        const confirm = button('Delete pool permanently', () => {
          config.routers = config.routers.filter((item) => item !== router);
          if (config.defaultRouterId === router.id) config.defaultRouterId = null;
          selected = config.routers[0]?.id || ''; adding = false; markDirty(); render();
        });
        confirm.className = 'router-delete-confirm';
        actions.setAttribute('role', 'group'); actions.setAttribute('aria-label', 'Delete pool confirmation');
        actions.append(cancel, confirm);
        footer.replaceChildren(node('span', `Delete “${router.name}”? Models stay in your library.`, 'router-caption'), actions);
        cancel.focus();
      });
      remove.className = 'router-remove router-pool-delete'; footer.append(remove); editor.append(footer);
      void refresh();
    }

    async function refresh(): Promise<void> {
      const router = current();
      if (!router || !alive || !host?.classList.contains('is-active')) return;
      const epoch = liveEpoch;
      try {
        const activity = await routerApi<RouterActivity>(`/${router.id}/activity`);
        if (!alive || epoch !== liveEpoch || live.contains(document.activeElement) || dirty) return;
        drawActivity(router, activity);
      } catch (error) { if (!dirty && alive && epoch === liveEpoch) live.replaceChildren(node('p', (error as Error).message)); }
    }

    function drawActivity(router: ModelRouter, activity: RouterActivity): void {
      const graph = node('div', '', 'router-graph');
      const chats = node('div', '', 'router-chats'); chats.append(node('h3', 'Chat activity'));
      const models = node('div', '', 'router-nodes'); models.append(node('h3', 'Model capacity'));
      const rows = [...activity.assignments].sort((a, b) => Number(activity.requests.some((r) => r.chatId === b.chatId)) - Number(activity.requests.some((r) => r.chatId === a.chatId)));
      if (!rows.length) chats.append(node('p', 'No active or queued chats. Choose this model pool in the chat model picker to send a request.'));
      for (const assignment of rows) {
        const request = activity.requests.find((r) => r.chatId === assignment.chatId);
        const targetEntry = router.entries.find((e) => e.id === (request?.entryId || assignment.assignedEntryId));
        const row = node('div', '', 'router-chat'); row.dataset.target = targetEntry?.id || ''; row.dataset.status = request?.status || 'idle';
        const modelName = targetEntry ? routerEntryModelLabel(targetEntry, library) : 'Unavailable model';
        row.append(node('strong', state?.chats.find((c) => c.id === assignment.chatId)?.name || assignment.chatId), node('span', `${request?.status === 'queued' ? 'Queued · waiting for capacity' : request?.status === 'active' ? 'Generating' : 'Idle'} → ${modelName}`));
        const decision = activity.decisions?.find((d) => d.chatId === assignment.chatId);
        if (decision?.tier) {
          const judged = `${decision.taskType ? `${formatRouterTaskTypeLabel(decision.taskType)} · ` : ''}${formatRouterTierLabel(decision.tier)} · ${decision.effort || 'default'} reasoning · ${Math.round(decision.confidence * 100)}%`;
          const line = node('span', `Last judgment: ${judged}`); line.title = decision.reason; row.append(line);
        }
        const override = node('select'); override.setAttribute('aria-label', 'Persistent model override');
        override.title = 'Applies to the next generation. Choose model pool assignment to clear.';
        const reset = new Option('Model pool assignment', ''); reset.dataset.modelSelectReset = 'true';
        override.append(reset, ...router.entries.filter((e) => e.enabled).map((e) => {
          const option = new Option(`${routerEntryProviderLabel(e, providerChoices)} / ${routerEntryModelLabel(e, library)}`, e.id);
          option.dataset.providerId = e.providerId; option.dataset.providerLabel = routerEntryProviderLabel(e, providerChoices);
          option.dataset.modelId = e.modelId; option.dataset.modelLabel = routerEntryModelLabel(e, library);
          return option;
        }));
        override.value = assignment.overrideEntryId || '';
        override.onchange = () => { void routerApi(`/${router.id}/override`, { chatId: assignment.chatId, entryId: override.value || null }, 'POST').then(() => { override.blur(); void refresh(); }).catch((error) => { message.textContent = error.message; }); };
        row.append(override); chats.append(row); mountAuxiliaryModelSelectCombobox(override, { searchable: true });
      }
      for (const [index, entry] of router.entries.entries()) {
        const activityEntry = activity.entries.find((e) => e.entryId === entry.id);
        const card = node('div', '', 'router-node'); card.dataset.node = entry.id;
        const inspect = button(`${index + 1}. ${routerEntryModelLabel(entry, library)}`, () => {
          if (typeof detail.togglePopover === 'function') {
            const bounds = inspect.getBoundingClientRect();
            detail.style.left = `${Math.max(16, Math.min(bounds.left, window.innerWidth - 396))}px`;
            detail.style.top = `${Math.max(16, Math.min(bounds.bottom + 8, window.innerHeight - 200))}px`;
            detail.togglePopover();
          } else {
            detail.hidden = !detail.hidden;
            inspect.setAttribute('aria-expanded', String(!detail.hidden));
          }
        });
        inspect.setAttribute('aria-expanded', 'false');
        const detail = node('div', '', 'router-telemetry'); detail.hidden = true;
        detail.id = `router-telemetry-${entry.id}`;
        inspect.setAttribute('aria-controls', detail.id);
        if (typeof detail.togglePopover === 'function') {
          detail.hidden = false; detail.popover = 'auto';
          detail.addEventListener('toggle', () => inspect.setAttribute('aria-expanded', String(detail.matches(':popover-open'))));
        }
        const stats = activityEntry?.telemetry;
        const pricing = providers.find((p) => p.id === entry.providerId)?.pricing;
        const rates = pricing?.models?.[entry.modelId] || pricing?.models?.['*'] || pricing?.default;
        const cost = stats?.usageSamples && rates && (stats.promptTokens || stats.completionTokens)
          ? `${((stats.promptTokens * rates.inputPer1M + stats.completionTokens * rates.outputPer1M) / 1000000).toFixed(5)} ${pricing?.currency || 'USD'} (configured rates)` : 'not available';
        detail.textContent = stats ? `Average generation latency: ${Math.round(stats.latencyMs / stats.completed)} ms · Error rate: ${Math.round(100 * stats.errors / stats.completed)}% · Tokens: ${stats.usageSamples ? stats.tokens : 'not reported'} · Estimated cost: ${cost}` : 'No completed generations this session. Latency, errors, reported tokens, and estimated cost appear here.';
        const meter = node('progress'); meter.max = entry.concurrencyLimit; meter.value = activityEntry?.active || 0; meter.setAttribute('aria-label', `${routerEntryModelLabel(entry, library)} occupied generation slots`);
        card.append(inspect, node('span', routerEntryProviderLabel(entry, providerChoices)), node('span', activity.availability[entry.id]?.reason || 'Checking availability'), meter, node('span', `${activityEntry?.active || 0} / ${entry.concurrencyLimit} active · ${activityEntry?.queued || 0} queued`), detail);
        const health = activity.availability[entry.id];
        if (health?.kind) {
          if (health.retryAt) card.append(node('span', `${health.resetAt ? 'Resets' : 'Retry available'} ${new Date(health.retryAt).toLocaleString()}`));
          const retry = button('Retry now', () => {
            retry.disabled = true;
            void routerApi<RouterActivity>(`/${router.id}/retry`, { entryId: entry.id }, 'POST')
              .then((updated) => { if (alive && selected === router.id && retry.isConnected) drawActivity(router, updated); })
              .catch((error) => { if (alive && retry.isConnected) { retry.disabled = false; retry.textContent = 'Retry now'; card.append(node('span', `Could not enable retry: ${(error as Error).message}`)); } });
          });
          retry.title = 'Allow one recovery attempt on the next request. No model request is sent now.';
          retry.disabled = health.reason === 'Checking allowance recovery';
          card.append(retry);
        }
        models.append(card);
      }
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.classList.add('router-connections'); svg.setAttribute('aria-hidden', 'true');
      graph.append(svg, chats, models); releasePickers(live); live.replaceChildren(node('h2', 'Live routing'), graph);
      const recentFailure = [...activity.events].reverse().find((e) => e.status === 'failover');
      if (recentFailure) live.append(node('p', `Last failover: ${recentFailure.error || 'Previous model unavailable'}`, 'router-message'));
      requestAnimationFrame(() => {
        if (!graph.isConnected) return;
        const bounds = graph.getBoundingClientRect(); svg.setAttribute('viewBox', `0 0 ${bounds.width} ${bounds.height}`);
        for (const chat of chats.querySelectorAll<HTMLElement>('[data-target]')) {
          const model = [...models.querySelectorAll<HTMLElement>('[data-node]')].find((m) => m.dataset.node === chat.dataset.target);
          if (!model) continue;
          const a = chat.getBoundingClientRect(); const b = model.getBoundingClientRect();
          const x1 = a.right - bounds.left; const y1 = a.top + a.height / 2 - bounds.top; const x2 = b.left - bounds.left; const y2 = b.top + b.height / 2 - bounds.top;
          const path = document.createElementNS(svg.namespaceURI, 'path'); path.setAttribute('d', `M ${x1} ${y1} C ${(x1 + x2) / 2} ${y1}, ${(x1 + x2) / 2} ${y2}, ${x2} ${y2}`);
          path.setAttribute('class', chat.dataset.status === 'active' ? 'is-active' : chat.dataset.status === 'queued' ? 'is-queued' : 'is-idle'); svg.append(path);
        }
      });
    }
    render();
    const tick = async (): Promise<void> => { if (!alive || !host.isConnected) return; await refresh(); if (alive) timer = setTimeout(() => { void tick(); }, 2500); };
    timer = setTimeout(() => { void tick(); }, 2500);
  } catch (error) { if (alive) host.replaceChildren(node('p', `Could not load model pools: ${(error as Error).message}`), button('Retry', () => { void mountRoutersPanel(); })); }
}

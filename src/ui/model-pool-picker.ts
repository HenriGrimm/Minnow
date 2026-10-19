import '../styles/model-pool-picker.css';
import { randomUUID } from '../lib/random-id';
import { decodeModelSelectKey, encodeModelSelectKey } from '../lib/model-select-key';
import { canonicalRouterBinding, loadRouterConfig, saveRouterConfig, ROUTER_PROVIDER_ID, type ModelRouter, type RouterConfig, type RouterEntry } from '../models/routers';
import { formatRouterTierLabel, guessRouterTier, isDecisionModelId, ROUTER_TIERS } from '../models/router-tiers.mjs';
import { isLocalRuntimeCatalogProviderId } from '../models/model-select-library';
import { parseModelOptionLabels } from './composer-model-button';
import { closePoolTaskTypeChoices, createPoolEntry, poolStrategyChoices, poolTaskTypeChoices, poolTaskTypeBadges, POOL_POLICIES } from './model-pool-fields';
import { formatRouterTaskTypeLabel } from '../models/router-task-types.mjs';
import { iconHtml } from './icon';
import { openContextMenu, type ContextMenuHandle } from './context-menu';

interface PoolBrowserOptions {
  select: () => HTMLSelectElement | null;
  selectedValue: () => string;
  query: () => string;
  pick: (value: string) => void;
  onEditing: (editing: boolean) => void;
  onLayout?: () => void;
  manage: () => void;
}
export interface ModelPoolBrowser {
  refreshSearch: () => void;
  requestLeave: (next: () => void) => boolean;
  dispose: () => void;
}
interface PoolModelChoice { value: string; providerId: string; modelId: string; label: string; provider: string }
function node<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = ''): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag); el.textContent = text; el.className = className; return el;
}
function button(text: string, action: () => void, className = 'pool-picker-action'): HTMLButtonElement {
  const el = node('button', text, className); el.type = 'button'; el.onclick = action; return el;
}
function field(text: string, control: HTMLElement): HTMLLabelElement {
  const el = node('label', '', 'pool-picker-field'); el.append(node('span', text), control); return el;
}
const key = (entry: { providerId: string; modelId: string }): string => encodeModelSelectKey(entry.providerId, entry.modelId);

/** Use the picker's existing catalog, without recursive pools or duplicate runtime catalogs. */
function modelChoices(select: HTMLSelectElement | null): PoolModelChoice[] {
  const choices = new Map<string, PoolModelChoice>();
  for (const option of select?.options ?? []) {
    const binding = decodeModelSelectKey(option.value);
    if (!binding || option.disabled || binding.providerId === ROUTER_PROVIDER_ID || isLocalRuntimeCatalogProviderId(binding.providerId)) continue;
    const labels = parseModelOptionLabels(option);
    choices.set(option.value, { ...binding, value: option.value,
      label: option.dataset.modelLabel || labels.model,
      provider: option.dataset.providerLabel || labels.provider || option.closest('optgroup')?.label || binding.providerId });
  }
  return [...choices.values()];
}

export function mountModelPoolBrowser(host: HTMLElement, options: PoolBrowserOptions): ModelPoolBrowser {
  let alive = true;
  let config: RouterConfig = { routers: [], defaultRouterId: null, revision: 0 };
  let loading = true;
  let loadEpoch = 0;
  let saving = false;
  let inspected = '';
  let draft: ModelRouter | undefined;
  let original = '';
  let adding = false;
  let addQuery = '';
  let query = options.query();
  let error = '';
  let notice = '';
  let pendingLeave: (() => void) | undefined;
  let deleting = false;
  const disclosures = new Set<string>();
  let entryMenu: ContextMenuHandle | undefined;
  const root = node('div', '', 'pool-picker'); host.replaceChildren(root);
  const choices = (): PoolModelChoice[] => modelChoices(options.select());
  const choiceFor = (entry: { providerId: string; modelId: string }): PoolModelChoice | undefined => choices().find(choice => choice.value === key(entry));
  const label = (entry: { providerId: string; modelId: string }): string => choiceFor(entry)?.label || entry.modelId;
  const provider = (entry: { providerId: string; modelId: string }): string => choiceFor(entry)?.provider || entry.providerId;
  const selectedId = (): string => {
    const binding = decodeModelSelectKey(options.selectedValue());
    return binding?.providerId === ROUTER_PROVIDER_ID ? canonicalRouterBinding(binding).modelId : '';
  };
  const dirty = (): boolean => Boolean(draft && JSON.stringify(draft) !== original);
  const requestLeave = (next: () => void): boolean => {
    if (saving) return false;
    if (!dirty()) return true;
    pendingLeave = next; render();
    root.querySelector<HTMLButtonElement>('[data-keep-editing]')?.focus();
    return false;
  };
  const edit = (pool: ModelRouter): void => {
    draft = structuredClone(pool); original = JSON.stringify(draft);
    disclosures.clear();
    error = ''; notice = ''; adding = false; deleting = false;
    render(); root.querySelector<HTMLInputElement>('[aria-label="Pool name"]')?.focus();
  };
  const create = (): void => {
    const binding = decodeModelSelectKey(options.selectedValue());
    const entry = binding && choices().some(choice => choice.value === key(binding)) && !isDecisionModelId(binding.modelId)
      ? [createPoolEntry(binding)] : [];
    edit({ id: randomUUID(), name: '', enabled: true, policy: 'priority', entries: entry });
    // A newly opened, unnamed draft must also be resolved on dismissal.
    original = '';
  };
  const returnToList = (): void => {
    const leave = (): void => { draft = undefined; adding = false; error = ''; pendingLeave = undefined; render(); };
    if (requestLeave(leave)) leave();
  };
  const use = (pool: ModelRouter): void => {
    if (!alive || !pool.enabled || !pool.entries.some(entry => entry.enabled)) return;
    options.pick(encodeModelSelectKey(ROUTER_PROVIDER_ID, pool.id));
  };

  async function load(): Promise<void> {
    const epoch = ++loadEpoch;
    loading = true; error = ''; render();
    try {
      const fresh = await loadRouterConfig();
      if (!alive || epoch !== loadEpoch) return;
      config = structuredClone(fresh);
      inspected = config.routers.some(pool => pool.id === inspected) ? inspected
        : selectedId() || config.routers[0]?.id || '';
    } catch (cause) { if (alive && epoch === loadEpoch) error = `Could not load model pools: ${(cause as Error).message}`; }
    finally { if (alive && epoch === loadEpoch) { loading = false; render(); } }
  }

  async function commit(andUse = false, remove = false): Promise<void> {
    if (!draft || saving || !alive) return;
    if (!remove) {
      if (!draft.name.trim()) { error = 'Give your pool a name.'; render(); root.querySelector<HTMLInputElement>('[aria-label="Pool name"]')?.focus(); return; }
      if (draft.enabled && !draft.entries.some(entry => entry.enabled)) { error = 'Add at least one active model, or pause this pool.'; render(); return; }
      if (draft.entries.some(entry => !Number.isInteger(entry.concurrencyLimit) || entry.concurrencyLimit < 1 || entry.concurrencyLimit > 100)) {
        error = 'Concurrent generation slots must be a whole number from 1 to 100.'; render(); return;
      }
      if (draft.entries.length > 100) { error = 'A pool can contain up to 100 models.'; render(); return; }
    }
    const edited = structuredClone(draft); edited.name = edited.name.trim();
    const next = structuredClone(config);
    const index = next.routers.findIndex(pool => pool.id === edited.id);
    if (remove) next.routers = next.routers.filter(pool => pool.id !== edited.id);
    else if (index < 0) next.routers.push(edited);
    else next.routers[index] = edited;
    if ((!edited.enabled || remove) && next.defaultRouterId === edited.id) next.defaultRouterId = null;
    saving = true; error = ''; render();
    try {
      const saved = await saveRouterConfig(next);
      if (!alive) return;
      config = structuredClone(saved);
      inspected = remove ? config.routers[0]?.id || '' : edited.id;
      draft = undefined; original = ''; deleting = false; adding = false;
      notice = remove ? 'Pool deleted. Models stay connected.' : `${edited.name} saved.`;
      saving = false;
      render();
      if (andUse && !remove) {
        const savedPool = config.routers.find(pool => pool.id === edited.id);
        if (savedPool) use(savedPool);
      }
    } catch (cause) {
      if (alive) { error = `Could not save: ${(cause as Error).message}`; deleting = false; }
    } finally { if (alive) { saving = false; render(); } }
  }

  function renderList(): void {
    const heading = node('div', '', 'pool-picker-heading');
    const identity = node('div'); identity.append(node('h3', 'Model pools'), node('p', 'Shared across projects'));
    const add = button('New pool', create, 'pool-picker-action pool-picker-primary');
    add.disabled = loading || Boolean(error); heading.append(identity, add); root.append(heading);
    if (loading) { root.append(node('p', 'Loading model pools…', 'pool-picker-empty')); return; }
    if (error) {
      const message = node('p', error, 'pool-picker-error'); message.setAttribute('role', 'alert');
      root.append(message, button('Retry', () => { void load(); })); return;
    }
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const pools = config.routers.filter(pool => {
      const text = [pool.name, ...pool.entries.flatMap(entry => [label(entry), provider(entry), entry.modelId, ...(pool.policy === 'evaluate' ? (entry.taskTypes?.length ? entry.taskTypes.map(formatRouterTaskTypeLabel) : ['Any task']) : [])])].join(' ').toLowerCase();
      return terms.every(term => text.includes(term));
    });
    if (!pools.length) {
      const empty = node('div', '', 'pool-picker-empty');
      empty.append(node('strong', config.routers.length ? 'No matching pools' : 'Your models, working together'),
        node('p', config.routers.length ? 'Try a pool, model, or provider name.' : 'Create a pool with one or more models.'));
      if (!config.routers.length) empty.append(button('Create a pool', create));
      root.append(empty); return;
    }
    const pool = pools.find(pool => pool.id === inspected) || pools[0]; inspected = pool.id;
    const columns = node('div', '', 'pool-picker-columns');
    const rail = node('div', '', 'pool-picker-rail'); rail.setAttribute('role', 'group'); rail.setAttribute('aria-label', 'Model pools');
    for (const candidate of pools) {
      const row = button('', () => { inspected = candidate.id; render(); root.querySelector<HTMLButtonElement>(`[data-pool-id="${candidate.id}"]`)?.focus(); }, 'pool-picker-row');
      row.dataset.poolId = candidate.id; row.setAttribute('aria-pressed', String(candidate.id === pool.id));
      const name = node('span', candidate.name, 'pool-picker-name');
      if (candidate.id === selectedId()) name.append(node('span', 'Selected', 'pool-picker-selected'));
      row.append(name, node('span', candidate.enabled
        ? `${POOL_POLICIES.find(policy => policy.id === candidate.policy)?.title} · ${candidate.entries.filter(entry => entry.enabled).length} ${candidate.entries.filter(entry => entry.enabled).length === 1 ? 'model' : 'models'}`
        : 'Paused', 'pool-picker-caption'));
      rail.append(row);
    }
    rail.addEventListener('keydown', event => {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      const rows = [...rail.querySelectorAll<HTMLButtonElement>('button')];
      const index = rows.indexOf(event.target as HTMLButtonElement); if (index < 0) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, index + (event.key === 'ArrowUp' ? -1 : 1)));
      rows[next].click();
    });
    const detail = node('section', '', 'pool-picker-detail'); detail.setAttribute('aria-label', pool.name);
    const title = node('div', '', 'pool-picker-detail-heading');
    const policy = POOL_POLICIES.find(policy => policy.id === pool.policy)!;
    const labelWrap = node('div'); labelWrap.append(node('h3', pool.name), node('span', policy.title, 'pool-picker-caption'));
    title.append(labelWrap, button('Edit', () => edit(pool))); detail.append(title, node('p', policy.detail, 'pool-picker-description'));
    const entries = node('ol', '', 'pool-picker-preview');
    pool.entries.forEach(entry => {
      const row = node('li');
      row.append(node('strong', label(entry)), node('span', `${provider(entry)} · ${entry.concurrencyLimit} ${entry.concurrencyLimit === 1 ? 'slot' : 'slots'}${!entry.enabled ? ' · Paused' : ''}`, 'pool-picker-caption'));
      if (pool.policy === 'evaluate') {
        row.append(node('span', `${formatRouterTierLabel(entry.tier || guessRouterTier(label(entry)))} tier${entry.tier ? '' : ' · Auto'}`, 'pool-picker-caption'), poolTaskTypeBadges(entry));
      }
      entries.append(row);
    });
    detail.append(entries);
    if (pool.policy === 'evaluate') detail.append(node('p', pool.evaluator ? `Evaluator: ${label(pool.evaluator)}` : 'No evaluator set. Uses model order.', 'pool-picker-caption'));
    const canUse = pool.enabled && pool.entries.some(entry => entry.enabled);
    const useButton = button(pool.id === selectedId() ? 'Selected' : 'Use pool', () => use(pool), 'pool-picker-action pool-picker-primary');
    useButton.disabled = !canUse; detail.append(useButton);
    if (!canUse) detail.append(node('p', pool.enabled ? 'Enable a model before using this pool.' : 'This pool is paused. Edit it to enable.', 'pool-picker-caption'));
    columns.append(rail, detail); root.append(columns);
  }

  function addModels(pool: ModelRouter): void {
    const heading = node('div', '', 'pool-picker-heading');
    heading.append(node('h3', 'Add models'), button('Done', () => { adding = false; render(); }, 'pool-picker-action pool-picker-primary'));
    const search = node('input'); search.type = 'search'; search.placeholder = 'Search models or providers…'; search.setAttribute('aria-label', 'Find models to add'); search.value = addQuery;
    const results = node('div', '', 'pool-picker-catalog');
    const draw = (): void => {
      results.replaceChildren();
      const terms = addQuery.toLowerCase().trim().split(/\s+/).filter(Boolean);
      const matches = choices().filter(choice => !isDecisionModelId(choice.modelId) && terms.every(term => `${choice.label} ${choice.provider}`.toLowerCase().includes(term)));
      for (const choice of matches) {
        const included = pool.entries.some(entry => key(entry) === choice.value);
        const add = button('', () => { pool.entries.push(createPoolEntry({ providerId: choice.providerId, modelId: choice.modelId })); draw(); search.focus(); }, 'pool-picker-catalog-row');
        add.disabled = included || pool.entries.length >= 100;
        const identity = node('span'); identity.append(node('strong', choice.label), node('span', choice.provider, 'pool-picker-caption'));
        add.append(identity, node('span', included ? '✓ Added' : '+ Add')); results.append(add);
      }
      if (!matches.length) results.append(node('p', 'No matching models. Connect a provider or download a model in Models.', 'pool-picker-caption'));
    };
    search.oninput = () => { addQuery = search.value; draw(); };
    draw(); root.append(heading, field('Available models', search), results);
  }

  function evaluatorFields(pool: ModelRouter): HTMLElement {
    const section = node('div', '', 'pool-picker-evaluator');
    const select = node('select'); select.setAttribute('aria-label', 'Task evaluator');
    const none = node('option', 'No evaluator (use model order)'); none.value = ''; select.append(none);
    for (const choice of choices().filter(choice => choice.providerId !== 'minnow-library')) {
      const option = node('option', `${choice.label} · ${choice.provider}`); option.value = choice.value; select.append(option);
    }
    const current = pool.evaluator ? key(pool.evaluator) : '';
    if (current && ![...select.options].some(option => option.value === current)) {
      const option = node('option', `${pool.evaluator!.modelId} · ${pool.evaluator!.providerId} (not listed)`); option.value = current; select.append(option);
    }
    select.value = current;
    select.onchange = () => { const binding = decodeModelSelectKey(select.value); if (binding) pool.evaluator = binding; else delete pool.evaluator; };
    section.append(field('Task evaluator', select), node('p', 'Chooses a task type, tier, and reasoning once per chat. Assign specialties below, or choose Any task for a fallback model.', 'pool-picker-caption'));
    const custom = node('details'); custom.append(node('summary', 'Use an unlisted evaluator'));
    const providerSelect = node('select'); providerSelect.setAttribute('aria-label', 'Evaluator provider');
    const providers = new Map(choices().filter(choice => choice.providerId !== 'minnow-library').map(choice => [choice.providerId, choice.provider]));
    if (pool.evaluator) providers.set(pool.evaluator.providerId, pool.evaluator.providerId);
    for (const [id, label] of providers) { const option = node('option', label); option.value = id; providerSelect.append(option); }
    if (pool.evaluator) providerSelect.value = pool.evaluator.providerId;
    const model = node('input'); model.value = pool.evaluator?.modelId || ''; model.maxLength = 500; model.placeholder = 'typesafe/jev-1.13'; model.setAttribute('aria-label', 'Evaluator model ID');
    const apply = button('Use evaluator', () => {
      if (!providerSelect.value || !model.value.trim()) { model.required = true; model.reportValidity(); return; }
      pool.evaluator = { providerId: providerSelect.value, modelId: model.value.trim() }; render();
    });
    custom.append(field('Provider', providerSelect), field('Model ID', model), apply); section.append(custom);
    return section;
  }

  function lineup(pool: ModelRouter): HTMLElement {
    const section = node('section', '', 'pool-picker-lineup');
    const heading = node('div', '', 'pool-picker-heading');
    heading.append(node('h3', `Model lineup · ${pool.entries.length}`), button('+ Add models', () => { adding = true; addQuery = ''; render(); root.querySelector<HTMLInputElement>('[aria-label="Find models to add"]')?.focus(); }));
    section.append(heading);
    const list = node('ol'); list.setAttribute('aria-label', 'Models in priority order');
    pool.entries.forEach((entry, index) => {
      const row = node('li', '', 'pool-picker-entry'); row.dataset.entryId = entry.id;
      const main = node('div', '', 'pool-picker-entry-main');
      const identity = node('div', '', 'pool-picker-entry-identity');
      identity.append(node('strong', label(entry)), node('span', `${provider(entry)}${!entry.enabled ? ' · Paused' : ''}${!choiceFor(entry) ? ' · Not in current catalog' : ''}`, 'pool-picker-caption'));
      const move = (offset: number): void => {
        const to = index + offset; if (to < 0 || to >= pool.entries.length) return;
        pool.entries.splice(index, 1); pool.entries.splice(to, 0, entry); render();
        root.querySelector<HTMLButtonElement>(`[data-entry-id="${entry.id}"] .pool-picker-entry-menu`)?.focus();
      };
      const order = node('div', '', 'pool-picker-order');
      const menu = button('', () => {
        entryMenu = openContextMenu({ anchor: menu, restoreFocus: menu, mount: row, label: `Actions for rank ${index + 1}`, items: [
          { id: 'up', label: 'Move up', disabled: index === 0, onSelect: () => move(-1) },
          { id: 'down', label: 'Move down', disabled: index === pool.entries.length - 1, onSelect: () => move(1) },
          { id: 'pause', label: entry.enabled ? 'Pause model' : 'Enable model', onSelect: () => { entry.enabled = !entry.enabled; render(); root.querySelector<HTMLButtonElement>(`[data-entry-id="${entry.id}"] .pool-picker-entry-menu`)?.focus(); } },
          { kind: 'separator' },
          { id: 'remove', label: 'Remove from pool', onSelect: () => { pool.entries.splice(index, 1); render(); root.querySelector<HTMLButtonElement>('.pool-picker-lineup .pool-picker-heading button')?.focus(); } },
        ] });
      }, 'pool-picker-icon pool-picker-entry-menu');
      menu.innerHTML = iconHtml('more', { size: 15 }); menu.setAttribute('aria-label', `Actions for rank ${index + 1}`); menu.setAttribute('aria-haspopup', 'menu');
      order.append(menu);
      main.append(node('span', String(index + 1), 'pool-picker-rank'), identity, order);
      row.append(main);
      const matching = node('div', '', 'pool-picker-entry-routing');
      if (pool.policy === 'evaluate') {
        const tier = node('select'); tier.className = 'pool-picker-tier'; tier.setAttribute('aria-label', `Tier for ${label(entry)}`);
        const auto = node('option', `Auto: ${formatRouterTierLabel(guessRouterTier(entry.modelId))}`); auto.value = ''; tier.append(auto);
        for (const value of ROUTER_TIERS) { const option = node('option', formatRouterTierLabel(value)); option.value = value; tier.append(option); }
        tier.value = entry.tier || '';
        tier.onchange = () => { if (tier.value) entry.tier = tier.value as RouterEntry['tier']; else delete entry.tier; };
        matching.append(field('Tier', tier), poolTaskTypeChoices(entry, `rank ${index + 1}`, () => {}));
      }
      const slots = node('input'); slots.type = 'number'; slots.min = '1'; slots.max = '100'; slots.step = '1'; slots.value = String(entry.concurrencyLimit);
      slots.setAttribute('aria-label', `Concurrent slots for ${label(entry)}`);
      slots.oninput = () => { entry.concurrencyLimit = Number(slots.value); };
      const capacity = field('Slots', slots); capacity.classList.add('pool-picker-entry-slots');
      matching.append(capacity); row.append(matching); list.append(row);
    });
    section.append(list);
    if (!pool.entries.length) section.append(node('p', 'Add a model to start your lineup.', 'pool-picker-caption'));
    section.append(node('p', 'Chats keep their assigned model. Capacity is shared across projects and pools.', 'pool-picker-caption'));
    return section;
  }

  function renderEditor(): void {
    const pool = draft!;
    const header = node('div', '', 'pool-picker-heading');
    header.append(button('← Pools', returnToList), node('span', 'Shared across projects', 'pool-picker-caption')); root.append(header);
    if (pendingLeave) {
      const prompt = node('div', '', 'pool-picker-empty');
      const keep = button('Keep editing', () => { pendingLeave = undefined; render(); root.querySelector<HTMLInputElement>('[aria-label="Pool name"]')?.focus(); }); keep.dataset.keepEditing = 'true';
      prompt.append(node('strong', 'Discard unsaved changes?'), node('p', 'Your saved pool stays as it is.'), keep,
        button('Discard changes', () => { const next = pendingLeave; pendingLeave = undefined; draft = undefined; next?.(); }, 'pool-picker-action pool-picker-primary'));
      root.append(prompt); return;
    }
    if (deleting) {
      const prompt = node('div', '', 'pool-picker-empty');
      const actions = node('div', '', 'pool-picker-confirm-actions');
      actions.setAttribute('role', 'group'); actions.setAttribute('aria-label', 'Delete pool confirmation');
      actions.append(button('Cancel', () => { deleting = false; render(); }), button('Delete pool permanently', () => { void commit(false, true); }, 'pool-picker-action pool-picker-danger'));
      prompt.append(node('strong', `Delete “${pool.name}”?`), node('p', 'Chats using this pool will need another selection. Models stay connected.'), actions);
      root.append(prompt); return;
    }
    if (adding) { addModels(pool); return; }
    const name = node('input'); name.value = pool.name; name.maxLength = 100; name.placeholder = 'e.g. Everyday coding'; name.setAttribute('aria-label', 'Pool name');
    name.oninput = () => { pool.name = name.value; };
    root.append(field('Pool name', name), node('p', 'How should this pool choose?', 'pool-picker-label'));
    root.append(poolStrategyChoices(pool.policy, policy => {
      pool.policy = policy; render(); root.querySelector<HTMLButtonElement>(`[data-policy="${policy}"]`)?.focus();
    }));
    if (pool.policy === 'evaluate') root.append(evaluatorFields(pool));
    root.append(lineup(pool));
    const extra = node('details', '', 'pool-picker-options'); extra.append(node('summary', 'Pool options'));
    extra.open = disclosures.has('pool');
    extra.ontoggle = () => { if (extra.isConnected) { if (extra.open) disclosures.add('pool'); else disclosures.delete('pool'); } };
    extra.append(button(pool.enabled ? 'Pause pool' : 'Enable pool', () => {
      pool.enabled = !pool.enabled; render(); root.querySelector<HTMLButtonElement>('.pool-picker-options button')?.focus();
    }));
    if (config.routers.some(candidate => candidate.id === pool.id)) extra.append(button('Delete pool', () => { deleting = true; render(); }, 'pool-picker-action pool-picker-danger'));
    extra.append(node('p', pool.enabled ? 'Pool enabled' : 'Pool paused', 'pool-picker-caption')); root.append(extra);
    if (error) {
      const message = node('p', error, 'pool-picker-error'); message.setAttribute('role', 'alert');
      const reload = button('Reload pools', () => {
        const discardAndReload = (): void => { draft = undefined; original = ''; void load(); };
        if (requestLeave(discardAndReload)) discardAndReload();
      });
      root.append(message, reload);
    }
    const footer = node('div', '', 'pool-picker-footer');
    footer.append(node('span', 'Changes apply after saving.', 'pool-picker-caption'));
    const actions = node('div', '', 'pool-picker-save-actions');
    actions.append(button('Save', () => { void commit(); }), button('Save & use', () => { void commit(true); }, 'pool-picker-action pool-picker-primary'));
    (actions.lastElementChild as HTMLButtonElement).disabled = !pool.enabled;
    footer.append(actions); root.append(footer);
  }

  function render(): void {
    if (!alive) return;
    closePoolTaskTypeChoices(root); entryMenu?.close(); entryMenu = undefined;
    const scrollTop = host.scrollTop;
    root.replaceChildren(); options.onEditing(Boolean(draft));
    if (draft) renderEditor(); else renderList();
    if (!draft) {
      const footer = node('div', '', 'pool-picker-footer');
      const selected = config.routers.find(pool => pool.id === selectedId());
      const selectedModel = choices().find(choice => choice.value === options.selectedValue());
      const selection = selected?.name || selectedModel?.label;
      const status = node('span', notice || (selection ? `Selected: ${selection}` : selectedId() ? 'Selected pool is unavailable.' : 'Choose a model or pool.'), 'pool-picker-caption');
      status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
      footer.append(status, button('Manage pools ↗', options.manage)); root.append(footer);
    }
    root.setAttribute('aria-busy', String(saving || loading));
    if (saving) {
      root.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>('button, input, select').forEach(control => { control.disabled = true; });
      const status = node('p', 'Saving pool…', 'pool-picker-caption'); status.setAttribute('role', 'status'); root.append(status);
    }
    host.scrollTop = scrollTop;
    options.onLayout?.();
  }
  const changed = (): void => {
    if (!alive || draft || saving) return;
    void load();
  };
  window.addEventListener('minnow-routers-changed', changed);
  void load();
  return {
    refreshSearch: () => {
      const next = options.query();
      if (next !== query) { query = next; if (!draft) render(); }
    },
    requestLeave,
    dispose: () => { alive = false; closePoolTaskTypeChoices(root); entryMenu?.close(); window.removeEventListener('minnow-routers-changed', changed); },
  };
}

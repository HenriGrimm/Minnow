import { randomUUID } from '../../lib/random-id';
import '../../styles/model-routers.css';
import { formatModelLabel } from '../../lib/format-model-label';
import type { LibraryModel } from '../../models/library';
import {
  fetchLibraryModelSelectMerge,
  LIBRARY_MODEL_PROVIDER_ID,
  libraryModelLoadState,
  type LibraryModelSelectMerge,
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
import { listProviders } from '../../providers/store';
import { sessionState as state } from '../../state/sessions';
import { listFillProviderOptions } from '../settings-model-binding';

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

/** Fill a router model select from My Models (display name + quant + load state). */
function fillLibraryModelOptions(
  select: HTMLSelectElement,
  library: LibraryModel[],
  serves: LibraryModelSelectMerge['serves'],
): void {
  select.replaceChildren();
  for (const model of library) {
    const stateLabel = libraryModelLoadState(model, serves);
    const { optionText, title } = formatModelLabel({
      id: model.name,
      quantization: model.quant || undefined,
      state: stateLabel,
    });
    const option = new Option(optionText, model.id);
    option.title = title;
    select.append(option);
  }
}

let dispose: (() => void) | undefined;

export async function mountRoutersPanel(): Promise<void> {
  dispose?.();
  const host = document.getElementById('modelsSection-routers');
  if (!host) return;
  host.replaceChildren(node('p', 'Loading model pools…'));
  let alive = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  dispose = () => { alive = false; if (timer) clearTimeout(timer); };
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
    const root = node('div', '', 'router-panel');
    const bar = node('div', '', 'router-toolbar');
    const picker = node('select'); picker.setAttribute('aria-label', 'Model pool');
    const message = node('p', '', 'router-message'); message.setAttribute('role', 'status');
    const editor = node('div', '', 'router-editor');
    const live = node('div', '', 'router-live');
    let liveEpoch = 0;
    const save = button('Save configuration', () => { void commit(); });
    const markDirty = (): void => { dirty = true; save.disabled = false; message.textContent = 'Unsaved changes'; };
    if (remapped) markDirty();
    async function commit(): Promise<void> {
      if (saving) return;
      saving = true; save.disabled = true; root.inert = true; root.setAttribute('aria-busy', 'true');
      try { config = structuredClone(await saveRouterConfig(config)); dirty = false; message.textContent = 'Saved'; render(); }
      catch (error) { message.textContent = (error as Error).message; save.disabled = false; }
      finally { saving = false; root.inert = false; root.removeAttribute('aria-busy'); }
    }
    const current = (): ModelRouter | undefined => config.routers.find((r) => r.id === selected);
    picker.onchange = () => { selected = picker.value; render(); };
    bar.append(node('h2', 'Model pools'), picker, button('New model pool', () => {
      const router: ModelRouter = { id: randomUUID(), name: 'New model pool', enabled: true, policy: 'priority', entries: [] };
      config.routers.push(router); selected = router.id; markDirty(); render();
    }), save);
    root.append(bar, message, editor, live); host.replaceChildren(root);

    function fillEntryModels(modelSelect: HTMLSelectElement, entry: RouterEntry): void {
      if (entry.providerId === LIBRARY_MODEL_PROVIDER_ID) {
        fillLibraryModelOptions(modelSelect, library, libraryMerge?.serves ?? []);
      } else {
        const models = catalogs.find((c) => c.provider.id === entry.providerId)?.models || [];
        modelSelect.replaceChildren(
          ...models
            .filter((m) => m.type === 'llm' || m.type === 'vlm' || !m.type)
            .map((m) => new Option(m.id, m.id)),
        );
      }
      ensureSelectValue(modelSelect, entry.modelId, entry.modelId);
    }

    function firstUnusedModel(): { providerId: string; modelId: string } | null {
      const used = new Set(current()?.entries.map((e) => `${e.providerId}\0${e.modelId}`) ?? []);
      const unusedLibrary = library.find((model) => !used.has(`${LIBRARY_MODEL_PROVIDER_ID}\0${model.id}`));
      if (unusedLibrary) return { providerId: LIBRARY_MODEL_PROVIDER_ID, modelId: unusedLibrary.id };
      const catalog = catalogs.find((c) =>
        providerChoices.some((choice) => choice.id === c.provider.id) &&
        c.models.some((m) => (m.type === 'llm' || m.type === 'vlm' || !m.type) && !used.has(`${c.provider.id}\0${m.id}`)),
      );
      const model = catalog?.models.find((m) =>
        (m.type === 'llm' || m.type === 'vlm' || !m.type) && !used.has(`${catalog.provider.id}\0${m.id}`),
      );
      if (!catalog || !model) return null;
      return { providerId: catalog.provider.id, modelId: model.id };
    }

    function render(): void {
      liveEpoch++;
      picker.replaceChildren(...config.routers.map((r) => new Option(r.name, r.id)));
      picker.value = selected; picker.disabled = !config.routers.length;
      save.disabled = !dirty;
      editor.replaceChildren(); live.replaceChildren();
      const router = current();
      if (!router) {
        editor.append(node('p', 'Create a model pool to share model capacity across chats. Add models from My Models or your configured providers, then select the model pool in any chat.'));
        return;
      }
      const header = node('div', '', 'router-fields');
      const name = node('input'); name.value = router.name; name.maxLength = 100;
      name.oninput = () => { router.name = name.value; markDirty(); };
      const enabled = node('input'); enabled.type = 'checkbox'; enabled.checked = router.enabled;
      enabled.onchange = () => { router.enabled = enabled.checked; if (!enabled.checked && config.defaultRouterId === router.id) config.defaultRouterId = null; markDirty(); };
      const policy = node('select'); policy.append(new Option('Priority', 'priority'), new Option('Balance by rank', 'balance')); policy.value = router.policy;
      policy.onchange = () => { router.policy = policy.value as ModelRouter['policy']; markDirty(); };
      const defaultToggle = node('input'); defaultToggle.type = 'checkbox'; defaultToggle.checked = config.defaultRouterId === router.id;
      defaultToggle.onchange = () => { config.defaultRouterId = defaultToggle.checked ? router.id : null; markDirty(); };
      header.append(field('Name', name), field('Policy', policy), field('Enabled', enabled), field('Default for new chats', defaultToggle));
      editor.append(header, node('p', 'Chats keep their assigned model. When it is full, they wait; if it fails, the response restarts on another eligible model. My Models entries load when needed and unload after in-flight local work finishes.'));
      const list = node('ol', '', 'router-entry-list');
      router.entries.forEach((entry, index) => {
        const row = node('li'); row.dataset.entryId = entry.id;
        const provider = node('select'); provider.setAttribute('aria-label', `Provider for rank ${index + 1}`);
        provider.append(...providerChoices.map((choice) => new Option(choice.label, choice.id)));
        ensureSelectValue(provider, entry.providerId, entry.providerId);
        const model = node('select'); model.setAttribute('aria-label', `Model for rank ${index + 1}`);
        fillEntryModels(model, entry);
        provider.onchange = () => {
          entry.providerId = provider.value;
          if (entry.providerId === LIBRARY_MODEL_PROVIDER_ID) {
            entry.modelId = library.find((m) => !router.entries.some((e) => e !== entry && e.providerId === LIBRARY_MODEL_PROVIDER_ID && e.modelId === m.id))?.id
              || library[0]?.id
              || '';
          } else {
            const catalog = catalogs.find((c) => c.provider.id === entry.providerId);
            entry.modelId = catalog?.models.find((m) => m.type === 'llm' || m.type === 'vlm' || !m.type)?.id || '';
          }
          fillEntryModels(model, entry);
          markDirty();
        };
        model.onchange = () => { entry.modelId = model.value; markDirty(); };
        const capacity = node('input'); capacity.type = 'number'; capacity.min = '1'; capacity.max = '100'; capacity.value = String(entry.concurrencyLimit);
        capacity.oninput = () => { entry.concurrencyLimit = Number(capacity.value); markDirty(); };
        const toggle = node('input'); toggle.type = 'checkbox'; toggle.checked = entry.enabled;
        toggle.onchange = () => { entry.enabled = toggle.checked; markDirty(); };
        const move = (offset: number): void => {
          const target = index + offset;
          if (target < 0 || target >= router.entries.length) return;
          [router.entries[index], router.entries[target]] = [router.entries[target], router.entries[index]];
          markDirty(); render(); editor.querySelector<HTMLElement>(`[data-entry-id="${entry.id}"] button`)?.focus();
        };
        const up = button('↑', () => move(-1)); up.disabled = index === 0; up.setAttribute('aria-label', `Move rank ${index + 1} up`);
        const down = button('↓', () => move(1)); down.disabled = index === router.entries.length - 1; down.setAttribute('aria-label', `Move rank ${index + 1} down`);
        row.onkeydown = (event) => { if (event.altKey && ['ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); move(event.key === 'ArrowUp' ? -1 : 1); } };
        row.append(node('span', String(index + 1), 'router-rank'), provider, model, field('Slots', capacity), field('Enabled', toggle), up, down, button('Remove', () => { router.entries.splice(index, 1); markDirty(); render(); }));
        list.append(row);
      });
      const configuration = node('details', '', 'router-configuration');
      configuration.open = dirty || !router.entries.length;
      configuration.append(node('summary', `Configure entries (${router.entries.length})`));
      configuration.append(list, button('Add model', () => {
        const next = firstUnusedModel();
        if (!next) { message.textContent = 'No additional models available. Download a model in My Models or configure a provider in Models → Providers.'; return; }
        router.entries.push({ id: randomUUID(), providerId: next.providerId, modelId: next.modelId, enabled: true, concurrencyLimit: 1 }); markDirty(); render();
      }), button('Delete router', () => {
        config.routers = config.routers.filter((r) => r.id !== router.id);
        if (config.defaultRouterId === router.id) config.defaultRouterId = null;
        selected = config.routers[0]?.id || ''; markDirty(); render();
      }));
      editor.append(configuration);
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
        const override = node('select'); override.setAttribute('aria-label', 'Persistent model override');
        override.title = 'Applies to the next generation. Choose model pool assignment to clear.';
        override.append(new Option('Model pool assignment', ''), ...router.entries.filter((e) => e.enabled).map((e) => new Option(`${routerEntryProviderLabel(e, providerChoices)} / ${routerEntryModelLabel(e, library)}`, e.id)));
        override.value = assignment.overrideEntryId || '';
        override.onchange = () => { void routerApi(`/${router.id}/override`, { chatId: assignment.chatId, entryId: override.value || null }, 'POST').then(() => { override.blur(); void refresh(); }).catch((error) => { message.textContent = error.message; }); };
        row.append(override); chats.append(row);
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
        models.append(card);
      }
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.classList.add('router-connections'); svg.setAttribute('aria-hidden', 'true');
      graph.append(svg, chats, models); live.replaceChildren(node('h2', 'Live routing'), graph);
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

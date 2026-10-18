import { getRouterConfigSync, loadRouterConfig, type RouterEntry } from '../models/routers';
import { formatRouterTierLabel, guessRouterTier } from '../models/router-tiers.mjs';
import { poolTaskTypeBadges, POOL_POLICIES } from './model-pool-fields';

/** A small inspector for pool assignments in the system Models popover. */
export function mountModelPoolOverview(host: HTMLElement, label: (entry: RouterEntry) => string): { refresh: () => void; dispose: () => void } {
  let alive = true;
  let error = '';
  const expanded = new Set<string>();
  function render(): void {
    if (!alive) return;
    host.replaceChildren();
    const pools = getRouterConfigSync().routers;
    if (!pools.length) {
      const empty = document.createElement('p'); empty.className = 'models-system__pool-empty';
      empty.textContent = error || 'Group models and assign specialties to match each task.';
      host.append(empty);
    }
    for (const pool of pools) {
      const card = document.createElement('details'); card.className = 'models-system__pool'; card.dataset.poolId = pool.id;
      card.open = expanded.has(pool.id);
      card.ontoggle = () => { if (card.isConnected) { if (card.open) expanded.add(pool.id); else expanded.delete(pool.id); } };
      const summary = document.createElement('summary');
      const identity = document.createElement('span'); identity.className = 'models-system__pool-identity';
      const name = document.createElement('strong'); name.textContent = pool.name;
      const strategy = document.createElement('small');
      const active = pool.entries.filter(entry => entry.enabled);
      strategy.textContent = pool.enabled ? `${POOL_POLICIES.find(policy => policy.id === pool.policy)?.title} · ${active.length} ${active.length === 1 ? 'model' : 'models'}` : 'Paused';
      identity.append(name, strategy); summary.append(identity);
      if (pool.policy === 'evaluate') {
        const taskTypes = [...new Set(active.flatMap(entry => entry.taskTypes || []))];
        const coverage = poolTaskTypeBadges({ taskTypes });
        if (active.some(entry => !entry.taskTypes?.length) && taskTypes.length) coverage.append(poolTaskTypeBadges({}).firstElementChild!);
        summary.append(coverage);
      }
      const entries = document.createElement('ul'); entries.className = 'models-system__pool-entries';
      for (const entry of pool.entries) {
        const row = document.createElement('li');
        const model = document.createElement('span'); model.textContent = label(entry);
        const tier = document.createElement('small');
        tier.textContent = !entry.enabled ? 'Paused' : pool.policy === 'evaluate' ? `${formatRouterTierLabel(entry.tier || guessRouterTier(label(entry)))} tier` : `${entry.concurrencyLimit} ${entry.concurrencyLimit === 1 ? 'slot' : 'slots'}`;
        row.append(model, tier);
        if (pool.policy === 'evaluate') row.append(poolTaskTypeBadges(entry));
        entries.append(row);
      }
      card.append(summary, entries); host.append(card);
    }
    if (error) {
      const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'models-system__manage'; retry.textContent = 'Retry loading pools';
      retry.onclick = () => { void load(); }; host.append(retry);
    }
  }
  async function load(): Promise<void> {
    try { await loadRouterConfig(); error = ''; }
    catch { error = 'Could not refresh model pools.'; }
    render();
  }
  render(); void load();
  window.addEventListener('minnow-routers-changed', render);
  return { refresh: render, dispose: () => { alive = false; window.removeEventListener('minnow-routers-changed', render); } };
}

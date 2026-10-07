import { appendSettingsGroup } from './settings-layout';
import { createSettingsActionsRow } from './settings-controls';

type UsageMetrics = Record<string, number | string | null>;
type TavilyUsage = { key: UsageMetrics; account: UsageMetrics; fetchedAt: string };

function count(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value.toLocaleString() : 'Unavailable';
}

function pair(used: unknown, limit: unknown): string {
  return `${count(used)} / ${count(limit)} credits`;
}

/** Refreshes only while this Settings section is mounted and the saved key is stable. */
export function appendTavilyUsageSettings(content: HTMLElement, serverUp: boolean) {
  const group = appendSettingsGroup(content, 'Tavily usage',
    'Reported by Tavily. Account and key totals can include activity outside Minnow.',
    'integrations.search.tavilyUsage', { emphasis: true });
  const status = document.createElement('p');
  status.className = 'settings-field-hint';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const metrics = document.createElement('div');
  metrics.setAttribute('role', 'group');
  metrics.setAttribute('aria-label', 'Tavily credit usage');
  const details = document.createElement('details');
  const summary = document.createElement('summary');
  summary.textContent = 'Usage by endpoint';
  const table = document.createElement('table');
  table.className = 'settings-tavily-breakdown';
  details.append(summary, table);
  details.hidden = true;
  const updated = document.createElement('p');
  updated.className = 'settings-field-hint';
  let key = '';
  let generation = 0;
  let controller: AbortController | null = null;

  function metric(label: string, value: string): void {
    const row = document.createElement('div');
    row.className = 'settings-row';
    const title = document.createElement('span');
    title.className = 'settings-row__label';
    title.textContent = label;
    const output = document.createElement('span');
    output.className = 'settings-row__control';
    output.textContent = value;
    row.append(title, output);
    metrics.append(row);
  }

  function render(data: TavilyUsage): void {
    metrics.replaceChildren();
    metric('Plan', typeof data.account.current_plan === 'string' ? data.account.current_plan : 'Unavailable');
    metric('Account plan usage', pair(data.account.plan_usage, data.account.plan_limit));
    metric('Saved key usage', pair(data.key.usage, data.key.limit));
    if (data.account.paygo_usage !== null || data.account.paygo_limit !== null) {
      metric('Pay-as-you-go usage', pair(data.account.paygo_usage, data.account.paygo_limit));
    }
    table.replaceChildren();
    const header = document.createElement('tr');
    for (const text of ['Endpoint', 'Saved key credits', 'Account credits']) {
      const th = document.createElement('th');
      th.scope = 'col';
      th.textContent = text;
      header.append(th);
    }
    table.append(header);
    for (const name of ['search', 'map', 'extract', 'crawl', 'research']) {
      const row = document.createElement('tr');
      const th = document.createElement('th');
      th.scope = 'row';
      th.textContent = name[0].toUpperCase() + name.slice(1);
      row.append(th);
      for (const scope of [data.key, data.account]) {
        const td = document.createElement('td');
        td.textContent = count(scope[`${name}_usage`]);
        row.append(td);
      }
      table.append(row);
    }
    details.hidden = false;
    const timestamp = new Date(data.fetchedAt);
    updated.textContent = Number.isFinite(timestamp.getTime())
      ? `Last refreshed ${timestamp.toLocaleString()}` : 'Refresh time unavailable';
  }

  async function refresh(force = false): Promise<void> {
    controller?.abort();
    const requestGeneration = ++generation;
    if (!serverUp || !key) {
      group.removeAttribute('aria-busy');
      metrics.replaceChildren();
      details.hidden = true;
      updated.textContent = '';
      status.textContent = serverUp ? 'Add and save a Tavily API key to see usage.' : 'Open or restart Minnow to see Tavily usage.';
      refreshButton.disabled = true;
      return;
    }
    controller = new AbortController();
    refreshButton.disabled = true;
    group.setAttribute('aria-busy', 'true');
    status.textContent = 'Loading Tavily usage…';
    try {
      const response = await fetch(`/api/config/search/tavily-usage${force ? '?refresh=1' : ''}`, {
        cache: 'no-store', signal: controller.signal,
      });
      const data = await response.json();
      if (requestGeneration !== generation || !group.isConnected) return;
      if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : 'Could not load Tavily usage.');
      if (!data.key || !data.account) throw new Error('Usage data unavailable.');
      render(data);
      status.textContent = '';
    } catch (error) {
      if (requestGeneration !== generation || !group.isConnected) return;
      status.textContent = error instanceof Error ? error.message : 'Could not load Tavily usage.';
      if (metrics.childElementCount) status.textContent += ' Showing previously refreshed usage.';
    } finally {
      if (requestGeneration === generation) {
        refreshButton.disabled = !serverUp || !key;
        group.removeAttribute('aria-busy');
      }
    }
  }

  const actions = createSettingsActionsRow([{ label: 'Refresh', id: 'settingsTavilyUsageRefresh',
    disabled: true, onClick: () => { void refresh(true); } }]);
  const refreshButton = actions.querySelector('button')!;
  group.append(metrics, status, details, updated, actions);

  return {
    setSavedKey(savedKey: string): void {
      const next = savedKey.trim();
      if (next === key && generation > 0) return;
      key = next;
      metrics.replaceChildren();
      table.replaceChildren();
      details.hidden = true;
      updated.textContent = '';
      void refresh();
    },
  };
}

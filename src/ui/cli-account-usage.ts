import '../styles/cli-account-usage.css';
import { AGENT_CLI_USAGE_NAMES, fetchAgentCliAccountUsage, type AgentCliAccountUsage, type AgentCliKind } from '../models/agent-clis';
import { isRenderIdle, subscribeRenderIdle } from '../boot/render-idle';

export interface AccountUsageView {
  root: HTMLElement;
  start: () => void;
  stop: () => void;
  refresh: (force?: boolean) => Promise<void>;
}

export function accountUsageSummary(usage: AgentCliAccountUsage | null): string {
  if (!usage || !usage.windows.length || !['ready', 'stale'].includes(usage.status)) return 'Usage unavailable';
  const used = Math.max(...usage.windows.map(row => row.usedPercent));
  return `${Math.max(0, Math.floor(100 - used))}% left${usage.status === 'stale' ? ' · last known' : ''}`;
}

function localTime(value: string): string {
  return new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function createAccountUsageView(
  kind: AgentCliKind,
  options: {
    request?: typeof fetchAgentCliAccountUsage;
    onChange?: (usage: AgentCliAccountUsage | null) => void;
    visible?: () => boolean;
  } = {},
): AccountUsageView {
  const root = document.createElement('section');
  root.className = 'cli-account-usage';
  root.setAttribute('aria-label', `${AGENT_CLI_USAGE_NAMES[kind]} account usage`);
  const heading = document.createElement('div');
  heading.className = 'cli-account-usage__heading';
  const title = document.createElement('h3');
  title.textContent = 'Account usage';
  const refreshButton = document.createElement('button');
  refreshButton.type = 'button';
  refreshButton.className = 'cli-account-usage__refresh';
  refreshButton.textContent = 'Refresh';
  refreshButton.setAttribute('aria-label', `Refresh ${AGENT_CLI_USAGE_NAMES[kind]} account usage`);
  heading.append(title, refreshButton);
  const status = document.createElement('p');
  status.className = 'cli-account-usage__status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const rows = document.createElement('div');
  rows.className = 'cli-account-usage__windows';
  const metadata = document.createElement('p');
  metadata.className = 'cli-account-usage__metadata';
  root.append(heading, status, rows, metadata);
  let usage: AgentCliAccountUsage | null = null;
  let active = false;
  let controller: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let unsubscribe: (() => void) | undefined;
  const visible = (): boolean => !isRenderIdle() && root.isConnected && (options.visible?.() ?? true);

  function render(): void {
    root.setAttribute('aria-busy', String(Boolean(controller)));
    refreshButton.textContent = controller ? 'Refreshing…' : 'Refresh';
    const retryAt = usage?.retryAt ? Date.parse(usage.retryAt) : 0;
    refreshButton.disabled = Boolean(controller) || retryAt > Date.now();
    refreshButton.title = retryAt > Date.now() ? `Try again after ${localTime(usage!.retryAt!)}` : '';
    const expired = usage?.windows.some(row => row.resetsAt && Date.parse(row.resetsAt) <= Date.now());
    status.textContent = !usage ? 'Checking account usage…'
      : usage.status === 'stale' ? `Showing last-known usage. ${usage.message ?? ''}`
        : usage.message ?? (expired ? 'A reset time has passed. Refresh to check the current allowance.' : 'Allowance shared across your account.');
    status.dataset.state = usage?.status ?? 'loading';
    rows.replaceChildren();
    for (const row of usage?.windows ?? []) {
      const item = document.createElement('div');
      item.className = 'cli-account-usage__window';
      const label = document.createElement('span');
      label.textContent = row.label;
      const remaining = Math.max(0, Math.floor(100 - row.usedPercent));
      const value = document.createElement('strong');
      value.textContent = `${remaining}% left`;
      const meter = document.createElement('progress');
      meter.max = 100;
      meter.value = Math.max(0, Math.min(100, remaining));
      meter.setAttribute('aria-label', `${row.label} allowance remaining`);
      meter.dataset.tone = remaining <= 10 ? 'danger' : remaining <= 25 ? 'warning' : 'normal';
      const reset = document.createElement('span');
      reset.className = 'cli-account-usage__reset';
      reset.textContent = row.resetsAt ? `Resets ${localTime(row.resetsAt)}` : 'Reset time unavailable';
      item.append(label, value, meter, reset);
      rows.append(item);
    }
    const parts = [usage?.plan, usage?.fetchedAt ? `Updated ${localTime(usage.fetchedAt)}` : null];
    if (usage?.credits?.unlimited) parts.push('Unlimited credits');
    else if (usage?.credits?.balance != null) parts.push(`Credits: ${usage.credits.balance}`);
    if (usage?.retryAt && retryAt > Date.now()) parts.push(`Retry after ${localTime(usage.retryAt)}`);
    metadata.textContent = parts.filter(Boolean).join(' · ');
    metadata.hidden = !metadata.textContent;
  }

  async function refresh(force = false): Promise<void> {
    if (!active || controller || (!force && !visible())) return;
    const requestController = new AbortController();
    controller = requestController;
    render();
    try {
      const next = await (options.request ?? fetchAgentCliAccountUsage)(kind, { refresh: force, signal: requestController.signal });
      if (!active || requestController.signal.aborted) return;
      usage = next;
    } catch {
      if (!active || requestController.signal.aborted) return;
      const previous = usage?.fetchedAt && Date.now() - Date.parse(usage.fetchedAt) <= 60 * 60_000 ? usage : null;
      usage = { ...(previous ?? { kind, windows: [], plan: null, fetchedAt: null }),
        status: previous?.windows.length ? 'stale' : 'error', checkedAt: new Date().toISOString(), retryAt: null,
        message: 'Could not reach account usage. Try refreshing again.' };
    } finally {
      if (controller === requestController) {
        controller = null;
        if (active) { render(); options.onChange?.(usage); }
      }
    }
  }

  function poll(): void {
    timer = setTimeout(() => {
      if (!active) return;
      if (visible()) void refresh();
      render();
      poll();
    }, 60_000);
  }
  refreshButton.addEventListener('click', () => void refresh(true));
  render();
  return {
    root, refresh,
    start() {
      if (active) return;
      active = true;
      unsubscribe = subscribeRenderIdle(idle => { if (!idle && visible()) void refresh(); });
      void refresh();
      poll();
    },
    stop() {
      active = false;
      controller?.abort();
      controller = null;
      clearTimeout(timer);
      unsubscribe?.();
      unsubscribe = undefined;
    },
  };
}

import '../styles/cli-account-usage.css';
import { fetchProviderAccountUsage, hasProviderUsage, type ProviderAccountUsage, type ProviderUsageMetric } from '../providers/account-usage';

export function providerMetricText(metric: ProviderUsageMetric): string {
  return (['remaining', 'used', 'limit'] as const).flatMap(key => {
    const value = metric[key];
    return typeof value === 'number' && Number.isFinite(value)
      ? [value.toLocaleString(undefined, { maximumFractionDigits: 8 }) + ' ' + metric.unit + ' ' + key] : [];
  }).join(' · ');
}
export function createProviderAccountUsageView(id: string, options: {
  visible?: () => boolean;
  onChange?: (usage: ProviderAccountUsage) => void;
  request?: typeof fetchProviderAccountUsage;
} = {}) {
  const root = document.createElement('section');
  root.className = 'cli-account-usage provider-account-usage';
  root.setAttribute('aria-label', 'Provider account usage');
  const heading = document.createElement('div');
  heading.className = 'cli-account-usage__heading';
  const title = document.createElement('h3');
  title.textContent = 'Account usage';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'cli-account-usage__refresh';
  button.textContent = 'Refresh';
  heading.append(title, button);
  const status = document.createElement('p');
  status.className = 'cli-account-usage__status';
  status.setAttribute('role', 'status');
  const rows = document.createElement('div');
  rows.className = 'cli-account-usage__windows';
  const metadata = document.createElement('p');
  metadata.className = 'cli-account-usage__metadata';
  root.append(heading, status, rows, metadata);
  let active = false;
  let revision = 0;
  let loading = false;
  const visible = () => !document.hidden && (options.visible?.() ?? root.isConnected);
  async function refresh(force = false): Promise<void> {
    if (!active || loading || !visible()) return;
    loading = true;
    const current = ++revision;
    button.disabled = true;
    status.textContent = 'Checking account usage…';
    const usage = await (options.request ?? fetchProviderAccountUsage)(id, force);
    if (!active || current !== revision) return;
    loading = false;
    button.disabled = false;
    rows.replaceChildren();
    status.textContent = hasProviderUsage(usage) ? 'Reported by provider.'
      : usage.status === 'unsupported' ? 'This provider does not expose account usage.'
      : 'Account usage unavailable.';
    if (hasProviderUsage(usage)) {
      for (const metric of usage.metrics) {
        const values = providerMetricText(metric);
        if (!values) continue;
        const row = document.createElement('div');
        row.className = 'cli-account-usage__window';
        const label = document.createElement('span');
        label.textContent = metric.label;
        const value = document.createElement('strong');
        value.textContent = values;
        row.append(label, value);
        if (metric.resetsAt && Number.isFinite(Date.parse(metric.resetsAt))) {
          const reset = document.createElement('span');
          reset.className = 'cli-account-usage__reset';
          reset.textContent = 'Resets ' + new Date(metric.resetsAt).toLocaleString();
          row.append(reset);
        }
        rows.append(row);
      }
    }
    metadata.textContent = 'Checked ' + new Date(usage.checkedAt).toLocaleString();
    options.onChange?.(usage);
  }
  const onVisible = () => { if (visible()) void refresh(); };
  button.addEventListener('click', () => { void refresh(true); });
  return {
    root, refresh,
    start() {
      if (!active) { active = true; document.addEventListener('visibilitychange', onVisible); }
      void refresh();
    },
    stop() {
      active = false; revision++; loading = false;
      document.removeEventListener('visibilitychange', onVisible);
    },
  };
}

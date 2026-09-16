import { appendSettingsGroup } from './settings-layout';
import { createSettingsActionsRow, createSettingsInputRow, createSettingsSelectRow } from './settings-controls';
import '../styles/settings-harness-evals.css';

type Checks = { uv: boolean; git: boolean; node: boolean; docker: boolean };
type Score = { trials: number; passed: number; errors: number; ungraded: number; total_cost_usd: number | null };
type Run = { id: string; action: string; status: string; startedAt: string; log?: string;
  expectedTrials?: number; config?: { model: string }; summary?: Record<string, Score> | null };
type Snapshot = { available: boolean; installed: boolean; runtime: boolean; datasets: boolean;
  checks: Checks | null; active: Run | null; history: Run[] };
let dispose: (() => void) | undefined;
export function disposeHarnessEvalsSettingsSection(): void { dispose?.(); dispose = undefined; }
async function api<T>(action: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/harness-evals/${action}`, body === undefined
    ? { cache: 'no-store' }
    : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Could not reach benchmark controls');
  return data as T;
}
function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  return node;
}

export async function renderHarnessEvalsSettingsSection(): Promise<void> {
  disposeHarnessEvalsSettingsSection();
  const mount = document.getElementById('settingsHarnessEvalsBody');
  if (!mount) return;
  mount.replaceChildren(); mount.classList.add('harness-evals');
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  dispose = () => { disposed = true; clearTimeout(timer); };
  let snapshot: Snapshot | null = null;
  let pending = false;
  const setup = appendSettingsGroup(mount, 'Setup',
    'Compare Minnow Build with its minimal shell profile on the same DeepSWE and Terminal-Bench tasks. These are local subsets, not full leaderboard scores.', 'advanced.harness');
  const readiness = el('p', 'Checking benchmark setup…'); readiness.className = 'field-hint';
  const errors = el('p'); errors.setAttribute('role', 'alert'); errors.hidden = true;
  setup.append(readiness, errors);
  function showError(error: unknown) {
    if (disposed) return;
    errors.textContent = error instanceof Error ? error.message : String(error); errors.hidden = false;
  }
  async function action(name: string, body?: unknown) {
    pending = true; errors.hidden = true; updateButtons();
    try { await api(name, body); await refresh(); }
    catch (error) { showError(error); }
    finally { pending = false; updateButtons(); }
  }
  const setupActions = createSettingsActionsRow([
    { label: 'Check setup', onClick: () => void action('checks') },
    { label: 'Install evaluator & datasets', onClick: () => void action('setup', {}) },
    { label: 'Build runtime', onClick: () => void action('runtime', {}) },
  ]);
  setup.append(setupActions);
  const hint = el('p', 'Requires a Minnow source checkout, Node, Git, uv and Docker with Linux containers. Setup downloads dependencies and tasks; model calls begin only when you start a comparison.');
  hint.className = 'field-hint'; setup.append(hint);
  const comparison = appendSettingsGroup(mount, 'New comparison');
  const form = el('form'); comparison.append(form);
  const provider = createSettingsSelectRow('Provider', { options: [{ value: '', label: 'Loading providers…' }], description: 'Uses the credentials saved in Models → Providers.' });
  const model = createSettingsInputRow('Model ID', { required: true, placeholder: 'Exact model ID from your provider', autocomplete: 'off' });
  const models = el('datalist'); models.id = 'harnessEvalModels'; model.input.setAttribute('list', models.id);
  let modelRequest = 0;
  async function loadModels() {
    const request = ++modelRequest;
    models.replaceChildren();
    if (!provider.select.value) return;
    try {
      const response = await fetch(`/api/providers/${encodeURIComponent(provider.select.value)}/models`);
      if (!response.ok) return; // Manual IDs work for providers without a catalog.
      const data = await response.json() as { data?: { id: string }[] };
      if (disposed || request !== modelRequest) return;
      for (const item of data.data || []) {
        if (typeof item.id !== 'string') continue;
        const option = el('option'); option.value = item.id; models.append(option);
      }
    } catch { /* The model field remains editable when discovery is offline. */ }
  }
  const preset = createSettingsSelectRow('Task sample', { options: [
    { value: 'smoke', label: 'Small trial · 10 tasks' }, { value: 'pilot', label: 'Pilot · 30 tasks' },
  ] });
  const attempts = createSettingsInputRow('Attempts per task', { type: 'number', value: '1', min: '1', max: '5', step: '1', required: true });
  form.append(provider.row, model.row, models, preset.row, attempts.row);
  const advanced = el('details'); advanced.append(el('summary', 'Run limits'));
  const fields = {
    max_steps: createSettingsInputRow('Maximum steps', { type: 'number', value: '100', min: '1', max: '1000', required: true }),
    max_tokens: createSettingsInputRow('Output tokens per call', { type: 'number', value: '4096', min: '128', max: '131072', required: true }),
    context_window: createSettingsInputRow('Model context window', { type: 'number', value: '32768', min: '1024', max: '1048576', required: true, description: 'Match the context available on your loaded model.' }),
    timeout: createSettingsInputRow('Seconds per attempt', { type: 'number', value: '600', min: '60', max: '7200', required: true }),
  };
  advanced.append(...Object.values(fields).map(f => f.row));
  advanced.addEventListener('invalid', () => { advanced.open = true; }, true);
  const count = el('p'); count.className = 'field-hint';
  function updateCount() {
    const n = (preset.select.value === 'pilot' ? 30 : 10) * Number(attempts.input.value) * 2;
    count.textContent = `${Number.isFinite(n) ? n : 0} attempts across both profiles, one at a time. Provider charges apply. Keep Minnow open while running.`;
  }
  preset.select.addEventListener('change', updateCount);
  attempts.input.addEventListener('input', updateCount); updateCount();
  const runActions = createSettingsActionsRow([
    { label: 'Start comparison', variant: 'primary', type: 'submit' },
    { label: 'Stop', onClick: () => void action('stop', {}) },
  ]);
  form.append(advanced, count, runActions);
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (!form.reportValidity() || !provider.select.value) return;
    void action('run', { providerId: provider.select.value, model: model.input.value, preset: preset.select.value,
      attempts: Number(attempts.input.value), ...Object.fromEntries(Object.entries(fields).map(([key, f]) => [key, Number(f.input.value)])) });
  });
  const activity = appendSettingsGroup(mount, 'Activity');
  const state = el('p', 'No benchmark operation running.'); state.setAttribute('role', 'status');
  const details = el('details'); details.append(el('summary', 'Operation log'));
  const log = el('pre'); log.tabIndex = 0; log.setAttribute('aria-label', 'Benchmark operation log'); details.append(log);
  activity.append(state, details);
  const results = appendSettingsGroup(mount, 'Recent comparisons', 'Pass counts come from the task verifier. Failed and ungraded trials remain in the denominator.');
  const history = el('div'); results.append(history);
  let historyKey = '';
  function renderHistory(runs: Run[]) {
    const comparisons = runs.filter(r => r.action === 'run');
    const key = JSON.stringify(comparisons);
    if (key === historyKey) return;
    historyKey = key; history.replaceChildren();
    if (!comparisons.length) { history.append(el('p', 'Your comparisons and verifier results will appear here.')); return; }
    for (const run of comparisons) {
      const entry = el('details');
      entry.append(el('summary', `${run.config?.model || 'Comparison'} · ${run.status} · ${new Date(run.startedAt).toLocaleString()}`));
      entry.append(el('p', `${run.expectedTrials} planned attempts. Results: evals/harness/artifacts/${run.id}/jobs`));
      if (run.summary) {
        const table = el('table'); table.className = 'harness-evals__results';
        const header = el('tr');
        for (const title of ['Profile', 'Passed', 'Errors', 'Ungraded', 'Cost']) {
          const th = el('th', title); th.scope = 'col'; header.append(th);
        }
        const head = el('thead'); head.append(header); table.append(head);
        const body = el('tbody');
        for (const [profile, score] of Object.entries(run.summary)) {
          const row = el('tr');
          for (const value of [profile, `${score.passed}/${score.trials}`, score.errors, score.ungraded,
            score.total_cost_usd == null ? 'Not reported' : `$${score.total_cost_usd.toFixed(2)}`]) row.append(el('td', String(value)));
          body.append(row);
        }
        table.append(body);
        const scroll = el('div'); scroll.className = 'harness-evals__table-wrap'; scroll.append(table); entry.append(scroll);
      } else entry.append(el('p', 'No verifier report yet. Interrupted runs may have partial results saved on disk.'));
      history.append(entry);
    }
  }
  function updateButtons() {
    const busy = pending || snapshot?.active?.status === 'running';
    const buttons = setupActions.querySelectorAll('button');
    buttons[0].disabled = pending;
    buttons[1].disabled = !!busy || !snapshot?.available || !snapshot.checks?.uv || !snapshot.checks?.git || !snapshot.checks?.node;
    buttons[2].disabled = !!busy || !snapshot?.installed || !snapshot.checks?.docker;
    const runButtons = runActions.querySelectorAll('button');
    runButtons[0].disabled = !!busy || !snapshot?.available || !snapshot.installed || !snapshot.runtime || !snapshot.datasets || !snapshot.checks?.docker || !snapshot.checks?.node || !snapshot.checks?.uv || !snapshot.checks?.git || !provider.select.value;
    runButtons[1].disabled = pending || snapshot?.active?.status !== 'running';
  }
  async function refresh() {
    const next = await api<Snapshot>('status');
    if (disposed || !mount?.isConnected) return;
    snapshot = next;
    const labels: string[] = [];
    if (!next.available) labels.push('Available when running Minnow from a source checkout.');
    else {
      if (next.checks) for (const [name, ready] of Object.entries(next.checks)) {
        if (name !== 'checkedAt') labels.push(`${name === 'docker' ? 'Linux Docker' : name}: ${ready ? 'ready' : 'unavailable'}`);
      }
      labels.push(`Evaluator: ${next.installed ? 'installed' : 'not installed'}`, `Datasets: ${next.datasets ? 'downloaded' : 'not downloaded'}`, `Runtime: ${next.runtime ? 'built' : 'not built'}`);
    }
    readiness.textContent = labels.join(' · ');
    state.textContent = next.active ? `${({ setup: 'Evaluator setup', runtime: 'Runtime build', run: 'Comparison' } as Record<string, string>)[next.active.action]}: ${next.active.status}` : 'No benchmark operation running.';
    const latest = next.active || next.history[0]; log.textContent = latest?.log || 'Operation output will appear here.';
    renderHistory(next.history); updateButtons();
  }
  provider.select.addEventListener('change', () => { updateButtons(); void loadModels(); });
  async function poll() {
    if (disposed || !mount?.isConnected) return;
    if (!document.hidden && !mount.closest('[hidden]')) {
      try { await refresh(); } catch (error) { showError(error); }
    }
    if (!disposed) timer = setTimeout(() => void poll(), 2500);
  }
  try {
    const response = await fetch('/api/providers');
    if (!response.ok) throw new Error('Could not load providers. Open or restart Minnow.');
    const data = await response.json() as { activeProviderId: string; providers: { id: string; label: string; apiKind: string; enabled: boolean }[] };
    if (disposed) return;
    const providers = data.providers.filter(p => p.enabled !== false && ['openai-v1', 'lm-studio-v0'].includes(p.apiKind));
    provider.select.replaceChildren(...providers.map(p => { const option = el('option', p.label); option.value = p.id; return option; }));
    if (!providers.length) { const option = el('option', 'Add a Chat Completions provider in Models'); option.value = ''; provider.select.append(option); }
    else if (providers.some(p => p.id === data.activeProviderId)) provider.select.value = data.activeProviderId;
    await refresh(); void action('checks'); void loadModels();
  } catch (error) { showError(error); }
  updateButtons(); timer = setTimeout(() => void poll(), 2500);
}

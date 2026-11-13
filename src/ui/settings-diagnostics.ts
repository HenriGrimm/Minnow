import { showToast } from './toast';
import { appConfirm } from './app-dialog';
/**
 * Settings → Advanced → Health & diagnostics — subsystem probes and local error viewer.
 */

import '../styles/settings-general.css';
import '../styles/settings-about.css';
import { detectConfigServer } from '../config/storage-mode';
import {
  loadDiagnosticsPrefs,
  saveDiagnosticsPref,
} from '../diagnostics/prefs';
import {
  appendSettingsGroup,
  linkToSettingsSection,
} from './settings-layout';
import {
  appendSettingsOfflineHint,
  createSettingsActionsRow,
  runSettingsAction,
} from './settings-controls';
import { setStatus } from './status';
import { createSettingsToggleRow } from './settings-switch';
import {
  fetchDiagnosticsHealth,
  healthRowsFromPayload,
  type DiagnosticsHealthPayload,
} from './health-strip';
import { createIcon } from './icon';

type DiagnosticErrorGroup = {
  signature: string;
  count: number;
  lastAt?: string;
  source?: string;
  kind?: string;
  message?: string;
  stack?: string;
};

type SourceFilter = 'all' | 'renderer' | 'server' | 'electron';

// ── Fetch ────────────────────────────────────────────────────────────────────

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function clearMount(id: string): HTMLElement | null {
  const mount = document.getElementById(id);
  if (!mount) return null;
  mount.replaceChildren();
  return mount;
}

/** Human-readable timestamp for diagnostic meta rows. */
function formatDiagnosticTime(iso?: string): string {
  if (!iso) return '';
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return iso;
  return new Date(parsed).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'medium',
  });
}

/** Load grouped errors for the viewer. */
async function fetchDiagnosticErrors(source: SourceFilter): Promise<DiagnosticErrorGroup[]> {
  const params = new URLSearchParams({ source, maxLines: '200' });
  const res = await fetch(`/api/diagnostics/errors?${params}`, { cache: 'no-store' });
  if (!res.ok) throw new Error('Could not load errors');
  const body = (await res.json()) as { errors?: DiagnosticErrorGroup[] };
  return body.errors ?? [];
}

/** Load tail log lines for the viewer. */
async function fetchDiagnosticLogs(source: SourceFilter): Promise<Record<string, unknown>[]> {
  const params = new URLSearchParams({ source, maxLines: '80' });
  const res = await fetch(`/api/diagnostics/logs?${params}`, { cache: 'no-store' });
  if (!res.ok) throw new Error('Could not load logs');
  const body = (await res.json()) as { lines?: Record<string, unknown>[] };
  return body.lines ?? [];
}

async function fetchDiagnosticReport(): Promise<string> {
  const res = await fetch('/api/diagnostics/report', { cache: 'no-store' });
  if (!res.ok) throw new Error('Report unavailable');
  const { markdown } = (await res.json()) as { markdown?: string };
  if (!markdown) throw new Error('Report is empty');
  return markdown;
}

function renderChecks(host: HTMLElement, health: DiagnosticsHealthPayload | null, onLastError: () => void): void {
  const list = el('ul', 'settings-health-checks');
  list.setAttribute('aria-label', 'Subsystem checks');
  for (const { label, detail, ok } of healthRowsFromPayload(health)) {
    const item = el('li', 'settings-health-checks__row');
    item.dataset.status = ok === true ? 'ok' : ok === false ? 'error' : 'unknown';
    const icon = createIcon(ok === true ? 'check' : ok === false ? 'warning' : 'help');
    const text = el('span', 'settings-health-checks__label');
    text.appendChild(el('span', '', label));
    if (detail) text.appendChild(el('span', 'settings-health-checks__detail', detail));
    const status = ok === true ? 'OK' : ok === false ? 'Unavailable' : 'Unknown';
    item.append(icon, text, el('span', 'settings-health-checks__status', status));
    list.appendChild(item);
  }
  host.replaceChildren(list);
  if (health?.lastError?.message) {
    const lastError = el('button', 'settings-inline-link settings-health-checks__last', 'View last error');
    lastError.type = 'button';
    lastError.addEventListener('click', onLastError);
    host.appendChild(lastError);
  }
}

// ── Lists ────────────────────────────────────────────────────────────────────

function renderFilterRow(
  onChange: (source: SourceFilter) => void,
  active: SourceFilter,
): HTMLElement {
  const row = el('div', 'diagnostics-filter-row');
  row.setAttribute('role', 'tablist');
  row.setAttribute('aria-label', 'Filter diagnostics by source');

  const filters: Array<{ id: SourceFilter; label: string }> = [
    { id: 'all', label: 'All' },
    { id: 'renderer', label: 'Renderer' },
    { id: 'server', label: 'Server' },
    { id: 'electron', label: 'Electron' },
  ];

  for (const f of filters) {
    const btn = el('button', 'diagnostics-filter-btn', f.label);
    btn.type = 'button';
    btn.dataset.source = f.id;
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', String(f.id === active));
    btn.classList.toggle('is-active', f.id === active);
    btn.addEventListener('click', () => onChange(f.id));
    row.appendChild(btn);
  }

  return row;
}

function renderErrorList(host: HTMLElement, errors: DiagnosticErrorGroup[]): void {
  host.replaceChildren();

  if (!errors.length) {
    host.appendChild(el('p', 'diagnostics-empty', 'No captured errors yet.'));
    return;
  }

  const list = el('ul', 'diagnostics-error-list');
  list.setAttribute('aria-label', 'Grouped diagnostic errors');

  for (const group of errors) {
    const item = el('li', 'diagnostics-error-item');
    const head = el('div', 'diagnostics-error-item__head');

    const titleWrap = el('div', 'diagnostics-error-item__title-wrap');
    titleWrap.appendChild(
      el('span', 'diagnostics-error-item__title', group.message || group.signature),
    );

    const badge = el('span', 'diagnostics-error-item__badge', `×${group.count}`);
    badge.setAttribute('aria-label', `${group.count} occurrences`);
    head.append(titleWrap, badge);
    item.appendChild(head);

    const meta = el('div', 'diagnostics-error-item__meta');
    if (group.source) {
      meta.appendChild(el('span', 'diagnostics-source-badge', group.source));
    }
    if (group.lastAt) {
      const time = el('time', 'diagnostics-error-item__time');
      time.dateTime = group.lastAt;
      time.textContent = formatDiagnosticTime(group.lastAt);
      meta.appendChild(time);
    }
    if (meta.childElementCount) item.appendChild(meta);

    if (group.stack) {
      const details = el('details', 'diagnostics-error-item__details');
      const summary = el('summary', 'diagnostics-error-item__summary', 'Stack trace');
      const pre = el('pre', 'diagnostics-error-item__stack', group.stack);
      details.append(summary, pre);
      item.appendChild(details);
    }

    list.appendChild(item);
  }

  host.appendChild(list);
}

function renderLogTail(host: HTMLElement, lines: Record<string, unknown>[]): void {
  host.replaceChildren();

  if (!lines.length) {
    host.appendChild(el('p', 'diagnostics-empty', 'Log tail is empty.'));
    return;
  }

  const pre = el('pre', 'diagnostics-log-tail');
  pre.textContent = lines.map((line) => JSON.stringify(line)).join('\n');
  host.appendChild(pre);
}

// ── Render ───────────────────────────────────────────────────────────────────

/** Populate Settings → Advanced → Health & diagnostics. */
export async function renderDiagnosticsSettingsSection(): Promise<void> {
  const mount = clearMount('settingsDiagnosticsBody');
  if (!mount) return;

  const shell = el('div', 'settings-general');
  mount.appendChild(shell);

  const serverUp = (await detectConfigServer()) === 'server';
  if (!serverUp) {
    appendSettingsOfflineHint(
      shell,
      'Diagnostics require Minnow running locally. Crash logs may still exist under <code>~/.minnow/logs/</code>.',
    );
  }

  const content = el('div', 'settings-general__content');
  shell.appendChild(content);

  const checks = el('div', 'settings-health');
  checks.dataset.settingsSearchKey = 'advanced.diagnostics.health';
  const toolbar = el('div', 'settings-health__toolbar');
  const checkButton = el('button', 'settings-inline-btn settings-health__primary');
  checkButton.type = 'button';
  checkButton.append(createIcon('refresh'), 'Run checks');
  checkButton.disabled = !serverUp;
  const exportButton = el('button', 'settings-inline-btn', 'Export diagnostics');
  exportButton.type = 'button';
  exportButton.disabled = !serverUp;
  toolbar.append(checkButton, exportButton);
  const healthHost = el('div', 'diagnostics-health-host');
  healthHost.setAttribute('aria-live', 'polite');
  checks.append(toolbar, healthHost);
  content.appendChild(checks);

  const issuesPrefs = loadDiagnosticsPrefs();
  const issuesGroup = appendSettingsGroup(
    content,
    'Issues app',
    'Optional auto-filing of renderer crashes as bug cards.',
    'advanced.diagnostics.fileErrorsToIssues',
    { emphasis: true },
  );
  const { row: fileIssuesRow } = createSettingsToggleRow('File renderer errors to Issues', {
    checked: issuesPrefs.fileErrorsToIssues,
    description:
      'When enabled, uncaught renderer errors create bug cards in the Issues app. Off by default.',
    searchKey: 'advanced.diagnostics.fileErrorsToIssues',
    onChange: (next) => saveDiagnosticsPref('fileErrorsToIssues', next),
  });
  issuesGroup.appendChild(fileIssuesRow);

  const diagnostics = appendSettingsGroup(
    content,
    'Error log',
    'Grouped by signature with a rotating JSONL tail from ~/.minnow/logs/.',
    'advanced.diagnostics',
    { emphasis: true },
  );
  const installLink = linkToSettingsSection('View version and runtime details', 'about');
  installLink.classList.add('settings-health-checks__last');

  let activeFilter: SourceFilter = 'all';
  const filterHost = el('div', 'diagnostics-filter-host');
  const errorsSection = el('section', 'diagnostics-subsection');
  errorsSection.appendChild(el('h4', 'diagnostics-subsection__title', 'Errors'));
  const errorsHost = el('div', 'diagnostics-errors-host');
  errorsSection.appendChild(errorsHost);

  const logsSection = el('section', 'diagnostics-subsection');
  logsSection.appendChild(el('h4', 'diagnostics-subsection__title', 'Log tail'));
  const logsHost = el('div', 'diagnostics-logs-host');
  logsSection.appendChild(logsHost);

  diagnostics.append(filterHost, errorsSection, logsSection);

  const actions = createSettingsActionsRow(
    [
      {
        label: 'Copy report',
        variant: 'primary',
        onClick: () => {
          void (async () => {
            try {
              await navigator.clipboard.writeText(await fetchDiagnosticReport());
              showToast('Diagnostic report copied');
            } catch {
              setStatus('err', 'Could not copy report');
            }
          })();
        },
      },
      {
        label: 'Refresh',
        onClick: () => {
          void refreshViewer();
        },
      },
      {
        label: 'Clear',
        variant: 'danger',
        title: 'Delete local diagnostic logs under ~/.minnow/logs/',
        onClick: () => {
          void runSettingsAction(actions.querySelector('button:last-child'), 'Clearing diagnostics…', async () => {
            if (
              !await appConfirm(
                'Clear all captured diagnostic errors and log tail?\n\nThis deletes local JSONL files under ~/.minnow/logs/ and cannot be undone.',
              )
            ) {
              return;
            }
            if (!serverUp) {
              setStatus('err', 'Diagnostics server offline');
              return;
            }
            try {
              const res = await fetch('/api/diagnostics/clear', { method: 'POST' });
              if (!res.ok) throw new Error('Clear failed');
              await refreshViewer();
            } catch {
              setStatus('err', 'Could not clear diagnostics');
            }
          });
        },
      },
    ],
    { searchKey: 'advanced.diagnostics.actions' },
  );
  diagnostics.append(actions, installLink);

  const scrollToErrors = (): void => {
    errorsSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  function setActiveFilter(source: SourceFilter): void {
    activeFilter = source;
    for (const btn of filterHost.querySelectorAll<HTMLButtonElement>('.diagnostics-filter-btn')) {
      const isActive = btn.dataset.source === source;
      btn.classList.toggle('is-active', isActive);
      btn.setAttribute('aria-selected', String(isActive));
    }
    void refreshViewer();
  }

  let refreshVersion = 0;
  async function refreshViewer(): Promise<void> {
    const version = ++refreshVersion;
    const filter = activeFilter;
    const health = serverUp ? await fetchDiagnosticsHealth() : null;
    if (version !== refreshVersion) return;
    renderChecks(healthHost, health, scrollToErrors);
    try {
      const [errors, logs] = await Promise.all([
        serverUp ? fetchDiagnosticErrors(filter) : Promise.resolve([]),
        serverUp ? fetchDiagnosticLogs(filter) : Promise.resolve([]),
      ]);
      if (version !== refreshVersion) return;
      renderErrorList(errorsHost, errors);
      renderLogTail(logsHost, logs);
    } catch {
      if (version !== refreshVersion) return;
      errorsHost.replaceChildren();
      errorsHost.appendChild(el('p', 'diagnostics-empty', 'Could not load diagnostics.'));
    }
  }

  filterHost.replaceChildren();
  filterHost.appendChild(renderFilterRow(setActiveFilter, activeFilter));

  checkButton.addEventListener('click', () => {
    void runSettingsAction(checkButton, 'Running checks…', refreshViewer);
  });
  exportButton.addEventListener('click', () => {
    void runSettingsAction(exportButton, 'Preparing diagnostics…', async () => {
      const report = await fetchDiagnosticReport();
      const url = URL.createObjectURL(new Blob([report], { type: 'text/markdown' }));
      const link = el('a');
      link.href = url;
      link.download = 'minnow-diagnostics.md';
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
  });
  await refreshViewer();
}

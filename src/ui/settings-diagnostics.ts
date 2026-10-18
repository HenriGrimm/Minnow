import { runSettingsAction } from './settings-controls';
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
} from './settings-controls';
import { setStatus } from './status';
import { createSettingsToggleRow } from './settings-switch';
import {
  fetchDiagnosticsHealth,
  renderHealthStrip,
  type DiagnosticsHealthPayload,
} from './health-strip';

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

  const lead = el('p', 'settings-section-lead');
  lead.append(
    'Local subsystem checks and captured errors. Nothing leaves this device. Version details are under ',
    linkToSettingsSection('About', 'about'),
    '.',
  );
  shell.appendChild(lead);

  const serverUp = await detectConfigServer();
  if (!serverUp) {
    appendSettingsOfflineHint(
      shell,
      'Diagnostics require Minnow running locally. Crash logs may still exist under <code>~/.minnow/logs/</code>.',
    );
  }

  const content = el('div', 'settings-general__content');
  shell.appendChild(content);

  let health: DiagnosticsHealthPayload | null = null;
  if (serverUp) {
    health = await fetchDiagnosticsHealth();
  }

  const healthGroup = appendSettingsGroup(
    content,
    'Subsystem health',
    'Same probes as the status strip: server, tools, memory, Brain, LSP, and PTY.',
    'advanced.diagnostics.health',
    { emphasis: true },
  );
  const healthHost = el('div', 'diagnostics-health-host');
  healthGroup.appendChild(healthHost);

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
              const res = await fetch('/api/diagnostics/report', { cache: 'no-store' });
              if (!res.ok) throw new Error('Report unavailable');
              const body = (await res.json()) as { markdown?: string };
              const text = body.markdown ?? '';
              await navigator.clipboard.writeText(text);
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
  diagnostics.appendChild(actions);

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

  async function refreshViewer(): Promise<void> {
    if (serverUp) {
      health = await fetchDiagnosticsHealth();
      renderHealthStrip(healthHost, health, { onErrorClick: scrollToErrors });
    } else {
      healthHost.replaceChildren();
      healthHost.appendChild(el('p', 'diagnostics-empty', 'Server offline'));
    }

    try {
      const [errors, logs] = await Promise.all([
        serverUp ? fetchDiagnosticErrors(activeFilter) : Promise.resolve([]),
        serverUp ? fetchDiagnosticLogs(activeFilter) : Promise.resolve([]),
      ]);
      renderErrorList(errorsHost, errors);
      renderLogTail(logsHost, logs);
    } catch {
      errorsHost.replaceChildren();
      errorsHost.appendChild(el('p', 'diagnostics-empty', 'Could not load diagnostics.'));
    }
  }

  filterHost.replaceChildren();
  filterHost.appendChild(renderFilterRow(setActiveFilter, activeFilter));

  renderHealthStrip(healthHost, health, { onErrorClick: scrollToErrors });
  await refreshViewer();
}

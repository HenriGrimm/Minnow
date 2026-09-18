import '../styles/settings-general.css';
import '../styles/settings-servers.css';

import {
  fetchManagedServerLogs,
  fetchManagedServers,
  fetchServerInstallStatus,
  installManagedServer,
  restartManagedServer,
  setManagedServerAutoStart,
  setManagedServerEnabled,
  setManagedServerPort,
  startManagedServer,
  stopManagedServer,
  uninstallManagedServer,
  type ManagedServerSummary,
  type ServerInstallJob,
  type ServerRuntimePhase,
} from '../servers/client';
import {
  appendSettingsCrosslinks,
  appendSettingsGroup,
  linkToModelsSection,
  linkToSettingsSection,
} from './settings-layout';
import { appendSettingsOfflineHint } from './settings-controls';
import { createSettingsSwitch } from './settings-switch';
import { setStatus } from './status';
import { appConfirm } from './app-dialog';
import { isLocalServerAvailable } from '../tools/config';

// ── Status ───────────────────────────────────────────────────────────────────

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const PHASE_LABELS: Record<ServerRuntimePhase, string> = {
  pending: 'Not installed',
  installing: 'Installing…',
  starting: 'Starting…',
  running: 'Running',
  stopped: 'Stopped',
  error: 'Error',
};

/** Compact status pill label + optional mono endpoint for managed server rows. */
function describeServerStatus(server: ManagedServerSummary): {
  ok: boolean;
  pill: string;
  endpoint: string | null;
} {
  if (server.job?.phase === 'installing') {
    return {
      ok: false,
      pill: 'Installing',
      endpoint: server.job.message || `${server.job.percent}%`,
    };
  }
  if (server.running) {
    return {
      ok: true,
      pill: 'Running',
      endpoint: `http://127.0.0.1:${server.port}`,
    };
  }
  if (server.installed) {
    return {
      ok: false,
      pill: PHASE_LABELS[server.phase] ?? server.phase,
      endpoint: null,
    };
  }
  return { ok: false, pill: PHASE_LABELS.pending, endpoint: null };
}

/** Status pill matching LSP row instrumentation (semantic green only when running). */
function createServerStatusPill(label: string, ok: boolean): HTMLElement {
  const pill = el(
    'span',
    `settings-lsp-pill ${ok ? 'settings-lsp-pill--running' : 'settings-lsp-pill--off'}`,
    label,
  );
  pill.setAttribute('aria-label', label);
  return pill;
}

/** Poll install job until done, error, or timeout. */
async function pollInstallJob(
  serverId: string,
  onTick: (job: ServerInstallJob | null) => void,
  maxMs = 600_000,
): Promise<'done' | 'error' | 'timeout'> {
  const started = Date.now();
  while (Date.now() - started < maxMs) {
    const job = await fetchServerInstallStatus(serverId);
    onTick(job);
    if (job?.phase === 'done') return 'done';
    if (job?.phase === 'error') return 'error';
    await new Promise((r) => setTimeout(r, 500));
  }
  return 'timeout';
}

// ── Rows ─────────────────────────────────────────────────────────────────────

/** Catalog rows shown in Models → Engine instead of here. */
const MODELS_ENGINE_SERVER_IDS = new Set(['llama-cpp', 'mlx-lm']);

function createServerRow(
  server: ManagedServerSummary,
  onRefresh: () => void,
): HTMLElement {
  const row = document.createElement('article');
  row.className = 'settings-mcp-row';
  row.setAttribute('role', 'listitem');
  row.dataset.serverId = server.id;

  const head = el('div', 'settings-mcp-row-head');
  const toggleWrap = el('div', 'settings-mcp-toggle');
  const { root: enableSwitch, input: enableInput } = createSettingsSwitch({
    checked: server.enabled,
    ariaLabel: `${server.enabled ? 'Disable' : 'Enable'} ${server.label}`,
  });
  enableInput.dataset.serverEnable = server.id;
  const identity = el('div', 'settings-mcp-row-identity');
  identity.append(el('span', 'settings-mcp-name', server.label));
  if (server.description) {
    const desc = el('span', 'settings-mcp-row-desc');
    desc.textContent = server.description;
    desc.title = server.description;
    identity.append(desc);
  }
  toggleWrap.append(enableSwitch);
  head.append(toggleWrap, identity);

  const statusInfo = describeServerStatus(server);
  const headMeta = el('div', 'settings-mcp-row-head-meta');
  headMeta.append(
    createServerStatusPill(statusInfo.pill, statusInfo.ok),
    el('span', 'settings-mcp-badge settings-mcp-badge--builtin', 'Managed'),
  );
  head.append(headMeta);
  row.append(head);

  const body = el('div', 'settings-mcp-row-body');
  if (statusInfo.endpoint) {
    const endpoint = el('p', 'settings-mcp-hint settings-server-endpoint');
    endpoint.textContent = statusInfo.endpoint;
    body.append(endpoint);
  }

  const installProgress = el('p', 'settings-mcp-hint settings-server-install-progress hidden');
  installProgress.dataset.serverInstallProgress = server.id;
  body.append(installProgress);

  const toolbar = el('div', 'settings-server-toolbar');
  const autoRow = el('label', 'settings-inline-checkbox settings-server-auto-start');
  const autoCb = document.createElement('input');
  autoCb.type = 'checkbox';
  autoCb.checked = server.autoStart;
  autoCb.dataset.serverAutoStart = server.id;
  autoRow.append(autoCb, document.createTextNode('Auto-start when Minnow opens'));
  toolbar.append(autoRow);

  const portInline = el('div', 'settings-server-port-inline');
  const portLabel = el('label', 'settings-field-label', 'Port');
  portLabel.htmlFor = `settingsServerPort-${server.id}`;
  const portInput = document.createElement('input');
  portInput.type = 'number';
  portInput.id = `settingsServerPort-${server.id}`;
  portInput.className = 'settings-input';
  portInput.min = '1024';
  portInput.max = '65535';
  portInput.value = String(server.port);
  portInput.dataset.serverPort = server.id;
  const portApply = el('button', 'settings-inline-btn', 'Apply');
  portApply.type = 'button';
  portApply.dataset.serverPortApply = server.id;
  portInline.append(portLabel, portInput, portApply);
  toolbar.append(portInline);

  const actions = el('div', 'settings-server-actions');
  /** Shown under the toolbar when this host cannot install the runtime. */
  let installUnavailableHint: HTMLParagraphElement | null = null;
  if (!server.installed) {
    if (server.installable === false) {
      if (server.reason) {
        installUnavailableHint = el('p', 'settings-mcp-hint', server.reason);
        installUnavailableHint.dataset.serverInstallReason = server.id;
      }
    } else {
      const installBtn = el('button', 'settings-action-btn', 'Install');
      installBtn.type = 'button';
      installBtn.dataset.serverInstall = server.id;
      actions.append(installBtn);
    }
  } else {
    if (!server.running) {
      const startBtn = el('button', 'settings-action-btn', 'Start');
      startBtn.type = 'button';
      startBtn.dataset.serverStart = server.id;
      actions.append(startBtn);
    } else {
      const stopBtn = el('button', 'settings-inline-btn', 'Stop');
      stopBtn.type = 'button';
      stopBtn.dataset.serverStop = server.id;
      actions.append(stopBtn);
      const restartBtn = el('button', 'settings-inline-btn', 'Restart');
      restartBtn.type = 'button';
      restartBtn.dataset.serverRestart = server.id;
      actions.append(restartBtn);
    }
    const uninstallBtn = el('button', 'settings-inline-btn settings-mcp-remove', 'Uninstall');
    uninstallBtn.type = 'button';
    uninstallBtn.dataset.serverUninstall = server.id;
    actions.append(uninstallBtn);
  }
  toolbar.append(actions);
  body.append(toolbar);
  if (installUnavailableHint) {
    body.append(installUnavailableHint);
  }

  const logsPanel = document.createElement('details');
  logsPanel.className = 'settings-server-logs';
  const logsSummary = document.createElement('summary');
  logsSummary.textContent = 'Logs';
  const logsPre = document.createElement('pre');
  logsPre.className = 'settings-server-logs__body';
  logsPre.dataset.serverLogs = server.id;
  logsPre.textContent = '(expand to load)';
  const logsRefresh = el('button', 'settings-inline-btn', 'Refresh logs');
  logsRefresh.type = 'button';
  logsRefresh.dataset.serverLogsRefresh = server.id;
  logsPanel.append(logsSummary, logsRefresh, logsPre);
  body.append(logsPanel);

  row.append(body);

  enableInput.addEventListener('change', () => {
    void (async () => {
      const ok = await setManagedServerEnabled(server.id, enableInput.checked);
      if (ok) {
        setStatus('ok', enableInput.checked ? `${server.label} enabled` : `${server.label} disabled`);
        onRefresh();
        return;
      }
      enableInput.checked = !enableInput.checked;
      setStatus('err', 'Could not update. Open or restart Minnow.');
    })();
  });

  autoCb.addEventListener('change', () => {
    void (async () => {
      const ok = await setManagedServerAutoStart(server.id, autoCb.checked);
      if (ok) {
        setStatus('ok', autoCb.checked ? 'Auto-start enabled' : 'Auto-start disabled');
        return;
      }
      autoCb.checked = !autoCb.checked;
      setStatus('err', 'Could not save auto-start');
    })();
  });

  portApply.addEventListener('click', () => {
    void (async () => {
      const port = Number(portInput.value);
      const result = await setManagedServerPort(server.id, port);
      if (result.ok) {
        portInput.value = String(result.port);
        setStatus('ok', `Port set to ${result.port}`);
        onRefresh();
        return;
      }
      setStatus('err', result.ok === false ? result.error : 'Invalid port');
    })();
  });

  const installBtn = actions.querySelector<HTMLButtonElement>(`[data-server-install="${server.id}"]`);
  installBtn?.addEventListener('click', () => {
    void (async () => {
      installBtn.disabled = true;
      installProgress.classList.remove('hidden');
      installProgress.textContent = 'Starting install…';

      const pollPromise = pollInstallJob(server.id, (job) => {
        if (job?.phase === 'installing' || job?.phase === 'pending') {
          installProgress.textContent =
            job.message || `Installing… ${job.percent}%`;
        }
      });

      const result = await installManagedServer(server.id);
      if (result.ok === false) {
        installBtn.disabled = false;
        installProgress.classList.add('hidden');
        setStatus('err', result.error);
        return;
      }
      if (result.alreadyInstalled) {
        installProgress.classList.add('hidden');
        installBtn.disabled = false;
        setStatus('ok', 'Already installed');
        onRefresh();
        return;
      }

      const pollResult = await pollPromise;
      installProgress.classList.add('hidden');
      installBtn.disabled = false;
      if (pollResult === 'done') {
        setStatus('ok', `${server.label} installed`);
        onRefresh();
        return;
      }
      if (pollResult === 'error') {
        const lastJob = await fetchServerInstallStatus(server.id);
        const detail = lastJob?.error?.trim() || lastJob?.message?.trim();
        setStatus('err', detail ? `Install failed: ${detail}` : 'Install failed — see logs');
        onRefresh();
        return;
      }
      setStatus('err', 'Install timed out — check logs');
      onRefresh();
    })();
  });

  actions.querySelector<HTMLButtonElement>(`[data-server-start="${server.id}"]`)?.addEventListener(
    'click',
    () => {
      void (async () => {
        const result = await startManagedServer(server.id);
        if (result.ok) {
          setStatus('ok', `${server.label} started`);
          onRefresh();
          return;
        }
        setStatus('err', result.ok === false ? result.error : 'Start failed');
      })();
    },
  );

  actions.querySelector<HTMLButtonElement>(`[data-server-stop="${server.id}"]`)?.addEventListener(
    'click',
    () => {
      void (async () => {
        const result = await stopManagedServer(server.id);
        if (result.ok) {
          setStatus('ok', `${server.label} stopped`);
          onRefresh();
          return;
        }
        setStatus('err', result.ok === false ? result.error : 'Stop failed');
      })();
    },
  );

  actions.querySelector<HTMLButtonElement>(`[data-server-restart="${server.id}"]`)?.addEventListener(
    'click',
    () => {
      void (async () => {
        const result = await restartManagedServer(server.id);
        if (result.ok) {
          setStatus('ok', `${server.label} restarted`);
          onRefresh();
          return;
        }
        setStatus('err', result.ok === false ? result.error : 'Restart failed');
      })();
    },
  );

  actions.querySelector<HTMLButtonElement>(`[data-server-uninstall="${server.id}"]`)?.addEventListener(
    'click',
    () => {
      void (async () => {
        if (
          !(await appConfirm(
            `Uninstall ${server.label}? This removes files under ~/.minnow/servers/.`,
            { confirmLabel: 'Uninstall', danger: true },
          ))
        ) {
          return;
        }
        const ok = await uninstallManagedServer(server.id);
        if (ok) {
          setStatus('ok', `${server.label} uninstalled`);
          onRefresh();
          return;
        }
        setStatus('err', 'Uninstall failed');
      })();
    },
  );

  const loadLogs = (): void => {
    void (async () => {
      logsPre.textContent = 'Loading…';
      const lines = await fetchManagedServerLogs(server.id);
      logsPre.textContent =
        lines && lines.length > 0 ? lines.join('\n') : '(no log lines yet)';
    })();
  };

  logsPanel.addEventListener('toggle', () => {
    if (logsPanel.open) loadLogs();
  });
  logsRefresh.addEventListener('click', (e) => {
    e.preventDefault();
    loadLogs();
  });

  return row;
}

/** Compact status strip above the server list (matches LSP / Usage instrumentation). */
function appendServersStats(
  group: HTMLElement,
  servers: ManagedServerSummary[],
): HTMLElement {
  const stats = el('div', 'settings-servers-stats');
  stats.setAttribute('role', 'status');

  const running = servers.filter((s) => s.running).length;
  const installed = servers.filter((s) => s.installed).length;

  const addStat = (label: string, value: string, ok = false): void => {
    const stat = el('div', 'settings-servers-stat');
    stat.append(
      el('span', 'settings-servers-stat__label', label),
      el(
        'span',
        `settings-servers-stat__value${ok ? ' settings-servers-stat__value--ok' : ''}`,
        value,
      ),
    );
    stats.appendChild(stat);
  };

  addStat('Catalog', String(servers.length));
  addStat('Installed', String(installed));
  addStat('Running', String(running), running > 0);

  group.insertBefore(stats, group.firstChild);
  return stats;
}

// ── Render ───────────────────────────────────────────────────────────────────

/** Render Settings → Servers into the section mount. */
export async function renderServersSettingsSection(mount: HTMLElement): Promise<void> {
  mount.replaceChildren();

  const shell = el('div', 'settings-general settings-servers');
  mount.appendChild(shell);

  const lead = el('p', 'settings-section-lead');
  const storageCode = el('code', undefined, '~/.minnow/servers/');
  lead.append(
    'Install and lifecycle-manage local services under ',
    storageCode,
    '. SearXNG powers ',
    linkToSettingsSection('Search', 'search'),
    ' and ',
    linkToSettingsSection('Deep Research', 'deep-research'),
    ' when running. Local model runtimes (llama.cpp and MLX) live in ',
    linkToModelsSection('Models → Engine', 'engine'),
    '.',
  );
  shell.appendChild(lead);

  const offlineBanner = appendSettingsOfflineHint(
    shell,
    'Open Minnow to install, start, and configure managed services.',
    {
      id: 'settingsServersOffline',
      searchKey: 'integrations.servers',
      hidden: isLocalServerAvailable(),
    },
  );

  const content = el('div', 'settings-general__content');
  shell.appendChild(content);

  const servicesGroup = appendSettingsGroup(
    content,
    'Managed services',
    'Enable, set ports, auto-start, and view logs for bundled local servers.',
    'integrations.servers',
    { emphasis: true },
  );

  const list = el('div', 'settings-servers-list');
  list.id = 'settingsManagedServerList';
  list.setAttribute('role', 'list');
  list.setAttribute('aria-label', 'Managed servers');
  servicesGroup.appendChild(list);

  appendSettingsCrosslinks(shell, [
    { label: 'Inference engines', sectionId: 'engine' },
    { label: 'Search provider', sectionId: 'search' },
    { label: 'Deep Research', sectionId: 'deep-research' },
  ]);

  let statsEl: HTMLElement | null = null;

  const refresh = async (): Promise<void> => {
    const online = isLocalServerAvailable();
    offlineBanner.classList.toggle('hidden', online);
    statsEl?.remove();
    statsEl = null;
    list.replaceChildren();

    if (!online) {
      list.appendChild(
        el(
          'p',
          'settings-servers-empty',
          'Open Minnow to load managed services.',
        ),
      );
      return;
    }

    const catalog = await fetchManagedServers();
    // Inference runtimes are managed from Models → Engine.
    const servers = catalog?.filter((s) => !MODELS_ENGINE_SERVER_IDS.has(s.id)) ?? null;
    if (servers === null) {
      list.appendChild(el('p', 'settings-servers-empty', 'Could not load servers.'));
      return;
    }
    if (servers.length === 0) {
      list.appendChild(el('p', 'settings-servers-empty', 'No managed servers in catalog.'));
      return;
    }

    statsEl = appendServersStats(servicesGroup, servers);

    for (const server of servers) {
      list.appendChild(createServerRow(server, () => void refresh()));
    }
  };

  await refresh();
}

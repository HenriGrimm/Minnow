import {
  DEFAULT_DEV_SERVER_PORT,
  type DevServerLifecycleStatus,
  type DevServerNetwork,
} from '../config/startup-api';
import { worktreeTitle } from '../lib/worktree-title';
import type { DevServerListItem, ListeningPortRow } from '../config/dev-servers-api';

export type HubDevServerUiState =
  | 'offline'
  | 'setup'
  | 'stopped'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'error';

export type DevServerRowUiState = HubDevServerUiState | 'port-conflict';

export interface HubDevServerViewModel {
  uiState: HubDevServerUiState;
  label: string;
  meta: string;
  openUrl: string | null;
  primaryDisabled: boolean;
  showConsole: boolean;
  settingsDisabled: boolean;
  port: number;
  network: DevServerNetwork;
}

export interface DevServerRowViewModel {
  id: string;
  name: string;
  uiState: DevServerRowUiState;
  command: string;
  meta: string;
  worktreeLabel: string | null;
  openUrl: string | null;
  port: number;
  network: DevServerNetwork;
  canStart: boolean;
  canStop: boolean;
  canRestart: boolean;
  canEdit: boolean;
  canDelete: boolean;
  portConflict: boolean;
  warning: string | null;
}

export interface HubDevServersSummaryView {
  uiState: HubDevServerUiState;
  label: string;
  meta: string;
  primaryDisabled: boolean;
}

function formatNetworkLabel(network: DevServerNetwork): string {
  return network === 'lan' ? 'network' : 'this PC';
}

function formatPortMeta(port: number | null | undefined, network: DevServerNetwork): string {
  if (port == null) return formatNetworkLabel(network);
  return `:${port} · ${formatNetworkLabel(network)}`;
}

/** User-facing URL for open-in-preview (localhost + configured port). */
export function formatHubDevServerOpenUrl(
  healthUrl: string | null | undefined,
  port: number,
  _network: DevServerNetwork = 'local',
): string {
  if (healthUrl) {
    try {
      const u = new URL(healthUrl);
      u.hostname = 'localhost';
      u.port = String(port);
      return u.toString();
    } catch {
    }
  }
  return `http://localhost:${port}/`;
}

/** Status line under a single-server label (legacy hub helpers). */
export function formatHubDevServerMeta(
  status: DevServerLifecycleStatus,
  error: string | null | undefined,
  port: number | null | undefined,
  network: DevServerNetwork,
): string {
  if (status === 'starting') return `starting… ${formatPortMeta(port, network)} · click to stop`;
  if (status === 'running') return `running ${formatPortMeta(port, network)}`;
  if (status === 'stopping') return 'stopping…';
  if (status === 'error') {
    const short =
      error && error.length > 36 ? `${error.slice(0, 33)}…` : (error ?? 'start failed');
    return short;
  }
  if (status === 'stopped') return `stopped ${formatPortMeta(port, network)}`;
  return 'stopped';
}

function openUrlForStatus(
  status: DevServerLifecycleStatus,
  healthUrl: string | null | undefined,
  port: number,
  network: DevServerNetwork,
): string | null {
  if (status !== 'starting' && status !== 'running') return null;
  return formatHubDevServerOpenUrl(healthUrl, port, network);
}

/** Map API status + server availability to legacy hub cell presentation. */
export function deriveHubDevServerView(
  serverOnline: boolean,
  status: DevServerLifecycleStatus,
  error?: string | null,
  _runId?: string | null,
  port: number = DEFAULT_DEV_SERVER_PORT,
  network: DevServerNetwork = 'local',
  healthUrl?: string | null,
): HubDevServerViewModel {
  const settingsDisabled =
    !serverOnline ||
    status === 'starting' ||
    status === 'running' ||
    status === 'stopping';
  const openUrl = openUrlForStatus(status, healthUrl, port, network);

  if (!serverOnline) {
    return {
      uiState: 'offline',
      label: 'Dev server',
      meta: 'server offline',
      openUrl: null,
      primaryDisabled: true,
      showConsole: false,
      settingsDisabled: true,
      port,
      network,
    };
  }

  if (status === 'no_guide') {
    return {
      uiState: 'setup',
      label: 'Set up',
      meta: 'no startup guide',
      openUrl: null,
      primaryDisabled: false,
      showConsole: false,
      settingsDisabled: false,
      port,
      network,
    };
  }

  if (status === 'starting') {
    return {
      uiState: 'starting',
      label: 'Dev server',
      meta: formatHubDevServerMeta(status, error, port, network),
      openUrl,
      primaryDisabled: false,
      showConsole: true,
      settingsDisabled: true,
      port,
      network,
    };
  }

  if (status === 'running') {
    return {
      uiState: 'running',
      label: 'Dev server',
      meta: formatHubDevServerMeta(status, error, port, network),
      openUrl,
      primaryDisabled: false,
      showConsole: true,
      settingsDisabled: true,
      port,
      network,
    };
  }

  if (status === 'stopping') {
    return {
      uiState: 'stopping',
      label: 'Dev server',
      meta: formatHubDevServerMeta(status, error, port, network),
      openUrl: null,
      primaryDisabled: true,
      showConsole: true,
      settingsDisabled: true,
      port,
      network,
    };
  }

  if (status === 'error') {
    return {
      uiState: 'error',
      label: 'Dev server',
      meta: formatHubDevServerMeta(status, error, port, network),
      openUrl: null,
      primaryDisabled: false,
      showConsole: true,
      settingsDisabled: false,
      port,
      network,
    };
  }

  return {
    uiState: 'stopped',
    label: 'Dev server',
    meta: formatHubDevServerMeta('stopped', error, port, network),
    openUrl: null,
    primaryDisabled: false,
    showConsole: false,
    settingsDisabled: false,
    port,
    network,
  };
}

function formatElapsed(startedAt: number | null): string {
  if (startedAt == null) return '';
  const sec = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  return `${Math.floor(min / 60)}h`;
}

/** Compact worktree label for server rows: the checkout's user-facing title (MIN-14). */
export function formatDevServerWorktreeLabel(
  worktreeRoot: string | null | undefined,
  workspaceRoot: string,
  titleFor: (path: string) => string = (path) => worktreeTitle({ path }),
): string | null {
  if (!worktreeRoot?.trim()) return null;
  const normRoot = workspaceRoot.replace(/\\/g, '/').replace(/\/+$/, '');
  const normPath = worktreeRoot.replace(/\\/g, '/').replace(/\/+$/, '');
  if (normPath === normRoot) return 'workspace';
  return titleFor(worktreeRoot);
}

/** Per-row state machine for the Dev Servers screen. */
export function deriveDevServerRowView(
  serverOnline: boolean,
  item: DevServerListItem,
  workspaceRoot = '',
  worktreeTitleFor?: (path: string) => string,
): DevServerRowViewModel {
  const port = item.port ?? item.def?.port ?? DEFAULT_DEV_SERVER_PORT;
  const network = item.network ?? item.def?.network ?? 'local';
  const command = item.command ?? item.def?.command ?? '';
  const name = item.name || item.def?.name || item.id;
  const base = deriveHubDevServerView(
    serverOnline,
    item.status,
    item.error,
    item.runId,
    port,
    network,
    item.healthUrl,
  );

  const stoppedLike =
    item.status === 'stopped' || item.status === 'error' || item.status === 'no_guide';
  const portConflict =
    serverOnline && stoppedLike && item.portInUse && item.status !== 'no_guide';

  let uiState: DevServerRowUiState = base.uiState;
  let warning: string | null = null;
  if (portConflict) {
    uiState = 'port-conflict';
    warning = `port in use`;
  } else if (
    (item.status === 'running' || item.status === 'starting') &&
    item.port != null &&
    item.pid == null &&
    item.portInUse
  ) {
    warning = 'listening port may not match configured port';
  }

  const elapsed =
    item.status === 'running' || item.status === 'starting'
      ? formatElapsed(item.startedAt)
      : '';
  const worktreeLabel = formatDevServerWorktreeLabel(
    item.worktreeRoot ?? item.def?.worktreeRoot,
    workspaceRoot,
    worktreeTitleFor,
  );
  const metaParts = [base.meta];
  if (worktreeLabel) metaParts.push(worktreeLabel);
  if (elapsed) metaParts.push(elapsed);
  if (warning) metaParts.push(warning);

  return {
    id: item.id,
    name,
    uiState,
    command,
    meta: metaParts.join(' · '),
    worktreeLabel,
    openUrl: base.openUrl,
    port,
    network,
    canStart:
      serverOnline &&
      (item.status === 'stopped' || item.status === 'error' || item.status === 'no_guide'),
    canStop:
      serverOnline &&
      (item.status === 'starting' || item.status === 'running' || item.status === 'stopping'),
    canRestart: serverOnline && (item.status === 'running' || item.status === 'error'),
    canEdit: serverOnline && item.status !== 'starting' && item.status !== 'stopping',
    canDelete: serverOnline && item.def?.source !== 'startup.md',
    portConflict,
    warning,
  };
}

/** Compact hub strip summary for the multi-server list. */
export function deriveHubDevServersSummary(
  serverOnline: boolean,
  servers: DevServerListItem[],
): HubDevServersSummaryView {
  if (!serverOnline) {
    return {
      uiState: 'offline',
      label: 'Dev servers',
      meta: 'server offline',
      primaryDisabled: true,
    };
  }

  const real = servers.filter((s) => s.status !== 'no_guide' || s.def != null);
  if (real.length === 0 || servers.every((s) => s.status === 'no_guide' && !s.def)) {
    return {
      uiState: 'setup',
      label: 'Dev servers',
      meta: 'no servers yet',
      primaryDisabled: false,
    };
  }

  const running = servers.filter((s) => s.status === 'running' || s.status === 'starting');
  const errored = servers.filter((s) => s.status === 'error');
  const ports = running
    .map((s) => s.port)
    .filter((p): p is number => typeof p === 'number')
    .slice(0, 2);
  const portBit = ports.length ? ports.map((p) => `:${p}`).join(' ') : '';

  if (errored.length && !running.length) {
    return {
      uiState: 'error',
      label: 'Dev servers',
      meta: `${errored.length} error${errored.length === 1 ? '' : 's'}`,
      primaryDisabled: false,
    };
  }

  if (running.length) {
    return {
      uiState: running.some((s) => s.status === 'starting') ? 'starting' : 'running',
      label: 'Dev servers',
      meta: `${running.length} running${portBit ? ` · ${portBit}` : ''}`,
      primaryDisabled: false,
    };
  }

  return {
    uiState: 'stopped',
    label: 'Dev servers',
    meta: `${servers.length} stopped`,
    primaryDisabled: false,
  };
}

/** Attribute a listening port to a named registry server when possible. */
export function labelPortAttribution(
  row: ListeningPortRow,
  servers: DevServerListItem[],
): string | null {
  for (const s of servers) {
    if (s.port === row.port && (s.status === 'running' || s.status === 'starting')) {
      return s.name || s.id;
    }
    if (s.pid != null && s.pid === row.pid) {
      return s.name || s.id;
    }
  }
  return null;
}

/** Scope filter for the listening-ports table. */
export type PortsScopeFilter = 'all' | 'linked' | 'protected' | 'other';

export interface PortsFilterState {
  query: string;
  scope: PortsScopeFilter;
}

function portSearchHaystack(row: ListeningPortRow, servers: DevServerListItem[]): string {
  const attr = labelPortAttribution(row, servers);
  return [
    String(row.port),
    String(row.pid),
    row.process,
    row.address,
    attr ?? '',
    row.protected ? 'protected minnow' : '',
  ]
    .join(' ')
    .toLowerCase();
}

function matchesPortsScope(
  row: ListeningPortRow,
  servers: DevServerListItem[],
  scope: PortsScopeFilter,
): boolean {
  if (scope === 'all') return true;
  if (scope === 'protected') return row.protected;
  const linked = labelPortAttribution(row, servers) != null;
  if (scope === 'linked') return linked;
  return !row.protected && !linked;
}

/** Client-side search + scope filter for the ports panel (does not refetch). */
export function filterListeningPorts(
  ports: ListeningPortRow[],
  servers: DevServerListItem[],
  filter: PortsFilterState,
): ListeningPortRow[] {
  const q = filter.query.trim().toLowerCase();
  return ports.filter((row) => {
    if (!matchesPortsScope(row, servers, filter.scope)) return false;
    if (!q) return true;
    return portSearchHaystack(row, servers).includes(q);
  });
}

/** Sortable columns in the listening-ports table. */
export type PortsSortKey = 'port' | 'process' | 'pid' | 'source';

export type PortsSortDirection = 'asc' | 'desc';

export type PortsListSort = {
  key: PortsSortKey;
  direction: PortsSortDirection;
};

export const DEFAULT_PORTS_LIST_SORT: PortsListSort = {
  key: 'port',
  direction: 'asc',
};

/** Display label used for the Source column and for sorting. */
export function portSourceSortLabel(
  row: ListeningPortRow,
  servers: DevServerListItem[],
): string {
  if (row.protected) return 'Minnow (protected)';
  const attr = labelPortAttribution(row, servers);
  return attr ?? '';
}

export function defaultDirectionForPortsSortKey(key: PortsSortKey): PortsSortDirection {
  return 'asc';
}

/** Toggle direction on the same column, or switch column with a sensible default. */
export function cyclePortsListSort(current: PortsListSort, nextKey: PortsSortKey): PortsListSort {
  if (current.key === nextKey) {
    return {
      key: nextKey,
      direction: current.direction === 'asc' ? 'desc' : 'asc',
    };
  }
  return { key: nextKey, direction: defaultDirectionForPortsSortKey(nextKey) };
}

/** aria-sort value for the active column header. */
export function portsListSortAriaSort(
  sort: PortsListSort,
  column: PortsSortKey,
): 'none' | 'ascending' | 'descending' {
  if (sort.key !== column) return 'none';
  return sort.direction === 'asc' ? 'ascending' : 'descending';
}

/** Sort a port list after filtering (stable tie-break on port number). */
export function sortListeningPorts(
  ports: ListeningPortRow[],
  servers: DevServerListItem[],
  sort: PortsListSort,
): ListeningPortRow[] {
  const sign = sort.direction === 'asc' ? 1 : -1;
  return [...ports].sort((a, b) => {
    let cmp = 0;
    switch (sort.key) {
      case 'port':
        cmp = a.port - b.port;
        break;
      case 'pid':
        cmp = a.pid - b.pid;
        break;
      case 'process':
        cmp = a.process.localeCompare(b.process, undefined, { sensitivity: 'base' });
        break;
      case 'source':
        cmp = portSourceSortLabel(a, servers).localeCompare(
          portSourceSortLabel(b, servers),
          undefined,
          { sensitivity: 'base' },
        );
        break;
      default:
        cmp = 0;
    }
    if (cmp === 0) cmp = a.port - b.port;
    return cmp * sign;
  });
}

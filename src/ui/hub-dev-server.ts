import { fetchDevServers, type DevServerListItem } from '../config/dev-servers-api';
import { navigateToCodeDevServers } from '../os/router';
import { isLocalServerAvailable } from '../tools/config';
import type { Chat } from '../types';
import {
  deriveHubDevServersSummary,
  type HubDevServerUiState,
} from './dev-server-screen-view';

export { deriveHubDevServerView } from './hub-dev-server-view';
export type {
  HubDevServerUiState,
  HubDevServerViewModel,
} from './hub-dev-server-view';

let pollTimer: ReturnType<typeof setInterval> | null = null;
let lastServers: DevServerListItem[] = [];
let mountedCell: HTMLElement | null = null;
let refreshController: AbortController | null = null;

function stopPolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function startPolling(refresh: () => void): void {
  stopPolling();
  pollTimer = setInterval(() => {
    if (!document.hidden && mountedCell?.isConnected) void refresh();
  }, 2000);
}

function applySummaryToDom(
  uiState: HubDevServerUiState,
  label: string,
  meta: string,
  primaryDisabled: boolean,
): void {
  const cell = document.getElementById('hubDevServerCell');
  const labelEl = document.getElementById('hubDevServerLabel');
  const metaEl = document.getElementById('hubDevServerMeta');
  const dot = document.getElementById('hubDevServerDot');
  if (!cell || !labelEl || !metaEl || !dot) return;

  labelEl.textContent = label;
  metaEl.textContent = meta;

  cell.classList.remove(
    'hub-strip__cell--stopped',
    'hub-strip__cell--starting',
    'hub-strip__cell--running',
    'hub-strip__cell--error',
    'hub-strip__cell--offline',
    'hub-strip__cell--setup',
  );

  const dotClass =
    uiState === 'running'
      ? 'ok pulse'
      : uiState === 'starting' || uiState === 'stopping'
        ? 'warn pulse'
        : uiState === 'error'
          ? 'err'
          : 'idle';

  dot.className = `hub-strip__dot ${dotClass}`;
  cell.classList.add(`hub-strip__cell--${uiState}`);
  cell.setAttribute('aria-disabled', primaryDisabled ? 'true' : 'false');
  cell.classList.toggle('hub-strip__cell--disabled', primaryDisabled);
  cell.setAttribute('aria-label', `${label}: ${meta}. Open Dev servers screen`);
}

async function refreshDevServerCell(): Promise<void> {
  if (!mountedCell || refreshController) return;
  const online = isLocalServerAvailable();
  if (!online) {
    applySummaryToDom('offline', 'Dev servers', 'server offline', true);
    stopPolling();
    return;
  }

  const controller = new AbortController();
  refreshController = controller;
  try {
    const result = await fetchDevServers(controller.signal);
    if (controller.signal.aborted) return;
    lastServers = result;
    const summary = deriveHubDevServersSummary(true, lastServers);
    applySummaryToDom(
      summary.uiState,
      summary.label,
      summary.meta,
      summary.primaryDisabled,
    );
    const busy = lastServers.some((s) => s.status === 'starting' || s.status === 'running');
    if (busy) startPolling(() => void refreshDevServerCell());
    else stopPolling();
  } catch {
    if (!controller.signal.aborted) applySummaryToDom('error', 'Dev servers', 'status unavailable', false);
  } finally {
    if (refreshController === controller) refreshController = null;
  }
}

/** Stop managed primary server (used by shell kill UI). */
export async function stopHubDevServer(): Promise<void> {
  if (!isLocalServerAvailable()) return;
  const { postDevServerStop } = await import('../config/startup-api');
  try {
    await postDevServerStop();
  } catch {
  }
  void refreshDevServerCell();
}

/** Mount hub cell: click opens Dev Servers screen. */
export function initHubDevServer(cell: HTMLElement, _chat: Chat): void {
  teardownHubDevServer();
  mountedCell = cell;
  const openScreen = (): void => {
    if (cell.getAttribute('aria-disabled') === 'true') return;
    navigateToCodeDevServers();
  };

  cell.addEventListener('click', () => openScreen());
  cell.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    openScreen();
  });

  void refreshDevServerCell();
}

/** Refresh summary on hub live update. */
export function updateHubDevServer(): void {
  void refreshDevServerCell();
}

/** Tear down polling when hub unmounts. */
export function teardownHubDevServer(): void {
  stopPolling();
  mountedCell = null;
  refreshController?.abort();
  refreshController = null;
  lastServers = [];
}

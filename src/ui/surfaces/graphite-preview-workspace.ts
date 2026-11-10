import { hasHostSessionToken, isPairedDevice } from '../../api/session-token';
import { fetchTerminalLog } from '../../api/terminal';
import { fetchDevServers, postDevServerStartById, postDevServerStopById, type DevServerListItem } from '../../config/dev-servers-api';
import { stripAnsi } from '../../lib/strip-ansi';
import { navigateToCodeDevServers } from '../../os/router';
import { resolveChatWorktreeRoot } from '../../state/chat-worktree';
import { createIcon, type IconName } from '../icon';
import { panelPathsEqual } from '../panel-worktree-cwd';
import { scheduleElectronPreviewHostLayoutSync, scheduleSecondaryPreviewHostLayoutSync } from '../preview-electron-visibility';
import type { SurfaceContext } from './surface-registry';

const SERVER_STATUS = {
  no_guide: 'No startup guide', stopped: 'stopped', starting: 'starting…',
  running: 'running', stopping: 'stopping…', error: 'error',
} satisfies Record<DevServerListItem['status'], string>;

function element<K extends keyof HTMLElementTagNameMap>(tag: K, name: string, value?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = name;
  if (value !== undefined) node.textContent = value;
  return node;
}

function iconButton(name: string, icon: IconName, run: () => void): HTMLButtonElement {
  const button = element('button', 'graphite-surface-icon');
  button.type = 'button';
  button.title = name;
  button.setAttribute('aria-label', name);
  button.append(createIcon(icon, { size: 14 }));
  button.addEventListener('click', run);
  return button;
}

export function mountGraphitePreviewWorkspace(host: HTMLElement, stage: HTMLElement, previews: HTMLElement[]): {
  setVisible(visible: boolean, context: SurfaceContext): void;
} {
  const rail = element('aside', 'graphite-preview-servers');
  rail.setAttribute('aria-label', 'Dev servers');
  rail.hidden = true;
  const heading = element('div', 'graphite-preview-servers__heading', 'Dev servers');
  heading.append(iconButton('Manage dev servers', 'plus', navigateToCodeDevServers));
  const list = element('div', 'graphite-preview-servers__list');
  const logLabel = element('p', 'graphite-preview-servers__log-label', 'Server log');
  const log = element('pre', 'graphite-preview-servers__log');
  log.setAttribute('aria-label', 'Selected server log');
  rail.append(heading, list, logLabel, log);
  host.prepend(rail);

  const widths = [
    ['desktop', 'Desktop', 'deviceDesktop'], ['tablet', 'Tablet', 'deviceTablet'], ['phone', 'Phone', 'deviceMobile'],
  ] as const;
  const deviceButtons: HTMLButtonElement[] = [];
  for (const preview of previews) {
    const tools = preview.querySelector('.preview-header__tools, .preview-header__trail');
    if (!tools) continue;
    const devices = element('div', 'graphite-preview-devices');
    devices.setAttribute('role', 'group');
    devices.setAttribute('aria-label', 'Preview width');
    for (const [id, label, icon] of widths) {
      const button = iconButton(label + ' preview width', icon, () => {
        host.dataset.previewWidth = id;
        for (const other of deviceButtons) other.setAttribute('aria-pressed', String(other.dataset.width === id));
        scheduleElectronPreviewHostLayoutSync();
        scheduleSecondaryPreviewHostLayoutSync();
      });
      button.dataset.width = id;
      button.setAttribute('aria-pressed', String(id === 'desktop'));
      deviceButtons.push(button);
      devices.append(button);
    }
    tools.before(devices);
    if (window.minnow?.window?.openAgentBrowserViewer) {
      const agent = iconButton('Open Agent Browser', 'eye', () => document.getElementById('btnAgentBrowserViewer')?.click());
      agent.classList.add('graphite-preview-agent');
      tools.insertBefore(agent, tools.querySelector('#btnPreviewDevTools'));
    }
    const design = preview.querySelector('#btnPreviewDesignToggle, #btnPreviewDesignToggleSecondary');
    design?.replaceChildren(createIcon('cursor', { size: 14 }));
  }

  function openServer(port: number): void {
    const shown = previews.find(pane => host.contains(pane) && pane.getClientRects().length);
    const url = shown?.querySelector<HTMLInputElement>('.preview-url');
    if (!url) return;
    url.value = `http://localhost:${port}/`;
    shown?.querySelector<HTMLButtonElement>('.preview-go')?.click();
  }

  let context: SurfaceContext | null = null;
  let active = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let request: AbortController | undefined;
  let revision = 0;
  let selected = '';
  let signature = '';
  let servers: DevServerListItem[] = [];
  const busy = new Set<string>();
  const blocked = (server: DevServerListItem) => server.status === 'starting' || server.status === 'stopping';

  function paint(): void {
    if (!servers.some(server => server.id === selected)) selected = servers[0]?.id ?? '';
    const next = JSON.stringify([selected, [...busy], servers.map(server => [
      server.id, server.name, server.command, server.port, server.status, server.error,
    ])]);
    if (next === signature) return;
    signature = next;
    list.replaceChildren();
    if (!servers.length) {
      list.append(element('p', 'graphite-preview-servers__notice', 'No dev servers in this checkout'));
      return;
    }
    for (const server of servers) {
      const row = element('div', 'graphite-preview-servers__row');
      const button = element('button', 'graphite-preview-servers__select');
      button.type = 'button';
      button.setAttribute('aria-pressed', String(selected === server.id));
      button.title = server.error || server.name;
      const dot = element('span', 'graphite-preview-servers__dot');
      dot.dataset.state = server.status;
      dot.setAttribute('aria-hidden', 'true');
      const text = element('span', 'graphite-preview-servers__identity');
      const summary = server.status === 'running' && server.port
        ? [`localhost:${server.port}`, server.command].filter(Boolean).join(' · ')
        : SERVER_STATUS[server.status];
      text.append(element('span', '', server.name), element('code', '', summary));
      button.append(dot, text);
      button.addEventListener('click', () => {
        selected = server.id;
        paint();
        void syncLog();
        if (server.status === 'running' && server.port && !isPairedDevice()) {
          openServer(server.port);
        }
      });
      row.append(button);
      if (hasHostSessionToken() && !isPairedDevice()) {
        const running = server.status === 'running';
        const toggle = iconButton(`${running ? 'Stop' : 'Start'} ${server.name}`, running ? 'stop' : 'metricTtft', () => {
          if (!context || !active || busy.has(server.id) || blocked(server)) return;
          const captured = context;
          busy.add(server.id);
          paint();
          const cwd = resolveChatWorktreeRoot(captured.chat);
          void (running ? postDevServerStopById(server.id) : postDevServerStartById(server.id, { worktreeRoot: cwd }))
            .then(result => { if (!result.ok) throw new Error(`Could not ${running ? 'stop' : 'start'} ${server.name}`); })
            .catch(error => {
              if (context?.chat.id === captured.chat.id) log.textContent = error instanceof Error ? error.message : 'Could not update dev server';
            }).finally(() => {
              busy.delete(server.id);
              if (active) void refresh();
            });
        });
        toggle.disabled = busy.has(server.id) || blocked(server);
        row.append(toggle);
      }
      list.append(row);
    }
  }

  async function syncLog(): Promise<void> {
    const item = servers.find(server => server.id === selected);
    const sequence = ++revision;
    if (!item?.runId) {
      log.textContent = item ? 'Start this server to see its output.' : 'No server output';
      return;
    }
    const text = await fetchTerminalLog(item.runId).catch(() => '');
    if (!active || sequence !== revision) return;
    const pinned = log.scrollHeight - log.scrollTop - log.clientHeight < 24;
    log.textContent = text ? stripAnsi(text).slice(-80_000) : 'Waiting for server output…';
    if (pinned) log.scrollTop = log.scrollHeight;
  }

  async function refresh(): Promise<void> {
    if (!active || !context || request) return;
    const next = new AbortController();
    request = next;
    const captured = context;
    try {
      const all = await fetchDevServers(next.signal);
      if (!active || context?.chat.id !== captured.chat.id || next.signal.aborted) return;
      const cwd = resolveChatWorktreeRoot(captured.chat) ?? captured.chat.workspacePath;
      servers = all.filter(server => (server.def != null || server.status !== 'no_guide') &&
        (!server.worktreeRoot || panelPathsEqual(server.worktreeRoot, cwd ?? '')));
      paint();
      await syncLog();
    } catch {
      if (active && !next.signal.aborted) {
        signature = '';
        list.replaceChildren(element('p', 'graphite-preview-servers__notice', 'Could not load dev servers'));
      }
    } finally {
      if (request === next) request = undefined;
    }
  }

  function syncVisibility(): void {
    const panel = host.closest('#surfaceSide, #surfaceBottom');
    const maximized = (panel?.id === 'surfaceSide' ? 'side' : panel?.id === 'surfaceBottom' ? 'bottom' : null)
      === stage.dataset.surfaceMax;
    const next = Boolean(context && maximized);
    host.classList.toggle('graphite-browser-host--expanded', next);
    rail.hidden = !next;
    if (next === active) return;
    active = next;
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
    if (active) {
      void refresh();
      timer = setInterval(() => { if (!document.hidden) void refresh(); }, 4000);
    } else {
      request?.abort();
      request = undefined;
    }
  }

  new MutationObserver(syncVisibility).observe(stage, { attributes: true, attributeFilter: ['data-surface-max'] });
  return {
    setVisible(visible, next) {
      const changedChat = context?.chat.id !== next.chat.id;
      if (changedChat || !visible) {
        request?.abort();
        request = undefined;
        revision++;
        servers = [];
        selected = '';
        signature = '';
        list.replaceChildren();
        log.textContent = '';
      }
      context = visible ? next : null;
      const wasActive = active;
      syncVisibility();
      if (changedChat && wasActive && active) void refresh();
    },
  };
}

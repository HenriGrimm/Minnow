import '../styles/dev-server-screen.css';
import {
  createDevServerApi, deleteDevServerApi, fetchDevServers, fetchListeningPorts,
  fetchNextFreePort, postDevServerStartById, postDevServerStopById, updateDevServerApi,
  type DevServerListItem,
} from '../config/dev-servers-api';
import { formatWorktreeOptionLabel, getPrincipalWorktree, parseWorktreeListPorcelain } from '../lib/worktree-list-parse';
import { listWorktrees } from '../state/worktree-service';
import { createButton, createIconButton } from './components/button';
import { openDevServerFormPopover } from './dev-server-form-popover';
import { deriveDevServerRowView } from './dev-server-screen-view';
import { panelPathsEqual } from './panel-worktree-cwd';

interface ThreadDevServersOptions {
  host: HTMLElement;
  toolbar: HTMLElement;
  workspace: string;
  checkout: string;
  canManage: boolean;
  signal: AbortSignal;
  isCurrent(): boolean;
  reposition(): void;
}

export function mountThreadDevServers(options: ThreadDevServersOptions): void {
  const { host, toolbar, workspace, checkout, canManage, signal, reposition } = options;
  const isCurrent = () => !signal.aborted && options.isCurrent();
  const list = document.createElement('div');
  const form = document.createElement('div');
  const notice = document.createElement('p');
  notice.className = 'graphite-thread-card__notice';
  notice.setAttribute('role', 'status');
  host.append(notice, list, form);

  let servers: DevServerListItem[] = [];
  let managing = false;
  let loading = true;
  let fetching = false;
  let busy = false;
  let loadError = '';
  let actionError = '';
  let confirmDelete: string | undefined;
  let closeForm: (() => void) | undefined;

  const gear = createIconButton({
    label: 'Dev server settings', icon: 'appSettings', size: 'sm', pressed: false,
    onClick: () => {
      managing = !managing;
      confirmDelete = undefined;
      actionError = '';
      gear.setAttribute('aria-pressed', String(managing));
      render();
    },
  });
  if (canManage) toolbar.append(gear);

  function render(): void {
    if (!isCurrent()) return;
    gear.disabled = busy || Boolean(closeForm);
    list.hidden = Boolean(closeForm);
    notice.hidden = !actionError && !loadError && !loading;
    notice.textContent = actionError || loadError || (loading ? 'Loading dev servers…' : '');
    if (closeForm) return;

    const focused = list.contains(document.activeElement)
      ? (document.activeElement as HTMLElement).dataset.serverAction : undefined;
    list.replaceChildren();
    const rows = managing ? servers : servers.filter(server =>
      inCheckout(server.def?.worktreeRoot) || (server.runId && inCheckout(server.worktreeRoot)));
    for (const server of rows) {
      const view = deriveDevServerRowView(true, server, workspace);
      const row = document.createElement('div');
      row.className = 'graphite-thread-card__row';
      const identity = document.createElement('span');
      identity.className = 'graphite-thread-card__row-body';
      const title = document.createElement('span');
      title.textContent = server.name;
      const detail = document.createElement('span');
      detail.className = 'graphite-thread-card__detail';
      const runningElsewhere = view.canStop && !inCheckout(server.worktreeRoot);
      detail.textContent = managing ? view.command : runningElsewhere ? 'Running in another checkout' : view.meta;
      detail.title = server.error || detail.textContent;
      identity.append(title, detail);
      row.append(identity);

      if (managing && confirmDelete === server.id) {
        row.classList.add('graphite-thread-card__row--confirmation');
        detail.textContent = 'Remove this server and stop any active run?';
        row.append(
          control('Cancel', 'cancel', () => { confirmDelete = undefined; render(); }),
          control('Delete', 'confirm', () => void mutate(() => deleteDevServerApi(server.id)), true),
        );
      } else if (managing) {
        if (view.canEdit) row.append(control('Edit', 'edit', anchor => void edit(anchor, server)));
        if (view.canDelete) row.append(control('Delete', 'delete', () => {
          confirmDelete = server.id;
          render();
          list.querySelector<HTMLButtonElement>('[data-server-action$=":cancel"]')?.focus();
        }));
      } else if (canManage && (view.canStop || view.canStart)) {
        const toggle = control(view.canStop ? 'Stop' : 'Run', 'toggle', () => void toggleServer(server));
        toggle.disabled ||= runningElsewhere || server.status === 'stopping';
        row.append(toggle);
      }
      list.append(row);

      function control(label: string, key: string, onClick: (anchor: HTMLButtonElement) => void, danger = false) {
        const button = createButton({
          label, ariaLabel: `${label} ${server.name}`, size: 'sm', variant: danger ? 'danger' : 'ghost',
          disabled: busy, onClick: event => onClick(event.currentTarget as HTMLButtonElement),
        });
        button.dataset.serverAction = `${server.id}:${key}`;
        return button;
      }
    }
    if (!loading && !loadError && !rows.length) {
      const empty = document.createElement('p');
      empty.className = 'graphite-thread-card__notice';
      empty.textContent = managing ? 'No dev servers configured.' : 'No dev servers for this checkout.';
      list.append(empty);
    }
    if (managing) {
      const add = createButton({
        label: 'Add dev server', icon: 'plus', size: 'sm', variant: 'ghost', disabled: busy,
        onClick: event => void edit(event.currentTarget as HTMLButtonElement),
      });
      add.dataset.serverAction = 'add';
      list.append(add);
    } else if (loadError) {
      list.append(createButton({ label: 'Retry', size: 'sm', onClick: () => void refresh() }));
    }
    if (focused) {
      const next = Array.from(list.querySelectorAll('button')).find(button => button.dataset.serverAction === focused);
      (next && !next.disabled ? next : gear).focus({ preventScroll: true });
    }
    reposition();
  }

  function inCheckout(path?: string | null): boolean {
    return !path || panelPathsEqual(path, checkout);
  }

  async function refresh(): Promise<void> {
    if (!isCurrent() || fetching || busy || closeForm) return;
    fetching = true;
    const previous = JSON.stringify([servers, loadError, loading]);
    try {
      servers = (await fetchDevServers(signal)).filter(server => Boolean(server.command));
      loadError = '';
    } catch {
      loadError = 'Could not load dev servers.';
    } finally {
      loading = false;
      fetching = false;
      if (!busy && previous !== JSON.stringify([servers, loadError, loading])) render();
    }
  }

  async function mutate(run: () => Promise<void>): Promise<void> {
    if (!isCurrent() || busy || !canManage) return;
    busy = true;
    actionError = '';
    render();
    try {
      await run();
      confirmDelete = undefined;
    } catch (error) {
      actionError = error instanceof Error ? error.message : 'Could not update dev servers.';
    } finally {
      busy = false;
      if (isCurrent()) {
        render();
        await refresh();
      }
    }
  }

  function toggleServer(server: DevServerListItem): Promise<void> {
    return mutate(async () => {
      const live = (await fetchDevServers(signal)).find(item => item.id === server.id);
      if (!isCurrent()) return;
      const stop = live?.status === 'running' || live?.status === 'starting';
      if (!live || live.status !== server.status || live.runId !== server.runId ||
        !inCheckout(stop ? live.worktreeRoot : live.def?.worktreeRoot)) {
        throw new Error('The dev server changed. Check its status and try again.');
      }
      if (stop) {
        if (!(await postDevServerStopById(live.id)).ok) throw new Error('Could not stop the dev server.');
      } else {
        const result = await postDevServerStartById(live.id, { worktreeRoot: checkout });
        if (!result.ok) throw new Error(result.error || 'Could not start the dev server.');
      }
    });
  }

  async function edit(anchor: HTMLButtonElement, existing?: DevServerListItem): Promise<void> {
    if (!isCurrent() || busy || closeForm || !canManage) return;
    busy = true;
    gear.disabled = true;
    anchor.disabled = true;
    const [worktrees, ports] = await Promise.all([
      listWorktrees(workspace).then(result => result.worktrees ?? parseWorktreeListPorcelain(result.output ?? '')).catch(() => []),
      fetchListeningPorts(signal).catch(() => []),
    ]);
    if (!isCurrent()) return;
    busy = false;
    anchor.disabled = false;
    const principal = getPrincipalWorktree(worktrees);
    closeForm = openDevServerFormPopover({
      anchor, existing, workspacePath: workspace,
      inline: { host: form, worktreeRoot: checkout, reposition },
      worktrees: worktrees.length ? worktrees.map(wt => ({
        value: wt.path, label: formatWorktreeOptionLabel(wt, workspace, { principalPath: principal?.path }),
      })) : [{ value: workspace, label: 'Workspace' }],
      getPorts: () => ports,
      nextFreePort: fetchNextFreePort,
      onSave: values => {
        if (!isCurrent()) return Promise.reject(new Error('The active checkout changed.'));
        return existing ? updateDevServerApi(existing.id, values) : createDevServerApi(values);
      },
      onClose: () => {
        closeForm = undefined;
        if (!isCurrent()) return;
        render();
        const next = Array.from(list.querySelectorAll('button')).find(button => button.dataset.serverAction === anchor.dataset.serverAction);
        (next ?? gear).focus({ preventScroll: true });
      },
      onSaved: () => { void refresh(); },
    });
    list.hidden = true;
    gear.disabled = true;
    reposition();
  }

  signal.addEventListener('abort', () => {
    clearInterval(timer);
    closeForm?.();
  }, { once: true });
  const timer = setInterval(() => { if (!document.hidden) void refresh(); }, 4000);
  render();
  void refresh();
}

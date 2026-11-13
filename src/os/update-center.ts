import { getUpdaterApi, watchUpdaterStatus, type MinnowUpdaterStatus } from '../electron/updater-client';
import {
  checkAgentCliUpdates, installAgentCliUpdate,
  type AgentCliKind, type AgentCliUpdateCheck,
} from '../models/agent-clis';
import { invalidateProviderCache } from '../providers/store';

const POLL_MS = 5 * 60_000;
const RETRY_MS = 60_000;

export function createUpdateCenter() {
  const listeners = new Set<() => void>();
  const state = {
    app: null as MinnowUpdaterStatus | null,
    appError: '',
    appChecking: false,
    restarting: false,
    cli: null as AgentCliUpdateCheck | null,
    cliChecking: false,
    cliError: '',
    cliRestricted: false,
    cliInstalling: [] as AgentCliKind[],
    operations: new Map<AgentCliKind, { state: 'running' | 'done' | 'error'; message: string }>(),
  };
  let lastAttempt = 0;
  let checkWork: Promise<void> | undefined;
  let stop: (() => void) | undefined;
  const publish = () => { for (const listener of listeners) listener(); };
  const updateApp = (status: MinnowUpdaterStatus) => { state.app = status; publish(); };

  function checkCli(force = false): Promise<void> {
    if (checkWork) return checkWork;
    if (!force && (state.cliRestricted || Date.now() - lastAttempt < (state.cliError || state.cliInstalling.length ? RETRY_MS : POLL_MS))) {
      return Promise.resolve();
    }
    lastAttempt = Date.now();
    state.cliChecking = true;
    publish();
    checkWork = checkAgentCliUpdates(force).then(result => {
      if (result) {
        state.cli = result;
        state.cliInstalling = result.installing ?? [];
        state.cliRestricted = false;
      } else {
        state.cli = null;
        state.cliInstalling = [];
        state.cliRestricted = true;
      }
      state.cliError = '';
    }).catch(() => {
      state.cliError = 'Could not check CLI updates. Try again when you are online.';
    }).finally(() => {
      state.cliChecking = false;
      checkWork = undefined;
      publish();
    });
    return checkWork;
  }

  async function check() {
    const api = getUpdaterApi();
    const app = state.app;
    const canCheck = api && !state.appChecking && !state.restarting
      && (!app || (app.supported && !['checking', 'downloading', 'ready'].includes(app.state)));
    if (!canCheck) return checkCli(true);
    state.appChecking = true;
    state.appError = '';
    publish();
    await Promise.all([checkCli(true), api.checkNow().then(status => {
      if (status) updateApp(status);
    }).catch(() => { state.appError = 'Could not check for a Minnow update.'; }).finally(() => {
      state.appChecking = false;
      publish();
    })]);
  }

  async function restart() {
    if (state.restarting || state.app?.state !== 'ready' || isInstallingCli()) return;
    state.restarting = true;
    state.appError = '';
    publish();
    try {
      if (!await getUpdaterApi()?.restart()) throw new Error();
    } catch {
      state.restarting = false;
      state.appError = 'Could not restart Minnow. Try again.';
      publish();
    }
  }

  async function updateCli(kind: AgentCliKind) {
    if (state.restarting || state.operations.get(kind)?.state === 'running') return;
    const item = state.cli?.items.find(row => row.kind === kind);
    if (!item || item.state === 'current' || state.cliRestricted) return;
    state.operations.set(kind, { state: 'running', message: 'Updating…' });
    publish();
    try {
      const { installedVersion } = await installAgentCliUpdate(kind);
      invalidateProviderCache();
      // Show the installed version immediately; then verify against the feed.
      const unchanged = installedVersion === item.installedVersion && item.state === 'available';
      const next = state.cli?.items.find(row => row.kind === kind);
      if (next && installedVersion) {
        next.installedVersion = installedVersion;
        if (installedVersion === next.latestVersion) next.state = 'current';
      }
      state.operations.set(kind, {
        state: 'done',
        message: unchanged
          ? 'The installed version did not change. Your CLI may follow a different release channel.'
          : `Installed version ${installedVersion}.`,
      });
      await checkWork;
      await checkCli(true);
    } catch (error) {
      state.operations.set(kind, { state: 'error', message: error instanceof Error ? error.message : 'Update failed. Try again.' });
    }
    publish();
  }

  function subscribe(listener: () => void) {
    listeners.add(listener);
    if (!stop) {
      const poll = () => { if (!document.hidden) void checkCli(); };
      const unwatch = watchUpdaterStatus(updateApp);
      const timer = window.setInterval(poll, RETRY_MS);
      const initial = window.setTimeout(poll, 2_000);
      const online = () => { if (!document.hidden) void checkCli(true); };
      window.addEventListener('focus', poll);
      window.addEventListener('online', online);
      document.addEventListener('visibilitychange', poll);
      stop = () => {
        unwatch();
        window.clearTimeout(initial);
        window.clearInterval(timer);
        window.removeEventListener('focus', poll);
        window.removeEventListener('online', online);
        document.removeEventListener('visibilitychange', poll);
      };
    }
    listener();
    return () => {
      if (!listeners.delete(listener)) return;
      if (listeners.size === 0) { stop?.(); stop = undefined; }
    };
  }

  function pendingUpdates() {
    return [
      ...(state.app && ['ready', 'downloading'].includes(state.app.state) ? [`Minnow:${state.app.pendingVersion}`] : []),
      ...(state.cli?.items ?? []).filter(row => row.state === 'available').map(row => `${row.kind}:${row.latestVersion}`),
    ];
  }

  function isInstallingCli() {
    return state.cliInstalling.length > 0
      || Array.from(state.operations.values()).some(operation => operation.state === 'running');
  }

  return { state, subscribe, check, checkCli, restart, updateCli, pendingUpdates, isInstallingCli };
}

export const updateCenter = createUpdateCenter();
export type UpdateCenter = ReturnType<typeof createUpdateCenter>;

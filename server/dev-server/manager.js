import path from 'node:path';
import { readConfigJson, writeConfigJson } from '../config/store.js';
import { mergeConfigMeta } from '../config/validators.js';
import { COMMAND_TIMEOUT_MS, runProcess } from '../process-runner.js';
import {
  cancelRun,
  createBackgroundRun,
  getRun,
  killProcessTree,
  stopActiveRun,
} from '../terminal-runner.js';
import { isPidAlive, readRunIndexEntry } from '../terminal/run-index.js';
import { resolveSafePath, runWithToolContext } from '../runtime/path-access.js';
import { normalizeWorkspacePathKey } from '../workspace/root.js';
import { validateAllowedWorkspaceRoot } from '../chats-workspace/paths.js';
import {
  buildDevServerSpawnEnv,
  resolveEffectiveGuide,
  withStrictPort,
} from './effective-guide.js';
import { PRIMARY_DEV_SERVER_ID, getDevServerDefinition, readDevServers } from './registry.js';
import { readDevServerSettings } from './settings.js';
import { readStartupGuide } from './startup-guide.js';
import { assessHostKillCommand } from '../tools/host-kill-guard.js';
import { assessHostPortBindCommand } from '../tools/host-port-bind-guard.js';
import { probePort } from './ports.js';
import { getEffectiveWorkspaceRoot } from '../runtime/path-access.js';

/** @typedef {'no_guide' | 'stopped' | 'starting' | 'running' | 'stopping' | 'error'} DevServerStatus */

/**
 * @typedef {object} ManagedDevServer
 * @property {string} workspaceKey
 * @property {string} workspaceRoot
 * @property {string} serverId
 * @property {DevServerStatus} status
 * @property {string} [runId]
 * @property {number | null} [pid]
 * @property {string} [command]
 * @property {string} [healthUrl]
 * @property {number} [port]
 * @property {string} [worktreeRoot]
 * @property {string} [error]
 * @property {string} [lastError]
 * @property {number} [startedAt]
 * @property {boolean} [orphaned]
 */

/** @type {Map<string, Map<string, ManagedDevServer>>} */
const byWorkspaceKey = new Map();

const HEALTH_TIMEOUT_MS = 4_000;
const HEALTH_RECONCILE_INTERVAL_MS = 250;

function startingTimeoutMs() {
  const raw = process.env.MINNOW_DEV_SERVER_START_TIMEOUT_MS;
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 45_000;
}

/** @type {Map<string, ReturnType<typeof setInterval>>} */
const healthReconcileTimers = new Map();

/** @type {((healthUrl: string) => Promise<boolean> | boolean) | null} */
let probeHealthOverrideForTests = null;

/**
 * @param {string} workspaceKey
 * @param {string} serverId
 */
function healthReconcileKey(workspaceKey, serverId) {
  return `${workspaceKey}\0${serverId}`;
}

/**
 * @param {string} workspaceKey
 * @param {string} serverId
 */
function stopHealthReconcile(workspaceKey, serverId) {
  const key = healthReconcileKey(workspaceKey, serverId);
  const timer = healthReconcileTimers.get(key);
  if (timer) {
    clearInterval(timer);
    healthReconcileTimers.delete(key);
  }
}

/**
 * @param {ManagedDevServer} row
 * @param {string} healthUrl
 */
function ensureHealthReconcileScheduled(row, healthUrl) {
  if (!healthUrl || row.status !== 'starting') return;
  const key = healthReconcileKey(row.workspaceKey, row.serverId);
  if (healthReconcileTimers.has(key)) return;

  const tick = async () => {
    const wsMap = byWorkspaceKey.get(row.workspaceKey);
    const current = wsMap?.get(row.serverId);
    if (!current || current.status !== 'starting') {
      stopHealthReconcile(row.workspaceKey, row.serverId);
      return;
    }
    const url =
      current.healthUrl && typeof current.healthUrl === 'string' ? current.healthUrl : healthUrl;
    await reconcileHealth(current, url);
    if (current.status !== 'starting') {
      stopHealthReconcile(row.workspaceKey, row.serverId);
    }
  };

  const interval = setInterval(() => {
    void tick();
  }, HEALTH_RECONCILE_INTERVAL_MS);
  if (typeof interval.unref === 'function') interval.unref();
  healthReconcileTimers.set(key, interval);
  void tick();
}

/**
 * @param {ManagedDevServer} row
 */
function isManagedChildAlive(row) {
  if (row.runId) {
    const run = getRun(row.runId);
    if (run && !run.finished) return true;
  }
  if (row.pid != null && isPidAlive(row.pid)) return true;
  return false;
}

/**
 * @param {string} workspaceRoot
 */
function workspaceKey(workspaceRoot) {
  return normalizeWorkspacePathKey(path.resolve(workspaceRoot));
}

/**
 * @param {string} key
 * @returns {Promise<Record<string, Record<string, unknown>>>}
 */
async function readPersistedServers(key) {
  const meta = (await readConfigJson('config.json')) ?? {};
  const ws =
    meta.workspace && typeof meta.workspace === 'object'
      ? /** @type {Record<string, unknown>} */ (meta.workspace)
      : null;
  const byPath =
    ws?.devServerByPath && typeof ws.devServerByPath === 'object'
      ? /** @type {Record<string, unknown>} */ (ws.devServerByPath)
      : null;
  const row = byPath?.[key];
  if (!row || typeof row !== 'object') return {};

  const obj = /** @type {Record<string, unknown>} */ (row);
  if (obj.servers && typeof obj.servers === 'object' && !Array.isArray(obj.servers)) {
    return /** @type {Record<string, Record<string, unknown>>>} */ (obj.servers);
  }
  if (typeof obj.status === 'string') {
    return { [PRIMARY_DEV_SERVER_ID]: obj };
  }
  return {};
}

/**
 * @param {string} key
 * @param {Record<string, Record<string, unknown>>} servers
 */
async function persistServers(key, servers) {
  const meta = (await readConfigJson('config.json')) ?? {};
  const existingWs =
    meta.workspace && typeof meta.workspace === 'object'
      ? { .../** @type {Record<string, unknown>} */ (meta.workspace) }
      : {};
  const byPath =
    existingWs.devServerByPath && typeof existingWs.devServerByPath === 'object'
      ? { .../** @type {Record<string, unknown>} */ (existingWs.devServerByPath) }
      : {};
  byPath[key] = { servers };
  existingWs.devServerByPath = byPath;
  const merged = mergeConfigMeta(meta, { workspace: existingWs });
  if (merged.workspace && typeof merged.workspace === 'object') {
    /** @type {Record<string, unknown>} */ (merged.workspace).devServerByPath = byPath;
  }
  await writeConfigJson('config.json', merged);
}

/**
 * @param {ManagedDevServer} row
 */
async function saveState(row) {
  let wsMap = byWorkspaceKey.get(row.workspaceKey);
  if (!wsMap) {
    wsMap = new Map();
    byWorkspaceKey.set(row.workspaceKey, wsMap);
  }
  wsMap.set(row.serverId, row);

  const servers = {};
  for (const [id, r] of wsMap) {
    servers[id] = {
      status: r.status,
      runId: r.runId ?? null,
      pid: r.pid ?? null,
      command: r.command ?? null,
      healthUrl: r.healthUrl ?? null,
      port: r.port ?? null,
      worktreeRoot: r.worktreeRoot ?? null,
      error: r.error ?? null,
      lastError: r.lastError ?? null,
      startedAt: r.startedAt ?? null,
      orphaned: r.orphaned ?? false,
    };
  }
  await persistServers(row.workspaceKey, servers);
}

/**
 * @param {string} root
 * @param {string} serverId
 * @returns {Promise<ManagedDevServer>}
 */
async function getOrInitRow(root, serverId = PRIMARY_DEV_SERVER_ID) {
  const key = workspaceKey(root);
  let wsMap = byWorkspaceKey.get(key);
  if (!wsMap) {
    wsMap = new Map();
    byWorkspaceKey.set(key, wsMap);
  }
  const existing = wsMap.get(serverId);
  if (existing) return existing;

  const persistedMap = await readPersistedServers(key);
  const persisted = persistedMap[serverId] ?? null;
  /** @type {ManagedDevServer} */
  const row = {
    workspaceKey: key,
    workspaceRoot: path.resolve(root),
    serverId,
    status: 'stopped',
    runId: typeof persisted?.runId === 'string' ? persisted.runId : undefined,
    pid: typeof persisted?.pid === 'number' ? persisted.pid : null,
    command: typeof persisted?.command === 'string' ? persisted.command : undefined,
    healthUrl: typeof persisted?.healthUrl === 'string' ? persisted.healthUrl : undefined,
    port: typeof persisted?.port === 'number' ? persisted.port : undefined,
    worktreeRoot:
      typeof persisted?.worktreeRoot === 'string' ? persisted.worktreeRoot : undefined,
    error: typeof persisted?.error === 'string' ? persisted.error : undefined,
    lastError: typeof persisted?.lastError === 'string' ? persisted.lastError : undefined,
    startedAt: typeof persisted?.startedAt === 'number' ? persisted.startedAt : undefined,
    orphaned: persisted?.orphaned === true,
  };

  if (persisted?.status === 'running' || persisted?.status === 'starting') {
    row.status = /** @type {DevServerStatus} */ (persisted.status);
  } else if (persisted?.status === 'error') {
    row.status = 'error';
  }

  wsMap.set(serverId, row);
  return row;
}

/**
 * @param {ManagedDevServer} row
 */
async function reconcileRow(row) {
  if (!row.runId) {
    if (row.status === 'running' || row.status === 'starting') {
      row.status = 'stopped';
      row.error = undefined;
      await saveState(row);
    } else if (row.status === 'error') {
      if (row.error) row.lastError = row.error;
      row.status = 'stopped';
      row.error = undefined;
      await saveState(row);
    }
    return row;
  }

  const run = getRun(row.runId);
  if (run?.finished) {
    row.status = 'stopped';
    row.runId = undefined;
    row.pid = null;
    row.error = undefined;
    await saveState(row);
    return row;
  }

  if (!run && row.status !== 'stopping') {
    if (row.startedAt && Date.now() - row.startedAt < 2_000) {
      return row;
    }
    const indexed = await readRunIndexEntry(row.runId);
    if (indexed && !indexed.finished && isPidAlive(indexed.pid)) {
      row.status = 'running';
      row.pid = indexed.pid ?? row.pid ?? null;
      row.orphaned = true;
      await saveState(row);
      return row;
    }
    row.status = 'stopped';
    row.runId = undefined;
    row.pid = null;
    row.orphaned = false;
    await saveState(row);
  }

  return row;
}

/**
 * @param {string} [healthUrl]
 * @returns {Promise<boolean>}
 */
async function probeHealth(healthUrl) {
  if (!healthUrl || typeof healthUrl !== 'string') return true;
  if (probeHealthOverrideForTests) {
    return Boolean(await probeHealthOverrideForTests(healthUrl));
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
    const res = await fetch(healthUrl, {
      method: 'GET',
      signal: controller.signal,
      redirect: 'follow',
    });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * @param {ManagedDevServer} row
 * @param {{ runId: string, pid: number, startedAt: number }} started
 * @param {{ command: string, healthUrl?: string, port?: number }} guide
 */
async function applyStartedRun(row, started, guide) {
  row.runId = started.runId;
  row.pid = started.pid;
  row.startedAt = started.startedAt;
  row.command = guide.command;
  row.healthUrl = guide.healthUrl;
  row.port = guide.port;
  row.error = undefined;
  row.orphaned = false;

  if (guide.healthUrl) {
    const ok = await probeHealth(guide.healthUrl);
    row.status = ok ? 'running' : 'starting';
  } else {
    row.status = 'running';
  }

  await saveState(row);
  if (row.status === 'starting' && guide.healthUrl) {
    ensureHealthReconcileScheduled(row, guide.healthUrl);
  }
}

/**
 * @param {Record<string, unknown>} args
 * @param {{ command: string }} guide
 */
function shouldRegisterDevServerFromTool(args, guide) {
  if (args?.register_dev_server === true) return true;
  const command = typeof args?.command === 'string' ? args.command.trim() : '';
  return command.length > 0 && command === guide.command.trim();
}

/**
 * @param {import('./registry.js').DevServerDefinition | null} def
 * @param {{ command: string, cwd?: string, healthUrl?: string, port?: number, apiPort?: number, stop?: { command?: string } } | null} startupGuide
 * @param {{ port: number, network: 'local' | 'lan' }} settings
 * @param {string} workspaceRoot
 */
function effectiveFromDefinition(def, startupGuide, settings, workspaceRoot) {
  if (!def && !startupGuide) return null;
  const guide = {
    command: def?.command ?? startupGuide?.command ?? '',
    cwd: def?.cwd ?? startupGuide?.cwd,
    healthUrl: def?.healthUrl ?? startupGuide?.healthUrl,
    port: def?.port ?? startupGuide?.port,
    apiPort: startupGuide?.apiPort,
    stop: startupGuide?.stop,
  };
  if (!guide.command) return null;
  const packageJsonDir = path.join(path.resolve(workspaceRoot), guide.cwd ?? '.');
  return resolveEffectiveGuide(
    guide,
    {
      port: def?.port ?? settings.port,
      network: def?.network ?? settings.network,
    },
    { packageJsonDir },
  );
}

/**
 * @param {ManagedDevServer} row
 * @param {string | undefined} healthUrl
 */
async function reconcileHealth(row, healthUrl) {
  let healthOk = null;
  if ((row.status === 'running' || row.status === 'starting') && healthUrl) {
    healthOk = await probeHealth(healthUrl);
    if (row.status === 'starting' && healthOk && isManagedChildAlive(row)) {
      row.status = 'running';
      await saveState(row);
    } else if (
      row.status === 'starting' &&
      healthOk === false &&
      row.startedAt &&
      Date.now() - row.startedAt > startingTimeoutMs()
    ) {
      if (row.runId) {
        const run = getRun(row.runId);
        if (run?.child && !run.finished) {
          killProcessTree(run.child);
        } else {
          cancelRun(row.runId);
        }
      }
      row.status = 'error';
      row.error = 'Health check timed out';
      row.runId = undefined;
      row.pid = null;
      await saveState(row);
    }
  }
  return healthOk;
}

/**
 * @param {string} registryRoot
 * @param {{ worktreeRoot?: string } | null | undefined} def
 * @param {string | undefined} overrideWorktreeRoot
 */
async function resolveDevServerRunRoot(registryRoot, def, overrideWorktreeRoot) {
  const candidate =
    (typeof overrideWorktreeRoot === 'string' && overrideWorktreeRoot.trim()) ||
    (typeof def?.worktreeRoot === 'string' && def.worktreeRoot.trim()) ||
    registryRoot;
  return validateAllowedWorkspaceRoot(candidate);
}

/**
 * @param {string} [workspaceRoot]
 * @param {string} [serverId]
 */
export async function getDevServerStatusById(
  workspaceRoot = getEffectiveWorkspaceRoot(),
  serverId = PRIMARY_DEV_SERVER_ID,
) {
  const root = path.resolve(workspaceRoot);
  const startup = await readStartupGuide(root);
  const settings = await readDevServerSettings(root);
  const def = await getDevServerDefinition(root, serverId);
  let row = await getOrInitRow(root, serverId);
  row = await reconcileRow(row);
  const runRoot = row.worktreeRoot ?? def?.worktreeRoot ?? root;
  const effective = effectiveFromDefinition(def, startup.guide, settings, runRoot);

  const live = row.status === 'running' || row.status === 'starting';
  const healthUrl = live
    ? (row.healthUrl ?? effective?.healthUrl ?? def?.healthUrl ?? startup.guide?.healthUrl)
    : (effective?.healthUrl ?? def?.healthUrl ?? startup.guide?.healthUrl ?? row.healthUrl);
  const healthOk = await reconcileHealth(row, healthUrl);
  if (row.status === 'starting' && healthUrl) {
    ensureHealthReconcileScheduled(row, healthUrl);
  }

  const hasGuide = Boolean(def?.command || (serverId === PRIMARY_DEV_SERVER_ID && startup.guide));
  const displayPort = live
    ? (row.port ?? effective?.port ?? def?.port ?? startup.guide?.port ?? null)
    : (effective?.port ?? def?.port ?? startup.guide?.port ?? row.port ?? null);
  const portInUse =
    displayPort != null ? (await probePort(displayPort)) === 'in-use' : false;

  const displayCommand = live
    ? (row.command ?? effective?.command ?? def?.command ?? startup.guide?.command ?? null)
    : (effective?.command ?? def?.command ?? startup.guide?.command ?? row.command ?? null);

  const listError = live
    ? (row.error ?? startup.parseError ?? null)
    : (startup.parseError ?? null);

  return {
    id: serverId,
    def: def,
    workspacePath: root,
    worktreeRoot: row.worktreeRoot ?? def?.worktreeRoot ?? root,
    startupExists: startup.exists,
    guide: startup.guide,
    effectiveGuide: effective,
    settings,
    parseError: startup.parseError,
    status: hasGuide ? row.status : 'no_guide',
    runId: row.runId ?? null,
    pid: row.pid ?? null,
    port: displayPort,
    network: effective?.network ?? def?.network ?? settings.network ?? null,
    healthUrl: healthUrl ?? null,
    healthOk,
    portInUse,
    error: listError,
    lastError: row.lastError ?? null,
    command: displayCommand,
    startedAt: row.startedAt ?? null,
  };
}

/**
 * @param {string} [workspaceRoot]
 */
export async function listDevServerStatuses(workspaceRoot = getEffectiveWorkspaceRoot()) {
  const root = path.resolve(workspaceRoot);
  const defs = await readDevServers(root);
  if (defs.length === 0) {
    const primary = await getDevServerStatusById(root, PRIMARY_DEV_SERVER_ID);
    return {
      servers: [
        {
          def: null,
          status: primary.status,
          runId: primary.runId,
          pid: primary.pid,
          healthOk: primary.healthOk,
          startedAt: primary.startedAt,
          portInUse: primary.portInUse,
          port: primary.port,
          network: primary.network,
          command: primary.command,
          healthUrl: primary.healthUrl,
          error: primary.error,
          id: PRIMARY_DEV_SERVER_ID,
          name: 'primary',
        },
      ],
    };
  }

  const servers = [];
  for (const def of defs) {
    const st = await getDevServerStatusById(root, def.id);
    servers.push({
      def,
      status: st.status,
      runId: st.runId,
      pid: st.pid,
      healthOk: st.healthOk,
      startedAt: st.startedAt,
      portInUse: st.portInUse,
      port: st.port,
      network: st.network,
      command: st.command,
      healthUrl: st.healthUrl,
      error: st.error,
      worktreeRoot: st.worktreeRoot,
      id: def.id,
      name: def.name,
    });
  }
  return { servers };
}

/**
 * @param {string} [workspaceRoot]
 */
export async function getDevServerStatus(workspaceRoot = getEffectiveWorkspaceRoot()) {
  return getDevServerStatusById(workspaceRoot, PRIMARY_DEV_SERVER_ID);
}

/**
 * @param {string} [workspaceRoot]
 * @param {string} [serverId]
 * @param {{ worktreeRoot?: string, strictPort?: boolean }} [options]
 */
export async function startDevServerById(
  workspaceRoot = getEffectiveWorkspaceRoot(),
  serverId = PRIMARY_DEV_SERVER_ID,
  options = {},
) {
  const registryRoot = path.resolve(workspaceRoot);
  const startup = await readStartupGuide(registryRoot);
  const settings = await readDevServerSettings(registryRoot);
  let def = await getDevServerDefinition(registryRoot, serverId);

  if (!def && serverId === PRIMARY_DEV_SERVER_ID) {
    await readDevServers(registryRoot);
    def = await getDevServerDefinition(registryRoot, serverId);
  }

  let runRoot;
  try {
    runRoot = await resolveDevServerRunRoot(registryRoot, def, options.worktreeRoot);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }

  const runStartup = runRoot === registryRoot ? startup : await readStartupGuide(runRoot);

  if (!def?.command) {
    if (!runStartup.exists) {
      return { ok: false, error: 'startup.md not found in workspace root' };
    }
    if (!runStartup.guide) {
      return { ok: false, error: runStartup.parseError ?? 'Invalid startup.md' };
    }
  }

  const resolved = effectiveFromDefinition(def, runStartup.guide, settings, runRoot);
  if (!resolved) {
    return { ok: false, error: 'No command configured for this server' };
  }
  const effective =
    options.strictPort === true
      ? { ...resolved, command: withStrictPort(resolved.command) }
      : resolved;

  let row = await getOrInitRow(registryRoot, serverId);
  row = await reconcileRow(row);

  const liveInThisHost = Boolean(row.runId && getRun(row.runId) && !getRun(row.runId)?.finished);
  if (row.status === 'running' && row.runId && (liveInThisHost || row.orphaned)) {
    return {
      ok: true,
      status: row.status,
      runId: row.runId,
      alreadyRunning: true,
      ...(row.orphaned && !liveInThisHost ? { orphaned: true, pid: row.pid ?? null } : {}),
    };
  }

  const cwdRel = effective.cwd ?? '.';

  row.status = 'starting';
  row.startedAt = Date.now();
  row.command = effective.command;
  row.healthUrl = effective.healthUrl;
  row.port = effective.port;
  row.worktreeRoot = runRoot;
  row.error = undefined;
  await saveState(row);

  try {
    const started = await runWithToolContext(
      async () => {
        const cwd = resolveSafePath(cwdRel, { write: false });
        return createBackgroundRun({
          command: effective.command,
          cwd,
          shell: false,
          source: 'agent',
          sandbox: false,
          logSubdir: 'dev-server',
          env: buildDevServerSpawnEnv(effective.port, effective.network, {
            splitStack: effective.splitStack,
            apiPort: effective.apiPort,
          }),
        });
      },
      { workspaceRoot: runRoot },
    );

    await applyStartedRun(row, started, effective);
    return {
      ok: true,
      status: row.status,
      runId: row.runId,
      pid: row.pid,
      worktreeRoot: runRoot,
      alreadyRunning: false,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    row.status = 'error';
    row.error = message;
    row.runId = undefined;
    row.pid = null;
    await saveState(row);
    return { ok: false, error: message };
  }
}

/**
 * @param {string} [workspaceRoot]
 */
export async function startDevServer(workspaceRoot = getEffectiveWorkspaceRoot()) {
  return startDevServerById(workspaceRoot, PRIMARY_DEV_SERVER_ID);
}

/**
 * @param {string} [workspaceRoot]
 * @param {string} [serverId]
 */
export async function stopDevServerById(
  workspaceRoot = getEffectiveWorkspaceRoot(),
  serverId = PRIMARY_DEV_SERVER_ID,
) {
  const registryRoot = path.resolve(workspaceRoot);
  const def = await getDevServerDefinition(registryRoot, serverId);
  let row = await getOrInitRow(registryRoot, serverId);
  const runRoot = row.worktreeRoot ?? def?.worktreeRoot ?? registryRoot;
  const startup = await readStartupGuide(runRoot);

  const hasGuide = Boolean(def?.command || (serverId === PRIMARY_DEV_SERVER_ID && startup.guide));

  if (!row.runId && row.status !== 'running' && row.status !== 'starting') {
    row.status = hasGuide ? 'stopped' : 'no_guide';
    await saveState(row);
    return { ok: true, status: row.status };
  }

  stopHealthReconcile(row.workspaceKey, row.serverId);
  row.status = 'stopping';
  await saveState(row);

  const stopCmd =
    serverId === PRIMARY_DEV_SERVER_ID || def?.source === 'startup.md'
      ? startup.guide?.stop?.command
      : undefined;
  if (stopCmd) {
    try {
      await runWithToolContext(
        async () => {
          const cwd = resolveSafePath(startup.guide?.cwd ?? def?.cwd ?? '.', { write: false });
          await runProcess(
            process.platform === 'win32' ? 'cmd.exe' : 'sh',
            process.platform === 'win32' ? ['/d', '/s', '/c', stopCmd] : ['-c', stopCmd],
            { cwd, timeout: COMMAND_TIMEOUT_MS, shell: false },
          );
        },
        { workspaceRoot: runRoot },
      );
    } catch {
    }
  }

  if (row.runId) {
    const run = getRun(row.runId);
    if (run?.child && !run.finished) {
      killProcessTree(run.child);
    } else {
      cancelRun(row.runId);
    }
  }

  row.status = hasGuide ? 'stopped' : 'no_guide';
  row.runId = undefined;
  row.pid = null;
  row.worktreeRoot = undefined;
  row.error = undefined;
  row.startedAt = undefined;
  await saveState(row);

  return { ok: true, status: row.status };
}

/**
 * @param {string} [workspaceRoot]
 */
export async function stopDevServer(workspaceRoot = getEffectiveWorkspaceRoot()) {
  return stopDevServerById(workspaceRoot, PRIMARY_DEV_SERVER_ID);
}

/**
 * @param {string} [workspaceRoot]
 * @param {string} [serverId]
 */
export async function restartDevServerById(
  workspaceRoot = getEffectiveWorkspaceRoot(),
  serverId = PRIMARY_DEV_SERVER_ID,
  options = {},
) {
  await stopDevServerById(workspaceRoot, serverId);
  return startDevServerById(workspaceRoot, serverId, options);
}

/**
 * @param {string} runId
 */
async function clearRowForRunId(runId) {
  for (const wsMap of byWorkspaceKey.values()) {
    for (const row of wsMap.values()) {
      if (row.runId === runId) {
        stopHealthReconcile(row.workspaceKey, row.serverId);
        row.status = 'stopped';
        row.runId = undefined;
        row.pid = null;
        row.orphaned = false;
        row.startedAt = undefined;
        await saveState(row);
        return;
      }
    }
  }
}

/**
 * @param {Record<string, unknown>} args
 */
export async function toolStartBackgroundCommand(args) {
  const command = typeof args?.command === 'string' ? args.command.trim() : '';
  if (!command) return 'Error: command is required';

  const hostKill = assessHostKillCommand(command);
  if (hostKill) return hostKill;
  const portBind = assessHostPortBindCommand(command);
  if (portBind) return portBind;

  const cwdUser = typeof args?.cwd === 'string' && args.cwd.trim() ? args.cwd.trim() : '.';
  let cwd;
  try {
    cwd = resolveSafePath(cwdUser, { write: false });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `Error: ${message}`;
  }

  try {
    const chatId = typeof args?.chatId === 'string' ? args.chatId : undefined;
    let spawnEnv;
    try {
      const { resolveBoardTaskSpawnEnvForCommand } = await import(
        '../workspace/board-task-ports.js'
      );
      spawnEnv = await resolveBoardTaskSpawnEnvForCommand({ chatId, cwd });
    } catch {
      spawnEnv = undefined;
    }

    const shellProfile = await (
      await import('../terminal/shell-config.js')
    ).resolveExecuteShellProfile(getEffectiveWorkspaceRoot());

    const started = await createBackgroundRun({
      command,
      cwd,
      shell: false,
      source: 'agent',
      chatId,
      allowUnsandboxed: args?.allow_unsandboxed === true,
      logSubdir: 'dev-server',
      shellProfile,
      ...(spawnEnv ? { env: spawnEnv } : {}),
    });
    if (started.error) return started.error;

    const root = path.resolve(getEffectiveWorkspaceRoot());
    const startup = await readStartupGuide(root);
    if (startup.guide && shouldRegisterDevServerFromTool(args, startup.guide)) {
      const settings = await readDevServerSettings(root);
      await readDevServers(root); 
      const effective = resolveEffectiveGuide(startup.guide, settings, {
        packageJsonDir: path.join(root, startup.guide.cwd ?? '.'),
      });
      const row = await getOrInitRow(root, PRIMARY_DEV_SERVER_ID);
      row.command = effective.command;
      row.healthUrl = effective.healthUrl;
      row.port = effective.port;
      await applyStartedRun(row, started, effective);
    }

    return JSON.stringify(
      {
        ok: true,
        runId: started.runId,
        pid: started.pid,
        logPath: started.logPath,
        startedAt: started.startedAt,
      },
      null,
      2,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `Error: ${message}`;
  }
}

/**
 * @param {Record<string, unknown>} args
 */
export async function toolStopBackgroundCommand(args) {
  const runId = typeof args?.run_id === 'string' ? args.run_id.trim() : '';
  if (!runId) return 'Error: run_id is required';

  const stopped = await stopActiveRun(runId);
  if (!stopped.ok) {
    return `Error: ${stopped.error}`;
  }

  await clearRowForRunId(runId);

  return JSON.stringify(
    { ok: true, runId, ...(stopped.alreadyStopped ? { alreadyStopped: true } : {}) },
    null,
    2,
  );
}

export async function toolStopCommand(args) {
  const runId = typeof args?.run_id === 'string' ? args.run_id.trim() : '';
  if (!runId) return 'Error: run_id is required';

  const stopped = await stopActiveRun(runId);
  if (!stopped.ok) {
    return `Error: ${stopped.error}`;
  }

  await clearRowForRunId(runId);

  return JSON.stringify(
    { ok: true, runId, ...(stopped.alreadyStopped ? { alreadyStopped: true } : {}) },
    null,
    2,
  );
}

export function resetDevServerManagerForTests() {
  for (const timer of healthReconcileTimers.values()) {
    clearInterval(timer);
  }
  healthReconcileTimers.clear();
  probeHealthOverrideForTests = null;
  byWorkspaceKey.clear();
}

/** @param {(healthUrl: string) => Promise<boolean> | boolean} fn */
export function setProbeHealthOverrideForTests(fn) {
  probeHealthOverrideForTests = fn;
}

export { readStartupGuide };

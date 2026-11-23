import { spawn, spawnSync } from 'node:child_process';
import fsp from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { killProcessTree, killProcessTreeAndWait } from '../terminal-runner.js';
import { readResource, writeResource } from '../config/store.js';
import { waitForHealth as waitForEndpointHealth } from '../models/wait-for-health.js';
import { getServerDef, listServerDefs } from './catalog.js';
import {
  getServerLogPath,
  getServerRunPath,
  getServerVenvDir,
  getServersRoot,
} from './paths.js';
import { realpathForBoundaryCheck } from '../workspace/safe-path.js';
import { MODEL_LOAD_TIMEOUT_MS } from '../models/timeouts.js';

/** @typedef {'pending'|'installing'|'starting'|'running'|'stopped'|'error'} ServerRuntimePhase */

/**
 * @typedef {object} ServerJob
 * @property {string} serverId
 * @property {'pending'|'installing'|'done'|'error'} phase
 * @property {number} percent
 * @property {string} message
 * @property {string | undefined} error
 */

/**
 * @typedef {object} ManagedProcessState
 * @property {import('node:child_process').ChildProcess} child
 * @property {number} port
 * @property {boolean} healthy
 * @property {ServerRuntimePhase} phase
 */

/** @type {Map<string, Promise<void>>} */
const serverLogWriteQueues = new Map();


/** @type {Map<string, ManagedProcessState>} */
const processes = new Map();

/** @type {Map<string, ServerJob>} */
const jobs = new Map();

/** @type {Map<string, Promise<{ ok: boolean; error?: string; alreadyInstalled?: boolean; job?: ServerJob | null }>>} */
const installPromises = new Map();

/** @type {Map<string, string[]>} */
const logRingBuffers = new Map();

/** @type {Map<string, Set<(event: object) => void>>} */
const serverStateListeners = new Map();

const LOG_RING_MAX_LINES = 500;

/** @type {typeof spawn | null} */
let spawnOverrideForTests = null;

/** @type {typeof fetch | null} */
let fetchOverrideForTests = null;

/**
 * @type {((serverId: string, onProgress?: (message: string) => void) => Promise<void>) | null}
 */
let installProvisionOverrideForTests = null;

/** @type {typeof killProcessTreeAndWait | null} */
let killTreeWaitOverrideForTests = null;

export function setKillTreeWaitOverrideForTests(fn) {
  killTreeWaitOverrideForTests = fn;
}

export function resetKillTreeWaitOverrideForTests() {
  killTreeWaitOverrideForTests = null;
}

async function killManagedChildAndWait(child, opts) {
  if (killTreeWaitOverrideForTests) {
    return killTreeWaitOverrideForTests(child, opts);
  }
  return killProcessTreeAndWait(child, opts);
}

export function setManagerSpawnOverrideForTests(fn) {
  spawnOverrideForTests = fn;
}

export function resetManagerSpawnOverrideForTests() {
  spawnOverrideForTests = null;
}

export function setManagerFetchOverrideForTests(fn) {
  fetchOverrideForTests = fn;
}

export function resetManagerFetchOverrideForTests() {
  fetchOverrideForTests = null;
}

export function setInstallProvisionOverrideForTests(fn) {
  installProvisionOverrideForTests = fn;
}

export function resetInstallProvisionOverrideForTests() {
  installProvisionOverrideForTests = null;
}

export function resetManagerStateForTests() {
  for (const [, state] of processes) {
    killProcessTree(state.child);
  }
  processes.clear();
  jobs.clear();
  installPromises.clear();
  logRingBuffers.clear();
  serverStateListeners.clear();
}

/**
 * @param {string} serverId
 * @param {(event: object) => void} listener
 * @returns {() => void}
 */
export function subscribeServerState(serverId, listener) {
  let set = serverStateListeners.get(serverId);
  if (!set) {
    set = new Set();
    serverStateListeners.set(serverId, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) serverStateListeners.delete(serverId);
  };
}

/**
 * @param {string} serverId
 * @param {object} event
 */
function emitServerState(serverId, event) {
  const set = serverStateListeners.get(serverId);
  if (!set) return;
  for (const listener of [...set]) {
    try {
      listener(event);
    } catch {
    }
  }
}

/**
 * @param {string} command
 * @param {readonly string[]} args
 * @param {import('node:child_process').SpawnOptions} options
 */
function spawnManaged(command, args, options) {
  if (spawnOverrideForTests) {
    return spawnOverrideForTests(command, args, options);
  }
  return spawn(command, args, options);
}

function updateJob(serverId, patch) {
  const prev = jobs.get(serverId) ?? {
    serverId,
    phase: 'pending',
    percent: 0,
    message: '',
  };
  const next = { ...prev, ...patch, serverId };
  jobs.set(serverId, next);
  return next;
}

/**
 * @param {string} serverId
 * @param {string} chunk
 */
async function appendServerLog(serverId, chunk) {
  const text = String(chunk);
  if (!text) return;

  const lines = logRingBuffers.get(serverId) ?? [];
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    lines.push(line);
  }
  while (lines.length > LOG_RING_MAX_LINES) {
    lines.shift();
  }
  logRingBuffers.set(serverId, lines);

  const logPath = getServerLogPath(serverId);
  const prev = serverLogWriteQueues.get(logPath) ?? Promise.resolve();
  const next = prev.then(async () => {
    await fsp.mkdir(path.dirname(logPath), { recursive: true });
    await fsp.appendFile(logPath, text, 'utf8');
  }).catch(() => {}).finally(() => {
    if (serverLogWriteQueues.get(logPath) === next) {
      serverLogWriteQueues.delete(logPath);
    }
  });
  serverLogWriteQueues.set(logPath, next);
  return next;
}

/**
 * @param {string} serverId
 * @param {number} port
 * @param {string} healthPath
 */
async function waitForHealth(serverId, port, healthPath, timeoutMs = MODEL_LOAD_TIMEOUT_MS) {
  const url = `http://127.0.0.1:${port}${healthPath}`;
  const result = await waitForEndpointHealth({
    healthPath,
    port,
    timeoutMs,
    label: serverId,
    fetchImpl: fetchOverrideForTests ?? fetch,
  });
  if (!result.ok) {
    throw new Error(`Health check timed out for ${serverId} (${url})`);
  }
  return true;
}

/**
 * @param {number} port
 */
function isLocalPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolve(true));
    });
  });
}

/**
 * @param {string} serverId
 * @param {{ pid: number, port: number, startedAt: number, command: string }} record
 */
async function writeServerRunRecord(serverId, record) {
  const runPath = getServerRunPath(serverId);
  await fsp.mkdir(path.dirname(runPath), { recursive: true });
  await fsp.writeFile(runPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
}

async function deleteServerRunRecord(serverId) {
  try {
    await fsp.rm(getServerRunPath(serverId), { force: true });
  } catch {
  }
}

/**
 * @param {number} pid
 */
function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {number} pid
 */
function readProcessCommandLine(pid) {
  if (!isPidAlive(pid)) return null;
  if (process.platform === 'win32') {
    try {
      const out = spawnSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
        ],
        { encoding: 'utf8', windowsHide: true, timeout: 5000 },
      );
      const line = (out.stdout ?? '').trim();
      return line || null;
    } catch {
      return null;
    }
  }
  try {
    const psArgs =
      process.platform === 'darwin'
        ? ['-ww', '-o', 'command=', '-p', String(pid)]
        : ['-o', 'command=', '-p', String(pid)];
    const out = spawnSync('ps', psArgs, {
      encoding: 'utf8',
      timeout: 5000,
    });
    const line = (out.stdout ?? '').trim();
    return line || null;
  } catch {
    return null;
  }
}

/**
 * @param {number} pid
 */
function readDarwinProcessExecutable(pid) {
  if (process.platform !== 'darwin' || !isPidAlive(pid)) return null;
  try {
    const out = spawnSync('sysctl', ['-n', `proc_pidpath:${pid}`], {
      encoding: 'utf8',
      timeout: 5000,
    });
    const line = (out.stdout ?? '').trim();
    return line || null;
  } catch {
    return null;
  }
}

/**
 * @param {string} serverId
 * @param {string} recordedCommand
 * @param {string} liveCommand
 * @param {number} [pid]
 */
function processCommandMatchesServer(serverId, recordedCommand, liveCommand, pid) {
  if (!liveCommand) return false;
  const venvDir = getServerVenvDir(serverId);
  let venvReal = path.normalize(venvDir);
  try {
    venvReal = path.normalize(realpathForBoundaryCheck(path.resolve(venvDir)));
  } catch {
  }
  const venvNorm = path.normalize(venvDir);
  const executable = Number.isInteger(pid) && pid > 0 ? readDarwinProcessExecutable(pid) : null;
  if (executable) {
    const normalizedExe = path.normalize(executable);
    if (normalizedExe.includes(venvReal) || normalizedExe.includes(venvNorm)) {
      return true;
    }
  }
  const normalizedLive = path.normalize(liveCommand);
  if (normalizedLive.includes(venvReal) || normalizedLive.includes(venvNorm)) {
    return true;
  }
  if (recordedCommand && liveCommand.includes(recordedCommand.trim().slice(0, 48))) return true;
  return false;
}

/**
 * @param {number} pid
 * @param {{ graceMs?: number }} [opts]
 */
async function killPidTreeAndWait(pid, opts = {}) {
  if (!isPidAlive(pid)) return;
  const handle = { pid };
  if (killTreeWaitOverrideForTests) {
    return killTreeWaitOverrideForTests(handle, opts);
  }
  return killProcessTreeAndWait(handle, opts);
}

/**
 * @param {string} serverId
 */
async function reapOrphanedServerRun(serverId) {
  const def = getServerDef(serverId);
  if (!def || def.kind === 'native-binary') return;

  let raw;
  try {
    raw = await fsp.readFile(getServerRunPath(serverId), 'utf8');
  } catch {
    return;
  }

  /** @type {{ pid?: number, command?: string }} */
  let record;
  try {
    record = JSON.parse(raw);
  } catch {
    await deleteServerRunRecord(serverId);
    return;
  }

  const pid = Number(record.pid);
  if (!Number.isInteger(pid) || pid <= 0) {
    await deleteServerRunRecord(serverId);
    return;
  }

  if (!isPidAlive(pid)) {
    await deleteServerRunRecord(serverId);
    return;
  }

  const liveCommand = readProcessCommandLine(pid);
  const recordedCommand = typeof record.command === 'string' ? record.command : '';
  if (!processCommandMatchesServer(serverId, recordedCommand, liveCommand ?? '', pid)) {
    await deleteServerRunRecord(serverId);
    return;
  }

  await killPidTreeAndWait(pid);
  await deleteServerRunRecord(serverId);
}

export async function reapOrphanedServers() {
  for (const def of listServerDefs()) {
    try {
      await reapOrphanedServerRun(def.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[servers] reap orphan ${def.id} failed: ${message}`);
    }
  }
}

/**
 * @param {string} serverId
 */
export function getServerJob(serverId) {
  return jobs.get(serverId) ?? null;
}

/**
 * @param {string} serverId
 */
export async function getInstallStatus(serverId) {
  const def = getServerDef(serverId);
  if (!def) {
    return { serverId, found: false, installed: false };
  }
  const status = await def.provisioner.getInstallStatus();
  const job = getServerJob(serverId);
  return {
    serverId,
    found: true,
    kind: def.kind,
    label: def.label,
    ...status,
    job,
  };
}

export async function listServers() {
  const config = await readResource('servers');
  const defs = listServerDefs();
  const out = [];

  for (const def of defs) {
    const entry = config[def.id] ?? {
      enabled: false,
      autoStart: def.defaultAutoStart,
      port: def.defaultPort,
    };
    const install = await getInstallStatus(def.id);
    const proc = processes.get(def.id);
    out.push({
      id: def.id,
      label: def.label,
      description: def.description,
      kind: def.kind,
      healthPath: def.healthPath,
      enabled: entry.enabled === true,
      autoStart: entry.autoStart === true,
      port: entry.port,
      defaultPort: def.defaultPort,
      installed: install.installed,
      version: install.version,
      running: proc?.phase === 'running' && proc?.healthy === true,
      phase: proc?.phase ?? (install.installed ? 'stopped' : 'pending'),
      job: install.job,
      supported: install.supported,
      installable: install.installable,
      reason: install.reason ?? null,
      ...(def.id === 'mtplx' ? { path: install.path, source: install.source, appPath: install.appPath, appVersion: install.appVersion } : {}),
    });
  }

  return out;
}

/**
 * @param {string} serverId
 */
async function runInstallServer(serverId) {
  const def = getServerDef(serverId);
  if (!def) throw new Error(`Unknown server: ${serverId}`);

  const config = await readResource('servers');
  const port = config[serverId]?.port ?? def.defaultPort;
  if (installProvisionOverrideForTests) {
    await installProvisionOverrideForTests(serverId, (msg) => {
      updateJob(serverId, { phase: 'installing', percent: 50, message: msg });
    });
  } else {
    await def.provisioner.provision((msg) => {
      updateJob(serverId, { phase: 'installing', percent: 50, message: msg });
    });
  }
  if (serverId === 'searxng' && def.provisioner.writeSearxngSettings) {
    await def.provisioner.writeSearxngSettings(port);
  }
  updateJob(serverId, { phase: 'done', percent: 100, message: 'Installed', error: undefined });
}

/**
 * @param {string} serverId
 */
export async function startInstallServer(serverId) {
  const def = getServerDef(serverId);
  if (!def) throw new Error(`Unknown server: ${serverId}`);

  const existingPromise = installPromises.get(serverId);
  if (existingPromise) {
    return { ok: true, inProgress: true, job: getServerJob(serverId) };
  }

  const status = await def.provisioner.getInstallStatus();
  if (status.installed) {
    updateJob(serverId, { phase: 'done', percent: 100, message: 'Already installed' });
    return { ok: true, alreadyInstalled: true, job: getServerJob(serverId) };
  }

  const inFlight = jobs.get(serverId);
  if (inFlight?.phase === 'installing') {
    return { ok: true, inProgress: true, job: inFlight };
  }

  updateJob(serverId, { phase: 'installing', percent: 0, message: 'Starting install' });
  const promise = runInstallServer(serverId)
    .then(() => ({ ok: true, alreadyInstalled: false, job: getServerJob(serverId) }))
    .catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      updateJob(serverId, { phase: 'error', percent: 0, message, error: message });
      console.error(`[servers] install ${serverId} failed: ${message}`);
      return { ok: false, error: message, job: getServerJob(serverId) };
    })
    .finally(() => {
      installPromises.delete(serverId);
    });
  installPromises.set(serverId, promise);
  return { ok: true, started: true, job: getServerJob(serverId) };
}

/**
 * @param {string} serverId
 */
export async function installServer(serverId) {
  const def = getServerDef(serverId);
  if (!def) throw new Error(`Unknown server: ${serverId}`);

  const existing = await def.provisioner.getInstallStatus();
  if (existing.installed) {
    updateJob(serverId, { phase: 'done', percent: 100, message: 'Already installed' });
    return { ok: true, alreadyInstalled: true };
  }

  const kick = await startInstallServer(serverId);
  if (kick.ok === false) {
    throw new Error(kick.error ?? 'Install failed');
  }
  if (kick.alreadyInstalled) return kick;

  const pending = installPromises.get(serverId);
  if (!pending) return kick;

  const result = await pending;
  if (result.ok === false) {
    throw new Error(result.error ?? 'Install failed');
  }
  return result;
}

/**
 * @param {string} serverId
 */
export async function startServer(serverId) {
  const def = getServerDef(serverId);
  if (!def) throw new Error(`Unknown server: ${serverId}`);

  if (def.kind === 'native-binary') {
    throw new Error(
      `"${serverId}" is a native binary runtime — serve a model from Models instead of starting here`,
    );
  }

  const install = await def.provisioner.getInstallStatus();
  if (!install.installed) {
    throw new Error(`Server "${serverId}" is not installed`);
  }

  if (processes.has(serverId)) {
    const state = processes.get(serverId);
    if (state?.healthy) return { ok: true, alreadyRunning: true };
    await stopServer(serverId);
  }

  const config = await readResource('servers');
  const port = config[serverId]?.port ?? def.defaultPort;

  if (!processes.has(serverId) && !(await isLocalPortFree(port))) {
    throw new Error(
      `Port ${port} is in use by another process — choose a different port in Settings → Servers or stop the conflicting process`,
    );
  }

  const spec = await def.provisioner.getSpawnSpec(port);

  const child = spawnManaged(spec.command, spec.args, {
    cwd: spec.cwd,
    env: { ...process.env, ...spec.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    detached: process.platform !== 'win32',
  });

  processes.set(serverId, {
    child,
    port,
    healthy: false,
    phase: 'starting',
  });

  child.stdout?.on('data', (chunk) => {
    void appendServerLog(serverId, chunk.toString());
  });
  child.stderr?.on('data', (chunk) => {
    void appendServerLog(serverId, chunk.toString());
  });

  const commandLine = [spec.command, ...(spec.args ?? [])].join(' ');

  const exitDuringStartup = new Promise((_, reject) => {
    const onExit = (code) => {
      reject(
        new Error(
          `${serverId} exited during startup (code=${code ?? 'null'}) — see ${getServerLogPath(serverId)}`,
        ),
      );
    };
    child.once('exit', onExit);
    child.once('error', () => onExit(1));
  });

  child.on('exit', (code) => {
    const state = processes.get(serverId);
    if (state?.child === child) {
      processes.delete(serverId);
      void deleteServerRunRecord(serverId);
      void appendServerLog(serverId, `\n[exit] code=${code ?? 'null'}\n`);
    }
    emitServerState(serverId, {
      type: 'exit',
      code: code ?? null,
      pid: child.pid ?? null,
    });
  });

  child.on('error', (err) => {
    const message = err instanceof Error ? err.message : String(err);
    void appendServerLog(serverId, `\n[spawn error] ${message}\n`);
    processes.delete(serverId);
    void deleteServerRunRecord(serverId);
  });

  try {
    await Promise.race([waitForHealth(serverId, port, def.healthPath), exitDuringStartup]);
  } catch (err) {
    await killManagedChildAndWait(child);
    processes.delete(serverId);
    await deleteServerRunRecord(serverId);
    throw err;
  }

  const state = processes.get(serverId);
  if (!state || state.child !== child) {
    throw new Error(
      `${serverId} process map lost during startup — see ${getServerLogPath(serverId)}`,
    );
  }

  state.healthy = true;
  state.phase = 'running';

  if (child.pid) {
    await writeServerRunRecord(serverId, {
      pid: child.pid,
      port,
      startedAt: Date.now(),
      command: commandLine,
    });
  }

  return { ok: true, port };
}

/**
 * @param {string} serverId
 */
export async function stopServer(serverId) {
  const state = processes.get(serverId);
  if (!state?.child) {
    await deleteServerRunRecord(serverId);
    return { ok: true, wasRunning: false };
  }

  await killManagedChildAndWait(state.child);
  processes.delete(serverId);
  await deleteServerRunRecord(serverId);
  return { ok: true, wasRunning: true };
}

/**
 * @param {import('node:child_process').ChildProcess} child
 */
function killServerChildNow(child) {
  killProcessTree(child);
}

export async function shutdownAllServers() {
  const ids = [...processes.keys()];
  await Promise.all(ids.map((id) => stopServer(id)));
}

export function shutdownAllServersNow() {
  for (const [, state] of processes) {
    killServerChildNow(state.child);
  }
  processes.clear();
  for (const def of listServerDefs()) {
    void deleteServerRunRecord(def.id);
  }
}

/**
 * @param {string} serverId
 */
export async function restartServer(serverId) {
  await stopServer(serverId);
  return startServer(serverId);
}

/**
 * @param {string} serverId
 */
export async function uninstallServer(serverId) {
  const def = getServerDef(serverId);
  if (!def) throw new Error(`Unknown server: ${serverId}`);
  await stopServer(serverId);
  await def.provisioner.uninstall();
  jobs.delete(serverId);
  logRingBuffers.delete(serverId);
  return { ok: true };
}

export async function autoStartEnabledServers() {
  const config = await readResource('servers');
  for (const def of listServerDefs()) {
    const entry = config[def.id];
    if (!entry?.enabled || !entry?.autoStart) continue;
    const install = await def.provisioner.getInstallStatus();
    if (!install.installed) continue;
    try {
      await startServer(def.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[servers] auto-start ${def.id} failed: ${message}`);
    }
  }
}

export async function autoProvisionEnabledServers() {
  const config = await readResource('servers');
  for (const def of listServerDefs()) {
    if (!def.defaultAutoProvision) continue;
    const entry = config[def.id];
    if (!entry?.enabled || !entry?.autoStart) continue;
    const install = await def.provisioner.getInstallStatus();
    if (install.installed) continue;
    void (async () => {
      try {
        await installServer(def.id);
        await startServer(def.id);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[servers] auto-provision ${def.id} failed: ${message}`);
      }
    })();
  }
}

/**
 * @param {string} serverId
 * @param {number} [tailLines]
 */
export function getServerLogs(serverId, tailLines = 200) {
  const ring = logRingBuffers.get(serverId) ?? [];
  const n = Math.max(1, Math.min(tailLines, LOG_RING_MAX_LINES));
  return ring.slice(-n);
}

export async function getManagedSearxngUrl() {
  const config = await readResource('servers');
  const entry = config.searxng;
  if (!entry?.enabled) return null;

  const state = processes.get('searxng');
  if (!state || state.phase !== 'running' || !state.healthy) return null;

  return `http://127.0.0.1:${entry.port}`;
}

/**
 * @param {string} serverId
 * @returns {Promise<number | null>}
 */
export async function getManagedServerPort(serverId) {
  const def = getServerDef(serverId);
  if (!def) return null;
  const config = await readResource('servers');
  const port = config[serverId]?.port;
  return typeof port === 'number' ? port : def.defaultPort;
}

/**
 * @param {string} serverId
 */
export function isManagedServerRunning(serverId) {
  const state = processes.get(serverId);
  return state?.phase === 'running' && state?.healthy === true;
}

/**
 * @param {string} serverId
 * @param {boolean} enabled
 */
export async function setServerEnabled(serverId, enabled) {
  const def = getServerDef(serverId);
  if (!def) throw new Error(`Unknown server: ${serverId}`);
  const config = await readResource('servers');
  if (!config[serverId]) throw new Error(`Unknown server config: ${serverId}`);
  config[serverId].enabled = enabled === true;
  await writeResource('servers', config);
  if (!enabled) await stopServer(serverId);
  return config[serverId];
}

/**
 * @param {string} serverId
 * @param {boolean} autoStart
 */
export async function setServerAutoStart(serverId, autoStart) {
  const def = getServerDef(serverId);
  if (!def) throw new Error(`Unknown server: ${serverId}`);
  const config = await readResource('servers');
  if (!config[serverId]) throw new Error(`Unknown server config: ${serverId}`);
  config[serverId].autoStart = autoStart === true;
  await writeResource('servers', config);
  return config[serverId];
}

/**
 * @param {string} serverId
 * @param {number} port
 */
export async function setServerPort(serverId, port) {
  const def = getServerDef(serverId);
  if (!def) throw new Error(`Unknown server: ${serverId}`);
  const n = Number(port);
  if (!Number.isInteger(n) || n < 1024 || n > 65_535) {
    throw new Error('Port must be an integer between 1024 and 65535');
  }
  const config = await readResource('servers');
  if (!config[serverId]) throw new Error(`Unknown server config: ${serverId}`);
  config[serverId].port = n;
  await writeResource('servers', config);
  if (serverId === 'searxng') {
    const { writeSearxngSettings } = await import('./searxng.js');
    await writeSearxngSettings(n);
  }
  const running = processes.get(serverId);
  if (running) {
    await restartServer(serverId);
  }
  return config[serverId];
}

export async function ensureServersLayout() {
  await fsp.mkdir(getServersRoot(), { recursive: true });
  await fsp.mkdir(path.dirname(getServerLogPath('_')), { recursive: true });
}

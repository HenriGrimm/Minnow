/**
 * Voice Python worker lifecycle — install, spawn, health, repair.
 */

import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import {
  getInstallStatus,
  getVenvPython,
  patchMeta,
  provision,
} from './provision.js';
import { getVoiceLogPath, getVoiceWorkerScriptPath } from './paths.js';
import { logChildProcessDiagnostic } from '../diagnostics/process-handlers.js';
import { detectHardware } from '../system/hardware.js';
import { isCudaHardware } from './provision.js';
import { resetLocalSttForTests as resetSttModelCache } from './local-stt.js';
import { resetLocalTtsForTests as resetTtsModelCache } from './local-tts.js';
import { preloadVoiceModels } from './preload.js';

/** @typedef {'pending' | 'installing' | 'completed' | 'failed'} InstallPhase */

/**
 * @typedef {object} InstallJob
 * @property {InstallPhase} phase
 * @property {number} percent
 * @property {string} message
 * @property {string | null} error
 */

/**
 * @typedef {object} WorkerState
 * @property {import('node:child_process').ChildProcess} child
 * @property {number} port
 * @property {boolean} healthy
 * @property {'starting' | 'running' | 'stopped' | 'error'} phase
 */

/** @type {WorkerState | null} */
let workerState = null;
let startPromise = null;

/** @type {InstallJob | null} */
let installJob = null;

/** @type {Promise<void> | null} */
let installPromise = null;

/** @type {Set<(event: object) => void>} */
const installListeners = new Set();

/** @type {typeof spawn | null} */
let spawnOverrideForTests = null;

/** @type {typeof fetch | null} */
let fetchOverrideForTests = null;

/** @type {((onProgress?: (message: string) => void) => Promise<void>) | null} */
let provisionOverrideForTests = null;

function emitInstall(event) {
  for (const listener of installListeners) {
    try {
      listener(event);
    } catch {
      /* ignore listener errors */
    }
  }
}

function setInstallJob(patch) {
  installJob = {
    phase: installJob?.phase ?? 'pending',
    percent: installJob?.percent ?? 0,
    message: installJob?.message ?? '',
    error: installJob?.error ?? null,
    ...patch,
  };
  emitInstall({
    phase: installJob.phase,
    percent: installJob.percent,
    message: installJob.message,
    error: installJob.error,
  });
  return installJob;
}

function resetWorkerModelCache() {
  resetSttModelCache();
  resetTtsModelCache();
}

/**
 * @returns {Promise<number>}
 */
async function pickFreePort(preferred = 8765) {
  const tryPort = (port) =>
    new Promise((resolve, reject) => {
      const server = net.createServer();
      server.unref();
      server.on('error', reject);
      server.listen(port, '127.0.0.1', () => {
        const address = server.address();
        const chosen = typeof address === 'object' && address ? address.port : port;
        server.close(() => resolve(chosen));
      });
    });

  try {
    return await tryPort(preferred);
  } catch {
    return tryPort(0);
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

/**
 * @param {number} port
 */
async function waitForWorkerHealth(port) {
  const url = `http://127.0.0.1:${port}/health`;
  let delayMs = 200;
  const maxAttempts = 40;
  const fetchImpl = fetchOverrideForTests ?? fetch;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (!workerState || workerState.port !== port || workerState.phase === 'error') {
      throw new Error('Voice worker exited before becoming ready. Check the voice worker log.');
    }
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(3_000) });
      if (res.ok) return true;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, delayMs));
    delayMs = Math.min(delayMs * 1.5, 2_000);
  }

  throw new Error(`Voice worker health check timed out (${url})`);
}

/**
 * @param {string} chunk
 */
/** @type {Promise<void> | null} */
let voiceLogWriteChain = null;


async function appendWorkerLog(chunk) {
  const text = String(chunk);
  if (!text) return;
  const logPath = getVoiceLogPath();
  const prev = voiceLogWriteChain ?? Promise.resolve();
  const next = prev.then(async () => {
    await fsp.mkdir(path.dirname(logPath), { recursive: true }).catch(() => {});
    try {
      await fsp.appendFile(logPath, text, 'utf8');
    } catch {
      /* ignore log write failures */
    }
  }).catch(() => {}).finally(() => {
    if (voiceLogWriteChain === next) voiceLogWriteChain = null;
  });
  voiceLogWriteChain = next;
}

/**
 * @param {import('node:child_process').ChildProcess} child
 */
function killWorkerChild(child) {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      }).unref();
    } catch {
      if (typeof child.kill === 'function') child.kill();
    }
    return;
  }
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    if (typeof child.kill === 'function') child.kill('SIGTERM');
  }
}

/**
 * @param {(message: string) => void} [onProgress]
 */
async function runProvision(onProgress) {
  if (provisionOverrideForTests) {
    await provisionOverrideForTests(onProgress);
    return;
  }
  await provision(onProgress);
}

/**
 * Kick off voice runtime install in the background.
 */
export async function installRuntime() {
  if (installPromise) {
    return { ok: true, inProgress: true, job: installJob };
  }

  const status = await getInstallStatus();
  if (status.installed) {
    setInstallJob({ phase: 'completed', percent: 100, message: 'Already installed', error: null });
    return { ok: true, alreadyInstalled: true, job: installJob };
  }

  if (installJob?.phase === 'installing') {
    return { ok: true, inProgress: true, job: installJob };
  }

  setInstallJob({ phase: 'installing', percent: 0, message: 'Starting install', error: null });

  installPromise = runProvision((msg) => {
    setInstallJob({ phase: 'installing', percent: 50, message: msg, error: null });
  })
    .then(() => {
      setInstallJob({ phase: 'completed', percent: 100, message: 'Install complete', error: null });
    })
    .catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      setInstallJob({ phase: 'failed', percent: 0, message, error: message });
      console.error(`[voice] install failed: ${message}`);
    })
    .finally(() => {
      installPromise = null;
    });

  return { ok: true, started: true, job: installJob };
}

/**
 * Re-run provisioning (repair venv / deps).
 */
export async function repairRuntime() {
  if (installPromise) {
    return { ok: true, inProgress: true, job: installJob };
  }

  setInstallJob({ phase: 'installing', percent: 0, message: 'Repairing runtime', error: null });

  installPromise = runProvision((msg) => {
    setInstallJob({ phase: 'installing', percent: 50, message: msg, error: null });
  })
    .then(() => {
      setInstallJob({ phase: 'completed', percent: 100, message: 'Repair complete', error: null });
    })
    .catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      setInstallJob({ phase: 'failed', percent: 0, message, error: message });
      console.error(`[voice] repair failed: ${message}`);
    })
    .finally(() => {
      installPromise = null;
    });

  return { ok: true, started: true, job: installJob };
}

/**
 * Spawn the Python voice worker on a random localhost port.
 * Warm STT/TTS from settings in the background; a preload failure must not block startup.
 */
export async function startWorker() {
  if (!startPromise) {
    startPromise = startWorkerOnce().finally(() => { startPromise = null; });
  }
  return startPromise;
}

async function startWorkerOnce() {
  const install = await getInstallStatus();
  if (!install.installed) {
    throw new Error('Voice runtime is not installed');
  }

  if (workerState?.healthy) {
    return { ok: true, alreadyRunning: true, port: workerState.port };
  }

  if (workerState) {
    await stopWorker();
  }

  resetWorkerModelCache();

  const venvPython = await getVenvPython();
  const workerScript = getVoiceWorkerScriptPath();
  const port = await pickFreePort();

  const child = spawnManaged(
    venvPython,
    [workerScript, '--host', '127.0.0.1', '--port', String(port)],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    },
  );

  workerState = {
    child,
    port,
    healthy: false,
    phase: 'starting',
  };

  child.stdout?.on('data', (chunk) => {
    void appendWorkerLog(chunk.toString());
  });
  child.stderr?.on('data', (chunk) => {
    void appendWorkerLog(chunk.toString());
  });

  child.on('exit', (code) => {
    if (workerState?.child === child) {
      workerState = null;
      resetWorkerModelCache();
      void appendWorkerLog(`\n[exit] code=${code ?? 'null'}\n`);
      void patchMeta({ pid: null, port: null });
      if (code !== 0 && code != null) {
        void logChildProcessDiagnostic({
          kind: 'voice-worker-exit',
          message: `Voice worker exited with code ${code}`,
          extra: { exitCode: code },
        });
      }
    }
  });

  child.on('error', (err) => {
    const message = err instanceof Error ? err.message : String(err);
    void appendWorkerLog(`\n[spawn error] ${message}\n`);
    void logChildProcessDiagnostic({
      kind: 'voice-worker-error',
      message,
      stack: err instanceof Error ? err.stack : undefined,
    });
    if (workerState?.child === child) {
      workerState.phase = 'error';
      workerState.healthy = false;
    }
  });

  try {
    await waitForWorkerHealth(port);
  } catch (error) {
    if (workerState?.child === child) await stopWorker();
    throw error;
  }

  if (!workerState || workerState.child !== child || workerState.phase === 'error') {
    if (workerState?.child === child) await stopWorker();
    throw new Error('Voice worker exited before becoming healthy');
  }

  workerState.healthy = true;
  workerState.phase = 'running';
  await patchMeta({ port, pid: child.pid ?? null });

  void preloadVoiceModels().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[voice] preload failed: ${message}`);
  });

  return { ok: true, port, pid: child.pid ?? null };
}

/** Stop the voice worker process if running. */
export async function stopWorker() {
  if (!workerState?.child) {
    await patchMeta({ pid: null, port: null });
    return { ok: true, wasRunning: false };
  }

  killWorkerChild(workerState.child);
  workerState = null;
  resetWorkerModelCache();
  await patchMeta({ pid: null, port: null });
  return { ok: true, wasRunning: true };
}

/**
 * Query worker /health when running.
 */
export async function getHealth() {
  if (!workerState?.healthy || !workerState.port) {
    return { ok: false, status: workerState?.phase ?? 'stopped' };
  }

  const url = `http://127.0.0.1:${workerState.port}/health`;
  const fetchImpl = fetchOverrideForTests ?? fetch;
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(3_000) });
    if (!res.ok) {
      return { ok: false, status: 'error' };
    }
    const json = await res.json();
    return { ok: true, status: json?.status ?? 'ready', port: workerState.port };
  } catch {
    return { ok: false, status: 'error' };
  }
}

/**
 * Combined runtime status for the client.
 */
async function fetchWorkerCuda(port) {
  const fetchImpl = fetchOverrideForTests ?? fetch;
  try {
    const res = await fetchImpl(`http://127.0.0.1:${port}/voice/capabilities`, {
      signal: AbortSignal.timeout(3_000),
    });
    if (!res.ok) return false;
    const json = await res.json();
    return json?.cuda === true;
  } catch {
    return false;
  }
}

export async function getRuntimeStatus() {
  const install = await getInstallStatus();
  let cudaAvailable = false;
  try {
    const hw = await detectHardware();
    cudaAvailable = isCudaHardware(hw);
  } catch {
    cudaAvailable = false;
  }

  const running = workerState?.healthy === true;
  const workerHealth = running ? await getHealth() : { ok: false, status: 'stopped' };

  if (running && workerState?.port) {
    cudaAvailable = await fetchWorkerCuda(workerState.port);
  } else if (install.torchVariant === 'cuda') {
    cudaAvailable = true;
  } else if (install.torchVariant === 'cpu') {
    cudaAvailable = false;
  }

  let health = 'not_installed';
  if (install.installed) {
    if (installJob?.phase === 'installing') health = 'installing';
    else if (installJob?.phase === 'failed') health = 'error';
    else if (running && workerHealth.ok) health = 'ready';
    else if (running) health = 'error';
    else if (workerState?.phase === 'starting') health = 'starting';
    else health = 'stopped';
  } else if (installJob?.phase === 'installing') {
    health = 'installing';
  } else if (installJob?.phase === 'failed') {
    health = 'error';
  }

  return {
    installed: install.installed,
    running,
    health,
    cudaAvailable,
    torchVariant: install.torchVariant,
    port: workerState?.port ?? null,
    installedAt: install.installedAt,
    installedPackages: install.installedPackages,
    skippedPackages: install.skippedPackages,
    installJob: installJob
      ? {
          phase: installJob.phase,
          percent: installJob.percent,
          message: installJob.message,
          error: installJob.error,
        }
      : null,
    worker: workerHealth,
  };
}

/** @returns {InstallJob | null} */
export function getInstallJob() {
  return installJob;
}

/**
 * @param {(event: object) => void} listener
 */
export function subscribeInstallProgress(listener) {
  installListeners.add(listener);
  if (installJob) {
    listener({
      phase: installJob.phase,
      percent: installJob.percent,
      message: installJob.message,
      error: installJob.error,
    });
  }
  return () => {
    installListeners.delete(listener);
  };
}

/** Test helpers */
export function setVoiceSpawnOverrideForTests(fn) {
  spawnOverrideForTests = fn;
}

export function resetVoiceSpawnOverrideForTests() {
  spawnOverrideForTests = null;
}

export function setVoiceFetchOverrideForTests(fn) {
  fetchOverrideForTests = fn;
}

export function resetVoiceFetchOverrideForTests() {
  fetchOverrideForTests = null;
}

export function setVoiceProvisionOverrideForTests(fn) {
  provisionOverrideForTests = fn;
}

export function resetVoiceProvisionOverrideForTests() {
  provisionOverrideForTests = null;
}

export function resetVoiceRuntimeForTests() {
  if (workerState?.child) {
    killWorkerChild(workerState.child);
  }
  workerState = null;
  installJob = null;
  installPromise = null;
  startPromise = null;
  installListeners.clear();
}

/** Current worker HTTP port when healthy, else null. */
export function getWorkerPort() {
  return workerState?.healthy && workerState.port ? workerState.port : null;
}

/** Fetch implementation (overridable in tests). */
export function getWorkerFetch() {
  return fetchOverrideForTests ?? fetch;
}

/** @internal Test helper — simulate a running worker without spawning Python. */
export function setWorkerStateForTests(state) {
  workerState = state;
}

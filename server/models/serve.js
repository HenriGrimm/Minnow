import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import {
  createBackgroundRun,
  getRun,
  readRunLogTail,
  stopActiveRun,
  subscribeRun,
} from '../terminal-runner.js';
import {
  createProvider,
  LLAMA_CPP_LOCAL_ID,
  MINNOW_LIBRARY_PROVIDER_ID,
  listProviders,
  MLX_LM_LOCAL_ID,
  seedLlamaCppLocal,
  setActiveProviderId,
  updateProvider,
} from '../providers/store.js';
import {
  getManagedServerPort,
  isManagedServerRunning,
  startServer,
  stopServer,
  subscribeServerState,
} from '../servers/manager.js';
import {
  getInstallStatus as getMlxInstallStatus,
  isMlxSupported,
  MLX_LM_VERSION,
  MLX_UNSUPPORTED_MESSAGE,
} from '../servers/mlx-lm.js';
import { contextLengthFromTransformersConfig } from './mlx-context-length.js';
import { detectHardware } from '../system/hardware.js';
import { detectRuntimes } from './runtime-detect.js';
import {
  buildLlamaServerLaunch,
  buildLlamaServerSpawnEnv,
  findSiblingMmproj,
  readLlamaCppConfig,
  warnIfReasoningBudgetCliFlag,
  writeLlamaCppConfig,
} from './llama-args.js';
import { appendServeLog } from './serve-logs.js';
import { setProviderThinkingBudgetSupport } from '../providers/capabilities-store.js';
import { readGgufMetadata } from './gguf-metadata.js';
import { assertSplitGgufSiblings } from './split-gguf.js';
import { diagnoseLlamaFailure } from './diagnose-llama-failure.js';
import { geometryFromGgufMetadata } from '../../src/models/model-geometry.mjs';
import { parseSpecContextBytes, updateLoadRate } from '../../src/models/load-progress.mjs';
import {
  listServeActivity,
  startServeActivity,
  stopAllServeActivity,
  stopServeActivity,
} from './serve-activity.js';
import {
  getLaunchPrefs,
  llamaSettingsFromLaunchRow,
  mergeLaunchSettings,
  recordLaunchLoadPrior,
} from './launch-prefs.js';
import { getServesIndexPath, modelsLogDir } from './paths.js';
import { validatePort, validateRuntime, validateServeId } from './validate.js';
import { MODEL_LOAD_TIMEOUT_MS } from './timeouts.js';
import { listGenerationStates } from '../generations/store.js';
import { waitForHealth as waitForEndpointHealth } from './wait-for-health.js';
import {
  classifyServeExit,
  resetClassifyServeExitOverrideForTests,
} from './classify-serve-exit.js';
import {
  estimatePlanMemoryBytes,
  pickEvictions,
  resolveResidencyLimits,
  SERVE_IDLE_TTL_MS,
  serveHasInFlightGenerations,
  serveMatchesModelId,
} from './admit-serve.js';

export {
  classifyServeExit,
  setClassifyServeExitOverrideForTests,
  resetClassifyServeExitOverrideForTests,
} from './classify-serve-exit.js';
import {
  buildLlamaServerEnv,
  getInstalledLlamaVariant,
  llamaServerSpawnCwd,
  resolveLlamaServer,
  getActiveLlamaFork,
  detectLlamaThinkingBudgetSupport,
  assertLlamaServerMatchesHostArch,
  listLlamaGpuDevices,
} from './llama-runtime.js';

// ── Types ────────────────────────────────────────────────────────────────────

/** @typedef {'starting' | 'running' | 'stopped' | 'error' | 'crashed' | 'unhealthy'} ServeStatus */

/**
 * @typedef {object} ServeFailure
 * @property {string} code
 * @property {string} [title]
 * @property {string} [detail]
 * @property {string} [remediation]
 * @property {boolean} [retryable]
 * @property {Record<string, unknown>} [suggestedSettings]
 * @property {string[]} [chatTemplateFields]
 * @property {number | null} [exitCode]
 */

/**
 * @typedef {object} ServeRecord
 * @property {string} id
 * @property {string} runtime
 * @property {string} modelPath
 * @property {string} modelLabel
 * @property {number} port
 * @property {string} baseUrl
 * @property {string} providerId
 * @property {ServeStatus} status
 * @property {string} [runId]
 * @property {number | null} [pid]
 * @property {string} [error]
 * @property {number} startedAt
 * @property {number} [stoppedAt]
 * @property {number} [lastHealthyAt]
 * @property {number} [exitCode]
 * @property {ServeFailure} [failure]
 * @property {number} [restartCount]
 * @property {string} [libraryId]
 * @property {Record<string, unknown>} [llamaSettings]
 * @property {MlxServeSettings} [mlxSettings]
 * @property {object} [launchPlan]
 * @property {number} [lastUsedAt]
 * @property {string} [engineId] llama.cpp engine that spawned this serve (`upstream` or a fork id).
 */

/**
 * @typedef {object} MlxServeSettings
 * @property {string} snapshotPath
 * @property {string | null} quant
 * @property {string} mlxLmVersion
 * @property {number} port
 * @property {number | null} contextLength
 */

function isLiveServeStatus(status) {
  return status === 'running' || status === 'starting' || status === 'unhealthy';
}

const AUTO_RESTART_CODES = new Set(['unknown', 'transient', 'port_conflict']);
const AUTO_RESTART_DELAY_MS = 2_000;
const AUTO_RESTART_MIN_HEALTHY_MS = 30_000;
const HEARTBEAT_INTERVAL_MS = 10_000;
const HEARTBEAT_FAILS_TO_UNHEALTHY = 3;

/** @type {ServeRecord[]} */
let servesCache = [];
let loaded = false;

/** @type {Set<(payload: { serves: object[], reason: string }) => void>} */
const serveCommitListeners = new Set();

/** @type {Map<string, () => void>} */
const llamaRunUnsubs = new Map();

/** @type {Map<string, number>} */
const heartbeatFailStreak = new Map();

/** @type {Map<string, { cancelled: boolean, promise: Promise<void> }>} */
const pendingRestarts = new Map();

const userStoppingServeIds = new Set();

/**
 * @param {ServeRecord} row
 */
function isServeStopRequested(row) {
  return userStoppingServeIds.has(row.id) || row.status === 'stopped';
}

/**
 * @type {{ libraryId: string, modelPath: string, modelLabel: string, llamaSettings: Record<string, unknown> | null, hardware: object | null, weightsBytes: number, runtime: string, } | null}
 */
let lastTtlEviction = null;

/** @type {ReturnType<typeof setInterval> | null} */
let heartbeatTimer = null;
let heartbeatIntervalMs = HEARTBEAT_INTERVAL_MS;
let restartDelayMs = AUTO_RESTART_DELAY_MS;
let mlxCrashUnsub = null;

export const INTERRUPTED_SERVE_ERROR = 'Model load interrupted (Minnow restarted)';

// ── Test hooks ───────────────────────────────────────────────────────────────

/** @type {((baseUrl: string) => Promise<boolean>) | null} */
let reachabilityProbeOverrideForTests = null;

export function setServeReachabilityProbeOverrideForTests(fn) {
  reachabilityProbeOverrideForTests = fn;
}

export function resetServeReachabilityProbeOverrideForTests() {
  reachabilityProbeOverrideForTests = null;
}

/** @type {typeof createBackgroundRun | null} */
let createBackgroundRunOverrideForTests = null;
/** @type {typeof stopActiveRun | null} */
let stopActiveRunOverrideForTests = null;
/** @type {((baseUrl: string) => Promise<boolean | { ok: boolean, error?: string, logTail?: string, exitCode?: number | null }>) | null} */
let waitForHealthOverrideForTests = null;
/** @type {((baseUrl: string, modelId: string) => Promise<void>) | null} */
let mlxWarmupOverrideForTests = null;

export function setServeBackgroundRunOverrideForTests(fn) {
  createBackgroundRunOverrideForTests = fn;
}

export function resetServeBackgroundRunOverrideForTests() {
  createBackgroundRunOverrideForTests = null;
}

export function setStopActiveRunOverrideForTests(fn) {
  stopActiveRunOverrideForTests = fn;
}

export function resetStopActiveRunOverrideForTests() {
  stopActiveRunOverrideForTests = null;
}

function stopServeRun(runId) {
  return (stopActiveRunOverrideForTests ?? stopActiveRun)(runId);
}

export function setServeHealthOverrideForTests(fn) {
  waitForHealthOverrideForTests = fn;
}

export function resetServeHealthOverrideForTests() {
  waitForHealthOverrideForTests = null;
}

export function setMlxWarmupOverrideForTests(fn) {
  mlxWarmupOverrideForTests = fn;
}

export function resetMlxWarmupOverrideForTests() {
  mlxWarmupOverrideForTests = null;
}

/** @type {typeof subscribeRun | null} */
let subscribeRunOverrideForTests = null;
/** @type {typeof subscribeServerState | null} */
let subscribeServerStateOverrideForTests = null;
/** @type {((row: ServeRecord) => Promise<boolean>) | null} */
let heartbeatProbeOverrideForTests = null;
/** @type {((pid: number | null | undefined) => boolean) | null} */
let pidAliveOverrideForTests = null;

export function setSubscribeRunOverrideForTests(fn) {
  subscribeRunOverrideForTests = fn;
}

export function resetSubscribeRunOverrideForTests() {
  subscribeRunOverrideForTests = null;
}

export function setSubscribeServerStateOverrideForTests(fn) {
  subscribeServerStateOverrideForTests = fn;
}

export function resetSubscribeServerStateOverrideForTests() {
  subscribeServerStateOverrideForTests = null;
}

export function setServeHeartbeatProbeOverrideForTests(fn) {
  heartbeatProbeOverrideForTests = fn;
}

export function resetServeHeartbeatProbeOverrideForTests() {
  heartbeatProbeOverrideForTests = null;
}

export function setServePidAliveOverrideForTests(fn) {
  pidAliveOverrideForTests = fn;
}

export function resetServePidAliveOverrideForTests() {
  pidAliveOverrideForTests = null;
}

export function setServeHeartbeatIntervalMsForTests(ms) {
  heartbeatIntervalMs = Number(ms) > 0 ? Number(ms) : HEARTBEAT_INTERVAL_MS;
  if (heartbeatTimer) {
    stopServeHeartbeat();
    ensureServeHeartbeat();
  }
}

export function setServeRestartDelayMsForTests(ms) {
  restartDelayMs = Number.isFinite(ms) && ms >= 0 ? Number(ms) : AUTO_RESTART_DELAY_MS;
}

/**
 * @param {string} baseUrl
 */
async function isServeEndpointReachable(baseUrl) {
  if (reachabilityProbeOverrideForTests) {
    return reachabilityProbeOverrideForTests(baseUrl);
  }
  const urls = [`${baseUrl}/health`, `${baseUrl}/v1/models`];
  for (const url of urls) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2_500) });
      if (res.ok) return true;
    } catch {
    }
  }
  return false;
}

/**
 * @param {ServeRecord} row
 */
async function isServeStillLive(row) {
  if (row.runtime === 'mlx-lm') {
    return isManagedServerRunning('mlx-lm');
  }
  if (row.runtime === 'llama-cpp' && row.runId) {
    const run = getRun(row.runId);
    if (run && !run.finished) return true;
  }
  if (row.baseUrl) {
    return isServeEndpointReachable(row.baseUrl);
  }
  return false;
}

async function reconcileInterruptedServes() {
  let changed = false;
  for (const row of servesCache) {
    if (row.status !== 'running' && row.status !== 'starting' && row.status !== 'unhealthy') continue;
    if (await isServeStillLive(row)) continue;

    if (row.status === 'starting') {
      row.status = 'error';
      row.error = INTERRUPTED_SERVE_ERROR;
    } else {
      row.status = 'stopped';
      row.error = undefined;
    }
    row.stoppedAt = Date.now();
    row.runId = undefined;
    row.pid = undefined;
    changed = true;
  }
  if (!changed) return;

  await commitServes('reconcile');

  for (const runtime of ['llama-cpp', 'mlx-lm']) {
    const providerId = runtime === 'llama-cpp' ? LLAMA_CPP_LOCAL_ID : MLX_LM_LOCAL_ID;
    const stillRunning = servesCache.some(
      (s) => s.runtime === runtime && isLiveServeStatus(s.status),
    );
    if (!stillRunning) {
      try {
        await updateProvider(providerId, { enabled: false });
      } catch {
      }
    }
  }
}

// ── Persistence ──────────────────────────────────────────────────────────────

async function loadServes() {
  if (loaded) return;
  loaded = true;
  try {
    const raw = await fsp.readFile(getServesIndexPath(), 'utf8');
    const parsed = JSON.parse(raw);
    servesCache = Array.isArray(parsed.serves) ? parsed.serves : [];
  } catch {
    servesCache = [];
  }
  await reconcileInterruptedServes();
  reconcileServeActivityPollers();
  ensureServeHeartbeat();
  ensureMlxCrashWatch();
}

async function saveServes() {
  await fsp.mkdir(path.dirname(getServesIndexPath()), { recursive: true });
  await fsp.writeFile(
    getServesIndexPath(),
    `${JSON.stringify({ version: 1, serves: servesCache }, null, 2)}\n`,
    'utf8',
  );
}

/**
 * @param {string} reason
 */
export async function commitServes(reason) {
  await saveServes();
  reconcileServeActivityPollers();
  const snapshot = { serves: servesCache.map(publicServe), reason: String(reason || 'update') };
  for (const listener of [...serveCommitListeners]) {
    try {
      listener(snapshot);
    } catch {
    }
  }
}

function reconcileServeActivityPollers() {
  const wanted = new Set();
  for (const row of servesCache) {
    if (row.runtime !== 'llama-cpp') continue;
    if (row.status !== 'running' && row.status !== 'unhealthy') continue;
    wanted.add(row.id);
    startServeActivity({
      id: row.id,
      baseUrl: row.baseUrl,
      runtime: row.runtime,
      modelLabel: row.modelLabel,
      libraryId: row.libraryId,
    });
  }
  for (const activity of listServeActivity()) {
    if (!wanted.has(activity.serveId)) stopServeActivity(activity.serveId);
  }
}

/**
 * @param {(payload: { serves: object[], reason: string }) => void} listener
 * @returns {() => void}
 */
export function subscribeServeEvents(listener) {
  serveCommitListeners.add(listener);
  listener({ serves: servesCache.map(publicServe), reason: 'subscribe' });
  return () => {
    serveCommitListeners.delete(listener);
  };
}

// ── Health ───────────────────────────────────────────────────────────────────

/**
 * @returns {Promise<number>}
 */
async function pickFreePort(preferred = 8085) {
  const claimed = new Set(
    servesCache
      .filter((row) => isLiveServeStatus(row.status) && Number.isInteger(row.port))
      .map((row) => row.port),
  );

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

  if (!claimed.has(preferred)) {
    try {
      const port = await tryPort(preferred);
      if (!claimed.has(port)) return port;
    } catch {
    }
  }

  for (let i = 0; i < 8; i += 1) {
    const port = await tryPort(0);
    if (!claimed.has(port)) return port;
  }
  throw new Error('No free port for llama.cpp serve');
}

/**
 * @param {{ code?: string, title?: string, detail?: string, remediation?: string, retryable?: boolean, suggestedSettings?: Record<string, unknown>, chatTemplateFields?: string[] } | null | undefined} diagnosis
 * @param {number | null} [exitCode]
 */
function publicFailure(diagnosis, exitCode) {
  const code = diagnosis?.code || 'unknown';
  const out = {
    code,
    exitCode: exitCode ?? null,
  };
  if (diagnosis?.title) out.title = diagnosis.title;
  if (diagnosis?.detail) out.detail = diagnosis.detail;
  if (diagnosis?.remediation) out.remediation = diagnosis.remediation;
  if (typeof diagnosis?.retryable === 'boolean') out.retryable = diagnosis.retryable;
  if (diagnosis?.suggestedSettings) out.suggestedSettings = diagnosis.suggestedSettings;
  if (Array.isArray(diagnosis?.chatTemplateFields) && diagnosis.chatTemplateFields.length) {
    out.chatTemplateFields = diagnosis.chatTemplateFields;
  }
  return out;
}

/**
 * @param {string} baseUrl
 * @param {number} [timeoutMs]
 * @param {string} [runId]
 * @returns {Promise<{ ok: true } | { ok: false, error: string, logTail?: string, exitCode?: number | null }>}
 */
async function waitForHealth(baseUrl, timeoutMs = MODEL_LOAD_TIMEOUT_MS, runId) {
  if (waitForHealthOverrideForTests) {
    const result = await waitForHealthOverrideForTests(baseUrl);
    if (result === true) return { ok: true };
    if (result && typeof result === 'object' && result.ok === true) return { ok: true };
    if (result && typeof result === 'object' && result.ok === false) {
      return {
        ok: false,
        error: result.error || 'llama-server did not become healthy in time',
        logTail: result.logTail,
        exitCode: result.exitCode ?? null,
      };
    }
    return { ok: false, error: 'llama-server did not become healthy in time' };
  }
  return waitForEndpointHealth({
    healthPath: '/health',
    extraPaths: ['/v1/models'],
    baseUrl,
    timeoutMs,
    runId,
    getRun,
    readLogTail: (id) => readRunLogTail(id, 4096),
    label: 'llama-server',
  });
}

/**
 * @param {ServeRecord} row
 */
function publicServe(row) {
  return {
    id: row.id,
    runtime: row.runtime,
    modelPath: row.modelPath,
    modelLabel: row.modelLabel,
    port: row.port,
    baseUrl: row.baseUrl,
    providerId: row.providerId,
    status: row.status,
    runId: row.runId ?? null,
    pid: row.pid ?? null,
    error: row.error ?? null,
    startedAt: row.startedAt,
    stoppedAt: row.stoppedAt ?? null,
    llamaSettings: row.llamaSettings ?? null,
    mlxSettings: row.mlxSettings ?? null,
    libraryId: row.libraryId ?? null,
    exitCode: row.exitCode ?? null,
    failure: row.failure ?? null,
  };
}

/**
 * @param {string} modelPath
 */
function labelFromPath(modelPath) {
  return path.basename(modelPath).replace(/\.gguf$/i, '');
}

/**
 * @param {ServeRecord} row
 */
function snapshotTtlEviction(row) {
  return {
    libraryId: typeof row.libraryId === 'string' ? row.libraryId : '',
    modelPath: row.modelPath,
    modelLabel: row.modelLabel,
    llamaSettings: row.llamaSettings ? { ...row.llamaSettings } : null,
    hardware: row.launchPlan?.hardware ?? null,
    weightsBytes: Number(row.launchPlan?.weightsBytes) || 0,
    runtime: 'llama-cpp',
  };
}

function clearTtlEvictionIfMatchesRow(row) {
  if (!lastTtlEviction) return;
  if (serveMatchesModelId(lastTtlEviction, row.libraryId || row.modelLabel)) {
    lastTtlEviction = null;
    return;
  }
  if (lastTtlEviction.modelPath === row.modelPath) lastTtlEviction = null;
}

// ── Admit ────────────────────────────────────────────────────────────────────

/**
 * @param {object} plan
 */
export async function admitServe(plan) {
  await loadServes();
  const hardware = plan?.hardware && typeof plan.hardware === 'object' ? plan.hardware : {};
  const variant = plan?.variant ?? 'cpu';
  const llamaConfig = await readLlamaCppConfig();
  const { modelsMax, budgetBytes } = resolveResidencyLimits({
    hardware,
    variant,
    userModelsMax: llamaConfig.models_max,
  });
  const live = servesCache.filter(
    (row) => row.runtime === 'llama-cpp' && isLiveServeStatus(row.status),
  );
  const residents = live.map((row) => ({
    id: row.id,
    lastUsedAt: row.lastUsedAt,
    estimateBytes: estimatePlanMemoryBytes(row.launchPlan),
  }));
  const evictions = pickEvictions({
    residents,
    incomingEstimateBytes: estimatePlanMemoryBytes(plan),
    modelsMax,
    budgetBytes,
  });
  for (const victim of evictions) {
    const deadline = Date.now() + MODEL_LOAD_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await loadServes();
      const row = servesCache.find((serve) => serve.id === victim.id);
      if (!row || !isLiveServeStatus(row.status)) break;
      if (!serveHasInFlightGenerations(row, listGenerationStates())) break;
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    await loadServes();
    const still = servesCache.find((serve) => serve.id === victim.id);
    if (!still || !isLiveServeStatus(still.status)) continue;
    if (serveHasInFlightGenerations(still, listGenerationStates())) continue;
    await stopServe(victim.id, { cause: 'admit' });
  }
}

async function stopExistingMlxServes() {
  await loadServes();
  for (const row of servesCache) {
    if (
      row.runtime === 'mlx-lm' &&
      isLiveServeStatus(row.status)
    ) {
      row.status = 'stopped';
      row.stoppedAt = Date.now();
    }
  }
  await commitServes('stop-existing-mlx');
}

/**
 * @param {{ id: string, label: string, baseUrl: string, enabled: boolean }} opts
 */
export async function upsertLocalRuntimeProvider(opts) {
  const patch = {
    baseUrl: opts.baseUrl,
    enabled: opts.enabled,
    supportsExtendedSamplers: true,
  };
  const create = () =>
    createProvider({
      id: opts.id,
      label: opts.label,
      baseUrl: opts.baseUrl,
      apiKind: 'openai-v1',
      enabled: opts.enabled,
      modelsPath: '/v1/models',
      chatCompletionsPath: '/v1/chat/completions',
      supportsModelLoadUnload: false,
      supportsExtendedSamplers: true,
    });

  try {
    await updateProvider(opts.id, patch);
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err)?.code !== 'ENOENT') throw err;
    try {
      await create();
    } catch (createErr) {
      if (!String(createErr?.message || '').includes('already exists')) throw createErr;
      if (opts.id === LLAMA_CPP_LOCAL_ID) await seedLlamaCppLocal();
      await updateProvider(opts.id, patch);
    }
  }
  if (opts.enabled) {
    await setActiveProviderId(opts.id);
  }
  return opts.id;
}

/**
 * @param {{ baseUrl: string, enabled: boolean }} opts
 */
export async function upsertLlamaCppProvider(opts) {
  return upsertLocalRuntimeProvider({
    id: LLAMA_CPP_LOCAL_ID,
    label: 'llama.cpp (local)',
    baseUrl: opts.baseUrl,
    enabled: opts.enabled,
  });
}

/**
 * @param {{ baseUrl: string, enabled: boolean }} opts
 */
export async function upsertMlxLmProvider(opts) {
  return upsertLocalRuntimeProvider({
    id: MLX_LM_LOCAL_ID,
    label: 'MLX (local)',
    baseUrl: opts.baseUrl,
    enabled: opts.enabled,
  });
}

/**
 * @returns {Promise<number>}
 */
async function ensureMlxLmServerRunning() {
  if (!isMlxSupported()) {
    throw new Error(MLX_UNSUPPORTED_MESSAGE);
  }
  const status = await getMlxInstallStatus();
  if (!status.installed) {
    throw new Error(
      'The MLX runtime is not installed — install it from Models → Engine before loading MLX weights',
    );
  }
  await startServer('mlx-lm');
  const port = await getManagedServerPort('mlx-lm');
  if (!port) {
    throw new Error('mlx-lm has no configured port');
  }
  return port;
}

/**
 * @param {string} modelPath
 * @param {number} port
 * @param {unknown} quantHint
 * @returns {Promise<MlxServeSettings>}
 */
async function readMlxLoadedWith(modelPath, port, quantHint) {
  let contextLength = null;
  let quant =
    typeof quantHint === 'string' && quantHint.trim() ? quantHint.trim() : null;
  try {
    const raw = await fsp.readFile(path.join(modelPath, 'config.json'), 'utf8');
    const config = JSON.parse(raw);
    contextLength = contextLengthFromTransformersConfig(config) ?? null;
    if (!quant && config && typeof config === 'object') {
      const bits = Number(/** @type {{ quantization?: { bits?: unknown } }} */ (config).quantization?.bits);
      if (Number.isFinite(bits) && bits > 0) quant = `mlx-${bits}bit`;
    }
  } catch {
  }
  return {
    snapshotPath: modelPath,
    quant,
    mlxLmVersion: MLX_LM_VERSION,
    port,
    contextLength,
  };
}

/**
 * @param {string} baseUrl
 * @param {string} modelId
 */
async function warmupMlxWeights(baseUrl, modelId) {
  if (mlxWarmupOverrideForTests) {
    await mlxWarmupOverrideForTests(baseUrl, modelId);
    return;
  }
  const url = `${baseUrl}/v1/chat/completions`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: 'user', content: '.' }],
        max_tokens: 1,
      }),
      signal: AbortSignal.timeout(MODEL_LOAD_TIMEOUT_MS),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(
        `MLX model did not finish loading (HTTP ${res.status})${text ? `: ${text.slice(0, 200)}` : ''}`,
      );
    }
  } catch (err) {
    const name = err && typeof err === 'object' ? /** @type {{ name?: string }} */ (err).name : '';
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new Error(
        'MLX model did not finish loading within the load timeout — weights load on the first request',
      );
    }
    throw err;
  }
}

/**
 * @param {string} runtime
 * @param {unknown} rawModelPath
 * @returns {Promise<string>}
 */
async function validateServeModelTarget(runtime, rawModelPath) {
  const modelPath = path.resolve(String(rawModelPath || ''));

  if (runtime === 'mlx-lm') {
    try {
      const stat = await fsp.stat(modelPath);
      if (!stat.isDirectory()) throw new Error('not a directory');
    } catch {
      throw new Error('MLX model directory not found');
    }
    return modelPath;
  }

  try {
    const stat = await fsp.stat(modelPath);
    if (!stat.isFile()) throw new Error('Model path is not a file');
  } catch {
    throw new Error('Model file not found');
  }
  if (!modelPath.toLowerCase().endsWith('.gguf')) {
    throw new Error('Only local .gguf files can be served in v1');
  }
  const meta = await readGgufMetadata(modelPath);
  if (meta && meta.splitCount > 1) {
    await assertSplitGgufSiblings(modelPath, meta.splitCount);
  }
  return modelPath;
}

/**
 * @param {{ serveId: string, baseUrl: string, modelLabel: string, apiKind: string, providerId?: string }} opts
 */
async function registerServeProvider(opts) {
  const providerId = opts.providerId || `models-${opts.serveId.slice(0, 8)}`;
  const existing = await listProviders();
  if (!existing.providers.some((p) => p.id === providerId)) {
    const isOpenAi = opts.apiKind === 'openai-v1';
    await createProvider({
      id: providerId,
      label: `Models · ${opts.modelLabel}`,
      baseUrl: opts.baseUrl,
      apiKind: opts.apiKind,
      enabled: true,
      modelsPath: isOpenAi ? '/v1/models' : '/api/v0/models',
      chatCompletionsPath: isOpenAi ? '/v1/chat/completions' : '/api/v0/chat/completions',
      supportsModelLoadUnload: false,
    });
  }
  await setActiveProviderId(providerId);
  return providerId;
}

// ── Start serve ──────────────────────────────────────────────────────────────

/**
 * @param {{ modelPath: string, runtime?: string, port?: number, modelLabel?: string, profile?: string, hardware?: object, llama?: object, libraryId?: string, quant?: string, paramsB?: number, isMoe?: boolean, weightsGb?: number, async?: boolean, restartCount?: number }} body
 */
export async function startServe(body) {
  await loadServes();
  const runtime = validateRuntime(body.runtime || 'llama-cpp');
  const modelPath = await validateServeModelTarget(runtime, body.modelPath);

  const ggufMeta = runtime === 'llama-cpp' ? await readGgufMetadata(modelPath) : null;

  const runtimes = await detectRuntimes();
  let llamaServerPath = null;
  let llamaVariant = 'cpu';
  let llamaEngineId = null;
  let llamaAsymmetricKv = false;
  if (runtime === 'llama-cpp') {
    for (const [id, handle] of pendingRestarts) {
      const pending = servesCache.find((row) => row.id === id);
      if (pending && pending.modelPath === modelPath) handle.cancelled = true;
    }
    const resolvedLlama = await resolveLlamaServer();
    llamaServerPath = resolvedLlama.path;
    if (!llamaServerPath) {
      throw new Error(
        resolvedLlama.reason ??
          'llama-server is not installed — install it from Models → Engine before serving',
      );
    }
    assertLlamaServerMatchesHostArch(llamaServerPath);
    llamaVariant = (await getInstalledLlamaVariant()) ?? 'cpu';
    llamaEngineId = resolvedLlama.engineId;
    llamaAsymmetricKv = (await getActiveLlamaFork())?.asymmetricKv === true;
  }
  if (runtime === 'ollama' && !runtimes.ollama.serving) {
    throw new Error('Ollama is not running on http://127.0.0.1:11434');
  }
  if (runtime === 'lm-studio' && !runtimes.lmStudio.available) {
    throw new Error('LM Studio server is not reachable on http://127.0.0.1:1234');
  }

  const serveId = crypto.randomUUID();
  const modelLabel =
    typeof body.modelLabel === 'string' && body.modelLabel.trim()
      ? body.modelLabel.trim()
      : labelFromPath(modelPath);

  if (runtime === 'mlx-lm') {
    await stopExistingMlxServes();
    const port = await ensureMlxLmServerRunning();
    const baseUrl = `http://127.0.0.1:${port}`;
    await upsertMlxLmProvider({ baseUrl, enabled: true });

    const mlxLibraryId = typeof body.libraryId === 'string' ? body.libraryId.trim() : '';
    const mlxWeightsBytes = Number(body.weightsGb) > 0 ? Number(body.weightsGb) * 1024 ** 3 : 0;
    const mlxSettings = await readMlxLoadedWith(modelPath, port, body.quant);

    const row = /** @type {ServeRecord} */ ({
      id: serveId,
      runtime,
      modelPath,
      modelLabel,
      port,
      baseUrl,
      providerId: MINNOW_LIBRARY_PROVIDER_ID,
      status: 'starting',
      startedAt: Date.now(),
      mlxSettings,
    });
    if (mlxLibraryId) row.libraryId = mlxLibraryId;
    servesCache.unshift(row);
    await commitServes('mlx-start');
    ensureMlxCrashWatch();

    const settleMlx = async () => {
      try {
        await warmupMlxWeights(baseUrl, modelPath);
      } catch (err) {
        if (isServeStopRequested(row)) return;
        const message = err instanceof Error ? err.message : String(err);
        row.status = 'error';
        row.error = message;
        row.stoppedAt = Date.now();
        await commitServes('mlx-warmup-error');
        throw new Error(message);
      }
      const loadMs = Math.max(0, Date.now() - row.startedAt);
      if (mlxLibraryId) {
        try {
          await recordLaunchLoadPrior(mlxLibraryId, {
            lastLoadMs: loadMs,
            lastWeightsBytes: mlxWeightsBytes,
          });
        } catch (err) {
          console.warn('[mlx-lm] launch load prior persist failed:', err);
        }
      }
      if (isServeStopRequested(row)) return;
      row.status = 'running';
      row.lastHealthyAt = Date.now();
      await commitServes('mlx-running');
      ensureServeHeartbeat();
    };

    if (body.async === true) {
      void settleMlx().catch(() => {
      });
      return publicServe(row);
    }

    await settleMlx();
    return publicServe(row);
  }

  if (runtime === 'ollama' || runtime === 'lm-studio') {
    const baseUrl =
      runtime === 'ollama' ? runtimes.ollama.baseUrl : runtimes.lmStudio.baseUrl;
    const providerId = await registerServeProvider({
      serveId,
      baseUrl,
      modelLabel,
      apiKind: runtime === 'ollama' ? 'openai-v1' : 'lm-studio-v0',
    });
    const row = /** @type {ServeRecord} */ ({
      id: serveId,
      runtime,
      modelPath,
      modelLabel,
      port: runtime === 'ollama' ? 11434 : 1234,
      baseUrl,
      providerId,
      status: 'running',
      startedAt: Date.now(),
    });
    servesCache.unshift(row);
    await commitServes('external-start');
    return publicServe(row);
  }

  const port = body.port ? validatePort(body.port) : await pickFreePort(8085);
  const baseUrl = `http://127.0.0.1:${port}`;
  const providerId = MINNOW_LIBRARY_PROVIDER_ID;

  const profileKey =
    typeof body.profile === 'string' && body.profile.trim() ? body.profile.trim() : 'balanced';

  const hardware =
    body.hardware && typeof body.hardware === 'object'
      ? body.hardware
      : await detectHardware();

  const llamaConfig = await readLlamaCppConfig();
  const libraryId = typeof body.libraryId === 'string' ? body.libraryId.trim() : '';
  const savedLaunch = libraryId
    ? llamaSettingsFromLaunchRow((await getLaunchPrefs()).byLibraryId[libraryId])
    : undefined;
  const requestLlama =
    body.llama && typeof body.llama === 'object' ? body.llama : undefined;
  const userSettings = mergeLaunchSettings(savedLaunch, requestLlama);
  const mmprojPath = await findSiblingMmproj(modelPath);

  let weightsBytes = Number(body.weightsGb) > 0 ? Number(body.weightsGb) * 1024 ** 3 : 0;
  if (!(weightsBytes > 0)) {
    try {
      weightsBytes = (await fsp.stat(modelPath)).size;
    } catch {
      weightsBytes = 0;
    }
  }

  let draftWeightsBytes = 0;
  const draftModelPath =
    typeof userSettings?.spec_draft_model === 'string' ? userSettings.spec_draft_model.trim() : '';
  if (draftModelPath) {
    try {
      draftWeightsBytes = (await fsp.stat(draftModelPath)).size;
    } catch {
      draftWeightsBytes = 0;
    }
  }

  const modelMeta = {
    name: modelLabel,
    quantization: body.quant,
    parameters_raw: body.paramsB,
    is_moe: body.isMoe,
    serveWeightsGb: body.weightsGb,
    serveQuant: body.quant,
  };
  const launchOpts = {
    modelPath,
    port,
    profileKey,
    hardware,
    modelMeta,
    settings: userSettings,
    defaults: llamaConfig.defaults,
    variant: llamaVariant,
    mmprojPath: mmprojPath ?? undefined,
    ggufMeta,
    weightsBytes,
    draftWeightsBytes,
    libraryId: libraryId || undefined,
    llamaDevices: await listLlamaGpuDevices(llamaServerPath, llamaVariant),
    asymmetricKv: llamaAsymmetricKv,
  };
  let launch = buildLlamaServerLaunch(launchOpts);

  const ggufGeometry = ggufMeta ? geometryFromGgufMetadata(ggufMeta) : null;
  const launchPlan = {
    ...launch.plan,
    geometry: ggufGeometry ?? undefined,
    weightsBytes,
    draftWeightsBytes,
    hardware,
    variant: llamaVariant,
    trainCtx: ggufMeta?.trainCtx,
    parallel: launch.settings?.parallel ?? 1,
    splitCount: ggufMeta?.splitCount ?? 1,
  };
  await admitServe(launchPlan);

  const loadedAt = Date.now();
  const row = /** @type {ServeRecord} */ ({
    id: serveId,
    runtime,
    modelPath,
    modelLabel,
    port,
    baseUrl,
    providerId,
    status: 'starting',
    startedAt: loadedAt,
    lastUsedAt: loadedAt,
    llamaSettings: launch.settings,
    restartCount: Number.isInteger(body.restartCount) ? Number(body.restartCount) : 0,
  });
  if (libraryId) row.libraryId = libraryId;
  if (llamaEngineId) row.engineId = llamaEngineId;
  row.launchPlan = launchPlan;
  servesCache.unshift(row);
  await commitServes('llama-starting');

  await fsp.mkdir(modelsLogDir(), { recursive: true });

  const spawnEnv = buildLlamaServerSpawnEnv(
    llamaServerPath,
    userSettings,
    process.env,
    buildLlamaServerEnv,
  );

  const createRun = createBackgroundRunOverrideForTests ?? createBackgroundRun;
  const spawnLlama = async (nextLaunch) => {
    const spawned = await createRun({
      command: llamaServerPath,
      args: nextLaunch.args,
      cwd: llamaServerSpawnCwd(llamaServerPath),
      env: spawnEnv,
      source: 'agent',
      sandbox: false,
      logSubdir: 'models',
    });
    if (isServeStopRequested(row)) {
      await stopServeRun(spawned.runId);
      throw new Error('Model load cancelled');
    }
    row.runId = spawned.runId;
    row.pid = spawned.pid;
    await commitServes('llama-spawned');
    if (nextLaunch.warning) {
      await appendServeLog(spawned.runId, nextLaunch.warning);
    }
    return spawned;
  };

  let run = await spawnLlama(launch);

  const settle = async () => {
    let currentRun = run;
    let currentLaunch = launch;
    let currentBaseUrl = row.baseUrl;
    let portRetried = false;
    let jinjaRetried = false;

    const diagnoseLoad = (healthy) =>
      diagnoseLlamaFailure(
        healthy.logTail ?? '',
        healthy.exitCode ?? null,
        row.launchPlan ?? currentLaunch.plan,
      );

    let healthy = await waitForHealth(currentBaseUrl, MODEL_LOAD_TIMEOUT_MS, currentRun.runId);
    if (isServeStopRequested(row)) return;
    while (!healthy.ok) {
      await stopServeRun(currentRun.runId);
      if (isServeStopRequested(row)) return;
      const diagnosis = diagnoseLoad(healthy);
      const retryPort = diagnosis.code === 'port_conflict' && !portRetried;
      const retryJinja = diagnosis.code === 'bad_template' && !jinjaRetried;
      if (!retryPort && !retryJinja) {
        const exited = healthy.exitCode != null || Boolean(healthy.logTail);
        row.status = 'error';
        row.exitCode = healthy.exitCode ?? null;
        row.failure = publicFailure(diagnosis, healthy.exitCode ?? null);
        row.error = exited ? diagnosis.title : healthy.error;
        row.stoppedAt = Date.now();
        await commitServes('llama-error');
        throw new Error(row.error);
      }
      if (retryPort) {
        portRetried = true;
        const freshPort = await pickFreePort(0);
        row.port = freshPort;
        currentBaseUrl = `http://127.0.0.1:${freshPort}`;
        row.baseUrl = currentBaseUrl;
      }
      if (retryJinja) {
        jinjaRetried = true;
      }
      currentLaunch = buildLlamaServerLaunch({
        ...launchOpts,
        port: row.port,
        settings: {
          ...userSettings,
          skip_jinja: jinjaRetried ? true : userSettings?.skip_jinja,
        },
      });
      row.llamaSettings = currentLaunch.settings;
      currentRun = await spawnLlama(currentLaunch);
      healthy = await waitForHealth(currentBaseUrl, MODEL_LOAD_TIMEOUT_MS, currentRun.runId);
      if (isServeStopRequested(row)) return;
    }

    const loadMs = Math.max(0, Date.now() - row.startedAt);
    if (libraryId) {
      try {
        await recordLaunchLoadPrior(libraryId, {
          lastLoadMs: loadMs,
          lastWeightsBytes: weightsBytes,
        });
      } catch (err) {
        console.warn('[llama-cpp] launch load prior persist failed:', err);
      }
    }
    try {
      const config = await readLlamaCppConfig();
      const table =
        config.loadRate && typeof config.loadRate === 'object' ? { ...config.loadRate } : {};
      const next = updateLoadRate(table[llamaVariant], { loadMs, weightsBytes });
      if (next > 0) {
        table[llamaVariant] = next;
        await writeLlamaCppConfig({ loadRate: table });
      }
    } catch (err) {
      console.warn('[llama-cpp] load rate persist failed:', err);
    }

    if (currentLaunch?.plan?.spec_type && currentRun?.runId) {
      try {
        const tail = (await readRunLogTail(currentRun.runId, 32768)) ?? '';
        const specBytes = parseSpecContextBytes(tail);
        if (specBytes != null && specBytes > 0 && row.launchPlan) {
          row.launchPlan.specContextBytes = specBytes;
        }
      } catch {
      }
    }

    if (isServeStopRequested(row)) return;
    row.status = 'running';
    row.lastHealthyAt = Date.now();
    row.lastUsedAt = Date.now();
    clearTtlEvictionIfMatchesRow(row);
    watchLlamaRun(row);
    ensureServeHeartbeat();
    warnIfReasoningBudgetCliFlag(userSettings, llamaConfig.defaults);
    await upsertLlamaCppProvider({ baseUrl: row.baseUrl, enabled: true });
    try {
      const supportsThinkingBudget = await detectLlamaThinkingBudgetSupport(llamaServerPath);
      await setProviderThinkingBudgetSupport(LLAMA_CPP_LOCAL_ID, supportsThinkingBudget);
    } catch (err) {
      console.warn('[llama-cpp] thinking budget feature detect failed:', err);
    }
    await commitServes('llama-running');
  };

  if (body.async === true) {
    void settle().catch(() => {
    });
    return publicServe(row);
  }

  await settle();
  return publicServe(row);
}

// ── Stop serve ───────────────────────────────────────────────────────────────

/**
 * @param {string} serveId
 * @param {{ cause?: 'user' | 'ttl' | 'admit' }} [opts]
 */
export async function stopServe(serveId, opts = {}) {
  await loadServes();
  validateServeId(serveId);
  const row = servesCache.find((s) => s.id === serveId);
  if (!row) throw new Error('Serve session not found');

  const cause = opts.cause === 'ttl' || opts.cause === 'admit' ? opts.cause : 'user';
  if (cause === 'ttl' && row.runtime === 'llama-cpp') {
    lastTtlEviction = snapshotTtlEviction(row);
  }
  if (cause === 'user') {
    clearTtlEvictionIfMatchesRow(row);
  }
  userStoppingServeIds.add(serveId);
  cancelPendingRestart(serveId);
  llamaRunUnsubs.get(serveId)?.();
  llamaRunUnsubs.delete(serveId);

  try {
    if (row.runId) {
      const result = await stopServeRun(row.runId);
      const pidStillAlive = row.pid != null && isPidAlive(row.pid);
      if (!result.ok && pidStillAlive) {
        throw new Error(result.error || `Failed to stop model process ${row.pid}`);
      }
    }

    row.status = 'stopped';
    row.stoppedAt = Date.now();
    row.error = undefined;
    await commitServes('stop');

    if (row.runtime === 'llama-cpp' || row.runtime === 'mlx-lm') {
      const sharedProviderId = row.runtime === 'llama-cpp' ? LLAMA_CPP_LOCAL_ID : MLX_LM_LOCAL_ID;
      const stillRunning = servesCache.some(
        (s) => s.runtime === row.runtime && s.id !== serveId && isLiveServeStatus(s.status),
      );
      if (!stillRunning) {
        try {
          await updateProvider(sharedProviderId, { enabled: false });
        } catch {
        }
        if (row.runtime === 'mlx-lm') {
          try {
            await stopServer('mlx-lm');
          } catch {
          }
        }
      }
    } else if (row.providerId) {
      try {
        await updateProvider(row.providerId, { enabled: false });
      } catch {
      }
    }

    return publicServe(row);
  } finally {
    userStoppingServeIds.delete(serveId);
  }
}

export async function listServes() {
  await loadServes();
  return servesCache.map(publicServe);
}

/**
 * @param {string} serveId
 */
export async function getServe(serveId) {
  await loadServes();
  validateServeId(serveId);
  const row = servesCache.find((s) => s.id === serveId);
  return row ? publicServe(row) : null;
}

export async function shutdownAllModelServes() {
  await loadServes();
  const liveRows = servesCache.filter((row) => isLiveServeStatus(row.status));
  for (const row of liveRows) {
    userStoppingServeIds.add(row.id);
  }
  const results = await Promise.allSettled(liveRows.map(async (row) => {
    try {
      cancelPendingRestart(row.id);
      llamaRunUnsubs.get(row.id)?.();
      llamaRunUnsubs.delete(row.id);
      if (row.runId) {
        const result = await stopServeRun(row.runId);
        if (!result.ok) throw new Error(result.error || `Failed to stop model ${row.id}`);
      }
      row.status = 'stopped';
      row.stoppedAt = Date.now();
    } finally {
      userStoppingServeIds.delete(row.id);
    }
  }));
  await commitServes('shutdown');
  const failures = results.filter((result) => result.status === 'rejected');
  if (failures.length) {
    throw new AggregateError(failures.map((result) => result.reason), 'Failed to stop model processes');
  }
  for (const providerId of [LLAMA_CPP_LOCAL_ID, MLX_LM_LOCAL_ID]) {
    try {
      await updateProvider(providerId, { enabled: false });
    } catch {
    }
  }
  const mlxStillActive = servesCache.some(
    (s) => s.runtime === 'mlx-lm' && isLiveServeStatus(s.status),
  );
  if (!mlxStillActive) {
    try {
      await stopServer('mlx-lm');
    } catch {
    }
  }
}

// ── Restart ──────────────────────────────────────────────────────────────────

/**
 * @param {ServeRecord} row
 * @param {{ code: string }} classification
 * @param {number} [now]
 */
export function shouldAutoRestartServe(row, classification, now = Date.now()) {
  if (!row || !classification) return false;
  if (classification.code === 'oom_vram') return false;
  if (!AUTO_RESTART_CODES.has(classification.code)) return false;
  if ((row.restartCount ?? 0) >= 1) return false;
  const healthyAt = row.lastHealthyAt ?? row.startedAt;
  if (!healthyAt || now - healthyAt < AUTO_RESTART_MIN_HEALTHY_MS) return false;
  return true;
}

function cancelPendingRestart(serveId) {
  const pending = pendingRestarts.get(serveId);
  if (pending) pending.cancelled = true;
}

/**
 * @param {string} serveId
 */
export async function restartServe(serveId) {
  await loadServes();
  validateServeId(serveId);
  const row = servesCache.find((s) => s.id === serveId);
  if (!row) throw new Error('Serve session not found');
  return startServe({
    modelPath: row.modelPath,
    runtime: row.runtime,
    modelLabel: row.modelLabel,
    llama: row.llamaSettings,
    libraryId: row.libraryId,
    restartCount: row.restartCount ?? 1,
    async: true,
  });
}

function scheduleAutoRestart(row) {
  if (pendingRestarts.has(row.id)) return;
  const handle = { cancelled: false, promise: Promise.resolve() };
  handle.promise = (async () => {
    await new Promise((resolve) => setTimeout(resolve, restartDelayMs));
    if (handle.cancelled) return;
    const current = servesCache.find((s) => s.id === row.id);
    if (!current || current.status !== 'crashed') return;
    await restartServe(row.id);
  })().catch((err) => {
    console.warn('[serve] auto-restart failed:', err);
  }).finally(() => {
    pendingRestarts.delete(row.id);
  });
  pendingRestarts.set(row.id, handle);
}

export function waitForServeRestartsForTests() {
  return Promise.all([...pendingRestarts.values()].map((h) => h.promise));
}

/**
 * @type {Set<Promise<void>>}
 */
const pendingCrashHandlers = new Set();

function trackCrashHandler(promise) {
  pendingCrashHandlers.add(promise);
  void promise.finally(() => {
    pendingCrashHandlers.delete(promise);
  });
}

export function waitForServeCrashHandlersForTests() {
  return Promise.all([...pendingCrashHandlers]);
}

// ── Crash watch ──────────────────────────────────────────────────────────────

function watchLlamaRun(row) {
  if (!row.runId) return;
  llamaRunUnsubs.get(row.id)?.();
  const subscribe = subscribeRunOverrideForTests ?? subscribeRun;
  if (typeof subscribe !== 'function') return;
  const unsub = subscribe(row.runId, (event) => {
    if (event?.type !== 'exit') return;
    trackCrashHandler(handleLlamaRunExit(row.id, event));
  });
  llamaRunUnsubs.set(row.id, typeof unsub === 'function' ? unsub : () => {});
}

/**
 * @param {string} serveId
 * @param {{ code?: number | null, stopped?: boolean }} event
 */
async function handleLlamaRunExit(serveId, event) {
  await loadServes();
  const row = servesCache.find((s) => s.id === serveId);
  if (!row) return;
  if (event?.stopped) return;
  if (userStoppingServeIds.has(serveId)) return;
  if (row.status === 'stopped' || row.status === 'error' || row.status === 'crashed') return;

  llamaRunUnsubs.get(serveId)?.();
  llamaRunUnsubs.delete(serveId);

  const exitCode = Number.isFinite(event?.code) ? Number(event.code) : event?.code ?? null;
  let logTail = '';
  if (row.runId) {
    try {
      logTail = (await readRunLogTail(row.runId, 4096)) ?? '';
    } catch {
      logTail = '';
    }
  }
  const classified = classifyServeExit({ exitCode, logTail, plan: row.launchPlan ?? null });
  row.status = 'crashed';
  row.exitCode = exitCode;
  row.failure = publicFailure(classified, exitCode);
  row.stoppedAt = Date.now();
  row.error = classified.title || undefined;
  heartbeatFailStreak.delete(serveId);

  const willRestart = shouldAutoRestartServe(row, classified);
  if (willRestart) {
    row.restartCount = (row.restartCount ?? 0) + 1;
  }
  await commitServes('llama-crash');

  const stillLive = servesCache.some(
    (s) => s.runtime === 'llama-cpp' && s.id !== serveId && isLiveServeStatus(s.status),
  );
  if (!stillLive) {
    try {
      await updateProvider(LLAMA_CPP_LOCAL_ID, { enabled: false });
    } catch {
    }
  }

  if (willRestart) scheduleAutoRestart(row);
}

function ensureMlxCrashWatch() {
  if (mlxCrashUnsub) return;
  const subscribe = subscribeServerStateOverrideForTests ?? subscribeServerState;
  if (typeof subscribe !== 'function') return;
  mlxCrashUnsub = subscribe('mlx-lm', (event) => {
    if (event?.type !== 'exit') return;
    trackCrashHandler(handleMlxServerExit(event));
  });
}

/**
 * @param {{ code?: number | null }} event
 */
async function handleMlxServerExit(event) {
  await loadServes();
  const exitCode = Number.isFinite(event?.code) ? Number(event.code) : event?.code ?? null;
  let changed = false;
  for (const row of servesCache) {
    if (row.runtime !== 'mlx-lm') continue;
    if (userStoppingServeIds.has(row.id)) continue;
    if (row.status === 'stopped' || row.status === 'error' || row.status === 'crashed') continue;
    if (!isLiveServeStatus(row.status)) continue;
    row.status = 'crashed';
    row.exitCode = exitCode;
    row.failure = { code: 'unknown', exitCode };
    row.stoppedAt = Date.now();
    row.error = undefined;
    heartbeatFailStreak.delete(row.id);
    changed = true;
  }
  if (!changed) return;
  await commitServes('mlx-crash');
  try {
    await updateProvider(MLX_LM_LOCAL_ID, { enabled: false });
  } catch {
  }
}

function isPidAlive(pid) {
  if (pidAliveOverrideForTests) return pidAliveOverrideForTests(pid);
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isServeProcessAlive(row) {
  if (row.runtime === 'mlx-lm') {
    try {
      return isManagedServerRunning('mlx-lm');
    } catch {
      return false;
    }
  }
  return isPidAlive(row.pid);
}

async function probeServeHealth(row) {
  if (heartbeatProbeOverrideForTests) return heartbeatProbeOverrideForTests(row);
  if (!row.baseUrl) return false;
  try {
    const res = await fetch(`${row.baseUrl}/health`, { signal: AbortSignal.timeout(2_500) });
    return res.ok;
  } catch {
    return false;
  }
}

// ── Heartbeat ────────────────────────────────────────────────────────────────

function stopServeHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

/**
 * @param {{ llamaSettings?: Record<string, unknown> | null }} row
 * @returns {number}
 */
function serveIdleTtlMs(row) {
  const raw = row?.llamaSettings?.idle_ttl_ms;
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 0) return Math.trunc(n);
  return SERVE_IDLE_TTL_MS;
}

function ensureServeHeartbeat() {
  if (heartbeatTimer) return;
  if (process.env.NODE_TEST_CONTEXT && heartbeatIntervalMs === HEARTBEAT_INTERVAL_MS) return;
  heartbeatTimer = setInterval(() => {
    void tickServeHeartbeat();
  }, heartbeatIntervalMs);
  heartbeatTimer.unref?.();
}

export async function tickServeHeartbeatForTests() {
  await tickServeHeartbeat();
}

async function tickServeHeartbeat() {
  await loadServes();
  const now = Date.now();
  const ttlIds = [];
  for (const row of servesCache) {
    if (row.runtime !== 'llama-cpp') continue;
    if (row.status !== 'running' && row.status !== 'unhealthy') continue;
    const usedAt = row.lastUsedAt ?? row.startedAt ?? 0;
    const ttl = serveIdleTtlMs(row);
    if (ttl > 0 && now - usedAt >= ttl) ttlIds.push(row.id);
  }
  for (const id of ttlIds) {
    try {
      await stopServe(id, { cause: 'ttl' });
    } catch (err) {
      console.warn('[serve] idle TTL stop failed:', err);
    }
  }

  let changed = false;
  for (const row of servesCache) {
    if (row.status !== 'running' && row.status !== 'unhealthy') continue;
    const alive = isServeProcessAlive(row);
    if (!alive) {
      if (row.status !== 'crashed' && row.status !== 'stopped') {
        row.status = 'crashed';
        row.exitCode = row.exitCode ?? null;
        row.failure = row.failure ?? { code: 'unknown', exitCode: row.exitCode ?? null };
        row.stoppedAt = Date.now();
        heartbeatFailStreak.delete(row.id);
        changed = true;
      }
      continue;
    }
    const ok = await probeServeHealth(row);
    if (ok) {
      heartbeatFailStreak.delete(row.id);
      row.lastHealthyAt = Date.now();
      if (row.status === 'unhealthy') {
        row.status = 'running';
        changed = true;
      }
      continue;
    }
    const fails = (heartbeatFailStreak.get(row.id) ?? 0) + 1;
    heartbeatFailStreak.set(row.id, fails);
    if (fails >= HEARTBEAT_FAILS_TO_UNHEALTHY && row.status !== 'unhealthy') {
      row.status = 'unhealthy';
      changed = true;
    }
  }
  if (changed) await commitServes('heartbeat');
}

/**
 * @param {string} modelId
 * @returns {Promise<ServeRecord | null>}
 */
export async function findLiveLlamaCppServeForModel(modelId) {
  return findLiveServeForRuntime('llama-cpp', modelId);
}

/**
 * @param {string} modelId
 * @returns {Promise<ServeRecord | null>}
 */
export async function findLiveMlxServeForModel(modelId) {
  return findLiveServeForRuntime('mlx-lm', modelId);
}

/**
 * @param {'llama-cpp' | 'mlx-lm'} runtime
 * @param {string} modelId
 * @returns {Promise<ServeRecord | null>}
 */
async function findLiveServeForRuntime(runtime, modelId) {
  await loadServes();
  const live = servesCache.filter(
    (row) => row.runtime === runtime && isLiveServeStatus(row.status),
  );
  const id = String(modelId ?? '').trim();
  const matches = live.filter((row) => {
    if (serveMatchesModelId(row, id)) return true;
    if (runtime === 'mlx-lm' && row.modelPath && row.modelPath === id) return true;
    return false;
  });
  if (matches.length === 0) return null;
  let best = matches[0];
  for (const row of matches) {
    if ((row.lastUsedAt ?? 0) > (best.lastUsedAt ?? 0)) best = row;
  }
  return best;
}

/**
 * @param {string} serveId
 * @param {number} [at]
 */
export async function touchServeLastUsedAt(serveId, at = Date.now()) {
  await loadServes();
  const row = servesCache.find((s) => s.id === serveId);
  if (!row) return false;
  row.lastUsedAt = at;
  return true;
}

export function getLastTtlEviction() {
  return lastTtlEviction;
}

export function peekServeRowForTests(serveId) {
  return servesCache.find((s) => s.id === serveId) ?? null;
}

export function patchServeRowForTests(serveId, patch) {
  const row = servesCache.find((s) => s.id === serveId);
  if (!row) return null;
  Object.assign(row, patch);
  return row;
}

export async function resetServesForTests() {
  for (const unsub of llamaRunUnsubs.values()) {
    try {
      unsub();
    } catch {
    }
  }
  llamaRunUnsubs.clear();
  for (const handle of pendingRestarts.values()) handle.cancelled = true;
  pendingRestarts.clear();
  heartbeatFailStreak.clear();
  userStoppingServeIds.clear();
  lastTtlEviction = null;
  serveCommitListeners.clear();
  stopServeHeartbeat();
  stopAllServeActivity();
  if (typeof mlxCrashUnsub === 'function') {
    try {
      mlxCrashUnsub();
    } catch {
    }
  }
  mlxCrashUnsub = null;
  servesCache = [];
  loaded = false;
  heartbeatIntervalMs = HEARTBEAT_INTERVAL_MS;
  restartDelayMs = AUTO_RESTART_DELAY_MS;
  resetServeBackgroundRunOverrideForTests();
  resetStopActiveRunOverrideForTests();
  resetServeHealthOverrideForTests();
  resetMlxWarmupOverrideForTests();
  resetServeReachabilityProbeOverrideForTests();
  resetSubscribeRunOverrideForTests();
  resetSubscribeServerStateOverrideForTests();
  resetServeHeartbeatProbeOverrideForTests();
  resetServePidAliveOverrideForTests();
  resetClassifyServeExitOverrideForTests();
}

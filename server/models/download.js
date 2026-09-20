import { getMtplxStatus, isMtplxSupported } from './mtplx-runtime.js';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { getModelsConfig } from './models-config.js';
import {
  downloadHfFile,
  downloadHfSnapshot,
  fetchRemoteSize,
  listRepoFilesRecursive,
  MLX_SNAPSHOT_EXCLUDE,
  pickGgufFilenames,
  validateRepoFilePath,
} from './hf-client.js';
import { expandSplitGgufFilenames, parseSplitGgufFilename } from './split-gguf.js';
import { isMlxSupported, MLX_UNSUPPORTED_MESSAGE } from '../servers/mlx-lm.js';
import { getDownloadsIndexPath, repoDownloadDir } from './paths.js';
import { validateJobId, validateRepoId } from './validate.js';
import { invalidateCachedModelsCache } from './cached.js';

const MIN_FREE_BYTES = 500 * 1024 * 1024;

const DOWNLOAD_PROGRESS_EMIT_MS = 200;

const MAX_CONCURRENT_DOWNLOADS = 2;

const SPEED_EWMA_ALPHA = 0.2;

const INTERRUPTED_DOWNLOAD_ERROR = 'Download interrupted (server restarted)';

/** @typedef {'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled' | 'interrupted'} DownloadStatus */

/**
 * @typedef {'gguf' | 'mlx'} DownloadFormat
 */

/**
 * @typedef {object} DownloadJob
 * @property {string} id
 * @property {string} repoId
 * @property {string} filename
 * @property {string} repoFilePath
 * @property {string[]} [repoFilePaths]
 * @property {string} quant
 * @property {DownloadFormat} [format]
 * @property {DownloadStatus} status
 * @property {number} bytesReceived
 * @property {number | null} totalBytes
 * @property {string} destPath
 * @property {string} [error]
 * @property {number} createdAt
 * @property {number} [finishedAt]
 * @property {number} [resumeAt]
 * @property {number} [bytesPerSec]
 * @property {number | null} [etaMs]
 * @property {boolean} [interrupted]
 */

/** @type {Map<string, AbortController>} */
const abortByJob = new Map();
const pauseRequests = new Set();
const runsByJob = new Map();
let startQueue = Promise.resolve();
let saveQueue = Promise.resolve();

/** @type {Map<string, Set<(event: object) => void>>} */
const listenersByJob = new Map();

/** @type {DownloadJob[]} */
let jobsCache = [];

let loaded = false;
let jobsLoad = null;

/**
 * Bumped by `resetDownloadsForTests` so an in-flight `saveJobs()` cannot write
 * a stale (often empty) index over a later test's seeded `downloads.json`.
 * @type {number}
 */
let persistGeneration = 0;

/** In-flight `runDownloadJob` promises; tests drain these before reseeding. */
const inFlightDownloads = new Set();

// ── Job state ────────────────────────────────────────────────────────────────

function emit(jobId, event) {
  const set = listenersByJob.get(jobId);
  if (!set) return;
  for (const listener of set) {
    try {
      listener(event);
    } catch {
    }
  }
}

function snapshot(job) {
  return {
    jobId: job.id,
    status: job.status,
    bytesReceived: job.bytesReceived,
    totalBytes: job.totalBytes,
    bytesPerSec: job.bytesPerSec ?? null,
    etaMs: job.etaMs ?? null,
    interrupted: job.interrupted === true,
    resumeAt: job.resumeAt ?? null,
    error: job.error ?? null,
  };
}

async function loadJobs() {
  if (jobsLoad) return jobsLoad;
  if (loaded) return;
  jobsLoad = (async () => {
    try {
      const raw = await fsp.readFile(getDownloadsIndexPath(), 'utf8');
      const parsed = JSON.parse(raw);
      jobsCache = Array.isArray(parsed.jobs) ? parsed.jobs : [];
    } catch {
      jobsCache = [];
    }
    await reconcileInterruptedJobs();
    loaded = true;
    pumpDownloadQueue();
  })();
  try { await jobsLoad; } finally { jobsLoad = null; }
}

/**
 * @param {DownloadJob} job
 */
async function cleanupJobArtifacts(job) {
  if (!job.destPath) return;
  // MTPLX's cache belongs to the external installation. Cancelling a repair
  // download must not remove weights that were there before Minnow started it.
  if (job.engine === 'mtplx' && job.preserveExistingArtifacts) return;
  if (job.format === 'mlx') {
    await fsp.rm(job.destPath, { recursive: true, force: true }).catch(() => {});
    return;
  }
  await fsp.rm(job.destPath, { force: true }).catch(() => {});
  await fsp.rm(`${job.destPath}.partial`, { force: true }).catch(() => {});
  if (Array.isArray(job.repoFilePaths)) {
    const dir = path.dirname(job.destPath);
    for (const file of job.repoFilePaths) {
      const dest = path.join(dir, path.basename(file));
      if (dest === job.destPath) continue;
      await fsp.rm(dest, { force: true }).catch(() => {});
      await fsp.rm(`${dest}.partial`, { force: true }).catch(() => {});
    }
  }
}

/**
 * @param {DownloadJob} job
 */
async function partialSizeForJob(job) {
  if (!job.destPath || job.format === 'mlx') return 0;
  let size = 0;
  for (const file of job.repoFilePaths ?? [job.filename]) {
    const dest = path.join(path.dirname(job.destPath), path.basename(file));
    for (const candidate of [dest, `${dest}.partial`]) {
      try {
        const stat = await fsp.stat(candidate);
        if (stat.isFile()) { size += stat.size; break; }
      } catch {}
    }
  }
  return size;
}

async function reconcileInterruptedJobs() {
  let changed = false;
  for (const job of jobsCache) {
    if (job.status !== 'queued' && job.status !== 'running') continue;
    const resumeAt = await partialSizeForJob(job);
    job.status = 'interrupted';
    job.interrupted = true;
    job.error = INTERRUPTED_DOWNLOAD_ERROR;
    job.resumeAt = resumeAt;
    if (resumeAt > 0) job.bytesReceived = resumeAt;
    changed = true;
  }
  if (!changed) return;
  for (const job of jobsCache) {
    if (job.status !== 'interrupted') continue;
    job.status = 'queued';
    job.error = undefined;
    delete job.finishedAt;
  }
  await saveJobs();
}

/**
 * @param {unknown} err
 * @param {AbortSignal} signal
 */
function isCancelledError(err, signal) {
  if (signal.aborted) return true;
  if (!(err instanceof Error)) return false;
  if (err.message === 'Download cancelled') return true;
  return err.name === 'AbortError';
}

async function saveJobs() {
  const generation = persistGeneration;
  const snapshot = JSON.stringify({ version: 1, jobs: jobsCache }, null, 2);
  const indexPath = getDownloadsIndexPath();
  const pending = saveQueue.then(async () => {
    await fsp.mkdir(path.dirname(indexPath), { recursive: true });
    if (generation !== persistGeneration) return;
    const temporary = `${indexPath}.tmp`;
    await fsp.writeFile(temporary, `${snapshot}\n`, 'utf8');
    await fsp.rename(temporary, indexPath);
  });
  saveQueue = pending.catch(() => {});
  await pending;
}

/**
 * @param {string} jobId
 */
function findJob(jobId) {
  return jobsCache.find((j) => j.id === jobId) ?? null;
}

/**
 * @param {number} requiredBytes
 */
async function assertDiskSpace(requiredBytes) {
  const targetDir = repoDownloadDir('_probe');
  await fsp.mkdir(path.dirname(targetDir), { recursive: true });
  try {
    const { statfs } = await import('node:fs/promises');
    const stats = await statfs(path.dirname(targetDir));
    const free = Number(stats.bfree) * Number(stats.bsize);
    const need = Math.max(requiredBytes, MIN_FREE_BYTES);
    if (free < need) {
      throw new Error(
        `Not enough disk space (need ~${Math.ceil(need / (1024 ** 3))} GB free)`,
      );
    }
  } catch (err) {
    if (err && err.message?.includes('Not enough disk space')) throw err;
  }
}

function pumpDownloadQueue() {
  const running = jobsCache.filter((job) => job.status === 'running');
  const queued = jobsCache
    .filter((job) => job.status === 'queued')
    .slice()
    .sort((a, b) => a.createdAt - b.createdAt);
  for (const job of queued) {
    if (running.length >= MAX_CONCURRENT_DOWNLOADS) return;
    if (running.some((row) => row.repoId === job.repoId)) continue;
    job.status = 'running';
    running.push(job);
    const pending = runDownloadJob(job);
    runsByJob.set(job.id, pending);
    inFlightDownloads.add(pending);
    void pending.finally(() => {
      inFlightDownloads.delete(pending);
      runsByJob.delete(job.id);
    });
  }
}

/**
 * @param {DownloadJob} job
 */
function createSpeedTracker(job) {
  let lastAt = 0;
  let lastBytes = job.bytesReceived || 0;
  let ewma = 0;
  return {
    /**
     * @param {number} bytes
     * @param {number | null} total
     */
    tick(bytes, total) {
      const now = Date.now();
      if (lastAt > 0) {
        const dtSec = (now - lastAt) / 1000;
        if (dtSec > 0) {
          const instant = Math.max(0, (bytes - lastBytes) / dtSec);
          ewma = ewma > 0 ? SPEED_EWMA_ALPHA * instant + (1 - SPEED_EWMA_ALPHA) * ewma : instant;
        }
      }
      lastAt = now;
      lastBytes = bytes;
      job.bytesPerSec = ewma;
      const remaining = total != null && total > bytes ? total - bytes : 0;
      job.etaMs = ewma > 0 && remaining > 0 ? Math.round((remaining / ewma) * 1000) : remaining > 0 ? null : 0;
    },
  };
}

/**
 * @param {DownloadJob} job
 */
async function recordResumeOffset(job) {
  const size = await partialSizeForJob(job);
  job.resumeAt = size;
  if (job.format !== 'mlx') job.bytesReceived = size;
}

// ── Download ─────────────────────────────────────────────────────────────────

/**
 * @param {DownloadJob} job
 * @param {AbortSignal} signal
 * @param {(bytes: number, total: number | null) => void} onProgress
 */
async function downloadGgufJobFiles(job, signal, onProgress) {
  const files =
    Array.isArray(job.repoFilePaths) && job.repoFilePaths.length
      ? job.repoFilePaths
      : [job.repoFilePath || job.filename];
  const destDir = path.dirname(job.destPath);
  let completedBytes = 0;
  const knownTotal = job.totalBytes;
  for (const file of files) {
    if (signal.aborted) throw new Error('Download cancelled');
    const destPath = path.join(destDir, path.basename(file));
    const result = await downloadHfFile({
      repoId: job.repoId,
      filename: file,
      destPath,
      signal,
      onProgress: (received, fileTotal) => {
        const overall = completedBytes + received;
        const overallTotal =
          knownTotal != null
            ? knownTotal
            : fileTotal != null
              ? completedBytes + fileTotal
              : null;
        onProgress(overall, overallTotal);
      },
    });
    completedBytes += result.bytesReceived;
    onProgress(completedBytes, knownTotal ?? completedBytes);
  }
  return { bytesReceived: completedBytes, totalBytes: knownTotal ?? completedBytes };
}

/**
 * @param {DownloadJob} job
 */
async function runDownloadJob(job) {
  const controller = new AbortController();
  abortByJob.set(job.id, controller);

  job.status = 'running';
  await saveJobs();
  emit(job.id, snapshot(job));

  let lastProgressEmitAt = 0;
  const speed = createSpeedTracker(job);
  const onProgress = (bytes, total) => {
    job.bytesReceived = bytes;
    if (total != null) job.totalBytes = total;
    const now = Date.now();
    if (now - lastProgressEmitAt < DOWNLOAD_PROGRESS_EMIT_MS) return;
    lastProgressEmitAt = now;
    speed.tick(bytes, job.totalBytes);
    emit(job.id, snapshot(job));
  };

  try {
    const result =
      job.format === 'mlx'
        ? await downloadHfSnapshot({
            repoId: job.repoId,
            destDir: job.destPath,
            signal: controller.signal,
            exclude: MLX_SNAPSHOT_EXCLUDE,
            onProgress,
          })
        : await downloadGgufJobFiles(job, controller.signal, onProgress);
    job.bytesReceived = result.bytesReceived;
    job.totalBytes = result.totalBytes;
    job.status = 'completed';
    job.etaMs = 0;
    job.finishedAt = Date.now();
    invalidateCachedModelsCache();
    emit(job.id, snapshot(job));
  } catch (err) {
    const cancelled = isCancelledError(err, controller.signal);
    const paused = pauseRequests.has(job.id);
    job.status = paused ? 'paused' : cancelled ? 'cancelled' : 'failed';
    job.error = paused ? undefined : err instanceof Error ? err.message : String(err);
    job.bytesPerSec = 0;
    job.etaMs = null;
    job.finishedAt = Date.now();
    if (cancelled && !paused) {
      await cleanupJobArtifacts(job);
    } else {
      await recordResumeOffset(job);
    }
    emit(job.id, snapshot(job));
  } finally {
    abortByJob.delete(job.id);
    pauseRequests.delete(job.id);
    await saveJobs();
    pumpDownloadQueue();
  }
}

// ── Public jobs ──────────────────────────────────────────────────────────────

/**
 * @param {{ repoId: string, filename?: string, quant?: string, catalogName?: string, format?: string, sizeBytes?: number }} body
 */
export function startDownload(body) {
  const pending = startQueue.then(() => createDownload(body));
  startQueue = pending.catch(() => {});
  return pending;
}

async function createDownload(body) {
  await loadJobs();
  const repoId = validateRepoId(body.repoId);
  if (body.engine != null && (body.engine !== 'mtplx' || body.format !== 'mlx')) throw new Error('MTPLX downloads require MLX snapshots');
  if (body.filename) {
    validateRepoFilePath(body.filename);
    if (!/\.gguf$/i.test(body.filename)) throw new Error('Select a GGUF model file');
  }
  const duplicate = jobsCache.find((job) => job.repoId === repoId
    && (job.engine ?? null) === (body.engine ?? null)
    && (job.format ?? 'gguf') === (body.format ?? 'gguf')
    && (body.format === 'mlx' || (body.filename ? job.repoFilePath === body.filename : job.quant === (body.quant || 'Q4_K_M')))
    && ['running', 'queued', 'paused', 'interrupted'].includes(job.status));
  if (duplicate) return publicJob(duplicate);

  if (body.format === 'mlx') {
    if (!isMlxSupported()) {
      throw new Error(MLX_UNSUPPORTED_MESSAGE);
    }
    if (body.engine === 'mtplx' && !isMtplxSupported()) throw new Error('MTPLX requires Apple Silicon and macOS 14 or newer.');
    const destPath = body.engine === 'mtplx' ? path.join((await getMtplxStatus()).cacheDir, repoId.replace('/', '--')) : repoDownloadDir(repoId);
    const preserveExistingArtifacts = body.engine === 'mtplx' && await fsp.readdir(destPath).then((entries) => entries.length > 0).catch(() => false);
    const declared = Number(body.sizeBytes);
    const totalBytes = Number.isFinite(declared) && declared > 0 ? declared : null;
    await assertDiskSpace(totalBytes != null ? totalBytes + MIN_FREE_BYTES : MIN_FREE_BYTES);

    const job = /** @type {DownloadJob} */ ({
      id: crypto.randomUUID(),
      repoId,
      filename: '',
      repoFilePath: '',
      quant: typeof body.quant === 'string' ? body.quant.trim() : '',
      format: 'mlx',
      engine: body.engine === 'mtplx' ? 'mtplx' : undefined,
      preserveExistingArtifacts,
      status: 'queued',
      bytesReceived: 0,
      totalBytes,
      destPath,
      createdAt: Date.now(),
    });

    jobsCache.unshift(job);
    await saveJobs();
    pumpDownloadQueue();
    return publicJob(job);
  }

  const quant = typeof body.quant === 'string' && body.quant.trim() ? body.quant.trim() : 'Q4_K_M';
  const given =
    typeof body.filename === 'string' && body.filename.trim() ? body.filename.trim() : '';

  /** @type {string[]} */
  let files;
  /** @type {number | null} */
  let totalBytes = null;

  if (given && !parseSplitGgufFilename(given)) {
    files = [given];
    try {
      totalBytes = await fetchRemoteSize(repoId, files[0]);
    } catch {
    }
  } else {
    const listed = await listRepoFilesRecursive(repoId);
    const ggufs = listed
      .map((row) => row.path)
      .filter((p) => p.toLowerCase().endsWith('.gguf'));
    if (!ggufs.length) {
      throw new Error(`No GGUF files found in ${repoId}`);
    }
    files = given ? expandSplitGgufFilenames(given, ggufs) : pickGgufFilenames(ggufs, quant);
    const summed = files.reduce((sum, filePath) => {
      const row = listed.find((item) => item.path === filePath);
      return sum + (typeof row?.size === 'number' ? row.size : 0);
    }, 0);
    totalBytes = summed > 0 ? summed : null;
    if (totalBytes == null) {
      try {
        totalBytes = await fetchRemoteSize(repoId, files[0]);
      } catch {
      }
    }
  }

  const destDir = repoDownloadDir(repoId);
  const repoFilePath = files[0];
  const localFilename = path.basename(repoFilePath);
  const destPath = path.join(destDir, repoFilePath);

  if (totalBytes != null) {
    await assertDiskSpace(totalBytes + MIN_FREE_BYTES);
  } else {
    await assertDiskSpace(MIN_FREE_BYTES);
  }

  const job = /** @type {DownloadJob} */ ({
    id: crypto.randomUUID(),
    repoId,
    filename: localFilename,
    repoFilePath,
    repoFilePaths: files,
    quant,
    format: 'gguf',
    status: 'queued',
    bytesReceived: 0,
    totalBytes,
    destPath,
    createdAt: Date.now(),
  });

  jobsCache.unshift(job);
  await saveJobs();
  pumpDownloadQueue();
  return publicJob(job);
}

/**
 * @param {DownloadJob} job
 */
function publicJob(job) {
  return {
    id: job.id,
    repoId: job.repoId,
    filename: job.filename,
    repoFilePath: job.repoFilePath,
    quant: job.quant,
    format: job.format ?? 'gguf',
    status: job.status,
    bytesReceived: job.bytesReceived,
    totalBytes: job.totalBytes,
    destPath: job.destPath,
    error: job.error ?? null,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt ?? null,
    resumeAt: job.resumeAt ?? null,
    bytesPerSec: job.bytesPerSec ?? null,
    etaMs: job.etaMs ?? null,
    interrupted: job.interrupted === true,
  };
}

export async function listDownloads() {
  await loadJobs();
  return jobsCache.map(publicJob);
}

/**
 * @param {string} jobId
 */
export async function cancelDownload(jobId) {
  await loadJobs();
  validateJobId(jobId);
  const job = findJob(jobId);
  if (!job) {
    throw new Error('Download job not found');
  }
  if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') {
    return publicJob(job);
  }
  const controller = abortByJob.get(jobId);
  if (controller) {
    pauseRequests.delete(jobId);
    controller.abort();
    await runsByJob.get(jobId);
    return publicJob(job);
  }
  job.status = 'cancelled';
  job.finishedAt = Date.now();
  await saveJobs();
  await cleanupJobArtifacts(job);
  emit(jobId, snapshot(job));
  pumpDownloadQueue();
  return publicJob(job);
}

export async function pauseDownload(jobId) {
  await loadJobs();
  validateJobId(jobId);
  const job = findJob(jobId);
  if (!job) throw new Error('Download job not found');
  if (!['running', 'queued', 'interrupted'].includes(job.status)) return publicJob(job);
  const controller = abortByJob.get(jobId);
  if (controller) {
    pauseRequests.add(jobId);
    controller.abort();
    await runsByJob.get(jobId);
  } else {
    job.status = 'paused';
    job.bytesPerSec = 0;
    job.etaMs = null;
    await saveJobs();
    emit(jobId, snapshot(job));
  }
  return publicJob(job);
}

export function resumeDownload(jobId) {
  const pending = startQueue.then(() => resumeDownloadJob(jobId));
  startQueue = pending.catch(() => {});
  return pending;
}

async function resumeDownloadJob(jobId) {
  await loadJobs();
  validateJobId(jobId);
  const job = findJob(jobId);
  if (!job) throw new Error('Download job not found');
  if (!['paused', 'failed', 'interrupted'].includes(job.status)) return publicJob(job);
  await recordResumeOffset(job);
  await assertDiskSpace(Math.max(0, (job.totalBytes ?? 0) - job.bytesReceived) + MIN_FREE_BYTES);
  job.status = 'queued';
  job.error = undefined;
  job.interrupted = true;
  job.bytesPerSec = 0;
  job.etaMs = null;
  delete job.finishedAt;
  await saveJobs();
  emit(jobId, snapshot(job));
  pumpDownloadQueue();
  return publicJob(job);
}

/**
 * @param {string} jobId
 * @param {(event: object) => void} listener
 */
export function subscribeDownload(jobId, listener) {
  validateJobId(jobId);
  if (!listenersByJob.has(jobId)) listenersByJob.set(jobId, new Set());
  listenersByJob.get(jobId).add(listener);
  const job = findJob(jobId);
  if (job) {
    listener(snapshot(job));
  }
  return () => {
    listenersByJob.get(jobId)?.delete(listener);
  };
}

export async function resetDownloadsForTests() {
  persistGeneration += 1;
  for (const controller of abortByJob.values()) {
    try {
      controller.abort();
    } catch {
    }
  }
  // Empty the cache first so a finishing job's `pumpDownloadQueue()` cannot
  // start another run while we drain.
  jobsCache = [];
  loaded = false;
  listenersByJob.clear();
  // Bound the wait so a fetch that ignores abort cannot stall the suite
  // (download.test.mjs keeps a never-settling body until abort).
  const drainDeadline = Date.now() + 5_000;
  while (inFlightDownloads.size > 0 && Date.now() < drainDeadline) {
    for (const controller of abortByJob.values()) {
      try {
        controller.abort();
      } catch {
      }
    }
    await Promise.race([
      Promise.allSettled([...inFlightDownloads]),
      new Promise((resolve) => setTimeout(resolve, 250)),
    ]);
  }
  abortByJob.clear();
  persistGeneration += 1;
  if (!process.env.MINNOW_HOME) return;
  try {
    const indexPath = getDownloadsIndexPath();
    await fsp.mkdir(path.dirname(indexPath), { recursive: true });
    await fsp.writeFile(indexPath, `${JSON.stringify({ version: 1, jobs: [] }, null, 2)}\n`);
  } catch {
  }
}

export { getModelsConfig } from './models-config.js';
export { MAX_CONCURRENT_DOWNLOADS };

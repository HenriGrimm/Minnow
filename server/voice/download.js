/**
 * Voice model download jobs — HF snapshot downloads to ~/.minnow/models/voice/.
 */

import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { downloadHfSnapshot, listRepoFilesRecursive } from '../models/hf-client.js';
import { validateJobId, validateRepoId } from '../models/validate.js';
import {
  getVoiceDownloadsIndexPath,
  getVoiceInstalledPath,
  getVoiceModelsRoot,
  voiceModelDir,
} from './paths.js';
import { isSttCatalogModel, resolveSttDownloadRepoId } from './stt-catalog.js';
import { QWEN_TOKENIZER_MODEL_ID, resolveTtsCatalogMeta } from './tts-catalog.js';

/** Minimum free bytes before starting a voice download (500 MB). */
const MIN_FREE_BYTES = 500 * 1024 * 1024;

/** @typedef {'queued' | 'running' | 'completed' | 'failed' | 'cancelled'} VoiceDownloadStatus */
/** @typedef {'stt' | 'tts'} VoiceModelKind */

/**
 * @typedef {object} VoiceDownloadJob
 * @property {string} id
 * @property {VoiceModelKind} kind
 * @property {string} modelId
 * @property {VoiceDownloadStatus} status
 * @property {number} bytesReceived
 * @property {number | null} totalBytes
 * @property {boolean} [staged]
 * @property {string} destDir
 * @property {string} [error]
 * @property {number} createdAt
 * @property {number} [finishedAt]
 */

/** @type {Map<string, AbortController>} */
const abortByJob = new Map();

/** @type {Map<string, Set<(event: object) => void>>} */
const listenersByJob = new Map();

/** @type {VoiceDownloadJob[]} */
let jobsCache = [];

let loading;
let jobsWrites = Promise.resolve();
let manifestWrites = Promise.resolve();
const running = new Set();
const completeMarker = '.minnow-snapshot-complete';

function stagingDir(jobId) {
  return path.join(path.dirname(getVoiceModelsRoot()), '.voice-downloads', validateJobId(jobId));
}

function withManifest(operation) {
  const next = manifestWrites.then(operation);
  manifestWrites = next.catch(() => {});
  return next;
}

async function writeJson(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + '.' + crypto.randomUUID() + '.tmp';
  try {
    await fsp.writeFile(tmp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', flush: true });
    await fsp.rename(tmp, file);
  } finally {
    await fsp.rm(tmp, { force: true });
  }
}

function emit(jobId, event) {
  const set = listenersByJob.get(jobId);
  if (!set) return;
  for (const listener of set) {
    try {
      listener(event);
    } catch {
      /* ignore listener errors */
    }
  }
}

async function loadJobs() {
  loading ??= recoverJobs().catch((err) => {
    loading = undefined;
    throw err;
  });
  return loading;
}

async function recoverJobs() {
  try {
    const raw = await fsp.readFile(getVoiceDownloadsIndexPath(), 'utf8');
    const parsed = JSON.parse(raw);
    jobsCache = Array.isArray(parsed.jobs) ? parsed.jobs : [];
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    return;
  }
  const interrupted = jobsCache.filter(job => ['queued', 'running'].includes(job.status));
  for (const job of interrupted) {
    const stage = stagingDir(job.id);
    validateKind(job.kind);
    const dest = voiceModelDir(validateRepoId(job.modelId));
    const candidates = [[job.kind, job.modelId, dest]];
    if (job.kind === 'tts' && resolveTtsCatalogMeta(job.modelId).requiresTokenizer) {
      candidates.unshift(['tts', QWEN_TOKENIZER_MODEL_ID, voiceModelDir(QWEN_TOKENIZER_MODEL_ID)]);
    }
    for (const [kind, modelId, dir] of candidates) {
      const manifest = await readInstalledManifestFile();
      const recorded = manifest[kind].find(row => row.modelId === modelId);
      if (recorded) {
        if (recorded.path !== dir || await snapshotAvailable(dir, modelId)) continue;
        manifest[kind] = manifest[kind].filter(row => row.modelId !== modelId);
        await writeInstalledManifest(manifest);
      }
      const marker = await fsp.readFile(path.join(dir, completeMarker), 'utf8').catch(err => {
        if (err.code !== 'ENOENT') throw err;
        return '';
      });
      if (marker === modelId) {
        await registerInstalledModel(kind, modelId, dir, { mode: kind === 'tts' ? resolveTtsCatalogMeta(modelId).mode : undefined });
      } else if (!job.staged) {
        // Older builds streamed into the public directory. Retain ambiguous files for recovery.
        const parked = path.join(path.dirname(stage), 'interrupted-' + job.id, path.basename(dir));
        await fsp.mkdir(path.dirname(parked), { recursive: true });
        await fsp.rename(dir, parked).catch(err => { if (err.code !== 'ENOENT') throw err; });
      }
    }
    const installed = await readInstalledManifestFile();
    job.status = installed[job.kind].some(row => row.modelId === job.modelId) ? 'completed' : 'failed';
    if (job.status === 'failed') job.error = 'Download interrupted. Start the download again.';
    job.finishedAt = Date.now();
    await fsp.rm(stage, { recursive: true, force: true });
  }
  if (interrupted.length) await saveJobs();
}

function saveJobs() {
  const next = jobsWrites.then(() => writeJson(getVoiceDownloadsIndexPath(), { version: 1, jobs: jobsCache }));
  jobsWrites = next.catch(() => {});
  return next;
}

/**
 * @param {string} jobId
 */
function findJob(jobId) {
  return jobsCache.find((j) => j.id === jobId) ?? null;
}

/**
 * @param {VoiceModelKind} kind
 */
function validateKind(kind) {
  if (kind !== 'stt' && kind !== 'tts') {
    throw new Error('Invalid kind — expected stt or tts');
  }
  return kind;
}

/**
 * @param {number} requiredBytes
 */
async function assertDiskSpace(requiredBytes) {
  const targetDir = getVoiceModelsRoot();
  await fsp.mkdir(targetDir, { recursive: true });
  try {
    const { statfs } = await import('node:fs/promises');
    const stats = await statfs(targetDir);
    const free = Number(stats.bfree) * Number(stats.bsize);
    const need = Math.max(requiredBytes, MIN_FREE_BYTES);
    if (free < need) {
      throw new Error(
        `Not enough disk space (need ~${Math.ceil(need / (1024 ** 3))} GB free)`,
      );
    }
  } catch (err) {
    if (err && err.message?.includes('Not enough disk space')) throw err;
    /* statfs unavailable — skip strict check */
  }
}

/**
 * @typedef {object} InstalledVoiceModel
 * @property {string} modelId
 * @property {string} path
 * @property {number} installedAt
 * @property {number} [sizeBytes]
 * @property {'stt' | 'tts'} [kind]
 * @property {'custom_voice' | 'voice_design' | 'voice_clone' | 'tokenizer'} [mode]
 */

/**
 * Map a voice models directory name back to a HuggingFace repo id.
 * @param {string} dirName
 */
function dirNameToModelId(dirName) {
  return dirName.replace(/--/g, '/');
}

/**
 * Classify an on-disk voice model as STT or TTS using catalog metadata.
 * @param {string} modelId
 * @returns {'stt' | 'tts' | null}
 */
function classifyVoiceModelKind(modelId) {
  if (isSttCatalogModel(modelId)) return 'stt';
  const lower = modelId.toLowerCase();
  if (lower.includes('tts') || lower.includes('tokenizer') || lower.includes('qwen3-tts')) {
    return 'tts';
  }
  return null;
}

/**
 * @param {string} destDir
 */
async function computeDirSizeBytes(destDir) {
  let sizeBytes = 0;
  try {
    const walk = async (current) => {
      const entries = await fsp.readdir(current, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
        } else if (entry.isFile()) {
          const stat = await fsp.stat(full);
          sizeBytes += stat.size;
        }
      }
    };
    await walk(destDir);
  } catch {
    sizeBytes = 0;
  }
  return sizeBytes;
}

// Legacy downloads lack a completion marker. Recognize supported weight layouts,
// including all the shards referenced by a transformers index.
async function snapshotAvailable(dir, modelId) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
  const files = new Set(entries.filter(entry => entry.isFile()).map(entry => entry.name));
  if (files.has(completeMarker) && await fsp.readFile(path.join(dir, completeMarker), 'utf8') === modelId) return true;
  if (!files.has('config.json') || [...files].some(file => file.endsWith('.partial'))) return false;
  const weightsPresent = async (name) => files.has(name) && (await fsp.stat(path.join(dir, name))).size > 0;
  for (const name of ['model.safetensors', 'model.bin', 'pytorch_model.bin']) {
    if (await weightsPresent(name)) return true;
  }
  for (const name of ['model.safetensors.index.json', 'pytorch_model.bin.index.json']) {
    if (!files.has(name)) continue;
    try {
      const index = JSON.parse(await fsp.readFile(path.join(dir, name), 'utf8'));
      const shards = [...new Set(Object.values(index.weight_map ?? {}))];
      if (shards.length && (await Promise.all(shards.map(weightsPresent))).every(Boolean)) return true;
    } catch (err) {
      if (!(err instanceof SyntaxError)) throw err;
    }
  }
  return false;
}

/**
 * Scan ~/.minnow/models/voice for HF snapshot folders and rebuild the manifest.
 * @returns {Promise<{ version: number, stt: InstalledVoiceModel[], tts: InstalledVoiceModel[] }>}
 */
async function rebuildInstalledManifestFromDisk() {
  const manifest = { version: 1, stt: [], tts: [] };
  const modelsRoot = getVoiceModelsRoot();
  let entries = [];
  try {
    entries = await fsp.readdir(modelsRoot, { withFileTypes: true });
  } catch {
    return manifest;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const modelId = dirNameToModelId(entry.name);
    const kind = classifyVoiceModelKind(modelId);
    if (!kind) continue;

    const destDir = path.join(modelsRoot, entry.name);
    if (!await snapshotAvailable(destDir, modelId)) continue;
    let installedAt = Date.now();
    try {
      const stat = await fsp.stat(destDir);
      installedAt = Math.trunc(stat.mtimeMs);
    } catch {
      /* keep default installedAt */
    }

    const row = /** @type {InstalledVoiceModel} */ ({
      modelId,
      path: destDir,
      installedAt,
      sizeBytes: await computeDirSizeBytes(destDir),
      kind,
      ...(kind === 'tts' ? { mode: resolveTtsCatalogMeta(modelId).mode } : {}),
    });

    if (kind === 'stt') manifest.stt.push(row);
    else manifest.tts.push(row);
  }

  manifest.stt.sort((a, b) => b.installedAt - a.installedAt);
  manifest.tts.sort((a, b) => b.installedAt - a.installedAt);
  await writeInstalledManifest(manifest);
  return manifest;
}

/**
 * @returns {Promise<{ version: number, stt: InstalledVoiceModel[], tts: InstalledVoiceModel[] }>}
 */
async function readInstalledManifestFile() {
  try {
    const raw = await fsp.readFile(getVoiceInstalledPath(), 'utf8');
    const parsed = JSON.parse(raw);
    return {
      version: 1,
      stt: Array.isArray(parsed.stt) ? parsed.stt : [],
      tts: Array.isArray(parsed.tts) ? parsed.tts : [],
    };
  } catch {
    return { version: 1, stt: [], tts: [] };
  }
}

/**
 * Whether any HF snapshot folders exist under the voice models root.
 */
async function hasVoiceModelsOnDisk() {
  try {
    const entries = await fsp.readdir(getVoiceModelsRoot(), { withFileTypes: true });
    return entries.some((entry) => entry.isDirectory());
  } catch {
    return false;
  }
}

/**
 * @param {{ version: number, stt: InstalledVoiceModel[], tts: InstalledVoiceModel[] }} manifest
 */
async function shouldRebuildManifest(manifest) {
  if (manifest.stt.length > 0 || manifest.tts.length > 0) return false;
  return hasVoiceModelsOnDisk();
}

/**
 * @param {{ rebuildFromDisk?: boolean }} [options]
 * @returns {Promise<{ version: number, stt: InstalledVoiceModel[], tts: InstalledVoiceModel[] }>}
 */
async function readInstalledManifest({ rebuildFromDisk = false } = {}) {
  const manifest = await readInstalledManifestFile();
  if (!rebuildFromDisk) return manifest;
  for (const kind of ['stt', 'tts']) {
    const usable = [];
    for (const row of manifest[kind]) {
      if (row.path !== voiceModelDir(row.modelId) || await snapshotAvailable(row.path, row.modelId)) usable.push(row);
    }
    if (usable.length !== manifest[kind].length) {
      manifest[kind] = usable;
      await writeInstalledManifest(manifest);
    }
  }
  if (await shouldRebuildManifest(manifest)) {
    return rebuildInstalledManifestFromDisk();
  }
  return manifest;
}

/**
 * @param {{ version: number, stt: InstalledVoiceModel[], tts: InstalledVoiceModel[] }} manifest
 */
async function writeInstalledManifest(manifest) {
  await writeJson(getVoiceInstalledPath(), manifest);
}

/**
 * Register a completed download in the installed manifest.
 * @param {VoiceModelKind} kind
 * @param {string} modelId
 * @param {string} destDir
 * @param {{ mode?: string }} [options]
 */
async function registerInstalledModel(kind, modelId, destDir, options = {}) {
  const manifest = await readInstalledManifest();
  const list = kind === 'stt' ? manifest.stt : manifest.tts;
  const filtered = list.filter((row) => row.modelId !== modelId);
  const sizeBytes = await computeDirSizeBytes(destDir);
  filtered.unshift({
    modelId,
    path: destDir,
    installedAt: Date.now(),
    sizeBytes,
    kind,
    ...(options.mode ? { mode: options.mode } : {}),
  });
  if (kind === 'stt') manifest.stt = filtered;
  else manifest.tts = filtered;
  await writeInstalledManifest(manifest);
}

async function publishSnapshot(kind, modelId, incoming, mode) {
  await fsp.writeFile(path.join(incoming, completeMarker), modelId);
  await withManifest(async () => {
    const existing = await readInstalledManifestFile();
    if (existing[kind].some(row => row.modelId === modelId)) return;
    const dest = voiceModelDir(modelId);
    try {
      // Old builds can leave unregistered, incomplete directories in the public tree.
      if (!await snapshotAvailable(dest, modelId)) {
        const parked = path.join(path.dirname(getVoiceModelsRoot()), '.voice-downloads', 'interrupted-' + crypto.randomUUID());
        await fsp.rename(dest, parked).catch(err => { if (err.code !== 'ENOENT') throw err; });
      }
      await fsp.rename(incoming, dest);
    } catch (err) {
      // Another completed transfer may have published just before a manifest write failed.
      const marker = await fsp.readFile(path.join(dest, completeMarker), 'utf8').catch(() => '');
      if (marker !== modelId) throw err;
    }
    await registerInstalledModel(kind, modelId, dest, { mode });
  });
}

/**
 * Download the Qwen tokenizer dependency when a TTS model requires it.
 * @param {string} parentJobId
 * @param {AbortSignal} signal
 * @param {(bytes: number, total: number | null) => void} onProgress
 */
async function ensureTokenizerDownloaded(parentJobId, signal, onProgress) {
  const manifest = await readInstalledManifest();
  const hasTokenizer = manifest.tts.some((row) => row.modelId === QWEN_TOKENIZER_MODEL_ID);
  if (hasTokenizer) return;

  const destDir = path.join(stagingDir(parentJobId), 'tokenizer');
  const result = await downloadHfSnapshot({
    repoId: QWEN_TOKENIZER_MODEL_ID,
    destDir,
    signal,
    onProgress: (bytes, total) => onProgress(bytes, total),
  });
  await publishSnapshot('tts', QWEN_TOKENIZER_MODEL_ID, destDir, 'tokenizer');
  emit(parentJobId, {
    jobId: parentJobId,
    status: 'running',
    bytesReceived: result.bytesReceived,
    totalBytes: result.totalBytes,
    message: 'Tokenizer dependency installed',
  });
}

/**
 * @param {VoiceDownloadJob} job
 */
async function runDownloadJob(job) {
  const controller = new AbortController();
  abortByJob.set(job.id, controller);

  try {
    job.status = 'running';
    await saveJobs();
    emit(job.id, {
      jobId: job.id,
      status: job.status,
      bytesReceived: job.bytesReceived,
      totalBytes: job.totalBytes,
    });
    const repoId =
      job.kind === 'stt' ? resolveSttDownloadRepoId(job.modelId) : job.modelId;
    const result = await downloadHfSnapshot({
      repoId,
      destDir: path.join(stagingDir(job.id), 'model'),
      signal: controller.signal,
      onProgress: (bytes, total) => {
        job.bytesReceived = bytes;
        if (total != null) job.totalBytes = total;
        emit(job.id, {
          jobId: job.id,
          status: job.status,
          bytesReceived: job.bytesReceived,
          totalBytes: job.totalBytes,
        });
      },
    });
    job.bytesReceived = result.bytesReceived;
    job.totalBytes = result.totalBytes;
    if (job.kind === 'tts') {
      const meta = resolveTtsCatalogMeta(job.modelId);
      if (meta.requiresTokenizer) {
        const parentBytes = result.bytesReceived;
        const parentTotal = result.totalBytes;
        await ensureTokenizerDownloaded(job.id, controller.signal, (bytes, total) => {
          job.bytesReceived = parentBytes + bytes;
          if (total != null) {
            job.totalBytes = (parentTotal ?? 0) + total;
          }
          emit(job.id, {
            jobId: job.id,
            status: job.status,
            bytesReceived: job.bytesReceived,
            totalBytes: job.totalBytes,
          });
        });
      }
    }

    controller.signal.throwIfAborted();
    const ttsMode = job.kind === 'tts' ? resolveTtsCatalogMeta(job.modelId).mode : undefined;
    await publishSnapshot(job.kind, job.modelId, path.join(stagingDir(job.id), 'model'), ttsMode);
    job.status = 'completed';
    job.finishedAt = Date.now();
    emit(job.id, {
      jobId: job.id,
      status: job.status,
      bytesReceived: job.bytesReceived,
      totalBytes: job.totalBytes,
    });
  } catch (err) {
    const cancelled = controller.signal.aborted || err?.message === 'Download cancelled';
    job.status = cancelled ? 'cancelled' : 'failed';
    job.error = err instanceof Error ? err.message : String(err);
    job.finishedAt = Date.now();
    emit(job.id, {
      jobId: job.id,
      status: job.status,
      bytesReceived: job.bytesReceived,
      totalBytes: job.totalBytes,
      error: job.error,
    });
  } finally {
    abortByJob.delete(job.id);
    await fsp.rm(stagingDir(job.id), { recursive: true, force: true });
    await saveJobs();
  }
}

/**
 * @param {VoiceDownloadJob} job
 */
function publicJob(job) {
  return {
    id: job.id,
    kind: job.kind,
    modelId: job.modelId,
    status: job.status,
    bytesReceived: job.bytesReceived,
    totalBytes: job.totalBytes,
    destDir: job.destDir,
    error: job.error ?? null,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt ?? null,
  };
}

/**
 * @param {{ modelId: string, kind: VoiceModelKind }} body
 */
export async function startVoiceDownload(body) {
  await loadJobs();
  const kind = validateKind(body.kind);
  const modelId = validateRepoId(String(body.modelId || '').trim());

  const destDir = voiceModelDir(modelId);
  const existing = await withManifest(() => readInstalledManifest({ rebuildFromDisk: true }));
  const list = kind === 'stt' ? existing.stt : existing.tts;
  const already = list.some((row) => row.modelId === modelId);
  if (already) {
    throw new Error(`Model already installed: ${modelId}`);
  }

  if (kind === 'tts' && resolveTtsCatalogMeta(modelId).mode === 'tokenizer') {
    throw new Error('Download a TTS model — the tokenizer is installed automatically when required');
  }

  const downloadRepoId = kind === 'stt' ? resolveSttDownloadRepoId(modelId) : modelId;

  let totalBytes = null;
  try {
    const files = await listRepoFilesRecursive(downloadRepoId);
    const sum = files.reduce((acc, f) => acc + (f.size ?? 0), 0);
    totalBytes = sum > 0 ? sum : null;
  } catch {
    /* size unknown until stream starts */
  }

  if (totalBytes != null) {
    await assertDiskSpace(totalBytes + MIN_FREE_BYTES);
  } else {
    await assertDiskSpace(MIN_FREE_BYTES);
  }

  const active = jobsCache.find(job => job.modelId === modelId && ['queued', 'running'].includes(job.status));
  if (active) return publicJob(active);
  const job = /** @type {VoiceDownloadJob} */ ({
    staged: true,
    id: crypto.randomUUID(),
    kind,
    modelId,
    status: 'queued',
    bytesReceived: 0,
    totalBytes,
    destDir,
    createdAt: Date.now(),
  });

  jobsCache.unshift(job);
  jobsCache = jobsCache.filter((entry, index) => index < 100 || ['running', 'queued'].includes(entry.status));
  try {
    await saveJobs();
  } catch (err) {
    jobsCache = jobsCache.filter(row => row !== job);
    throw err;
  }
  if (job.status === 'cancelled') return publicJob(job);

  const task = runDownloadJob(job).catch(error => {
    console.warn('[voice] Could not persist download job:', error.message);
  }).finally(() => running.delete(task));
  running.add(task);
  return publicJob(job);
}

export async function listVoiceDownloads() {
  await loadJobs();
  return jobsCache.map(publicJob);
}

/**
 * @param {string} jobId
 */
export async function cancelVoiceDownload(jobId) {
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
  if (controller) controller.abort();
  else if (job.status === 'queued') {
    job.status = 'cancelled';
    job.finishedAt = Date.now();
    await saveJobs();
  }
  return publicJob(job);
}

/**
 * @param {string} jobId
 * @param {(event: object) => void} listener
 */
export function subscribeVoiceDownload(jobId, listener) {
  validateJobId(jobId);
  if (!listenersByJob.has(jobId)) listenersByJob.set(jobId, new Set());
  listenersByJob.get(jobId).add(listener);
  const job = findJob(jobId);
  if (job) {
    listener({
      jobId: job.id,
      status: job.status,
      bytesReceived: job.bytesReceived,
      totalBytes: job.totalBytes,
      error: job.error ?? null,
    });
  }
  return () => {
    listenersByJob.get(jobId)?.delete(listener);
  };
}

export async function listInstalledVoiceModels() {
  await loadJobs();
  return withManifest(() => readInstalledManifest({ rebuildFromDisk: true }));
}

/**
 * @param {VoiceModelKind} kind
 * @param {string} modelId
 */
export async function deleteVoiceModel(kind, modelId) {
  await loadJobs();
  return withManifest(() => deleteInstalledModel(kind, modelId));
}

async function deleteInstalledModel(kind, modelId) {
  const normalizedKind = validateKind(kind);
  const normalizedId = validateRepoId(String(modelId || '').trim());
  const manifest = await readInstalledManifest({ rebuildFromDisk: true });
  const list = normalizedKind === 'stt' ? manifest.stt : manifest.tts;
  const entry = list.find((row) => row.modelId === normalizedId);
  if (!entry) {
    throw new Error('Installed model not found');
  }
  await fsp.rm(entry.path, { recursive: true, force: true });
  const next = list.filter((row) => row.modelId !== normalizedId);
  if (normalizedKind === 'stt') manifest.stt = next;
  else manifest.tts = next;
  await writeInstalledManifest(manifest);
  return { ok: true, modelId: normalizedId, kind: normalizedKind };
}

/** Test helper — reset module state. */
export async function resetVoiceDownloadsForTests() {
  await Promise.all(running);
  jobsCache = [];
  loading = undefined;
  abortByJob.clear();
  listenersByJob.clear();
}

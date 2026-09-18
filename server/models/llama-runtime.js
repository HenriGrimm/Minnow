import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { getMinnowHome } from '../config/home.js';
import { runProcess } from '../process-runner.js';
import { getAppRoot } from '../workspace/root.js';
import { parseLlamaListDevices, synthesizeLlamaDevices } from '../../src/models/llama-devices.mjs';
import { detectHardware } from '../system/hardware.js';
import { readLlamaCppConfig } from './llama-args.js';
import {
  detectPreferredLlamaVariant,
  fetchReleaseAssetList,
  isGpuCapableVariant,
  listInstallableVariants,
  resolveLlamaAssets,
} from './llama-variant.js';
import {
  UPSTREAM_ENGINE_ID,
  getForkBinDir,
  getForkDef,
  getForkMetaPath,
  readEngineConfig,
  variantForFork,
} from './llama-forks-catalog.js';

export const LLAMA_CPP_RELEASE_TAG = 'b10448';

const BINARY_BASE = 'llama-server';

/** @type {Promise<string> | null} */
let installPromise = null;

/**
 * @type {Map<string, Promise<boolean>>}
 */
const thinkingBudgetSupportCache = new Map();

/** Cached `--cache-type-k` allowed values, keyed by binary path. */
const cacheTypesCache = new Map();

/** Cached `llama-server --list-devices` rows, keyed by binary path. */
const listDevicesCache = new Map();

/**
 * @typedef {{ phase: 'idle' | 'installing' | 'completed' | 'failed', percent: number, message: string, error: string | null }} LlamaInstallJob
 */

/** @type {LlamaInstallJob | null} */
let installJob = null;

/** @type {Set<(job: LlamaInstallJob) => void>} */
const installListeners = new Set();

const LLAMA_INSTALL_EMIT_MS = 200;
let lastInstallEmitAt = 0;

// ── Install job ──────────────────────────────────────────────────────────────

function emitInstallJob() {
  if (!installJob) return;
  const now = Date.now();
  if (installJob.phase === 'installing' && now - lastInstallEmitAt < LLAMA_INSTALL_EMIT_MS) {
    return;
  }
  lastInstallEmitAt = now;
  for (const listener of installListeners) {
    try {
      listener(installJob);
    } catch {
    }
  }
}

/**
 * @param {Partial<LlamaInstallJob>} patch
 */
function setInstallJob(patch) {
  installJob = {
    phase: installJob?.phase ?? 'idle',
    percent: installJob?.percent ?? 0,
    message: installJob?.message ?? '',
    error: installJob?.error ?? null,
    ...patch,
  };
  emitInstallJob();
}

/** @returns {LlamaInstallJob | null} */
export function getLlamaInstallJob() {
  return installJob;
}

/**
 * @param {(job: LlamaInstallJob) => void} listener
 * @returns {() => void}
 */
export function subscribeLlamaInstallProgress(listener) {
  if (installJob) listener(installJob);
  installListeners.add(listener);
  return () => installListeners.delete(listener);
}

export function resetLlamaInstallJobForTests() {
  installJob = null;
  installListeners.clear();
  installPromise = null;
}

// ── Paths ────────────────────────────────────────────────────────────────────

export function getManagedLlamaRoot() {
  return path.join(getMinnowHome(), 'models-runtime', 'llama-cpp');
}

export function getManagedLlamaMetaPath() {
  return path.join(getManagedLlamaRoot(), 'meta.json');
}

export function getVendorLlamaRoot() {
  return path.join(getAppRoot(), 'vendor', 'llama-cpp');
}

export function binaryFileName() {
  return process.platform === 'win32' ? `${BINARY_BASE}.exe` : BINARY_BASE;
}

/**
 * @param {string} dir
 * @returns {string | null}
 */
export function findBinaryInDir(dir) {
  if (!dir || !fs.existsSync(dir)) return null;
  const direct = path.join(dir, binaryFileName());
  if (fs.existsSync(direct)) return direct;

  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const nested = path.join(dir, ent.name, binaryFileName());
    if (fs.existsSync(nested)) return nested;
  }
  return null;
}

/**
 * @param {string} cmd
 */
async function which(cmd) {
  try {
    if (process.platform === 'win32') {
      const { code, stdout } = await runProcess('where', [cmd], { timeout: 3_000 });
      if (code === 0 && stdout.trim()) return stdout.trim().split(/\r?\n/)[0];
      return null;
    }
    const { code, stdout } = await runProcess('which', [cmd], { timeout: 3_000 });
    if (code === 0 && stdout.trim()) return stdout.trim().split(/\r?\n/)[0];
    return null;
  } catch {
    return null;
  }
}

// ── Resolve ──────────────────────────────────────────────────────────────────

/**
 * Upstream llama.cpp only (PATH → vendor → managed), ignoring the active engine.
 * @returns {Promise<{ path: string | null, source: 'path' | 'vendor' | 'managed' | null }>}
 */
export async function resolveUpstreamLlamaServer() {
  const pathHit = await which(BINARY_BASE);
  if (pathHit && fs.existsSync(pathHit)) {
    return { path: pathHit, source: 'path' };
  }

  const vendorHit = findBinaryInDir(getVendorLlamaRoot());
  if (vendorHit) {
    return { path: vendorHit, source: 'vendor' };
  }

  const managedHit = findBinaryInDir(getManagedLlamaRoot());
  if (managedHit) {
    return { path: managedHit, source: 'managed' };
  }

  return { path: null, source: null };
}

/**
 * The fork row the user selected, or null when upstream is active.
 * @param {Record<string, unknown>} [config]
 */
export async function getActiveLlamaFork(config) {
  const cfg = config ?? (await readLlamaCppConfig());
  const { active } = readEngineConfig(cfg);
  if (active === UPSTREAM_ENGINE_ID) return null;
  return getForkDef(active, cfg);
}

/**
 * Installed binary for a fork: a local fork's own path, else its built `bin/`.
 * @param {import('./llama-forks-catalog.js').ForkDef} fork
 * @returns {string | null}
 */
export function findForkBinary(fork) {
  if (fork.source === 'local') {
    return fork.binaryPath && fs.existsSync(fork.binaryPath) ? fork.binaryPath : null;
  }
  return findBinaryInDir(getForkBinDir(fork.id));
}

/**
 * @param {string} forkId
 * @returns {Promise<Record<string, unknown> | null>}
 */
export async function readForkMeta(forkId) {
  try {
    const meta = JSON.parse(await fsp.readFile(getForkMetaPath(forkId), 'utf8'));
    return meta && typeof meta === 'object' ? meta : null;
  } catch {
    return null;
  }
}

/**
 * Binary the next serve spawns. A selected fork never falls back to upstream:
 * launch settings tuned for its KV types would fail on the stock build.
 * @returns {Promise<{ path: string | null, source: 'path' | 'vendor' | 'managed' | 'fork' | null, engineId: string, reason?: string }>}
 */
export async function resolveLlamaServer() {
  const config = await readLlamaCppConfig();
  const { active } = readEngineConfig(config);
  if (active !== UPSTREAM_ENGINE_ID) {
    const fork = getForkDef(active, config);
    if (!fork) {
      return {
        path: null,
        source: null,
        engineId: active,
        reason: `The selected llama.cpp engine "${active}" no longer exists. Pick another in Models → Engine.`,
      };
    }
    const binary = findForkBinary(fork);
    if (!binary) {
      return {
        path: null,
        source: null,
        engineId: fork.id,
        reason: `${fork.label} is selected but not built yet. Build it in Models → Engine, or switch back to upstream llama.cpp.`,
      };
    }
    return { path: binary, source: 'fork', engineId: fork.id };
  }
  return { ...(await resolveUpstreamLlamaServer()), engineId: UPSTREAM_ENGINE_ID };
}

const PE_MACHINE_AMD64 = 0x8664;
const PE_MACHINE_ARM64 = 0xaa64;

/**
 * @param {string} exePath
 * @returns {number | null}
 */
export function readWindowsPeMachine(exePath) {
  if (process.platform !== 'win32' || !exePath) return null;
  let fd;
  try {
    fd = fs.openSync(exePath, 'r');
    const dos = Buffer.alloc(64);
    if (fs.readSync(fd, dos, 0, 64, 0) < 64) return null;
    if (dos.toString('ascii', 0, 2) !== 'MZ') return null;
    const peOff = dos.readUInt32LE(60);
    const pe = Buffer.alloc(6);
    if (fs.readSync(fd, pe, 0, 6, peOff) < 6) return null;
    if (pe.toString('ascii', 0, 4) !== 'PE\0\0') return null;
    return pe.readUInt16LE(4);
  } catch {
    return null;
  } finally {
    if (fd != null) fs.closeSync(fd);
  }
}

/**
 * @param {string | null | undefined} exePath
 */
export function llamaServerPeArchMismatch(exePath) {
  const machine = readWindowsPeMachine(exePath);
  if (machine == null) return false;
  const want = process.arch === 'arm64' ? PE_MACHINE_ARM64 : PE_MACHINE_AMD64;
  return machine !== want;
}

/**
 * @param {string} exePath
 */
export function assertLlamaServerMatchesHostArch(exePath) {
  if (!llamaServerPeArchMismatch(exePath)) return;
  const machine = readWindowsPeMachine(exePath);
  const got =
    machine === PE_MACHINE_ARM64 ? 'arm64' : machine === PE_MACHINE_AMD64 ? 'x64' : `0x${machine.toString(16)}`;
  const need = process.arch === 'arm64' ? 'arm64' : 'x64';
  throw new Error(
    `Installed llama-server.exe is ${got}, but this Minnow host is ${need}. Reinstall llama.cpp from Models → Engine.`,
  );
}

// ── Release ──────────────────────────────────────────────────────────────────

export function isLlamaRuntimeInstallable() {
  const { platform, arch } = process;
  if (platform === 'win32') return arch === 'x64' || arch === 'arm64';
  if (platform === 'darwin') return arch === 'x64' || arch === 'arm64';
  if (platform === 'linux') return arch === 'x64' || arch === 'arm64';
  return false;
}

/**
 * @returns {string}
 */
export function pickLlamaReleaseAssetName(tag = LLAMA_CPP_RELEASE_TAG) {
  const { platform, arch } = process;
  if (platform === 'win32') {
    return arch === 'arm64'
      ? `llama-${tag}-bin-win-cpu-arm64.zip`
      : `llama-${tag}-bin-win-cpu-x64.zip`;
  }
  if (platform === 'darwin') {
    return arch === 'arm64'
      ? `llama-${tag}-bin-macos-arm64.tar.gz`
      : `llama-${tag}-bin-macos-x64.tar.gz`;
  }
  if (platform === 'linux') {
    return arch === 'arm64'
      ? `llama-${tag}-bin-ubuntu-arm64.tar.gz`
      : `llama-${tag}-bin-ubuntu-x64.tar.gz`;
  }
  throw new Error(`Unsupported platform for bundled llama-server: ${platform} ${arch}`);
}

/**
 * @param {string | null | undefined} a
 * @param {string | null | undefined} b
 * @returns {boolean}
 */
export function llamaReleaseTagsEqual(a, b) {
  if (a == null || b == null) return false;
  const left = normalizeLlamaReleaseTag(String(a));
  const right = normalizeLlamaReleaseTag(String(b));
  if (left.build != null && right.build != null) return left.build === right.build;
  return left.raw === right.raw;
}

/**
 * @param {string} tag
 * @returns {{ raw: string, build: number | null }}
 */
function normalizeLlamaReleaseTag(tag) {
  const raw = tag.trim();
  const stripped = raw.replace(/^b/i, '');
  if (/^\d+$/.test(stripped)) {
    return { raw, build: Number.parseInt(stripped, 10) };
  }
  return { raw, build: null };
}

/**
 * @returns {Promise<Record<string, unknown> | null>}
 */
async function readManagedLlamaMeta() {
  try {
    const meta = JSON.parse(await fsp.readFile(getManagedLlamaMetaPath(), 'utf8'));
    return meta && typeof meta === 'object' ? meta : null;
  } catch {
    return null;
  }
}

/**
 * @returns {Promise<string | null>}
 */
export async function getInstalledLlamaVariant() {
  const fork = await getActiveLlamaFork();
  if (fork) return variantForFork(fork);
  const meta = await readManagedLlamaMeta();
  return typeof meta?.variant === 'string' ? meta.variant : null;
}

export async function getLlamaRuntimeStatus() {
  const resolved = await resolveLlamaServer();
  const activeFork = await getActiveLlamaFork();
  const meta = await readManagedLlamaMeta();
  const installedVersion = typeof meta?.version === 'string' ? meta.version : null;
  const pinnedVersion = LLAMA_CPP_RELEASE_TAG;
  const managedBinary = findBinaryInDir(getManagedLlamaRoot());
  const managedInstallExists = Boolean(managedBinary);
  const upgradeAvailable =
    managedInstallExists &&
    ((installedVersion != null && !llamaReleaseTagsEqual(installedVersion, pinnedVersion)) ||
      llamaServerPeArchMismatch(managedBinary));

  const assets = await fetchReleaseAssetList();
  const installableVariants = listInstallableVariants(assets);
  const preferredVariant = await detectPreferredLlamaVariant(undefined, assets);
  const config = await readLlamaCppConfig();
  const variant =
    (typeof config.variant === 'string' ? config.variant : null) ??
    (typeof meta?.variant === 'string' ? meta.variant : null) ??
    preferredVariant;

  const forkVariant = activeFork ? variantForFork(activeFork) : null;
  const activeVariant = forkVariant ?? variant;

  return {
    path: resolved.path,
    source: resolved.source,
    engineId: resolved.engineId,
    engineLabel: activeFork?.label ?? 'llama.cpp',
    engineReason: resolved.reason ?? null,
    variant:
      forkVariant ??
      (typeof meta?.variant === 'string' ? meta.variant : null) ??
      (resolved.path ? variant : preferredVariant),
    version: installedVersion ?? pinnedVersion,
    pinnedVersion,
    installedVersion,
    upgradeAvailable,
    assetNames: Array.isArray(meta?.assetNames) ? meta.assetNames : [],
    installedAt: typeof meta?.installedAt === 'string' ? meta.installedAt : null,
    installable: isLlamaRuntimeInstallable(),
    gpuCapable: isGpuCapableVariant(
      forkVariant ?? (typeof meta?.variant === 'string' ? meta.variant : null) ?? preferredVariant,
    ),
    preferredVariant,
    installableVariants,
    loadRateBytesPerMs: readLoadRateForVariant(config, activeVariant),
    devices: await listLlamaGpuDevices(resolved.path, activeVariant),
    kvCacheTypes: await detectLlamaCacheTypes(resolved.path),
    asymmetricKv: activeFork?.asymmetricKv === true,
  };
}

/**
 * @param {{ loadRate?: unknown }} config
 * @param {string | null | undefined} variant
 * @returns {number | null}
 */
function readLoadRateForVariant(config, variant) {
  const table = config?.loadRate;
  if (!table || typeof table !== 'object' || !variant) return null;
  const value = Number(/** @type {Record<string, unknown>} */ (table)[variant]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * @param {string} url
 * @param {string} dest
 * @param {(pct: number) => void} [onProgress]
 */
export async function downloadToFile(url, dest, onProgress) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'minnow-llama-runtime' },
  });
  if (!res.ok) {
    throw new Error(`Download failed: HTTP ${res.status}`);
  }
  const total = Number(res.headers.get('content-length') || 0);
  let received = 0;
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const file = fs.createWriteStream(dest);
  const body = res.body;
  if (!body) {
    throw new Error('Empty response body');
  }
  for await (const chunk of body) {
    received += chunk.length;
    file.write(chunk);
    if (total > 0 && onProgress) {
      onProgress(Math.min(95, Math.round((received / total) * 90) + 5));
    }
  }
  await new Promise((resolve, reject) => {
    file.end(() => resolve());
    file.on('error', reject);
  });
}

/**
 * @param {string} filePath
 */
async function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const stream = fs.createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest('hex');
}

/**
 * @param {string | Buffer | Uint8Array} filePathOrBuffer
 * @param {string | null | undefined} digest
 */
export async function assertArchiveDigest(filePathOrBuffer, digest) {
  const raw = typeof digest === 'string' ? digest.trim() : '';
  if (!raw) {
    return;
  }
  const expected = raw.replace(/^sha256:/i, '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expected)) {
    throw new Error(`Unrecognized llama.cpp archive digest: ${raw}`);
  }
  const actual =
    typeof filePathOrBuffer === 'string'
      ? await sha256File(filePathOrBuffer)
      : crypto.createHash('sha256').update(filePathOrBuffer).digest('hex');
  if (actual !== expected) {
    throw new Error(
      `llama.cpp archive sha256 mismatch (expected ${expected}, got ${actual}) — not extracting`,
    );
  }
}

/**
 * @param {string} archivePath
 * @param {string} destDir
 */
/**
 * Windows' own bsdtar reads zip; a GNU tar earlier on PATH (Git for Windows, MSYS) cannot.
 */
function tarCommand() {
  if (process.platform === 'win32') {
    const systemTar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    if (fs.existsSync(systemTar)) return systemTar;
  }
  return 'tar';
}

/**
 * @param {string[]} args
 * @param {string} [cwd]
 */
async function runTar(args, cwd) {
  const result = await runProcess(tarCommand(), args, { cwd, timeout: 10 * 60_000 });
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim().split(/\r?\n/).slice(-2).join(' ');
    throw new Error(`Could not extract archive (tar exited ${result.code})${detail ? `: ${detail}` : ''}`);
  }
}

export async function extractArchive(archivePath, destDir) {
  await fsp.mkdir(destDir, { recursive: true });
  if (archivePath.endsWith('.zip')) {
    await runTar(['-xf', archivePath, '-C', destDir], destDir);
    return;
  }
  if (archivePath.endsWith('.gz') && !archivePath.endsWith('.tar.gz')) {
    const outPath = path.join(destDir, path.basename(archivePath, '.gz'));
    await pipeline(
      fs.createReadStream(archivePath),
      createGunzip(),
      fs.createWriteStream(outPath),
    );
    return;
  }
  await runTar(['-xf', archivePath, '-C', destDir]);
}

/**
 * @param {string} extractDir
 * @param {string} managedRoot
 */
export async function copyFlattenedExtractContents(extractDir, managedRoot) {
  await fsp.mkdir(managedRoot, { recursive: true });

  async function walk(dir) {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        await walk(full);
      } else {
        await fsp.copyFile(full, path.join(managedRoot, ent.name));
      }
    }
  }

  await walk(extractDir);
}

/**
 * @param {string} extractDir
 * @param {string} managedRoot
 */
export async function copyExtractedBinaries(extractDir, managedRoot) {
  const found = await findExtractedBinary(extractDir);
  if (!found) {
    throw new Error('llama-server not found inside archive');
  }

  const binDir = path.dirname(found);
  const entries = await fsp.readdir(binDir, { withFileTypes: true });
  for (const ent of entries) {
    const src = path.join(binDir, ent.name);
    const dest = path.join(managedRoot, ent.name);
    if (ent.isDirectory()) {
      await fsp.cp(src, dest, { recursive: true });
    } else {
      await fsp.copyFile(src, dest);
      if (process.platform !== 'win32' && ent.name === BINARY_BASE) {
        await fsp.chmod(dest, 0o755);
      }
    }
  }
}

/**
 * @param {string} searchDir
 */
export async function findExtractedBinary(searchDir) {
  const wanted = binaryFileName();
  async function walk(dir) {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        const hit = await walk(full);
        if (hit) return hit;
      } else if (ent.name === wanted || ent.name === BINARY_BASE) {
        return full;
      }
    }
    return null;
  }
  return walk(searchDir);
}

// ── Install ──────────────────────────────────────────────────────────────────

/**
 * @param {{ variant?: string, tag?: string, reinstall?: boolean, onProgress?: (patch: { percent: number, message: string }) => void }} [opts]
 * @returns {Promise<string>}
 */
export async function ensureLlamaServer(opts = {}) {
  const resolved = await resolveUpstreamLlamaServer();
  const installedVariant = await getInstalledLlamaVariant();
  const config = await readLlamaCppConfig();
  const wantsVariant = opts.variant ?? config.variant;

  if (resolved.path && !opts.reinstall) {
    const variantOk = !wantsVariant || wantsVariant === installedVariant;
    if (variantOk) {
      const meta = await readManagedLlamaMeta();
      const installedVersion = typeof meta?.version === 'string' ? meta.version : null;
      const pinnedVersion = opts.tag ?? LLAMA_CPP_RELEASE_TAG;
      const versionDrift =
        Boolean(installedVersion) && !llamaReleaseTagsEqual(installedVersion, pinnedVersion);
      if (versionDrift) {
        return resolved.path;
      }
      return resolved.path;
    }
  }

  if (!isLlamaRuntimeInstallable()) {
    throw new Error(
      'llama-server not found — install llama.cpp server binaries or use Ollama/LM Studio',
    );
  }

  if (!installPromise) {
    installPromise = installManagedLlamaServer(opts).finally(() => {
      installPromise = null;
    });
  }
  return installPromise;
}

/**
 * @param {{ variant?: string, tag?: string, reinstall?: boolean, onProgress?: (patch: { percent: number, message: string }) => void }} opts
 */
async function installManagedLlamaServer(opts) {
  const onProgress = (patch) => {
    setInstallJob({
      phase: 'installing',
      percent: patch.percent,
      message: patch.message,
      error: null,
    });
    opts.onProgress?.(patch);
  };
  setInstallJob({ phase: 'installing', percent: 0, message: 'Starting install', error: null });
  const tag = opts.tag ?? LLAMA_CPP_RELEASE_TAG;
  const config = await readLlamaCppConfig();
  const assets = await fetchReleaseAssetList(tag);
  const variant =
    opts.variant ??
    config.variant ??
    (await detectPreferredLlamaVariant(undefined, assets));

  const { mainZip, companionZip, assetNames } = resolveLlamaAssets({
    variant,
    tag,
    assets,
  });

  onProgress({ percent: 2, message: `Resolving llama.cpp ${tag} (${variant})` });

  // Reuse the asset list from fetchReleaseAssetList (API or HTML fallback) —
  // do not hit api.github.com a second time (rate-limit sensitive).
  const assetByName = new Map(assets.map((a) => [a.name, a]));
  const mainAsset = assetByName.get(mainZip);
  if (!mainAsset?.browser_download_url) {
    throw new Error(`No llama.cpp release asset ${mainZip}`);
  }

  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'minnow-llama-'));
  const managedRoot = getManagedLlamaRoot();

  try {
    onProgress({ percent: 5, message: `Downloading ${mainZip}` });
    const mainArchivePath = path.join(tmpRoot, mainZip);
    await downloadToFile(mainAsset.browser_download_url, mainArchivePath, (pct) => {
      onProgress({ percent: pct, message: `Downloading ${mainZip}` });
    });
    await assertArchiveDigest(mainArchivePath, mainAsset.digest);

    if (companionZip) {
      const companionAsset = assetByName.get(companionZip);
      if (companionAsset?.browser_download_url) {
        onProgress({ percent: 50, message: `Downloading ${companionZip}` });
        const companionPath = path.join(tmpRoot, companionZip);
        await downloadToFile(companionAsset.browser_download_url, companionPath);
        await assertArchiveDigest(companionPath, companionAsset.digest);
        onProgress({ percent: 70, message: 'Extracting CUDA runtime' });
        const companionExtract = path.join(tmpRoot, 'companion');
        await extractArchive(companionPath, companionExtract);
        await fsp.rm(managedRoot, { recursive: true, force: true });
        await fsp.mkdir(managedRoot, { recursive: true });
        await copyFlattenedExtractContents(companionExtract, managedRoot);
      }
    }

    onProgress({ percent: 85, message: 'Extracting llama-server' });
    if (!companionZip) {
      await fsp.rm(managedRoot, { recursive: true, force: true });
      await fsp.mkdir(managedRoot, { recursive: true });
    }
    const extractDir = path.join(tmpRoot, 'extract');
    await extractArchive(mainArchivePath, extractDir);
    await copyExtractedBinaries(extractDir, managedRoot);

    const installed = findBinaryInDir(managedRoot);
    if (!installed) {
      throw new Error('llama-server install completed but binary is missing');
    }
    assertLlamaServerMatchesHostArch(installed);

    await fsp.writeFile(
      getManagedLlamaMetaPath(),
      `${JSON.stringify(
        {
          version: tag,
          variant,
          assetNames,
          installedAt: new Date().toISOString(),
          path: installed,
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    clearLlamaBinaryProbeCaches();

    onProgress({ percent: 100, message: 'llama-server ready' });
    setInstallJob({ phase: 'completed', percent: 100, message: 'llama-server ready', error: null });
    return installed;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    setInstallJob({ phase: 'failed', percent: 0, message, error: message });
    throw err;
  } finally {
    await fsp.rm(tmpRoot, { recursive: true, force: true });
  }
}

// ── Spawn ────────────────────────────────────────────────────────────────────

/**
 * @param {string} binaryPath
 */
export function llamaServerSpawnCwd(binaryPath) {
  return path.dirname(binaryPath);
}

/**
 * @param {string} binaryPath
 * @param {NodeJS.ProcessEnv} [baseEnv]
 */
export function buildLlamaServerEnv(binaryPath, baseEnv = process.env) {
  const pathKey = process.platform === 'win32' ? 'Path' : 'PATH';
  const binDir = path.dirname(binaryPath);
  const existing = baseEnv[pathKey] ?? process.env[pathKey] ?? '';
  return {
    ...baseEnv,
    [pathKey]: existing ? `${binDir}${path.delimiter}${existing}` : binDir,
  };
}

export function resetLlamaRuntimeInstallForTests() {
  installPromise = null;
  clearLlamaBinaryProbeCaches();
}

/** Forget `--help` / `--list-devices` probes after a binary is replaced. */
export function clearLlamaBinaryProbeCaches() {
  thinkingBudgetSupportCache.clear();
  listDevicesCache.clear();
  cacheTypesCache.clear();
}

/**
 * GPU ids llama.cpp will accept on `--device`. Prefers `--list-devices`; falls
 * back to hardware.gpus synthesized as CUDA0 / Vulkan0 / …
 *
 * @param {string | null | undefined} binaryPath
 * @param {string | null | undefined} [variant]
 */
export async function listLlamaGpuDevices(binaryPath, variant) {
  const key = binaryPath || `__synth:${variant || 'cpu'}`;
  const cached = listDevicesCache.get(key);
  if (cached) return cached;

  const probe = (async () => {
    if (binaryPath) {
      try {
        const result = await runProcess(binaryPath, ['--list-devices'], { timeout: 15_000 });
        const parsed = parseLlamaListDevices(`${result.stdout}\n${result.stderr}`);
        if (parsed.length) return parsed;
      } catch {
        /* binary missing or flag unsupported */
      }
    }
    const hardware = await detectHardware();
    return synthesizeLlamaDevices(hardware, variant || hardware?.backend);
  })();

  listDevicesCache.set(key, probe);
  return probe;
}

export function resetLlamaDeviceListCacheForTests() {
  listDevicesCache.clear();
}

export async function detectLlamaThinkingBudgetSupport(binaryPath) {
  if (!binaryPath) return false;
  const cached = thinkingBudgetSupportCache.get(binaryPath);
  if (cached) return cached;

  const probe = (async () => {
    try {
      const result = await runProcess(binaryPath, ['--help'], { timeout: 15_000 });
      const helpText = `${result.stdout}\n${result.stderr}`;
      return /--reasoning-budget/.test(helpText);
    } catch {
      return false;
    }
  })();
  thinkingBudgetSupportCache.set(binaryPath, probe);
  return probe;
}

/**
 * `--cache-type-k` "allowed values" from `llama-server --help`. Forks add types
 * here (turbo3's turbo2/3/4), so the inspector learns them without a catalog entry.
 * @param {string} helpText
 * @returns {string[]}
 */
export function parseLlamaCacheTypes(helpText) {
  const text = String(helpText ?? '');
  const at = text.search(/--cache-type-k\b/);
  if (at < 0) return [];
  // The list wraps: continuation lines follow until the "(default: …)" line.
  const match = text.slice(at, at + 1200).match(/allowed values:\s*([^(]+)/i);
  if (!match) return [];
  return match[1]
    .split(/[,\r\n]/)
    .map((t) => t.trim())
    .filter((t) => /^[a-z0-9][a-z0-9_.]{0,23}$/i.test(t));
}

/**
 * @param {string | null | undefined} binaryPath
 * @returns {Promise<string[]>}
 */
export async function detectLlamaCacheTypes(binaryPath) {
  if (!binaryPath) return [];
  const cached = cacheTypesCache.get(binaryPath);
  if (cached) return cached;
  const probe = (async () => {
    try {
      const result = await runProcess(binaryPath, ['--help'], { timeout: 15_000 });
      return parseLlamaCacheTypes(`${result.stdout}\n${result.stderr}`);
    } catch {
      return [];
    }
  })();
  cacheTypesCache.set(binaryPath, probe);
  return probe;
}

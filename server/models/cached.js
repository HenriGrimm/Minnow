import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getModelsConfig } from './models-config.js';
import { getModelsRoot, repoDownloadDir } from './paths.js';
import { scanInstalledArtifacts } from './installed.js';
import { contextLengthFromTransformersConfig } from './mlx-context-length.js';
import { getMinnowHome } from '../config/home.js';

const CUSTOM_DIR_SKIP_NAMES = new Set(['blobs', 'manifests']);

const BLOCKED_ROOTS = ['/sys', '/proc', '/dev', '/run', '/var/run'];

/**
 * @typedef {object} CachedGgufFile
 * @property {string} name
 * @property {string} rel_path
 * @property {number} size_bytes
 * @property {string} role
 * @property {string} quant
 * @property {boolean} [split]
 * @property {number} [parts]
 */

/**
 * @typedef {object} CachedModelRow
 * @property {string} repo_id
 * @property {number} size_bytes
 * @property {number} nb_files
 * @property {boolean} has_incomplete
 * @property {string} path
 * @property {boolean} [is_gguf]
 * @property {boolean} [is_ollama]
 * @property {boolean} [is_local_dir]
 * @property {boolean} [is_diffusion]
 * @property {string} [backend]
 * @property {CachedGgufFile[]} [gguf_files]
 * @property {string} [mlx_root]
 * @property {string} [mlx_quant]
 * @property {number} [mlx_context_length]
 * @property {string} [status]
 */

// ── MLX detect ───────────────────────────────────────────────────────────────

/**
 * @param {string} dir
 * @param {string} repoId
 * @returns {Promise<{ root: string, quant: string, contextLength?: number } | null>}
 */
async function detectMlxRepo(dir, repoId) {
  let hasSafetensors = false;
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    hasSafetensors = entries.some(
      (e) => e.isFile() && e.name.toLowerCase().endsWith('.safetensors'),
    );
  } catch {
    return null;
  }
  if (!hasSafetensors) return null;

  /** @type {Record<string, unknown> | null} */
  let config = null;
  try {
    config = JSON.parse(await fsp.readFile(path.join(dir, 'config.json'), 'utf8'));
  } catch {
    return null;
  }
  if (!config || typeof config !== 'object') return null;

  const contextLength = contextLengthFromTransformersConfig(config);

  const quantization = /** @type {Record<string, unknown> | undefined} */ (config.quantization);
  const quantConfig = /** @type {Record<string, unknown> | undefined} */ (
    config.quantization_config
  );

  let bits = NaN;
  if (
    quantization &&
    typeof quantization === 'object' &&
    Number.isFinite(Number(quantization.bits)) &&
    Number.isFinite(Number(quantization.group_size))
  ) {
    bits = Number(quantization.bits);
  } else if (quantConfig && typeof quantConfig === 'object') {
    const method = String(quantConfig.quant_method ?? '').toLowerCase();
    if (!method || method === 'mlx') {
      bits = Number(quantConfig.bits);
    }
  }
  if (Number.isFinite(bits) && bits > 0) {
    return {
      root: dir,
      quant: `mlx-${bits}bit`,
      ...(contextLength !== undefined ? { contextLength } : {}),
    };
  }

  if (/(^|[-_/])mlx([-_/]|$)/i.test(repoId)) {
    const named = /(\d+)\s*bit/i.exec(repoId);
    return {
      root: dir,
      quant: named ? `mlx-${named[1]}bit` : 'mlx',
      ...(contextLength !== undefined ? { contextLength } : {}),
    };
  }

  return null;
}

/**
 * @param {{ root: string, quant: string, contextLength?: number }} mlx
 */
function mlxRowFields(mlx) {
  return {
    mlx_root: mlx.root,
    mlx_quant: mlx.quant,
    ...(typeof mlx.contextLength === 'number' && mlx.contextLength > 0
      ? { mlx_context_length: mlx.contextLength }
      : {}),
  };
}

/**
 * @param {string} p
 */
function safePath(p) {
  try {
    const rp = path.resolve(p);
    return !BLOCKED_ROOTS.some((b) => rp === b || rp.startsWith(`${b}${path.sep}`));
  } catch {
    return false;
  }
}

// ── Cache paths ──────────────────────────────────────────────────────────────

/**
 * @returns {string[]}
 */
export function hfCachePaths() {
  const candidates = [];
  const add = (p) => {
    if (!p) return;
    const expanded = p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
    if (!candidates.includes(expanded)) candidates.push(expanded);
  };

  add(process.env.HF_HUB_CACHE);
  add(process.env.HUGGINGFACE_HUB_CACHE);
  const hfHome = process.env.HF_HOME;
  if (hfHome) add(path.join(hfHome, 'hub'));
  add(path.join(os.homedir(), '.cache', 'huggingface', 'hub'));
  if (process.platform === 'win32') {
    add(path.join(os.homedir(), '.cache', 'huggingface', 'hub'));
  }
  return candidates;
}

/**
 * @param {string | undefined} raw
 * @returns {string}
 */
function expandHubCachePath(raw) {
  if (!raw?.trim()) return '';
  const trimmed = raw.trim();
  return trimmed.startsWith('~') ? path.join(os.homedir(), trimmed.slice(1)) : trimmed;
}

/**
 * @returns {string}
 */
export function resolveHfHubCacheDir() {
  const explicit =
    expandHubCachePath(process.env.HF_HUB_CACHE) ||
    expandHubCachePath(process.env.HUGGINGFACE_HUB_CACHE);
  if (explicit) return explicit;

  for (const candidate of hfCachePaths()) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
    }
  }

  return path.join(os.homedir(), '.cache', 'huggingface', 'hub');
}

/**
 * @param {string} [dir]
 * @returns {Promise<string>}
 */
export async function ensureHfHubCacheDir(dir = resolveHfHubCacheDir()) {
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

/**
 * @param {string} name
 */
function ggufQuant(name) {
  const m = name.match(/(?:UD-)?(IQ\d+_[A-Z0-9_]+|Q\d(?:_[A-Z0-9]+)+|BF16|F16|FP16|F32|Q8_0)/i);
  return m ? m[0].toUpperCase() : '';
}

/**
 * @param {string} name
 */
function ggufRole(name) {
  const n = name.toLowerCase();
  if (n.startsWith('mmproj') || n.includes('mmproj')) return 'projector';
  return 'model';
}

// ── Scan ─────────────────────────────────────────────────────────────────────

/**
 * @param {string} base
 * @returns {Promise<CachedGgufFile[]>}
 */
async function collectGgufs(base) {
  if (!safePath(base)) return [];
  const files = [];
  const splitGroups = new Map();

  async function walk(dir) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (safePath(full)) await walk(full);
        continue;
      }
      if (!entry.name.toLowerCase().endsWith('.gguf')) continue;
      if (entry.name.startsWith('._')) continue;

      let size = 0;
      try {
        const stat = await fsp.stat(full);
        size = stat.size;
      } catch {
      }

      let rel = entry.name;
      try {
        rel = path.relative(base, full).split(path.sep).join('/');
      } catch {
      }

      const splitMatch = entry.name.match(/^(.+)-(\d+)-of-(\d+)\.gguf$/i);
      if (splitMatch) {
        const [, prefix, partS, totalS] = splitMatch;
        const key = `${dir}\0${prefix}\0${totalS}`;
        let g = splitGroups.get(key);
        if (!g) {
          g = {
            name: entry.name,
            rel_path: rel,
            size_bytes: 0,
            role: ggufRole(entry.name),
            quant: ggufQuant(entry.name),
            parts: Number(totalS),
            split: true,
          };
          splitGroups.set(key, g);
        }
        g.size_bytes += size;
        if (Number(partS) === 1) {
          g.name = entry.name;
          g.rel_path = rel;
          g.role = ggufRole(entry.name);
          g.quant = ggufQuant(entry.name);
        }
        continue;
      }

      files.push({
        name: entry.name,
        rel_path: rel,
        size_bytes: size,
        role: ggufRole(entry.name),
        quant: ggufQuant(entry.name),
      });
    }
  }

  try {
    const stat = await fsp.stat(base);
    if (!stat.isDirectory()) return [];
  } catch {
    return [];
  }

  await walk(base);
  files.push(...splitGroups.values());
  files.sort((a, b) => {
    const ar = a.role !== 'model' ? 1 : 0;
    const br = b.role !== 'model' ? 1 : 0;
    if (ar !== br) return ar - br;
    return (a.rel_path || '').localeCompare(b.rel_path || '');
  });
  return files;
}

/**
 * @param {string} cache
 * @param {Set<string>} seen
 * @returns {Promise<CachedModelRow[]>}
 */
async function scanHfCache(cache, seen) {
  const out = [];
  let entries;
  try {
    entries = await fsp.readdir(cache, { withFileTypes: true });
  } catch {
    return out;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('models--')) continue;
    const repoId = entry.name.replace(/^models--/, '').replace(/--/g, '/');
    if (seen.has(repoId)) continue;
    seen.add(repoId);

    const blobs = path.join(cache, entry.name, 'blobs');
    const snap = path.join(cache, entry.name, 'snapshots');
    let sizeBytes = 0;
    let nbFiles = 0;
    let hasIncomplete = false;

    async function tallyDir(dir) {
      let items;
      try {
        items = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const item of items) {
        if (!item.isFile()) continue;
        nbFiles += 1;
        if (item.name.endsWith('.incomplete')) hasIncomplete = true;
        try {
          const stat = await fsp.stat(path.join(dir, item.name));
          sizeBytes += stat.size;
        } catch {
        }
      }
    }

    await tallyDir(blobs);
    if (sizeBytes === 0) {
      let snapDirs;
      try {
        snapDirs = await fsp.readdir(snap, { withFileTypes: true });
      } catch {
        snapDirs = [];
      }
      for (const sd of snapDirs) {
        if (!sd.isDirectory()) continue;
        await tallyDir(path.join(snap, sd.name));
      }
    }

    let isDiffusion = false;
    /** @type {{ root: string, quant: string } | null} */
    let mlx = null;
    /** @type {CachedGgufFile[]} */
    const ggufFiles = [];
    let snapDirs;
    try {
      snapDirs = await fsp.readdir(snap, { withFileTypes: true });
    } catch {
      snapDirs = [];
    }
    for (const sd of snapDirs) {
      if (!sd.isDirectory()) continue;
      const sf = path.join(snap, sd.name);
      try {
        await fsp.access(path.join(sf, 'model_index.json'));
        isDiffusion = true;
      } catch {
      }
      if (!mlx) mlx = await detectMlxRepo(sf, repoId);
      const found = await collectGgufs(sf);
      for (const f of found) {
        ggufFiles.push({ ...f, rel_path: `${sd.name}/${f.rel_path}` });
      }
    }

    out.push({
      repo_id: repoId,
      size_bytes: sizeBytes,
      nb_files: nbFiles,
      has_incomplete: hasIncomplete,
      path: cache,
      is_diffusion: isDiffusion,
      is_gguf: ggufFiles.length > 0,
      gguf_files: ggufFiles,
      ...(mlx ? mlxRowFields(mlx) : {}),
      status: hasIncomplete ? 'incomplete' : 'cached',
    });
  }

  return out;
}

/**
 * @param {string} dirPath
 * @param {Set<string>} seen
 */
async function scanCustomDir(dirPath, seen) {
  const out = [];
  const expanded = dirPath.startsWith('~')
    ? path.join(os.homedir(), dirPath.slice(1))
    : path.resolve(dirPath);
  if (!safePath(expanded)) return out;

  let entries;
  try {
    entries = await fsp.readdir(expanded, { withFileTypes: true });
  } catch {
    return out;
  }

  for (const entry of entries) {
    if (
      !entry.isDirectory() ||
      entry.name.startsWith('.') ||
      entry.name.startsWith('models--') ||
      CUSTOM_DIR_SKIP_NAMES.has(entry.name)
    ) {
      continue;
    }

    const publisherRoot = path.join(expanded, entry.name);
    let children;
    try {
      children = await fsp.readdir(publisherRoot, { withFileTypes: true });
    } catch {
      continue;
    }

    const subdirs = children.filter(
      (c) =>
        c.isDirectory() &&
        !c.name.startsWith('.') &&
        !c.name.startsWith('models--') &&
        !CUSTOM_DIR_SKIP_NAMES.has(c.name),
    );

    /** @type {Array<{ repoId: string, modelRoot: string }>} */
    const modelRoots = [];
    let nestedEmitted = false;

    for (const sub of subdirs) {
      const modelRoot = path.join(publisherRoot, sub.name);
      const ggufFiles = await collectGgufs(modelRoot);
      let isModel = ggufFiles.length > 0;
      if (!isModel) {
        isModel = await dirLooksLikeModel(modelRoot);
      }
      if (!isModel) continue;
      nestedEmitted = true;
      modelRoots.push({ repoId: `${entry.name}/${sub.name}`, modelRoot });
    }

    if (!nestedEmitted) {
      const ggufFiles = await collectGgufs(publisherRoot);
      let isModel = ggufFiles.length > 0;
      if (!isModel) {
        isModel = await dirLooksLikeModel(publisherRoot);
      }
      if (isModel) {
        modelRoots.push({ repoId: entry.name, modelRoot: publisherRoot });
      }
    }

    for (const { repoId, modelRoot } of modelRoots) {
      if (seen.has(repoId)) continue;

      const ggufFiles = await collectGgufs(modelRoot);
      let sizeBytes = 0;
      let nbFiles = 0;
      await walkCount(modelRoot, (sz) => {
        nbFiles += 1;
        sizeBytes += sz;
      });

      let isDiffusion = false;
      try {
        await fsp.access(path.join(modelRoot, 'model_index.json'));
        isDiffusion = true;
      } catch {
      }
      const mlx = await detectMlxRepo(modelRoot, repoId);

      seen.add(repoId);
      out.push({
        repo_id: repoId,
        size_bytes: sizeBytes,
        nb_files: nbFiles,
        has_incomplete: false,
        path: modelRoot,
        is_local_dir: true,
        is_diffusion: isDiffusion,
        is_gguf: ggufFiles.length > 0,
        gguf_files: ggufFiles,
        ...(mlx ? mlxRowFields(mlx) : {}),
        status: 'local',
      });
    }
  }

  return out;
}

/**
 * @param {string} dir
 */
async function dirLooksLikeModel(dir) {
  async function walk(d) {
    let entries;
    try {
      entries = await fsp.readdir(d, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of entries) {
      const full = path.join(d, entry.name);
      if (entry.isFile()) {
        const lower = entry.name.toLowerCase();
        if (
          lower.endsWith('.gguf') ||
          entry.name === 'config.json' ||
          lower.endsWith('.safetensors') ||
          lower.endsWith('.bin')
        ) {
          return true;
        }
      } else if (entry.isDirectory() && safePath(full)) {
        if (await walk(full)) return true;
      }
    }
    return false;
  }
  return walk(dir);
}

/**
 * @param {string} dir
 * @param {(size: number) => void} onFile
 */
async function walkCount(dir, onFile) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (safePath(full)) await walkCount(full, onFile);
      continue;
    }
    try {
      const stat = await fsp.stat(full);
      onFile(stat.size);
    } catch {
    }
  }
}

/**
 * @param {Set<string>} seen
 */
async function scanMinnowArtifacts(seen) {
  const artifacts = await scanInstalledArtifacts({ includeCustomDirs: false });
  /** @type {Map<string, CachedModelRow>} */
  const byRepo = new Map();

  for (const art of artifacts) {
    let row = byRepo.get(art.repoId);
    if (!row) {
      if (seen.has(art.repoId)) continue;
      row = {
        repo_id: art.repoId,
        size_bytes: 0,
        nb_files: 0,
        has_incomplete: false,
        path: repoDownloadDir(art.repoId),
        is_gguf: true,
        gguf_files: [],
        status: 'downloaded',
      };
      byRepo.set(art.repoId, row);
      seen.add(art.repoId);
    }
    row.size_bytes += art.sizeBytes;
    row.nb_files += 1;
    const relPath = path.relative(row.path, art.path).split(path.sep).join('/') || art.filename;
    row.gguf_files.push({
      name: art.filename,
      rel_path: relPath,
      size_bytes: art.sizeBytes,
      role: ggufRole(art.filename),
      quant: ggufQuant(art.filename),
    });
  }

  return [...byRepo.values()];
}

/**
 * @param {Set<string>} seen
 * @param {CachedModelRow[]} existing
 * @returns {Promise<CachedModelRow[]>}
 */
async function scanMlxArtifacts(seen, existing) {
  const root = path.join(getModelsRoot(), 'artifacts');
  const out = [];
  let entries;
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return out;
  }

  const byRepo = new Map(existing.map((row) => [row.repo_id, row]));

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const repoId = entry.name.replace(/--/g, '/');
    const dir = path.join(root, entry.name);
    const mlx = await detectMlxRepo(dir, repoId);
    if (!mlx) continue;

    const already = byRepo.get(repoId);
    if (already) {
      already.mlx_root = mlx.root;
      already.mlx_quant = mlx.quant;
      if (typeof mlx.contextLength === 'number' && mlx.contextLength > 0) {
        already.mlx_context_length = mlx.contextLength;
      }
      continue;
    }
    if (seen.has(repoId)) continue;

    let sizeBytes = 0;
    let nbFiles = 0;
    await walkCount(dir, (sz) => {
      nbFiles += 1;
      sizeBytes += sz;
    });

    seen.add(repoId);
    out.push({
      repo_id: repoId,
      size_bytes: sizeBytes,
      nb_files: nbFiles,
      has_incomplete: false,
      path: dir,
      is_gguf: false,
      gguf_files: [],
      mlx_root: mlx.root,
      mlx_quant: mlx.quant,
      ...(typeof mlx.contextLength === 'number' && mlx.contextLength > 0
        ? { mlx_context_length: mlx.contextLength }
        : {}),
      status: 'downloaded',
    });
  }

  return out;
}

// ── List cache ───────────────────────────────────────────────────────────────

export const CACHED_MODELS_LIST_TTL_MS = 30_000;

/** @type {{ at: number, home: string, payload: { models: CachedModelRow[] } } | null} */
let listCache = null;
let cachedModelsScanCount = 0;

export function invalidateCachedModelsCache() {
  listCache = null;
}

export function getCachedModelsScanCountForTests() {
  return cachedModelsScanCount;
}

export function resetCachedModelsScanCountForTests() {
  cachedModelsScanCount = 0;
}

/**
 * @returns {Promise<{ models: CachedModelRow[] }>}
 */
async function scanCachedModelsUncached() {
  cachedModelsScanCount += 1;
  const seen = new Set();
  const models = [];

  for (const cache of hfCachePaths()) {
    models.push(...(await scanHfCache(cache, seen)));
  }

  const artifactRows = await scanMinnowArtifacts(seen);
  models.push(...artifactRows);
  models.push(...(await scanMlxArtifacts(seen, artifactRows)));

  const config = await getModelsConfig();
  const dirs = Array.isArray(config.modelDirs)
    ? config.modelDirs.filter((d) => typeof d === 'string' && d.trim())
    : [];
  for (const dir of dirs) {
    models.push(...(await scanCustomDir(dir.trim(), seen)));
  }

  models.sort((a, b) => a.repo_id.localeCompare(b.repo_id));
  return { models };
}

/**
 * @returns {Promise<{ models: CachedModelRow[] }>}
 */
export async function listCachedModels() {
  const now = Date.now();
  const home = getMinnowHome();
  if (
    listCache &&
    listCache.home === home &&
    now - listCache.at < CACHED_MODELS_LIST_TTL_MS
  ) {
    return listCache.payload;
  }
  const payload = await scanCachedModelsUncached();
  listCache = { at: now, home, payload };
  return payload;
}

/**
 * Scan installed model artifacts on disk.
 */

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getModelsConfig } from './models-config.js';
import { getModelsRoot, repoDownloadDir } from './paths.js';
import { listDownloads } from './download.js';

/** Paths that must never be walked (safety). */
const BLOCKED_ROOTS = ['/sys', '/proc', '/dev', '/run', '/var/run'];

/** LM Studio / Ollama metadata folders — not model roots. */
const CUSTOM_DIR_SKIP_NAMES = new Set(['blobs', 'manifests']);

/**
 * Repo id for a GGUF under a configured extra folder.
 * Flat layout: `local-llama`. Nested (LM Studio): `publisher/ModelFolder-GGUF`.
 * @param {string} publisherName Immediate child of the configured root
 * @param {string} publisherRoot Absolute path to that child
 * @param {string} ggufFullPath Absolute path to the weight file
 */
export function customArtifactRepoId(publisherName, publisherRoot, ggufFullPath) {
  const parentDir = path.dirname(ggufFullPath);
  const rel = path.relative(publisherRoot, parentDir);
  if (!rel || rel === '.') return publisherName;
  const top = rel.split(path.sep)[0];
  if (!top || CUSTOM_DIR_SKIP_NAMES.has(top)) return publisherName;
  return `${publisherName}/${top}`;
}

/**
 * @typedef {object} InstalledArtifact
 * @property {string} repoId
 * @property {string} filename
 * @property {string} path
 * @property {number} sizeBytes
 * @property {number} mtimeMs
 */

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

/**
 * Expand ~ and resolve a configured model directory path.
 * @param {string} dirPath
 */
function expandModelDir(dirPath) {
  return dirPath.startsWith('~')
    ? path.join(os.homedir(), dirPath.slice(1))
    : path.resolve(dirPath);
}

/**
 * Walk a directory tree and collect GGUF file paths.
 * @param {string} dir
 * @param {(fullPath: string, filename: string) => void | Promise<void>} onGguf
 */
async function walkGgufs(dir, onGguf) {
  if (!safePath(dir)) return;
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
      if (safePath(full)) await walkGgufs(full, onGguf);
      continue;
    }
    if (!entry.name.toLowerCase().endsWith('.gguf')) continue;
    if (entry.name.startsWith('._')) continue;
    await onGguf(full, entry.name);
  }
}

/**
 * Scan GGUF artifacts under config.models.modelDirs[] subfolders.
 * @param {Set<string>} seenPaths normalized absolute paths already collected
 * @returns {Promise<InstalledArtifact[]>}
 */
async function scanCustomDirArtifacts(seenPaths) {
  const config = await getModelsConfig();
  const dirs = Array.isArray(config.modelDirs)
    ? config.modelDirs.filter((d) => typeof d === 'string' && d.trim())
    : [];
  const out = [];

  for (const dir of dirs) {
    const expanded = expandModelDir(dir.trim());
    if (!safePath(expanded)) continue;

    let entries;
    try {
      entries = await fsp.readdir(expanded, { withFileTypes: true });
    } catch {
      continue;
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
      const modelDir = path.join(expanded, entry.name);
      await walkGgufs(modelDir, async (full, filename) => {
        const normalized = path.resolve(full);
        if (seenPaths.has(normalized)) return;
        seenPaths.add(normalized);
        try {
          const stat = await fsp.stat(full);
          if (!stat.isFile()) return;
          out.push({
            repoId: customArtifactRepoId(entry.name, modelDir, full),
            filename,
            path: full,
            sizeBytes: stat.size,
            mtimeMs: stat.mtimeMs,
          });
        } catch {
          /* skip unreadable */
        }
      });
    }
  }

  return out;
}

/**
 * @param {{ includeCustomDirs?: boolean }} [options]
 * @returns {Promise<InstalledArtifact[]>}
 */
export async function scanInstalledArtifacts(options = {}) {
  const includeCustomDirs = options.includeCustomDirs !== false;
  const seenPaths = new Set();
  const out = [];
  const root = path.join(getModelsRoot(), 'artifacts');
  let entries = [];
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    entries = [];
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const repoKey = entry.name;
    const repoId = repoKey.replace(/--/g, '/');
    const dir = repoDownloadDir(repoId);
    await walkGgufs(dir, async (full, filename) => {
      const normalized = path.resolve(full);
      if (seenPaths.has(normalized)) return;
      try {
        const stat = await fsp.stat(full);
        if (!stat.isFile()) return;
        seenPaths.add(normalized);
        out.push({
          repoId,
          filename,
          path: full,
          sizeBytes: stat.size,
          mtimeMs: stat.mtimeMs,
        });
      } catch {
        /* skip unreadable */
      }
    });
  }

  if (includeCustomDirs) {
    out.push(...(await scanCustomDirArtifacts(seenPaths)));
  }

  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

/**
 * Combined installed view: artifacts + recent download jobs.
 */
export async function listInstalled() {
  const [artifacts, downloads] = await Promise.all([
    scanInstalledArtifacts(),
    listDownloads(),
  ]);
  return { artifacts, downloads };
}

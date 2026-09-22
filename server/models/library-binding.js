import { PROVIDER_ID_BY_ENGINE, MTPLX_LOCAL_ID, isLocalServeProviderId } from '../../src/models/engine-ids.mjs';
import { getLaunchPrefs } from './launch-prefs.js';
import path from 'node:path';

import { listCachedModels } from './cached.js';
import {
  findLiveLlamaCppServeForModel,
  findLiveMlxServeForModel,
  getServe,
  listServes,
  startServe,
} from './serve.js';
import { MODEL_LOAD_TIMEOUT_MS } from './timeouts.js';
import { MINNOW_LIBRARY_PROVIDER_ID } from '../providers/store.js';
import { LLAMA_CPP_LOCAL_ID, MLX_LM_LOCAL_ID } from '../../src/models/runtime-ids.mjs';

export const LIBRARY_MODEL_NOT_LOADED_MESSAGE =
  'Model is not loaded — load it in Models, or send a chat message to start it.';

const SERVE_POLL_MS = 400;

/** @type {LibraryBindingDeps | null} */
let testDeps = null;

/**
 * @typedef {object} LibraryBindingDeps
 * @property {(id: string) => Promise<object | null>} [findLiveLlamaCppServe]
 * @property {(id: string) => Promise<object | null>} [findLiveMlxServe]
 * @property {() => Promise<object[]>} [listServes]
 * @property {() => Promise<{ models?: object[] }>} [listCachedModels]
 * @property {(body: object) => Promise<object>} [startServe]
 * @property {(id: string) => Promise<object | null>} [getServe]
 * @property {() => number} [now]
 * @property {(ms: number) => Promise<void>} [sleep]
 * @property {number} [loadTimeoutMs]
 */

/**
 * @param {LibraryBindingDeps | null} [deps]
 */
export function setLibraryBindingDepsForTests(deps = null) {
  testDeps = deps;
}

/**
 * @param {string | undefined} providerId
 * @param {string | undefined} modelId
 */
export function isLibraryModelBinding(providerId, modelId) {
  const pid = providerId?.trim();
  const mid = modelId?.trim();
  if (!pid || !mid) return false;
  return pid === MINNOW_LIBRARY_PROVIDER_ID && (mid.startsWith('gguf:') || mid.startsWith('mlx:') || mid.startsWith('mtplx:'));
}

/**
 * @param {{ providerId?: string, id?: string } | null | undefined} binding
 * @param {LibraryBindingDeps} [deps]
 * @returns {Promise<{ providerId: string, id: string }>}
 */
export async function resolveLibraryAttemptBinding(binding, deps = {}) {
  const providerId = typeof binding?.providerId === 'string' ? binding.providerId.trim() : '';
  const id = typeof binding?.id === 'string' ? binding.id.trim() : '';
  if (!providerId || !id) {
    return /** @type {{ providerId: string, id: string }} */ (binding ?? { providerId, id });
  }
  if (!isLibraryModelBinding(providerId, id)) {
    return { ...binding, providerId, id };
  }

  const resolved = mergeDeps(deps);
  const serve = await findOrStartServe(id, resolved);
  const remapped = remapFromServe(serve);
  return { ...binding, providerId: remapped.providerId, id: remapped.id };
}

/**
 * @param {LibraryBindingDeps} [explicit]
 * @returns {Required<Pick<LibraryBindingDeps, 'findLiveLlamaCppServe' | 'findLiveMlxServe' | 'listServes' | 'listCachedModels' | 'startServe' | 'getServe' | 'now' | 'sleep' | 'loadTimeoutMs'>>}
 */
function mergeDeps(explicit = {}) {
  const overlay = { ...(testDeps || {}), ...explicit };
  return {
    findLiveLlamaCppServe: overlay.findLiveLlamaCppServe ?? findLiveLlamaCppServeForModel,
    findLiveMlxServe: overlay.findLiveMlxServe ?? findLiveMlxServeForModel,
    listServes: overlay.listServes ?? listServes,
    listCachedModels: overlay.listCachedModels ?? listCachedModels,
    startServe: overlay.startServe ?? startServe,
    getServe: overlay.getServe ?? getServe,
    now: overlay.now ?? Date.now,
    sleep: overlay.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    loadTimeoutMs: overlay.loadTimeoutMs ?? MODEL_LOAD_TIMEOUT_MS,
  };
}

/**
 * @param {string} libraryId
 * @param {ReturnType<typeof mergeDeps>} deps
 */
async function findOrStartServe(libraryId, deps) {
  const existing = await findMatchingLiveServe(libraryId, deps);
  if (existing?.status === 'running') return existing;
  if (existing && (existing.status === 'starting' || existing.status === 'unhealthy')) {
    return waitUntilRunning(existing, deps);
  }

  const target = await resolveCachedTarget(libraryId, deps);
  if (!target) {
    throw new Error(LIBRARY_MODEL_NOT_LOADED_MESSAGE);
  }

  const started = await deps.startServe({
    runtime: target.runtime,
    modelPath: target.modelPath,
    modelLabel: target.modelLabel,
    libraryId: target.libraryId,
    ...(target.quant ? { quant: target.quant } : {}),
    ...(target.weightsGb ? { weightsGb: target.weightsGb } : {}),
  });
  if (started?.status === 'running') return started;
  return waitUntilRunning(started, deps);
}

/**
 * @param {string} libraryId
 * @param {ReturnType<typeof mergeDeps>} deps
 */
async function findMatchingLiveServe(libraryId, deps) {
  const llama = await deps.findLiveLlamaCppServe(libraryId);
  const mlx = await deps.findLiveMlxServe(libraryId);
  const direct = pickPreferredServe(llama, mlx);
  if (direct) return direct;
  const serves = await deps.listServes();
  const byLibraryId = serves.find((row) => row.libraryId === libraryId && ['running', 'starting', 'unhealthy'].includes(row.status));
  if (byLibraryId) return byLibraryId;

  const target = await resolveCachedTarget(libraryId, deps).catch(() => null);
  if (!target?.modelPath) return null;
  const byPath = (Array.isArray(serves) ? serves : []).find(
    (row) =>
      row &&
      typeof row.modelPath === 'string' &&
      row.modelPath === target.modelPath &&
      (row.status === 'running' || row.status === 'starting' || row.status === 'unhealthy'),
  );
  return byPath ?? null;
}

/**
 * @param {object | null | undefined} a
 * @param {object | null | undefined} b
 */
function pickPreferredServe(a, b) {
  const running = [a, b].find((row) => row?.status === 'running');
  if (running) return running;
  return a || b || null;
}

/**
 * @param {object} serve
 * @returns {{ providerId: string, id: string }}
 */
function remapFromServe(serve) {
  if (!serve) {
    throw new Error(LIBRARY_MODEL_NOT_LOADED_MESSAGE);
  }
  if (serve.runtime === 'mlx-lm') {
    const mlxModelId =
      (typeof serve.modelPath === 'string' && serve.modelPath.trim()) ||
      (typeof serve.modelLabel === 'string' && serve.modelLabel.trim()) ||
      '';
    if (!mlxModelId) throw new Error(LIBRARY_MODEL_NOT_LOADED_MESSAGE);
    return { providerId: MLX_LM_LOCAL_ID, id: mlxModelId };
  }
  const label = typeof serve.modelLabel === 'string' ? serve.modelLabel.trim() : '';
  if (!label) throw new Error(LIBRARY_MODEL_NOT_LOADED_MESSAGE);
  return { providerId: PROVIDER_ID_BY_ENGINE[serve.runtime] ?? LLAMA_CPP_LOCAL_ID, id: label };
}

/**
 * @param {string} libraryId
 * @param {ReturnType<typeof mergeDeps>} deps
 * @returns {Promise<{ runtime: string, modelPath: string, modelLabel: string, libraryId: string, quant?: string, weightsGb?: number } | null>}
 */
async function resolveCachedTarget(libraryId, deps) {
  const parsed = parseLibraryId(libraryId);
  if (!parsed) return null;
  const payload = await deps.listCachedModels();
  const models = Array.isArray(payload?.models) ? payload.models : [];
  const row = models.find((m) => m && m.repo_id === parsed.repoId);
  if (!row) return null;

  if (parsed.kind === 'mtplx') {
    if (!row.mtplx_validated || row.has_incomplete || !row.mtplx_root) return null;
    const saved = (await getLaunchPrefs()).byLibraryId[libraryId];
    return { runtime: saved?.engine === 'mlx-lm' ? 'mlx-lm' : 'mtplx', modelPath: row.mtplx_root,
      modelLabel: saved?.mtplx?.model_id || row.repo_id, libraryId, weightsGb: Number(row.size_bytes) / 1024 ** 3 };
  }
  if (parsed.kind === 'mlx') {
    const snapshot = typeof row.mlx_root === 'string' ? row.mlx_root.trim() : '';
    if (!snapshot) return null;
    return {
      runtime: 'mlx-lm',
      modelPath: snapshot,
      modelLabel: snapshot,
      libraryId,
    };
  }

  const files = Array.isArray(row.gguf_files) ? row.gguf_files : [];
  const file = files.find((f) => f && f.rel_path === parsed.relPath);
  if (!file) return null;
  const modelPath = resolveGgufFilePath(row, parsed.relPath);
  if (!modelPath) return null;
  const fileName = typeof file.name === 'string' ? file.name : path.basename(modelPath);
  const modelLabel = fileName.replace(/\.gguf$/i, '') || fileName;
  const sizeBytes = Number(file.size_bytes);
  return {
    runtime: 'llama-cpp',
    modelPath,
    modelLabel,
    libraryId,
    ...(typeof file.quant === 'string' && file.quant ? { quant: file.quant } : {}),
    ...(Number.isFinite(sizeBytes) && sizeBytes > 0
      ? { weightsGb: sizeBytes / 1024 ** 3 }
      : {}),
  };
}

/**
 * @param {string} libraryId
 * @param {LibraryBindingDeps} [deps]
 * @returns {Promise<object | null>}
 */
export async function resolveLibraryCachedTarget(libraryId, deps = {}) {
  return resolveCachedTarget(libraryId, mergeDeps(deps));
}

/** True when a cached HF/library row has a projector sibling (VLM). */
export function libraryCachedRowHasVision(row) {
  const files = Array.isArray(row?.gguf_files) ? row.gguf_files : [];
  return files.some(
    (file) =>
      file?.role === 'projector' ||
      (typeof file?.name === 'string' && /mmproj/i.test(file.name)),
  );
}

/**
 * @param {string} libraryId
 * @param {LibraryBindingDeps} [deps]
 */
export async function findLibraryCachedRow(libraryId, deps = {}) {
  const parsed = parseLibraryId(libraryId);
  if (!parsed) return null;
  const payload = await mergeDeps(deps).listCachedModels();
  const models = Array.isArray(payload?.models) ? payload.models : [];
  return models.find((m) => m && m.repo_id === parsed.repoId) ?? null;
}

/**
 * Map a persisted llama-cpp-local / mlx-lm-local router pair back to a library id.
 * @param {string} providerId
 * @param {string} modelId
 * @param {LibraryBindingDeps} [deps]
 * @returns {Promise<string | null>}
 */
export async function resolveLibraryIdForProviderModel(providerId, modelId, deps = {}) {
  const pid = providerId?.trim() ?? '';
  const mid = modelId?.trim() ?? '';
  if (!pid || !mid) return null;
  if (isLibraryModelBinding(pid, mid)) return mid;
  if (!isLocalServeProviderId(pid)) return null;
  const payload = await mergeDeps(deps).listCachedModels();
  const models = Array.isArray(payload?.models) ? payload.models : [];
  if (pid === MTPLX_LOCAL_ID) {
    const live = (await mergeDeps(deps).listServes()).find((serve) => serve.runtime === 'mtplx' && serve.modelLabel === mid && serve.libraryId);
    if (live) return live.libraryId;
    const prefs = (await getLaunchPrefs()).byLibraryId;
    const row = models.find((r) => r.mtplx_validated && [r.repo_id, r.mtplx_root, path.basename(r.mtplx_root ?? ''), prefs[`mtplx:${r.repo_id}`]?.mtplx?.model_id].includes(mid));
    return row ? 'mtplx:' + row.repo_id : null;
  }
  const want = mid.toLowerCase();
  if (pid === MLX_LM_LOCAL_ID) {
    for (const row of models) {
      const snapshot = typeof row?.mlx_root === 'string' ? row.mlx_root.trim() : '';
      const repo = typeof row?.repo_id === 'string' ? row.repo_id.trim() : '';
      const libraryId = `${row.mtplx_root ? 'mtplx' : 'mlx'}:${repo}`;
      if (snapshot && (snapshot === mid || snapshot.toLowerCase() === want)) return libraryId;
      if (repo && repo.toLowerCase() === want) return libraryId;
    }
    return null;
  }
  for (const row of models) {
    const files = Array.isArray(row?.gguf_files) ? row.gguf_files : [];
    const repo = typeof row?.repo_id === 'string' ? row.repo_id.trim() : '';
    for (const file of files) {
      const rel = typeof file?.rel_path === 'string' ? file.rel_path.trim() : '';
      const name = typeof file?.name === 'string' ? file.name.trim() : '';
      const stem = name.replace(/\.gguf$/i, '');
      if (!rel) continue;
      if (
        mid === stem ||
        mid === name ||
        mid === rel ||
        want === stem.toLowerCase() ||
        want === name.toLowerCase() ||
        want === rel.toLowerCase()
      ) {
        return `gguf:${repo}:${rel}`;
      }
    }
  }
  return null;
}

/**
 * @param {string} libraryId
 * @returns {{ kind: 'gguf', repoId: string, relPath: string } | { kind: 'mlx', repoId: string } | null}
 */
export function parseLibraryId(libraryId) {
  const id = libraryId.trim();
  if (id.startsWith('mtplx:')) return id.slice(6).trim() ? { kind: 'mtplx', repoId: id.slice(6).trim() } : null;
  if (id.startsWith('mlx:')) {
    const repoId = id.slice(4).trim();
    return repoId ? { kind: 'mlx', repoId } : null;
  }
  if (!id.startsWith('gguf:')) return null;
  const rest = id.slice(5);
  const colon = rest.indexOf(':');
  if (colon < 0) return null;
  const repoId = rest.slice(0, colon).trim();
  const relPath = rest.slice(colon + 1).trim();
  if (!repoId || !relPath) return null;
  return { kind: 'gguf', repoId, relPath };
}

/**
 * @param {{ path?: string, repo_id?: string, is_local_dir?: boolean, status?: string }} row
 * @param {string} relPath
 */
function resolveGgufFilePath(row, relPath) {
  const root = typeof row.path === 'string' ? row.path.trim() : '';
  if (!root || !relPath) return null;
  const parts = relPath.split('/').filter(Boolean);
  if (row.is_local_dir || row.status === 'downloaded') {
    return path.join(root, ...parts);
  }
  const repoDir = `models--${String(row.repo_id || '').replace(/\//g, '--')}`;
  return path.join(root, repoDir, 'snapshots', ...parts);
}

/**
 * Poll until the serve is running, or throw on error / timeout.
 * Chat's picker load uses the same timeout and a 400ms tick.
 *
 * @param {object} serve
 * @param {ReturnType<typeof mergeDeps>} deps
 */
async function waitUntilRunning(serve, deps) {
  if (serve?.status === 'running') return serve;
  const serveId = typeof serve?.id === 'string' ? serve.id : '';
  if (!serveId) throw new Error(LIBRARY_MODEL_NOT_LOADED_MESSAGE);

  const started = deps.now();
  while (deps.now() - started < deps.loadTimeoutMs) {
    const next = await deps.getServe(serveId);
    if (next?.status === 'running') return next;
    if (next?.status === 'error' || next?.status === 'stopped' || next?.status === 'crashed') {
      const message =
        (typeof next.error === 'string' && next.error.trim()) || 'Model failed to load';
      throw new Error(message);
    }
    await deps.sleep(SERVE_POLL_MS);
  }
  throw new Error('Timed out waiting for model to load');
}

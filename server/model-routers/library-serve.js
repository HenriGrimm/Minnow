import { isLocalServeProviderId } from '../../src/models/engine-ids.mjs';
/**
 * Router bind for My Models: wait until other local generations idle, then load.
 */

import { listGenerationStates } from '../generations/store.js';
import { serveHasInFlightGenerations, serveMatchesModelId } from '../models/admit-serve.js';
import {
  isLibraryModelBinding,
  resolveLibraryAttemptBinding,
  resolveLibraryIdForProviderModel,
} from '../models/library-binding.js';
import {
  findLiveLlamaCppServeForModel,
  findLiveMlxServeForModel,
  listServes,
} from '../models/serve.js';
import { MODEL_LOAD_TIMEOUT_MS } from '../models/timeouts.js';
import { MINNOW_LIBRARY_PROVIDER_ID } from '../providers/store.js';
import { LLAMA_CPP_LOCAL_ID, MLX_LM_LOCAL_ID } from '../../src/models/runtime-ids.mjs';

const SERVE_POLL_MS = 400;

/** @type {'waiting' | 'loading'} */
const PHASE_WAITING = 'waiting';
const PHASE_LOADING = 'loading';

/** @type {Map<string, 'waiting' | 'loading'>} */
const phases = new Map();
let mutex = Promise.resolve();

/** @type {LibraryServeDeps | null} */
let testDeps = null;

/**
 * @typedef {object} LibraryServeDeps
 * @property {() => Promise<object[]>} [listServes]
 * @property {() => object[]} [listGenerationStates]
 * @property {(id: string) => Promise<object | null>} [findLiveLlamaCppServe]
 * @property {(id: string) => Promise<object | null>} [findLiveMlxServe]
 * @property {(binding: object) => Promise<{ providerId: string, id: string }>} [resolveBinding]
 * @property {(providerId: string, modelId: string) => Promise<string | null>} [resolveLibraryId]
 * @property {() => number} [now]
 * @property {(ms: number) => Promise<void>} [sleep]
 * @property {number} [loadTimeoutMs]
 */

/**
 * @param {LibraryServeDeps | null} [deps]
 */
export function setLibraryServeDepsForTests(deps = null) {
  testDeps = deps;
  mutex = Promise.resolve();
  phases.clear();
}

/** Live GPU phase for a library id, used by router availability copy. */
export function libraryServePhase(libraryId) {
  return phases.get(libraryId?.trim()) || null;
}

function isLiveStatus(status) {
  return status === 'running' || status === 'starting' || status === 'unhealthy';
}

function isLocalRuntimeProvider(providerId) {
  return isLocalServeProviderId(providerId);
}

/**
 * @param {LibraryServeDeps} [explicit]
 */
function mergeDeps(explicit = {}) {
  const overlay = { ...(testDeps || {}), ...explicit };
  return {
    listServes: overlay.listServes ?? listServes,
    listGenerationStates: overlay.listGenerationStates ?? listGenerationStates,
    findLiveLlamaCppServe: overlay.findLiveLlamaCppServe ?? findLiveLlamaCppServeForModel,
    findLiveMlxServe: overlay.findLiveMlxServe ?? findLiveMlxServeForModel,
    resolveBinding: overlay.resolveBinding ?? resolveLibraryAttemptBinding,
    resolveLibraryId: overlay.resolveLibraryId ?? resolveLibraryIdForProviderModel,
    now: overlay.now ?? Date.now,
    sleep: overlay.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    loadTimeoutMs: overlay.loadTimeoutMs ?? MODEL_LOAD_TIMEOUT_MS,
  };
}

function enqueue(fn) {
  const run = mutex.then(fn, fn);
  mutex = run.then(() => undefined, () => undefined);
  return run;
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    const reason = signal.reason;
    throw reason instanceof Error ? reason : new DOMException('Aborted', 'AbortError');
  }
}

function serveMatchesLibrary(serve, libraryId) {
  if (!serve || !libraryId) return false;
  if (typeof serve.libraryId === 'string' && serve.libraryId === libraryId) return true;
  return serveMatchesModelId(serve, libraryId);
}

/**
 * Remap a router entry onto llama-cpp-local / mlx-lm-local, loading after in-flight work.
 * @param {{ providerId: string, modelId: string }} entry
 * @param {{ signal?: AbortSignal, onPhase?: (phase: 'waiting' | 'loading') => void }} [opts]
 * @param {LibraryServeDeps} [deps]
 */
export async function bindRouterLibraryEntry(entry, opts = {}, deps = {}) {
  const providerId = typeof entry?.providerId === 'string' ? entry.providerId.trim() : '';
  const modelId = typeof entry?.modelId === 'string' ? entry.modelId.trim() : '';
  if (!providerId || !modelId) return { providerId, id: modelId };
  if (!isLibraryModelBinding(providerId, modelId) && !isLocalRuntimeProvider(providerId)) {
    return { providerId, id: modelId };
  }

  const resolved = mergeDeps(deps);
  const libraryId =
    (await resolved.resolveLibraryId(providerId, modelId)) ||
    (isLibraryModelBinding(providerId, modelId) ? modelId : null);
  if (!libraryId) return { providerId, id: modelId };

  return enqueue(async () => {
    const started = resolved.now();
    try {
      while (resolved.now() - started < resolved.loadTimeoutMs) {
        throwIfAborted(opts.signal);
        const live = await pickLiveServe(libraryId, resolved);
        if (live?.status === 'running') {
          return resolved.resolveBinding({
            providerId: MINNOW_LIBRARY_PROVIDER_ID,
            id: libraryId,
          });
        }
        if (live && (live.status === 'starting' || live.status === 'unhealthy')) {
          setPhase(libraryId, PHASE_LOADING, opts.onPhase);
          return resolved.resolveBinding({
            providerId: MINNOW_LIBRARY_PROVIDER_ID,
            id: libraryId,
          });
        }

        const othersBusy = await otherLocalServesBusy(libraryId, resolved);
        if (othersBusy) {
          setPhase(libraryId, PHASE_WAITING, opts.onPhase);
          await resolved.sleep(SERVE_POLL_MS);
          continue;
        }

        setPhase(libraryId, PHASE_LOADING, opts.onPhase);
        return resolved.resolveBinding({
          providerId: MINNOW_LIBRARY_PROVIDER_ID,
          id: libraryId,
        });
      }
      throw new Error('Timed out waiting for a free GPU to load the model');
    } finally {
      phases.delete(libraryId);
    }
  });
}

function setPhase(libraryId, phase, onPhase) {
  phases.set(libraryId, phase);
  onPhase?.(phase);
}

async function pickLiveServe(libraryId, deps) {
  const llama = await deps.findLiveLlamaCppServe(libraryId);
  const mlx = await deps.findLiveMlxServe(libraryId);
  const direct = [llama, mlx].find((row) => row?.status === 'running') || llama || mlx || null;
  if (direct) return direct;
  const serves = await deps.listServes();
  return (Array.isArray(serves) ? serves : []).find(
    (row) => row && isLiveStatus(row.status) && serveMatchesLibrary(row, libraryId),
  ) ?? null;
}

async function otherLocalServesBusy(libraryId, deps) {
  const serves = await deps.listServes();
  const generations = deps.listGenerationStates();
  const others = (Array.isArray(serves) ? serves : []).filter(
    (row) =>
      row &&
      isLiveStatus(row.status) &&
      (['llama-cpp', 'mlx-lm', 'mtplx'].includes(row.runtime)) &&
      !serveMatchesLibrary(row, libraryId),
  );
  return others.some(
    (row) => row.status === 'starting' || row.status === 'unhealthy' || serveHasInFlightGenerations(row, generations),
  );
}

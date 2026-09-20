import { getLibraryLaunchSettingsForId } from '../config/library-launch-meta';
import { MTPLX_LOCAL_ID, isLocalServeProviderId } from './engine-ids.mjs';
/**
 * Merge My Models (local GGUF library) into the top-bar / composer model picker.
 * Uses a synthetic provider id so load/unload can start or stop Minnow serves.
 */

import { isServerStorageMode } from '../config/storage-mode';
import { buildTopBarModelOptionHtml } from '../lib/format-model-label';
import { MODEL_LOAD_TIMEOUT_MS } from './serve-timeouts';
import { decodeModelSelectKey, encodeModelSelectKey } from '../lib/model-select-key';
import { LLAMA_CPP_LOCAL_PROVIDER_ID, MLX_LM_LOCAL_PROVIDER_ID } from '../providers/types';
import type { ProviderModelsResult } from '../providers/fetch-all-models';
import type { LmModelRecord } from '../types';
import {
  fetchCachedModels,
  listModelServes,
  type CachedModelRow,
  type ServeRecord,
} from './api-client';
import { fetchHardware } from './hardware-client';
import {
  activeServeFor,
  buildLibrary,
  loadableLibrary,
  type LibraryModel,
} from './library';

// ── Keys ─────────────────────────────────────────────────────────────────────

/** Pseudo-provider id for composite #modelSelect keys (not in providers registry). */
export const LIBRARY_MODEL_PROVIDER_ID = 'minnow-library';

/** Optgroup label in the model picker. */
export const LIBRARY_MODEL_OPTGROUP_LABEL = 'My Models';

export function isLibraryModelProviderId(providerId: string | undefined): boolean {
  return providerId?.trim() === LIBRARY_MODEL_PROVIDER_ID;
}

/** True when chat/send binding points at a local library row. */
export function isLibraryModelBinding(providerId: string | undefined, modelId: string | undefined): boolean {
  const pid = providerId?.trim();
  const mid = modelId?.trim();
  if (!pid || !mid) return false;
  return (
    isLibraryModelProviderId(pid) &&
    (mid.startsWith('gguf:') || mid.startsWith('mlx:') || mid.startsWith('mtplx:'))
  );
}

/** My Models rows eligible for the picker (MLX gated on Metal when hardware is known). */
export async function loadableLibraryFromCached(
  cached: CachedModelRow[],
): Promise<LibraryModel[]> {
  let backend: string | null | undefined = undefined;
  try {
    const hw = await fetchHardware();
    backend = hw.backend ?? null;
  } catch {}
  return loadableLibrary(await buildLibrary(cached), { backend }).filter((m) => m.servable && !m.incomplete);
}

/**
 * Map synthetic My Models provider id to the ~/.minnow provider used for upstream HTTP.
 */
export function resolveUpstreamProviderId(
  providerId: string | undefined,
  modelId: string | undefined,
): string {
  const pid = providerId?.trim() ?? '';
  if (!isLibraryModelBinding(pid, modelId)) return pid;
  const mid = modelId?.trim() ?? '';
  if (mid.startsWith('mtplx:')) return getLibraryLaunchSettingsForId(mid)?.engine === 'mlx-lm' ? MLX_LM_LOCAL_PROVIDER_ID : MTPLX_LOCAL_ID;
  if (mid.startsWith('mlx:')) return MLX_LM_LOCAL_PROVIDER_ID;
  return LLAMA_CPP_LOCAL_PROVIDER_ID;
}

function upstreamProviderForLibraryModel(model: LibraryModel | undefined): string {
  if (model?.id.startsWith('mtplx:')) return resolveUpstreamProviderId(LIBRARY_MODEL_PROVIDER_ID, model.id);
  if (model?.format === 'MLX' || model?.id.startsWith('mlx:')) {
    return MLX_LM_LOCAL_PROVIDER_ID;
  }
  return LLAMA_CPP_LOCAL_PROVIDER_ID;
}

export function encodeLibraryModelSelectKey(libraryId: string): string {
  return encodeModelSelectKey(LIBRARY_MODEL_PROVIDER_ID, libraryId.trim());
}

export function decodeLibraryModelSelectKey(selectValue: string): string | null {
  const decoded = decodeModelSelectKey(selectValue.trim());
  if (!decoded || !isLibraryModelProviderId(decoded.providerId)) return null;
  return decoded.modelId.trim() || null;
}

export interface LibraryModelSelectMerge {
  optgroupHtml: string;
  cacheEntries: Array<{ key: string; row: LmModelRecord }>;
  library: LibraryModel[];
  serves: ServeRecord[];
}

// ── Serve state ──────────────────────────────────────────────────────────────

/**
 * Context window a chat actually gets from a running serve.
 *
 * `llamaSettings.ctx` is the `-c` total, which the planner already multiplied by
 * `--parallel` (`ctx = ctxPerSlot * parallel`), so the per-chat window is the
 * quotient. Without this a model outside the bundled catalog — anything the GGUF
 * scan has no `context_length` for — reads back as "Context limit unknown", which
 * also switches off history compression.
 */
export function servedContextLength(serve: ServeRecord | undefined): number | undefined {
  if (!serve || serve.status !== 'running') return undefined;
  const mtplxCtx = Number(serve.mtplxSettings?.context_window);
  if (Number.isFinite(mtplxCtx) && mtplxCtx > 0) return mtplxCtx;
  const mlxCtx = Number(serve.mlxSettings?.contextLength);
  if (Number.isFinite(mlxCtx) && mlxCtx > 0) return mlxCtx;
  const settings = serve.llamaSettings;
  if (!settings || typeof settings !== 'object') return undefined;
  const ctx = Number(settings.ctx);
  if (!Number.isFinite(ctx) || ctx <= 0) return undefined;
  const parallel = Math.max(1, Math.trunc(Number(settings.parallel) || 1));
  return Math.floor(ctx / parallel) || undefined;
}

function serveLoadState(serve: ServeRecord | undefined): LmModelRecord['state'] {
  if (!serve) return 'not loaded';
  if (serve.status === 'running') return 'loaded';
  if (serve.status === 'starting') return 'not loaded';
  return 'not loaded';
}

/** Load-state for one library row from active serves. */
export function libraryModelLoadState(
  model: LibraryModel,
  serves: ServeRecord[],
): LmModelRecord['state'] {
  return serveLoadState(activeServeFor(model, serves));
}

/** Running serve for a library id, if any. */
export function activeServeForLibraryId(
  libraryId: string,
  library: LibraryModel[],
  serves: ServeRecord[],
): ServeRecord | undefined {
  const model = library.find((m) => m.id === libraryId.trim());
  if (!model) return undefined;
  return activeServeFor(model, serves);
}

/** Provider + upstream model id once a library row is served locally. */
export function resolveServedBindingForLibraryId(
  libraryId: string,
  library: LibraryModel[],
  serves: ServeRecord[],
  providerModels?: ProviderModelsResult[],
): { providerId: string; modelId: string } | null {
  const serve = activeServeForLibraryId(libraryId, library, serves);
  if (!serve || serve.status !== 'running') return null;

  const model = library.find((m) => m.id === libraryId.trim());
  const upstreamId = upstreamProviderForLibraryModel(model);

  if (serve.runtime === 'mtplx') return { providerId: MTPLX_LOCAL_ID, modelId: serve.modelLabel };
  if (upstreamId === MLX_LM_LOCAL_PROVIDER_ID || serve.runtime === 'mlx-lm') {
    const mlxModelId =
      serve.modelPath?.trim() ||
      model?.path?.trim() ||
      serve.modelLabel?.trim() ||
      '';
    if (!mlxModelId) return null;
    return { providerId: MLX_LM_LOCAL_PROVIDER_ID, modelId: mlxModelId };
  }

  const label = serve.modelLabel?.trim() || model?.name?.trim() || '';
  if (!label) return null;

  if (upstreamId === LLAMA_CPP_LOCAL_PROVIDER_ID) {
    const llama =
      providerModels?.find((r) => r.provider.id === LLAMA_CPP_LOCAL_PROVIDER_ID) ?? null;
    if (llama) {
      const hit = llama.models.find(
        (m) => m.id === label || m.id.toLowerCase() === label.toLowerCase(),
      );
      if (hit) {
        return { providerId: LLAMA_CPP_LOCAL_PROVIDER_ID, modelId: hit.id };
      }
    }
  }

  return { providerId: upstreamId, modelId: label };
}

/** True when a My Models row is not loaded in a Minnow serve yet. */
export function libraryModelNeedsLoad(
  libraryId: string,
  cache: ReadonlyMap<string, LmModelRecord>,
): boolean {
  const key = encodeLibraryModelSelectKey(libraryId);
  const row = cache.get(key);
  if (!row) return true;
  const state = row.state?.trim().toLowerCase();
  return state !== 'loaded';
}

/**
 * Whether a My Models chat turn should run the load path before completions.
 * Live serve status wins: no running serve always needs load (picker cache can
 * stay "loaded" after Models eject). Optional cache kept for call-site symmetry.
 */
export function libraryBindingNeedsServeLoad(
  libraryId: string,
  library: LibraryModel[],
  serves: ServeRecord[],
  _cache?: ReadonlyMap<string, LmModelRecord>,
): boolean {
  const serve = activeServeForLibraryId(libraryId, library, serves);
  if (serve?.status === 'running') return false;
  return true;
}

/**
 * Completions provider/model for a My Models row once a serve is running.
 * Returns null when there is no running serve (caller must ensure-load first).
 */
export function resolveLibrarySendBinding(
  libraryId: string,
  library: LibraryModel[],
  serves: ServeRecord[],
  providerModels?: ProviderModelsResult[],
): { providerId: string; modelId: string } | null {
  return resolveServedBindingForLibraryId(libraryId, library, serves, providerModels);
}

function normalizeBindingToken(value: string | null | undefined): string {
  return value?.trim().toLowerCase() ?? '';
}

/**
 * Resolve the My Models library id for a chat binding.
 * After a served turn, chats often persist llama-cpp-local / mlx-lm-local + upstream
 * model ids — those must still auto-load when the serve is gone.
 */
export function resolveLibraryModelIdForChatBinding(
  providerId: string | undefined,
  modelId: string | undefined,
  library: LibraryModel[],
): string | null {
  const pid = providerId?.trim();
  const mid = modelId?.trim();
  if (!pid || !mid) return null;

  if (isLibraryModelBinding(pid, mid)) return mid;

  if (pid === LLAMA_CPP_LOCAL_PROVIDER_ID) {
    const want = normalizeBindingToken(mid);
    const hit = library.find((model) => {
      if (model.format === 'MLX' || model.id.startsWith('mlx:')) return false;
      const name = normalizeBindingToken(model.name);
      const file = normalizeBindingToken(model.fileName);
      const repo = normalizeBindingToken(model.repoId);
      return want === name || (file && want === file) || (repo && want === repo);
    });
    return hit?.id ?? null;
  }

  if (pid === MTPLX_LOCAL_ID) {
    return library.find((m) => m.source === 'mtplx-cache' && [m.id, m.name, m.repoId, m.path, m.path?.split(/[/\\]/).pop(), getLibraryLaunchSettingsForId(m.id)?.mtplx?.model_id].includes(mid))?.id ?? null;
  }
  if (pid === MLX_LM_LOCAL_PROVIDER_ID) {
    const want = mid.trim();
    const wantLower = want.toLowerCase();
    const hit = library.find((model) => {
      if (model.format !== 'MLX' && !model.id.startsWith('mlx:')) return false;
      const path = model.path?.trim();
      if (path && (path === want || path.endsWith(want))) return true;
      const name = normalizeBindingToken(model.name);
      return wantLower === name;
    });
    return hit?.id ?? null;
  }

  return null;
}

/**
 * True for Minnow-owned local runtime providers whose `/v1/models` catalogs
 * must not appear in the picker (users select via My Models instead).
 */
export function isLocalRuntimeCatalogProviderId(providerId: string | undefined): boolean {
  const id = providerId?.trim();
  return isLocalServeProviderId(id);
}

/**
 * Clear llama-cpp-local / mlx-lm-local catalog rows from picker results.
 * Those providers stay registered for serve routing; the picker surface is My Models only.
 */
export function omitLocalRuntimeCatalogModels(
  results: ProviderModelsResult[],
): ProviderModelsResult[] {
  return results.map((entry) => {
    if (!isLocalRuntimeCatalogProviderId(entry.provider.id)) return entry;
    // Empty models → optgroup omitted by buildMultiProviderModelSelectInnerHtml filters.
    return entry.models.length === 0 ? entry : { ...entry, models: [] };
  });
}

/**
 * @deprecated Prefer {@link omitLocalRuntimeCatalogModels}. Kept so call sites and
 * test mocks that still pass library/serves keep compiling; library/serves are ignored.
 */
export function dedupLlamaCppModelsAgainstLibrary(
  results: ProviderModelsResult[],
  _library?: LibraryModel[],
  _serves?: ServeRecord[],
): ProviderModelsResult[] {
  return omitLocalRuntimeCatalogModels(results);
}

// ── Merge ────────────────────────────────────────────────────────────────────

/**
 * Fetch local weights and build optgroup HTML + modelCache rows for the picker.
 * Returns null when the tool server is down or the library scan is empty.
 */
export async function fetchLibraryModelSelectMerge(
  signal?: AbortSignal,
): Promise<LibraryModelSelectMerge | null> {
  if (!isServerStorageMode()) return null;
  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }

  const [cached, serves] = await Promise.all([
    fetchCachedModels(),
    listModelServes().catch(() => [] as ServeRecord[]),
  ]);

  const library = await loadableLibraryFromCached(cached);
  if (library.length === 0) return null;

  const cacheEntries: Array<{ key: string; row: LmModelRecord }> = [];
  const opts = library
    .map((model) => {
      const key = encodeLibraryModelSelectKey(model.id);
      const serve = activeServeFor(model, serves);
      const state = serveLoadState(serve);
      const vision = model.capabilities.includes('vision');
      const loadedContext = servedContextLength(serve);
      cacheEntries.push({
        key,
        row: {
          id: model.id,
          type: vision ? 'vlm' : 'llm',
          state,
          quantization: model.quant || undefined,
          max_context_length: model.contextLength ?? undefined,
          ...(loadedContext !== undefined ? { loaded_context_length: loadedContext } : {}),
          ...(vision ? { catalogVision: true } : {}),
        },
      });
      return buildTopBarModelOptionHtml({
        value: key,
        model: {
          id: model.name,
          quantization: model.quant || undefined,
          state,
        },
        providerId: LIBRARY_MODEL_PROVIDER_ID,
        providerLabel: LIBRARY_MODEL_OPTGROUP_LABEL,
        providerBaseUrl: 'http://127.0.0.1',
        supportsModelLoadUnload: true,
      });
    })
    .join('');

  const optgroupHtml = `<optgroup label="${LIBRARY_MODEL_OPTGROUP_LABEL}">${opts}</optgroup>`;
  return { optgroupHtml, cacheEntries, library, serves };
}

const SERVE_POLL_MS = 400;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function findLibraryModel(libraryId: string): Promise<LibraryModel | null> {
  const cached = await fetchCachedModels();
  const library = await loadableLibraryFromCached(cached);
  return library.find((m) => m.id === libraryId.trim()) ?? null;
}

/** Start a Minnow serve for a library row (waits until running or failed). */
export async function loadLibraryModelFromPicker(libraryId: string): Promise<void> {
  const id = libraryId.trim();
  if (!id) throw new Error('No model selected');

  const model = await findLibraryModel(id);
  if (!model) throw new Error('Model not found in My Models');

  const serves = await listModelServes().catch(() => [] as ServeRecord[]);
  const existing = activeServeFor(model, serves);
  if (existing?.status === 'running') return;

  const { loadModel } = await import('../ui/models/store');
  await loadModel(model);

  const started = Date.now();
  while (Date.now() - started < MODEL_LOAD_TIMEOUT_MS) {
    const nextServes = await listModelServes().catch(() => [] as ServeRecord[]);
    const serve = activeServeFor(model, nextServes);
    if (serve?.status === 'running') return;
    if (serve?.status === 'error') {
      throw new Error(serve.error?.trim() || 'Model failed to load');
    }
    if (serve?.status === 'stopped' && serve.error) {
      throw new Error(serve.error.trim());
    }
    await sleep(SERVE_POLL_MS);
  }
  throw new Error('Timed out waiting for model to load');
}

/** Stop the serve holding a library row, if any. */
export async function unloadLibraryModelFromPicker(libraryId: string): Promise<void> {
  const id = libraryId.trim();
  if (!id) return;

  const model = await findLibraryModel(id);
  if (!model) return;

  const serves = await listModelServes().catch(() => [] as ServeRecord[]);
  const serve = activeServeFor(model, serves);
  if (!serve) return;

  const { unloadServe } = await import('../ui/models/store');
  await unloadServe(serve.id);
}

/**
 * The context window a server-side runner (board attempt, sub-agent, Super Plan
 * stage) budgets against. Mirrors the renderer's `turnModelContextLimit`: a
 * running local serve's `-c` wins, then shared catalog/probe/known-model resolution.
 * The runner still narrows this with the host's own overflow numbers.
 */

import { readCapabilities } from '../providers/capabilities-store.js';
import { proxyModels } from '../providers/proxy.js';
import { contextLengthFromModelRow } from '../../src/lib/context-length.mjs';
import { LLAMA_CPP_LOCAL_ID, MLX_LM_LOCAL_ID } from '../../src/models/runtime-ids.mjs';
import { findLiveLlamaCppServeForModel, findLiveMlxServeForModel } from './serve.js';

// Share in-flight catalog requests across parallel board attempts. Refresh loaded
// runtime metadata each minute rather than issuing one request per task.
const catalogs = new Map();
async function modelCatalog(providerId) {
  const cached = catalogs.get(providerId);
  if (cached && cached.expires > Date.now()) return cached.promise;
  const promise = proxyModels(providerId).catch(() => ({ data: [] }));
  catalogs.set(providerId, { promise, expires: Date.now() + 60_000 });
  return promise;
}

/**
 * Per-chat window of a running serve. `llamaSettings.ctx` is the `-c` total the
 * planner multiplied by `--parallel`, so one slot gets the quotient. Same rule
 * as `servedContextLength` in src/models/model-select-library.ts.
 *
 * @param {{ status?: string, llamaSettings?: { ctx?: unknown, parallel?: unknown } | null, mlxSettings?: { contextLength?: unknown } | null } | null | undefined} serve
 * @returns {number | null}
 */
export function servedContextLength(serve) {
  if (!serve || serve.status !== 'running') return null;
  const mlxCtx = Number(serve.mlxSettings?.contextLength);
  if (Number.isFinite(mlxCtx) && mlxCtx > 0) return mlxCtx;
  const settings = serve.llamaSettings;
  if (!settings || typeof settings !== 'object') return null;
  const ctx = Number(settings.ctx);
  if (!Number.isFinite(ctx) || ctx <= 0) return null;
  const parallel = Math.max(1, Math.trunc(Number(settings.parallel) || 1));
  return Math.floor(ctx / parallel) || null;
}

/**
 * @typedef {object} ContextWindowDeps
 * @property {(modelId: string) => Promise<object | null>} [findLiveLlamaCppServe]
 * @property {(modelId: string) => Promise<object | null>} [findLiveMlxServe]
 * @property {(providerId: string) => Promise<{ models?: Record<string, { contextLength?: number | null }> }>} [readCapabilities]
 * @property {(providerId: string) => Promise<{ data?: object[] }>} [listModels]
 */

/**
 * @param {{ providerId?: string, id?: string } | null | undefined} model already library-bound
 * @param {ContextWindowDeps} [deps]
 * @returns {Promise<number | null>}
 */
export async function resolveServerModelContextLimit(model, deps = {}) {
  const providerId = typeof model?.providerId === 'string' ? model.providerId.trim() : '';
  const modelId = typeof model?.id === 'string' ? model.id.trim() : '';
  if (!providerId || !modelId) return null;

  try {
    if (providerId === LLAMA_CPP_LOCAL_ID) {
      const serve = await (deps.findLiveLlamaCppServe ?? findLiveLlamaCppServeForModel)(modelId);
      const served = servedContextLength(/** @type {any} */ (serve));
      if (served != null) return served;
    } else if (providerId === MLX_LM_LOCAL_ID) {
      const serve = await (deps.findLiveMlxServe ?? findLiveMlxServeForModel)(modelId);
      const served = servedContextLength(/** @type {any} */ (serve));
      if (served != null) return served;
    }
  } catch {
    // No serve registry (tests, first boot): fall through to the model row.
  }

  let capabilities;
  try {
    const file = await (deps.readCapabilities ?? readCapabilities)(providerId);
    capabilities = file?.models?.[modelId];
  } catch {
    // Unknown provider id or unreadable file: no window.
  }
  let row;
  try {
    const catalog = await (deps.listModels ?? modelCatalog)(providerId);
    row = catalog?.data?.find(candidate => candidate.id === modelId);
  } catch {
    // Offline providers still benefit from persisted metadata and known models.
  }
  const catalogLength = row?.capabilities?.contextLength ?? row?.max_context_length;
  const probedLength = capabilities?.contextLength;
  // A saved catalog observation must not shadow a newer live catalog. Explicit
  // probes/overrides keep priority, just as mergeModelCapabilities does in chat.
  const useProbe = typeof probedLength === 'number' && Number.isFinite(probedLength) && probedLength > 0 &&
    !(capabilities?.sources?.contextLength === 'catalog' && typeof catalogLength === 'number' && Number.isFinite(catalogLength) && catalogLength > 0);
  return contextLengthFromModelRow({ ...row, id: modelId,
    capabilities: { contextLength: useProbe ? probedLength : catalogLength },
  }) ?? null;
}

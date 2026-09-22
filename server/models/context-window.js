import { MTPLX_LOCAL_ID } from '../../src/models/engine-ids.mjs';
import { findLiveServeForRuntime } from './serve.js';
/**
 * The context window a server-side runner (board attempt, sub-agent, Super Plan
 * stage) budgets against. Mirrors the renderer's `turnModelContextLimit`: a
 * running local serve's `-c` wins, then the provider's probed model row.
 * The runner still narrows this with the host's own overflow numbers.
 */

import { readCapabilities } from '../providers/capabilities-store.js';
import { LLAMA_CPP_LOCAL_ID, MLX_LM_LOCAL_ID } from '../../src/models/runtime-ids.mjs';
import { findLiveLlamaCppServeForModel, findLiveMlxServeForModel } from './serve.js';

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
  const mtplxCtx = Number(serve.mtplxSettings?.context_window);
  if (Number.isFinite(mtplxCtx) && mtplxCtx > 0) return mtplxCtx;
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
    if (providerId === MTPLX_LOCAL_ID) {
      return servedContextLength(await (deps.findLiveMtplxServe ?? ((id) => findLiveServeForRuntime('mtplx', id)))(modelId));
    }
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

  try {
    const file = await (deps.readCapabilities ?? readCapabilities)(providerId);
    const row = file?.models?.[modelId];
    const length = Number(row?.contextLength);
    if (Number.isFinite(length) && length > 0) return Math.floor(length);
  } catch {
    // Unknown provider id or unreadable file: no window.
  }
  return null;
}

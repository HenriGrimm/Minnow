/** Resolve the model a real attempt should use. */

import { readConfigJson } from '../config/store.js';
import { MINNOW_LIBRARY_PROVIDER_ID } from '../providers/store.js';

/**
 * @param {{ providerId?: string, id?: string } | null | undefined} override
 * @returns {Promise<{ providerId: string, id: string }>}
 */
export async function resolveAttemptModel(override) {
  const fromOverride = await completePair(override?.providerId, override?.id);
  if (fromOverride) return fromOverride;

  const cfg = (await readConfigJson('config.json')) ?? {};
  const autopilot =
    cfg.autopilot && typeof cfg.autopilot === 'object'
      ? /** @type {Record<string, unknown>} */ (cfg.autopilot)
      : {};
  const fromAutopilot = await completePair(
    autopilot.plannerProviderId,
    autopilot.plannerModelId,
  );
  if (fromAutopilot) return fromAutopilot;

  const fromChat = await readActiveChatPair();
  if (fromChat) return fromChat;

  throw new Error(
    'no model bound for this attempt: set Settings → Autopilot planner model, or select a model in the menubar',
  );
}

/**
 * Complete an explicit provider/model pair without falling through to Autopilot
 * or the active chat. Used when `POST /api/boards` includes a model body.
 *
 * @param {unknown} providerId
 * @param {unknown} modelId
 * @returns {Promise<{ providerId: string, id: string } | null>}
 */
export async function completeModelPair(providerId, modelId) {
  return completePair(providerId, modelId);
}

/**
 * A usable binding is a non-empty model id. Provider may be inferred.
 *
 * @param {unknown} providerId
 * @param {unknown} modelId
 * @returns {Promise<{ providerId: string, id: string } | null>}
 */
async function completePair(providerId, modelId) {
  const id = typeof modelId === 'string' ? modelId.trim() : '';
  if (!id) return null;
  let provider = typeof providerId === 'string' ? providerId.trim() : '';
  if (!provider) provider = await inferProviderId(id);
  return { providerId: provider, id };
}

/**
 * @param {string} modelId
 * @returns {Promise<string>}
 */
async function inferProviderId(modelId) {
  if (modelId.startsWith('gguf:') || modelId.startsWith('mlx:') || modelId.startsWith('mtplx:')) {
    return MINNOW_LIBRARY_PROVIDER_ID;
  }
  try {
    const { listProviders } = await import('../providers/store.js');
    const { readCapabilities } = await import('../providers/capabilities-store.js');
    const { providers } = await listProviders();
    for (const row of providers) {
      if (!row || row.enabled === false) continue;
      const pid = typeof row.id === 'string' ? row.id.trim() : '';
      if (!pid) continue;
      const caps = await readCapabilities(pid);
      const models = caps?.models && typeof caps.models === 'object' ? caps.models : {};
      if (Object.prototype.hasOwnProperty.call(models, modelId)) return pid;
    }
  } catch {
    // Empty homes and missing catalogs are not fatal; caller keeps id-only.
  }
  return '';
}

/**
 * Active chat menubar binding, if the sessions store is available.
 * @returns {Promise<{ providerId: string, id: string } | null>}
 */
async function readActiveChatPair() {
  try {
    const { readActiveChatModelBinding } = await import('../config/sessions-repo.js');
    const binding = readActiveChatModelBinding();
    return completePair(binding?.providerId, binding?.modelId);
  } catch {
    return null;
  }
}

/**
 * Validate Minnow setup profile bundles (schemaVersion 1).
 */

const ID_PATTERN = /^[a-z0-9][a-z0-9-_]{0,63}$/;
const MAX_BUNDLE_BYTES = 512 * 1024;

/**
 * @param {unknown} body
 * @returns {{ ok: true, bundle: object } | { ok: false, error: string }}
 */
export function validateProfileBundle(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'Profile must be an object' };
  }

  const raw = /** @type {Record<string, unknown>} */ (body);
  const size = Buffer.byteLength(JSON.stringify(raw), 'utf8');
  if (size > MAX_BUNDLE_BYTES) {
    return { ok: false, error: 'Profile bundle exceeds 512 KB limit' };
  }

  if (typeof raw.id !== 'string' || !ID_PATTERN.test(raw.id)) {
    return { ok: false, error: 'Invalid profile id' };
  }
  if (raw.id.includes('..') || raw.id.startsWith('_')) {
    return { ok: false, error: 'Invalid profile id' };
  }
  if (typeof raw.label !== 'string' || !raw.label.trim() || raw.label.length > 120) {
    return { ok: false, error: 'Invalid label' };
  }
  const schemaVersion = raw.schemaVersion;
  if (schemaVersion !== 1 && schemaVersion !== '1') {
    return { ok: false, error: 'Unsupported schemaVersion' };
  }

  if (!raw.prompt || typeof raw.prompt !== 'object' || Array.isArray(raw.prompt)) {
    return { ok: false, error: 'prompt section required' };
  }
  const prompt = /** @type {Record<string, unknown>} */ (raw.prompt);
  if (!raw.agents || typeof raw.agents !== 'object' || Array.isArray(raw.agents)) {
    return { ok: false, error: 'agents section required' };
  }
  if (!raw.tools || typeof raw.tools !== 'object' || Array.isArray(raw.tools)) {
    return { ok: false, error: 'tools section required' };
  }

  const tools = /** @type {Record<string, unknown>} */ (raw.tools);
  if (tools.keys && typeof tools.keys === 'object') {
    const keys = /** @type {Record<string, unknown>} */ (tools.keys);
    for (const key of Object.keys(keys)) {
      if (key.toLowerCase().includes('secret') || key.toLowerCase().includes('apikey')) {
        const val = keys[key];
        if (typeof val === 'string' && val.trim()) {
          return { ok: false, error: 'API keys cannot be stored in profile bundles' };
        }
      }
    }
  }

  const bundle = {
    id: raw.id,
    label: raw.label.trim(),
    schemaVersion: 1,
    meta:
      raw.meta && typeof raw.meta === 'object'
        ? { .../** @type {object} */ (raw.meta) }
        : {},
    prompt: {
      activeInfoPresetId:
        typeof prompt.activeInfoPresetId === 'string'
          ? prompt.activeInfoPresetId
          : 'general-assistant',
      planGranularity:
        prompt.planGranularity === 'large' ||
        prompt.planGranularity === 'small' ||
        prompt.planGranularity === 'medium'
          ? prompt.planGranularity
          : 'medium',
    },
    agents: /** @type {object} */ (raw.agents),
    tools: {},
    ...(raw.rules && typeof raw.rules === 'object' ? { rules: raw.rules } : {}),
    ...(raw.skills && typeof raw.skills === 'object' ? { skills: raw.skills } : {}),
  };

  return { ok: true, bundle };
}

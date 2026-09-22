import fsp from 'node:fs/promises';
import path from 'node:path';
import { getModelsRoot } from './paths.js';
import { runMtplxJson } from './mtplx-runtime.js';

const fallbackDraft = { supported: true, default: 3, minimum: 1, maximum: 3, valueLabels: ['D1', 'D2', 'D3'] };
const fallbackContext = { supported: true, minimum: 4096, maximum: 262144, default: 262144, step: 1024 };
const fallbackKv = { supported: true, modes: ['off', 'q8', 'q4'], restartRequired: true };
const strings = (v) => Array.isArray(v) ? v.filter((s) => typeof s === 'string') : [];
const positive = (v, fallback) => Number.isFinite(v) && v > 0 ? Math.trunc(v) : fallback;

function bounds(raw, fallback) {
  if (!raw || typeof raw !== 'object') return { ...fallback };
  const minimum = positive(raw.minimum, fallback.minimum);
  const maximum = Math.max(minimum, positive(raw.maximum, fallback.maximum));
  return { supported: raw.supported !== false, minimum, maximum,
    default: Math.max(minimum, Math.min(maximum, positive(raw.default, fallback.default))),
    ...(fallback.step ? { step: positive(raw.step, fallback.step) } : { valueLabels: strings(raw.value_labels) }) };
}

function normalize(json, source, modelPath) {
  const compatibility = json.compatibility ?? {};
  const backend = source === 'health' ? json.startup?.backend ?? {} : json.backend ?? compatibility.backend ?? {};
  const controls = backend.model_controls ?? json.model_controls ?? compatibility.model_controls ?? {};
  const contract = compatibility.runtime_contract ?? json.runtime_contract ?? {};
  const draftControl = controls.draft_control ?? (Number.isFinite(contract.mtp_depth_max)
    ? { ...fallbackDraft, maximum: contract.mtp_depth_max, default: Math.min(3, contract.mtp_depth_max) }
    : undefined);
  const reasoning = controls.reasoning;
  const kv = controls.kv_quant ?? controls.kv_quant_policy;
  return {
    modelPath: modelPath ?? json.model_path ?? json.model_dir ?? controls.model_ref ?? '',
    archId: controls.architecture_id ?? json.architecture ?? null,
    backendId: controls.backend_id ?? backend.backend_id ?? compatibility.recommended_backend ?? null,
    supportLevel: controls.support_level ?? compatibility.support_level ?? null,
    tier: compatibility.tier ?? null,
    canRun: source === 'health' ? json.ok === true || json.status === 'ok' : compatibility.can_run === true,
    mtpSupported: compatibility.mtp_supported === true || (source === 'health' && controls.draft_control?.supported === true),
    recommendedProfile: compatibility.recommended_profile ?? json.profile ?? null,
    recommendedBackend: compatibility.recommended_backend ?? null,
    draft: bounds(draftControl, fallbackDraft),
    contextWindow: bounds(controls.context_window ?? controls.context_window_policy, fallbackContext),
    kvQuant: kv ? { supported: kv.supported !== false, modes: strings(kv.modes).length ? strings(kv.modes) : ['off'], restartRequired: kv.restart_required !== false } : { ...fallbackKv },
    reasoning: reasoning ? { supported: reasoning.supported !== false, parser: reasoning.parser,
      modes: strings(reasoning.modes), defaultMode: reasoning.default_mode ?? reasoning.default,
      effortLevels: strings(reasoning.effort_levels), defaultEffort: reasoning.default_effort } : null,
    sampling: controls.sampling ?? json.recommended_sampler ?? null, source, fetchedAt: Date.now(),
  };
}

export const descriptorFromInspect = (json, modelPath) => normalize(json, 'inspect', modelPath);
export const descriptorFromHealth = (json, modelPath) => normalize(json, 'health', modelPath);
export const fallbackMtplxDescriptor = (modelPath) => ({ ...normalize({}, 'inspect', modelPath), source: 'fallback' });

const inflight = new Map();
let writes = Promise.resolve();
const cacheFile = () => path.join(getModelsRoot(), 'mtplx-descriptors.json');
async function fingerprint(modelPath) {
  return (await Promise.all(['', 'config.json', 'mtplx_runtime.json', 'mtp.safetensors'].map(async (name) => {
    try { const stat = await fsp.stat(path.join(modelPath, name)); return `${stat.mtimeMs}:${stat.size}`; }
    catch { return 'missing'; }
  }))).join('|');
}
async function readCache() {
  try { return JSON.parse(await fsp.readFile(cacheFile(), 'utf8')); } catch { return {}; }
}
export async function getCachedMtplxDescriptor(modelPath) {
  modelPath = path.resolve(modelPath);
  const row = (await readCache())[modelPath];
  return row?.signature === await fingerprint(modelPath) ? row.descriptor : null;
}
async function persist(modelPath, descriptor, signature) {
  const file = cacheFile();
  const next = writes.catch(() => {}).then(async () => {
    const cache = await readCache();
    if (cache[modelPath]?.signature === signature && cache[modelPath].descriptor?.source === 'health' && descriptor.source !== 'health') return cache[modelPath].descriptor;
    cache[modelPath] = { signature, descriptor };
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(`${file}.tmp`, JSON.stringify(cache, null, 2));
    await fsp.rename(`${file}.tmp`, file);
    return descriptor;
  });
  writes = next;
  return next;
}
export async function getMtplxDescriptor(modelPath, { inspect = runMtplxJson } = {}) {
  modelPath = path.resolve(modelPath);
  const signature = await fingerprint(modelPath);
  const cached = (await readCache())[modelPath];
  if (cached?.signature === signature) return cached.descriptor;
  const key = `${cacheFile()}:${modelPath}:${signature}`;
  if (!inflight.has(key)) inflight.set(key, (async () => {
    try {
      const json = await inspect(['inspect', modelPath, '--json']);
      return await persist(modelPath, descriptorFromInspect(json, modelPath), signature);
    } catch { return fallbackMtplxDescriptor(modelPath); }
    finally { inflight.delete(key); }
  })());
  return inflight.get(key);
}
export async function recordMtplxHealthDescriptor(modelPath, health) {
  modelPath = path.resolve(modelPath);
  return persist(modelPath, descriptorFromHealth(health, modelPath), await fingerprint(modelPath));
}

export const DEFAULT_IMAGE_GENERATION_CONFIG = Object.freeze({
  enabled: false,
  providerId: '',
  adapterId: '',
  modelId: '',
  defaults: Object.freeze({}),
  maxConcurrentJobs: 1,
  timeoutSeconds: 600,
});

export const IMAGE_OPTION_KEYS = Object.freeze(['aspect_ratio', 'size', 'quality', 'format', 'background']);
export const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 32 * 1024 * 1024;

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}

export function mergeImageGenerationConfig(existing, patch) {
  const base = { ...DEFAULT_IMAGE_GENERATION_CONFIG, ...existing, defaults: { ...existing?.defaults } };
  if (patch === null) return { ...DEFAULT_IMAGE_GENERATION_CONFIG, defaults: {} };
  object(patch, 'Image generation configuration');
  for (const key of Object.keys(patch)) {
    if (!(key in DEFAULT_IMAGE_GENERATION_CONFIG)) throw new Error(`Unknown image generation setting: ${key}`);
  }
  for (const key of ['providerId', 'adapterId', 'modelId']) {
    if (patch[key] === undefined) continue;
    if (typeof patch[key] !== 'string' || patch[key].length > 200 || /[\x00-\x1f]/.test(patch[key])) throw new Error(`Invalid ${key}`);
    base[key] = patch[key].trim();
  }
  if (patch.enabled !== undefined) {
    if (typeof patch.enabled !== 'boolean') throw new Error('enabled must be boolean');
    base.enabled = patch.enabled;
  }
  for (const [key, min, max] of [['maxConcurrentJobs', 1, 4], ['timeoutSeconds', 30, 1800]]) {
    if (patch[key] === undefined) continue;
    if (!Number.isInteger(patch[key]) || patch[key] < min || patch[key] > max) throw new Error(`Invalid ${key}`);
    base[key] = patch[key];
  }
  if (patch.defaults === null) base.defaults = {};
  else if (patch.defaults !== undefined) {
    object(patch.defaults, 'Image defaults');
    for (const [key, value] of Object.entries(patch.defaults)) {
      if (!IMAGE_OPTION_KEYS.includes(key)) throw new Error(`Unsupported image default: ${key}`);
      if (value === null) delete base.defaults[key];
      else {
        if (typeof value !== 'string' || !value.trim() || value.length > 80) throw new Error(`Invalid image default: ${key}`);
        base.defaults[key] = value.trim();
      }
    }
  }
  return base;
}

export function normalizeImageRequest(raw, defaults = {}) {
  object(raw, 'Image request');
  const allowed = new Set(['prompt', 'operation', 'reference_paths', 'output_path', ...IMAGE_OPTION_KEYS]);
  for (const key of Object.keys(raw)) if (!allowed.has(key)) throw new Error(`Unsupported image argument: ${key}`);
  if (typeof raw.prompt !== 'string' || !raw.prompt.trim() || raw.prompt.length > 32000) throw new Error('prompt must contain 1–32000 characters');
  const request = { ...defaults, ...raw, operation: raw.operation ?? 'generate', reference_paths: raw.reference_paths ?? [] };
  if (!['generate', 'edit'].includes(request.operation)) throw new Error('Unsupported image operation');
  if (!Array.isArray(request.reference_paths) || request.reference_paths.length > 8 || request.reference_paths.some(p => typeof p !== 'string' || !p || p.length > 4096)) throw new Error('Invalid reference_paths');
  if (request.operation === 'edit' && !request.reference_paths.length) throw new Error('Editing requires reference_paths');
  if (request.operation === 'generate' && request.reference_paths.length) throw new Error('Use edit for reference images');
  if (request.output_path !== undefined && (typeof request.output_path !== 'string' || !request.output_path || request.output_path.length > 4096)) throw new Error('Invalid output_path');
  for (const key of IMAGE_OPTION_KEYS) if (request[key] !== undefined && (typeof request[key] !== 'string' || !request[key] || request[key].length > 80)) throw new Error(`Invalid ${key}`);
  return request;
}

export function validateImageCapabilities(request, capabilities) {
  if (!capabilities?.operations?.includes(request.operation)) throw new Error('Image operation unsupported by selected model');
  for (const key of IMAGE_OPTION_KEYS) {
    if (request[key] !== undefined && !capabilities.options?.[key]?.includes(request[key])) throw new Error(`Unsupported ${key}: ${request[key]}`);
  }
  if (request.background === 'transparent' && request.format === 'jpeg') throw new Error('Transparent images require PNG or WebP');
  if (request.size && request.aspect_ratio) throw new Error('Specify size or aspect_ratio, not both');
}

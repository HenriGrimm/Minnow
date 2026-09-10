import { deriveMessagesPathFromChat } from '../../src/lib/derive-messages-path.mjs';

/**
 * @param {'lm-studio-v0' | 'openai-v1' | 'anthropic-v1'} apiKind
 */
export function getProviderCapabilities(apiKind) {
  return {
    supportsModelLoadUnload: apiKind === 'lm-studio-v0',
  };
}

/**
 * @param {'lm-studio-v0' | 'openai-v1' | 'anthropic-v1'} apiKind
 * @param {{ modelsPath?: string, chatCompletionsPath?: string, messagesPath?: string, modelsLoadPath?: string, modelsUnloadPath?: string }} [overrides]
 */
export function getDefaultPaths(apiKind, overrides = {}) {
  const defaults =
    apiKind === 'openai-v1'
      ? {
          modelsPath: '/v1/models',
          chatCompletionsPath: '/v1/chat/completions',
          messagesPath: '/v1/messages',
          embeddingsPath: '/v1/embeddings',
        }
      : apiKind === 'anthropic-v1'
        ? {
            modelsPath: '/v1/models',
            chatCompletionsPath: '/v1/messages',
            messagesPath: '/v1/messages',
            embeddingsPath: '/v1/embeddings',
          }
        : apiKind === 'lm-studio-v0'
          ? {
              modelsPath: '/api/v0/models',
              chatCompletionsPath: '/api/v0/chat/completions',
              modelsLoadPath: '/api/v1/models/load',
              modelsUnloadPath: '/api/v1/models/unload',
            }
          : {
              // Agent CLI and other non-HTTP providers have no upstream catalog.
              modelsPath: '',
              chatCompletionsPath: '',
              embeddingsPath: '/v1/embeddings',
            };

  const out = {
    modelsPath: overrides.modelsPath || defaults.modelsPath,
    chatCompletionsPath: overrides.chatCompletionsPath || defaults.chatCompletionsPath,
    embeddingsPath: overrides.embeddingsPath || defaults.embeddingsPath || '/v1/embeddings',
  };

  if (defaults.messagesPath) {
    const chatPath = overrides.chatCompletionsPath || defaults.chatCompletionsPath;
    out.messagesPath =
      overrides.messagesPath ||
      (apiKind === 'anthropic-v1'
        ? overrides.chatCompletionsPath || defaults.messagesPath
        : deriveMessagesPathFromChat(chatPath));
  }

  if (defaults.modelsLoadPath) {
    out.modelsLoadPath = overrides.modelsLoadPath || defaults.modelsLoadPath;
    out.modelsUnloadPath = overrides.modelsUnloadPath || defaults.modelsUnloadPath;
  }

  return out;
}

/**
 * @param {unknown} item
 */
function normalizeLmStudioModelRow(item) {
  if (typeof item === 'string') {
    return { id: item, type: 'llm' };
  }
  if (!item || typeof item !== 'object' || !('id' in item)) {
    return { id: String(item), type: 'llm' };
  }

  const src = /** @type {Record<string, unknown>} */ (item);
  const id = String(src.id);
  const type = typeof src.type === 'string' ? src.type : 'llm';
  const state = typeof src.state === 'string' ? src.state : undefined;

  const upstreamCaps =
    src.capabilities && typeof src.capabilities === 'object'
      ? /** @type {Record<string, unknown>} */ (src.capabilities)
      : null;

  /** @type {boolean | undefined} */
  let catalogVision;
  if (type === 'vlm') {
    catalogVision = true;
  } else if (upstreamCaps?.vision === true) {
    catalogVision = true;
  } else if (upstreamCaps?.vision === false) {
    catalogVision = false;
  }

  let reasoning = src.reasoning;
  if (
    (!reasoning || typeof reasoning !== 'object') &&
    upstreamCaps?.reasoning &&
    typeof upstreamCaps.reasoning === 'object'
  ) {
    reasoning = upstreamCaps.reasoning;
  }

  return {
    id,
    type,
    ...(state ? { state } : {}),
    ...(typeof src.quantization === 'string' ? { quantization: src.quantization } : {}),
    ...(typeof src.arch === 'string' ? { arch: src.arch } : {}),
    ...(typeof src.max_context_length === 'number'
      ? { max_context_length: src.max_context_length }
      : {}),
    ...(typeof src.loaded_context_length === 'number'
      ? { loaded_context_length: src.loaded_context_length }
      : {}),
    ...(catalogVision !== undefined ? { catalogVision } : {}),
    ...(reasoning && typeof reasoning === 'object' ? { reasoning } : {}),
  };
}

const VISION_BOOLEAN_FIELDS = ['vision', 'supports_vision', 'supports_images', 'multimodal'];

const VISION_CAPABILITY_TOKENS = new Set([
  'vision',
  'image',
  'images',
  'image_input',
  'multimodal',
  'vlm',
]);

/**
 * @param {unknown} value
 */
function capabilityListHasVision(value) {
  if (!Array.isArray(value)) return false;
  return value.some(
    (v) => typeof v === 'string' && VISION_CAPABILITY_TOKENS.has(v.trim().toLowerCase()),
  );
}

/**
 * @param {unknown} value
 */
function modalityListHasImage(value) {
  if (!Array.isArray(value)) return false;
  return value.some((v) => typeof v === 'string' && /^images?$/i.test(v.trim()));
}

/**
 * @param {string} value
 */
function inputModalityStringHasImage(value) {
  const input = value.split('->')[0];
  return /(^|[+,\s|/])images?([+,\s|/]|$)/i.test(input);
}

/**
 * @param {Record<string, unknown>} src
 * @returns {boolean | undefined}
 */
export function openAiRowVisionFlag(src) {
  if (typeof src.type === 'string' && src.type.trim().toLowerCase() === 'vlm') {
    return true;
  }

  for (const field of VISION_BOOLEAN_FIELDS) {
    if (typeof src[field] === 'boolean') {
      return /** @type {boolean} */ (src[field]);
    }
  }

  const caps = src.capabilities;
  if (caps && typeof caps === 'object' && !Array.isArray(caps)) {
    const vision = /** @type {Record<string, unknown>} */ (caps).vision;
    if (typeof vision === 'boolean') return vision;
  }
  if (capabilityListHasVision(caps)) return true;

  const architecture =
    src.architecture && typeof src.architecture === 'object'
      ? /** @type {Record<string, unknown>} */ (src.architecture)
      : null;

  const modalityLists = [
    src.input_modalities,
    src.modalities,
    architecture?.input_modalities,
    architecture?.modalities,
  ];
  for (const list of modalityLists) {
    if (modalityListHasImage(list)) return true;
  }

  const modality = architecture?.modality ?? src.modality;
  if (typeof modality === 'string' && inputModalityStringHasImage(modality)) {
    return true;
  }

  return undefined;
}

/** @type {readonly string[]} */
const OPENAI_CONTEXT_FIELD_ALIASES = [
  'context_length',
  'context_window',
  'max_context_length',
  'max_model_len',
  'max_seq_len',
];

/**
 * @type {readonly string[]}
 */
const OPENAI_NESTED_CONTEXT_FIELD_ALIASES = [
  'n_ctx',
  'context_length',
  'context_window',
  'max_model_len',
  'n_ctx_train',
];

/**
 * @param {Record<string, unknown> | null | undefined} obj
 * @param {readonly string[]} fields
 * @returns {number | undefined}
 */
function firstPositiveContextField(obj, fields) {
  if (!obj || typeof obj !== 'object') {
    return undefined;
  }
  for (const field of fields) {
    const val = obj[field];
    if (typeof val === 'number' && Number.isFinite(val) && val > 0) {
      return val;
    }
  }
  return undefined;
}

/**
 * @param {unknown} item
 */
function normalizeOpenAiModelRow(item) {
  if (typeof item === 'string') {
    return { id: item, type: 'llm', state: 'loaded' };
  }
  if (!item || typeof item !== 'object' || !('id' in item)) {
    return { id: String(item), type: 'llm', state: 'loaded' };
  }

  const src = /** @type {Record<string, unknown>} */ (item);
  const id = String(src.id);
  const type = typeof src.type === 'string' ? src.type : 'llm';
  const state = typeof src.state === 'string' ? src.state : 'loaded';

  let maxContext = firstPositiveContextField(src, OPENAI_CONTEXT_FIELD_ALIASES);
  if (maxContext === undefined) {
    const meta =
      src.meta && typeof src.meta === 'object'
        ? /** @type {Record<string, unknown>} */ (src.meta)
        : src.model_extra && typeof src.model_extra === 'object'
          ? /** @type {Record<string, unknown>} */ (src.model_extra)
          : null;
    maxContext = firstPositiveContextField(meta, OPENAI_NESTED_CONTEXT_FIELD_ALIASES);
  }

  const catalogVision = openAiRowVisionFlag(src);

  return {
    id,
    type,
    state,
    ...(maxContext !== undefined ? { max_context_length: maxContext } : {}),
    ...(typeof src.owned_by === 'string' ? { owned_by: src.owned_by } : {}),
    ...(typeof src.arch === 'string' ? { arch: src.arch } : {}),
    ...(typeof src.family === 'string' ? { family: src.family } : {}),
    ...(catalogVision !== undefined ? { catalogVision } : {}),
  };
}

/**
 * @param {'lm-studio-v0' | 'openai-v1' | 'anthropic-v1'} apiKind
 * @param {unknown} json
 * @returns {{ data: Array<{ id: string, type?: string, state?: string, catalogVision?: boolean }> }}
 */
export function normalizeModelsResponse(apiKind, json) {
  if (!json || typeof json !== 'object') {
    return { data: [] };
  }

  if (apiKind !== 'openai-v1' && apiKind !== 'anthropic-v1') {
    const raw = Array.isArray(/** @type {{ data?: unknown }} */ (json).data)
      ? /** @type {{ data: unknown[] }} */ (json).data
      : [];
    const data =
      apiKind === 'lm-studio-v0' ? raw.map(normalizeLmStudioModelRow) : raw;
    return { data };
  }

  const raw = Array.isArray(/** @type {{ data?: unknown }} */ (json).data)
    ? /** @type {{ data: unknown[] }} */ (json).data
    : [];

  const data = raw.map(normalizeOpenAiModelRow);

  return { data };
}

const V1_MODELS_TIMEOUT_MS = 15_000;

/**
 * @param {unknown} item
 * @returns {{ allowed_options?: string[], default?: string } | undefined}
 */
function reasoningBlockFromV1ModelRow(item) {
  if (!item || typeof item !== 'object') return undefined;
  const src = /** @type {Record<string, unknown>} */ (item);
  const direct =
    src.reasoning && typeof src.reasoning === 'object'
      ? /** @type {Record<string, unknown>} */ (src.reasoning)
      : null;
  const upstreamCaps =
    src.capabilities && typeof src.capabilities === 'object'
      ? /** @type {Record<string, unknown>} */ (src.capabilities)
      : null;
  const nested =
    upstreamCaps?.reasoning && typeof upstreamCaps.reasoning === 'object'
      ? /** @type {Record<string, unknown>} */ (upstreamCaps.reasoning)
      : null;
  const block = direct ?? nested;
  if (!block) return undefined;

  const allowed_options = Array.isArray(block.allowed_options)
    ? block.allowed_options.filter((v) => typeof v === 'string')
    : undefined;
  const def = typeof block.default === 'string' ? block.default : undefined;
  if (!allowed_options?.length && !def) return undefined;
  return {
    ...(allowed_options?.length ? { allowed_options } : {}),
    ...(def ? { default: def } : {}),
  };
}

/**
 * @param {unknown} json
 * @returns {unknown[]}
 */
function v1ModelsListFromJson(json) {
  if (Array.isArray(json)) return json;
  if (!json || typeof json !== 'object') return [];
  const root = /** @type {Record<string, unknown>} */ (json);
  if (Array.isArray(root.data)) return root.data;
  if (Array.isArray(root.models)) return root.models;
  return [];
}

/**
 * @param {string} baseUrl
 * @param {Record<string, string>} headers
 * @param {{ data: Array<Record<string, unknown>> }} normalized
 */
export async function enrichLmStudioModelsWithV1Reasoning(baseUrl, headers, normalized) {
  if (!normalized?.data?.length) return normalized;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), V1_MODELS_TIMEOUT_MS);
  try {
    const root = baseUrl.replace(/\/$/, '');
    const res = await fetch(`${root}/api/v1/models`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        ...headers,
      },
      signal: controller.signal,
    });
    if (!res.ok) return normalized;

    const json = await res.json();
    const v1Rows = v1ModelsListFromJson(json);
    if (v1Rows.length === 0) return normalized;

    /** @type {Map<string, { allowed_options?: string[], default?: string }>} */
    const reasoningById = new Map();
    for (const item of v1Rows) {
      if (!item || typeof item !== 'object' || !('id' in item)) continue;
      const id = String(/** @type {{ id: unknown }} */ (item).id);
      const block = reasoningBlockFromV1ModelRow(item);
      if (block) reasoningById.set(id, block);
    }
    if (reasoningById.size === 0) return normalized;

    const data = normalized.data.map((row) => {
      const existing =
        row.reasoning && typeof row.reasoning === 'object'
          ? /** @type {{ allowed_options?: unknown[] }} */ (row.reasoning)
          : null;
      const hasAllowed =
        Array.isArray(existing?.allowed_options) && existing.allowed_options.length > 0;
      if (hasAllowed) return row;

      const id = typeof row.id === 'string' ? row.id : String(row.id ?? '');
      const fromV1 = reasoningById.get(id);
      if (!fromV1) return row;

      return {
        ...row,
        reasoning: {
          ...(existing && typeof existing === 'object' ? existing : {}),
          ...fromV1,
        },
      };
    });

    return { data };
  } catch {
    return normalized;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * OpenCode Go models that must use OpenAI Responses (`/v1/responses`).
 * Chat/completions on these ids returns HTTP 500 (MIN-855).
 *
 * Gating is Go-only: Zen still converts GPT traffic internally and must not reroute.
 */

/**
 * True when the provider origin is OpenCode Go (`/zen/go`), not Zen.
 *
 * @param {string | null | undefined} baseUrl
 * @returns {boolean}
 */
export function isOpenCodeGoBaseUrl(baseUrl) {
  const raw = typeof baseUrl === 'string' ? baseUrl.trim() : '';
  if (!raw) return false;
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    if (host !== 'opencode.ai' && !host.endsWith('.opencode.ai')) return false;
    const path = url.pathname.toLowerCase().replace(/\/+$/, '') || '/';
    return path === '/zen/go' || path.startsWith('/zen/go/');
  } catch {
    return false;
  }
}

/**
 * Bare model id without an `opencode-go/` (or similar) prefix.
 *
 * @param {string} modelId
 * @returns {string}
 */
function bareModelId(modelId) {
  const raw = String(modelId || '')
    .trim()
    .toLowerCase();
  if (!raw) return '';
  const slash = raw.lastIndexOf('/');
  return slash >= 0 ? raw.slice(slash + 1) : raw;
}

/**
 * Muse Spark models do not accept Responses `reasoning.effort: "none"`.
 *
 * @param {string} modelId
 * @returns {boolean}
 */
export function isMuseSparkModel(modelId) {
  const id = bareModelId(modelId).replace(/[._]/g, '-');
  return /^muse-spark-1-[23](-contributor)?(-free)?$/.test(id);
}

/**
 * True for Muse Spark 1.2/1.3, GPT 5.6 Luna, and Grok 4.6 — Go's Responses-only models.
 *
 * @param {string} modelId
 * @returns {boolean}
 */
export function modelLooksOpenAiResponses(modelId) {
  const id = bareModelId(modelId).replace(/[._]/g, '-');
  if (!id) return false;
  if (isMuseSparkModel(modelId)) return true;
  if (id === 'gpt-5-6-luna') return true;
  if (id === 'grok-4-6') return true;
  return false;
}

/**
 * Route this (base URL, model) pair through `/v1/responses` instead of chat/completions.
 *
 * @param {string | null | undefined} baseUrl
 * @param {string} modelId
 * @returns {boolean}
 */
export function shouldUseOpenAiResponses(baseUrl, modelId) {
  return isOpenCodeGoBaseUrl(baseUrl) && modelLooksOpenAiResponses(modelId);
}

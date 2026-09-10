import { detectQuotaExhausted, isQuotaExhaustedText } from './quota-error.js';

/** @typedef {'default' | 'utility' | 'vision' | 'research'} FallbackRole */

/** @typedef {{ providerId: string, modelId: string }} FallbackCandidate */

export const FALLBACK_ROLES = ['default', 'utility', 'vision', 'research'];

const LEGACY_FALLBACK_KEY_ALIASES = {
  default: 'main-chat',
  utility: 'chat-titles',
};

const GLOBAL_FALLBACK_CHAIN_KEY = '_global';

const ABSOLUTE_MAX_CHAIN_LENGTH = 8;

/**
 * @param {string} roleKey
 * @param {Record<string, FallbackCandidate[]>} roles
 * @returns {FallbackCandidate[]}
 */
function resolveRoleChain(roleKey, roles) {
  const direct = roles[roleKey];
  if (Array.isArray(direct) && direct.length > 0) {
    return direct;
  }
  const normalized = LEGACY_FALLBACK_KEY_ALIASES[roleKey] ?? roleKey;
  const fromNormalized = roles[normalized];
  if (Array.isArray(fromNormalized) && fromNormalized.length > 0) {
    return fromNormalized;
  }
  for (const [legacyKey, mapped] of Object.entries(LEGACY_FALLBACK_KEY_ALIASES)) {
    if (mapped !== normalized) continue;
    const fromLegacy = roles[legacyKey];
    if (Array.isArray(fromLegacy) && fromLegacy.length > 0) {
      return fromLegacy;
    }
  }
  return [];
}

const RETRYABLE_NODE_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ETIMEDOUT',
  'ECONNRESET',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

const RATE_LIMIT_HTTP_STATUSES = new Set([408, 425, 429, 529]);

const RETRYABLE_HTTP_STATUSES = new Set([502, 503, 504, ...RATE_LIMIT_HTTP_STATUSES]);

export const MAX_SAME_CANDIDATE_ATTEMPTS = 3;

const RETRY_BASE_DELAY_MS = 1_000;

const RETRY_MAX_DELAY_MS = 30_000;

/**
 * @param {string | null | undefined} value
 * @param {number} [nowMs]
 * @returns {number | null}
 */
export function parseRetryAfterMs(value, nowMs = Date.now()) {
  const raw = parseRetryAfterRawMs(value, nowMs);
  return raw === null ? null : Math.min(raw, RETRY_MAX_DELAY_MS);
}

/**
 * The header's own wait, uncapped. Backoff must use {@link parseRetryAfterMs};
 * only quota detection needs to see a wait longer than a turn can survive.
 * @param {string | null | undefined} value
 * @param {number} [nowMs]
 * @returns {number | null}
 */
function parseRetryAfterRawMs(value, nowMs = Date.now()) {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw) return null;

  if (/^\d+(\.\d+)?$/.test(raw)) {
    const seconds = Number(raw);
    if (!Number.isFinite(seconds) || seconds < 0) return null;
    return Math.round(seconds * 1000);
  }

  if (!/[a-z]/i.test(raw)) return null;
  const at = Date.parse(raw);
  if (Number.isNaN(at)) return null;
  return Math.max(at - nowMs, 0);
}

/**
 * @param {number} attempt
 * @param {number | null | undefined} [retryAfterMs]
 * @returns {number}
 */
export function computeRetryDelayMs(attempt, retryAfterMs) {
  if (typeof retryAfterMs === 'number' && retryAfterMs >= 0) {
    return Math.min(retryAfterMs, RETRY_MAX_DELAY_MS);
  }
  const exponential = RETRY_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1);
  const jitter = Math.random() * RETRY_BASE_DELAY_MS;
  return Math.min(Math.round(exponential + jitter), RETRY_MAX_DELAY_MS);
}

/**
 * @param {unknown} response
 * @returns {string | null}
 */
function readRetryAfterHeader(response) {
  if (!response || typeof response !== 'object') return null;
  const headers = /** @type {{ headers?: unknown }} */ (response).headers;
  if (headers && typeof (/** @type {Headers} */ (headers).get) === 'function') {
    return /** @type {Headers} */ (headers).get('retry-after');
  }
  if (headers && typeof headers === 'object') {
    const record = /** @type {Record<string, unknown>} */ (headers);
    const value = record['retry-after'] ?? record['Retry-After'];
    return typeof value === 'string' ? value : null;
  }
  return null;
}

/**
 * @param {unknown} config
 * @returns {{ enabled: boolean, cooldownSeconds: number, maxChainLength: number, roles: Record<string, FallbackCandidate[]> }}
 */
export function readFallbackChainsConfig(config) {
  const block =
    config && typeof config === 'object' && config.fallbackChains && typeof config.fallbackChains === 'object'
      ? /** @type {Record<string, unknown>} */ (config.fallbackChains)
      : {};

  const roles = {};
  if (block.roles && typeof block.roles === 'object') {
    for (const [role, entries] of Object.entries(/** @type {Record<string, unknown>} */ (block.roles))) {
      if (!Array.isArray(entries)) continue;
      roles[role] = entries
        .map((entry) => normalizeCandidate(entry))
        .filter((entry) => entry !== null);
    }
  }

  return {
    enabled: block.enabled === true,
    cooldownSeconds:
      typeof block.cooldownSeconds === 'number' && Number.isFinite(block.cooldownSeconds)
        ? block.cooldownSeconds
        : 60,
    maxChainLength:
      typeof block.maxChainLength === 'number' && Number.isFinite(block.maxChainLength)
        ? block.maxChainLength
        : 4,
    roles,
  };
}

/**
 * @param {unknown} entry
 * @returns {FallbackCandidate | null}
 */
function normalizeCandidate(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const row = /** @type {Record<string, unknown>} */ (entry);
  if (typeof row.providerId !== 'string' || !row.providerId.trim()) return null;
  return {
    providerId: row.providerId.trim(),
    modelId: typeof row.modelId === 'string' ? row.modelId : '',
  };
}

/**
 * @param {string} providerId
 * @param {string} modelId
 * @returns {string}
 */
export function candidateKey(providerId, modelId) {
  return `${providerId}:${modelId}`;
}

/**
 * @param {{ role?: string | null, primaryProviderId: string, primaryModelId?: string, config?: unknown, enabledProviderIds?: Set<string> | string[], }} params
 * @returns {FallbackCandidate[]}
 */
export function resolveFallbackChain({
  role,
  primaryProviderId,
  primaryModelId = '',
  config,
  enabledProviderIds,
}) {
  const primaryModel = typeof primaryModelId === 'string' ? primaryModelId : '';
  const primary = {
    providerId: primaryProviderId,
    modelId: primaryModel,
  };

  const fallback = readFallbackChainsConfig(config);
  if (!fallback.enabled) {
    return [primary];
  }

  const enabled = toEnabledSet(enabledProviderIds);
  const roleKey = typeof role === 'string' && role.trim() ? role.trim() : 'main-chat';
  const roleChain = resolveRoleChain(roleKey, fallback.roles);

  /** @type {FallbackCandidate[]} */
  const ordered = [];
  const seen = new Set();

  const pushCandidate = (candidate) => {
    if (!candidate.providerId) return;
    if (enabled && !enabled.has(candidate.providerId)) return;
    const modelId =
      typeof candidate.modelId === 'string' && candidate.modelId.trim()
        ? candidate.modelId.trim()
        : primaryModel;
    const key = candidateKey(candidate.providerId, modelId);
    if (seen.has(key)) return;
    seen.add(key);
    ordered.push({ providerId: candidate.providerId, modelId });
  };

  pushCandidate(primary);
  for (const step of roleChain) {
    pushCandidate(step);
    if (ordered.length >= fallback.maxChainLength) break;
  }

  const globalChain = resolveRoleChain(GLOBAL_FALLBACK_CHAIN_KEY, fallback.roles);
  for (const step of globalChain) {
    pushCandidate(step);
    if (ordered.length >= ABSOLUTE_MAX_CHAIN_LENGTH) break;
  }

  if (ordered.length === 0) {
    return [primary];
  }

  return ordered.slice(0, ABSOLUTE_MAX_CHAIN_LENGTH);
}

/**
 * @param {Set<string> | string[] | undefined} enabledProviderIds
 * @returns {Set<string> | null}
 */
function toEnabledSet(enabledProviderIds) {
  if (!enabledProviderIds) return null;
  if (enabledProviderIds instanceof Set) return enabledProviderIds;
  if (Array.isArray(enabledProviderIds)) {
    return new Set(enabledProviderIds.filter((id) => typeof id === 'string' && id.trim()));
  }
  return null;
}

/**
 * @param {unknown} err
 * @param {{ status?: number, headers?: unknown } | null | undefined} [response]
 * @param {string} [rawBody] the response body, when the caller already read it
 * @returns {{
 *   kind: 'retryable' | 'fatal',
 *   reason: string,
 *   rateLimited?: boolean,
 *   retryAfterMs?: number,
 *   quotaExceeded?: boolean,
 * }}
 */
export function classifyUpstreamError(err, response, rawBody) {
  const status = response?.status;

  if (typeof status === 'number') {
    if (status === 401 || status === 403) {
      return { kind: 'fatal', reason: `Upstream HTTP ${status} (auth)` };
    }
    if (status === 400) {
      return { kind: 'fatal', reason: 'Upstream HTTP 400 (bad request / model not found)' };
    }
    if (status === 422) {
      return { kind: 'fatal', reason: 'Upstream HTTP 422 (validation)' };
    }
    if (RATE_LIMIT_HTTP_STATUSES.has(status) || status === 402) {
      const header = readRetryAfterHeader(response);
      // A spent allowance is not backpressure: retrying it only burns attempts.
      if (
        detectQuotaExhausted({
          status,
          body: rawBody,
          retryAfterMs: parseRetryAfterRawMs(header),
        })
      ) {
        return {
          kind: 'fatal',
          reason: `Upstream HTTP ${status} (out of usage)`,
          quotaExceeded: true,
        };
      }
      if (status === 402) {
        return { kind: 'fatal', reason: 'Upstream HTTP 402 (payment required)', quotaExceeded: true };
      }
      const retryAfterMs = parseRetryAfterMs(header);
      return {
        kind: 'retryable',
        reason: `Upstream HTTP ${status}`,
        rateLimited: true,
        ...(retryAfterMs == null ? {} : { retryAfterMs }),
      };
    }
    if (RETRYABLE_HTTP_STATUSES.has(status)) {
      return { kind: 'retryable', reason: `Upstream HTTP ${status}` };
    }
    if (status >= 500) {
      return { kind: 'retryable', reason: `Upstream HTTP ${status}` };
    }
    return { kind: 'fatal', reason: `Upstream HTTP ${status}` };
  }

  if (err && typeof err === 'object') {
    const e = /** @type {{ name?: string, code?: string, message?: string, cause?: unknown }} */ (err);
    if (e.name === 'AbortError') {
      return { kind: 'fatal', reason: 'Request aborted' };
    }
    if (typeof e.code === 'string' && RETRYABLE_NODE_CODES.has(e.code)) {
      return { kind: 'retryable', reason: e.code };
    }
    if (e.cause) {
      return classifyUpstreamError(e.cause, response, rawBody);
    }
    const message = typeof e.message === 'string' ? e.message : String(err);
    if (isQuotaExhaustedText(message)) {
      return { kind: 'fatal', reason: message, quotaExceeded: true };
    }
    const lower = message.toLowerCase();
    if (
      lower.includes('econnrefused') ||
      lower.includes('enotfound') ||
      lower.includes('etimedout') ||
      lower.includes('fetch failed') ||
      lower.includes('network')
    ) {
      return { kind: 'retryable', reason: message };
    }
    return { kind: 'fatal', reason: message };
  }

  return { kind: 'fatal', reason: String(err) };
}

/**
 * @param {Buffer} requestBody
 * @param {string} modelId
 * @returns {Buffer}
 */
export function buildCandidateRequestBody(requestBody, modelId) {
  if (!modelId) return requestBody;
  try {
    const parsed = JSON.parse(requestBody.toString('utf8'));
    if (!parsed || typeof parsed !== 'object') return requestBody;
    return Buffer.from(JSON.stringify({ ...parsed, model: modelId }), 'utf8');
  } catch {
    return requestBody;
  }
}

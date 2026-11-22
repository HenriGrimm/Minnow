/**
 * Sanitize Anthropic Messages requests for third-party gateways (e.g. OpenCode Zen).
 * The AI SDK adds betas such as structured-outputs that Console proxies reject with 400.
 */

import { isAnthropicGatewayBaseUrl } from '../../../src/lib/anthropic-thinking-style.mjs';
import { mergeOpenCodeIdentityHeaders } from '../../providers/opencode-identity.js';

/** Beta features stripped before POST to non-native Anthropic gateways. */
export const GATEWAY_STRIPPED_BETAS = new Set([
  'structured-outputs-2025-11-13',
  'advanced-tool-use-2025-11-20',
]);

/**
 * @param {string | undefined} headerValue
 * @returns {string | undefined}
 */
export function stripAnthropicGatewayBetas(headerValue) {
  if (!headerValue || typeof headerValue !== 'string') return undefined;
  const parts = headerValue
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part && !GATEWAY_STRIPPED_BETAS.has(part.toLowerCase()));
  return parts.length > 0 ? parts.join(',') : undefined;
}

/**
 * @param {HeadersInit | undefined} headers
 * @returns {Record<string, string>}
 */
function headersToRecord(headers) {
  if (!headers) return {};
  if (headers instanceof Headers) {
    /** @type {Record<string, string>} */
    const out = {};
    headers.forEach((value, key) => {
      out[key] = value;
    });
    return out;
  }
  if (Array.isArray(headers)) {
    /** @type {Record<string, string>} */
    const out = {};
    for (const [key, value] of headers) {
      out[key] = value;
    }
    return out;
  }
  return { ...headers };
}

/**
 * @param {Set<string>} betas
 */
export function stripAnthropicGatewayBetasFromSet(betas) {
  if (!betas || typeof betas[Symbol.iterator] !== 'function') return;
  for (const beta of [...betas]) {
    if (GATEWAY_STRIPPED_BETAS.has(String(beta).trim().toLowerCase())) {
      betas.delete(beta);
    }
  }
}

/**
 * Remove JSON Schema keywords Anthropic gateways often reject on tool input_schema.
 * @param {unknown} schema
 * @returns {unknown}
 */
export function sanitizeAnthropicGatewayInputSchema(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return schema;
  }

  const record = /** @type {Record<string, unknown>} */ ({ ...schema });
  delete record.$schema;
  delete record.$id;
  delete record.$defs;
  delete record.$ref;
  delete record.$comment;
  delete record.definitions;
  delete record.additionalProperties;
  delete record.maxItems;
  delete record.minLength;
  delete record.maxLength;
  delete record.minimum;
  delete record.maximum;
  delete record.multipleOf;
  delete record.uniqueItems;

  if (record.type === 'string' && typeof record.pattern === 'string') {
    delete record.pattern;
  }

  if (typeof record.minItems === 'number' && record.minItems > 1) {
    delete record.minItems;
  }

  if (record.properties && typeof record.properties === 'object' && !Array.isArray(record.properties)) {
    /** @type {Record<string, unknown>} */
    const properties = {};
    for (const [key, value] of Object.entries(
      /** @type {Record<string, unknown>} */ (record.properties),
    )) {
      properties[key] = sanitizeAnthropicGatewayInputSchema(value);
    }
    record.properties = properties;
  }

  if (record.items) {
    record.items = sanitizeAnthropicGatewayInputSchema(record.items);
  }

  for (const combiner of ['anyOf', 'oneOf', 'allOf']) {
    if (Array.isArray(record[combiner])) {
      record[combiner] = record[combiner].map(sanitizeAnthropicGatewayInputSchema);
    }
  }

  return record;
}

/**
 * @param {unknown} tool
 * @returns {unknown}
 */
function sanitizeGatewayToolEntry(tool) {
  if (!tool || typeof tool !== 'object') return tool;
  const record = /** @type {Record<string, unknown>} */ ({ ...tool });
  delete record.eager_input_streaming;
  delete record.strict;
  if (record.input_schema) {
    record.input_schema = sanitizeAnthropicGatewayInputSchema(record.input_schema);
  }
  return record;
}

/**
 * @param {unknown} body
 * @returns {unknown}
 */
export function sanitizeAnthropicGatewayRequestBody(body) {
  if (!body || typeof body !== 'object') return body;
  const next = { .../** @type {Record<string, unknown>} */ (body) };

  if (next.thinking && typeof next.thinking === 'object') {
    const thinking = /** @type {Record<string, unknown>} */ (next.thinking);
    if (thinking.type === 'disabled') {
      delete next.thinking;
    }
  }

  delete next.output_config;

  if (Array.isArray(next.tools)) {
    next.tools = next.tools.map(sanitizeGatewayToolEntry);
  }

  if (next.tool_choice && typeof next.tool_choice === 'object') {
    const toolChoice = { .../** @type {Record<string, unknown>} */ (next.tool_choice) };
    delete toolChoice.disable_parallel_tool_use;
    next.tool_choice = toolChoice;
  }

  return next;
}

/**
 * @param {RequestInit | undefined} init
 * @returns {RequestInit | undefined}
 */
export function sanitizeAnthropicGatewayRequestInit(init) {
  if (!init) return init;

  /** @type {RequestInit} */
  const next = { ...init };
  const headers = headersToRecord(init.headers);
  const betaKey = Object.keys(headers).find((key) => key.toLowerCase() === 'anthropic-beta');

  if (betaKey) {
    const stripped = stripAnthropicGatewayBetas(headers[betaKey]);
    if (stripped) headers[betaKey] = stripped;
    else delete headers[betaKey];
  }

  next.headers = headers;

  if (typeof init.body === 'string') {
    try {
      const parsed = sanitizeAnthropicGatewayRequestBody(JSON.parse(init.body));
      next.body = JSON.stringify(parsed);
    } catch {
      next.body = init.body;
    }
  }

  return next;
}

/**
 * @param {string | undefined | null} baseUrl
 * @param {typeof fetch} [fetchImpl]
 * @param {{ sessionId?: string | null }} [options]
 * @returns {typeof fetch}
 */
export function createAnthropicGatewayFetch(
  baseUrl,
  fetchImpl = globalThis.fetch,
  options = {},
) {
  if (!isAnthropicGatewayBaseUrl(baseUrl)) {
    return fetchImpl;
  }

  return async (input, init) => {
    const sanitized = sanitizeAnthropicGatewayRequestInit(init);
    if (sanitized) {
      // Last writer: overwrite ai-sdk/anthropic User-Agent on OpenCode hosts.
      sanitized.headers = mergeOpenCodeIdentityHeaders(
        /** @type {Record<string, string>} */ (sanitized.headers),
        { baseUrl, sessionId: options.sessionId },
      );
    }
    return fetchImpl(input, sanitized);
  };
}

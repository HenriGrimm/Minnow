import { anthropicReasoningBlocks } from './anthropic-reasoning.mjs';

/**
 * Anthropic extended-thinking style by model id (mirrors @ai-sdk/anthropic getModelCapabilities).
 * Newer Claude families require `thinking.type: adaptive` instead of `enabled` + budget_tokens.
 */

/**
 * @param {string | undefined | null} modelId
 * @returns {boolean}
 */
export function anthropicModelUsesAdaptiveThinking(modelId) {
  const id = String(modelId ?? '')
    .trim()
    .toLowerCase();
  if (!id.includes('claude')) return false;

  return (
    id.includes('claude-opus-5') ||
    id.includes('claude-opus-4-8') ||
    id.includes('claude-opus-4-7') ||
    id.includes('claude-fable-5') ||
    id.includes('claude-sonnet-5') ||
    id.includes('claude-sonnet-4-6') ||
    id.includes('claude-opus-4-6')
  );
}

/**
 * Map legacy enabled-mode budget tokens to adaptive effort when normalizing requests.
 * @param {number | undefined} budgetTokens
 * @returns {'low' | 'medium' | 'high'}
 */
export function anthropicBudgetTokensToEffort(budgetTokens) {
  if (typeof budgetTokens !== 'number' || !Number.isFinite(budgetTokens)) {
    return 'medium';
  }
  if (budgetTokens <= 2048) return 'low';
  if (budgetTokens <= 10240) return 'medium';
  return 'high';
}

/**
 * Normalize providerOptions.anthropic.thinking for models that require adaptive mode.
 * @param {string | undefined} modelId
 * @param {Record<string, Record<string, unknown>> | undefined} providerOptions
 * @returns {Record<string, Record<string, unknown>> | undefined}
 */
export function normalizeAnthropicProviderOptions(modelId, providerOptions) {
  if (!providerOptions?.anthropic) return providerOptions;
  if (!anthropicModelUsesAdaptiveThinking(modelId)) return providerOptions;

  const anthropic = { ...providerOptions.anthropic };
  const thinking = anthropic.thinking;
  if (!thinking || typeof thinking !== 'object') {
    return providerOptions;
  }

  const thinkingRecord = /** @type {Record<string, unknown>} */ (thinking);
  if (thinkingRecord.type !== 'enabled') {
    return providerOptions;
  }

  const budgetRaw = thinkingRecord.budgetTokens ?? thinkingRecord.budget_tokens;
  const budgetTokens = typeof budgetRaw === 'number' ? budgetRaw : undefined;

  anthropic.thinking = { type: 'adaptive' };
  if (!anthropic.effort) {
    anthropic.effort = anthropicBudgetTokensToEffort(budgetTokens);
  }

  return { ...providerOptions, anthropic };
}

/**
 * True when replayed history has assistant tool_calls without Anthropic thinking signatures.
 * Follow-up requests with thinking enabled would 400 without signatures or a disabled override.
 *
 * @param {unknown} messages
 * @returns {boolean}
 */
export function anthropicHistoryHasUnsignedToolCalls(messages) {
  if (!Array.isArray(messages)) return false;
  // Only the current tool round requires a signed replay. Older user turns
  // may have been produced without thinking or by another provider.
  for (const msg of [...messages].reverse()) {
    if (!msg || typeof msg !== 'object') continue;
    if (msg.role === 'user') break;
    if (msg.role !== 'assistant') continue;
    if (!Array.isArray(msg.tool_calls) || msg.tool_calls.length === 0) continue;
    const signature =
      typeof msg.reasoning_signature === 'string' ? msg.reasoning_signature.trim() : '';
    if (!signature && anthropicReasoningBlocks(msg.reasoning_blocks).length === 0) return true;
  }
  return false;
}

/**
 * @param {string | undefined} modelId
 * @param {Record<string, Record<string, unknown>> | undefined} providerOptions
 * @returns {'enabled' | 'disabled' | 'adaptive' | null}
 */
export function anthropicThinkingTypeFromProviderOptions(modelId, providerOptions) {
  const thinking = providerOptions?.anthropic?.thinking;
  if (!thinking || typeof thinking !== 'object') {
    return null;
  }
  const type = /** @type {Record<string, unknown>} */ (thinking).type;
  if (type === 'enabled' || type === 'disabled' || type === 'adaptive') {
    return type;
  }
  return null;
}

/**
 * @param {string | undefined | null} baseUrl
 * @returns {boolean}
 */
export function isAnthropicGatewayBaseUrl(baseUrl) {
  const raw = String(baseUrl ?? '').trim();
  if (!raw) return false;
  try {
    const host = new URL(raw).hostname.toLowerCase();
    return host !== 'api.anthropic.com';
  } catch {
    return true;
  }
}

/**
 * @param {Record<string, unknown>} body
 * @returns {boolean}
 */
export function hasOutboundAnthropicTools(body) {
  return Array.isArray(body.tools) && body.tools.length > 0;
}

/**
 * Preserve requested thinking through gateways; strip only compatibility
 * fields independently of thinking and its signed tool history.
 *
 * @param {string | undefined | null} baseUrl
 * @param {Record<string, unknown>} body
 * @returns {Record<string, unknown>}
 */
export function adjustAnthropicRequestForGateway(baseUrl, body) {
  if (!isAnthropicGatewayBaseUrl(baseUrl)) {
    return body;
  }

  const next = { ...body };
  const providerOptions =
    next.providerOptions && typeof next.providerOptions === 'object'
      ? { .../** @type {Record<string, Record<string, unknown>>} */ (next.providerOptions) }
      : {};

  const anthropic = { ...(providerOptions.anthropic || {}) };
  delete anthropic.effort;

  if (hasOutboundAnthropicTools(next)) {
    delete anthropic.structuredOutputMode;
    delete anthropic.disableParallelToolUse;
    anthropic.toolStreaming = false;
  }

  if (anthropic.thinking && typeof anthropic.thinking === 'object') {
    const thinking = /** @type {Record<string, unknown>} */ (anthropic.thinking);
    if (thinking.type === 'disabled') {
      delete anthropic.thinking;
    }
  }

  providerOptions.anthropic = anthropic;
  next.providerOptions = providerOptions;
  delete next.temperature;
  delete next.top_p;
  delete next.top_k;
  return next;
}

/**
 * Disable thinking when tool-loop history cannot be replayed with signatures.
 *
 * @param {string | undefined} modelId
 * @param {Record<string, unknown>} body
 * @returns {Record<string, unknown>}
 */
export function adjustAnthropicThinkingForToolHistory(modelId, body) {
  if (!anthropicHistoryHasUnsignedToolCalls(body.messages)) {
    return body;
  }

  const providerOptions =
    body.providerOptions && typeof body.providerOptions === 'object'
      ? { .../** @type {Record<string, Record<string, unknown>>} */ (body.providerOptions) }
      : {};

  const anthropic = { ...(providerOptions.anthropic || {}) };
  delete anthropic.thinking;
  delete anthropic.effort;
  providerOptions.anthropic = anthropic;

  const next = { ...body, providerOptions };
  delete next.thinking;
  delete next.temperature;
  delete next.top_p;
  delete next.top_k;
  return next;
}

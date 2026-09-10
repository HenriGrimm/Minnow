/**
 * Anthropic Messages bridge — OpenAI Chat Completions in, OpenAI SSE out.
 */

import { APICallError } from '@ai-sdk/provider';
import { generateText as defaultGenerateText, streamText as defaultStreamText } from 'ai';
import { classifyUpstreamError } from '../fallback.js';
import { isHostDead, originFromUrl } from '../host-cooldown.js';
import {
  appendChunk,
  markComplete,
  markError,
  markStreaming,
  noteGenerationCandidateChosen,
} from '../store.js';
import { generationTimeoutMessage } from '../timeouts.js';
import { formatUpstreamHttpErrorMessage } from '../upstream-error-detail.js';
import { openAiMessagesToCoreMessages } from './openai-to-core-messages.js';
import {
  createOpenAiSseEncoder,
  encodeNonStreamingCompletion,
  encodeOpenAiSseDone,
  encodeUsageSseChunk,
} from './openai-sse-encoder.js';
import { mapOpenAiToolChoice, mapOpenAiTools } from './openai-tools.js';
import {
  buildAnthropicProvider as defaultBuildAnthropicProvider,
  deriveAnthropicBaseUrl,
} from './provider-runtime.js';
import {
  adjustAnthropicRequestForGateway,
  adjustAnthropicThinkingForToolHistory,
  anthropicThinkingTypeFromProviderOptions,
  normalizeAnthropicProviderOptions,
} from '../../../src/lib/anthropic-thinking-style.mjs';
import { openCodeSessionIdForGeneration } from '../../providers/opencode-identity.js';

export { deriveAnthropicBaseUrl };

/** @type {typeof defaultGenerateText} */
let generateText = defaultGenerateText;
/** @type {typeof defaultStreamText} */
let streamText = defaultStreamText;
/** @type {typeof defaultBuildAnthropicProvider} */
let buildAnthropicProvider = defaultBuildAnthropicProvider;

/**
 * Test hook: override AI SDK entry points without module mocking.
 * @param {{
 *   generateText?: typeof defaultGenerateText,
 *   streamText?: typeof defaultStreamText,
 *   buildAnthropicProvider?: typeof defaultBuildAnthropicProvider,
 * }} mocks
 */
export function __setAnthropicPumpMocksForTests(mocks = {}) {
  if (mocks.generateText) generateText = mocks.generateText;
  if (mocks.streamText) streamText = mocks.streamText;
  if (mocks.buildAnthropicProvider) buildAnthropicProvider = mocks.buildAnthropicProvider;
}

/** Restore production AI SDK bindings after tests. */
export function __resetAnthropicPumpMocksForTests() {
  generateText = defaultGenerateText;
  streamText = defaultStreamText;
  buildAnthropicProvider = defaultBuildAnthropicProvider;
}

/**
 * @param {Record<string, unknown>} body
 * @returns {import('@ai-sdk/provider-utils').ProviderOptions | undefined}
 */
function buildProviderOptions(body) {
  /** @type {Record<string, Record<string, unknown>>} */
  const options = {};

  if (body.providerOptions && typeof body.providerOptions === 'object') {
    for (const [provider, value] of Object.entries(
      /** @type {Record<string, unknown>} */ (body.providerOptions),
    )) {
      if (value && typeof value === 'object') {
        options[provider] = { .../** @type {Record<string, unknown>} */ (value) };
      }
    }
  }

  if (body.thinking && typeof body.thinking === 'object') {
    options.anthropic = {
      ...(options.anthropic || {}),
      thinking: body.thinking,
    };
  }

  const modelId = typeof body.model === 'string' ? body.model : '';
  return normalizeAnthropicProviderOptions(modelId, Object.keys(options).length > 0 ? options : undefined);
}

/**
 * Map OpenAI `stop` (string or array) to AI SDK `stopSequences` (max 8 entries).
 * @param {Record<string, unknown>} body
 * @returns {string[] | undefined}
 */
function openAiStopToStopSequences(body) {
  const raw = body.stop;
  if (raw == null) return undefined;
  const list = Array.isArray(raw) ? raw : [raw];
  const sequences = list
    .filter((entry) => typeof entry === 'string' && entry.length > 0)
    .slice(0, 8);
  return sequences.length > 0 ? sequences : undefined;
}

/**
 * @param {Record<string, unknown>} body
 * @param {import('@ai-sdk/provider-utils').ProviderOptions | undefined} providerOptions
 * @returns {boolean}
 */
function anthropicThinkingActive(body, providerOptions) {
  const fromOptions = anthropicThinkingTypeFromProviderOptions(
    typeof body.model === 'string' ? body.model : '',
    providerOptions,
  );
  if (fromOptions === 'enabled' || fromOptions === 'adaptive') {
    return true;
  }
  const thinking = body.thinking;
  if (!thinking || typeof thinking !== 'object') {
    return false;
  }
  const type = /** @type {Record<string, unknown>} */ (thinking).type;
  return type === 'enabled' || type === 'adaptive';
}

/**
 * @param {Record<string, unknown>} body
 * @param {import('@ai-sdk/anthropic').AnthropicProvider} provider
 * @param {AbortSignal} abortSignal
 * @returns {Record<string, unknown>}
 */
function buildGenerationCallOptions(body, provider, abortSignal) {
  const modelId = typeof body.model === 'string' ? body.model : '';
  const messages = openAiMessagesToCoreMessages(body.messages);
  const tools = mapOpenAiTools(body.tools);
  const toolChoice = mapOpenAiToolChoice(body.tool_choice);
  const providerOptions = buildProviderOptions(body);
  const thinkingActive = anthropicThinkingActive(body, providerOptions);

  /** @type {Record<string, unknown>} */
  const options = {
    model: provider(modelId),
    messages,
    abortSignal,
    allowSystemInMessages: true,
  };

  if (tools) {
    options.tools = tools;
    if (toolChoice) options.toolChoice = toolChoice;
  }
  if (typeof body.max_tokens === 'number') {
    options.maxOutputTokens = body.max_tokens;
  }
  if (!thinkingActive && typeof body.temperature === 'number') {
    options.temperature = body.temperature;
  }
  if (!thinkingActive && typeof body.top_p === 'number') {
    options.topP = body.top_p;
  }
  if (providerOptions) {
    options.providerOptions = providerOptions;
  }
  const stopSequences = openAiStopToStopSequences(body);
  if (stopSequences) {
    options.stopSequences = stopSequences;
  }

  return options;
}

/**
 * @param {unknown} err
 * @returns {{
 *   kind: 'retryable' | 'fatal',
 *   message: string,
 *   rateLimited?: boolean,
 *   retryAfterMs?: number,
 *   quotaExceeded?: boolean,
 * }}
 */
function classifySdkError(err) {
  if (err instanceof APICallError || (err && typeof err === 'object' && err.name === 'APICallError')) {
    const apiErr = /** @type {APICallError} */ (err);
    const status = apiErr.statusCode;
    const message = formatUpstreamHttpErrorMessage(
      status || 500,
      typeof apiErr.responseBody === 'string' ? apiErr.responseBody : apiErr.message,
    );
    const classified = classifyUpstreamError(
      err,
      typeof status === 'number'
        ? { status, headers: apiErr.responseHeaders }
        : undefined,
      typeof apiErr.responseBody === 'string' ? apiErr.responseBody : apiErr.message,
    );
    return {
      kind: classified.kind,
      message,
      rateLimited: classified.rateLimited,
      retryAfterMs: classified.retryAfterMs,
      quotaExceeded: classified.quotaExceeded,
    };
  }
  const classified = classifyUpstreamError(err);
  return {
    kind: classified.kind,
    message: classified.reason,
    quotaExceeded: classified.quotaExceeded,
  };
}

/**
 * Drop response_format — the v1 bridge does not map structured output yet.
 * @param {Buffer} requestBody
 * @returns {Record<string, unknown>}
 */
function parseOpenAiRequestBody(requestBody) {
  const parsed = JSON.parse(requestBody.toString('utf8'));
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Invalid chat completion request body');
  }
  if ('response_format' in parsed) {
    const { response_format: _ignored, ...rest } = /** @type {Record<string, unknown>} */ (parsed);
    return rest;
  }
  return /** @type {Record<string, unknown>} */ (parsed);
}

/**
 * retrySameCandidate is false after a stall so we do not spend the full timeout budget twice.
 *
 * @param {{
 *   state: import('../store.js').GenerationState,
 *   runtime: { profile: object, paths: object, secrets: object },
 *   candidate: { providerId: string, modelId: string },
 *   index: number,
 *   idleMs: number,
 *   maxMs: number,
 *   canFailover: boolean,
 * }} params
 * @returns {Promise<{
 *   outcome: 'complete' | 'retry' | 'fatal',
 *   message?: string,
 *   retrySameCandidate?: boolean,
 *   retryAfterMs?: number,
 *   hostSuspect?: boolean,
 * }>}
 */
export async function pumpAnthropicUpstream({
  state,
  runtime,
  candidate,
  index,
  idleMs,
  maxMs,
  canFailover,
}) {
  const controller = new AbortController();
  state.upstreamController = controller;

  const origin = originFromUrl(runtime.profile.baseUrl);
  /** @type {'idle' | 'max' | null} */
  let timeoutKind = null;
  let idleTimer = null;
  let bytesEmitted = false;

  const armIdleTimeout = () => {
    if (idleMs <= 0) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      timeoutKind = 'idle';
      controller.abort();
    }, idleMs);
  };

  const maxTimer =
    maxMs > 0
      ? setTimeout(() => {
          timeoutKind = 'max';
          controller.abort();
        }, maxMs)
      : null;

  armIdleTimeout();

  /** @type {Record<string, unknown> | undefined} */
  let adjustedBody;

  try {
    if (state.status === 'cancelled') {
      return { outcome: 'complete' };
    }

    if (isHostDead(origin)) {
      const message = `Host in cooldown: ${origin}`;
      if (canFailover) {
        return { outcome: 'retry', message, retrySameCandidate: false };
      }
      return { outcome: 'fatal', message };
    }

    markStreaming(state);

    const body = parseOpenAiRequestBody(state.requestBody);
    if (candidate.modelId) {
      body.model = candidate.modelId;
    }

    adjustedBody = adjustAnthropicRequestForGateway(
      runtime.profile.baseUrl,
      adjustAnthropicThinkingForToolHistory(
        typeof body.model === 'string' ? body.model : '',
        body,
      ),
    );

    const anthropic = buildAnthropicProvider({
      ...runtime,
      openCodeSessionId: openCodeSessionIdForGeneration(state),
    });
    const callOptions = buildGenerationCallOptions(adjustedBody, anthropic, controller.signal);
    const stream = body.stream === true;

    if (stream) {
      const result = streamText(
        /** @type {Parameters<typeof streamText>[0]} */ (callOptions),
      );
      const encoder = createOpenAiSseEncoder();
      /** @type {import('ai').LanguageModelUsage | undefined} */
      let lastUsage;
      /** @type {import('ai').FinishReason | undefined} */
      let lastFinishReason;

      for await (const part of result.fullStream) {
        if (state.status === 'cancelled' || state.status === 'error') {
          return { outcome: 'complete' };
        }

        armIdleTimeout();

        if (part.type === 'error') {
          const streamErr = part.error;
          throw streamErr instanceof Error ? streamErr : new Error(String(streamErr));
        }

        if (part.type === 'finish') {
          lastUsage = part.totalUsage;
          lastFinishReason = part.finishReason;
          continue;
        }

        const encoded = encoder.encodeStreamPart(part);
        if (encoded) {
          if (!bytesEmitted) {
            bytesEmitted = true;
            noteGenerationCandidateChosen(state, {
              providerId: candidate.providerId,
              modelId: candidate.modelId,
              index,
            });
          }
          appendChunk(state, Buffer.from(encoded, 'utf8'));
        }
      }

      if (lastUsage && !bytesEmitted) {
        noteGenerationCandidateChosen(state, {
          providerId: candidate.providerId,
          modelId: candidate.modelId,
          index,
        });
      }

      if (lastUsage) {
        appendChunk(
          state,
          Buffer.from(encodeUsageSseChunk(lastUsage, lastFinishReason), 'utf8'),
        );
      } else if (lastFinishReason) {
        appendChunk(
          state,
          Buffer.from(
            encodeUsageSseChunk(undefined, lastFinishReason),
            'utf8',
          ),
        );
      }
      appendChunk(state, Buffer.from(encodeOpenAiSseDone(), 'utf8'));

      if (state.status !== 'error' && state.status !== 'cancelled') {
        markComplete(state);
      }
      return { outcome: 'complete' };
    }

    const result = await generateText(
      /** @type {Parameters<typeof generateText>[0]} */ (callOptions),
    );

    noteGenerationCandidateChosen(state, {
      providerId: candidate.providerId,
      modelId: candidate.modelId,
      index,
    });

    const completion = encodeNonStreamingCompletion({
      model: typeof body.model === 'string' ? body.model : candidate.modelId,
      text: result.text,
      reasoningText: result.reasoningText,
      toolCalls: result.toolCalls,
      finishReason: result.finishReason,
      usage: result.usage,
    });

    appendChunk(state, Buffer.from(JSON.stringify(completion), 'utf8'));
    markComplete(state);
    return { outcome: 'complete' };
  } catch (err) {
    if (state.status === 'cancelled') {
      return { outcome: 'complete' };
    }

    if (err instanceof APICallError || (err && typeof err === 'object' && err.name === 'APICallError')) {
      const apiErr = /** @type {APICallError} */ (err);
      if (apiErr.statusCode === 400) {
        const toolCount = Array.isArray(adjustedBody?.tools) ? adjustedBody.tools.length : 0;
        const messageCount = Array.isArray(adjustedBody?.messages) ? adjustedBody.messages.length : 0;
        const detail =
          typeof apiErr.responseBody === 'string'
            ? apiErr.responseBody.replace(/\s+/g, ' ').trim().slice(0, 300)
            : '';
        console.warn(
          `[anthropic-pump] upstream 400 model=${String(adjustedBody?.model ?? '')} tools=${toolCount} messages=${messageCount} host=${runtime.profile.baseUrl}${detail ? ` detail=${detail}` : ''}`,
        );
      }
    }

    if (timeoutKind) {
      const message = generationTimeoutMessage({ idleMs, maxMs }, timeoutKind);
      if (!bytesEmitted) {
        return { outcome: 'retry', message, retrySameCandidate: false, hostSuspect: true };
      }
      return { outcome: 'fatal', message };
    }

    const classified = classifySdkError(err);
    if (!bytesEmitted && classified.quotaExceeded) {
      // The allowance is spent: another provider may still have room, but
      // retrying this one cannot succeed until it resets.
      if (canFailover) {
        return {
          outcome: 'retry',
          message: classified.message,
          retrySameCandidate: false,
          quotaExceeded: true,
        };
      }
      markError(state, classified.message, { quotaExceeded: true });
      return { outcome: 'fatal', message: classified.message, quotaExceeded: true };
    }
    if (!bytesEmitted && classified.kind === 'retryable') {
      return {
        outcome: 'retry',
        message: classified.message,
        retrySameCandidate: classified.rateLimited === true || !canFailover,
        retryAfterMs: classified.retryAfterMs,
        hostSuspect: classified.rateLimited !== true,
      };
    }

    if (!bytesEmitted) {
      markError(state, classified.message);
    }
    return { outcome: 'fatal', message: classified.message };
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    if (maxTimer) clearTimeout(maxTimer);
    if (state.upstreamController === controller) {
      state.upstreamController = null;
    }
  }
}

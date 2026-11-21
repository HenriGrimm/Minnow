// Shared server helper.
/**
 * Non-streaming server-side chat completion helper for the Deep Research engine.
 * OpenAI-compatible LLM call with one retry on transient failure.
 */

import { formatUpstreamHttpErrorMessage } from '../generations/upstream-error-detail.js';
import { getProviderRuntime as defaultGetProviderRuntime } from '../providers/store.js';
import { stripDraftOutput, stripThinking } from './strip-thinking.js';
import {
  chatCompletionBodyToResponses,
  responsesJsonToOpenAiCompletion,
} from '../generations/openai-responses/chat-to-responses.js';
import { resolveCompatibleCompletionUrl } from '../generations/openai-responses/url.js';
import { shouldUseOpenAiResponses } from '../../src/lib/openai-responses-route.mjs';
import {
  mergeOpenCodeIdentityHeaders,
  OPENCODE_SESSION_PROBE,
} from '../providers/opencode-identity.js';

/** Injectable deps for unit tests (mock fetch + provider runtime). */
export const llmCallDeps = {
  getProviderRuntime: defaultGetProviderRuntime,
  fetchFn: fetch,
};

/** HTTP statuses that trigger a single retry. */
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
/** Delay before retrying a transient upstream failure. */
const RETRY_DELAY_MS = 500;
/** Total attempts: initial call plus one retry on transient failure. */
const MAX_ATTEMPTS = 2;

/**
 * @typedef {object} LlmCallOptions
 * @property {string} providerId
 * @property {string} model
 * @property {Array<{ role: string, content: string }>} messages
 * @property {number} [temperature]
 * @property {number} [maxTokens]
 * @property {number} [timeoutMs]
 * @property {AbortSignal} [signal]
 * @property {boolean} [stripProse] When true, strip untagged leading reasoning prose (email drafts).
 */

/**
 * Resolve assistant text from an OpenAI-style completion JSON body.
 * @param {unknown} data
 * @returns {string}
 */
export function extractCompletionText(data) {
  if (!data || typeof data !== 'object') {
    throw new Error('Unexpected completion response schema');
  }
  const record = /** @type {Record<string, unknown>} */ (data);
  const openaiShaped = Array.isArray(record.choices)
    ? record
    : Array.isArray(record.output)
      ? responsesJsonToOpenAiCompletion(record)
      : record;
  const choices = /** @type {{ choices?: unknown[] }} */ (openaiShaped).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new Error('Unexpected completion response schema');
  }
  const message = /** @type {{ message?: { content?: string, reasoning_content?: string } }} */ (
    choices[0]
  ).message;
  if (!message || typeof message !== 'object') {
    throw new Error('Unexpected completion response schema');
  }
  const content = message.content || message.reasoning_content || '';
  if (typeof content !== 'string') {
    throw new Error('Unexpected completion response schema');
  }
  return content;
}

/**
 * @param {unknown} err
 * @returns {boolean}
 */
function isAbortError(err) {
  return (
    (err instanceof DOMException && err.name === 'AbortError') ||
    (err instanceof Error && err.name === 'AbortError')
  );
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * @param {AbortSignal | undefined} signal
 * @param {number} timeoutMs
 * @returns {{ controller: AbortController, cleanup: () => void }}
 */
function composeAbortSignal(signal, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  const onExternalAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) {
      controller.abort();
    } else {
      signal.addEventListener('abort', onExternalAbort, { once: true });
    }
  }

  return {
    controller,
    cleanup: () => {
      clearTimeout(timeoutId);
      if (signal) {
        signal.removeEventListener('abort', onExternalAbort);
      }
    },
  };
}

/**
 * @param {Response} response
 * @returns {Promise<never>}
 */
async function throwHttpError(response) {
  let rawBody = '';
  try {
    rawBody = await response.text();
  } catch {
    /* ignore */
  }
  const err = new Error(formatUpstreamHttpErrorMessage(response.status, rawBody));
  /** @type {Error & { status?: number }} */ (err).status = response.status;
  throw err;
}

/**
 * Perform one non-streaming chat completion POST.
 * OpenCode Go Responses models are mapped to `/v1/responses` (MIN-855).
 * @param {{ url: string, headers: Record<string, string>, model: string, messages: LlmCallOptions['messages'], temperature: number, maxTokens: number, signal: AbortSignal, baseUrl?: string }} params
 * @returns {Promise<string>}
 */
async function postCompletionOnce({
  url,
  headers,
  model,
  messages,
  temperature,
  maxTokens,
  signal,
  baseUrl,
}) {
  const chatBody = {
    model,
    messages,
    temperature,
    max_tokens: maxTokens,
    stream: false,
  };
  const body = shouldUseOpenAiResponses(baseUrl, model)
    ? chatCompletionBodyToResponses(chatBody)
    : chatBody;

  const response = await llmCallDeps.fetchFn(url, {
    method: 'POST',
    headers: mergeOpenCodeIdentityHeaders(
      {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...headers,
      },
      { baseUrl: url, sessionId: OPENCODE_SESSION_PROBE },
    ),
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    await throwHttpError(response);
  }

  const data = await response.json();
  return extractCompletionText(data);
}

/**
 * Call the configured provider with a non-streaming chat completion.
 * @param {LlmCallOptions} options
 * @returns {Promise<string>}
 */
export async function llmCall({
  providerId,
  model,
  messages,
  temperature = 0.3,
  maxTokens = 4096,
  timeoutMs = 60000,
  signal,
  stripProse = false,
}) {
  if (!providerId) {
    throw new Error('providerId is required');
  }
  if (!model) {
    throw new Error('model is required');
  }

  const runtime = await llmCallDeps.getProviderRuntime(providerId);
  const url = resolveCompatibleCompletionUrl(
    runtime.profile.baseUrl,
    runtime.paths.chatCompletionsPath,
    model,
  );

  let lastError = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const { controller, cleanup } = composeAbortSignal(signal, timeoutMs);
    try {
      const raw = await postCompletionOnce({
        url,
        headers: runtime.headers,
        model,
        messages,
        temperature,
        maxTokens,
        signal: controller.signal,
        baseUrl: runtime.profile.baseUrl,
      });
      return (stripProse ? stripDraftOutput(raw) : stripThinking(raw)) ?? '';
    } catch (err) {
      lastError = err;
      if (isAbortError(err)) {
        throw err;
      }

      const status = /** @type {{ status?: number }} */ (err).status;
      const retryableHttp =
        typeof status === 'number' && RETRYABLE_STATUS.has(status);
      const retryableNetwork =
        err instanceof TypeError && String(err.message).toLowerCase().includes('fetch');

      const canRetry = attempt < MAX_ATTEMPTS && (retryableHttp || retryableNetwork);

      if (!canRetry) {
        throw err;
      }

      await sleep(RETRY_DELAY_MS);
    } finally {
      cleanup();
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

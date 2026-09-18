import { validateProviderId } from '../providers/validate.js';
import { readConfigJson } from '../config/store.js';
import { listProviders } from '../providers/store.js';
import { resolveFallbackChain } from '../generations/fallback.js';
import { pumpUpstream } from '../generations/upstream.js';
import { pumpRouterGeneration } from '../model-routers/generation.js';
import {
  addLocalSubscriber,
  cancel as cancelGeneration,
  createGenerationState,
  NON_AGENT_FALLBACK_ROLES,
  removeLocalSubscriber,
} from '../generations/store.js';

export const RUNNER_FALLBACK_ROLE = 'sub-agent';

/**
 * @param {unknown} raw
 * @returns {string}
 */
function resolveRunnerFallbackRole(raw) {
  const role = typeof raw === 'string' && raw.trim() ? raw.trim() : RUNNER_FALLBACK_ROLE;
  if (NON_AGENT_FALLBACK_ROLES.has(role)) {
    return RUNNER_FALLBACK_ROLE;
  }
  return role;
}

/**
 * @returns {Error}
 */
function abortError() {
  if (typeof DOMException === 'function') {
    return new DOMException('Aborted', 'AbortError');
  }
  const err = new Error('Aborted');
  err.name = 'AbortError';
  return err;
}

/**
 * @param {unknown} terminal
 * @param {boolean} sawBytes
 */
function throwIfTerminalFailed(terminal, sawBytes) {
  const status = terminal && typeof terminal === 'object' ? terminal.status : null;
  if (status === 'error') {
    const message =
      typeof terminal.errorMessage === 'string' && terminal.errorMessage.trim()
        ? terminal.errorMessage
        : 'Generation failed';
    throw new Error(message);
  }
  if (status === 'cancelled') {
    throw abortError();
  }
  if (status === 'complete' && !sawBytes) {
    throw new Error('The provider returned an empty response.');
  }
}

/**
 * @param {import('../generations/store.js').GenerationState} state
 * @returns {AsyncIterable<string>}
 */
function iterateLocalSse(state) {
  /** @type {Buffer[]} */
  const queue = [];
  /** @type {{ resolve: () => void } | null} */
  let waiting = null;
  let finished = false;
  /** @type {object | null} */
  let terminal = null;

  const wake = () => {
    const waiter = waiting;
    waiting = null;
    waiter?.resolve();
  };

  const subscriber = {
    onChunk(buf) {
      queue.push(buf);
      wake();
    },
    onEnd(payload) {
      terminal = payload;
      finished = true;
      wake();
    },
  };

  addLocalSubscriber(state, subscriber);

  return {
    async *[Symbol.asyncIterator]() {
      let sawBytes = false;
      try {
        while (true) {
          while (queue.length > 0) {
            const buf = queue.shift();
            sawBytes = true;
            yield buf.toString('utf8');
          }
          if (finished) {
            throwIfTerminalFailed(terminal, sawBytes);
            return;
          }
          await new Promise((resolve) => {
            waiting = { resolve };
          });
        }
      } finally {
        removeLocalSubscriber(state, subscriber);
      }
    },
  };
}

/**
 * @param {string} providerId
 * @param {unknown} body
 * @param {import('./generation-binding').CompletionStreamOptions} [options]
 * @returns {Promise<{ state: import('../generations/store.js').GenerationState, stream: AsyncIterable<string> }>}
 */
async function startInProcessCompletion(providerId, body, options = {}) {
  const id = validateProviderId(providerId);
  const fallbackRole = resolveRunnerFallbackRole(options.fallbackRole);

  const config = (await readConfigJson('config.json')) ?? {};
  const { providers } = await listProviders();
  const enabledProviderIds = new Set(
    providers.filter((p) => p.enabled !== false).map((p) => p.id),
  );
  const bodyObj = body && typeof body === 'object' ? /** @type {{ model?: string }} */ (body) : {};
  const primaryModelId = typeof bodyObj.model === 'string' ? bodyObj.model : '';

  const candidates = resolveFallbackChain({
    role: fallbackRole,
    primaryProviderId: id,
    primaryModelId,
    config,
    enabledProviderIds,
  });

  const state = createGenerationState({
    providerId: id,
    body,
    persist: false,
    candidates,
    fallbackRole,
    chatId: typeof options.chatId === 'string' ? options.chatId : null,
  });

  const signal = options.signal;
  state.routerPreferAvailable = options.routerPreferAvailable === true;
  const onAbort = () => cancelGeneration(state);
  if (signal) {
    if (signal.aborted) {
      cancelGeneration(state);
    } else {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  }

  const stream = iterateLocalSse(state);
  if (id === 'minnow-router') pumpRouterGeneration(state);
  else pumpUpstream({ state });
  return { state, stream };
}

/**
 * @param {string} providerId
 * @param {unknown} body
 * @param {import('./generation-binding').CompletionStreamOptions} [options]
 * @returns {Promise<AsyncIterable<string> & { generationId: string }>}
 */
export async function createCompletionStream(providerId, body, options = {}) {
  const started = await startInProcessCompletion(providerId, body, options);
  return Object.assign(started.stream, { generationId: started.state.id });
}

/**
 * @type {import('./adapters').PostChatCompletions}
 */
export async function postChatCompletionsInProcess(provider, body, signal, options = {}) {
  const providerId = provider?.id;
  if (typeof providerId !== 'string' || !providerId.trim()) {
    throw new Error('postChatCompletionsInProcess: provider.id is required');
  }

  const started = await startInProcessCompletion(providerId, body, {
    signal,
    fallbackRole: options?.fallbackRole,
    chatId: options?.chatId,
    routerPreferAvailable: options?.routerPreferAvailable,
  });

  const encoder = new TextEncoder();
  const readable = new ReadableStream({
    async start(controller) {
      try {
        for await (const payload of started.stream) {
          controller.enqueue(encoder.encode(payload));
        }
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
    cancel() {
      cancelGeneration(started.state);
    },
  });

  return new Response(readable, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

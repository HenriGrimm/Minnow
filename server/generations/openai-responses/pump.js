/**
 * OpenAI Responses pump — Chat Completions in, OpenAI SSE out, `/v1/responses` upstream.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { classifyUpstreamError } from '../fallback.js';
import {
  appendChunk,
  markComplete,
  markError,
  markStreaming,
  noteGenerationCandidateChosen,
} from '../store.js';
import { generationTimeoutMessage } from '../timeouts.js';
import { formatUpstreamHttpErrorMessage } from '../upstream-error-detail.js';
import { upstreamFetch } from '../upstream-fetch.js';
import {
  mergeOpenCodeIdentityHeaders,
  openCodeSessionIdForGeneration,
} from '../../providers/opencode-identity.js';
import { sanitizeCompletionBodyForProvider } from '../../providers/sanitize-completion-body.js';
import {
  chatCompletionBodyToResponses,
  responsesJsonToOpenAiCompletion,
} from './chat-to-responses.js';
import { createResponsesSseTranslator } from './sse-to-openai.js';
import { resolveOpenAiResponsesUpstreamUrl } from './url.js';

export { resolveOpenAiResponsesUpstreamUrl } from './url.js';

/**
 * @param {{ status: number, url: string, providerId: string, modelId: string, requestBody: Buffer, responseText: string }} info
 */
function dumpUpstreamFailure(info) {
  try {
    const dir = join(homedir(), '.minnow', 'debug');
    mkdirSync(dir, { recursive: true });
    let parsedBody;
    try {
      parsedBody = JSON.parse(info.requestBody.toString('utf8'));
    } catch {
      parsedBody = info.requestBody.toString('utf8');
    }
    writeFileSync(
      join(dir, 'openai-upstream-last-error.json'),
      JSON.stringify(
        {
          at: new Date().toISOString(),
          status: info.status,
          url: info.url,
          providerId: info.providerId,
          modelId: info.modelId,
          responseText: info.responseText,
          requestBody: parsedBody,
        },
        null,
        2,
      ),
      'utf8',
    );
  } catch {
    /* debug dump is best-effort */
  }
}

/**
 * Sanitize as openai-v1 (strip samplers, gpt-5 temperature) then map to Responses.
 *
 * @param {Buffer} requestBody
 * @param {{ apiKind?: string, id?: string, supportsExtendedSamplers?: boolean, baseUrl?: string }} profile
 * @param {string} modelId
 * @param {string} [providerId]
 * @returns {{ chatBody: Record<string, unknown>, responsesBody: Record<string, unknown>, wire: Buffer }}
 */
export function prepareResponsesRequest(requestBody, profile, modelId, providerId) {
  const parsed = JSON.parse(requestBody.toString('utf8'));
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Invalid chat completion request body');
  }
  const chatBody = sanitizeCompletionBodyForProvider(
    /** @type {Record<string, unknown>} */ (parsed),
    {
      apiKind: 'openai-v1',
      id: providerId ?? profile.id,
      supportsExtendedSamplers: profile.supportsExtendedSamplers === true,
      baseUrl: profile.baseUrl,
    },
  );
  if (modelId) chatBody.model = modelId;
  const responsesBody = chatCompletionBodyToResponses(chatBody);
  return {
    chatBody,
    responsesBody,
    wire: Buffer.from(JSON.stringify(responsesBody), 'utf8'),
  };
}

/**
 * @param {{
 *   state: import('../store.js').GenerationState,
 *   runtime: { profile: object, paths: object, headers: Record<string, string> },
 *   candidate: { providerId: string, modelId: string },
 *   index: number,
 *   idleMs: number,
 *   maxMs: number,
 *   canFailover: boolean,
 *   origin?: string,
 * }} params
 * @returns {Promise<{
 *   outcome: 'complete' | 'retry' | 'fatal',
 *   message?: string,
 *   retrySameCandidate?: boolean,
 *   retryAfterMs?: number,
 *   hostSuspect?: boolean,
 * }>}
 */
export async function pumpOpenAiResponsesUpstream({
  state,
  runtime,
  candidate,
  index,
  idleMs,
  maxMs,
  canFailover,
}) {
  if (state.status === 'cancelled') {
    return { outcome: 'complete' };
  }

  const url = resolveOpenAiResponsesUpstreamUrl(
    runtime.profile.baseUrl,
    runtime.paths.chatCompletionsPath,
  );

  const prepared = prepareResponsesRequest(
    state.requestBody,
    runtime.profile,
    candidate.modelId,
    candidate.providerId,
  );
  const requestBody = prepared.wire;

  const controller = new AbortController();
  state.upstreamController = controller;

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

  const emit = (text) => {
    if (!text) return;
    if (!bytesEmitted) {
      bytesEmitted = true;
      noteGenerationCandidateChosen(state, {
        providerId: candidate.providerId,
        modelId: candidate.modelId,
        index,
      });
    }
    appendChunk(state, Buffer.from(text, 'utf8'));
  };

  try {
    markStreaming(state);

    const upstream = await upstreamFetch(url, {
      method: 'POST',
      headers: mergeOpenCodeIdentityHeaders(
        {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream, application/json',
          ...runtime.headers,
        },
        { baseUrl: url, sessionId: openCodeSessionIdForGeneration(state) },
      ),
      body: requestBody,
      signal: controller.signal,
    });

    if (state.status === 'cancelled') {
      controller.abort();
      return { outcome: 'complete' };
    }

    if (!upstream.ok) {
      let rawBody = '';
      try {
        rawBody = await upstream.text();
      } catch {
        /* ignore */
      }
      const message = formatUpstreamHttpErrorMessage(upstream.status, rawBody);
      dumpUpstreamFailure({
        status: upstream.status,
        url,
        providerId: candidate.providerId,
        modelId: candidate.modelId,
        requestBody,
        responseText: rawBody,
      });
      const classified = classifyUpstreamError(null, upstream, rawBody);
      if (!bytesEmitted && classified.quotaExceeded) {
        // The allowance is spent: another provider may still have room, but
        // retrying this one cannot succeed until it resets.
        return canFailover
          ? { outcome: 'retry', message, retrySameCandidate: false, quotaExceeded: true }
          : { outcome: 'fatal', message, quotaExceeded: true };
      }
      if (!bytesEmitted && classified.kind === 'retryable') {
        return {
          outcome: 'retry',
          message,
          retrySameCandidate: classified.rateLimited === true || !canFailover,
          retryAfterMs: classified.retryAfterMs,
          hostSuspect: classified.rateLimited !== true && upstream.status >= 500,
        };
      }
      return { outcome: 'fatal', message, quotaExceeded: classified.quotaExceeded };
    }

    const contentType = upstream.headers?.get?.('content-type')?.toLowerCase() ?? '';
    if (contentType.includes('text/html')) {
      let rawBody = '';
      try {
        rawBody = await upstream.text();
      } catch {
        /* ignore */
      }
      const message =
        'Provider returned an HTML error page instead of a completion response';
      dumpUpstreamFailure({
        status: upstream.status,
        url,
        providerId: candidate.providerId,
        modelId: candidate.modelId,
        requestBody,
        responseText: rawBody,
      });
      return canFailover
        ? { outcome: 'retry', message, retrySameCandidate: false, hostSuspect: true }
        : { outcome: 'fatal', message };
    }

    if (prepared.responsesBody.stream !== true) {
      const text = await upstream.text();
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        emit(text);
        if (state.status !== 'error' && state.status !== 'cancelled') {
          if (bytesEmitted) markComplete(state);
          else markError(state, 'Provider returned an empty response');
        }
        return { outcome: 'complete' };
      }
      const completion = responsesJsonToOpenAiCompletion(parsed, candidate.modelId);
      emit(JSON.stringify(completion));
      if (state.status !== 'error' && state.status !== 'cancelled') {
        markComplete(state);
      }
      return { outcome: 'complete' };
    }

    if (!upstream.body) {
      const text = await upstream.text();
      if (text) {
        const translator = createResponsesSseTranslator();
        for (const chunk of translator.push(text)) emit(chunk);
        for (const chunk of translator.finish()) emit(chunk);
      }
      if (state.status !== 'error' && state.status !== 'cancelled') {
        if (bytesEmitted) markComplete(state);
        else markError(state, 'Provider returned an empty response');
      }
      return { outcome: 'complete' };
    }

    const translator = createResponsesSseTranslator();
    const decoder = new TextDecoder();
    const reader = upstream.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      armIdleTimeout();
      const text = decoder.decode(value, { stream: true });
      for (const chunk of translator.push(text)) emit(chunk);
      if (state.status === 'error' || state.status === 'cancelled') {
        return { outcome: 'complete' };
      }
    }
    for (const chunk of translator.finish()) emit(chunk);

    if (state.status !== 'error' && state.status !== 'cancelled') {
      if (bytesEmitted) markComplete(state);
      else markError(state, 'Provider returned an empty response');
    }
    return { outcome: 'complete' };
  } catch (err) {
    if (state.status === 'cancelled') {
      return { outcome: 'complete' };
    }
    if (timeoutKind) {
      const message = generationTimeoutMessage({ idleMs, maxMs }, timeoutKind);
      if (!bytesEmitted) {
        return { outcome: 'retry', message, retrySameCandidate: false, hostSuspect: true };
      }
      return { outcome: 'fatal', message };
    }
    const classified = classifyUpstreamError(err);
    if (!bytesEmitted && classified.quotaExceeded && canFailover) {
      return { outcome: 'retry', message: classified.reason, retrySameCandidate: false, quotaExceeded: true };
    }
    if (!bytesEmitted && classified.kind === 'retryable') {
      return {
        outcome: 'retry',
        message: classified.reason,
        retrySameCandidate: classified.rateLimited === true || !canFailover,
        hostSuspect: true,
      };
    }
    return { outcome: 'fatal', message: classified.reason, quotaExceeded: classified.quotaExceeded };
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    if (maxTimer) clearTimeout(maxTimer);
    if (state.upstreamController === controller) {
      state.upstreamController = null;
    }
  }
}

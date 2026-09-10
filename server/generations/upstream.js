import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readConfigJson } from '../config/store.js';
import { getProviderRuntime, LLAMA_CPP_LOCAL_ID, MLX_LM_LOCAL_ID } from '../providers/store.js';
import {
  admitLocalCompletion,
  classifyLocalCompletionPriority,
} from '../providers/proxy.js';
import {
  resolveOpenCodeZenUpstreamUrl,
} from '../providers/opencode-zen.js';
import { sanitizeCompletionBodyForProvider } from '../providers/sanitize-completion-body.js';
import {
  buildCandidateRequestBody,
  classifyUpstreamError,
  computeRetryDelayMs,
  MAX_SAME_CANDIDATE_ATTEMPTS,
  readFallbackChainsConfig,
} from './fallback.js';
import { isHostDead, markHostDead, originFromUrl } from './host-cooldown.js';
import {
  appendChunk,
  markComplete,
  markError,
  markStreaming,
  noteGenerationCandidateChosen,
} from './store.js';
import {
  generationTimeoutMessage,
  readGenerationUpstreamTimeouts,
} from './timeouts.js';
import { pumpAnthropicUpstream } from './anthropic/pump.js';
import { deriveMessagesPathFromChat } from '../../src/lib/derive-messages-path.mjs';
import { resolveGenerationApi } from './resolve-model-api.js';
import { formatUpstreamHttpErrorMessage } from './upstream-error-detail.js';
import { upstreamFetch } from './upstream-fetch.js';
import {
  mergeOpenCodeIdentityHeaders,
  openCodeSessionIdForGeneration,
} from '../providers/opencode-identity.js';
import { pumpOpenAiResponsesUpstream } from './openai-responses/pump.js';

// ── Dump ─────────────────────────────────────────────────────────────────────

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
  }
}

// ── Prepare ──────────────────────────────────────────────────────────────────

/**
 * @param {Buffer} requestBody
 * @param {{ apiKind?: string, baseUrl?: string, id?: string }} profile
 * @param {string} modelId
 * @param {'lm-studio-v0' | 'openai-v1' | 'anthropic-v1'} [resolvedApi]
 * @param {string} [providerId]
 * @returns {Buffer}
 */
function prepareUpstreamRequestBody(requestBody, profile, modelId, resolvedApi, providerId) {
  const apiKind = resolvedApi ?? profile.apiKind ?? 'openai-v1';
  let body = requestBody;

  try {
    const parsed = JSON.parse(requestBody.toString('utf8'));
    if (parsed && typeof parsed === 'object') {
      const sanitized = sanitizeCompletionBodyForProvider(
        /** @type {Record<string, unknown>} */ (parsed),
        {
          apiKind,
          id: providerId ?? profile.id,
          supportsExtendedSamplers: profile.supportsExtendedSamplers === true,
          baseUrl: profile.baseUrl,
        },
      );
      body = Buffer.from(JSON.stringify(sanitized), 'utf8');
    }
  } catch {
  }

  if (apiKind !== 'openai-v1') return body;

  if ((providerId ?? profile.id) === LLAMA_CPP_LOCAL_ID) {
    try {
      const parsed = JSON.parse(body.toString('utf8'));
      if (parsed && typeof parsed === 'object') {
        const withTelemetry = { ...parsed, timings_per_token: true };
        if (parsed.stream === true) withTelemetry.return_progress = true;
        body = Buffer.from(JSON.stringify(withTelemetry), 'utf8');
      }
    } catch {
    }
  }

  try {
    const parsed = JSON.parse(body.toString('utf8'));
    if (!parsed || typeof parsed !== 'object') return body;
    const model = typeof parsed.model === 'string' ? parsed.model : modelId;
    if (!/kimi/i.test(model)) return body;
    if (typeof parsed.temperature !== 'number' || parsed.temperature === 1) return body;
    return Buffer.from(JSON.stringify({ ...parsed, temperature: 1 }), 'utf8');
  } catch {
    return body;
  }
}

// ── Pump ─────────────────────────────────────────────────────────────────────

/**
 * @param {{ state: import('./store.js').GenerationState }} params
 */
export function pumpUpstream({ state }) {
  void pumpUpstreamAsync({ state }).catch((err) => {
    console.error('[generations] unhandled pump error:', err);
  });
}

/**
 * @param {import('./store.js').GenerationState} state
 * @param {number} ms
 * @returns {Promise<boolean>}
 */
function delayUnlessCancelled(state, ms) {
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      if (state.status === 'cancelled') {
        resolve(false);
        return;
      }
      const remaining = ms - (Date.now() - started);
      if (remaining <= 0) {
        resolve(true);
        return;
      }
      setTimeout(tick, Math.min(remaining, 250));
    };
    tick();
  });
}

/**
 * @param {{ kind: string, rateLimited?: boolean }} classified
 * @param {boolean} canFailover
 * @returns {boolean}
 */
function shouldRetrySameCandidate(classified, canFailover) {
  if (classified.kind !== 'retryable') return false;
  return classified.rateLimited === true || !canFailover;
}

/**
 * @param {{ state: import('./store.js').GenerationState }} params
 */
export async function pumpUpstreamAsync({ state }) {
  const config = (await readConfigJson('config.json')) ?? {};
  const fallbackConfig = readFallbackChainsConfig(config);
  const { idleMs, maxMs } = await readGenerationUpstreamTimeouts();

  /** @type {string | null} */
  let lastError = null;
  /** Sticky: once any candidate reports a spent allowance, say so at the end. */
  let quotaExceeded = false;

  for (let index = state.activeCandidateIndex; index < state.candidates.length; index += 1) {
    if (state.status === 'cancelled') {
      return;
    }
    if (state.failoverDisabled && index > state.activeCandidateIndex) {
      return;
    }

    const candidate = state.candidates[index];
    let runtime;
    try {
      runtime = await getProviderRuntime(candidate.providerId);
    } catch (err) {
      const classified = classifyUpstreamError(err);
      lastError = classified.reason;
      if (classified.kind === 'retryable' && index < state.candidates.length - 1) {
        continue;
      }
      markError(state, lastError);
      return;
    }

    if (runtime.profile.enabled === false) {
      lastError = `Provider disabled: ${candidate.providerId}`;
      if (index < state.candidates.length - 1) {
        continue;
      }
      markError(state, lastError);
      return;
    }

    let completionAdmission = null;
    let url = resolveOpenCodeZenUpstreamUrl(
      runtime.profile.baseUrl,
      runtime.paths.chatCompletionsPath,
    );
    let origin = originFromUrl(runtime.profile.baseUrl);

    try {
      if (
        candidate.providerId === LLAMA_CPP_LOCAL_ID ||
        candidate.providerId === MLX_LM_LOCAL_ID
      ) {
        const admissionController = new AbortController();
        state.upstreamController = admissionController;
        completionAdmission = await admitLocalCompletion({
          providerId: candidate.providerId,
          modelId: candidate.modelId,
          priority: classifyLocalCompletionPriority(state),
          signal: admissionController.signal,
        });
        url = resolveOpenCodeZenUpstreamUrl(
          completionAdmission.baseUrl,
          runtime.paths.chatCompletionsPath,
        );
        origin = originFromUrl(completionAdmission.baseUrl);
      }

    if (isHostDead(origin)) {
      lastError = `Host in cooldown: ${origin}`;
      if (index < state.candidates.length - 1) {
        continue;
      }
      markError(state, lastError);
      return;
    }

    const canFailover = !state.failoverDisabled && index < state.candidates.length - 1;
    const resolvedApi = resolveGenerationApi(runtime, candidate.modelId);
    const anthropicRuntime =
      resolvedApi === 'anthropic-v1'
        ? {
            ...runtime,
            paths: {
              ...runtime.paths,
              messagesPath:
                runtime.profile.messagesPath ||
                runtime.paths.messagesPath ||
                deriveMessagesPathFromChat(runtime.paths.chatCompletionsPath),
            },
          }
        : runtime;
    const runAttempt = () => {
      if (resolvedApi === 'anthropic-v1') {
        return pumpAnthropicUpstream({
          state,
          runtime: anthropicRuntime,
          candidate,
          index,
          idleMs,
          maxMs,
          canFailover,
        });
      }
      if (resolvedApi === 'openai-responses') {
        return pumpOpenAiResponsesUpstream({
          state,
          runtime,
          candidate,
          index,
          idleMs,
          maxMs,
          canFailover,
        });
      }
      return attemptCandidateStream({
        state,
        candidate,
        index,
        url,
        headers: runtime.headers,
        requestBody: prepareUpstreamRequestBody(
          buildCandidateRequestBody(state.requestBody, candidate.modelId),
          runtime.profile,
          candidate.modelId,
          resolvedApi,
          candidate.providerId,
        ),
        idleMs,
        maxMs,
        origin,
        canFailover,
      });
    };

    let result = await runAttempt();

    for (
      let attempt = 1;
      result.outcome === 'retry' &&
      !state.routerAttempt &&
      result.retrySameCandidate === true &&
      attempt < MAX_SAME_CANDIDATE_ATTEMPTS &&
      state.status !== 'cancelled';
      attempt += 1
    ) {
      const delayMs = computeRetryDelayMs(attempt, result.retryAfterMs);
      console.warn(
        `[generations] ${result.message ?? 'upstream retryable failure'} — retrying ${candidate.providerId}/${candidate.modelId} in ${Math.round(delayMs / 1000)}s (attempt ${attempt + 1}/${MAX_SAME_CANDIDATE_ATTEMPTS})`,
      );
      if (!(await delayUnlessCancelled(state, delayMs))) {
        return;
      }
      result = await runAttempt();
    }

    if (result.outcome === 'complete') {
      return;
    }
    if (result.hostSuspect && canFailover) {
      markHostDead(origin, fallbackConfig.cooldownSeconds);
    }
    if (result.quotaExceeded) quotaExceeded = true;
    if (result.outcome === 'fatal' || !canFailover) {
      markError(state, result.message ?? 'Generation failed', { quotaExceeded });
      return;
    }
    lastError = result.message ?? lastError;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      lastError = message;
      if (index < state.candidates.length - 1) {
        continue;
      }
      markError(state, lastError);
      return;
    } finally {
      completionAdmission?.release?.();
    }
  }

  markError(state, lastError ?? 'All fallback candidates failed', { quotaExceeded });
}

// ── Attempt ──────────────────────────────────────────────────────────────────

/**
 * @param {{ state: import('./store.js').GenerationState, candidate: { providerId: string, modelId: string }, index: number, url: string, headers: Record<string, string>, requestBody: Buffer, idleMs: number, maxMs: number, origin: string, canFailover: boolean, }} params
 * @returns {Promise<{ outcome: 'complete' | 'retry' | 'fatal', message?: string, retrySameCandidate?: boolean, retryAfterMs?: number, hostSuspect?: boolean, }>}
 */
async function attemptCandidateStream({
  state,
  candidate,
  index,
  url,
  headers,
  requestBody,
  idleMs,
  maxMs,
  origin,
  canFailover,
}) {
  if (state.status === 'cancelled') {
    return { outcome: 'complete' };
  }

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

  try {
    markStreaming(state);

    const upstream = await upstreamFetch(url, {
      method: 'POST',
      headers: mergeOpenCodeIdentityHeaders(
        {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream, application/json',
          ...headers,
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
          retrySameCandidate: shouldRetrySameCandidate(classified, canFailover),
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

    if (!upstream.body) {
      const text = await upstream.text();
      if (text) {
        bytesEmitted = true;
        noteGenerationCandidateChosen(state, {
          providerId: candidate.providerId,
          modelId: candidate.modelId,
          index,
        });
        appendChunk(state, Buffer.from(text, 'utf8'));
      }
      if (state.status !== 'error' && state.status !== 'cancelled') {
        if (bytesEmitted) {
          markComplete(state);
        } else {
          markError(state, 'Provider returned an empty response');
        }
      }
      return { outcome: 'complete' };
    }

    const reader = upstream.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      armIdleTimeout();
      if (!bytesEmitted) {
        bytesEmitted = true;
        noteGenerationCandidateChosen(state, {
          providerId: candidate.providerId,
          modelId: candidate.modelId,
          index,
        });
      }
      appendChunk(state, Buffer.from(value));
      if (state.status === 'error' || state.status === 'cancelled') {
        return { outcome: 'complete' };
      }
    }

    if (state.status !== 'error' && state.status !== 'cancelled') {
      if (bytesEmitted) {
        markComplete(state);
      } else {
        markError(state, 'Provider returned an empty response');
      }
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
        retrySameCandidate: shouldRetrySameCandidate(classified, canFailover),
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

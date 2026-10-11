/**
 * Task evaluator for Auto model pools (router policy `evaluate`).
 *
 * Once per user turn the evaluator answers two typed questions about the
 * request — which capability tier it needs and how much reasoning — and the
 * router maps that onto its entries. It never names a model, so the pool can
 * change without retraining a prompt.
 *
 * Two evaluator kinds:
 * - Decision models (TypeSafe Jev, Cloudflare Clef) through the Jev-compatible
 *   Decisions API: typed `choice` questions with real probabilities.
 * - Any chat model, asked for the same answer as JSON; its confidence is
 *   self-reported.
 *
 * The evaluator must never block a turn: it runs under a hard timeout and every
 * failure falls back to the last decision or plain priority order.
 */

import { getProviderRuntime } from '../providers/store.js';
import { createGenerationState, cancel } from '../generations/store.js';
import { pumpUpstreamAsync } from '../generations/upstream.js';
import {
  formatRouterTierLabel,
  isDecisionModelId,
  isRouterEffort,
  isRouterTier,
} from '../../src/models/router-tiers.mjs';

export const EVALUATOR_TIMEOUT_MS = 4000;
/** Below this confidence a new decision does not move a chat off its current tier. */
export const KEEP_BELOW_CONFIDENCE = 0.55;

const REQUEST_CHARS = 6000;
const PREVIOUS_REQUEST_CHARS = 600;

const TIER_CRITERIA = {
  fast: 'Trivial or mechanical: a rename, a typo, formatting, a one-line answer, a quick lookup, or small talk.',
  balanced: 'Ordinary work: explain or change one function or file, write a test, fix a focused bug with a clear cause, or draft a short document.',
  frontier: 'Hard or open-ended: multi-file or architectural changes, subtle debugging, security, novel design, long careful reasoning, or a high cost of being wrong.',
};

const EFFORT_CRITERIA = {
  low: 'The answer is immediate; thinking first adds nothing.',
  medium: 'Some step-by-step reasoning helps.',
  high: 'Needs deep, careful reasoning or planning before answering.',
};

/** @param {unknown} content */
function messageText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (part && typeof part === 'object' && typeof part.text === 'string' ? part.text : ''))
    .filter(Boolean)
    .join('\n');
}

/** @param {unknown} content */
function imageCount(content) {
  if (!Array.isArray(content)) return 0;
  return content.filter((part) => part && typeof part === 'object' && part.type === 'image_url').length;
}

/** @param {{ messages?: Array<{ role?: string }> }} body */
function conversation(body) {
  return Array.isArray(body?.messages) ? body.messages.filter((m) => m && m.role !== 'system') : [];
}

/**
 * True when this request starts a user turn. Tool-loop rounds end on a tool or
 * assistant message and keep the decision their turn already made.
 * @param {{ messages?: Array<{ role?: string }> }} body
 */
export function isUserTurn(body) {
  const messages = conversation(body);
  return messages.length > 0 && messages[messages.length - 1].role === 'user';
}

/**
 * The state a decision model reads. Only the current request and a little
 * context — never the whole transcript.
 * @param {{ messages?: Array<{ role?: string, content?: unknown }>, tools?: unknown[] }} body
 */
export function buildDecisionState(body) {
  const users = conversation(body).filter((m) => m.role === 'user');
  const current = users[users.length - 1];
  const previous = users[users.length - 2];
  const state = {
    request: messageText(current?.content).trim().slice(0, REQUEST_CHARS),
    images_attached: imageCount(current?.content),
    conversation_turns: users.length,
    tools_available: Array.isArray(body?.tools) ? body.tools.length : 0,
  };
  const previousText = messageText(previous?.content).trim();
  if (previousText) state.previous_request = previousText.slice(0, PREVIOUS_REQUEST_CHARS);
  return state;
}

/**
 * Short evaluator name for "Judged by …".
 * @param {string} modelId
 */
export function evaluatorLabel(modelId) {
  const tail = String(modelId || '').split('/').pop()?.replace(/^~/, '').replace(/-latest$/, '') || '';
  if (!isDecisionModelId(modelId)) return tail;
  const [family, ...rest] = tail.split('-');
  const name = family.charAt(0).toUpperCase() + family.slice(1);
  return [name, ...rest].join(' ');
}

/** @param {string} modelId @param {Record<string, unknown>} state */
export function decisionRequestBody(modelId, state) {
  return {
    model: modelId,
    state,
    questions: {
      tier: {
        type: 'choice',
        instructions: 'How capable a model does this coding-assistant request need to be answered well?',
        criteria: TIER_CRITERIA,
      },
      effort: {
        type: 'choice',
        instructions: 'How much reasoning effort should the model spend before answering?',
        criteria: EFFORT_CRITERIA,
      },
    },
  };
}

/**
 * Where a provider serves the Decisions API, and the model id that endpoint
 * expects in the body.
 * @param {{ baseUrl?: string }} profile
 * @param {string} modelId
 * @returns {{ url: string, model: string }}
 */
export function decisionsEndpoint(profile, modelId) {
  const base = String(profile?.baseUrl || '').trim().replace(/\/+$/, '').replace(/\/v1$/, '');
  if (!base) throw new Error('The evaluator provider has no base URL');
  const url = new URL(base);
  if (/(^|\.)openrouter\.ai$/i.test(url.hostname)) {
    return { url: `${url.origin}/api/alpha/decisions`, model: modelId };
  }
  if (url.hostname === 'api.cloudflare.com') {
    const id = modelId.startsWith('@cf/') ? modelId : `@cf/cloudflare/${modelId.replace(/^cloudflare\//, '')}`;
    const aiBase = base.match(/^(.*\/ai)(?:\/|$)/)?.[1] || base;
    return { url: `${aiBase}/run/${id}`, model: id.split('/').pop() || id };
  }
  return { url: `${base}/v1/decisions`, model: modelId };
}

/** @param {{ choice?: unknown, confidence?: unknown, probabilities?: Record<string, number> } | undefined} answer */
function choiceConfidence(answer) {
  if (typeof answer?.confidence === 'number') return answer.confidence;
  const values = Object.values(answer?.probabilities || {}).filter((v) => typeof v === 'number');
  return values.length ? Math.max(...values) : 0;
}

/**
 * @param {unknown} json Decisions API response (Workers AI wraps it in `result`).
 * @returns {{ tier: string, effort: string, confidence: number }}
 */
export function parseDecisionAnswers(json) {
  const root = /** @type {any} */ (json)?.result?.answers ? /** @type {any} */ (json).result : json;
  const answers = /** @type {any} */ (root)?.answers;
  const tier = answers?.tier?.choice;
  const effort = answers?.effort?.choice;
  if (!isRouterTier(tier)) throw new Error('The evaluator did not return a tier');
  return {
    tier,
    effort: isRouterEffort(effort) ? effort : 'medium',
    confidence: Math.max(0, Math.min(1, choiceConfidence(answers.tier))),
  };
}

/**
 * Lenient JSON answer from a chat evaluator: tolerates think blocks, code
 * fences, and prose around the object.
 * @param {string} text
 */
export function parseChatEvaluatorText(text) {
  const visible = String(text || '').replace(/<think>[\s\S]*?<\/think>/gi, '');
  const match = visible.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('The evaluator did not return JSON');
  const value = JSON.parse(match[0]);
  if (!isRouterTier(value.tier)) throw new Error('The evaluator did not return a tier');
  const confidence = Number(value.confidence);
  return {
    tier: value.tier,
    effort: isRouterEffort(value.effort) ? value.effort : 'medium',
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence > 1 ? confidence / 100 : confidence)) : 0.6,
    reason: typeof value.reason === 'string' ? value.reason.trim().slice(0, 160) : '',
  };
}

/** Content of a finished generation, streamed or not. @param {Buffer[]} chunks */
function completionText(chunks) {
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    const parsed = JSON.parse(raw);
    return messageText(parsed?.choices?.[0]?.message?.content);
  } catch {}
  let text = '';
  for (const line of raw.split('\n')) {
    try { text += JSON.parse(line.replace(/^data:\s*/, ''))?.choices?.[0]?.delta?.content || ''; } catch {}
  }
  return text;
}

/**
 * @param {{ providerId: string, modelId: string }} evaluator
 * @param {Record<string, unknown>} state
 * @param {AbortSignal} signal
 */
async function askDecisionModel(evaluator, state, signal) {
  const { profile, headers } = await getProviderRuntime(evaluator.providerId);
  const endpoint = decisionsEndpoint(profile, evaluator.modelId);
  const response = await fetch(endpoint.url, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(decisionRequestBody(endpoint.model, state)),
    signal,
  });
  if (!response.ok) throw new Error(`Evaluator HTTP ${response.status}`);
  return parseDecisionAnswers(await response.json());
}

/**
 * @param {{ providerId: string, modelId: string }} evaluator
 * @param {Record<string, unknown>} state
 * @param {AbortSignal} signal
 */
async function askChatModel(evaluator, state, signal) {
  const criteria = (obj) => Object.entries(obj).map(([k, v]) => `- ${k}: ${v}`).join('\n');
  const child = createGenerationState({
    providerId: evaluator.providerId,
    candidates: [{ providerId: evaluator.providerId, modelId: evaluator.modelId }],
    body: {
      model: evaluator.modelId,
      stream: false,
      temperature: 0,
      max_tokens: 400,
      messages: [
        {
          role: 'system',
          content: [
            'You route requests for a coding assistant to the right model. Do not answer the request.',
            `Tier:\n${criteria(TIER_CRITERIA)}`,
            `Effort:\n${criteria(EFFORT_CRITERIA)}`,
            'Reply with one JSON object only: {"tier":"fast|balanced|frontier","effort":"low|medium|high","confidence":0.0-1.0,"reason":"under 12 words"}',
          ].join('\n\n'),
        },
        { role: 'user', content: JSON.stringify(state) },
      ],
    },
  });
  const abort = () => cancel(child);
  signal.addEventListener('abort', abort, { once: true });
  try { await pumpUpstreamAsync({ state: child }); }
  finally { signal.removeEventListener('abort', abort); }
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
  if (child.status !== 'complete') throw new Error(child.errorMessage || 'The evaluator did not finish');
  return parseChatEvaluatorText(completionText(child.chunks));
}

/**
 * One evaluator call under a hard timeout.
 * @param {{ providerId: string, modelId: string }} evaluator
 * @param {Record<string, unknown>} body
 * @param {{ signal?: AbortSignal, timeoutMs?: number }} [options]
 */
export async function evaluateTask(evaluator, body, { signal, timeoutMs = EVALUATOR_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  const state = buildDecisionState(body);
  try {
    const decision = isDecisionModelId(evaluator.modelId)
      ? await askDecisionModel(evaluator, state, controller.signal)
      : await askChatModel(evaluator, state, controller.signal);
    return {
      ...decision,
      reason: decision.reason || `${formatRouterTierLabel(decision.tier)} tier, ${decision.effort} reasoning`,
      judgedBy: evaluatorLabel(evaluator.modelId),
      source: 'evaluator',
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    if (controller.signal.aborted) throw new Error(`Evaluator took longer than ${Math.round(timeoutMs / 100) / 10}s`);
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Decide this request's tier and effort for a chat, applying the turn and
 * confidence rules. Returns null when the router should fall back to plain
 * priority order.
 * @param {{
 *   scheduler: import('./scheduler.js').RouterScheduler,
 *   router: { id: string, evaluator?: { providerId: string, modelId: string } | null },
 *   chatId: string,
 *   body: Record<string, any>,
 *   signal?: AbortSignal,
 *   onDeciding?: (info: { judgedBy: string, first: boolean }) => void,
 *   evaluate?: typeof evaluateTask,
 * }} options
 */
export async function decideRoute({ scheduler, router, chatId, body, signal, onDeciding, evaluate = evaluateTask }) {
  const key = scheduler.assignmentKey(router.id, chatId);
  const previous = scheduler.decisions.get(key) || null;
  if (scheduler.assignments[key]?.assignmentMode === 'override') {
    return { tier: null, effort: null, confidence: 1, source: 'override', reason: 'Pinned to a model for this chat', judgedBy: '' };
  }
  // Every round of one turn stays on the model the turn started with.
  if (previous && !isUserTurn(body)) return { ...previous, source: 'turn' };
  const evaluator = router.evaluator;
  if (!evaluator?.providerId || !evaluator?.modelId) {
    return { tier: null, effort: null, confidence: 0, source: 'fallback', reason: 'No task evaluator is set for this pool', judgedBy: '' };
  }
  const judgedBy = evaluatorLabel(evaluator.modelId);
  onDeciding?.({ judgedBy, first: !previous });
  let decision;
  try {
    decision = await evaluate(evaluator, body, { signal });
  } catch (error) {
    if (signal?.aborted) throw error;
    const message = error instanceof Error ? error.message : String(error);
    return previous
      ? { ...previous, source: 'fallback', reason: `${message}. Kept the last choice.` }
      : { tier: null, effort: null, confidence: 0, source: 'fallback', reason: message, judgedBy };
  }
  if (previous?.tier && decision.tier !== previous.tier && decision.confidence < KEEP_BELOW_CONFIDENCE) {
    decision = {
      ...decision,
      tier: previous.tier,
      effort: previous.effort,
      source: 'kept',
      reason: `Unsure (${Math.round(decision.confidence * 100)}%), so it stayed on the ${formatRouterTierLabel(previous.tier).toLowerCase()} tier`,
    };
  }
  scheduler.decisions.set(key, { ...decision, chatId, routerId: router.id, decidedAt: new Date().toISOString() });
  return decision;
}

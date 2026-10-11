import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDecisionState,
  decideRoute,
  decisionRequestBody,
  decisionsEndpoint,
  evaluatorLabel,
  isUserTurn,
  parseChatEvaluatorText,
  parseDecisionAnswers,
} from '../../server/model-routers/evaluator.js';
import { mapEffortToLevels } from '../../server/model-routers/generation.js';
import { RouterScheduler, validateRouters } from '../../server/model-routers/scheduler.js';
import {
  guessRouterTier,
  isDecisionModelId,
  routerEntryTier,
  routerTierFallbackOrder,
} from '../../src/models/router-tiers.mjs';

test('tiers are guessed from parameter counts first, then name families', () => {
  assert.equal(guessRouterTier('qwen3-4b-instruct'), 'fast');
  assert.equal(guessRouterTier('qwen3-32b'), 'balanced');
  assert.equal(guessRouterTier('Qwen3-30B-A3B'), 'balanced');
  assert.equal(guessRouterTier('llama-3.3-70b'), 'frontier');
  assert.equal(guessRouterTier('claude-haiku-5-5'), 'fast');
  assert.equal(guessRouterTier('gpt-5-mini'), 'fast');
  assert.equal(guessRouterTier('claude-opus-5-5'), 'frontier');
  assert.equal(guessRouterTier('gpt-5.5'), 'frontier');
  assert.equal(guessRouterTier('claude-sonnet-5-5'), 'balanced');
  assert.equal(routerEntryTier({ modelId: 'qwen3-4b', tier: 'frontier' }), 'frontier');
  assert.equal(routerEntryTier({ modelId: 'gguf:abc123', label: 'Gemma 4 27B' }), 'balanced');
});

test('a missing tier falls back to the nearest one, stronger first', () => {
  assert.deepEqual(routerTierFallbackOrder('balanced'), ['balanced', 'frontier', 'fast']);
  assert.deepEqual(routerTierFallbackOrder('fast'), ['fast', 'balanced', 'frontier']);
  assert.deepEqual(routerTierFallbackOrder('frontier'), ['frontier', 'balanced', 'fast']);
});

test('decision models are recognized by id', () => {
  for (const id of ['typesafe/jev-1.13', '~typesafe/jev-latest', 'jev', '@cf/cloudflare/clef', 'cloudflare/clef-flash', 'clef']) {
    assert.equal(isDecisionModelId(id), true, id);
  }
  for (const id of ['jevons-7b', 'qwen3-32b', 'clefable', 'openai/gpt-5']) {
    assert.equal(isDecisionModelId(id), false, id);
  }
  assert.equal(evaluatorLabel('typesafe/jev-1.13'), 'Jev 1.13');
  assert.equal(evaluatorLabel('~typesafe/jev-latest'), 'Jev');
  assert.equal(evaluatorLabel('@cf/cloudflare/clef-flash'), 'Clef flash');
  assert.equal(evaluatorLabel('openai/gpt-5-nano'), 'gpt-5-nano');
});

test('decision endpoints follow the provider host', () => {
  assert.deepEqual(decisionsEndpoint({ baseUrl: 'https://openrouter.ai/api' }, 'typesafe/jev-1.13'),
    { url: 'https://openrouter.ai/api/alpha/decisions', model: 'typesafe/jev-1.13' });
  assert.deepEqual(decisionsEndpoint({ baseUrl: 'https://api.cloudflare.com/client/v4/accounts/abc/ai/v1' }, 'clef'),
    { url: 'https://api.cloudflare.com/client/v4/accounts/abc/ai/run/@cf/cloudflare/clef', model: 'clef' });
  assert.deepEqual(decisionsEndpoint({ baseUrl: 'https://api.cloudflare.com/client/v4/accounts/abc/ai' }, '@cf/cloudflare/clef-flash'),
    { url: 'https://api.cloudflare.com/client/v4/accounts/abc/ai/run/@cf/cloudflare/clef-flash', model: 'clef-flash' });
  assert.deepEqual(decisionsEndpoint({ baseUrl: 'http://127.0.0.1:9000/' }, 'jev'),
    { url: 'http://127.0.0.1:9000/v1/decisions', model: 'jev' });
});

test('the decision request asks typed tier and effort questions', () => {
  const body = decisionRequestBody('typesafe/jev-1.13', { request: 'hi' });
  assert.equal(body.questions.tier.type, 'choice');
  assert.deepEqual(Object.keys(body.questions.tier.criteria), ['fast', 'balanced', 'frontier']);
  assert.deepEqual(Object.keys(body.questions.effort.criteria), ['low', 'medium', 'high']);
});

test('decision answers parse from OpenRouter and Workers AI shapes', () => {
  const answers = {
    tier: { type: 'choice', choice: 'frontier', confidence: 0.91, probabilities: { fast: 0.01, balanced: 0.08, frontier: 0.91 } },
    effort: { type: 'choice', choice: 'high', probabilities: { low: 0, medium: 0.2, high: 0.8 } },
  };
  assert.deepEqual(parseDecisionAnswers({ answers }), { tier: 'frontier', effort: 'high', confidence: 0.91 });
  assert.deepEqual(parseDecisionAnswers({ result: { answers: { tier: { choice: 'fast', probabilities: { fast: 0.7, balanced: 0.3 } } } } }),
    { tier: 'fast', effort: 'medium', confidence: 0.7 });
  assert.throws(() => parseDecisionAnswers({ answers: { tier: { choice: 'gigantic' } } }), /tier/);
});

test('chat evaluator answers tolerate think blocks and fences', () => {
  const text = '<think>hmm, big refactor</think>\n```json\n{"tier":"frontier","effort":"high","confidence":88,"reason":"Multi-file refactor"}\n```';
  assert.deepEqual(parseChatEvaluatorText(text), { tier: 'frontier', effort: 'high', confidence: 0.88, reason: 'Multi-file refactor' });
  assert.throws(() => parseChatEvaluatorText('I think it is hard'), /JSON/);
});

test('only user-ending requests start a turn; state carries the request, not the transcript', () => {
  const body = {
    tools: [{}, {}],
    messages: [
      { role: 'system', content: 'You are Minnow' },
      { role: 'user', content: 'first ask' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: [{ type: 'text', text: 'why does this break?' }, { type: 'image_url', image_url: { url: 'data:' } }] },
    ],
  };
  assert.equal(isUserTurn(body), true);
  assert.deepEqual(buildDecisionState(body), {
    request: 'why does this break?', images_attached: 1, conversation_turns: 2, tools_available: 2, previous_request: 'first ask',
  });
  assert.equal(isUserTurn({ messages: [...body.messages, { role: 'assistant', tool_calls: [] }, { role: 'tool', content: 'x' }] }), false);
});

test('effort maps onto the levels a model accepts', () => {
  assert.equal(mapEffortToLevels('high', ['low', 'medium', 'high', 'xhigh']), 'high');
  assert.equal(mapEffortToLevels('high', ['minimal', 'low', 'medium']), 'medium');
  assert.equal(mapEffortToLevels('low', ['medium', 'max']), 'medium');
  assert.equal(mapEffortToLevels('medium', []), undefined);
});

test('routers accept the Auto policy, an evaluator, and entry tiers', () => {
  const entry = { id: 'a', providerId: 'p', modelId: 'm', concurrencyLimit: 1 };
  const valid = validateRouters({ routers: [{ id: 'r', name: 'Auto', policy: 'evaluate', evaluator: { providerId: 'or', modelId: ' typesafe/jev-1.13 ' }, entries: [{ ...entry, tier: 'fast' }] }] });
  assert.deepEqual(valid.routers[0].evaluator, { providerId: 'or', modelId: 'typesafe/jev-1.13' });
  assert.equal(valid.routers[0].entries[0].tier, 'fast');
  const unset = validateRouters({ routers: [{ id: 'r', name: 'Auto', policy: 'evaluate', evaluator: { providerId: '', modelId: '' }, entries: [entry] }] });
  assert.equal('evaluator' in unset.routers[0], false);
  assert.equal('tier' in unset.routers[0].entries[0], false);
  assert.throws(() => validateRouters({ routers: [{ id: 'r', name: 'Auto', policy: 'evaluate', entries: [{ ...entry, tier: 'huge' }] }] }), /tier/);
});

test('decideRoute judges user turns once, keeps tool rounds, and holds the tier when unsure', async () => {
  const scheduler = new RouterScheduler();
  const router = { id: 'auto', evaluator: { providerId: 'or', modelId: 'typesafe/jev-1.13' } };
  const user = (text) => ({ messages: [{ role: 'user', content: text }] });
  const answers = [];
  let calls = 0;
  const evaluate = async () => { calls++; return answers.shift(); };
  const deciding = [];

  answers.push({ tier: 'frontier', effort: 'high', confidence: 0.9, reason: 'Hard', judgedBy: 'Jev 1.13', source: 'evaluator' });
  const first = await decideRoute({ scheduler, router, chatId: 'c', body: user('refactor auth'), evaluate, onDeciding: (info) => deciding.push(info) });
  assert.equal(first.tier, 'frontier');
  assert.deepEqual(deciding, [{ judgedBy: 'Jev 1.13', first: true }]);

  const toolRound = await decideRoute({ scheduler, router, chatId: 'c', body: { messages: [{ role: 'user', content: 'x' }, { role: 'tool', content: 'y' }] }, evaluate });
  assert.equal(toolRound.source, 'turn');
  assert.equal(toolRound.tier, 'frontier');
  assert.equal(calls, 1);

  answers.push({ tier: 'fast', effort: 'low', confidence: 0.4, reason: 'Maybe easy', judgedBy: 'Jev 1.13', source: 'evaluator' });
  const unsure = await decideRoute({ scheduler, router, chatId: 'c', body: user('and the other thing'), evaluate, onDeciding: (info) => deciding.push(info) });
  assert.equal(unsure.source, 'kept');
  assert.equal(unsure.tier, 'frontier');
  assert.equal(deciding[1].first, false);

  answers.push({ tier: 'fast', effort: 'low', confidence: 0.95, reason: 'Rename', judgedBy: 'Jev 1.13', source: 'evaluator' });
  assert.equal((await decideRoute({ scheduler, router, chatId: 'c', body: user('rename x'), evaluate })).tier, 'fast');
  assert.equal(scheduler.activity({ id: 'auto', entries: [] }).decisions[0].tier, 'fast');
});

test('decideRoute never blocks a turn: failures, no evaluator, and overrides fall back', async () => {
  const scheduler = new RouterScheduler();
  const router = { id: 'auto', evaluator: { providerId: 'or', modelId: 'typesafe/jev-1.13' } };
  const body = { messages: [{ role: 'user', content: 'hi' }] };
  const failing = async () => { throw new Error('Evaluator HTTP 503'); };
  const none = await decideRoute({ scheduler, router, chatId: 'a', body, evaluate: failing });
  assert.equal(none.source, 'fallback');
  assert.equal(none.tier, null);
  assert.match(none.reason, /503/);

  scheduler.decisions.set(scheduler.assignmentKey('auto', 'b'), { tier: 'balanced', effort: 'medium', confidence: 0.8, reason: 'ok', judgedBy: 'Jev', source: 'evaluator' });
  const kept = await decideRoute({ scheduler, router, chatId: 'b', body, evaluate: failing });
  assert.equal(kept.tier, 'balanced');
  assert.match(kept.reason, /Kept the last choice/);

  const unset = await decideRoute({ scheduler, router: { id: 'auto' }, chatId: 'c', body, evaluate: failing });
  assert.equal(unset.source, 'fallback');
  assert.equal(unset.tier, null);

  scheduler.assignments[scheduler.assignmentKey('auto', 'd')] = { chatId: 'd', routerId: 'auto', assignmentMode: 'override', assignedEntryId: 'x', overrideEntryId: 'x' };
  let called = false;
  const pinned = await decideRoute({ scheduler, router, chatId: 'd', body, evaluate: async () => { called = true; } });
  assert.equal(pinned.source, 'override');
  assert.equal(called, false);
});

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { setTestHome, rmTestHome } from '../config/test-helpers.js';
import { ensureMinnowLayout } from '../../server/config/home.js';
import { createProvider } from '../../server/providers/store.js';
import { getRouterWorkspace } from '../../server/model-routers/store.js';
import { runRouterGeneration } from '../../server/model-routers/generation.js';
import { createGenerationState, deleteGenerationsForProviderShutdown } from '../../server/generations/store.js';

let home; let upstream; let workspace;
let decisionMode = 'ok';
let decisionCalls = [];
let chatCalls = [];

before(async () => {
  home = setTestHome(process.env, 'minnow-test-model-routers-evaluate'); await ensureMinnowLayout();
  upstream = http.createServer(async (req, res) => {
    if (req.method === 'GET') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ data: [
        { id: 'small-4b' },
        { id: 'big-70b', reasoning: { allowed_options: ['low', 'medium', 'high'], default: 'medium' } },
        { id: 'judge-1b' },
      ] }));
      return;
    }
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    if (req.url.endsWith('/v1/decisions')) {
      decisionCalls.push(body);
      if (decisionMode === 'error') { res.writeHead(503); res.end('busy'); return; }
      const hard = /refactor/.test(body.state.request);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        model: body.model,
        answers: {
          tier: { type: 'choice', choice: hard ? 'frontier' : 'fast', confidence: 0.92, probabilities: {} },
          effort: { type: 'choice', choice: hard ? 'high' : 'low', confidence: 0.8, probabilities: {} },
        },
      }));
      return;
    }
    if (body.model === 'judge-1b') {
      chatCalls.push({ model: body.model });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '{"tier":"frontier","effort":"medium","confidence":0.8,"reason":"Architecture question"}' } }] }));
      return;
    }
    chatCalls.push({ model: body.model, effort: body.reasoning_effort });
    res.setHeader('Content-Type', 'text/event-stream');
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `from ${body.model}` } }] })}\n\n`);
    res.end('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  await createProvider({ id: 'router-eval', label: 'Router eval', apiKind: 'openai-v1', baseUrl: `http://127.0.0.1:${upstream.address().port}` });
  workspace = await getRouterWorkspace();
  await workspace.save({
    revision: workspace.revision,
    defaultRouterId: 'auto',
    routers: [{
      id: 'auto', name: 'Auto', enabled: true, policy: 'evaluate',
      evaluator: { providerId: 'router-eval', modelId: 'jev' },
      entries: ['small-4b', 'big-70b'].map((id) => ({ id, modelId: id, providerId: 'router-eval', enabled: true, concurrencyLimit: 2 })),
    }],
  });
});
after(async () => { await workspace?.flush(); deleteGenerationsForProviderShutdown(); upstream.closeAllConnections(); await new Promise((resolve) => upstream.close(resolve)); await rmTestHome(home); });

const run = async (chatId, messages) => {
  const state = createGenerationState({ providerId: 'minnow-router', chatId, body: { model: 'auto', messages, stream: true } });
  await runRouterGeneration(state);
  assert.equal(state.status, 'complete', state.errorMessage);
  return Buffer.concat(state.chunks).toString();
};
const controls = (text) => text.split('\n').filter((l) => l.includes('minnow_router')).map((l) => JSON.parse(l.replace(/^data:\s*/, '')).minnow_router);

test('a hard request is judged once and runs on the frontier entry at high reasoning', async () => {
  decisionMode = 'ok'; decisionCalls = []; chatCalls = [];
  const text = await run('hard', [{ role: 'user', content: 'refactor the auth middleware across six files' }]);
  assert.deepEqual(chatCalls, [{ model: 'big-70b', effort: 'high' }]);
  assert.equal(decisionCalls.length, 1);
  assert.equal(decisionCalls[0].model, 'jev');
  const [deciding, generating] = controls(text);
  assert.equal(deciding.phase, 'deciding');
  assert.equal(deciding.first, true);
  assert.deepEqual(deciding.candidates, ['small-4b', 'big-70b']);
  assert.equal(generating.phase, 'generating');
  assert.equal(generating.decision.tier, 'frontier');
  assert.equal(generating.decision.effort, 'high');
  assert.equal(generating.decision.judgedBy, 'Jev');
  assert.equal(generating.decision.modelLabel, 'big-70b');
  assert.ok(text.indexOf('"phase":"deciding"') < text.indexOf('from big-70b'));

  chatCalls = [];
  const toolRound = await run('hard', [
    { role: 'user', content: 'refactor the auth middleware across six files' },
    { role: 'assistant', content: '', tool_calls: [{ id: 't1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 't1', content: 'file contents' },
  ]);
  assert.equal(decisionCalls.length, 1, 'tool rounds reuse the turn decision');
  assert.deepEqual(chatCalls, [{ model: 'big-70b', effort: 'high' }]);
  assert.equal(controls(toolRound).some((c) => c.phase === 'deciding'), false);
});

test('an easy request in the same chat moves down to the fast entry', async () => {
  decisionMode = 'ok'; decisionCalls = []; chatCalls = [];
  const text = await run('hard', [{ role: 'user', content: 'rename x to userId' }]);
  assert.deepEqual(chatCalls, [{ model: 'small-4b', effort: undefined }]);
  const deciding = controls(text).find((c) => c.phase === 'deciding');
  assert.equal(deciding.first, false);
});

test('an evaluator failure falls back to rank order and says why', async () => {
  decisionMode = 'error'; decisionCalls = []; chatCalls = [];
  const text = await run('fresh', [{ role: 'user', content: 'refactor everything' }]);
  assert.deepEqual(chatCalls, [{ model: 'small-4b', effort: undefined }]);
  const generating = controls(text).find((c) => c.phase === 'generating');
  assert.equal(generating.decision.source, 'fallback');
  assert.match(generating.decision.reason, /503/);
});

test('any chat model can judge when it answers as JSON', async () => {
  decisionMode = 'ok'; decisionCalls = []; chatCalls = [];
  const router = workspace.routers[0];
  await workspace.save({ revision: workspace.revision, defaultRouterId: 'auto', routers: [{ ...router, evaluator: { providerId: 'router-eval', modelId: 'judge-1b' } }] });
  const text = await run('chat-judge', [{ role: 'user', content: 'how should we split the server?' }]);
  assert.deepEqual(chatCalls, [{ model: 'judge-1b' }, { model: 'big-70b', effort: 'medium' }]);
  assert.equal(decisionCalls.length, 0);
  const generating = controls(text).find((c) => c.phase === 'generating');
  assert.equal(generating.decision.reason, 'Architecture question');
  assert.equal(generating.decision.judgedBy, 'judge-1b');
});

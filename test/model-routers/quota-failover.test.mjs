import { before, after, beforeEach, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { setTestHome, rmTestHome } from '../config/test-helpers.js';
import { ensureMinnowLayout } from '../../server/config/home.js';
import { createProvider, updateProviderSecrets, setAgentCliProviderEnabled, updateAgentCliProviderSettings } from '../../server/providers/store.js';
import { __setAgentCliPumpMocksForTests, __resetAgentCliPumpMocksForTests } from '../../server/generations/agent-cli/pump.js';
import { allowanceContext, getAllowanceTracker } from '../../server/generations/allowance.js';
import { createGenerationState, deleteGenerationsForProviderShutdown } from '../../server/generations/store.js';
import { getRouterWorkspace } from '../../server/model-routers/store.js';
import { runRouterGeneration, pumpRouterGeneration } from '../../server/model-routers/generation.js';
import { handleRouterRequest } from '../../server/model-routers/routes.js';
import { evaluateTask } from '../../server/model-routers/evaluator.js';
import { createTurnRunner, createMemoryTranscriptStore } from '../../server/runner/index.js';

let home, server, workspace, tracker, releasePrimary;
let mode, requests;
const entry = (id, providerId = 'quota-primary') => ({ id, providerId, modelId: id, enabled: true, concurrencyLimit: 1, tier: 'balanced' });
const pool = (id, entries = [entry('primary'), entry('backup', 'quota-backup')]) => ({ id, name: id, enabled: true, policy: 'priority', entries });
before(async () => {
  home = setTestHome(process.env, 'minnow-quota-routing');
  await ensureMinnowLayout();
  server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET') { res.end(JSON.stringify({ data: ['primary', 'sibling', 'backup', 'judge', 'jev'].map(id => ({ id })) })); return; }
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); requests.push(body);
    if (mode === 'queued' && body.model === 'primary') await new Promise(resolve => { releasePrimary = resolve; });
    if (body.model === 'primary' && !['healthy', 'stream-quota'].includes(mode) && !(mode === 'tools' && !body.messages.some(row => row.role === 'tool'))
      || mode === 'judge' && ['judge', 'jev'].includes(body.model)) {
      res.writeHead(429, { 'Retry-After': '3600' });
      res.end(JSON.stringify({ error: { code: 'insufficient_quota', message: 'Usage limit reached' } })); return;
    }
    if (['all', 'mixed'].includes(mode) && body.model === 'backup') { res.writeHead(mode === 'all' ? 402 : 503); res.end(mode === 'all' ? 'out of credits' : 'backup unavailable'); return; }
    if (body.stream === false) {
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '{"tier":"balanced","effort":"low","confidence":0.9}' } }] })); return;
    }
    res.setHeader('Content-Type', 'text/event-stream');
    if (mode === 'stream-quota' && body.model === 'primary') {
      res.end('data: {"choices":[{"delta":{"content":"Failed partial response"}}]}\n\ndata: {"error":{"code":"insufficient_quota","message":"Usage limit reached"}}\n\n'); return;
    }
    const tools = mode === 'tools' && body.model === 'primary';
    const delta = tools ? { tool_calls: [{ index: 0, id: 'saved', type: 'function', function: { name: 'save_file', arguments: '{"path":"saved.txt","content":"saved once"}' } }] } : { content: 'Completed with backup.' };
    res.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: tools ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  for (const id of ['quota-primary', 'quota-backup']) await createProvider({ id, label: id, apiKind: 'openai-v1', baseUrl: `http://127.0.0.1:${server.address().port}` });
  workspace = await getRouterWorkspace();
  tracker = await getAllowanceTracker();
});
beforeEach(async () => {
  tracker.rows.clear(); tracker.probes.clear(); mode = 'quota'; requests = []; releasePrimary = undefined;
  await workspace.save({ revision: workspace.revision, routers: [pool('first'), pool('second')], defaultRouterId: null });
});
afterEach(async () => { __resetAgentCliPumpMocksForTests(); releasePrimary?.(); await tracker.flush(); deleteGenerationsForProviderShutdown(); });
after(async () => {
  await workspace.flush(); await tracker.flush(); server.closeAllConnections();
  await new Promise(resolve => server.close(resolve)); await rmTestHome(home);
});
function generation(chatId, routerId = 'first', messages = [{ role: 'user', content: 'Do the task' }]) {
  return createGenerationState({ providerId: 'minnow-router', chatId, body: { model: routerId, messages, stream: true } });
}
async function waitUntil(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) { assert.ok(Date.now() < deadline, 'timed out'); await new Promise(resolve => setTimeout(resolve, 10)); }
}

test('quota failover is shared across chats and pools, persists, and keeps catalog revision', async () => {
  const revision = workspace.revision;
  const first = generation('a'); await runRouterGeneration(first);
  assert.equal(first.status, 'complete');
  assert.equal(first.chosenModelId, 'backup');
  assert.match(Buffer.concat(first.chunks).toString(), /primary is out of usage. Continuing with backup/);
  await runRouterGeneration(generation('b', 'second'));
  assert.deepEqual(requests.map(row => row.model), ['primary', 'backup', 'backup']);
  assert.equal(workspace.revision, revision);
  const persisted = JSON.parse(await fs.readFile(path.join(home, 'model-routers', 'allowances.json'), 'utf8'));
  assert.equal(Object.values(persisted.rows)[0].kind, 'quota');
  assert.doesNotMatch(JSON.stringify(persisted), /insufficient_quota|Usage limit reached/);
});

test('account-wide quota skips sibling models without blocking another configured account', async () => {
  await workspace.save({ revision: workspace.revision, routers: [pool('first', [entry('primary'), entry('sibling'), entry('backup', 'quota-backup')])], defaultRouterId: null });
  await runRouterGeneration(generation('siblings'));
  assert.deepEqual(requests.map(row => row.model), ['primary', 'backup']);
});

test('a streamed quota error clears failed partial output and blocks the allowance for other chats', async () => {
  mode = 'stream-quota';
  const state = generation('stream'); await runRouterGeneration(state);
  assert.equal(state.status, 'complete');
  const wire = Buffer.concat(state.chunks).toString();
  assert.ok(wire.indexOf('Failed partial response') < wire.indexOf('"reset":true'));
  assert.match(wire, /primary is out of usage/);
  await runRouterGeneration(generation('stream-next'));
  assert.deepEqual(requests.map(row => row.model), ['primary', 'backup', 'backup']);
});

test('queued requests reroute as soon as quota is recorded, with no capacity leaks', async () => {
  mode = 'queued';
  const a = generation('queue-a'); const running = runRouterGeneration(a);
  await waitUntil(() => releasePrimary);
  const b = generation('queue-b'); workspace.scheduler.override(workspace.routers[0], b.chatId, 'primary');
  const waiting = runRouterGeneration(b);
  await waitUntil(() => workspace.scheduler.activity(workspace.routers[0]).entries[0].queued === 1);
  releasePrimary(); await Promise.all([running, waiting]);
  assert.equal(requests.filter(row => row.model === 'primary').length, 1);
  assert.equal(a.status, 'complete'); assert.equal(b.status, 'complete');
  assert.ok(workspace.scheduler.activity(workspace.routers[0]).entries.every(row => row.active === 0 && row.queued === 0));
});

test('Retry now permits a real recovery, while credential changes invalidate old blocks', async () => {
  await runRouterGeneration(generation('blocked'));
  mode = 'healthy';
  let status, response;
  await handleRouterRequest({ method: 'POST' }, {}, '/api/generations/routers/first/retry', async () => ({ entryId: 'primary' }), (_res, code, body) => { status = code; response = body; });
  assert.equal(status, 200); assert.equal(response.availability.primary.available, true);
  assert.equal(requests.length, 2, 'manual retry must not spend inference');
  const recovered = generation('recovered'); await runRouterGeneration(recovered);
  assert.equal(recovered.chosenModelId, 'primary');
  assert.equal(tracker.rows.size, 0);
  tracker.record(await allowanceContext('quota-primary', 'primary'), { kind: 'quota', scope: 'provider' });
  await updateProviderSecrets('quota-primary', { apiKey: 'new-test-key' });
  assert.equal(tracker.availability(await allowanceContext('quota-primary', 'primary')).available, true);
});

test('chat and decision evaluators share quota blocks instead of retrying across new chats', async () => {
  for (const modelId of ['judge', 'jev']) {
    tracker.rows.clear(); requests = []; mode = 'judge';
    await assert.rejects(evaluateTask({ providerId: 'quota-primary', modelId }, { messages: [{ role: 'user', content: 'judge' }] }));
    await assert.rejects(evaluateTask({ providerId: 'quota-primary', modelId }, { messages: [{ role: 'user', content: 'judge again' }] }));
    assert.equal(requests.length, 1);
  }
});

test('all-quota exhaustion retains terminal quota metadata and actionable blockers', async () => {
  mode = 'all'; const state = generation('all'); pumpRouterGeneration(state);
  await waitUntil(() => state.status === 'error');
  assert.equal(state.quotaExceeded, true);
  assert.match(state.errorMessage, /quota-primary.*Out of usage.*quota-backup.*Out of usage/);
  assert.match(state.errorMessage, /retry after/);
});

test('mixed failures report both blockers without claiming every allowance is spent', async () => {
  mode = 'mixed'; const state = generation('mixed'); pumpRouterGeneration(state);
  await waitUntil(() => state.status === 'error');
  assert.equal(state.quotaExceeded, false);
  assert.match(state.errorMessage, /quota-primary.*Out of usage.*quota-backup.*503/);
});

test('Claude CLI quota falls back to the API and is remembered for subsequent chats', async () => {
  await setAgentCliProviderEnabled('claude', true);
  await updateAgentCliProviderSettings('claude', { binPath: process.execPath });
  const cliEntry = { ...entry('opus', 'claude-code-cli'), id: 'cli' };
  await workspace.save({ revision: workspace.revision, routers: [pool('first', [cliEntry, entry('backup', 'quota-backup')])], defaultRouterId: null });
  let starts = 0;
  __setAgentCliPumpMocksForTests({
    prepareInvocation: async () => ({ env: {} }),
    spawn: () => {
      starts++;
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      let finish;
      const done = new Promise(resolve => { finish = resolve; });
      queueMicrotask(() => child.stdout.write(JSON.stringify({ type: 'result', is_error: true, errors: ["You've hit your limit"] }) + '\n'));
      return { child, done, stop: async () => { finish({ code: 1, stderr: '' }); } };
    },
  });
  const first = generation('cli-a'); first.fallbackRole = 'default';
  await runRouterGeneration(first);
  const second = generation('cli-b'); second.fallbackRole = 'default';
  await runRouterGeneration(second);
  assert.equal(first.status, 'complete'); assert.equal(second.status, 'complete');
  assert.equal(first.chosenModelId, 'backup'); assert.equal(starts, 1);
  assert.deepEqual(requests.map(row => row.model), ['backup', 'backup']);
});

test('the shared runner keeps completed tool results when the next round changes providers', async () => {
  mode = 'tools'; let executions = 0;
  const runner = createTurnRunner({
      transcriptStore: createMemoryTranscriptStore(), resolveProvider: async () => ({ id: 'minnow-router', apiKind: 'openai-v1', baseUrl: '' }),
      getSubAgentTypeConfig: async () => ({}), resolveSamplerPreset: () => ({ preset: {}, maxTokens: 256 }),
      resolveThinkingMode: () => ({ mode: 'off' }), resolveThinkingBudgetTokens: () => ({ budgetTokens: null }),
      loadToolCallsMeta: async () => {}, getToolCallsMetaSync: () => ({ useConstrainedDecoding: false }),
      isConstrainedDecodingEnabledForProvider: () => false, readProviderCapabilities: async () => null,
      isStructuredOutcomeResponseFormatAvailable: () => false, resolveSendCapabilities: () => ({}), resolveModelContextLimit: () => null,
      applyContextPolicy: async input => ({ applied: false, messages: input.messages }),
      runHeadlessToolBatch: async options => {
        const outcomes = [];
        for (const toolCall of options.toolCalls) {
          const result = await options.execute(toolCall.function.name, JSON.parse(toolCall.function.arguments), { toolCallId: toolCall.id });
          const outcome = { toolCall, result }; options.onToolDone?.(outcome); outcomes.push(outcome);
        }
        return outcomes;
      },
      postChatCompletions: async (_provider, body) => {
        const state = createGenerationState({ providerId: 'minnow-router', chatId: 'tools', body });
        await runRouterGeneration(state);
        return new Response(Buffer.concat(state.chunks), { headers: { 'content-type': 'text/event-stream' } });
      },
  });
  const result = await runner.run({ runId: 'tools', type: 'turn', task: 'Save the file.', systemPrompt: 'Test',
    providerId: 'minnow-router', modelId: 'first', finalizeStructuredOutcome: false, nudgeToolUse: false,
    signal: AbortSignal.timeout(5000),
    tools: [{ type: 'function', function: { name: 'save_file', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } } } } }],
    executeTool: async () => { executions++; return { content: 'Saved once' }; },
  });
  assert.equal(executions, 1);
  assert.deepEqual(requests.map(row => row.model), ['primary', 'primary', 'backup']);
  assert.ok(requests.at(-1).messages.some(row => row.role === 'tool' && row.content.includes('Saved once')));
  assert.equal(result.summary, 'Completed with backup.');
});

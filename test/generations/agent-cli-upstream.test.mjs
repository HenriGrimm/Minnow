import assert from 'node:assert/strict';
import { after, afterEach, before, test } from 'node:test';
import { mkdtemp, readFile, readdir, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGenerationState, cancel } from '../../server/generations/store.js';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import { pumpAgentCliUpstream, __setAgentCliPumpMocksForTests, __resetAgentCliPumpMocksForTests, agentCliRoleAllowed } from '../../server/generations/agent-cli/pump.js';
import { pumpAgentCliSession, __setAgentCliSessionMocksForTests, __resetAgentCliSessionMocksForTests } from '../../server/generations/agent-cli/session.js';
import { runTurn, createMemoryTranscriptStore } from '../../server/runner/index.js';

const fixture = fileURLToPath(new URL('../fixtures/fake-agent-cli.mjs', import.meta.url));
const states = [];
let home;
const oldHome = process.env.MINNOW_HOME;
before(async () => { home = await mkdtemp(join(tmpdir(), 'minnow-cli-test-')); process.env.MINNOW_HOME = home; resetMinnowHomeCache(); });
after(async () => { if (oldHome === undefined) delete process.env.MINNOW_HOME; else process.env.MINNOW_HOME = oldHome; resetMinnowHomeCache(); await rm(home, { recursive: true, force: true }); });
afterEach(async () => { for (const state of states) clearTimeout(state.evictTimer); states.length = 0; __resetAgentCliPumpMocksForTests(); await __resetAgentCliSessionMocksForTests(); });

function setup(scenario, kind = 'claude', body = {}, options = {}) {
  const providerId = `fixture-${kind}`;
  const state = createGenerationState({ providerId, body: { model: 'fixture', stream: true, messages: [{ role: 'user', content: 'Hi' }], ...body }, fallbackRole: 'default' });
  states.push(state);
  const seen = [];
  __setAgentCliPumpMocksForTests({ prepareInvocation: async input => {
    seen.push(input);
    return { command: process.execPath, args: [fixture], cwd: input.tempDir, stdin: input.prompt, signal: input.signal,
      env: { ...process.env, ...input.bridgeConfig.env, FAKE_AGENT_CLI_SCENARIO: scenario, FAKE_AGENT_CLI_PID_OUT: join(home, 'pids.json'), ...options.fixtureEnv } };
  } });
  const runtime = { profile: { apiKind: 'agent-cli-v1', agentCli: { kind, maxConcurrent: 1 } }, secrets: {} };
  const run = () => pumpAgentCliUpstream({ state, runtime, candidate: { providerId, modelId: 'fixture' }, index: 0, idleMs: 2000, maxMs: 8000, canFailover: false, ...options });
  return { state, run, seen };
}

for (const kind of ['claude', 'codex', 'cursor']) test(`${kind} executable streams valid SSE and cleans its private directory`, async () => {
  const { state, run, seen } = setup(kind, kind);
  assert.equal((await run()).outcome, 'complete');
  assert.equal(state.status, 'complete');
  const wire = Buffer.concat(state.chunks).toString();
  assert.equal((wire.match(/Hello/g) ?? []).length, 1);
  assert.match(wire, /"total_tokens":17/);
  assert.ok(wire.endsWith('data: [DONE]\n\n'));
  assert.ok(!wire.includes('Startup banner'));
  await assert.rejects(access(seen[0].tempDir));
});

test('non-streaming inference returns one ordinary OpenAI completion object', async () => {
  const { state, run } = setup('claude', 'claude', { stream: false });
  await run();
  const result = JSON.parse(Buffer.concat(state.chunks));
  assert.equal(result.choices[0].message.content, 'Hello 🌊');
  assert.equal(result.choices[0].message.reasoning, 'Consider it.');
  assert.equal(result.choices[0].finish_reason, 'stop');
});

test('stdio MCP handoff returns one tool call, kills shim, and replays real results next round', async () => {
  const tools = [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }];
  const first = setup('tool', 'claude', { tools });
  const result = await first.run();
  assert.equal(result.outcome, 'complete');
  const chunks = Buffer.concat(first.state.chunks).toString().split('\n\n').filter(row => row.startsWith('data: {')).map(row => JSON.parse(row.slice(6)));
  const calls = chunks.flatMap(row => row.choices?.[0]?.delta?.tool_calls ?? []);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].function.name, 'read_file');
  assert.deepEqual(JSON.parse(calls[0].function.arguments), { path: 'src/main.ts' });
  assert.ok(chunks.findIndex(row => row.choices?.[0]?.delta?.tool_calls?.length) < chunks.findIndex(row => row.choices?.[0]?.finish_reason === 'tool_calls'));
  assert.equal(chunks.at(-1).choices[0].finish_reason, 'tool_calls');
  const pids = JSON.parse(await readFile(join(home, 'pids.json'), 'utf8'));
  for (const pid of Object.values(pids)) assert.throws(() => process.kill(pid, 0), /ESRCH/);
  const second = setup('claude', 'claude', { tools, messages: [
    { role: 'user', content: 'Read the source' }, { role: 'assistant', content: null, tool_calls: calls },
    { role: 'tool', tool_call_id: calls[0].id, content: 'Actual source code' },
  ] });
  await second.run();
  assert.match(second.seen[0].prompt, /Actual source code/);
  assert.match(second.seen[0].prompt, /read_file/);
});

test('parallel CLI tool requests share one model round', async () => {
  const tools = [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }];
  const { state, run } = setup('tool-batch', 'claude', { tools });
  assert.equal((await run()).outcome, 'complete');
  const chunks = Buffer.concat(state.chunks).toString().split('\n\n')
    .filter(row => row.startsWith('data: {')).map(row => JSON.parse(row.slice(6)));
  const calls = chunks.flatMap(row => row.choices?.[0]?.delta?.tool_calls ?? []);
  assert.deepEqual(calls.map(call => call.index), [0, 1]);
  assert.deepEqual(calls.map(call => JSON.parse(call.function.arguments).path), ['src/main.ts', 'src/other.ts']);
  assert.equal(chunks.at(-1).choices[0].finish_reason, 'tool_calls');
});

test('Claude keeps one process across a Minnow tool result and counts each model request once', async () => {
  const chatId = `claude-session-${Date.now()}`;
  const tools = [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }];
  const messages = [{ role: 'user', content: 'Read the file.' }];
  const seen = [];
  __setAgentCliSessionMocksForTests({ prepareInvocation: async input => {
    seen.push(input);
    return { command: process.execPath, args: [fixture], cwd: input.tempDir, stdin: input.prompt,
      env: { ...process.env, ...input.bridgeConfig.env, FAKE_AGENT_CLI_SCENARIO: 'tool-continue' } };
  } });
  const runtime = { profile: { agentCli: { kind: 'claude', maxConcurrent: 1 } }, secrets: {} };
  const candidate = { providerId: 'fixture-claude-session', modelId: 'fixture' };
  const makeState = rows => {
    const state = createGenerationState({ providerId: candidate.providerId,
      body: { model: 'fixture', stream: true, messages: rows, tools }, chatId, fallbackRole: 'default' });
    states.push(state);
    return state;
  };
  const first = makeState(messages);
  assert.equal((await pumpAgentCliSession({ state: first, runtime, candidate, index: 0, idleMs: 3000, maxMs: 8000, canFailover: false })).outcome, 'complete');
  const firstWire = Buffer.concat(first.chunks).toString();
  const calls = firstWire.split('\n\n').filter(row => row.startsWith('data: {'))
    .flatMap(row => JSON.parse(row.slice(6)).choices?.[0]?.delta?.tool_calls ?? [])
    .map(({ index: _index, ...call }) => call);
  assert.equal(calls.length, 1);
  assert.match(firstWire, /"finish_reason":"tool_calls"/);
  const second = makeState([...messages, { role: 'assistant', content: null, tool_calls: calls },
    { role: 'tool', tool_call_id: calls[0].id, content: 'Actual source' }]);
  assert.equal((await pumpAgentCliSession({ state: second, runtime, candidate, index: 0, idleMs: 3000, maxMs: 8000, canFailover: false })).outcome, 'complete');
  const secondWire = Buffer.concat(second.chunks).toString();
  assert.match(secondWire, /Used Actual source/);
  assert.match(secondWire, /"prompt_tokens":14/);
  assert.doesNotMatch(secondWire, /"prompt_tokens":100/);
  assert.equal(seen.length, 1, 'resuming the tool result must not launch another CLI');
});

for (const kind of ['claude', 'codex', 'cursor']) test(`shared runner resumes the same ${kind} process after executing its tool`, async () => {
  const seen = [];
  __setAgentCliSessionMocksForTests({ prepareInvocation: async input => {
    seen.push(input);
    return { command: process.execPath, args: [fixture], cwd: input.tempDir, stdin: input.prompt,
      env: { ...process.env, ...input.bridgeConfig.env, FAKE_AGENT_CLI_SCENARIO: 'tool-continue', FAKE_AGENT_CLI_KIND: kind, FAKE_AGENT_CLI_TOOL: 'read_file' } };
  } });
  const provider = { id: `fixture-${kind}-live-runner`, apiKind: 'agent-cli-v1', baseUrl: '' };
  const runtime = { profile: { agentCli: { kind, maxConcurrent: 1 } }, secrets: {} };
  const candidate = { providerId: provider.id, modelId: 'fixture' };
  const executed = [];
  const requests = [];
  await runTurn({
    chatId: `${kind}-live-runner-${Date.now()}`, seed: 'Read the source file.',
    model: { providerId: provider.id, id: 'fixture' }, limits: { maxTurns: 2 },
    tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }],
    execute: async (name, args) => { executed.push({ name, args }); return { content: 'Real file contents' }; },
    deps: {
      transcriptStore: createMemoryTranscriptStore(), resolveProvider: async () => provider,
      getSubAgentTypeConfig: async () => ({}), resolveSamplerPreset: () => ({ preset: {}, maxTokens: 256 }),
      resolveThinkingMode: () => ({ mode: 'off' }), resolveThinkingBudgetTokens: () => ({ budgetTokens: null }),
      loadToolCallsMeta: async () => {}, getToolCallsMetaSync: () => ({ useConstrainedDecoding: false }),
      isConstrainedDecodingEnabledForProvider: () => false, readProviderCapabilities: async () => null,
      isStructuredOutcomeResponseFormatAvailable: () => false, resolveSendCapabilities: () => ({}),
      resolveModelContextLimit: () => null,
      applyContextPolicy: async input => ({ applied: false, messages: input.messages }),
      runHeadlessToolBatch: async options => {
        const outcomes = [];
        for (const toolCall of options.toolCalls) outcomes.push({ toolCall, result: await options.execute(
          toolCall.function.name, JSON.parse(toolCall.function.arguments), { toolCallId: toolCall.id },
        ) });
        return outcomes;
      },
      postChatCompletions: async (_provider, body, _signal, options) => {
        requests.push(body);
        const state = createGenerationState({ providerId: provider.id, body, chatId: options.chatId, fallbackRole: 'default' });
        states.push(state);
        assert.equal((await pumpAgentCliUpstream({ state, runtime, candidate, index: 0, idleMs: 3000, maxMs: 8000, canFailover: false })).outcome, 'complete');
        return new Response(Buffer.concat(state.chunks), { headers: { 'content-type': 'text/event-stream' } });
      },
    },
  });
  assert.deepEqual(executed.map(call => call.name), ['read_file']);
  assert.equal(requests.length, 2);
  assert.equal(seen.length, 1, 'the runner must deliver the tool result to its existing CLI process');
  assert.match(Buffer.concat(states.at(-1).chunks).toString(), /"prompt_tokens":14/);
});

for (const kind of ['claude', 'codex', 'cursor']) test(`Stop cancels a live ${kind} session and removes its private files`, async () => {
  const seen = [];
  __setAgentCliSessionMocksForTests({ prepareInvocation: async input => {
    seen.push(input);
    return { command: process.execPath, args: [fixture], cwd: input.tempDir, stdin: input.prompt,
      env: { ...process.env, ...input.bridgeConfig.env, FAKE_AGENT_CLI_SCENARIO: 'hang' } };
  } });
  const providerId = `fixture-${kind}-cancel`;
  const state = createGenerationState({ providerId, chatId: `${kind}-cancel-${Date.now()}`,
    body: { model: 'fixture', stream: true, messages: [{ role: 'user', content: 'Wait' }] }, fallbackRole: 'default' });
  states.push(state);
  const running = pumpAgentCliSession({ state, runtime: { profile: { agentCli: { kind, maxConcurrent: 1 } }, secrets: {} },
    candidate: { providerId, modelId: 'fixture' }, index: 0,
    idleMs: 3000, maxMs: 8000, canFailover: false });
  setTimeout(() => cancel(state), 100);
  assert.equal((await running).outcome, 'complete', state.errorMessage);
  assert.equal(state.status, 'cancelled');
  assert.equal(seen.length, 1);
  await assert.rejects(access(seen[0].tempDir));
});

test('current Cursor stream-json deltas reach the OpenAI-compatible stream incrementally', async () => {
  const { state, run } = setup('cursor-current', 'cursor');
  assert.equal((await run()).outcome, 'complete');
  const chunks = Buffer.concat(state.chunks).toString().split('\n\n').filter(row => row.startsWith('data: {')).map(row => JSON.parse(row.slice(6)));
  assert.equal(chunks.map(row => row.choices?.[0]?.delta?.content ?? '').join(''), 'Hello 🌊');
  assert.equal(chunks.at(-1).choices[0].finish_reason, 'stop');
});

test('exit-zero auth failures are fatal and do not silently succeed or retry', async () => {
  const { state, run } = setup('auth', 'claude', {}, { canFailover: true });
  assert.equal((await run()).outcome, 'fatal');
  assert.equal(state.status, 'error');
  assert.match(state.errorMessage, /authentication failed/);
});

test('rate limits can fail over only before model output', async () => {
  const { state, run } = setup('rate-limit', 'claude', {}, { canFailover: true });
  const result = await run();
  assert.equal(result.outcome, 'retry');
  assert.equal(result.retrySameCandidate, false);
  assert.equal(result.hostSuspect, false);
  assert.equal(state.chunks.length, 0);
});

test('stderr does not keep an idle invocation alive', async () => {
  const { state, run, seen } = setup('stderr-hang', 'claude', {}, { idleMs: 120, maxMs: 5000 });
  assert.equal((await run()).outcome, 'fatal');
  assert.match(state.errorMessage, /stopped sending data/);
  await assert.rejects(access(seen[0].tempDir));
});

test('Stop cancels subprocesses and cleans temporary files', async () => {
  const { state, run, seen } = setup('hang');
  const promise = run();
  const timer = setTimeout(() => cancel(state), 150);
  try { assert.equal((await promise).outcome, 'complete'); } finally { clearTimeout(timer); }
  assert.equal(state.status, 'cancelled');
  if (seen.length) await assert.rejects(access(seen[0].tempDir));
});

test('oversized and unterminated/bannner-only output fails without fabricated text', async () => {
  for (const scenario of ['oversized', 'banner-only']) {
    const { state, run } = setup(scenario);
    assert.equal((await run()).outcome, 'fatal');
    assert.equal(state.status, 'error');
    assert.equal(state.chunks.length, 0);
  }
  assert.deepEqual(await readdir(join(home, 'tmp', 'agent-cli')), []);
});

test('background work requires explicit opt-in but agents and board roles remain selectable', () => {
  for (const role of ['utility', 'chat-titles', 'goal-eval', 'editor-completion', 'context-summarize', null]) assert.equal(agentCliRoleAllowed({ fallbackRole: role }, {}), false);
  for (const role of ['default', 'sub-agent', 'research', 'builder']) assert.equal(agentCliRoleAllowed({ fallbackRole: role }, {}), true);
  assert.equal(agentCliRoleAllowed({ fallbackRole: 'utility' }, { allowUtilityRoles: true }), true);
});

test('shared runner retains question/report interception, tool callbacks, and exactly-once execution across CLI rounds', async () => {
  const report = { outcome: 'pass', summary: 'Read and verified the source.', evidence: ['src/main.ts'] };
  const sequence = [
    { name: 'ask_question', args: { prompt: 'Which file?' } },
    { name: 'read_file', args: { path: 'src/main.ts' } },
    { name: 'report_outcome', args: report },
  ];
  const asked = [], executed = [], events = [], requests = [];
  const provider = { id: 'fixture-claude', apiKind: 'agent-cli-v1', baseUrl: '' };
  const result = await runTurn({
    chatId: 'cli-round-trip', seed: 'Read the requested file and report.',
    model: { providerId: provider.id, id: 'fixture' }, limits: { maxTurns: 4 },
    tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }],
    ask: { ask: async question => { asked.push(question); return JSON.stringify({ status: 'answered', answer: 'src/main.ts' }); } },
    execute: async (name, args) => { executed.push({ name, args }); return { content: 'Actual source from Minnow' }; },
    onEvent: event => events.push(event),
    deps: {
      transcriptStore: createMemoryTranscriptStore(),
      resolveProvider: async () => provider,
      getSubAgentTypeConfig: async () => ({}),
      resolveSamplerPreset: () => ({ preset: {}, maxTokens: 256 }),
      resolveThinkingMode: () => ({ mode: 'off' }),
      resolveThinkingBudgetTokens: () => ({ budgetTokens: null }),
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
        const next = sequence[requests.length];
        assert.ok(next, 'runner must not replay a completed report');
        requests.push(body);
        const turn = setup('tool', 'claude', body, { fixtureEnv: { FAKE_AGENT_CLI_TOOL: next.name, FAKE_AGENT_CLI_TOOL_ARGS: JSON.stringify(next.args) } });
        assert.equal((await turn.run()).outcome, 'complete');
        const activity = Buffer.from('data: {"choices":[{"index":0,"delta":{}}],"minnow_agent_cli":{"phase":"thinking"}}\n\n');
        return new Response(Buffer.concat([activity, ...turn.state.chunks]), { headers: { 'content-type': 'text/event-stream' } });
      },
    },
  });
  assert.deepEqual(result, report);
  assert.equal(asked.length, 1);
  assert.deepEqual(executed, [{ name: 'read_file', args: { path: 'src/main.ts' } }]);
  assert.equal(requests.length, 3);
  assert.ok(requests[2].messages.some(row => row.role === 'tool' && row.content.includes('Actual source from Minnow')));
  assert.ok(events.some(event => event.type === 'phase' && event.phase === 'thinking'));
  assert.ok(events.some(event => event.type === 'tool_streaming' && event.name === 'read_file'));
  assert.ok(events.some(event => event.type === 'tool_result' && event.name === 'read_file'));
});

test('shared runner executes a parallel CLI handoff in one round', async () => {
  const executed = [];
  const requests = [];
  const provider = { id: 'fixture-claude', apiKind: 'agent-cli-v1', baseUrl: '' };
  await runTurn({
    chatId: 'cli-batch-round-trip', seed: 'Read two independent files.',
    model: { providerId: provider.id, id: 'fixture' }, limits: { maxTurns: 2 },
    tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }],
    execute: async (name, args) => { executed.push({ name, args }); return { content: `Contents of ${args.path}` }; },
    deps: {
      transcriptStore: createMemoryTranscriptStore(),
      resolveProvider: async () => provider,
      getSubAgentTypeConfig: async () => ({}),
      resolveSamplerPreset: () => ({ preset: {}, maxTokens: 256 }),
      resolveThinkingMode: () => ({ mode: 'off' }),
      resolveThinkingBudgetTokens: () => ({ budgetTokens: null }),
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
        requests.push(body);
        const turn = setup(requests.length === 1 ? 'tool-batch' : 'claude', 'claude', body);
        assert.equal((await turn.run()).outcome, 'complete');
        return new Response(Buffer.concat(turn.state.chunks), { headers: { 'content-type': 'text/event-stream' } });
      },
    },
  });
  assert.equal(requests.length, 2);
  assert.deepEqual(executed.map((call) => call.args.path), ['src/main.ts', 'src/other.ts']);
  assert.equal(requests[1].messages.filter((row) => row.role === 'tool').length, 2);
});

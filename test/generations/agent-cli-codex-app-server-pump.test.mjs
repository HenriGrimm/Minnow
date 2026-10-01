import assert from 'node:assert/strict';
import { test, before, after, afterEach } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGenerationState, cancel } from '../../server/generations/store.js';
import { pumpCodexAppServer } from '../../server/generations/codex-app-server/pump.js';
import { pumpAgentCliUpstream } from '../../server/generations/agent-cli/pump.js';
import { __setCodexInvocationForTests, shutdownCodexSessions, codexSessionStats } from '../../server/generations/codex-app-server/manager.js';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import { getAgentCliOutput } from '../../server/generations/agent-cli/output.js';
import { runTurn, createMemoryTranscriptStore } from '../../server/runner/index.js';

const fixture = fileURLToPath(new URL('../fixtures/fake-codex-conversation.mjs', import.meta.url));
let root, processes = 0, scripts = [];
const states = [], oldHome = process.env.MINNOW_HOME, oldCodexHome = process.env.CODEX_HOME;
before(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-app-server-test-')); process.env.MINNOW_HOME = root; process.env.CODEX_HOME = root; resetMinnowHomeCache(); });
afterEach(async () => { await shutdownCodexSessions(); __setCodexInvocationForTests(); for (const state of states) clearTimeout(state.evictTimer); states.length = 0; });
after(async () => { if (oldHome == null) delete process.env.MINNOW_HOME; else process.env.MINNOW_HOME = oldHome;
  if (oldCodexHome == null) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldCodexHome;
  resetMinnowHomeCache(); await fs.rm(root, { recursive: true, force: true }); });
function setup(sequence, env = {}) {
  processes = 0; scripts = sequence;
  __setCodexInvocationForTests(session => { processes++; return { command: process.execPath, argsPrefix: [fixture], cwd: session.home,
    env: { ...process.env, MINNOW_CODEX_SCRIPTS: JSON.stringify(scripts), ...env } }; });
}
const tools = [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object', properties: {} } } }];
async function generate(messages, overrides = {}, settings = {}) {
  const state = createGenerationState({ providerId: 'codex-cli', chatId: settings.chatId === undefined ? 'test-chat' : settings.chatId, fallbackRole: 'default',
    body: { model: 'fixture', stream: true, messages, tools, ...overrides } }); states.push(state);
  const pump = settings.providerEntry ? pumpAgentCliUpstream : pumpCodexAppServer;
  const run = pump({ state, runtime: { profile: { agentCli: { kind: 'codex', sessionMode: 'replay', maxConcurrent: 1, ...settings.agentCli } }, secrets: {} },
    candidate: { providerId: 'codex-cli', modelId: 'fixture' }, index: 0, idleMs: 1000, maxMs: 5000, canFailover: false });
  if (settings.abort) setTimeout(() => cancel(state), settings.abortAfterMs ?? 100);
  await run;
  const wire = Buffer.concat(state.chunks).toString();
  return { state, wire, rows: wire.split('\n\n').filter(row => row.startsWith('data: {')).map(row => JSON.parse(row.slice(6))) };
}
test('ten matching follow-ups reuse one process and stream snapshots without duplicates', async () => {
  setup(Array.from({ length: 11 }, () => ({ text: 'Hello.', deltas: ['Hel', 'lo.'] })));
  const messages = [{ role: 'user', content: 'Start.' }];
  for (let i = 0; i < 11; i++) {
    const result = await generate(messages);
    assert.equal(result.state.status, 'complete');
    assert.equal(result.rows.map(row => row.choices?.[0]?.delta?.content ?? '').join(''), 'Hello.');
    assert.equal(result.rows.at(-1).usage.total_tokens, 25);
    messages.push({ role: 'assistant', content: 'Hello.' }, { role: 'user', content: `Next ${i}.` });
  }
  assert.equal(processes, 1); assert.equal(codexSessionStats().idle, 1);
});

test('context window reaches native config and changes rebuild retained conversations', async () => {
  const configs = [];
  __setCodexInvocationForTests(async session => {
    configs.push(await fs.readFile(path.join(session.home, 'config.toml'), 'utf8'));
    return { command: process.execPath, argsPrefix: [fixture], cwd: session.home,
      env: { ...process.env, MINNOW_CODEX_SCRIPTS: JSON.stringify([{ text: 'Reply.' }]) } };
  });
  const messages = [{ role: 'user', content: 'Start.' }];
  const first = await generate(messages, {}, { agentCli: { contextWindowTokens: 300_000 } });
  assert.equal(first.state.status, 'complete');
  messages.push({ role: 'assistant', content: 'Reply.' }, { role: 'user', content: 'Next.' });
  const second = await generate(messages, {}, { agentCli: { contextWindowTokens: 400_000 } });
  assert.equal(second.state.status, 'complete');
  assert.equal(configs.length, 2);
  assert.match(configs[0], /^model_context_window = 300000$/m);
  assert.match(configs[1], /^model_context_window = 400000$/m);
  assert.ok(configs[0].indexOf('model_context_window') < configs[0].indexOf('[tools]'));
});

test('the production provider entry selects app-server for legacy persisted replay profiles', async () => {
  setup([{ text: 'Default transport.' }]);
  const result = await generate([{ role: 'user', content: 'Hello.' }], {}, { providerEntry: true });
  assert.equal(result.state.status, 'complete'); assert.ok(result.wire.includes('Default transport.'));
  assert.equal(processes, 1);
});
test('parallel handoff, duplicate notification, real tool results and same-turn reattachment', async () => {
  setup([{ calls: [{ id: 'one', name: 'mn_tool_0', duplicate: true }, { id: 'two', name: 'mn_tool_0' }] }, { text: 'Done.' }]);
  const messages = [{ role: 'user', content: 'Read.' }];
  const first = await generate(messages);
  const calls = first.rows.flatMap(row => row.choices?.[0]?.delta?.tool_calls ?? []).map(({ index, ...call }) => call);
  assert.equal(calls.length, 2);
  messages.push({ role: 'assistant', content: '', tool_calls: calls }, ...calls.map(call => ({ role: 'tool', tool_call_id: call.id, content: 'Real result' })));
  const second = await generate(messages);
  assert.equal(second.state.status, 'complete'); assert.ok(second.wire.includes('Done.')); assert.equal(processes, 1);
});
test('history edits, changed tool permissions and instruction changes rebuild the native thread', async () => {
  setup([{ text: 'Reply.' }]);
  await generate([{ role: 'user', content: 'A.' }]);
  await generate([{ role: 'user', content: 'Edited.' }]);
  await generate([{ role: 'system', content: 'Plan mode.' }, { role: 'user', content: 'A.' }], { tools: [] });
  assert.equal(processes, 3);
});
test('compaction fails closed with a runner-recognized overflow and disposes native history', async () => {
  setup([{ compact: true }]);
  const result = await generate([{ role: 'user', content: 'Long context.' }]);
  assert.equal(result.state.status, 'error'); assert.match(result.state.errorMessage, /Context length exceeded/);
  await shutdownCodexSessions(); assert.equal(codexSessionStats().total, 0);
});
test('Stop interrupts a turn and shuts down its process and private home', async () => {
  setup([{ hang: true }]);
  const result = await generate([{ role: 'user', content: 'Wait.' }], {}, { abort: true });
  assert.equal(result.state.status, 'cancelled');
  await shutdownCodexSessions(); assert.equal(codexSessionStats().total, 0);
});
test('required tools cannot silently succeed and native unknown tools receive no execution authority', async () => {
  setup([{ text: 'No tool.' }]);
  const required = await generate([{ role: 'user', content: 'Use a tool.' }], { tool_choice: 'required' });
  assert.equal(required.state.status, 'error'); assert.match(required.state.errorMessage, /required tool/);
  setup([{ calls: [{ id: 'native', name: 'shell_command' }] }]);
  const native = await generate([{ role: 'user', content: 'Native.' }]);
  assert.equal(native.state.status, 'error'); assert.match(native.state.errorMessage, /unexposed/);
});
test('non-streaming uses existing completion shape', async () => {
  setup([{ text: 'JSON reply.' }]);
  const result = await generate([{ role: 'user', content: 'Hi.' }], { stream: false });
  const completion = JSON.parse(result.wire);
  assert.equal(completion.choices[0].message.content, 'JSON reply.'); assert.equal(completion.usage.total_tokens, 25);
});

test('native call IDs are scoped to turns and independent chats', async () => {
  setup([{ calls: [{ id: 'same-id', name: 'mn_tool_0' }] }, { text: 'Done.' },
    { calls: [{ id: 'same-id', name: 'mn_tool_0' }] }, { text: 'Again.' }]);
  const messages = [{ role: 'user', content: 'First.' }];
  const collect = result => result.rows.flatMap(row => row.choices?.[0]?.delta?.tool_calls ?? []).map(({ index, ...call }) => call);
  const first = collect(await generate(messages));
  messages.push({ role: 'assistant', content: '', tool_calls: first }, { role: 'tool', tool_call_id: first[0].id, content: 'Saved result' });
  await generate(messages);
  messages.push({ role: 'assistant', content: 'Done.' }, { role: 'user', content: 'Next.' });
  const second = collect(await generate(messages));
  assert.equal(second.length, 1); assert.notEqual(second[0].id, first[0].id);
  const other = collect(await generate([{ role: 'user', content: 'Other chat.' }], {}, { chatId: 'other' }));
  assert.equal(other.length, 1); assert.notEqual(other[0].id, first[0].id);
});

test('idle retention is bounded and disposal deletes every private home', async () => {
  setup([{ text: 'Idle.' }]);
  for (let i = 0; i < 12; i++) await generate([{ role: 'user', content: 'Hello.' }], {}, { chatId: `idle-${i}` });
  assert.ok(codexSessionStats().idle <= 8);
  await shutdownCodexSessions();
  assert.equal(codexSessionStats().total, 0);
  assert.deepEqual(await fs.readdir(path.join(root, 'tmp', 'codex-app-server')), []);
});

function runnerDeps(overrides = {}) {
  return {
    transcriptStore: createMemoryTranscriptStore(),
    postChatCompletions: async (_provider, body) => {
      const { state, wire } = await generate(body.messages, body);
      return new Response(state.status === 'error' ? state.errorMessage : wire, {
        status: state.status === 'error' ? 400 : 200, headers: { 'Content-Type': 'text/event-stream' },
      });
    },
    runHeadlessToolBatch: async options => {
      const outcomes = [];
      for (const toolCall of options.toolCalls) {
        const result = await options.execute(toolCall.function.name, JSON.parse(toolCall.function.arguments), { toolCallId: toolCall.id });
        const outcome = { toolCall, result }; options.onToolDone?.(outcome); outcomes.push(outcome);
      }
      return outcomes;
    },
    resolveProvider: async () => ({ id: 'codex-cli', apiKind: 'openai-v1', baseUrl: 'http://127.0.0.1:9' }),
    getSubAgentTypeConfig: async () => ({}), resolveSamplerPreset: () => ({ preset: {}, maxTokens: 256 }),
    resolveThinkingMode: () => ({ mode: 'off' }), resolveThinkingBudgetTokens: () => ({ budgetTokens: null }),
    loadToolCallsMeta: async () => {}, getToolCallsMetaSync: () => ({ useConstrainedDecoding: false }),
    isConstrainedDecodingEnabledForProvider: () => false, readProviderCapabilities: async () => null,
    isStructuredOutcomeResponseFormatAvailable: () => false, resolveSendCapabilities: () => ({}),
    resolveModelContextLimit: () => 8192,
    applyContextPolicy: async input => ({ applied: false, messages: input.messages }), ...overrides,
  };
}

test('shared runner executes duplicated native calls once and retains real denied results', async () => {
  setup([{ calls: [{ id: 'read', name: 'mn_tool_0', duplicate: true, args: { path: 'safe' } },
    { id: 'denied', name: 'mn_tool_0', args: { path: 'blocked' } }] }, { text: 'Finished.' }]);
  const executed = [], events = [];
  const result = await runTurn({ chatId: 'runner', seed: 'Read files.', tools, lazyTools: false,
    model: { providerId: 'codex-cli', id: 'fixture' }, deps: runnerDeps(),
    injectReportTool: false, nudgeToolUse: false, finalizeStructuredOutcome: false,
    execute: async (_name, args) => { executed.push(args.path); return { content: args.path === 'blocked' ? 'Error: permission denied' : 'Actual file contents' }; },
    onEvent: event => events.push(event),
  });
  assert.equal(result.outcome, 'no_report'); assert.deepEqual(executed, ['safe', 'blocked']);
  assert.equal(processes, 1);
  assert.ok(events.some(event => event.type === 'tool_result' && event.content.includes('permission denied')));
});

test('shared runner compacts its own transcript before rebuilding after native compaction', async () => {
  setup([{ compact: true }]);
  let compacted = false;
  const result = await runTurn({ chatId: 'runner-overflow', seed: '', seedKind: 'continue', tools: [],
    messages: [{ role: 'system', content: 'Instructions' }, { role: 'user', content: 'Old' },
      { role: 'assistant', content: 'Old response '.repeat(400) }, { role: 'user', content: 'Continue' }],
    model: { providerId: 'codex-cli', id: 'fixture' }, lazyTools: false,
    injectReportTool: false, nudgeToolUse: false, finalizeStructuredOutcome: false,
    limits: { contextBudget: { enforcementPolicy: 'slide' } },
    deps: runnerDeps({ applyContextPolicy: async input => {
      if (input.effectiveLimitOverride != null) {
        compacted = true; scripts = [{ text: 'Recovered.' }];
        return { applied: true, messages: [input.messages[0], input.messages.at(-1)], tokensAfter: 8 };
      }
      return { applied: false, messages: input.messages };
    } }),
  });
  assert.equal(result.outcome, 'no_report', result.error); assert.equal(compacted, true); assert.equal(processes, 2);
});

test('questions and terminal reports remain runner capabilities', async () => {
  const question = { questions: [{ id: 'q', prompt: 'Choose', options: [{ id: 'a', label: 'A' }] }] };
  setup([{ calls: [{ id: 'ask', name: 'mn_tool_0', duplicate: true, args: question }] }, { text: 'Answered.' }]);
  let asks = 0;
  const asked = await runTurn({ chatId: 'runner-question', seed: 'Ask me.', tools: [], lazyTools: false,
    model: { providerId: 'codex-cli', id: 'fixture' }, deps: runnerDeps(),
    injectReportTool: false, nudgeToolUse: false, finalizeStructuredOutcome: false,
    ask: { ask: async value => { asks++; assert.deepEqual(value, question); return 'A'; } },
    execute: async () => { throw new Error('Human question reached server execution'); },
  });
  assert.equal(asked.outcome, 'no_report'); assert.equal(asks, 1);
  setup([{ calls: [{ id: 'report', name: 'mn_tool_0', duplicate: true,
    args: { outcome: 'pass', summary: 'Checked.', evidence: ['fixture'] } }] }]);
  const reported = await runTurn({ chatId: 'runner-report', seed: 'Report.', tools: [], lazyTools: false,
    model: { providerId: 'codex-cli', id: 'fixture' }, deps: runnerDeps(),
    execute: async () => { throw new Error('Report reached server execution'); },
  });
  assert.equal(reported.outcome, 'pass'); assert.equal(reported.summary, 'Checked.');
});

test('source login changes rebuild an otherwise matching conversation', async () => {
  setup([{ text: 'Reply.' }]);
  const authPath = path.join(root, 'auth.json');
  await fs.writeFile(authPath, JSON.stringify({ tokens: { access_token: 'first-login' } }));
  const messages = [{ role: 'user', content: 'Hello.' }];
  await generate(messages);
  messages.push({ role: 'assistant', content: 'Reply.' }, { role: 'user', content: 'Again.' });
  await fs.writeFile(authPath, JSON.stringify({ tokens: { access_token: 'second-login' } }));
  await generate(messages);
  assert.equal(processes, 2);
  await fs.rm(authPath);
});

test('a process crash after recorded tool work does not trigger transport replay', async () => {
  setup([{ calls: [{ id: 'edit', name: 'mn_tool_0' }] }, { crash: true }]);
  const messages = [{ role: 'user', content: 'Edit.' }];
  const first = await generate(messages);
  const calls = first.rows.flatMap(row => row.choices?.[0]?.delta?.tool_calls ?? []).map(({ index, ...call }) => call);
  messages.push({ role: 'assistant', content: '', tool_calls: calls }, { role: 'tool', tool_call_id: calls[0].id, content: 'Edit committed once' });
  const crashed = await generate(messages);
  assert.equal(crashed.state.status, 'error'); assert.equal(processes, 1);
  scripts = [{ text: 'Recovered.' }];
  const recovered = await generate(messages);
  assert.equal(recovered.state.status, 'complete'); assert.equal(processes, 2);
  assert.equal(recovered.rows.flatMap(row => row.choices?.[0]?.delta?.tool_calls ?? []).length, 0);
});

test('queued cancellation settles without waiting for the running conversation', async () => {
  setup([{ hang: true }]);
  const running = generate([{ role: 'user', content: 'Hold.' }], {}, { chatId: 'held' });
  const started = performance.now();
  const queued = await generate([{ role: 'user', content: 'Queued.' }], {}, { chatId: 'queued', abort: true });
  assert.equal(queued.state.status, 'cancelled'); assert.ok(performance.now() - started < 700);
  assert.notEqual(states[0].status, 'complete'); assert.equal(processes, 1);
  cancel(states[0]); await running;
});

test('unresponsive interruption is bounded and identity-less requests remain disposable', async () => {
  setup([{ hang: true }], { MINNOW_CODEX_IGNORE_INTERRUPT: '1' });
  const started = performance.now();
  const stopped = await generate([{ role: 'user', content: 'Wait.' }], {}, { abort: true, abortAfterMs: 800 });
  assert.equal(stopped.state.status, 'cancelled'); assert.ok(performance.now() - started < 5000);
  await shutdownCodexSessions(); assert.equal(codexSessionStats().total, 0);
  setup([{ text: 'Disposable.' }]);
  await generate([{ role: 'user', content: 'Utility.' }], {}, { chatId: null });
  await shutdownCodexSessions(); assert.equal(codexSessionStats().total, 0);
});

test('copied file credentials are redacted from native errors and retained raw output', async () => {
  const secret = 'private-file-login-secret', authPath = path.join(root, 'auth.json');
  await fs.writeFile(authPath, JSON.stringify({ tokens: { access_token: secret } }));
  setup([{ error: `Provider rejected ${secret}` }]);
  try {
    const result = await generate([{ role: 'user', content: 'Error.' }]);
    assert.equal(result.state.status, 'error'); assert.doesNotMatch(result.state.errorMessage, new RegExp(secret));
    assert.match(result.state.errorMessage, /redacted/);
    assert.doesNotMatch(getAgentCliOutput('test-chat').output, new RegExp(secret));
  } finally { await shutdownCodexSessions(); await fs.rm(authPath); }
});

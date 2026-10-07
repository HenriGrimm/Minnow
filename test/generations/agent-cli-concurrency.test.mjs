import assert from 'node:assert/strict';
import { test, before, after, afterEach } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGenerationState, cancel } from '../../server/generations/store.js';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import { pumpAgentCliUpstream } from '../../server/generations/agent-cli/pump.js';
import { __setAgentCliSessionMocksForTests, __resetAgentCliSessionMocksForTests } from '../../server/generations/agent-cli/session.js';
import { __setCodexInvocationForTests, shutdownCodexSessions } from '../../server/generations/codex-app-server/manager.js';
import { getAgentCliOutput } from '../../server/generations/agent-cli/output.js';

const codexFixture = fileURLToPath(new URL('../fixtures/fake-codex-conversation.mjs', import.meta.url));
const cliFixture = fileURLToPath(new URL('../fixtures/fake-agent-cli.mjs', import.meta.url));
const previous = Object.fromEntries(['MINNOW_HOME', 'CODEX_HOME', 'MINNOW_CODEX_LEGACY_EXEC', 'MINNOW_AGENT_CLI_REPLAY'].map(key => [key, process.env[key]]));
const runs = [];
let root;
before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-cli-concurrency-'));
  process.env.MINNOW_HOME = root; process.env.CODEX_HOME = root;
  delete process.env.MINNOW_CODEX_LEGACY_EXEC; delete process.env.MINNOW_AGENT_CLI_REPLAY;
  await fs.writeFile(path.join(root, 'auth.json'), JSON.stringify({ tokens: { account_id: 'fixture-account', access_token: 'fixture-token' } }));
  resetMinnowHomeCache();
});
afterEach(async () => {
  for (const { state } of runs) cancel(state);
  await Promise.all(runs.map(run => run.done));
  await shutdownCodexSessions(); __setCodexInvocationForTests();
  await __resetAgentCliSessionMocksForTests();
  for (const { state } of runs) clearTimeout(state.evictTimer);
  runs.length = 0;
});
after(async () => {
  for (const [key, value] of Object.entries(previous)) {
    if (value == null) delete process.env[key]; else process.env[key] = value;
  }
  resetMinnowHomeCache(); await fs.rm(root, { recursive: true, force: true });
});
async function until(predicate, message) {
  const deadline = Date.now() + 3000;
  while (!await predicate()) {
    assert.ok(Date.now() < deadline, message);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

for (const kind of ['codex', 'claude', 'cursor']) test(`${kind} runs two chats concurrently, respects the limit, and releases cancelled slots`, async () => {
  const prepared = [];
  if (kind === 'codex') __setCodexInvocationForTests(session => {
    prepared.push(session.home);
    return { command: process.execPath, argsPrefix: [codexFixture], cwd: session.home,
      env: { ...process.env, MINNOW_CODEX_SCRIPTS: JSON.stringify([{ hang: true }]) } };
  });
  else __setAgentCliSessionMocksForTests({ prepareInvocation: async input => {
    prepared.push(input.tempDir);
    return { command: process.execPath, args: [cliFixture], cwd: input.tempDir, stdin: input.prompt,
      env: { ...process.env, ...input.bridgeConfig.env, FAKE_AGENT_CLI_SCENARIO: 'hang',
        FAKE_AGENT_CLI_STDIN_OUT: path.join(input.tempDir, 'inference-started') } };
  } });
  const start = label => {
    const providerId = `concurrency-${kind}`;
    const state = createGenerationState({ providerId, chatId: `${providerId}-${label}`, fallbackRole: 'default',
      body: { model: 'fixture', stream: true, messages: [{ role: 'user', content: label }] } });
    const done = pumpAgentCliUpstream({ state,
      runtime: { profile: { agentCli: { kind, maxConcurrent: 2 } }, secrets: {} },
      candidate: { providerId, modelId: 'fixture' }, index: 0, idleMs: 0, maxMs: 15000, canFailover: false });
    const run = { state, done }; runs.push(run); return run;
  };
  const started = async (run, index) => kind === 'codex'
    ? getAgentCliOutput(run.state.chatId)?.output.includes('turn/started')
    : prepared[index] && await fs.access(path.join(prepared[index], 'inference-started')).then(() => true, () => false);
  const first = start('first');
  await until(() => started(first, 0), 'first chat did not reach inference');
  const second = start('second');
  await until(() => started(second, 1), 'second chat waited for the first inference to finish');
  assert.equal(first.state.status, 'streaming');
  assert.equal(second.state.status, 'streaming');

  const cancelled = start('cancelled-while-queued');
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(prepared.length, 2, 'configured concurrency must not be exceeded');
  cancel(cancelled.state); await cancelled.done;
  assert.equal(cancelled.state.status, 'cancelled');

  const next = start('next');
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(prepared.length, 2, 'cancelling a queued request must not release an active slot');
  cancel(first.state); await first.done;
  await until(() => started(next, 2), 'cancelling an active chat did not free its slot');
  assert.equal(second.state.status, 'streaming', 'other active inference must continue');
  assert.equal(next.state.status, 'streaming');
  assert.equal(prepared.length, 3);
});

test('Codex returns tools to a warm session while another chat is still generating', async () => {
  __setCodexInvocationForTests(session => ({ command: process.execPath, argsPrefix: [codexFixture], cwd: session.home,
    env: { ...process.env, MINNOW_CODEX_SCRIPTS: JSON.stringify(session.chatId === 'busy-chat'
      ? [{ hang: true }] : [{ calls: [{ id: 'read', name: 'mn_tool_0' }] }, { text: 'Tool result received.' }]) } }));
  const messages = [{ role: 'user', content: 'Read a file.' }];
  const start = (chatId, rows = messages) => {
    const providerId = 'concurrency-codex-tools';
    const state = createGenerationState({ providerId, chatId, fallbackRole: 'default', body: {
      model: 'fixture', stream: true, messages: rows,
      tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object', properties: {} } } }],
    } });
    const done = pumpAgentCliUpstream({ state, runtime: { profile: { agentCli: { kind: 'codex', maxConcurrent: 2 } }, secrets: {} },
      candidate: { providerId, modelId: 'fixture' }, index: 0, idleMs: 0, maxMs: 15000, canFailover: false });
    const run = { state, done }; runs.push(run); return run;
  };
  const first = start('tool-chat'); await first.done;
  assert.equal(first.state.status, 'complete', first.state.errorMessage);
  const calls = Buffer.concat(first.state.chunks).toString().split('\n\n').filter(row => row.startsWith('data: {'))
    .flatMap(row => JSON.parse(row.slice(6)).choices?.[0]?.delta?.tool_calls ?? []).map(({ index, ...call }) => call);
  assert.equal(calls.length, 1);
  const busy = start('busy-chat');
  await until(() => getAgentCliOutput(busy.state.chatId)?.output.includes('turn/started'), 'busy chat did not reach inference');
  const resumed = start('tool-chat', [...messages, { role: 'assistant', content: '', tool_calls: calls },
    { role: 'tool', tool_call_id: calls[0].id, content: 'Recorded file contents.' }]);
  await until(() => ['complete', 'error'].includes(resumed.state.status), 'tool result waited behind unrelated inference');
  await resumed.done;
  assert.equal(resumed.state.status, 'complete', resumed.state.errorMessage);
  assert.equal(busy.state.status, 'streaming');
  const wire = Buffer.concat(resumed.state.chunks).toString();
  assert.match(wire, /Tool result received/);
  assert.match(wire, /"continuation":"reused"/);
});

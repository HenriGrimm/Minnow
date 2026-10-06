// Manual protocol probe: installed Claude, isolated credentials, local inference only.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prepareAgentCliInvocation } from '../../server/generations/agent-cli/invocation.js';
import { pumpAgentCliSession, __setAgentCliSessionMocksForTests, __resetAgentCliSessionMocksForTests } from '../../server/generations/agent-cli/session.js';
import { disposeCliSessions } from '../../server/generations/agent-cli/lifecycle.js';
import { createGenerationState } from '../../server/generations/store.js';
import { readCliCheckpoint } from '../../server/generations/agent-cli/checkpoints.js';
import { resetMinnowHomeCache } from '../../server/config/home.js';

const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-native-recovery-'));
const requests = [];
const previous = { home: process.env.MINNOW_HOME, claude: process.env.CLAUDE_CONFIG_DIR };
let processes = 0;
const server = createServer(async (req, res) => {
  if (!req.url?.startsWith('/v1/messages')) { res.writeHead(200).end('{}'); return; }
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks)); requests.push(body);
  if (requests.length > 3) { res.writeHead(400).end('{}'); return; }
  const tool = requests.length === 1;
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const events = [
    ['message_start', { type: 'message_start', message: { id: `recovery-${requests.length}`, type: 'message', role: 'assistant', content: [], model: body.model, stop_reason: null, usage: { input_tokens: 2, output_tokens: 0 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: tool ? { type: 'tool_use', id: 'native-call', name: 'mcp__minnow__ping', input: { value: 1 } } : { type: 'text', text: '' } }],
    ...(!tool ? [['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Recovered.' } }]] : []),
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ...(tool ? [
      ['content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'native-call-2', name: 'mcp__minnow__ping', input: { value: 2 } } }],
      ['content_block_stop', { type: 'content_block_stop', index: 1 }],
      ['content_block_start', { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'Response after early tool dispatch.' } }],
      ['content_block_stop', { type: 'content_block_stop', index: 2 }],
    ] : []),
    ['message_delta', { type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } }],
    ['message_stop', { type: 'message_stop' }],
  ];
  for (const [event, data] of events) {
    // Native Claude dispatches MCP calls while later response blocks stream.
    if (tool && event === 'content_block_start' && data.index === 2) await new Promise(resolve => setTimeout(resolve, 1000));
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }
  res.end();
});
try {
  process.env.MINNOW_HOME = scratch;
  process.env.CLAUDE_CONFIG_DIR = path.join(scratch, 'claude-config');
  resetMinnowHomeCache();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  __setAgentCliSessionMocksForTests({ prepareInvocation: async input => {
    processes++;
    const invocation = await prepareAgentCliInvocation(input);
    invocation.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${server.address().port}`;
    invocation.env.CLAUDE_CONFIG_DIR = path.join(scratch, 'claude-config');
    delete invocation.env.CLAUDE_CODE_OAUTH_TOKEN; delete invocation.env.ANTHROPIC_AUTH_TOKEN;
    return invocation;
  } });
  const messages = [{ role: 'system', content: 'Use Minnow tools only.' }, { role: 'user', content: 'Call ping. Expensive original context.' }];
  const generate = async () => {
    const state = createGenerationState({ providerId: 'claude-code-cli', chatId: 'native-recovery', fallbackRole: 'default',
      body: { model: 'opus', stream: false, messages, tools: [{ type: 'function', function: { name: 'ping', parameters: { type: 'object', properties: { value: { type: 'number' } } } } }] } });
    const result = await pumpAgentCliSession({ state, runtime: { profile: { agentCli: { kind: 'claude', maxConcurrent: 1, contextWindowTokens: 1_000_000 } }, secrets: { cliToken: 'fake-local-key' } },
      candidate: { providerId: 'claude-code-cli', modelId: 'opus' }, index: 0, idleMs: 15000, maxMs: 30000, canFailover: false });
    clearTimeout(state.evictTimer);
    assert.equal(result.outcome, 'complete', state.errorMessage);
    return JSON.parse(Buffer.concat(state.chunks));
  };
  const first = await generate();
  assert.equal(first.usage.completion_tokens, 3, 'handoff must include final streamed usage');
  assert.equal(first.choices[0].message.content, 'Response after early tool dispatch.');
  let assistant = first.choices[0].message;
  let toolCount = 0;
  while (true) {
    assert.ok(assistant.tool_calls.length >= 1);
    toolCount += assistant.tool_calls.length;
    messages.push(assistant, ...assistant.tool_calls.map(call => ({ role: 'tool', tool_call_id: call.id, content: 'Actual completed result' })));
    if (toolCount >= 2) break;
    assistant = (await generate()).choices[0].message;
  }
  assert.equal(toolCount, 2);
  assert.equal(requests.length, 1, 'serial MCP handoffs must not cause another inference request');
  const checkpoint = await readCliCheckpoint('claude-code-cli', 'native-recovery');
  assert.equal(checkpoint.clean, true);
  assert.deepEqual(checkpoint.pendingCalls, assistant.tool_calls.map(call => call.id));
  await disposeCliSessions();
  const second = await generate();
  assert.equal(second.minnow_cli.continuation, 'resumed');
  assert.equal(second.minnow_cli.model, requests[1].model);
  assert.equal(second.choices[0].message.content, 'Recovered.');
  messages.push(second.choices[0].message, { role: 'user', content: 'Follow up.' });
  await disposeCliSessions();
  const third = await generate();
  assert.equal(third.minnow_cli.continuation, 'resumed');
  console.log(JSON.stringify({ models: requests.map(r => r.model), requests: requests.length,
    processes, firstUserPreserved: JSON.stringify(requests[0].messages[0]) === JSON.stringify(requests[1].messages[0]) }));
  assert.equal(requests.length, 3);
  assert.deepEqual(requests[0].messages[0], requests[1].messages[0]);
  assert.ok(JSON.stringify(requests[1].messages).includes('Actual completed result'));
  assert.equal(JSON.stringify(requests[1].messages).split('Expensive original context').length, 2, 'original history must appear once');
} finally {
  await __resetAgentCliSessionMocksForTests(); server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  for (const [name, value] of [['MINNOW_HOME', previous.home], ['CLAUDE_CONFIG_DIR', previous.claude]]) {
    if (value == null) delete process.env[name]; else process.env[name] = value;
  }
  resetMinnowHomeCache();
  await fs.rm(scratch, { recursive: true, force: true });
}

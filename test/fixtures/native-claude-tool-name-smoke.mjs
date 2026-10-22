// Installed Claude, real interactive adapter, isolated credentials and local inference only.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prepareAgentCliInvocation } from '../../server/generations/agent-cli/invocation.js';
import { pumpAgentCliSession, __setAgentCliSessionMocksForTests, __resetAgentCliSessionMocksForTests } from '../../server/generations/agent-cli/session.js';
import { createGenerationState } from '../../server/generations/store.js';
import { getAgentCliOutput } from '../../server/generations/agent-cli/output.js';
import { resetMinnowHomeCache } from '../../server/config/home.js';

const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-native-tool-name-'));
const previous = { home: process.env.MINNOW_HOME, claude: process.env.CLAUDE_CONFIG_DIR };
const requests = [], states = [];
let serverError, processes = 0;
const server = createServer((req, res) => {
  void respond(req, res).catch(error => { serverError = error; res.destroy(); });
});
async function respond(req, res) {
  if (!req.url?.startsWith('/v1/messages')) { res.writeHead(200).end('{}'); return; }
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks)); requests.push(body);
  assert.ok(requests.length <= 4, 'unexpected inference retry');
  const number = requests.length;
  const send = data => res.write(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`);
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  send({ type: 'message_start', message: { id: `tool-name-${number}`, type: 'message', role: 'assistant', content: [], model: body.model,
    stop_reason: null, usage: { input_tokens: 2, output_tokens: 0 } } });
  if (number <= 2) {
    send({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `native-${number}`,
      name: number === 1 ? 'browser_eval' : 'mcp__minnow__browser_eval', input: {} } });
    send({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ expression: 'document.title' }) } });
  } else {
    send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Recovered.\n' } });
  }
  send({ type: 'content_block_stop', index: 0 });
  send({ type: 'message_delta', delta: { stop_reason: number <= 2 ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } });
  send({ type: 'message_stop' }); res.end();
}
try {
  process.env.MINNOW_HOME = scratch;
  process.env.CLAUDE_CONFIG_DIR = path.join(scratch, 'claude-config');
  resetMinnowHomeCache();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  __setAgentCliSessionMocksForTests({ prepareInvocation: async input => {
    processes++;
    const config = process.env.CLAUDE_CONFIG_DIR;
    await fs.mkdir(config, { recursive: true });
    await fs.writeFile(path.join(config, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark',
      customApiKeyResponses: { approved: ['fake-local-key'], rejected: [] },
      projects: { [input.tempDir.replaceAll('\\', '/')]: { hasTrustDialogAccepted: true } } }));
    const invocation = await prepareAgentCliInvocation(input);
    invocation.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${server.address().port}`;
    delete invocation.env.CLAUDE_CODE_OAUTH_TOKEN; delete invocation.env.ANTHROPIC_AUTH_TOKEN;
    return invocation;
  } });
  const messages = [{ role: 'system', content: 'Use Minnow tools only.' }, { role: 'user', content: 'Inspect the page title.' }];
  const generate = async () => {
    const state = createGenerationState({ providerId: 'claude-code-cli', chatId: 'native-tool-name', fallbackRole: 'default', body: {
      model: 'sonnet', stream: true, messages, tools: [{ type: 'function', function: { name: 'browser_eval',
        parameters: { type: 'object', properties: { expression: { type: 'string' } }, required: ['expression'] } } }] } });
    states.push(state);
    await pumpAgentCliSession({ state, runtime: { profile: { agentCli: { kind: 'claude', interactive: true, maxConcurrent: 1 } }, secrets: { cliToken: 'fake-local-key' } },
      candidate: { providerId: 'claude-code-cli', modelId: 'sonnet' }, index: 0, idleMs: 15000, maxMs: 30000, canFailover: false });
    if (serverError) throw serverError;
    assert.equal(state.status, 'complete', `${state.errorMessage}\n${getAgentCliOutput('native-tool-name')?.output?.slice(-4000)}`);
    const deltas = Buffer.concat(state.chunks).toString().split('\n').filter(line => line.startsWith('data: {'))
      .flatMap(line => JSON.parse(line.slice(6)).choices ?? []).map(choice => choice.delta ?? {});
    const message = { role: 'assistant', content: deltas.map(d => d.content ?? '').join(''),
      tool_calls: deltas.flatMap(d => d.tool_calls ?? []).map(({ index, ...call }) => call) };
    messages.push(message);
    return message;
  };
  const first = await generate();
  assert.equal(first.tool_calls.length, 1, 'only the qualified MCP retry reaches Minnow');
  assert.equal(first.tool_calls[0].function.name, 'browser_eval');
  assert.equal(first.tool_calls[0].function.arguments, JSON.stringify({ expression: 'document.title' }));
  const rejection = requests[1].messages.flatMap(m => Array.isArray(m.content) ? m.content : [])
    .find(block => block.type === 'tool_result' && block.tool_use_id === 'native-1');
  assert.equal(rejection?.is_error, true, 'Claude rejects the unadvertised bare tool itself');
  messages.push({ role: 'tool', tool_call_id: first.tool_calls[0].id, content: 'Fixture title.' });
  const second = await generate();
  assert.equal(second.content, 'Recovered.\n');
  assert.equal(second.tool_calls.length, 0);
  messages.push({ role: 'user', content: 'Follow up.' });
  assert.equal((await generate()).content, 'Recovered.\n');
  assert.equal(processes, 1, 'recovery and follow-up retain the native process');
  assert.equal(requests.length, 4);
  assert.ok(requests.every(r => r.tools.every(t => t.name === 'EndConversation' || t.name.startsWith('mcp__minnow__'))));
  console.log(JSON.stringify({ requests: requests.length, processes, handoffs: first.tool_calls.length, rejection }));
} finally {
  await __resetAgentCliSessionMocksForTests();
  for (const state of states) clearTimeout(state.evictTimer);
  await new Promise(resolve => server.close(resolve));
  for (const [key, value] of [['MINNOW_HOME', previous.home], ['CLAUDE_CONFIG_DIR', previous.claude]]) {
    if (value == null) delete process.env[key]; else process.env[key] = value;
  }
  resetMinnowHomeCache();
  await fs.rm(scratch, { recursive: true, force: true });
}

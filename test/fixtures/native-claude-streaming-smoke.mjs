// Installed Claude, real interactive adapter, isolated credentials and local inference only.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { prepareAgentCliInvocation } from '../../server/generations/agent-cli/invocation.js';
import { pumpAgentCliSession, __setAgentCliSessionMocksForTests, __resetAgentCliSessionMocksForTests } from '../../server/generations/agent-cli/session.js';
import { pumpAgentCliUpstream } from '../../server/generations/agent-cli/pump.js';
import { createGenerationState } from '../../server/generations/store.js';
import { getAgentCliOutput } from '../../server/generations/agent-cli/output.js';
import { resetMinnowHomeCache } from '../../server/config/home.js';

const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-native-streaming-'));
const previous = { home: process.env.MINNOW_HOME, claude: process.env.CLAUDE_CONFIG_DIR };
const requests = [], observations = [], completions = [], helperInvocations = [];
let active, processes = 0, serverError;
const payloads = () => Buffer.concat(active?.chunks ?? []).toString().split('\n')
  .filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6)));
const deltas = () => payloads().flatMap(row => row.choices ?? []).map(choice => choice.delta ?? {});
const server = createServer((req, res) => {
  void respond(req, res).catch(error => { serverError = error; res.destroy(); });
});
async function respond(req, res) {
  if (!req.url?.startsWith('/v1/messages')) { res.writeHead(200).end('{}'); return; }
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks)); requests.push(body);
  if (requests.length > 5) throw new Error('Unexpected extra inference request.');
  const tool = requests.length === 1;
  const send = data => res.write(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`);
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  send({ type: 'message_start', message: { id: `streaming-${requests.length}`, type: 'message', role: 'assistant', content: [], model: body.model,
    stop_reason: null, usage: { input_tokens: 2, output_tokens: 0 } } });
  send({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } });
  send({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Checking the fixture.\n' } });
  send({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'fake-local-signature' } });
  send({ type: 'content_block_stop', index: 0 });
  await delay(1200);
  observations.push({ phase: 'thinking', visible: deltas().map(d => d.reasoning ?? '').join('').includes('Checking the fixture.') });
  send({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } });
  send({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'First line.\n' } });
  await delay(1000);
  observations.push({ phase: 'text', visible: deltas().map(d => d.content ?? '').join('').includes('First line.') });
  send({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Second line.\n' } });
  send({ type: 'content_block_stop', index: 1 });
  if (tool) {
    for (let i = 0; i < 2; i++) {
      send({ type: 'content_block_start', index: i + 2, content_block: { type: 'tool_use', id: 'native-' + i, name: 'mcp__minnow__ping', input: {} } });
      send({ type: 'content_block_delta', index: i + 2, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ value: i }) } });
      send({ type: 'content_block_stop', index: i + 2 });
    }
  }
  if (tool) {
    await delay(2500);
    send({ type: 'content_block_start', index: 4, content_block: { type: 'text', text: '' } });
    send({ type: 'content_block_delta', index: 4, delta: { type: 'text_delta', text: 'After tool dispatch.\n' } });
    send({ type: 'content_block_stop', index: 4 });
  }
  send({ type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null },
    usage: { output_tokens: 30, output_tokens_details: { thinking_tokens: 10 } } });
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
    if (requests.length >= 3) helperInvocations.push(input);
    invocation.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${server.address().port}`;
    delete invocation.env.CLAUDE_CODE_OAUTH_TOKEN; delete invocation.env.ANTHROPIC_AUTH_TOKEN;
    return invocation;
  } });
  const messages = [{ role: 'system', content: 'Use Minnow tools only.' }, { role: 'user', content: 'Call ping twice, then reply.' }];
  const generate = async () => {
    active = createGenerationState({ providerId: 'claude-code-cli', chatId: 'native-streaming', fallbackRole: 'default',
      body: { model: 'sonnet', stream: true, reasoning_effort: 'high', messages,
        tools: [{ type: 'function', function: { name: 'ping', parameters: { type: 'object', properties: { value: { type: 'number' } } } } }] } });
    await pumpAgentCliSession({ state: active,
      runtime: { profile: { agentCli: { kind: 'claude', interactive: true, maxConcurrent: 1 } }, secrets: { cliToken: 'fake-local-key' } },
      candidate: { providerId: 'claude-code-cli', modelId: 'sonnet' }, index: 0, idleMs: 15000, maxMs: 30000, canFailover: false });
    clearTimeout(active.evictTimer);
    if (serverError) throw serverError;
    assert.equal(active.status, 'complete', `${active.errorMessage}\n${getAgentCliOutput('native-streaming')?.output?.slice(-4000)}`);
    const values = deltas();
    const message = { role: 'assistant', content: values.map(d => d.content ?? '').join(''),
      tool_calls: values.flatMap(d => d.tool_calls ?? []).map(({ index, ...call }) => call) };
    completions.push({ text: message.content, thinking: values.map(d => d.reasoning ?? '').join(''), usage: payloads().findLast(row => row.usage)?.usage });
    messages.push(message);
    return message;
  };
  let toolCount = 0;
  const toolValues = [];
  while (true) {
    const message = await generate();
    if (!message.tool_calls.length) break;
    toolCount += message.tool_calls.length;
    toolValues.push(...message.tool_calls.map(call => JSON.parse(call.function.arguments).value));
    assert.ok(toolCount <= 2);
    messages.push(...message.tool_calls.map(call => ({ role: 'tool', tool_call_id: call.id, content: 'Fixture result.' })));
  }
  messages.push({ role: 'user', content: 'A follow-up in the same process.' });
  await generate();
  console.log(JSON.stringify({ processes, requests: requests.length, thinking: requests.map(r => r.thinking), observations, completions }));
  assert.equal(toolCount, 2);
  assert.deepEqual(toolValues.sort(), [0, 1]);
  assert.equal(processes, 1, 'tool continuation and follow-up reuse the interactive process');
  assert.equal(requests.length, 3);
  assert.ok(requests.every(r => r.thinking?.display === 'summarized'), 'request visible thinking summaries');
  assert.ok(observations.filter(o => o.phase === 'text').every(o => o.visible), 'reply text must arrive before the native response completes');
  assert.equal(completions.map(c => c.text).join(''), 'First line.\nSecond line.\nAfter tool dispatch.\n' + 'First line.\nSecond line.\n'.repeat(2));
  assert.equal(completions.map(c => c.thinking).join(''), 'Checking the fixture.\n'.repeat(3));
  assert.equal(completions.reduce((sum, c) => sum + (c.usage?.completion_tokens ?? 0), 0), 90);
  assert.equal(completions.reduce((sum, c) => sum + (c.usage?.completion_tokens_details?.reasoning_tokens ?? 0), 0), 30);
  // Helpers enter through the public router without a chat binding. Each must
  // use a fresh interactive process, return JSON, and remove its native files.
  for (const fallbackRole of ['chat-titles', 'utility']) {
    active = createGenerationState({ providerId: 'claude-code-cli', fallbackRole, persist: false,
      body: { model: 'sonnet', stream: false, messages: [{ role: 'user', content: `Reply for ${fallbackRole}.` }] } });
    try {
      await pumpAgentCliUpstream({ state: active,
        runtime: { profile: { agentCli: { kind: 'claude', interactive: true, allowUtilityRoles: true, maxConcurrent: 1 } }, secrets: { cliToken: 'fake-local-key' } },
        candidate: { providerId: 'claude-code-cli', modelId: 'sonnet' }, index: 0, idleMs: 15000, maxMs: 30000, canFailover: false });
      if (serverError) throw serverError;
      assert.equal(active.status, 'complete', active.errorMessage);
      const response = JSON.parse(Buffer.concat(active.chunks));
      assert.equal(response.choices[0].message.content, 'First line.\nSecond line.\n');
      assert.equal(response.minnow_cli.transport, 'claude-interactive');
      assert.equal(response.usage.completion_tokens, 30);
      const input = helperInvocations.at(-1);
      assert.equal(input.interactive, true);
      await assert.rejects(fs.access(input.tempDir), { code: 'ENOENT' });
      const nativeSource = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', input.tempDir.replace(/[^a-zA-Z0-9]/g, '-'), `${input.sessionId}.jsonl`);
      await assert.rejects(fs.access(nativeSource), { code: 'ENOENT' });
    } finally { clearTimeout(active.evictTimer); }
  }
  assert.equal(processes, 3);
  assert.equal(requests.length, 5);
  assert.equal(helperInvocations.length, 2);
  assert.notEqual(helperInvocations[0].sessionId, helperInvocations[1].sessionId);
  assert.notEqual(helperInvocations[0].tempDir, helperInvocations[1].tempDir);
  assert.ok(requests.slice(3).every(r => !JSON.stringify(r.messages).includes('Fixture result.')), 'helpers do not inherit chat history');
  console.log(JSON.stringify({ utilityProcesses: 2, utilityRequests: 2, transport: 'claude-interactive', cleaned: true }));
} finally {
  await __resetAgentCliSessionMocksForTests();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  for (const [name, value] of [['MINNOW_HOME', previous.home], ['CLAUDE_CONFIG_DIR', previous.claude]]) {
    if (value == null) delete process.env[name]; else process.env[name] = value;
  }
  resetMinnowHomeCache();
  assert.equal(path.dirname(scratch), os.tmpdir());
  await fs.rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

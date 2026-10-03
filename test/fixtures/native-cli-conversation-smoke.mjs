// Installed CLIs, local fake inference only. Cursor preflight sends no prompt.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { prepareAgentCliInvocation } from '../../server/generations/agent-cli/invocation.js';
import { createAgentCliBridge } from '../../server/generations/agent-cli/bridge.js';
import { openCursorAcp } from '../../server/generations/agent-cli/cursor-acp.js';
import { pumpAgentCliSession, __setAgentCliSessionMocksForTests, __resetAgentCliSessionMocksForTests } from '../../server/generations/agent-cli/session.js';
import { disposeCliSessions } from '../../server/generations/agent-cli/lifecycle.js';
import { getAgentCliOutput } from '../../server/generations/agent-cli/output.js';
import { createGenerationState } from '../../server/generations/store.js';
import { cliHash } from '../../server/generations/agent-cli/checkpoints.js';
import { resetMinnowHomeCache } from '../../server/config/home.js';
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-native-conversations-'));
const previous = { home: process.env.MINNOW_HOME, claude: process.env.CLAUDE_CONFIG_DIR, replay: process.env.MINNOW_AGENT_CLI_REPLAY };
let requests = [], processes = 0, answer = 0, bridge, cursor;
const stripCache = value => Array.isArray(value) ? value.map(stripCache) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'cache_control').map(([key, entry]) => [key, stripCache(entry)])) : value;
const server = createServer(async (req, res) => {
  if (!req.url?.startsWith('/v1/messages')) { res.writeHead(200).end('{}'); return; }
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks));
  requests.push({ roles: body.messages.map(row => row.role), firstUserHash: cliHash(stripCache(body.messages[0])),
    stableInstructions: cliHash(stripCache([body.system, body.tools])),
    chars: JSON.stringify(body.messages).length,
    title: JSON.stringify(body.system).includes('Generate a concise, sentence-case title') });
  if (requests.length > 12) { res.writeHead(400).end('{}'); return; }
  const text = `Answer ${++answer}.`, id = `native-smoke-${answer}`;
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const [event, data] of [
    ['message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', content: [], model: body.model,
      stop_reason: null, stop_sequence: null, usage: { input_tokens: 2, cache_read_input_tokens: 8, output_tokens: 0 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } }],
    ['message_stop', { type: 'message_stop' }],
  ]) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  res.end();
});
try {
  process.env.MINNOW_HOME = scratch; process.env.CLAUDE_CONFIG_DIR = path.join(scratch, 'claude-config'); resetMinnowHomeCache();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  __setAgentCliSessionMocksForTests({ prepareInvocation: async input => {
    processes++;
    const invocation = await prepareAgentCliInvocation(input);
    invocation.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${server.address().port}`;
    invocation.env.CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR;
    delete invocation.env.ANTHROPIC_AUTH_TOKEN; delete invocation.env.CLAUDE_CODE_OAUTH_TOKEN;
    return invocation;
  } });
  const report = [];
  for (const variant of ['replay', 'warm', 'restart-resume', ...(process.argv.includes('--budgets') ? ['budget-resume'] : [])]) {
    if (variant === 'replay') process.env.MINNOW_AGENT_CLI_REPLAY = '1'; else delete process.env.MINNOW_AGENT_CLI_REPLAY;
    requests = []; processes = 0; answer = 0;
    const messages = [{ role: 'system', content: 'Use only Minnow tools. Answer directly.' },
      { role: 'user', content: `Stable initial context. ${'Synthetic context for prefix verification. '.repeat(700)}` }];
    const metadata = [], times = [], usage = [];
    for (let turn = 0; turn < 3; turn++) {
      const startedAt = performance.now();
      const state = createGenerationState({ providerId: 'claude-code-cli', chatId: `native-${variant}`, fallbackRole: 'default',
        body: { model: 'claude-sonnet-4-6', stream: false, messages, tools: [] } });
      const result = await pumpAgentCliSession({ state,
        runtime: { profile: { agentCli: { kind: 'claude', maxConcurrent: 1,
          ...(variant === 'budget-resume' ? { maxBudgetUsd: .00007 } : {}) } }, secrets: { cliToken: 'fake-smoke-key' } },
        candidate: { providerId: 'claude-code-cli', modelId: 'claude-sonnet-4-6' }, index: 0, idleMs: 15_000, maxMs: 30_000, canFailover: false });
      clearTimeout(state.evictTimer);
      assert.equal(result.outcome, 'complete', state.errorMessage);
      const completion = JSON.parse(Buffer.concat(state.chunks));
      assert.equal(completion.choices[0].message.content, `Answer ${turn + 1}.`);
      metadata.push(completion.minnow_cli); times.push(Math.round(performance.now() - startedAt));
      usage.push(completion.usage);
      messages.push({ role: 'assistant', content: `Answer ${turn + 1}.` }, { role: 'user', content: `Follow-up ${turn + 1}.` });
      if (variant === 'restart-resume') await disposeCliSessions();
    }
    assert.equal(requests.length, 3); assert.equal(requests.some(row => row.title), false);
    if (variant !== 'replay') {
      assert.deepEqual(requests.map(row => row.roles), [['user'], ['user', 'assistant', 'user'], ['user', 'assistant', 'user', 'assistant', 'user']]);
      assert.equal(new Set(requests.map(row => row.firstUserHash)).size, 1);
      assert.equal(new Set(requests.map(row => row.stableInstructions)).size, 1, 'native system/tool prefix stays stable');
      assert.equal(metadata[1].continuation, variant === 'warm' ? 'reused' : 'resumed');
    } else assert.equal(new Set(requests.map(row => row.firstUserHash)).size, 3);
    report.push({ variant, processes, requests: requests.length, ms: times, roles: requests.map(row => row.roles),
      stableFirstUser: new Set(requests.map(row => row.firstUserHash)).size === 1,
      continuation: metadata.map(row => row.continuation), costs: metadata.map(row => row.cost_usd),
      usage,
      saved: getAgentCliOutput(`native-${variant}`)?.session?.restartResumeSupported });
    await disposeCliSessions();
  }
  console.log(JSON.stringify({ claude: report }));
  if (process.argv.includes('--cursor')) {
    const dir = path.join(scratch, 'cursor-preflight', 'work'); await fs.mkdir(dir, { recursive: true });
    bridge = await createAgentCliBridge({ tools: [], tempDir: dir, onCall() { throw new Error('Preflight must not call a tool.'); } });
    const invocation = await prepareAgentCliInvocation({ kind: 'cursor', acp: true, tempDir: dir, prompt: '', bridgeConfig: bridge.config });
    try {
      cursor = await openCursorAcp(invocation, { tools: [] });
      console.log(JSON.stringify({ cursor: { verified: true, transport: 'acp', prompted: false } }));
      await cursor.stop();
    } catch (error) {
      console.log(JSON.stringify({ cursor: { verified: false, transport: 'replay', prompted: false, reason: error.message } }));
    } finally { await invocation.cleanup?.(); }
  }
} finally {
  await cursor?.stop().catch(() => {}); await bridge?.close();
  await __resetAgentCliSessionMocksForTests();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  for (const [name, value] of [['MINNOW_HOME', previous.home], ['CLAUDE_CONFIG_DIR', previous.claude], ['MINNOW_AGENT_CLI_REPLAY', previous.replay]]) {
    if (value == null) delete process.env[name]; else process.env[name] = value;
  }
  resetMinnowHomeCache(); await fs.rm(scratch, { recursive: true, force: true });
}

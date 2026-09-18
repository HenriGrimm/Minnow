// Manual smoke: uses an installed Claude CLI against a local fake endpoint only.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentCliBridge } from '../../server/generations/agent-cli/bridge.js';
import { prepareAgentCliInvocation } from '../../server/generations/agent-cli/invocation.js';
import { spawnAgentCli } from '../../server/generations/agent-cli/spawn.js';

const scratch = await mkdtemp(join(tmpdir(), 'minnow-native-claude-mcp-'));
let child, bridge, timer;
let handoff;
let stdout = '';
const requests = [];
const server = createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  if (!req.url?.startsWith('/v1/messages')) { res.writeHead(404).end(); return; }
  const request = JSON.parse(body);
  const names = (request.tools ?? []).map(tool => tool.name);
  requests.push(names);
  if (requests.length > 3) { res.writeHead(400).end('Smoke test exhausted its request limit.'); void child?.stop(); return; }
  const name = names.find(name => name.endsWith('__ping'));
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const tool = { type: 'tool_use', id: 'tool-call-1', name, input: {} };
  const events = [
    ['message_start', { type: 'message_start', message: { id: 'mcp-smoke', type: 'message', role: 'assistant', content: [], model: 'fake', stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: name ? tool : { type: 'text', text: '' } }],
    ...(!name ? [['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'MCP_TOOL_MISSING' } }]] : []),
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: name ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }],
    ['message_stop', { type: 'message_stop' }],
  ];
  for (const [event, value] of events) res.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
  res.end();
});
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  bridge = await createAgentCliBridge({ tools: [{ name: 'ping', originalName: 'ping', description: 'Smoke test', inputSchema: { type: 'object', properties: {} } }], tempDir: scratch, onCall: call => {
    handoff = call;
    void child.stop();
  } });
  const invocation = await prepareAgentCliInvocation({ kind: 'claude', tempDir: scratch, prompt: 'Call the Minnow ping tool.', systemPrompt: 'Use Minnow tools only.', bridgeConfig: bridge.config, secrets: { cliToken: 'fake-smoke-key' } });
  invocation.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  invocation.env.CLAUDE_CONFIG_DIR = join(scratch, 'claude-home');
  delete invocation.env.CLAUDE_CODE_OAUTH_TOKEN;
  delete invocation.env.ANTHROPIC_AUTH_TOKEN;
  child = spawnAgentCli(invocation);
  child.child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-12_000); });
  timer = setTimeout(() => void child.stop(), 45_000);
  const exit = await child.done;
  console.log(JSON.stringify({ requests, handoff, stdout, stderr: exit.stderr }, null, 2));
  assert.ok(requests.some(names => names.includes('mcp__minnow__ping')), 'Native Claude must receive the Minnow MCP tool');
  assert.ok(requests.every(names => names.every(name => name.startsWith('mcp__minnow__'))), 'Native tools must remain disabled');
  assert.equal(handoff?.function.name, 'ping', 'Native Claude must hand off the requested tool');
} finally {
  clearTimeout(timer);
  await child?.stop();
  await bridge?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await rm(scratch, { recursive: true, force: true });
}

// Manual smoke: uses an installed Codex CLI against a local fake endpoint only.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentCliBridge } from '../../server/generations/agent-cli/bridge.js';
import { prepareAgentCliInvocation } from '../../server/generations/agent-cli/invocation.js';
import { spawnAgentCli } from '../../server/generations/agent-cli/spawn.js';

const scratch = await mkdtemp(join(tmpdir(), 'minnow-native-codex-mcp-'));
let child, bridge, timer;
let handoff;
let stdout = '';
const requests = [];
const server = createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  if (!req.url?.endsWith('/responses')) { res.writeHead(404).end(); return; }
  const request = JSON.parse(body);
  requests.push(request.tools ?? []);
  if (requests.length > 3) { res.writeHead(400).end('Smoke test exhausted its request limit.'); void child?.stop(); return; }
  const namespace = (request.tools ?? []).find(tool => tool.type === 'namespace' && tool.name === 'mcp__minnow');
  const name = namespace?.tools?.find(tool => tool.name === 'ping')?.name;
  const item = name
    ? { type: 'function_call', id: 'fc_smoke', call_id: 'call_smoke', namespace: 'mcp__minnow', name, arguments: '{}', status: 'completed' }
    : { type: 'message', id: 'msg_smoke', role: 'assistant', content: [{ type: 'output_text', text: 'MCP_TOOL_MISSING', annotations: [] }], status: 'completed' };
  const response = { id: 'resp_smoke', object: 'response', status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const value of [
    { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', ...(name ? { arguments: '' } : {}) } },
    ...(name ? [
      { type: 'response.function_call_arguments.delta', item_id: item.id, output_index: 0, delta: '{}' },
      { type: 'response.function_call_arguments.done', item_id: item.id, output_index: 0, arguments: '{}' },
    ] : [{ type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: 'MCP_TOOL_MISSING' }]),
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response },
  ]) res.write(`data: ${JSON.stringify(value)}\n\n`);
  res.end();
});
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  bridge = await createAgentCliBridge({ tools: [{ name: 'ping', originalName: 'ping', description: 'Smoke test', inputSchema: { type: 'object', properties: {} } }], tempDir: scratch, onCall: call => {
    handoff = call;
    void child.stop();
  } });
  const authPath = join(scratch, 'fake-auth.json');
  await writeFile(authPath, JSON.stringify({ OPENAI_API_KEY: 'fake-smoke-key' }));
  const invocation = await prepareAgentCliInvocation({ kind: 'codex', tempDir: scratch, prompt: 'Call the Minnow ping tool.', systemPrompt: 'Use Minnow tools only.', body: { model: 'gpt-5.3-codex' }, bridgeConfig: bridge.config, secrets: { codexAuthPath: authPath } });
  const configPath = join(invocation.env.CODEX_HOME, 'config.toml');
  const config = await readFile(configPath, 'utf8');
  await writeFile(configPath, `model_provider = "fake"\n${config}\n[model_providers.fake]\nname = "fake"\nbase_url = "http://127.0.0.1:${server.address().port}/v1"\nwire_api = "responses"\nrequires_openai_auth = true\n`);
  invocation.env.OPENAI_API_KEY = 'fake-smoke-key';
  delete invocation.env.CODEX_API_KEY;
  child = spawnAgentCli(invocation);
  child.child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-12_000); });
  timer = setTimeout(() => void child.stop(), 45_000);
  const exit = await child.done;
  console.log(JSON.stringify({ requests: requests.map(tools => tools.map(tool => ({ name: tool.name, tools: tool.tools?.map(nested => nested.name) }))), handoff, stdout, stderr: exit.stderr }, null, 2));
  assert.ok(requests.some(tools => tools.some(tool => tool.name === 'mcp__minnow' && tool.tools?.some(nested => nested.name === 'ping'))), 'Native Codex must receive the Minnow MCP tool');
  assert.equal(handoff?.function.name, 'ping', 'Native Codex must hand off the requested tool');
  const discoveryHelpers = ['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource'];
  assert.ok(requests.every(tools => tools.every(tool => tool.name?.startsWith('mcp__minnow') || discoveryHelpers.includes(tool.name))), 'Native execution tools must remain disabled');
} finally {
  clearTimeout(timer);
  await child?.stop();
  await bridge?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await rm(scratch, { recursive: true, force: true });
}

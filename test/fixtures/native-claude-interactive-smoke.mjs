// Manual feasibility probe: real interactive Claude, private configuration, local fake inference.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import pty from '@lydell/node-pty';
import { prepareAgentCliInvocation } from '../../server/generations/agent-cli/invocation.js';
import { createAgentCliBridge } from '../../server/generations/agent-cli/bridge.js';

const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-interactive-probe-'));
const config = path.join(scratch, 'config'), cwd = path.join(scratch, 'work');
const sessionId = randomUUID(), requests = [], hooks = [], requestPaths = [];
let terminal, bridge, handoffs = 0, output = '', timer, ended, trustedScratch = false;
let resolveStop;
const stopped = new Promise(resolve => { resolveStop = resolve; });
let resolveReady;
const ready = new Promise(resolve => { resolveReady = resolve; });
const server = createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  if (req.url === '/hook') {
    const event = JSON.parse(Buffer.concat(chunks)); hooks.push(event);
    if (event.hook_event_name === 'McpReady') resolveReady();
    if (event.hook_event_name === 'Stop' || event.hook_event_name === 'StopFailure') resolveStop(event);
    res.writeHead(200, { 'content-type': 'application/json' }).end('{}'); return;
  }
  if (!req.url?.startsWith('/v1/messages')) { res.writeHead(200).end('{}'); return; }
  const body = JSON.parse(Buffer.concat(chunks)); requests.push(body); requestPaths.push(req.url);
  if (requests.length > 3) { res.writeHead(400).end('{}'); resolveStop({ error: 'too many requests' }); return; }
  const callTool = requests.length === 1;
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const [event, data] of [
    ['message_start', { type: 'message_start', message: { id: `interactive-${requests.length}`, type: 'message', role: 'assistant', content: [], model: body.model, stop_reason: null, usage: { input_tokens: 2, output_tokens: 0 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: callTool
      ? { type: 'tool_use', id: 'probe-call', name: 'mcp__minnow__ping', input: {} } : { type: 'text', text: '' } }],
    ...(!callTool ? [['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Interactive tool result received.' } }]] : []),
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: callTool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } }],
    ['message_stop', { type: 'message_stop' }],
  ]) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  res.end();
});
try {
  await fs.mkdir(config); await fs.mkdir(cwd);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const key = 'fake-local-interactive-key';
  await fs.writeFile(path.join(config, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark',
    customApiKeyResponses: { approved: [key.slice(-20)], rejected: [] },
    projects: { [cwd]: { hasTrustDialogAccepted: true }, [cwd.replaceAll('\\', '/')]: { hasTrustDialogAccepted: true } } }));
  bridge = await createAgentCliBridge({ tempDir: cwd,
    tools: [{ name: 'ping', originalName: 'ping', description: 'Test ping', inputSchema: { type: 'object', properties: {} } }],
    onCall(call) { handoffs++; bridge.resolveCall(call.id, 'Actual Minnow result.'); } });
  // Observe actual MCP discovery before typing into the interactive prompt.
  const shim = new URL('../../server/generations/agent-cli/mcp-shim.mjs', import.meta.url).href;
  const wrapper = path.join(cwd, 'probe-mcp.mjs');
  await fs.writeFile(wrapper, `import { startMcpShim } from ${JSON.stringify(shim)};
startMcpShim({ output: { write(line) {
  process.stdout.write(line);
  if (JSON.parse(line).result?.tools) void fetch(${JSON.stringify(`${base}/hook`)}, {
    method: 'POST', body: JSON.stringify({ hook_event_name: 'McpReady' }) });
} } });\n`);
  bridge.config.args = [wrapper];
  const invocation = await prepareAgentCliInvocation({ kind: 'claude', tempDir: cwd, sessionId,
    body: { model: 'claude-opus-5-5', reasoning_effort: 'medium' }, prompt: 'Call ping.', systemPrompt: 'Use Minnow tools only.',
    bridgeConfig: bridge.config, secrets: { cliToken: key } });
  const removeFlags = new Map([['--print', 0], ['--output-format', 1], ['--include-partial-messages', 0], ['--input-format', 1], ['--thinking-display', 1]]);
  const args = [];
  for (let i = 0; i < invocation.args.length; i++) {
    const skip = removeFlags.get(invocation.args[i]);
    if (skip != null) i += skip; else args.push(invocation.args[i]);
  }
  const settings = { hooks: Object.fromEntries(['SessionStart', 'UserPromptSubmit', 'MessageDisplay', 'Stop', 'StopFailure'].map(name =>
    [name, [{ hooks: [{ type: 'http', url: `${base}/hook`, timeout: 5 }] }]])) };
  args.push('--settings', JSON.stringify(settings), '--permission-mode', 'dontAsk', '--prompt-suggestions', 'false');
  const env = { ...invocation.env, ANTHROPIC_API_KEY: key, ANTHROPIC_BASE_URL: base, CLAUDE_CONFIG_DIR: config, TERM: 'xterm-256color',
    MCP_CONNECTION_NONBLOCKING: '0', CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: 'false' };
  delete env.CLAUDE_CODE_OAUTH_TOKEN; delete env.ANTHROPIC_AUTH_TOKEN;
  terminal = pty.spawn(invocation.command, args, { cwd, env, name: 'xterm-256color', cols: 140, rows: 40 });
  ended = new Promise(resolve => terminal.onExit(event => { resolve(event); resolveStop({ error: `exit ${event.exitCode}` }); }));
  terminal.onData(text => {
    output = (output + text).slice(-24000);
    const flat = output.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\s+/g, '');
    // Only accept the displayed trust prompt for this newly-created empty fixture.
    if (!trustedScratch && flat.includes(cwd.replace(/\s+/g, '')) && flat.includes('Yes,Itrustthisfolder') && flat.includes('No,exit')) {
      trustedScratch = true; terminal.write('\x1b[B');
      setTimeout(() => terminal.write('\n'), 200);
    }
  });
  timer = setTimeout(() => { resolveReady(); resolveStop({ error: 'timeout' }); }, 25000);
  await ready;
  await new Promise(resolve => setTimeout(resolve, 200));
  terminal.write('\x1b[200~Call the Minnow ping tool.\x1b[201~');
  setTimeout(() => terminal.write('\r'), 200);
  const result = await stopped;
  assert.equal(result.hook_event_name, 'Stop', JSON.stringify({ result, output: output.slice(-3000) }));
  assert.equal(requests.length, 2, 'one tool request and one continuation');
  const followUp = new Promise(resolve => { resolveStop = resolve; });
  terminal.write('\x1b[200~Follow up once.\x1b[201~');
  setTimeout(() => terminal.write('\r'), 200);
  const followUpResult = await followUp;
  const transcriptFile = path.join(config, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`);
  const rows = (await fs.readFile(transcriptFile, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(JSON.parse);
  console.log(JSON.stringify({ requests: requests.length, handoffs, hooks: hooks.map(h => h.hook_event_name), result: result.hook_event_name ?? result.error,
    requestSummary: requests.map((r, i) => ({ path: requestPaths[i], model: r.model, tools: r.tools?.map(t => t.name), messages: r.messages?.length })),
    entrypoints: [...new Set(rows.map(r => r.entrypoint).filter(Boolean))],
    ...(result.error ? { terminal: output.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').slice(-6000) } : {}) }));
  assert.equal(followUpResult.hook_event_name, 'Stop');
  assert.equal(requests.length, 3, 'follow-up must add only one inference request');
  assert.equal(handoffs, 1);
  assert.ok(requests.every(r => r.tools.some(t => t.name === 'mcp__minnow__ping')));
  // Claude's EndConversation safeguard cannot access files or execute tools.
  assert.ok(requests.every(r => r.tools.every(t => t.name === 'EndConversation' || t.name.startsWith('mcp__minnow__'))));
  assert.ok(JSON.stringify(requests[1].messages).includes('Actual Minnow result.'));
  assert.deepEqual(requests[0].messages[0], requests[2].messages[0], 'follow-up preserves the original user message');
  assert.equal(JSON.stringify(requests[2].messages).split('Call the Minnow ping tool.').length, 2);
  assert.ok(rows.some(r => r.entrypoint === 'cli'));
} finally {
  clearTimeout(timer);
  terminal?.kill(); if (ended) await ended;
  await bridge?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  assert.equal(path.dirname(scratch), os.tmpdir(), 'cleanup is restricted to the created scratch directory');
  await fs.rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

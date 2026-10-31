import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { after, before, test } from 'node:test';
import { buildHeadlessRunner } from '../../scripts/build-headless-runner.mjs';

let directory, outfile, server, base;
let ordinary = false;
const requests = [];
const command = { commandId: 'canonical-command', state: 'running', revision: 1, executionId: 'canonical-execution' };
before(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-managed-cli-boundary-'));
  ({ outfile } = await buildHeadlessRunner({ outfile: path.join(directory, 'minnow-run.mjs'), logLevel: 'error' }));
  server = http.createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    const body = raw ? JSON.parse(raw) : null;
    requests.push({ method: req.method, path: req.url, headers: req.headers, body });
    res.setHeader('Content-Type', 'application/json');
    assert.equal(req.headers['x-minnow-token'], 'fixture-token');
    if (req.url.endsWith('/ping')) { res.end(JSON.stringify({ ok: true })); return; }
    if (req.url === '/api/chats/child' && req.method === 'GET') {
      res.end(JSON.stringify({ chat: { id: 'child', ...(ordinary ? {} : { chatCommandVersion: 1 }), modeId: 'plan',
        providerId: 'saved-provider', modelId: 'saved-model', workspacePath: directory },
        frame: { epoch: 'different-execution', history: { messages: [{ role: 'assistant', content: 'Do not report another turn' }] } } })); return;
    }
    if (req.url === '/api/chats/capabilities') {
      res.end(JSON.stringify({ creationEnabled: true, conversationStorage: 'sqlite' })); return;
    }
    if (req.url === '/api/chats/child/commands' && req.method === 'POST') {
      assert.equal(req.headers['x-minnow-chat-protocol'], '1');
      res.statusCode = 202; res.end(JSON.stringify({ receipt: command })); return;
    }
    if (req.url === '/api/chat-commands/canonical-command') {
      res.end(JSON.stringify({ receipt: { ...command, state: 'settled', disposition: 'settled',
        result: { outcome: 'no_report' }, assistantFinal: 'SERVER OWNED FINAL' } })); return;
    }
    res.statusCode = 500; res.end(JSON.stringify({ error: { message: `CLI crossed ownership boundary: ${req.url}` } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test('bundled CLI continues an existing ordinary chat through durable server admission with no replacement history', async () => {
  ordinary = true;
  try {
    const before = requests.length;
    const result = await run([]);
    assert.equal(result.assistantFinal, 'SERVER OWNED FINAL');
    const calls = requests.slice(before);
    assert.equal(calls.filter(row => row.path === '/api/chats/capabilities').length, 1);
    assert.equal(calls.filter(row => row.method === 'POST').length, 1);
    assert.ok(calls.every(row => !/generations|sessions/.test(row.path)));
  } finally { ordinary = false; }
});
after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  if (directory) await fs.rm(directory, { recursive: true, force: true });
});

async function run(extra) {
  const child = spawn(process.execPath, [outfile, 'run', '--prompt', 'Managed boundary', '--chat-id', 'child', '--persist-chat',
    '--base-url', base, '--token', 'fixture-token', '--json', ...extra],
  { cwd: directory, env: { ...process.env, MINNOW_HOME: directory }, windowsHide: true });
  let stdout = '', stderr = '';
  child.stdout.on('data', part => { stdout += part; }); child.stderr.on('data', part => { stderr += part; });
  const timer = setTimeout(() => child.kill(), 30_000);
  try {
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    assert.equal(code, 0, stderr);
    return JSON.parse(stdout);
  } finally { clearTimeout(timer); }
}

test('packaged CLI and scheduler resume managed chats through server commands with no second runner/persistence path', async () => {
  for (const [extra, ingress] of [[[], 'cli'], [['--scheduler-run'], 'scheduler']]) {
    const before = requests.length;
    const result = await run(extra);
    assert.equal(result.assistantFinal, 'SERVER OWNED FINAL');
    assert.equal(result.managedChat.commandId, 'canonical-command');
    const calls = requests.slice(before);
    const commands = calls.filter(row => row.method === 'POST');
    assert.equal(commands.length, 1);
    assert.equal(commands[0].path, '/api/chats/child/commands');
    assert.equal(commands[0].headers['x-minnow-chat-client'], ingress);
    assert.equal(commands[0].body.action, 'send');
    assert.equal(commands[0].body.text, 'Managed boundary');
    assert.ok(calls.every(row => row.path.endsWith('/ping') || row.path.startsWith('/api/chats/child') || row.path.startsWith('/api/chat-commands/')));
    assert.ok(calls.every(row => !row.path.includes('/generations') && !row.path.includes('/sessions')));
  }
});

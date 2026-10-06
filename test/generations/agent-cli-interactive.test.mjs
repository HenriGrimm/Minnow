import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { openClaudeInteractive, createInteractiveTranscript, supportsClaudeInteractiveVersion } from '../../server/generations/agent-cli/claude-interactive.js';
import { createAgentCliBridge } from '../../server/generations/agent-cli/bridge.js';
import { createAgentCliTranslator } from '../../server/generations/agent-cli/translate.js';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-interactive-test-'));
  const cwd = path.join(root, 'work'), config = path.join(root, 'config'), id = randomUUID();
  await fs.mkdir(cwd);
  const file = path.join(config, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${id}.jsonl`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  let exit, data, command, killed = false, run;
  const events = [], commands = [];
  t.after(async () => { await run?.stop(); assert.equal(path.dirname(root), os.tmpdir()); await fs.rm(root, { recursive: true, force: true, maxRetries: 5 }); });
  let ready;
  const bridge = { ready: new Promise(resolve => { ready = resolve; }), queuePrompt: () => `/mcp__minnow__message ${'a'.repeat(32)}` };
  run = await openClaudeInteractive({ command: 'fake-claude', args: [], cwd, env: {}, transport: 'claude-interactive' }, {
    bridge, nativeId: id, configRoot: config,
    spawnPty: () => ({ pid: 0, onData: fn => { data = fn; }, onExit: fn => { exit = fn; },
      write(value) { commands.push(value); if (value.startsWith('\x1b[200~')) command = value.slice(6, -6); },
      kill() { if (!killed) { killed = true; exit({ exitCode: 1 }); } },
    }),
  });
  run.child.stdout.on('data', chunk => { for (const line of chunk.toString().trim().split('\n')) events.push(JSON.parse(line)); });
  const settings = JSON.parse(await fs.readFile(path.join(cwd, 'claude-interactive-settings.json'), 'utf8'));
  const hook = settings.hooks.Stop[0].hooks[0];
  const post = (event, extra = {}) => fetch(hook.url, { method: 'POST', headers: hook.headers,
    body: JSON.stringify({ session_id: id, cwd, prompt_id: 'prompt', ...event }), ...extra });
  const begin = async () => { ready(true); await run.send('Payload stays out of the PTY'); await post({ hook_event_name: 'UserPromptSubmit', prompt: command }); await delay(10); };
  const row = (messageId, content, stop = 'tool_use', output = 17) => ({ type: 'assistant', uuid: randomUUID(),
    message: { id: messageId, role: 'assistant', model: 'claude-opus-5-5', stop_reason: stop, content,
      usage: { input_tokens: 2, cache_creation_input_tokens: 20, cache_read_input_tokens: 200, output_tokens: output, output_tokens_details: { thinking_tokens: 6 } } } });
  const append = row => fs.appendFile(file, JSON.stringify(row) + '\n');
  const waitResult = async () => {
    const deadline = Date.now() + 2000;
    while (!events.some(e => e.type === 'result') && Date.now() < deadline) await delay(20);
    assert.ok(events.some(e => e.type === 'result'), 'completion must arrive');
    return events.find(e => e.type === 'result');
  };
  return { root, cwd, file, run, events, commands, post, begin, row, append, waitResult, ready, exit: code => exit({ exitCode: code }), data: value => data(value), bridge };
}

test('first-run display and security notice complete without accepting login or later model output', async t => {
  const f = await fixture(t);
  f.data('Choose a login method. Press Enter to continue');
  await delay(350); assert.equal(f.commands.length, 0);
  f.data('Choose the text style that looks best with your terminal');
  f.data('Choose the text style that looks best with your terminal');
  await delay(350); assert.deepEqual(f.commands, ['\r\n']);
  const notice = 'Security notes: https://code.claude.com/docs/en/security Press Enter to continue';
  f.data(notice); f.data(notice);
  await delay(350); assert.deepEqual(f.commands, ['\r\n', '\r\n']);
  f.ready(true); await delay(10);
  f.data(`Accessing workspace: ${f.cwd}\nNo, exit\nYes, I trust this folder`);
  await delay(450); assert.equal(f.commands.length, 2, 'model output cannot drive startup input');
});

test('failed startup emits the actionable error before cleanup exits', async t => {
  const f = await fixture(t), diagnostics = [];
  f.run.child.stderr.on('data', chunk => diagnostics.push(chunk.toString()));
  f.ready(false);
  await assert.rejects(f.run.send('Not submitted'), /setup or sign-in/);
  assert.match((await f.waitResult()).error, /setup or sign-in/);
  assert.match(diagnostics.join(''), /Starting interactive session/);
  assert.match(diagnostics.join(''), /setup or sign-in/);
  assert.equal(f.commands.length, 0);
  const exited = await fixture(t); exited.exit(0);
  assert.match((await exited.waitResult()).error, /exited during startup/);
});

test('interactive support is version gated before any prompt is sent', () => {
  for (const version of [null, 'unknown', '2.1.288', '1.9.999']) assert.equal(supportsClaudeInteractiveVersion(version), false);
  for (const version of ['2.1.289 (Claude Code)', '2.1.290', '2.2.0', '3.0.0']) assert.equal(supportsClaudeInteractiveVersion(version), true);
});

test('interactive hooks stream ordered text, deduplicate retries and wait for final native usage', async t => {
  const f = await fixture(t); await f.begin();
  await f.post({ hook_event_name: 'MessageDisplay', message_id: 'display', index: 1, delta: 'world', final: true });
  await f.post({ hook_event_name: 'MessageDisplay', message_id: 'display', index: 0, delta: 'Hello ', final: false });
  await f.post({ hook_event_name: 'MessageDisplay', message_id: 'display', index: 1, delta: 'world', final: true });
  await f.append(f.row('api-1', [{ type: 'text', text: 'Hello world' }], 'end_turn'));
  await f.post({ hook_event_name: 'Stop', last_assistant_message: 'Hello world' });
  assert.equal((await f.waitResult()).subtype, 'success');
  const deltas = [], translator = createAgentCliTranslator('claude', delta => deltas.push(delta));
  f.events.forEach(translator.consume);
  assert.equal(deltas.map(d => d.content ?? '').join(''), 'Hello world');
  assert.equal(translator.snapshot().usage.prompt_tokens, 222);
  assert.equal(translator.snapshot().usage.completion_tokens, 17);
  assert.equal(translator.snapshot().usage.completion_tokens_details.reasoning_tokens, 6);
  assert.ok(f.commands.every(c => !c.includes('Payload')));
});

test('early MCP dispatch waits for the completed response and identical later calls use fresh usage', async t => {
  const f = await fixture(t); await f.begin();
  const call = { function: { name: 'ping', arguments: '{"a":1}' } };
  const tool = id => ({ type: 'tool_use', id, name: 'mcp__minnow__ping', input: { a: 1 } });
  let done = false;
  const handoff = f.run.beforeHandoff(call).then(value => { done = true; return value; });
  await delay(250); assert.equal(done, false);
  await f.append(f.row('api-1', [tool('tool-1'), { type: 'text', text: 'After dispatch.' }]));
  assert.equal((await handoff).id, 'api-1');
  const later = f.run.beforeHandoff(call);
  await f.append(f.row('api-2', [tool('tool-2')], 'tool_use', 25));
  assert.equal((await later).id, 'api-2');
  assert.deepEqual(f.events.filter(e => e.event?.type === 'message_start').map(e => e.event.message.usage.output_tokens), [17, 25]);
});

test('Stop waits for a fresh response even when the previous tool message has identical text', async t => {
  const f = await fixture(t); await f.begin();
  await f.append(f.row('tool-response', [{ type: 'tool_use', id: 'same-call', name: 'mcp__minnow__ping', input: {} }, { type: 'text', text: 'Same.' }]));
  await f.run.beforeHandoff({ function: { name: 'ping', arguments: '{}' } });
  await f.post({ hook_event_name: 'Stop', last_assistant_message: 'Same.' });
  await delay(200);
  assert.equal(f.events.some(e => e.type === 'result'), false);
  await f.append(f.row('final-response', [{ type: 'text', text: 'Same.' }], 'end_turn', 31));
  assert.equal((await f.waitResult()).subtype, 'success');
  assert.deepEqual(f.events.filter(e => e.event?.type === 'message_start').map(e => e.event.message.usage.output_tokens), [17, 31]);
});

test('multi-block replies reconcile the final hook with all native text blocks', async t => {
  const f = await fixture(t); await f.begin();
  await f.append(f.row('multi', [{ type: 'text', text: 'First.' }], 'end_turn'));
  await f.append(f.row('multi', [{ type: 'text', text: ' Last.' }], 'end_turn'));
  await f.post({ hook_event_name: 'Stop', last_assistant_message: 'Last.' });
  assert.equal((await f.waitResult()).subtype, 'success');
  assert.equal(f.events.filter(e => e.type === 'interactive_text').map(e => e.text).join(''), 'First. Last.');
  assert.equal(f.events.filter(e => e.event?.type === 'message_start').length, 1);
});

test('hook authentication, origin and session checks reject unrelated requests', async t => {
  const f = await fixture(t);
  assert.equal((await f.post({}, { headers: {} })).status, 403);
  assert.equal((await f.post({}, { headers: { Origin: 'https://example.com' } })).status, 403);
  await f.begin();
  const response = await f.post({ hook_event_name: 'UserPromptSubmit', prompt: 'unrequested message', session_id: 'other' });
  assert.equal((await response.json()).decision, 'block');
  assert.equal((await f.waitResult()).is_error, true);
});

test('rate-limit failure is recorded without inventing a percentage or successful completion', async t => {
  const f = await fixture(t); await f.begin();
  await f.post({ hook_event_name: 'StopFailure', error: 'rate_limit', error_details: 'Allowance exhausted.' });
  assert.match((await f.waitResult()).error, /Allowance exhausted/);
  assert.deepEqual(f.events.find(e => e.type === 'rate_limit_event').rate_limit_info, { status: 'rejected' });
});

test('an unexpected zero exit is a failure; intentional cancellation closes the PTY and hook listener', async t => {
  const f = await fixture(t); await f.begin(); f.exit(0);
  assert.equal((await f.waitResult()).is_error, true);
  const second = await fixture(t); await second.begin(); await second.run.stop();
  assert.equal((await second.run.done).code, 1);
  assert.equal(second.events.some(e => e.type === 'result' && e.subtype === 'success'), false);
  await assert.rejects(second.post({ hook_event_name: 'Stop' }));
});

test('cancellation releases a tool response still streaming and a cancelled startup never spawns', async t => {
  const f = await fixture(t); await f.begin();
  const pending = assert.rejects(f.run.beforeHandoff({ function: { name: 'ping', arguments: '{}' } }), /closed/);
  await f.run.stop(); await pending;
  const controller = new AbortController(); controller.abort();
  await assert.rejects(openClaudeInteractive({}, { signal: controller.signal, spawnPty() { assert.fail('must not spawn'); } }), /abort/i);
});

test('startup trust acceptance is limited to the exact private directory', async t => {
  const f = await fixture(t);
  f.data('Accessing workspace: other-folder\nNo, exit\nYes, I trust this folder');
  await delay(450); assert.equal(f.commands.length, 0);
  f.data(`Accessing workspace: ${f.cwd}\nNo, exit\nYes, I trust this folder`);
  await delay(450);
  assert.deepEqual(f.commands, ['\x1b[B', '\r\n']);
});

test('transcript reader preserves split UTF-8 records and rejects shrinkage', async t => {
  const f = await fixture(t), reader = createInteractiveTranscript([f.file]);
  const row = Buffer.from(JSON.stringify(f.row('split', [{ type: 'text', text: '🌊' }])) + '\n');
  const split = row.indexOf(Buffer.from('🌊')) + 1;
  await fs.writeFile(f.file, row.subarray(0, split));
  assert.equal((await reader.read()).messages.size, 0);
  await fs.appendFile(f.file, row.subarray(split));
  assert.equal((await reader.read()).messages.get('split').content[0].text, '🌊');
  await fs.writeFile(f.file, '');
  await assert.rejects(reader.read(), /verification/);
});

test('private MCP prompt delivery is authenticated, single use and supports images', async t => {
  const f = await fixture(t);
  const bridge = await createAgentCliBridge({ tools: [], tempDir: f.cwd, onCall() {}, interactive: true });
  t.after(() => bridge.close());
  const text = '/clear\n!do not execute\n' + 'long text '.repeat(10000);
  const command = bridge.queuePrompt([{ type: 'text', text }, { type: 'image', source: { media_type: 'image/png', data: 'aGVsbG8=' } }]);
  assert.match(command, /^\/mcp__minnow__message [a-f0-9]{32}$/);
  assert.throws(() => bridge.queuePrompt('overlap'), /not ready/);
  const url = new URL('/prompt', bridge.config.env.MINNOW_CLI_BRIDGE_URL);
  const body = JSON.stringify({ nonce: command.split(' ')[1] });
  assert.equal((await fetch(url, { method: 'POST', body })).status, 403);
  const headers = { authorization: `Bearer ${bridge.config.env.MINNOW_CLI_BRIDGE_TOKEN}` };
  const result = await fetch(url, { method: 'POST', headers, body }).then(r => r.json());
  assert.equal(result.messages[0].content.text, text);
  assert.deepEqual(result.messages[1].content, { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' });
  assert.equal((await fetch(url, { method: 'POST', headers, body })).status, 409);
});

import assert from 'node:assert/strict';
import { test, before, after, afterEach } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGenerationState, cancel } from '../../server/generations/store.js';
import { pumpCodexAppServer } from '../../server/generations/codex-app-server/pump.js';
import { pumpAgentCliUpstream } from '../../server/generations/agent-cli/pump.js';
import { __setCodexInvocationForTests, shutdownCodexSessions, codexSessionStats } from '../../server/generations/codex-app-server/manager.js';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import { getAgentCliOutput } from '../../server/generations/agent-cli/output.js';
import { runTurn, createMemoryTranscriptStore } from '../../server/runner/index.js';
import { cliCacheDir, readCliCheckpoint } from '../../server/generations/agent-cli/checkpoints.js';
import { toolImageFollowUpFromAttachments } from '../../server/runner/tool-image-follow-up.js';

const fixture = fileURLToPath(new URL('../fixtures/fake-codex-conversation.mjs', import.meta.url));
let root, processes = 0, scripts = [];
const states = [], oldHome = process.env.MINNOW_HOME, oldCodexHome = process.env.CODEX_HOME;
before(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-app-server-test-')); process.env.MINNOW_HOME = root; process.env.CODEX_HOME = root; resetMinnowHomeCache(); });
afterEach(async () => { await shutdownCodexSessions(); __setCodexInvocationForTests(); for (const state of states) clearTimeout(state.evictTimer); states.length = 0; });
after(async () => { if (oldHome == null) delete process.env.MINNOW_HOME; else process.env.MINNOW_HOME = oldHome;
  if (oldCodexHome == null) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldCodexHome;
  resetMinnowHomeCache(); await fs.rm(root, { recursive: true, force: true }); });
function setup(sequence, env = {}) {
  processes = 0; scripts = sequence;
  __setCodexInvocationForTests(session => { processes++; return { command: process.execPath, argsPrefix: [fixture], cwd: session.home,
    env: { ...process.env, MINNOW_CODEX_SCRIPTS: JSON.stringify(scripts), ...env } }; });
}
const tools = [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object', properties: {} } } }];
const imageUrl = 'data:image/png;base64,aW1hZ2U=';
const imagePart = { type: 'image_url', image_url: { url: imageUrl } };
async function generate(messages, overrides = {}, settings = {}) {
  const state = createGenerationState({ providerId: 'codex-cli', chatId: settings.chatId === undefined ? 'test-chat' : settings.chatId, fallbackRole: 'default',
    body: { model: 'fixture', stream: true, messages, tools, ...overrides } }); states.push(state);
  const pump = settings.providerEntry ? pumpAgentCliUpstream : pumpCodexAppServer;
  const run = pump({ state, runtime: { profile: { agentCli: { kind: 'codex', sessionMode: 'replay', maxConcurrent: 1, ...settings.agentCli } }, secrets: {} },
    candidate: { providerId: 'codex-cli', modelId: 'fixture' }, index: 0, idleMs: 1000, maxMs: 5000, canFailover: false });
  if (settings.abort) setTimeout(() => cancel(state), settings.abortAfterMs ?? 100);
  await run;
  const wire = Buffer.concat(state.chunks).toString();
  return { state, wire, rows: wire.split('\n\n').filter(row => row.startsWith('data: {')).map(row => JSON.parse(row.slice(6))) };
}
test('ten matching follow-ups reuse one process and stream snapshots without duplicates', async () => {
  setup(Array.from({ length: 11 }, () => ({ text: 'Hello.', deltas: ['Hel', 'lo.'] })));
  const messages = [{ role: 'user', content: 'Start.' }];
  for (let i = 0; i < 11; i++) {
    const result = await generate(messages);
    assert.equal(result.state.status, 'complete');
    assert.equal(result.rows.map(row => row.choices?.[0]?.delta?.content ?? '').join(''), 'Hello.');
    assert.equal(result.rows.at(-1).usage.total_tokens, 25);
    messages.push({ role: 'assistant', content: 'Hello.' }, { role: 'user', content: `Next ${i}.` });
  }
  assert.equal(processes, 1); assert.equal(codexSessionStats().idle, 1);
});

test('native Codex usage exhaustion preserves quota metadata on the generation and result', async () => {
  setup([{ error: "You've hit your usage limit" }]);
  const result = await generate([{ role: 'user', content: 'Start.' }]);
  assert.equal(result.state.status, 'error');
  assert.equal(result.state.quotaExceeded, true);
  assert.equal(result.state.failure.kind, 'quota');
  assert.equal(result.state.failure.scope, 'provider');
});

test('anonymous tool handoffs close their unresumable process instead of filling the CLI ceiling', async () => {
  setup([{ calls: [{ id: 'read', name: 'mn_tool_0' }] }]);
  for (let i = 0; i < 12; i++) {
    const result = await generate([{ role: 'user', content: 'Read the source.' }], {}, { chatId: null });
    assert.equal(result.state.status, 'complete', result.state.errorMessage);
    assert.equal(result.rows.at(-1).choices[0].finish_reason, 'tool_calls');
    assert.equal(codexSessionStats().total, 0, 'no future request can resume an anonymous native turn');
  }
  assert.equal(processes, 12);
});

for (const restart of [false, true]) test(`Codex sends image attachments on first and ${restart ? 'restored' : 'warm'} turns`, async () => {
  const log = path.join(root, `images-${restart}.jsonl`);
  setup([{ text: 'One.' }, { text: 'Two.' }], { MINNOW_CODEX_REQUEST_LOG: log });
  const messages = [{ role: 'user', content: [imagePart, { type: 'text', text: 'Describe this.' }] }];
  const settings = { chatId: `images-${restart}` };
  const first = await generate(messages, { minnow_cli_turn_context: 'Current file: image.png' }, settings);
  assert.equal(first.state.status, 'complete', first.state.errorMessage);
  if (restart) await shutdownCodexSessions();
  messages.push({ role: 'assistant', content: 'One.' }, { role: 'user', content: [imagePart] });
  const second = await generate(messages, {}, settings);
  assert.equal(second.state.status, 'complete', second.state.errorMessage);
  assert.equal(second.rows.at(-1).minnow_cli.continuation, restart ? 'resumed' : 'reused');
  const starts = (await fs.readFile(log, 'utf8')).trim().split('\n').map(JSON.parse).filter(row => row.method === 'turn/start');
  assert.match(starts[0].params.input[0].text, /Current file: image.png/);
  assert.deepEqual(starts[0].params.input.slice(1), [{ type: 'image', url: imageUrl }, { type: 'text', text: 'Describe this.' }]);
  assert.deepEqual(starts[1].params.input, [{ type: 'image', url: imageUrl }]);
  assert.equal(processes, restart ? 2 : 1);
});

test('Codex reconstructs historical image pixels and accepts input above the old 4 MB RPC limit', async () => {
  const log = path.join(root, 'image-history.jsonl');
  setup([{ text: 'Recovered.' }], { MINNOW_CODEX_REQUEST_LOG: log });
  const largeUrl = `data:image/png;base64,${Buffer.alloc(3.1 * 1024 * 1024).toString('base64')}`;
  const result = await generate([{ role: 'user', content: [imagePart] }, { role: 'assistant', content: 'Saw it.' },
    { role: 'user', content: [{ type: 'image_url', image_url: largeUrl }] }], {}, { chatId: 'image-history' });
  assert.equal(result.state.status, 'complete', result.state.errorMessage);
  const requests = (await fs.readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
  const history = requests.find(row => row.method === 'thread/inject_items').params.items;
  assert.deepEqual(history[0], { type: 'message', role: 'user', content: [{ type: 'input_image', image_url: imageUrl, detail: 'auto' }] });
  assert.deepEqual(requests.find(row => row.method === 'turn/start').params.input, [{ type: 'image', url: largeUrl }]);
});

test('Codex returns screenshot pixels in the pending tool result and retains its conversation', async () => {
  const log = path.join(root, 'tool-images.jsonl');
  setup([{ calls: [{ id: 'screenshot', name: 'mn_tool_0' }] }, { text: 'Saw the screenshot.' }, { text: 'Next.' }],
    { MINNOW_CODEX_REQUEST_LOG: log });
  const messages = [{ role: 'user', content: 'Take a screenshot.' }];
  const settings = { chatId: 'tool-images' };
  const first = await generate(messages, {}, settings);
  const calls = first.rows.flatMap(row => row.choices?.[0]?.delta?.tool_calls ?? []).map(({ index, ...call }) => call);
  messages.push({ role: 'assistant', content: '', tool_calls: calls },
    { role: 'tool', tool_call_id: calls[0].id, content: 'Screenshot saved.' },
    toolImageFollowUpFromAttachments([{ type: 'image', dataUrl: imageUrl }]));
  const second = await generate(messages, {}, settings);
  assert.equal(second.state.status, 'complete', second.state.errorMessage);
  assert.equal(second.rows.at(-1).minnow_cli.continuation, 'reused');
  const responses = (await fs.readFile(log, 'utf8')).trim().split('\n').map(JSON.parse).filter(row => row.result?.contentItems);
  assert.deepEqual(responses[0].result.contentItems.at(-1), { type: 'inputImage', imageUrl });
  messages.push({ role: 'assistant', content: 'Saw the screenshot.' }, { role: 'user', content: 'Next.' });
  assert.equal((await generate(messages, {}, settings)).state.status, 'complete');
  assert.equal(processes, 1);
});

for (const context of [undefined, 'Current document: recovery-notes.md']) test(`tool-result reconstruction preserves ${context ? 'current turn context' : 'empty input without context'}`, async () => {
  const log = path.join(root, `recovery-context-${Boolean(context)}.jsonl`);
  setup([{ text: 'Recovered.' }], { MINNOW_CODEX_REQUEST_LOG: log });
  const messages = [{ role: 'user', content: 'Read the file.' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'recorded-call', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'recorded-call', content: 'Recorded file contents.' }];
  const original = structuredClone(messages);
  const result = await generate(messages, { minnow_cli_turn_context: context }, { chatId: `recovery-context-${Boolean(context)}` });
  assert.equal(result.state.status, 'complete', result.state.errorMessage);
  const requests = (await fs.readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
  const starts = requests.filter(row => row.method === 'turn/start');
  assert.equal(starts.length, 1);
  if (context) {
    assert.equal(starts[0].params.input.length, 1);
    assert.match(starts[0].params.input[0].text, /<minnow_turn_context>/);
    assert.ok(starts[0].params.input[0].text.includes(context));
  } else assert.deepEqual(starts[0].params.input, []);
  const items = requests.filter(row => row.method === 'thread/inject_items').flatMap(row => row.params.items);
  assert.deepEqual(items.filter(item => item.type === 'function_call_output'),
    [{ type: 'function_call_output', call_id: 'recorded-call', output: 'Recorded file contents.' }]);
  assert.deepEqual(messages, original);
});

test('durable Codex resume verifies history and counts only the new turn', async () => {
  setup([{ text: 'One.' }, { text: 'Two.' }]);
  const messages = [{ role: 'user', content: 'Start.' }];
  await generate(messages, {}, { chatId: 'codex-restart' }); await shutdownCodexSessions();
  messages.push({ role: 'assistant', content: 'One.' }, { role: 'user', content: 'Next.' });
  const next = await generate(messages, {}, { chatId: 'codex-restart' });
  assert.equal(next.state.status, 'complete', next.state.errorMessage);
  assert.equal(next.rows.at(-1).minnow_cli.continuation, 'resumed'); assert.equal(next.rows.at(-1).usage.total_tokens, 25);
  assert.equal(processes, 2); assert.ok(next.wire.includes('Two.'));
});

test('canonical native rollout paths resume through an aliased Minnow home', async () => {
  const alias = path.join(root, 'home-alias');
  const home = path.join(root, 'aliased-home');
  await fs.mkdir(home);
  await fs.symlink(home, alias, process.platform === 'win32' ? 'junction' : 'dir');
  process.env.MINNOW_HOME = alias; resetMinnowHomeCache();
  try {
    setup([{ text: 'One.' }, { text: 'Two.' }], { MINNOW_CODEX_ROLLOUT_PATH: '1' });
    const chatId = 'canonical-rollout', messages = [{ role: 'user', content: 'Start.' }];
    await generate(messages, {}, { chatId });
    const checkpoint = await readCliCheckpoint('codex-cli', chatId);
    assert.equal(checkpoint.clean, true);
    assert.equal(checkpoint.nativeFile, 'fixture-thread.json');
    await shutdownCodexSessions();
    messages.push({ role: 'assistant', content: 'One.' }, { role: 'user', content: 'Next.' });
    const next = await generate(messages, {}, { chatId });
    assert.equal(next.rows.at(-1).minnow_cli.continuation, 'resumed');
    assert.ok(next.wire.includes('Two.'));
  } finally {
    await shutdownCodexSessions();
    process.env.MINNOW_HOME = root; resetMinnowHomeCache();
  }
});

test('tampered Codex native history reconstructs before starting a replacement turn', async () => {
  setup([{ text: 'One.' }, { text: 'Two.' }]); const chatId = 'codex-tampered';
  const messages = [{ role: 'user', content: 'Start.' }];
  await generate(messages, {}, { chatId }); await shutdownCodexSessions();
  const file = path.join(cliCacheDir('codex-cli', chatId), 'native', 'fixture-thread.json');
  const record = JSON.parse(await fs.readFile(file, 'utf8')); record.turns[0].items[0].text = 'Modified';
  await fs.writeFile(file, JSON.stringify(record));
  messages.push({ role: 'assistant', content: 'One.' }, { role: 'user', content: 'Next.' });
  const next = await generate(messages, {}, { chatId });
  assert.equal(next.state.status, 'complete', next.state.errorMessage); assert.equal(next.rows.at(-1).minnow_cli.continuation, 'rebuilt');
  assert.equal((await readCliCheckpoint('codex-cli', chatId)).clean, true);
});

test('context window reaches native config and changes rebuild retained conversations', async () => {
  const configs = [];
  __setCodexInvocationForTests(async session => {
    configs.push(await fs.readFile(path.join(session.home, 'config.toml'), 'utf8'));
    return { command: process.execPath, argsPrefix: [fixture], cwd: session.home,
      env: { ...process.env, MINNOW_CODEX_SCRIPTS: JSON.stringify([{ text: 'Reply.' }]) } };
  });
  const messages = [{ role: 'user', content: 'Start.' }];
  const first = await generate(messages, {}, { agentCli: { contextWindowTokens: 300_000 } });
  assert.equal(first.state.status, 'complete');
  messages.push({ role: 'assistant', content: 'Reply.' }, { role: 'user', content: 'Next.' });
  const second = await generate(messages, {}, { agentCli: { contextWindowTokens: 400_000 } });
  assert.equal(second.state.status, 'complete');
  assert.equal(configs.length, 2);
  assert.match(configs[0], /^model_context_window = 300000$/m);
  assert.match(configs[1], /^model_context_window = 400000$/m);
  assert.ok(configs[0].indexOf('model_context_window') < configs[0].indexOf('[tools]'));
});

test('Codex enables isolated tool orchestration and disables native environment access', async () => {
  const log = path.join(root, 'tool-environment-config.jsonl');
  let config;
  __setCodexInvocationForTests(async session => {
    config = await fs.readFile(path.join(session.home, 'config.toml'), 'utf8');
    return { command: process.execPath, argsPrefix: [fixture], cwd: session.home,
      env: { ...process.env, MINNOW_CODEX_REQUEST_LOG: log } };
  });
  const result = await generate([{ role: 'user', content: 'Hello.' }]);
  assert.equal(result.state.status, 'complete');
  assert.match(config, /^code_mode = true$/m);
  assert.match(config, /\[agents\]\nenabled = false/);
  assert.match(config, /^multi_agent_v2 = false$/m);
  const requests = (await fs.readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
  const start = requests.find(row => row.method === 'thread/start').params;
  assert.deepEqual(start.environments, []);
  assert.match(start.dynamicTools[0].description, /Minnow tool: read_file/);
  assert.match(start.developerInstructions, /code-mode exec/);
  assert.match(start.developerInstructions, /tools\.mn_read_batch/);
  assert.match(start.developerInstructions, /up to six ordinary Minnow calls/);
  assert.match(start.developerInstructions, /interactive tools sequential/);
});

test('the production provider entry selects app-server for legacy persisted replay profiles', async () => {
  setup([{ text: 'Default transport.' }]);
  const result = await generate([{ role: 'user', content: 'Hello.' }], {}, { providerEntry: true });
  assert.equal(result.state.status, 'complete'); assert.ok(result.wire.includes('Default transport.'));
  assert.equal(processes, 1);
});
test('parallel handoff, duplicate notification, real tool results and same-turn reattachment', async () => {
  setup([{ calls: [{ id: 'one', name: 'mn_tool_0', duplicate: true }, { id: 'two', name: 'mn_tool_0' }] }, { text: 'Done.' }]);
  const messages = [{ role: 'user', content: 'Read.' }];
  const first = await generate(messages);
  const calls = first.rows.flatMap(row => row.choices?.[0]?.delta?.tool_calls ?? []).map(({ index, ...call }) => call);
  assert.equal(calls.length, 2);
  messages.push({ role: 'assistant', content: '', tool_calls: calls }, ...calls.map(call => ({ role: 'tool', tool_call_id: call.id, content: 'Real result' })));
  const second = await generate(messages);
  assert.equal(second.state.status, 'complete'); assert.ok(second.wire.includes('Done.')); assert.equal(processes, 1);
});
test('native activity keeps staggered calls in one handoff without restarting the process', async () => {
  setup([{ calls: [{ id: 'one', name: 'mn_tool_0' },
    { id: 'two', name: 'mn_tool_0', activityCount: 3, activityIntervalMs: 100 }] }, { text: 'Done.' }]);
  const messages = [{ role: 'user', content: 'Read independently.' }];
  const first = await generate(messages);
  const calls = first.rows.flatMap(row => row.choices?.[0]?.delta?.tool_calls ?? []).map(({ index, ...call }) => call);
  assert.equal(calls.length, 2);
  assert.equal(first.rows.at(-1).minnow_cli.timings.tool_batch_count, 2);
  messages.push({ role: 'assistant', content: '', tool_calls: calls },
    ...calls.map(call => ({ role: 'tool', tool_call_id: call.id, content: 'Real result' })));
  assert.ok((await generate(messages)).wire.includes('Done.'));
  assert.equal(processes, 1);
});

test('single-call handoff retains the short quiet window', async () => {
  setup([{ calls: [{ id: 'one', name: 'mn_tool_0' }] }]);
  const first = await generate([{ role: 'user', content: 'Read.' }]);
  const timings = first.rows.at(-1).minnow_cli.timings;
  assert.equal(timings.tool_batch_count, 1);
  assert.ok(timings.tool_batch_collect_ms < 800, `collection took ${timings.tool_batch_collect_ms} ms`);
});

test('continuous native activity cannot postpone handoff indefinitely', async () => {
  setup([{ calls: [{ id: 'one', name: 'mn_tool_0' },
    { id: 'two', name: 'mn_tool_0', activityCount: 20, activityIntervalMs: 100 }] }]);
  const first = await generate([{ role: 'user', content: 'Read.' }]);
  assert.equal(first.state.status, 'complete', first.state.errorMessage);
  const timings = first.rows.at(-1).minnow_cli.timings;
  assert.equal(timings.tool_batch_count, 1);
  assert.ok(timings.tool_batch_collect_ms >= 900);
  assert.ok(timings.tool_batch_collect_ms < 1800, `collection took ${timings.tool_batch_collect_ms} ms`);
});

test('a full handoff flushes promptly and overflow calls survive the next round', async () => {
  setup([{ calls: Array.from({ length: 9 }, (_, i) => ({ id: `read-${i}`, name: 'mn_tool_0' })) }, { text: 'Done.' }]);
  const messages = [{ role: 'user', content: 'Read files.' }];
  const collect = result => result.rows.flatMap(row => row.choices?.[0]?.delta?.tool_calls ?? []).map(({ index, ...call }) => call);
  const first = await generate(messages);
  const calls = collect(first);
  assert.equal(calls.length, 8);
  assert.ok(first.rows.at(-1).minnow_cli.timings.tool_batch_collect_ms < 180);
  messages.push({ role: 'assistant', content: '', tool_calls: calls },
    ...calls.map(call => ({ role: 'tool', tool_call_id: call.id, content: 'Real result' })));
  const overflow = collect(await generate(messages));
  assert.equal(overflow.length, 1);
  assert.ok(!calls.some(call => call.id === overflow[0].id));
  messages.push({ role: 'assistant', content: '', tool_calls: overflow },
    { role: 'tool', tool_call_id: overflow[0].id, content: 'Last real result' });
  assert.ok((await generate(messages)).wire.includes('Done.'));
  assert.equal(processes, 1);
});

test('read batch expands into ordinary calls once and returns ordered real results', async () => {
  const log = path.join(root, 'read-batch-results.jsonl');
  setup([{ calls: [{ id: 'batch', name: 'mn_read_batch', duplicate: true, args: { calls: [
    { name: 'read_file', arguments: { path: 'safe' } }, { name: 'read_file', arguments: { path: 'blocked' } },
  ] } }] }, { text: 'Done.' }], { MINNOW_CODEX_REQUEST_LOG: log });
  const messages = [{ role: 'user', content: 'Read files.' }];
  const first = await generate(messages);
  const calls = first.rows.flatMap(row => row.choices?.[0]?.delta?.tool_calls ?? []).map(({ index, ...call }) => call);
  assert.deepEqual(calls.map(call => call.function.name), ['read_file', 'read_file']);
  assert.equal(new Set(calls.map(call => call.id)).size, 2);
  assert.ok(first.rows.at(-1).minnow_cli.timings.tool_batch_collect_ms < 180, 'complete transport batches skip the quiet wait');
  messages.push({ role: 'assistant', content: '', tool_calls: calls },
    { role: 'tool', tool_call_id: calls[0].id, content: 'Actual source' },
    { role: 'tool', tool_call_id: calls[1].id, content: 'Error: permission denied' });
  assert.ok((await generate(messages)).wire.includes('Done.'));
  const responses = (await fs.readFile(log, 'utf8')).trim().split('\n').map(JSON.parse).filter(row => row.result?.contentItems);
  assert.equal(responses.length, 1, 'duplicate notification has one native request ID');
  assert.deepEqual(responses[0].result.contentItems.map(item => JSON.parse(item.text)), [
    { index: 0, name: 'read_file', content: 'Actual source' },
    { index: 1, name: 'read_file', content: 'Error: permission denied' },
  ]);
  assert.equal(processes, 1);
});

test('split transport batches retain partial results until every member is recorded', async () => {
  const batch = id => ({ id, name: 'mn_read_batch', args: { calls: Array.from({ length: 5 }, (_, i) =>
    ({ name: 'read_file', arguments: { path: `${id}-${i}` } })) } });
  setup([{ calls: [batch('first'), batch('second')] }, { text: 'Both batches received.' }]);
  const messages = [{ role: 'user', content: 'Read files.' }];
  const collect = result => result.rows.flatMap(row => row.choices?.[0]?.delta?.tool_calls ?? []).map(({ index, ...call }) => call);
  const first = collect(await generate(messages));
  assert.equal(first.length, 8);
  messages.push({ role: 'assistant', content: '', tool_calls: first },
    ...first.map(call => ({ role: 'tool', tool_call_id: call.id, content: `Result ${call.id}` })));
  const remaining = collect(await generate(messages));
  assert.equal(remaining.length, 2);
  messages.push({ role: 'assistant', content: '', tool_calls: remaining },
    ...remaining.map(call => ({ role: 'tool', tool_call_id: call.id, content: `Result ${call.id}` })));
  assert.ok((await generate(messages)).wire.includes('Both batches received.'));
  assert.equal(new Set([...first, ...remaining].map(call => call.id)).size, 10);
  assert.equal(processes, 1);
});

for (const name of ['apply_patch', 'unknown_read', 'ask_question']) test(`read batch rejects ${name} without ending the native turn or executing members`, async () => {
  const log = path.join(root, `invalid-batch-${name}.jsonl`);
  setup([{ calls: [{ id: 'invalid-batch', name: 'mn_read_batch', duplicate: true, args: { calls: [
    { name: 'read_file', arguments: {} }, { name, arguments: {} },
  ] } }] }, { text: 'I can correct that call.' }], { MINNOW_CODEX_REQUEST_LOG: log });
  const result = await generate([{ role: 'user', content: 'Read.' }]);
  assert.equal(result.state.status, 'complete', result.state.errorMessage);
  assert.ok(result.wire.includes('I can correct that call.'));
  assert.equal(result.rows.flatMap(row => row.choices?.[0]?.delta?.tool_calls ?? []).length, 0);
  const responses = (await fs.readFile(log, 'utf8')).trim().split('\n').map(JSON.parse).filter(row => row.result?.contentItems);
  assert.ok(responses.length >= 1);
  assert.equal(new Set(responses.map(row => row.id)).size, 1, 'duplicate notifications share one native call');
  for (const response of responses) assert.deepEqual(response.result, responses[0].result, 'retransmissions reuse the cached rejection');
  assert.equal(responses[0].result.success, false);
  assert.match(responses[0].result.contentItems[0].text, /unavailable or non-read-only/);
  assert.match(responses[0].result.contentItems[0].text, /No calls were executed/);
  assert.equal(processes, 1);
});

test('Codex corrects a malformed batch and continues with real tool results in the same process', async () => {
  setup([{ calls: [{ id: 'invalid', name: 'mn_read_batch', args: { calls: [] } }] },
    { calls: [{ id: 'corrected', name: 'mn_read_batch', args: { calls: [{ name: 'read_file', arguments: { path: 'safe' } }] } }] },
    { text: 'Read the actual source.' }]);
  const messages = [{ role: 'user', content: 'Read.' }];
  const first = await generate(messages);
  assert.equal(first.state.status, 'complete', first.state.errorMessage);
  const calls = first.rows.flatMap(row => row.choices?.[0]?.delta?.tool_calls ?? []).map(({ index, ...call }) => call);
  assert.deepEqual(calls.map(call => call.function), [{ name: 'read_file', arguments: '{"path":"safe"}' }]);
  messages.push({ role: 'assistant', content: '', tool_calls: calls },
    { role: 'tool', tool_call_id: calls[0].id, content: 'Actual source' });
  const next = await generate(messages);
  assert.equal(next.state.status, 'complete', next.state.errorMessage);
  assert.ok(next.wire.includes('Read the actual source.'));
  assert.equal(processes, 1);
});

test('history edits, changed tool permissions and instruction changes rebuild the native thread', async () => {
  setup([{ text: 'Reply.' }]);
  await generate([{ role: 'user', content: 'A.' }]);
  await generate([{ role: 'user', content: 'Edited.' }]);
  await generate([{ role: 'system', content: 'Plan mode.' }, { role: 'user', content: 'A.' }], { tools: [] });
  assert.equal(processes, 3);
});
test('compaction fails closed with a runner-recognized overflow and disposes native history', async () => {
  setup([{ compact: true }]);
  const result = await generate([{ role: 'user', content: 'Long context.' }]);
  assert.equal(result.state.status, 'error'); assert.match(result.state.errorMessage, /Context length exceeded/);
  await shutdownCodexSessions(); assert.equal(codexSessionStats().total, 0);
});
test('Stop interrupts a turn and shuts down its process and private home', async () => {
  setup([{ hang: true }]);
  const result = await generate([{ role: 'user', content: 'Wait.' }], {}, { abort: true });
  assert.equal(result.state.status, 'cancelled');
  await shutdownCodexSessions(); assert.equal(codexSessionStats().total, 0);
});
test('required tools cannot silently succeed and native unknown tools receive no execution authority', async () => {
  setup([{ text: 'No tool.' }]);
  const required = await generate([{ role: 'user', content: 'Use a tool.' }], { tool_choice: 'required' });
  assert.equal(required.state.status, 'error'); assert.match(required.state.errorMessage, /required tool/);
  setup([{ calls: [{ id: 'native', name: 'shell_command' }] }]);
  const native = await generate([{ role: 'user', content: 'Native.' }]);
  assert.equal(native.state.status, 'error'); assert.match(native.state.errorMessage, /unexposed/);
});
test('non-streaming uses existing completion shape', async () => {
  setup([{ text: 'JSON reply.' }]);
  const result = await generate([{ role: 'user', content: 'Hi.' }], { stream: false });
  const completion = JSON.parse(result.wire);
  assert.equal(completion.choices[0].message.content, 'JSON reply.'); assert.equal(completion.usage.total_tokens, 25);
});

test('native call IDs are scoped to turns and independent chats', async () => {
  setup([{ calls: [{ id: 'same-id', name: 'mn_tool_0' }] }, { text: 'Done.' },
    { calls: [{ id: 'same-id', name: 'mn_tool_0' }] }, { text: 'Again.' }]);
  const messages = [{ role: 'user', content: 'First.' }];
  const collect = result => result.rows.flatMap(row => row.choices?.[0]?.delta?.tool_calls ?? []).map(({ index, ...call }) => call);
  const first = collect(await generate(messages));
  messages.push({ role: 'assistant', content: '', tool_calls: first }, { role: 'tool', tool_call_id: first[0].id, content: 'Saved result' });
  await generate(messages);
  messages.push({ role: 'assistant', content: 'Done.' }, { role: 'user', content: 'Next.' });
  const second = collect(await generate(messages));
  assert.equal(second.length, 1); assert.notEqual(second[0].id, first[0].id);
  const other = collect(await generate([{ role: 'user', content: 'Other chat.' }], {}, { chatId: 'other' }));
  assert.equal(other.length, 1); assert.notEqual(other[0].id, first[0].id);
});

test('idle retention is bounded and shutdown preserves clean resumable homes', async () => {
  setup([{ text: 'Idle.' }]);
  for (let i = 0; i < 12; i++) await generate([{ role: 'user', content: 'Hello.' }], {}, { chatId: `idle-${i}` });
  assert.ok(codexSessionStats().idle <= 8);
  await shutdownCodexSessions();
  assert.equal(codexSessionStats().total, 0);
  assert.ok((await fs.readdir(path.join(root, 'cli-sessions'))).length >= 8);
});

function runnerDeps(overrides = {}) {
  return {
    transcriptStore: createMemoryTranscriptStore(),
    postChatCompletions: async (_provider, body) => {
      const { state, wire } = await generate(body.messages, body);
      return new Response(state.status === 'error' ? state.errorMessage : wire, {
        status: state.status === 'error' ? 400 : 200, headers: { 'Content-Type': 'text/event-stream' },
      });
    },
    runHeadlessToolBatch: async options => {
      const outcomes = [];
      for (const toolCall of options.toolCalls) {
        const result = await options.execute(toolCall.function.name, JSON.parse(toolCall.function.arguments), { toolCallId: toolCall.id });
        const outcome = { toolCall, result }; options.onToolDone?.(outcome); outcomes.push(outcome);
      }
      return outcomes;
    },
    resolveProvider: async () => ({ id: 'codex-cli', apiKind: 'openai-v1', baseUrl: 'http://127.0.0.1:9' }),
    getSubAgentTypeConfig: async () => ({}), resolveSamplerPreset: () => ({ preset: {}, maxTokens: 256 }),
    resolveThinkingMode: () => ({ mode: 'off' }), resolveThinkingBudgetTokens: () => ({ budgetTokens: null }),
    loadToolCallsMeta: async () => {}, getToolCallsMetaSync: () => ({ useConstrainedDecoding: false }),
    isConstrainedDecodingEnabledForProvider: () => false, readProviderCapabilities: async () => null,
    isStructuredOutcomeResponseFormatAvailable: () => false, resolveSendCapabilities: () => ({}),
    resolveModelContextLimit: () => 8192,
    applyContextPolicy: async input => ({ applied: false, messages: input.messages }), ...overrides,
  };
}

test('shared runner executes duplicated native calls once and retains real denied results', async () => {
  setup([{ calls: [{ id: 'read', name: 'mn_tool_0', duplicate: true, args: { path: 'safe' } },
    { id: 'denied', name: 'mn_tool_0', args: { path: 'blocked' } }] }, { text: 'Finished.' }]);
  const executed = [], events = [];
  const result = await runTurn({ chatId: 'runner', seed: 'Read files.', tools, lazyTools: false,
    model: { providerId: 'codex-cli', id: 'fixture' }, deps: runnerDeps(),
    injectReportTool: false, nudgeToolUse: false, finalizeStructuredOutcome: false,
    execute: async (_name, args) => { executed.push(args.path); return { content: args.path === 'blocked' ? 'Error: permission denied' : 'Actual file contents' }; },
    onEvent: event => events.push(event),
  });
  assert.equal(result.outcome, 'no_report'); assert.deepEqual(executed, ['safe', 'blocked']);
  assert.equal(processes, 1);
  assert.ok(events.some(event => event.type === 'tool_result' && event.content.includes('permission denied')));
});

test('transport batches still use ordinary runner execution and permission results', async () => {
  setup([{ calls: [{ id: 'batch', name: 'mn_read_batch', duplicate: true, args: { calls: [
    { name: 'read_file', arguments: { path: 'safe' } }, { name: 'read_file', arguments: { path: 'blocked' } },
  ] } }] }, { text: 'Finished.' }]);
  const executed = [], events = [];
  const result = await runTurn({ chatId: 'runner-batch', seed: 'Read files.', tools, lazyTools: false,
    model: { providerId: 'codex-cli', id: 'fixture' }, deps: runnerDeps(),
    injectReportTool: false, nudgeToolUse: false, finalizeStructuredOutcome: false,
    execute: async (name, args) => {
      assert.equal(name, 'read_file', 'the transport wrapper never reaches tool execution');
      executed.push(args.path);
      return { content: args.path === 'blocked' ? 'Error: permission denied' : 'Actual file contents' };
    },
    onEvent: event => events.push(event),
  });
  assert.equal(result.outcome, 'no_report');
  assert.deepEqual(executed, ['safe', 'blocked']);
  assert.ok(events.some(event => event.type === 'tool_result' && event.content.includes('permission denied')));
  assert.equal(processes, 1);
});

test('shared runner compacts its own transcript before rebuilding after native compaction', async () => {
  setup([{ compact: true }]);
  let compacted = false;
  const result = await runTurn({ chatId: 'runner-overflow', seed: '', seedKind: 'continue', tools: [],
    messages: [{ role: 'system', content: 'Instructions' }, { role: 'user', content: 'Old' },
      { role: 'assistant', content: 'Old response '.repeat(400) }, { role: 'user', content: 'Continue' }],
    model: { providerId: 'codex-cli', id: 'fixture' }, lazyTools: false,
    injectReportTool: false, nudgeToolUse: false, finalizeStructuredOutcome: false,
    limits: { contextBudget: { enforcementPolicy: 'slide' } },
    deps: runnerDeps({ applyContextPolicy: async input => {
      if (input.effectiveLimitOverride != null) {
        compacted = true; scripts = [{ text: 'Recovered.' }];
        return { applied: true, messages: [input.messages[0], input.messages.at(-1)], tokensAfter: 8 };
      }
      return { applied: false, messages: input.messages };
    } }),
  });
  assert.equal(result.outcome, 'no_report', result.error); assert.equal(compacted, true); assert.equal(processes, 2);
});

test('a rejected question batch can be corrected into a real runner question', async () => {
  const question = { questions: [{ id: 'q', prompt: 'Choose', options: [{ id: 'a', label: 'A' }] }] };
  setup([{ calls: [{ id: 'invalid-ask', name: 'mn_read_batch', args: { calls: [
    { name: 'read_file', arguments: {} }, { name: 'ask_question', arguments: question },
  ] } }] }, { calls: [{ id: 'ask', name: 'mn_tool_1', args: question }] }, { text: 'Answered.' }]);
  let asks = 0;
  const deps = runnerDeps();
  const result = await runTurn({ chatId: 'runner-corrected-question', seed: 'Ask me.', tools, lazyTools: false,
    model: { providerId: 'codex-cli', id: 'fixture' }, deps,
    injectReportTool: false, nudgeToolUse: false, finalizeStructuredOutcome: false,
    ask: { ask: async value => { asks++; assert.deepEqual(value, question); return 'A'; } },
    execute: async () => { throw new Error('Rejected batch members must not execute'); },
  });
  assert.equal(result.outcome, 'no_report', result.error);
  assert.equal(deps.transcriptStore.load('runner-corrected-question').messages.at(-1).content, 'Answered.');
  assert.equal(asks, 1);
  assert.equal(processes, 1);
});

test('questions and terminal reports remain runner capabilities', async () => {
  const question = { questions: [{ id: 'q', prompt: 'Choose', options: [{ id: 'a', label: 'A' }] }] };
  setup([{ calls: [{ id: 'ask', name: 'mn_tool_0', duplicate: true, args: question }] }, { text: 'Answered.' }]);
  let asks = 0;
  const asked = await runTurn({ chatId: 'runner-question', seed: 'Ask me.', tools: [], lazyTools: false,
    model: { providerId: 'codex-cli', id: 'fixture' }, deps: runnerDeps(),
    injectReportTool: false, nudgeToolUse: false, finalizeStructuredOutcome: false,
    ask: { ask: async value => { asks++; assert.deepEqual(value, question); return 'A'; } },
    execute: async () => { throw new Error('Human question reached server execution'); },
  });
  assert.equal(asked.outcome, 'no_report'); assert.equal(asks, 1);
  setup([{ calls: [{ id: 'report', name: 'mn_tool_0', duplicate: true,
    args: { outcome: 'pass', summary: 'Checked.', evidence: ['fixture'] } }] }]);
  const reported = await runTurn({ chatId: 'runner-report', seed: 'Report.', tools: [], lazyTools: false,
    model: { providerId: 'codex-cli', id: 'fixture' }, deps: runnerDeps(),
    execute: async () => { throw new Error('Report reached server execution'); },
  });
  assert.equal(reported.outcome, 'pass'); assert.equal(reported.summary, 'Checked.');
});

test('source login changes rebuild an otherwise matching conversation', async () => {
  setup([{ text: 'Reply.' }]);
  const authPath = path.join(root, 'auth.json');
  await fs.writeFile(authPath, JSON.stringify({ tokens: { access_token: 'first-login' } }));
  const messages = [{ role: 'user', content: 'Hello.' }];
  await generate(messages);
  messages.push({ role: 'assistant', content: 'Reply.' }, { role: 'user', content: 'Again.' });
  await fs.writeFile(authPath, JSON.stringify({ tokens: { access_token: 'second-login' } }));
  await generate(messages);
  assert.equal(processes, 2);
  await fs.rm(authPath);
});

test('a process crash after recorded tool work does not trigger transport replay', async () => {
  setup([{ calls: [{ id: 'edit', name: 'mn_tool_0' }] }, { crash: true }]);
  const messages = [{ role: 'user', content: 'Edit.' }];
  const first = await generate(messages);
  const calls = first.rows.flatMap(row => row.choices?.[0]?.delta?.tool_calls ?? []).map(({ index, ...call }) => call);
  messages.push({ role: 'assistant', content: '', tool_calls: calls }, { role: 'tool', tool_call_id: calls[0].id, content: 'Edit committed once' });
  const crashed = await generate(messages);
  assert.equal(crashed.state.status, 'error'); assert.equal(processes, 1);
  scripts = [{ text: 'Recovered.' }];
  const recovered = await generate(messages);
  assert.equal(recovered.state.status, 'complete'); assert.equal(processes, 2);
  assert.equal(recovered.rows.flatMap(row => row.choices?.[0]?.delta?.tool_calls ?? []).length, 0);
});

test('queued cancellation settles without waiting for the running conversation', async () => {
  setup([{ hang: true }]);
  const running = generate([{ role: 'user', content: 'Hold.' }], {}, { chatId: 'held' });
  // The held conversation must own the single process before the second request queues behind it.
  for (let i = 0; i < 200 && processes < 1; i++) await new Promise(resolve => setTimeout(resolve, 10));
  const started = performance.now();
  const queued = await generate([{ role: 'user', content: 'Queued.' }], {}, { chatId: 'queued', abort: true });
  assert.equal(queued.state.status, 'cancelled'); assert.ok(performance.now() - started < 700);
  assert.notEqual(states[0].status, 'complete'); assert.equal(processes, 1);
  cancel(states[0]); await running;
});

test('unresponsive interruption is bounded and identity-less requests remain disposable', async () => {
  setup([{ hang: true }], { MINNOW_CODEX_IGNORE_INTERRUPT: '1' });
  const started = performance.now();
  const stopped = await generate([{ role: 'user', content: 'Wait.' }], {}, { abort: true, abortAfterMs: 800 });
  assert.equal(stopped.state.status, 'cancelled'); assert.ok(performance.now() - started < 5000);
  await shutdownCodexSessions(); assert.equal(codexSessionStats().total, 0);
  setup([{ text: 'Disposable.' }]);
  await generate([{ role: 'user', content: 'Utility.' }], {}, { chatId: null });
  await shutdownCodexSessions(); assert.equal(codexSessionStats().total, 0);
});

test('copied file credentials are redacted from native errors and retained raw output', async () => {
  const secret = 'private-file-login-secret', authPath = path.join(root, 'auth.json');
  await fs.writeFile(authPath, JSON.stringify({ tokens: { access_token: secret } }));
  setup([{ error: `Provider rejected ${secret}` }]);
  try {
    const result = await generate([{ role: 'user', content: 'Error.' }]);
    assert.equal(result.state.status, 'error'); assert.doesNotMatch(result.state.errorMessage, new RegExp(secret));
    assert.match(result.state.errorMessage, /redacted/);
    assert.doesNotMatch(getAgentCliOutput('test-chat').output, new RegExp(secret));
  } finally { await shutdownCodexSessions(); await fs.rm(authPath); }
});

test('trimmed assistant history reuses the native process for tool rounds and follow-ups', async () => {
  setup([{ text: 'Checking.\n', calls: [{ id: 'read', name: 'mn_tool_0' }] }, { text: 'Done.\n' }, { text: 'Again.\n' }]);
  const messages = [{ role: 'user', content: 'Read.' }];
  const first = await generate(messages);
  assert.equal(first.state.status, 'complete', first.state.errorMessage);
  const calls = first.rows.flatMap(row => row.choices?.[0]?.delta?.tool_calls ?? []);
  assert.equal(calls.length, 1);
  messages.push({ role: 'assistant', content: 'Checking.', tool_calls: calls },
    { role: 'tool', tool_call_id: calls[0].id, content: 'Source.' });
  const second = await generate(messages);
  assert.equal(second.state.status, 'complete', second.state.errorMessage);
  assert.equal(second.rows.at(-1).minnow_cli.continuation, 'reused');
  const answer = second.rows.map(row => row.choices?.[0]?.delta?.content ?? '').join('').trim();
  messages.push({ role: 'assistant', content: answer }, { role: 'user', content: 'Next.' });
  const third = await generate(messages);
  assert.equal(third.state.status, 'complete', third.state.errorMessage);
  assert.equal(third.rows.at(-1).minnow_cli.continuation, 'reused');
  assert.equal(processes, 1);
});


test('sequential tools bypass read collection and return results on the same native turn', async () => {
  setup([{ calls: [{ id: 'write', name: 'mn_tool_0' }] }, { text: 'Applied.' }]);
  const writeTools = [{ type: 'function', function: { name: 'apply_patch', parameters: { type: 'object', properties: {} } } }];
  const messages = [{ role: 'user', content: 'Apply the edit.' }];
  const first = await generate(messages, { tools: writeTools });
  assert.equal(first.state.status, 'complete', first.state.errorMessage);
  assert.ok(first.rows.at(-1).minnow_cli.timings.tool_batch_collect_ms < 100);
  const calls = first.rows.flatMap(row => row.choices?.[0]?.delta?.tool_calls ?? []).map(({ index, ...call }) => call);
  messages.push({ role: 'assistant', content: '', tool_calls: calls }, { role: 'tool', tool_call_id: calls[0].id, content: 'Actual edit result.' });
  const second = await generate(messages, { tools: writeTools });
  assert.equal(second.state.status, 'complete', second.state.errorMessage);
  assert.ok(second.wire.includes('Applied.'));
  assert.equal(processes, 1);
});

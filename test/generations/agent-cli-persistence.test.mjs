import assert from 'node:assert/strict';
import { test, before, after, afterEach } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import { createGenerationState, cancel } from '../../server/generations/store.js';
import { pumpAgentCliSession, __setAgentCliSessionMocksForTests, __resetAgentCliSessionMocksForTests } from '../../server/generations/agent-cli/session.js';
import { disposeCliSessions } from '../../server/generations/agent-cli/lifecycle.js';
import { getAgentCliOutput } from '../../server/generations/agent-cli/output.js';
import { cliCacheDir, readCliCheckpoint, writeCliCheckpoint } from '../../server/generations/agent-cli/checkpoints.js';
import { toolImageFollowUpFromAttachments } from '../../server/runner/tool-image-follow-up.js';
let root, processes = 0, invocations = [], kind = 'claude';
const states = [], previous = { home: process.env.MINNOW_HOME, claude: process.env.CLAUDE_CONFIG_DIR };
before(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-cli-persistent-')); process.env.MINNOW_HOME = root; process.env.CLAUDE_CONFIG_DIR = path.join(root, 'claude-config'); resetMinnowHomeCache(); });
afterEach(async () => { await __resetAgentCliSessionMocksForTests(); for (const state of states) clearTimeout(state.evictTimer); states.length = 0; });
after(async () => { for (const [key, value] of [['MINNOW_HOME', previous.home], ['CLAUDE_CONFIG_DIR', previous.claude]]) {
  if (value == null) delete process.env[key]; else process.env[key] = value;
} resetMinnowHomeCache(); await fs.rm(root, { recursive: true, force: true }); });
function setup(nextKind = 'claude', extraEnv = {}) {
  kind = nextKind; processes = 0; invocations = [];
  __setAgentCliSessionMocksForTests({ prepareInvocation: async input => {
    processes++; invocations.push(input);
    const fixture = fileURLToPath(new URL(`../fixtures/fake-${kind === 'claude' ? 'claude-session' : 'cursor-acp'}.mjs`, import.meta.url));
    return { command: process.execPath, args: kind === 'claude' ? [fixture, input.resumeId || input.sessionId, input.resumeId ? 'resume' : 'new'] : [fixture],
      cwd: input.tempDir, keepStdinOpen: true, transport: kind === 'cursor' ? 'acp' : 'stream-json',
      selectedModel: kind === 'cursor' ? 'fixture' : undefined,
      stdin: `${JSON.stringify({ type: 'user', message: { role: 'user', content: input.prompt } })}\n`,
      env: { ...process.env, ...input.bridgeConfig.env, CURSOR_DATA_DIR: path.join(path.dirname(input.tempDir), 'cursor-data'), ...extraEnv } };
  } });
}

test('interactive send failure survives a clean process exit during cleanup and reaches the CLI view', async () => {
  kind = 'claude';
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.exitCode = null;
  let finish;
  const done = new Promise(resolve => { finish = resolve; });
  __setAgentCliSessionMocksForTests({
    prepareInvocation: async input => ({ transport: 'claude-interactive', stdin: JSON.stringify({ message: { content: input.prompt } }), env: {} }),
    openInteractive: async () => ({ child, done,
      send: async () => { throw new Error('Native startup needs setup.'); },
      stop: async () => { child.exitCode = 0; finish({ code: 0, stderr: '' }); },
    }),
  });
  const result = await generate('interactive-startup-failure', [{ role: 'user', content: 'Hello.' }], { settings: { interactive: true } });
  assert.equal(result.outcome.outcome, 'fatal');
  assert.equal(result.state.errorMessage, 'Native startup needs setup.');
  assert.match(getAgentCliOutput('interactive-startup-failure').output, /Native startup needs setup/);
  assert.equal(getAgentCliOutput('interactive-startup-failure').status, 'exited');
});

test('interactive handoffs retain concurrent tool calls while later native commit checks are pending', async () => {
  kind = 'claude';
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = null;
  let finish, secondStarted;
  const done = new Promise(resolve => { finish = resolve; });
  const second = new Promise(resolve => { secondStarted = resolve; });
  __setAgentCliSessionMocksForTests({
    prepareInvocation: async input => ({ transport: 'claude-interactive', keepStdinOpen: true,
      stdin: JSON.stringify({ message: { content: input.prompt } }), env: input.bridgeConfig.env }),
    openInteractive: async invocation => ({ child, done,
      async send() {
        const post = value => fetch(invocation.env.MINNOW_CLI_BRIDGE_URL, { method: 'POST',
          headers: { authorization: `Bearer ${invocation.env.MINNOW_CLI_BRIDGE_TOKEN}` },
          body: JSON.stringify({ name: 'ping', arguments: { value } }) }).catch(() => {});
        void post(1);
        await new Promise(resolve => setTimeout(resolve, 30));
        void post(2);
      },
      async beforeHandoff(call) {
        if (JSON.parse(call.function.arguments).value === 1) await second;
        else { secondStarted(); await new Promise(resolve => setTimeout(resolve, 450)); }
        return null;
      },
      stop: async () => { child.exitCode = 0; finish({ code: 0, stderr: '' }); },
    }),
  });
  const result = await generate('concurrent-interactive-handoff', [{ role: 'user', content: 'Two calls.' }], {
    settings: { interactive: true }, tools: [{ type: 'function', function: { name: 'ping', parameters: { type: 'object' } } }],
  });
  assert.equal(result.state.status, 'complete', result.state.errorMessage);
  const calls = result.rows.flatMap(row => row.choices?.[0]?.delta?.tool_calls ?? []);
  assert.deepEqual(calls.map(call => JSON.parse(call.function.arguments).value).sort(), [1, 2]);
  assert.equal((await readCliCheckpoint('fixture-claude-durable', 'concurrent-interactive-handoff')).clean, false);
});

test('a natively ended Claude conversation never silently rebuilds into a new session', async () => {
  setup('claude');
  const providerId = 'fixture-claude-durable', chatId = 'native-ended';
  await writeCliCheckpoint(cliCacheDir(providerId, chatId), { providerId, chatId, clean: false, nativeEnded: true });
  const result = await generate(chatId, [{ role: 'user', content: 'Continue.' }]);
  assert.equal(result.state.status, 'error');
  assert.match(result.state.errorMessage, /ended this conversation/);
  assert.equal(processes, 0);
  assert.equal((await readCliCheckpoint(providerId, chatId)).nativeEnded, true);
});
async function generate(chatId, messages, options = {}) {
  const providerId = `fixture-${kind}-durable`;
  const state = createGenerationState({ providerId, chatId, fallbackRole: 'default', body: {
    model: 'fixture', stream: true, messages, tools: options.tools ?? [], minnow_cli_turn_context: options.context } }); states.push(state);
  const run = pumpAgentCliSession({ state, runtime: { profile: { agentCli: { kind, maxConcurrent: 1, ...options.settings } }, secrets: options.secrets ?? {} },
    candidate: { providerId, modelId: 'fixture' }, index: 0, idleMs: 2000, maxMs: 5000, canFailover: options.canFailover ?? false });
  if (options.abort) setTimeout(() => cancel(state), 100);
  const outcome = await run;
  const rows = Buffer.concat(state.chunks).toString().split('\n\n').filter(row => row.startsWith('data: {')).map(row => JSON.parse(row.slice(6)));
  const text = rows.map(row => row.choices?.[0]?.delta?.content ?? '').join('');
  return { state, outcome, rows, text };
}
for (const provider of ['claude', 'cursor']) test(`${provider} sends incremental follow-ups, persists clean checkpoints and resumes after shutdown`, async () => {
  setup(provider);
  const chat = `${provider}-warm`, messages = [{ role: 'system', content: 'Stable rules.' }, { role: 'user', content: 'Start.' }];
  const first = await generate(chat, messages, { context: 'Current file: one.ts' });
  assert.equal(first.state.status, 'complete', first.state.errorMessage); assert.equal(first.text, 'Reply 1.');
  messages.push({ role: 'assistant', content: first.text }, { role: 'user', content: 'Next.' });
  const second = await generate(chat, messages, { context: 'Current file: two.ts' });
  assert.equal(second.state.status, 'complete', second.state.errorMessage); assert.equal(second.text, 'Reply 2.');
  assert.equal(processes, 1); assert.equal(getAgentCliOutput(chat).session.sessionState, 'idle');
  if (provider === 'claude') {
    assert.equal(second.rows.at(-1).usage.prompt_tokens, 11); assert.equal(second.rows.at(-1).usage.completion_tokens, 3);
    assert.ok(Math.abs(second.rows.at(-1).minnow_cli.cost_usd - .01) < .000001);
  }
  assert.equal((await readCliCheckpoint(`fixture-${kind}-durable`, chat)).clean, true);
  await disposeCliSessions();
  messages.push({ role: 'assistant', content: second.text }, { role: 'user', content: 'After restart.' });
  const third = await generate(chat, messages);
  assert.equal(third.state.status, 'complete', third.state.errorMessage); assert.equal(third.text, 'Reply 3.'); assert.equal(processes, 2);
  assert.equal(third.rows.at(-1).minnow_cli.continuation, 'resumed');
  assert.equal(invocations.at(-1).prompt.includes('Stable rules.'), false, 'resume must not replay the original transcript');
});
test('Claude waits for the complete streamed response before handing off an early tool call', async () => {
  setup('claude', { FAKE_CLAUDE_STREAM_AFTER_TOOL: '1' });
  const chat = 'streaming-handoff', messages = [{ role: 'user', content: 'TOOL' }];
  const options = { tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } }] };
  const first = await generate(chat, messages, options);
  assert.equal(first.state.status, 'complete', first.state.errorMessage);
  assert.equal(first.text, 'Still finishing the response.');
  assert.equal(first.rows.at(-1).usage.completion_tokens, 12000);
  assert.equal(first.rows.at(-1).usage.completion_tokens_details.reasoning_tokens, 5400);
  assert.equal(first.rows.at(-1).minnow_cli.rate_limit.utilization, .83);
  assert.ok(first.rows.some(row => row.choices.length === 0 && row.minnow_cli?.rate_limit?.window === 'five_hour'));
  assert.equal(getAgentCliOutput(chat).session.rateLimit.status, 'allowed_warning');
  assert.equal((await readCliCheckpoint('fixture-claude-durable', chat)).clean, true);
  const calls = first.rows.flatMap(row => row.choices?.[0]?.delta?.tool_calls ?? []);
  assert.equal(calls.length, 1);
  messages.push({ role: 'assistant', content: first.text, tool_calls: calls },
    { role: 'tool', tool_call_id: calls[0].id, content: 'Source read once.' });
  const second = await generate(chat, messages, options);
  assert.equal(second.state.status, 'complete', second.state.errorMessage);
  assert.equal(second.text, 'Used Source read once.');
  assert.equal(second.rows.at(-1).usage.completion_tokens, 3, 'prior response must not be counted twice');
  assert.equal(processes, 1);
});

test('unbound requests never share a conversation or write a durable chat binding', async () => {
  setup(); const messages = [{ role: 'user', content: 'Start.' }];
  const first = await generate(null, messages), second = await generate(null, messages);
  assert.equal(first.state.status, 'complete', first.state.errorMessage);
  assert.equal(second.state.status, 'complete', second.state.errorMessage);
  assert.equal(first.text, 'Reply 1.'); assert.equal(second.text, 'Reply 1.'); assert.equal(processes, 2);
  assert.equal(await readCliCheckpoint('fixture-claude-durable', null), null);
});

test('Claude budget starts a resumed process for each user turn', async () => {
  setup(); const messages = [{ role: 'user', content: 'Start.' }];
  const first = await generate('budget', messages, { settings: { maxBudgetUsd: 1 } });
  messages.push({ role: 'assistant', content: first.text }, { role: 'user', content: 'Next.' });
  const second = await generate('budget', messages, { settings: { maxBudgetUsd: 1 } });
  assert.equal(second.state.status, 'complete', second.state.errorMessage); assert.equal(processes, 2); assert.ok(invocations[1].resumeId);
});
test('modified live Claude native history rebuilds before the next inference', async () => {
  setup(); const chat = 'live-tampered', messages = [{ role: 'user', content: 'Start.' }];
  const first = await generate(chat, messages);
  const record = await readCliCheckpoint('fixture-claude-durable', chat);
  const nativeFile = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', invocations[0].tempDir.replace(/[^a-zA-Z0-9]/g, '-'), `${record.nativeId}.jsonl`);
  const native = await fs.readFile(nativeFile, 'utf8');
  await fs.writeFile(nativeFile, native.replace('Start.', 'Edited.'));
  messages.push({ role: 'assistant', content: first.text }, { role: 'user', content: 'Next.' });
  const second = await generate(chat, messages);
  assert.equal(second.state.status, 'complete', second.state.errorMessage);
  assert.equal(processes, 2); assert.equal(second.rows.at(-1).minnow_cli.continuation, 'rebuilt');
  assert.equal(invocations[1].resumeId, undefined);
});

test('modified Claude native snapshots rebuild before inference', async () => {
  setup(); const chat = 'tampered', messages = [{ role: 'user', content: 'Start.' }];
  const first = await generate(chat, messages); await disposeCliSessions();
  const record = await readCliCheckpoint('fixture-claude-durable', chat);
  await fs.appendFile(path.join(cliCacheDir('fixture-claude-durable', chat), `${record.nativeId}.jsonl`), 'tampered');
  messages.push({ role: 'assistant', content: first.text }, { role: 'user', content: 'Next.' });
  const second = await generate(chat, messages);
  assert.equal(second.state.status, 'complete', second.state.errorMessage); assert.equal(second.rows.at(-1).minnow_cli.continuation, 'rebuilt'); assert.equal(invocations[1].resumeId, undefined);
});
test('interrupted Claude checkpoints remain dirty and rebuild from saved history', async () => {
  setup(); const chat = 'interrupted', messages = [{ role: 'user', content: 'HANG' }];
  const first = await generate(chat, messages, { abort: true }); assert.equal(first.state.status, 'cancelled');
  assert.equal((await readCliCheckpoint('fixture-claude-durable', chat)).clean, false);
  const second = await generate(chat, [{ role: 'user', content: 'Recorded history, now continue.' }]);
  assert.equal(second.state.status, 'complete', second.state.errorMessage); assert.equal(invocations[1].resumeId, undefined);
});
test('deleting an already evicted chat removes its durable binding', async () => {
  setup(); await generate('deleted', [{ role: 'user', content: 'Start.' }]); await disposeCliSessions();
  await disposeCliSessions(row => row.chatId === 'deleted', { forget: true });
  assert.equal(await readCliCheckpoint('fixture-claude-durable', 'deleted'), null);
});
test('Cursor tool results return through the same native prompt, once', async () => {
  setup('cursor'); const chat = 'cursor-tools', messages = [{ role: 'user', content: 'TOOL' }];
  const tools = [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }];
  const first = await generate(chat, messages, { tools });
  assert.equal(first.state.status, 'complete', first.state.errorMessage);
  const calls = first.rows.flatMap(row => row.choices?.[0]?.delta?.tool_calls ?? []).map(({ index, ...call }) => call);
  assert.equal(calls.length, 1); assert.equal(getAgentCliOutput(chat).session.sessionState, 'awaiting-tools');
  messages.push({ role: 'assistant', content: '', tool_calls: calls }, { role: 'tool', tool_call_id: calls[0].id, content: 'Actual source' });
  const second = await generate(chat, messages, { tools });
  assert.equal(second.state.status, 'complete', second.state.errorMessage); assert.equal(second.text, 'Used Actual source'); assert.equal(processes, 1);
});
for (const text of ['NATIVE', 'BLOCKING']) test(`Cursor rejects ${text} without granting execution or hanging`, async () => {
  setup('cursor'); const result = await generate(`cursor-${text}`, [{ role: 'user', content: text }]);
  assert.equal(result.state.status, 'error'); assert.equal(processes, 1);
  assert.match(result.state.errorMessage, /native permission|blocking extension/);
  assert.equal(await fs.access(path.join(invocations[0].tempDir, 'forbidden')).then(() => true, () => false), false);
});

for (const failure of ['ACP_UNAVAILABLE', 'ACP_WRONG_MODEL']) test(`Cursor selects isolated replay before inference for ${failure}`, async () => {
  setup('cursor'); const log = path.join(root, `acp-preflight-${failure}.log`);
  __setAgentCliSessionMocksForTests({ prepareInvocation: async input => {
    processes++; invocations.push(input);
    const acp = processes === 1;
    return { command: process.execPath, args: [fileURLToPath(new URL(acp ? '../fixtures/fake-cursor-acp.mjs' : '../fixtures/fake-agent-cli.mjs', import.meta.url))],
      cwd: input.tempDir, keepStdinOpen: acp, transport: acp ? 'acp' : 'stream-json', stdin: input.prompt, selectedModel: 'fixture',
      env: { ...process.env, [failure]: '1', ACP_CALL_LOG: log, FAKE_AGENT_CLI_SCENARIO: 'cursor', ...input.bridgeConfig.env } };
  } });
  const result = await generate('cursor-fallback', [{ role: 'user', content: 'Continue.' }]);
  assert.equal(result.state.status, 'complete', result.state.errorMessage); assert.equal(processes, 2);
  assert.equal(result.rows.at(-1).minnow_cli.transport, 'replay');
  assert.match(getAgentCliOutput('cursor-fallback').session.reason, /ACP unavailable.*isolated replay/);
  assert.equal((await fs.readFile(log, 'utf8')).includes('session/prompt'), false);
});

test('a crash after Claude inference starts never switches transport or retries a provider', async () => {
  setup(); const result = await generate('crash', [{ role: 'user', content: 'CRASH' }], { canFailover: true });
  assert.equal(result.outcome.outcome, 'fatal'); assert.equal(processes, 1);
  assert.equal((await readCliCheckpoint('fixture-claude-durable', 'crash')).clean, false);
});

for (const change of ['instructions', 'tools', 'account', 'settings', 'history']) test(`Claude reconstructs after changed ${change}`, async () => {
  setup(); const chat = `change-${change}`, messages = [{ role: 'system', content: 'Rules.' }, { role: 'user', content: 'Start.' }];
  const first = await generate(chat, messages);
  messages.push({ role: 'assistant', content: first.text }, { role: 'user', content: 'Next.' });
  const options = {};
  if (change === 'instructions') messages[0].content = 'New rules.';
  if (change === 'history') messages[1].content = 'Edited start.';
  if (change === 'tools') options.tools = [{ type: 'function', function: { name: 'new_tool', parameters: { type: 'object' } } }];
  if (change === 'account') options.secrets = { cliToken: 'new-fixture-account' };
  if (change === 'settings') options.settings = { contextWindowTokens: 400000 };
  const second = await generate(chat, messages, options);
  assert.equal(second.state.status, 'complete', second.state.errorMessage); assert.equal(processes, 2);
  assert.equal(second.rows.at(-1).minnow_cli.continuation, 'rebuilt'); assert.equal(invocations[1].resumeId, undefined);
});

test('Claude receives screenshot pixels through the pending tool result without replaying history', async () => {
  const log = path.join(root, 'claude-image-results.log'); setup('claude', { FAKE_CLAUDE_RESULT_LOG: log });
  const chat = 'claude-images', messages = [{ role: 'user', content: 'TOOL' }];
  const options = { tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } }] };
  const first = await generate(chat, messages, options);
  const calls = first.rows.flatMap(row => row.choices?.[0]?.delta?.tool_calls ?? []).map(({ index, ...call }) => call);
  const dataUrl = 'data:image/png;base64,aW1hZ2U=';
  messages.push({ role: 'assistant', content: '', tool_calls: calls },
    { role: 'tool', tool_call_id: calls[0].id, content: 'Screenshot saved.' },
    toolImageFollowUpFromAttachments([{ type: 'image', dataUrl }]));
  const second = await generate(chat, messages, options);
  assert.equal(second.state.status, 'complete', second.state.errorMessage);
  assert.equal(processes, 1, 'a screenshot must not restart Claude and invalidate its prompt cache');
  assert.equal(second.rows.at(-1).minnow_cli.continuation, 'reused');
  assert.equal(second.text, 'Used Screenshot saved.');
  assert.deepEqual(JSON.parse((await fs.readFile(log, 'utf8')).trim()).content,
    [{ type: 'text', text: 'Screenshot saved.' }, { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' }]);
  messages.push({ role: 'assistant', content: second.text }, { role: 'user', content: 'Next.' });
  const third = await generate(chat, messages, options);
  assert.equal(third.state.status, 'complete', third.state.errorMessage);
  assert.equal(processes, 1, 'the caller-owned screenshot row remains part of the continuation prefix');
});

for (const restart of [false, true]) test(`Claude tool handoff executes once${restart ? ' through interrupted native recovery' : ' and resumes after a completed turn'}`, async () => {
  const log = path.join(root, `claude-tool-${restart}.log`); setup('claude', { FAKE_CLAUDE_TOOL_LOG: log });
  const chat = `claude-tool-${restart}`, messages = [{ role: 'user', content: 'TOOL' }];
  const options = { tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } }], settings: { maxBudgetUsd: 1 } };
  const first = await generate(chat, messages, options);
  const calls = first.rows.flatMap(row => row.choices?.[0]?.delta?.tool_calls ?? []).map(({ index, ...call }) => call);
  assert.equal(calls.length, 1);
  messages.push({ role: 'assistant', content: '', tool_calls: calls }, { role: 'tool', tool_call_id: calls[0].id, content: 'Actual source' });
  if (restart) await disposeCliSessions();
  const second = await generate(chat, messages, options);
  assert.equal(second.state.status, 'complete', second.state.errorMessage);
  assert.equal((await fs.readFile(log, 'utf8')).trim(), 'read_file', 'recorded tools must never execute twice');
  if (!restart) {
    assert.equal(second.text, 'Used Actual source'); assert.equal(processes, 1, 'budget covers every tool continuation in one process');
    assert.equal(second.rows.at(-1).minnow_cli.cost_usd, undefined);
    assert.equal(second.rows.at(-1).minnow_cli.native_turn_cost_usd, .02);
  } else {
    assert.equal(second.rows.at(-1).minnow_cli.continuation, 'resumed'); assert.ok(invocations.at(-1).prompt.includes('Actual source'));
    assert.ok(invocations.at(-1).resumeId);
  }
  messages.push({ role: 'assistant', content: second.text }, { role: 'user', content: 'Next.' });
  await disposeCliSessions(); const third = await generate(chat, messages, options);
  assert.equal(third.state.status, 'complete', third.state.errorMessage); assert.equal(third.rows.at(-1).minnow_cli.continuation, 'resumed');
  assert.equal(third.rows.at(-1).minnow_cli.cost_usd, .01);
});

test('Claude preserves a verified handoff when inference is interrupted after tool execution', async () => {
  const log = path.join(root, 'interrupted-tool.log');
  setup('claude', { FAKE_CLAUDE_TOOL_LOG: log, FAKE_CLAUDE_HANG_AFTER_TOOL: '1' });
  const messages = [{ role: 'user', content: 'TOOL with expensive original context' }];
  const options = { tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } }] };
  const first = await generate('mid-tool-crash', messages, options);
  const calls = first.rows.flatMap(row => row.choices?.[0]?.delta?.tool_calls ?? []).map(({ index, ...call }) => call);
  messages.push({ role: 'assistant', content: '', tool_calls: calls }, { role: 'tool', tool_call_id: calls[0].id, content: 'Recorded result' });
  const second = await generate('mid-tool-crash', messages, { ...options, abort: true });
  assert.equal(second.state.status, 'cancelled');
  await disposeCliSessions();
  const saved = await readCliCheckpoint('fixture-claude-durable', 'mid-tool-crash');
  assert.equal(saved.clean, false);
  assert.deepEqual(saved.recovery.pendingCalls, [calls[0].id]);
  const third = await generate('mid-tool-crash', messages, options);
  assert.equal(third.state.status, 'complete', third.state.errorMessage);
  assert.equal(third.rows.at(-1).minnow_cli.continuation, 'resumed');
  assert.equal(third.rows.at(-1).minnow_cli.model, 'resolved-claude-model');
  assert.ok(invocations.at(-1).prompt.includes('Recorded result'));
  assert.equal(invocations.at(-1).prompt.includes('expensive original context'), false);
  assert.equal((await fs.readFile(log, 'utf8')).trim(), 'read_file');
});

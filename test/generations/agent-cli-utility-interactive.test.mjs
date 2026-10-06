import assert from 'node:assert/strict';
import { test, before, after, afterEach } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import { createGenerationState, cancel } from '../../server/generations/store.js';
import { pumpAgentCliUpstream } from '../../server/generations/agent-cli/pump.js';
import { __setAgentCliSessionMocksForTests, __resetAgentCliSessionMocksForTests } from '../../server/generations/agent-cli/session.js';

const previous = Object.fromEntries(['MINNOW_HOME', 'CLAUDE_CONFIG_DIR', 'MINNOW_CLAUDE_LEGACY_PRINT', 'MINNOW_AGENT_CLI_REPLAY'].map(key => [key, process.env[key]]));
const states = [];
let home, invocations, runs;
before(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-utility-interactive-'));
  process.env.MINNOW_HOME = home;
  process.env.CLAUDE_CONFIG_DIR = path.join(home, 'claude');
  delete process.env.MINNOW_CLAUDE_LEGACY_PRINT;
  delete process.env.MINNOW_AGENT_CLI_REPLAY;
  resetMinnowHomeCache();
});
afterEach(async () => {
  await __resetAgentCliSessionMocksForTests();
  for (const state of states) clearTimeout(state.evictTimer);
  states.length = 0;
});
after(async () => {
  for (const [key, value] of Object.entries(previous)) {
    if (value == null) delete process.env[key]; else process.env[key] = value;
  }
  resetMinnowHomeCache();
  await fs.rm(home, { recursive: true, force: true });
});

function setup(mode = 'reply') {
  invocations = []; runs = [];
  __setAgentCliSessionMocksForTests({
    prepareInvocation: async input => {
      invocations.push(input);
      assert.equal(input.interactive, true);
      assert.match(input.sessionId, /^[a-f0-9-]{36}$/);
      assert.equal(input.resumeId, undefined);
      return { transport: 'claude-interactive', keepStdinOpen: true, cwd: input.tempDir,
        env: input.bridgeConfig.env, stdin: JSON.stringify({ message: { content: input.prompt } }) };
    },
    spawn: () => { throw new Error('Unexpected print transport'); },
    openInteractive: async (invocation, { nativeId, configRoot, signal }) => {
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = null;
      let finish;
      const done = new Promise(resolve => { finish = resolve; });
      const nativeSource = path.join(configRoot, 'projects', invocation.cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${nativeId}.jsonl`);
      await fs.mkdir(path.dirname(nativeSource), { recursive: true });
      await fs.writeFile(nativeSource, 'owned native transcript');
      const run = { child, done, nativeSource, stopped: false,
        async send() {
          if (mode === 'failure') throw new Error('Utility startup failed');
          if (mode === 'cancel') { cancel(states.at(-1)); return; }
          if (mode === 'hang') return;
          if (mode === 'tool') {
            void fetch(invocation.env.MINNOW_CLI_BRIDGE_URL, { method: 'POST',
              headers: { authorization: `Bearer ${invocation.env.MINNOW_CLI_BRIDGE_TOKEN}` },
              body: JSON.stringify({ name: 'ping', arguments: {} }) }).catch(() => {});
            return;
          }
          // Hold both concurrent requests open long enough to expose accidental reuse.
          await new Promise(resolve => setTimeout(resolve, 20));
          assert.equal(signal.aborted, false);
          for (const event of [
            { type: 'assistant', message: { id: nativeId, content: [{ type: 'text', text: 'Helper answer' }],
              usage: { input_tokens: 5, cache_read_input_tokens: 7, cache_creation_input_tokens: 3, output_tokens: 2 } } },
            { type: 'result', subtype: 'success', result: 'Helper answer' },
          ]) child.stdout.write(JSON.stringify(event) + '\n');
        },
        beforeHandoff: async () => true,
        async stop() { run.stopped = true; child.exitCode = 0; finish({ code: 0, stderr: '' }); },
      };
      runs.push(run);
      return run;
    },
  });
}
async function generate(role, options = {}) {
  const providerId = 'fixture-claude-utility';
  const state = createGenerationState({ providerId, fallbackRole: role, persist: false, body: {
    model: 'fixture', stream: options.stream ?? false, messages: [{ role: 'user', content: options.prompt ?? role }],
    ...(options.tools ? { tools: options.tools } : {}),
  } });
  states.push(state);
  const outcome = await pumpAgentCliUpstream({ state,
    runtime: { profile: { agentCli: { kind: 'claude', interactive: true, allowUtilityRoles: options.allowed ?? true, maxConcurrent: 2 } }, secrets: {} },
    candidate: { providerId, modelId: 'fixture' }, index: 0, idleMs: options.idleMs ?? 1000, maxMs: 5000, canFailover: false });
  return { state, outcome, wire: Buffer.concat(state.chunks).toString() };
}
async function assertClean() {
  for (const run of runs) {
    assert.equal(run.stopped, true);
    await assert.rejects(fs.access(run.nativeSource), { code: 'ENOENT' });
  }
  for (const input of invocations) await assert.rejects(fs.access(input.tempDir), { code: 'ENOENT' });
  assert.deepEqual(await fs.readdir(path.join(home, 'cli-sessions')).catch(error => { if (error.code === 'ENOENT') return []; throw error; }), []);
}

for (const role of ['utility', 'chat-titles', 'goal-eval', 'editor-completion', 'context-summarize', 'memory-synthesis', 'brain-synthesis']) {
  test(`${role} uses isolated interactive Claude with complete response and usage`, async () => {
    setup();
    const result = await generate(role);
    assert.equal(result.state.chatId, null);
    assert.equal(result.state.status, 'complete', result.state.errorMessage);
    const response = JSON.parse(result.wire);
    assert.equal(response.choices[0].message.content, 'Helper answer');
    assert.equal(response.minnow_cli.transport, 'claude-interactive');
    assert.equal(response.usage.prompt_tokens, 15);
    assert.equal(response.usage.completion_tokens, 2);
    await assertClean();
  });
}
test('concurrent helpers have separate native IDs, directories, prompts and streamed responses', async () => {
  setup();
  const results = await Promise.all([generate('utility', { stream: true, prompt: 'First helper' }), generate('chat-titles', { stream: true, prompt: 'Second helper' })]);
  assert.equal(invocations.length, 2);
  assert.notEqual(invocations[0].sessionId, invocations[1].sessionId);
  assert.notEqual(invocations[0].tempDir, invocations[1].tempDir);
  assert.notEqual(invocations[0].prompt, invocations[1].prompt);
  for (const result of results) {
    assert.equal(result.state.status, 'complete', result.state.errorMessage);
    assert.match(result.wire, /Helper answer/);
    assert.ok(result.wire.endsWith('data: [DONE]\n\n'));
  }
  await assertClean();
});
test('helper opt-in remains required before starting Claude', async () => {
  setup();
  const result = await generate('utility', { allowed: false });
  assert.equal(result.outcome.outcome, 'retry');
  assert.match(result.outcome.message, /Background use of this CLI is off/);
  assert.equal(invocations.length, 0);
});
for (const mode of ['failure', 'cancel', 'hang']) test(`utility ${mode} closes the interactive process and removes private files`, async () => {
  setup(mode);
  const result = await generate('utility', { idleMs: 100 });
  assert.equal(result.state.status, mode === 'cancel' ? 'cancelled' : 'error');
  if (mode === 'failure') assert.equal(result.state.errorMessage, 'Utility startup failed');
  await assertClean();
});
test('unbound tool handoffs return the call without retaining an unreachable session', async () => {
  setup('tool');
  const result = await generate('utility', { tools: [{ type: 'function', function: { name: 'ping', parameters: { type: 'object' } } }] });
  assert.equal(result.state.status, 'complete', result.state.errorMessage);
  const response = JSON.parse(result.wire);
  assert.equal(response.choices[0].finish_reason, 'tool_calls');
  assert.equal(response.choices[0].message.tool_calls[0].function.name, 'ping');
  await assertClean();
});

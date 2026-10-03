import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createFakeCodexResponses } from '../fixtures/codex-app-server-responses.mjs';
import { resolveAgentCliBin, applyAgentCliCaptureEnv } from '../../server/generations/agent-cli/resolve-bin.js';
import { __setCodexInvocationForTests, shutdownCodexSessions } from '../../server/generations/codex-app-server/manager.js';
import { pumpCodexAppServer } from '../../server/generations/codex-app-server/pump.js';
import { createGenerationState } from '../../server/generations/store.js';
import { resetMinnowHomeCache } from '../../server/config/home.js';

test('real installed app-server drives Minnow streams, serial tool rounds and warm turns without replay', {
  skip: process.env.MINNOW_CODEX_APP_SERVER_SMOKE !== '1', timeout: 60_000,
}, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-codex-live-'));
  const endpoint = await createFakeCodexResponses();
  const oldHome = process.env.MINNOW_HOME, oldCodexHome = process.env.CODEX_HOME;
  const states = [];
  let processes = 0;
  process.env.MINNOW_HOME = root; process.env.CODEX_HOME = root; resetMinnowHomeCache();
  try {
    const bin = await resolveAgentCliBin({ kind: 'codex' });
    __setCodexInvocationForTests(async session => {
      processes++;
      const configPath = path.join(session.home, 'config.toml');
      const original = await fs.readFile(configPath, 'utf8');
      await fs.writeFile(configPath, `model_provider = "fixture"\n${original}\nenable_request_compression = false\n[model_providers.fixture]\nname = "Fixture"\nbase_url = ${JSON.stringify(endpoint.baseUrl)}\nwire_api = "responses"\nrequires_openai_auth = false\n`);
      const env = {};
      for (const key of ['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP', 'APPDATA', 'LOCALAPPDATA']) if (process.env[key]) env[key] = process.env[key];
      Object.assign(env, { CODEX_HOME: session.home, HOME: session.home, USERPROFILE: session.home });
      return { ...bin, cwd: session.home, env: applyAgentCliCaptureEnv(env, bin.command) };
    });
    const messages = [{ role: 'system', content: 'Minnow controls tools.' }, { role: 'user', content: 'Read files.' }];
    const tools = [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object', properties: {} } } }];
    async function round(script) {
      if (script) endpoint.scripts.push(script);
      const state = createGenerationState({ providerId: 'codex-cli', chatId: 'live-app-server', fallbackRole: 'default',
        body: { model: 'fixture-model', stream: true, messages, tools } }); states.push(state);
      const outcome = await pumpCodexAppServer({ state, runtime: { profile: { agentCli: { kind: 'codex' } }, secrets: {} },
        candidate: { providerId: 'codex-cli', modelId: 'fixture-model' }, index: 0, idleMs: 5000, maxMs: 15_000, canFailover: false });
      assert.equal(outcome.outcome, 'complete', state.errorMessage);
      const rows = Buffer.concat(state.chunks).toString().split('\n\n').filter(row => row.startsWith('data: {')).map(row => JSON.parse(row.slice(6)));
      const content = rows.map(row => row.choices?.[0]?.delta?.content ?? '').join('');
      const calls = rows.flatMap(row => row.choices?.[0]?.delta?.tool_calls ?? []).map(({ index, ...call }) => call);
      messages.push({ role: 'assistant', content, ...(calls.length ? { tool_calls: calls } : {}) });
      for (const call of calls) messages.push({ role: 'tool', tool_call_id: call.id, content: `Recorded ${call.id}` });
      return { rows, calls, content };
    }
    endpoint.scripts.push({ calls: [{ id: 'first', name: 'mn_tool_0' }, { id: 'second', name: 'mn_tool_0' }] }, { text: 'Done.', deltas: ['Do', 'ne.'] });
    assert.equal((await round()).calls.length, 1);
    assert.equal((await round()).calls.length, 1);
    assert.equal((await round()).content, 'Done.');
    const forwarding = [];
    for (let i = 0; i < 10; i++) {
      messages.push({ role: 'user', content: `Follow-up ${i}` });
      const result = await round({ text: 'Warm.', deltas: ['Wa', 'rm.'] });
      assert.equal(result.content, 'Warm.');
      forwarding.push(result.rows.at(-1).minnow_cli.timings.forwarding_max_ms);
    }
    assert.equal(processes, 1);
    assert.equal(endpoint.requests.length, 12);
    assert.ok(endpoint.requests.every(row => row.tools.every(tool => tool.name === 'mn_tool_0')));
    assert.ok(Math.max(...forwarding) < 50, `Forwarding exceeded 50 ms: ${forwarding}`);
    assert.equal(states.length, 13);
    const billed = () => states.reduce((sum, state) => sum + Buffer.concat(state.chunks).toString().split('\n\n')
      .filter(row => row.startsWith('data: {')).map(row => JSON.parse(row.slice(6)))
      .reduce((roundSum, row) => roundSum + (row.usage?.total_tokens ?? 0), 0), 0);
    assert.equal(billed(), endpoint.requests.length * 25, 'Each native request is billed exactly once across tool rounds');
    await shutdownCodexSessions();
    messages.push({ role: 'user', content: 'After restart.' });
    const restored = await round({ text: 'Resumed.' });
    assert.equal(restored.content, 'Resumed.');
    assert.equal(restored.rows.at(-1).minnow_cli.continuation, 'resumed');
    assert.equal(restored.rows.at(-1).usage.total_tokens, 25);
    assert.equal(processes, 2);
    // Losing a native binding after execution must seed the recorded result,
    // including when there is no new user input to submit.
    endpoint.scripts.push({ calls: [{ id: 'rebuild', name: 'mn_tool_0' }] });
    messages.push({ role: 'user', content: 'Read once more.' });
    assert.equal((await round()).calls.length, 1);
    await shutdownCodexSessions();
    assert.equal((await round({ text: 'Recovered from the recorded result.' })).content, 'Recovered from the recorded result.');
    assert.equal(processes, 3);
    const seeded = endpoint.requests.at(-1).input;
    assert.ok(seeded.some(item => item.type === 'function_call_output' && item.output.includes('Recorded')));
    // This abandoned handoff was killed before the native CLI reported its
    // usage. The replacement must never invent that missing count.
    assert.equal(billed(), (endpoint.requests.length - 1) * 25);
  } finally {
    await shutdownCodexSessions(); __setCodexInvocationForTests();
    for (const state of states) clearTimeout(state.evictTimer);
    await endpoint.close();
    if (oldHome == null) delete process.env.MINNOW_HOME; else process.env.MINNOW_HOME = oldHome;
    if (oldCodexHome == null) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldCodexHome;
    resetMinnowHomeCache(); await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
  }
});

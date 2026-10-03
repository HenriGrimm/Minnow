import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { fetchCodexModelCatalog } from '../server/models/codex-cli-catalog.js';
import { createFakeCodexResponses } from '../test/fixtures/codex-app-server-responses.mjs';
import { resolveAgentCliBin, applyAgentCliCaptureEnv } from '../server/generations/agent-cli/resolve-bin.js';
import { __setCodexInvocationForTests, shutdownCodexSessions } from '../server/generations/codex-app-server/manager.js';
import { pumpCodexAppServer } from '../server/generations/codex-app-server/pump.js';
import { createGenerationState } from '../server/generations/store.js';
import { resetMinnowHomeCache } from '../server/config/home.js';

/** Default inference stays on loopback. --account tests actual access with a
 * tiny read-only nonce tool; no workspace content is submitted. */
export async function runCodexModelToolSmoke({ account = false, models } = {}) {
  const catalog = models ?? await fetchCodexModelCatalog();
  assert.ok(catalog.length, 'The installed CLI must advertise models.');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-model-tools-'));
  const endpoint = account ? null : await createFakeCodexResponses();
  const previous = process.env.MINNOW_HOME;
  const states = [], results = [];
  process.env.MINNOW_HOME = root;
  resetMinnowHomeCache();
  try {
    if (endpoint) {
      const bin = await resolveAgentCliBin({ kind: 'codex' });
      __setCodexInvocationForTests(async session => {
        await fs.appendFile(path.join(session.home, 'config.toml'), `\n[model_providers.fixture]\nname = "Fixture"\nbase_url = ${JSON.stringify(endpoint.baseUrl)}\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\n`);
        const env = {};
        for (const key of ['PATH', 'Path', 'SystemRoot', 'COMSPEC', 'TEMP', 'TMP', 'APPDATA', 'LOCALAPPDATA']) {
          if (process.env[key]) env[key] = process.env[key];
        }
        Object.assign(env, { CODEX_HOME: session.home, HOME: session.home, USERPROFILE: session.home });
        return { ...bin, args: ['app-server', '--listen', 'stdio://', '-c', 'model_provider="fixture"'],
          cwd: session.home, env: applyAgentCliCaptureEnv(env, bin.command) };
      });
    }
    for (const model of catalog) {
      const id = model.slug;
      const messages = [{ role: 'system', content: 'Use the supplied Minnow lookup_nonce tool to answer. It returns a nonce you cannot know in advance. Call it once with label "probe", then answer with only its returned nonce.' },
        { role: 'user', content: 'Look up the probe nonce using the supplied tool and return it.' }];
      const tools = [{ type: 'function', function: { name: 'lookup_nonce', description: 'Returns a test nonce for the supplied label. This read-only test tool has no side effects.',
        parameters: { type: 'object', properties: { label: { type: 'string' } }, required: ['label'], additionalProperties: false } } }];
      const nonce = randomUUID();
      const chatId = `model-probe-${id}`;
      const startedAt = performance.now();
      let handoffs = 0;
      try {
        if (endpoint) {
          endpoint.scripts.length = 0;
          endpoint.scripts.push({ calls: [model.tool_mode === 'code_mode_only'
            ? { id: 'probe', name: 'exec', namespace: 'functions', code: 'text(await tools.mn_tool_0({ label: "probe" }));' }
            : { id: 'probe', name: 'mn_tool_0', args: { label: 'probe' } }] }, { text: nonce });
        }
        async function round() {
          const state = createGenerationState({ providerId: 'codex-cli', chatId, body: { model: id, stream: true, messages, tools,
            reasoning_effort: 'low' } });
          states.push(state);
          await pumpCodexAppServer({ state, runtime: { profile: { agentCli: { kind: 'codex' } }, secrets: {} },
            candidate: { providerId: 'codex-cli', modelId: id }, index: 0, idleMs: account ? 60_000 : 5000,
            maxMs: account ? 120_000 : 15_000, canFailover: false });
          assert.equal(state.status, 'complete', state.errorMessage);
          const rows = Buffer.concat(state.chunks).toString().split('\n\n').filter(row => row.startsWith('data: {')).map(row => JSON.parse(row.slice(6)));
          const content = rows.map(row => row.choices?.[0]?.delta?.content ?? '').join('');
          const calls = rows.flatMap(row => row.choices?.[0]?.delta?.tool_calls ?? []).map(({ index, ...call }) => call);
          messages.push({ role: 'assistant', content, ...(calls.length ? { tool_calls: calls } : {}) });
          for (const call of calls) {
            assert.equal(call.function.name, 'lookup_nonce');
            assert.deepEqual(JSON.parse(call.function.arguments), { label: 'probe' });
            handoffs++;
            messages.push({ role: 'tool', tool_call_id: call.id, content: nonce });
          }
          return { calls, content, metadata: rows.at(-1)?.minnow_cli };
        }
        const first = await round();
        assert.equal(first.calls.length, 1, 'The model must actually call the tool.');
        if (endpoint) {
          const request = endpoint.requests.at(-1);
          const wireTools = [...(request.tools ?? []), ...request.input.filter(item => item.type === 'additional_tools').flatMap(item => item.tools)];
          const toolNames = wireTools.flatMap(tool => tool.type === 'namespace' ? tool.tools.map(nested => `${tool.name}.${nested.name}`) : [tool.name]);
          assert.ok(toolNames.every(name => ['mn_tool_0', 'exec', 'wait', 'functions.exec', 'functions.wait', 'functions.request_user_input_async'].includes(name)),
            `Unexpected native tools for ${id}: ${toolNames}`);
          if (model.tool_mode === 'code_mode_only') assert.ok(JSON.stringify(wireTools).includes('mn_tool_0'), 'Code mode must expose the Minnow tool.');
          else assert.ok(toolNames.includes('mn_tool_0'));
        }
        const second = await round();
        assert.equal(second.calls.length, 0);
        assert.ok(second.content.includes(nonce), 'The answer must contain the real tool result.');
        assert.equal(second.metadata.continuation, 'reused');
        assert.equal(handoffs, 1, 'The tool must execute exactly once.');
        if (endpoint) assert.ok(JSON.stringify(endpoint.requests.at(-1).input).includes(nonce), 'Tool results must reach the model.');
        results.push({ model: id, status: 'passed', toolMode: model.tool_mode ?? 'direct', elapsedMs: Math.round(performance.now() - startedAt) });
      } catch (error) {
        results.push({ model: id, status: 'failed', message: error.message, elapsedMs: Math.round(performance.now() - startedAt) });
      } finally {
        await shutdownCodexSessions();
      }
      console.log(JSON.stringify(results.at(-1)));
    }
    return results;
  } finally {
    await shutdownCodexSessions(); __setCodexInvocationForTests(); await endpoint?.close();
    for (const state of states) clearTimeout(state.evictTimer);
    if (previous === undefined) delete process.env.MINNOW_HOME; else process.env.MINNOW_HOME = previous;
    resetMinnowHomeCache();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const results = await runCodexModelToolSmoke({ account: process.argv.includes('--account') });
  if (results.some(row => row.status === 'failed')) process.exitCode = 1;
}

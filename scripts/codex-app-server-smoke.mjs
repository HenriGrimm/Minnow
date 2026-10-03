import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveAgentCliBin, applyAgentCliCaptureEnv } from '../server/generations/agent-cli/resolve-bin.js';
import { createCodexRpc } from '../server/generations/codex-app-server/rpc.js';
import { createFakeCodexResponses } from '../test/fixtures/codex-app-server-responses.mjs';

export async function runCodexAppServerSmoke({ compactThreshold } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-codex-smoke-'));
  const endpoint = await createFakeCodexResponses();
  let rpc;
  const events = [];
  const calls = [];
  try {
    const config = [
      'cli_auth_credentials_store = "file"', 'model = "fixture-model"', 'model_provider = "fixture"',
      'approval_policy = "never"', 'sandbox_mode = "read-only"', 'web_search = "disabled"',
      'model_reasoning_summary = "auto"',
      ...(compactThreshold == null ? [] : [`model_auto_compact_token_limit = ${compactThreshold}`]),
      '[tools]', 'experimental_request_user_input = { enabled = false }',
      '[model_providers.fixture]', 'name = "Loopback fixture"', `base_url = ${JSON.stringify(endpoint.baseUrl)}`,
      'wire_api = "responses"', 'requires_openai_auth = false',
      '[features]',
      ...['shell_tool', 'unified_exec', 'hooks', 'memories', 'multi_agent', 'skill_mcp_dependency_install',
        'apps', 'browser_use', 'browser_use_external', 'browser_use_full_cdp_access', 'computer_use',
        'image_generation', 'in_app_browser', 'in_app_local_automation', 'request_permissions_tool',
        'default_mode_request_user_input', 'sleep_tool', 'view_image', 'workspace_dependencies',
        'plugins', 'plugin_sharing', 'tool_suggest', 'skill_search', 'goals', 'enable_request_compression']
        .map(name => `${name} = false`),
    ].join('\n');
    await fs.writeFile(path.join(root, 'config.toml'), config, { mode: 0o600 });
    const env = {};
    for (const key of ['PATH', 'Path', 'SystemRoot', 'COMSPEC', 'TEMP', 'TMP', 'APPDATA', 'LOCALAPPDATA']) {
      if (process.env[key]) env[key] = process.env[key];
    }
    // Avoid host auth, instructions, and home-directory skill discovery.
    Object.assign(env, { CODEX_HOME: root, HOME: root, USERPROFILE: root });
    const bin = await resolveAgentCliBin({ kind: 'codex' });
    rpc = createCodexRpc({ ...bin, cwd: root, env: applyAgentCliCaptureEnv(env, bin.command) }, {
      onRequest: row => { calls.push(row); },
    });
    rpc.subscribe(row => events.push({ ...row, receivedAt: performance.now() }));
    const initialized = await rpc.initialize({ experimentalApi: true });
    const started = await rpc.request('thread/start', { model: 'fixture-model', modelProvider: 'fixture',
      cwd: root, ephemeral: true, sandbox: 'read-only', approvalPolicy: 'never', environments: [],
      baseInstructions: 'Follow Minnow instructions. Use only supplied dynamic tools.',
      developerInstructions: 'Smoke fixture instructions.',
      dynamicTools: [{ type: 'function', name: 'minnow_lookup', description: 'Fixture lookup',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false } }],
    });
    const threadId = started.thread.id;
    async function waitFor(predicate, timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs;
      while (!predicate()) {
        if (Date.now() >= deadline) throw new Error(`Smoke fixture timed out: ${JSON.stringify({ calls, recentEvents: events.slice(-6), modelRequests: endpoint.requests.length })}`);
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
    async function turn(text, script) {
      endpoint.scripts.push(script);
      const result = await rpc.request('turn/start', { threadId, input: [{ type: 'text', text }] });
      await waitFor(() => events.some(row => row.method === 'turn/completed' && row.params.turn.id === result.turn.id));
      const completed = events.find(row => row.method === 'turn/completed' && row.params.turn.id === result.turn.id);
      assert.equal(completed.params.turn.status, 'completed');
      return result.turn.id;
    }
    await rpc.request('thread/inject_items', { threadId, items: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Historical user.' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Historical answer.' }] },
      { type: 'function_call', name: 'minnow_lookup', call_id: 'historical-call', arguments: '{}' },
      { type: 'function_call_output', call_id: 'historical-call', output: 'Recorded historical tool result.' },
    ] });
    await turn('First input.', { text: 'First reply.', deltas: ['First ', 'reply.'] });
    await turn('Second input.', { text: 'Second reply.' });
    const catalog = endpoint.requests[0].tools;
    const evidence = { userAgent: initialized.userAgent, processCount: 1, threadId,
      modelRequests: endpoint.requests.length, wireTools: catalog.map(tool => ({ type: tool.type, name: tool.name })),
      seededHistory: JSON.stringify(endpoint.requests[0].input).includes('Historical answer.'),
      seededToolResult: JSON.stringify(endpoint.requests[0].input).includes('Recorded historical tool result.'),
      secondTurnHistory: JSON.stringify(endpoint.requests[1].input).includes('First reply.'),
      incrementalDeltas: events.filter(row => row.method === 'item/agentMessage/delta').map(row => row.params.delta) };
    if (compactThreshold != null) {
      evidence.nativeCompactions = events.filter(row => row.method === 'item/completed'
        && row.params.item.type === 'contextCompaction').length;
      evidence.postCompactionContainsRecordedToolResult = JSON.stringify(endpoint.requests.at(-1).input).includes('Recorded historical tool result.');
      assert.ok(evidence.nativeCompactions > 0, 'Forced compaction must be exercised');
      assert.equal(evidence.postCompactionContainsRecordedToolResult, false, 'Native compaction changes Minnow accepted history');
      console.log(JSON.stringify(evidence, null, 2));
      return evidence;
    }
    // Capture evidence before asserting the release gate, so failures explain
    // why generation must remain gated on this installed CLI.
    assert.equal(evidence.seededHistory, true);
    assert.equal(evidence.seededToolResult, true);
    assert.equal(evidence.secondTurnHistory, true);
    assert.deepEqual(evidence.incrementalDeltas, ['First ', 'reply.', 'Second reply.']);
    assert.deepEqual(catalog.map(tool => tool.name), ['minnow_lookup'], 'Wire catalog must contain only Minnow tools');
    endpoint.scripts.push({ calls: [{ id: 'parallel-1', name: 'minnow_lookup' }, { id: 'parallel-2', name: 'minnow_lookup' }] });
    endpoint.scripts.push({ text: 'Tool reply.' });
    const result = await rpc.request('turn/start', { threadId, input: [{ type: 'text', text: 'Use tools.' }] });
    await waitFor(() => calls.length === 1);
    await new Promise(resolve => setTimeout(resolve, 250));
    evidence.parallelCallsBeforeFirstResult = calls.length;
    await rpc.respond(calls[0].id, { contentItems: [{ type: 'inputText', text: 'Real Minnow result 1.' }], success: true });
    await waitFor(() => calls.length === 2);
    await rpc.respond(calls[1].id, { contentItems: [{ type: 'inputText', text: 'Real Minnow result 2.' }], success: true });
    await waitFor(() => events.some(row => row.method === 'turn/completed' && row.params.turn.id === result.turn.id));
    evidence.dynamicCalls = calls.map(row => ({ method: row.method, params: row.params }));
    assert.ok(calls.every(row => row.method === 'item/tool/call' && row.params.threadId === threadId
      && row.params.turnId === result.turn.id));
    assert.notEqual(calls[0].id, calls[1].id);
    assert.ok(JSON.stringify(endpoint.requests.at(-1).input).includes('Real Minnow result 2.'));
    for (let i = 0; i < 10; i++) await turn(`Follow-up ${i}.`, { text: `Reply ${i}.` });
    evidence.followupTurns = 10;
    evidence.nativeCompactions = events.filter(row => row.method === 'item/completed'
      && row.params.item.type === 'contextCompaction').length;
    // Supported outputSchema must reach the model wire. This endpoint validates
    // transport, not the model's ability to obey a schema or tool instruction.
    endpoint.scripts.push({ text: '{"ok":true}' });
    const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };
    const structured = await rpc.request('turn/start', { threadId, input: [{ type: 'text', text: 'Return JSON.' }], outputSchema: schema });
    await waitFor(() => events.some(row => row.method === 'turn/completed' && row.params.turn.id === structured.turn.id));
    evidence.structuredOutput = endpoint.requests.at(-1).text?.format;
    assert.deepEqual(evidence.structuredOutput.schema, schema);
    evidence.usage = events.filter(row => row.method === 'thread/tokenUsage/updated').at(-1)?.params.tokenUsage;
    evidence.modelRequests = endpoint.requests.length;
    assert.equal(evidence.usage.total.totalTokens, evidence.modelRequests * 25);
    assert.equal(evidence.usage.total.cachedInputTokens, evidence.modelRequests * 4);
    assert.equal(evidence.usage.total.reasoningOutputTokens, evidence.modelRequests);
    // An instruction to require a tool is not a transport guarantee: script an
    // answer without one and verify that native completion still succeeds.
    const requiredThread = await rpc.request('thread/start', { model: 'fixture-model', modelProvider: 'fixture',
      cwd: root, ephemeral: true, sandbox: 'read-only', approvalPolicy: 'never', environments: [],
      baseInstructions: 'You must call minnow_lookup before answering. A tool call is required.',
      dynamicTools: [{ type: 'function', name: 'minnow_lookup', description: 'Required fixture tool',
        inputSchema: { type: 'object', properties: {} } }],
    });
    endpoint.scripts.push({ text: 'Ignored the required tool instruction.' });
    const required = await rpc.request('turn/start', { threadId: requiredThread.thread.id,
      input: [{ type: 'text', text: 'Call the required tool.' }] });
    await waitFor(() => events.some(row => row.method === 'turn/completed' && row.params.turn.id === required.turn.id));
    evidence.requiredToolWireChoice = endpoint.requests.at(-1).tool_choice;
    evidence.requiredToolNativeStatus = events.find(row => row.method === 'turn/completed' && row.params.turn.id === required.turn.id).params.turn.status;
    assert.equal(evidence.requiredToolWireChoice, 'auto');
    assert.equal(evidence.requiredToolNativeStatus, 'completed');
    endpoint.scripts.push({ calls: [{ id: 'native-probe', name: 'shell_command',
      args: { command: 'echo MINNOW_NATIVE_EXECUTION_SENTINEL' } }] });
    endpoint.scripts.push({ text: 'Native probe finished.' });
    const nativeProbe = await rpc.request('turn/start', { threadId: requiredThread.thread.id,
      input: [{ type: 'text', text: 'Probe undeclared native tool.' }] });
    await waitFor(() => events.some(row => row.method === 'turn/completed' && row.params.turn.id === nativeProbe.turn.id));
    const rejectedNative = endpoint.requests.at(-1).input.find(item => item.type === 'function_call_output' && item.call_id === 'native-probe');
    evidence.nativeToolRejection = rejectedNative?.output;
    assert.match(String(evidence.nativeToolRejection), /unsupported|unrecognized|unknown/i);
    assert.equal(calls.length, 2, 'Only the two declared dynamic calls reach the client');
    const requestCountBeforeInterrupt = endpoint.requests.length;
    endpoint.scripts.push({ hang: true });
    const hanging = await rpc.request('turn/start', { threadId, input: [{ type: 'text', text: 'Wait for interruption.' }] });
    await waitFor(() => endpoint.requests.length > requestCountBeforeInterrupt);
    const interruptedAt = performance.now();
    await rpc.request('turn/interrupt', { threadId, turnId: hanging.turn.id }, { timeoutMs: 1000 });
    await waitFor(() => events.some(row => row.method === 'turn/completed' && row.params.turn.id === hanging.turn.id), 1000);
    evidence.interruptMs = performance.now() - interruptedAt;
    assert.equal(events.find(row => row.method === 'turn/completed' && row.params.turn.id === hanging.turn.id).params.turn.status, 'interrupted');
    console.log(JSON.stringify(evidence, null, 2));
    return evidence;
  } finally {
    await rpc?.close();
    await endpoint.close();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await runCodexAppServerSmoke({ ...(process.argv.includes('--compaction') ? { compactThreshold: 1 } : {}) });
}

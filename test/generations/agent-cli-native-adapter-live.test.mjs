import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createNativeEnforcementFixture, psQuote, exists } from '../fixtures/codex-native-enforcement.mjs';
import { __setCodexInvocationForTests, shutdownCodexSessions } from '../../server/generations/codex-app-server/manager.js';
import { pumpAgentCliUpstream } from '../../server/generations/agent-cli/pump.js';
import { resolveAgentCliBin, applyAgentCliCaptureEnv } from '../../server/generations/agent-cli/resolve-bin.js';
import { createGenerationState } from '../../server/generations/store.js';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import { readCliCheckpoint } from '../../server/generations/agent-cli/checkpoints.js';
import { createNativeExecutionContext, bindNativeExecutionContext } from '../../server/generations/native-execution-context.js';
import Database from 'better-sqlite3';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { initSessionsSchema } from '../../server/config/sessions-schema.js';
import { createChatRepository } from '../../server/chats/repository.js';
import { createChatCheckpointCoordinator } from '../../server/chats/checkpoints.js';
import { createChatPolicy } from '../../server/chats/policy.js';
import { createChatNativeExecution, NATIVE_READ_TOOLS, NATIVE_WRITE_TOOLS } from '../../server/chats/native-execution.js';
import { createChatTranscriptStore } from '../../server/chats/transcript-store.js';
import { createServerRunnerDeps } from '../../server/runtime/server-runner-deps.js';
import { runTurn } from '../../server/runner/index.js';
import { postChatCompletionsInProcess } from '../../server/runner/generation-binding.js';
import { setAgentCliProviderEnabled } from '../../server/providers/store.js';
import { deleteGenerationsForProviderShutdown } from '../../server/generations/store.js';

const installed = { skip: process.env.MINNOW_CODEX_NATIVE_ENFORCEMENT !== '1' || process.platform !== 'win32', timeout: 90_000 };
const edit = file => `*** Begin Patch\n*** Add File: ${file.replaceAll('\\', '/')}\n+NATIVE_ADAPTER_EDIT\n*** End Patch`;
function spawnDelayedChild(file, waitForExit = false) {
  const command = `Set-Content -LiteralPath ${psQuote(file + '.started')} -Value STARTED; Start-Sleep -Seconds 3; Set-Content -LiteralPath ${psQuote(file)} -Value CHILD_EFFECT`;
  const encoded = Buffer.from(command, 'utf16le').toString('base64');
  return `$ErrorActionPreference = 'Stop'; $child = Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList '-NoProfile','-EncodedCommand',${psQuote(encoded)} -WindowStyle Hidden -PassThru; Write-Output ('BG_CHILD_STARTED:' + $child.Id); $deadline = [DateTime]::UtcNow.AddSeconds(5); while (-not (Test-Path -LiteralPath ${psQuote(file + '.started')})) { if ([DateTime]::UtcNow -gt $deadline) { throw 'Child payload did not start' }; Start-Sleep -Milliseconds 20 }; Write-Output 'CHILD_PAYLOAD_STARTED'; ${waitForExit ? 'Wait-Process -Id $child.Id -Timeout 10' : ''}`;
}
async function harness(t) {
  const f = await createNativeEnforcementFixture();
  const previous = process.env.MINNOW_HOME, states = [], records = [], boundaries = [];
  const controller = new AbortController();
  process.env.MINNOW_HOME = path.join(f.root, 'minnow'); resetMinnowHomeCache();
  const bin = await resolveAgentCliBin({ kind: 'codex' });
  const auth = path.join(f.home, 'fixture-auth.json'); await fs.writeFile(auth, '{}');
  let privateHome, current = true;
  __setCodexInvocationForTests(async session => {
    privateHome = session.home;
    const config = await fs.readFile(path.join(session.home, 'config.toml'), 'utf8');
    assert.match(config, /sandbox = "mxc"/);
    assert.match(config, /inherit = "none"/);
    await fs.writeFile(path.join(session.home, 'private-marker.txt'), 'NATIVE_ADAPTER_PRIVATE');
    await fs.writeFile(path.join(session.home, 'config.toml'), `model_provider = "fixture"\n${config}\n[model_providers.fixture]\nname = "Fixture"\nbase_url = ${JSON.stringify(f.endpoint.baseUrl)}\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\n`);
    const env = {};
    for (const name of ['PATH', 'Path', 'SystemRoot', 'COMSPEC', 'TEMP', 'TMP', 'APPDATA', 'LOCALAPPDATA']) if (process.env[name]) env[name] = process.env[name];
    Object.assign(env, { CODEX_HOME: session.home, HOME: session.home, USERPROFILE: session.home, OPENAI_API_KEY: 'FIXTURE_PROVIDER_SECRET_NOT_FOR_SHELL' });
    return { ...bin, cwd: session.home, env: applyAgentCliCaptureEnv(env, bin.command) };
  });
  const policy = { version: 1, workspace: await fs.realpath(f.workspace), mode: 'workspace-write', fingerprint: 'fixture-full-v1' };
  const nativeExecution = {
    policy, signal: controller.signal,
    async runTurn(meta, operation) {
      assert.ok(meta.threadId, 'Thread is initialized before host admission, inference is not.');
      boundaries.push({ stage: 'before', ...meta }); const result = await operation();
      assert.equal(result.nativeQuiescence.verified, true);
      assert.equal(result.nativeQuiescence.threadId, meta.threadId);
      boundaries.push({ stage: 'after', ...meta }); return result;
    },
    async assertCurrent() { if (!current) throw new Error('Native policy revoked.'); },
    async record(event) { records.push(event); },
    async approve() { return 'decline'; },
  };
  t.after(async () => {
    await shutdownCodexSessions(); __setCodexInvocationForTests();
    for (const state of states) clearTimeout(state.evictTimer);
    if (previous === undefined) delete process.env.MINNOW_HOME; else process.env.MINNOW_HOME = previous;
    resetMinnowHomeCache(); await f.close();
  });
  const messages = [{ role: 'system', content: 'Isolated adapter fixture.' }, { role: 'user', content: 'Run the fixture.' }];
  const tools = [{ type: 'function', function: { name: 'fixture_lookup', parameters: { type: 'object', properties: {} } } }];
  return { f, states, records, boundaries, policy, nativeExecution, messages, controller,
    get privateHome() { return privateHome; }, revoke() { current = false; controller.abort(new Error('Native policy revoked.')); },
    async round(scripts, { execution = nativeExecution, chatId = 'native-adapter-fixture', canonicalMessages = messages } = {}) {
      f.endpoint.scripts.push(...scripts);
      // Mirror the private generation-binding projection. Never infer authority
      // or strip marker-like prose in the adapter/request-body parser.
      const projected = execution?.projectMessages ? execution.projectMessages(canonicalMessages) : canonicalMessages;
      const state = createGenerationState({ providerId: 'codex-cli', chatId, fallbackRole: 'default',
        body: { model: 'gpt-5.5', stream: true, messages: projected, tools } }); states.push(state);
      const requestMessages = JSON.parse(state.requestBody).messages;
      if (execution?.policy) bindNativeExecutionContext(state, Object.isFrozen(execution) ? execution
        : createNativeExecutionContext(Object.freeze({ ...execution,
          policy: Object.freeze({ ...execution.policy }) }), { chatId, providerId: 'codex-cli', modelId: 'gpt-5.5' }));
      const result = await pumpAgentCliUpstream({ state, runtime: { profile: { agentCli: { kind: 'codex', nativeCodingTools: true } },
        secrets: { codexAuthPath: auth } }, candidate: { providerId: 'codex-cli', modelId: 'gpt-5.5' },
        index: 0, idleMs: 5000, maxMs: 25000, canFailover: true, nativeExecution: execution });
      const rows = Buffer.concat(state.chunks).toString().split('\n\n').filter(row => row.startsWith('data: {')).map(row => JSON.parse(row.slice(6)));
      return { state, result, rows, requestMessages, calls: rows.flatMap(row => row.choices?.[0]?.delta?.tool_calls ?? []).map(({ index, ...call }) => call) };
    },
  };
}

test('installed native adapter waits for private host admission then reads/edits/tests and returns a real Minnow tool', installed, async t => {
  const h = await harness(t);
  const original = h.nativeExecution.runTurn;
  let enter; const gate = new Promise(resolve => { enter = resolve; });
  h.nativeExecution.runTurn = async (meta, op) => { await gate; return original(meta, op); };
  const firstPromise = h.round([
    { calls: [{ id: 'native-read', name: 'exec_command', args: { cmd: 'Get-Content allowed.txt', login: false } }] },
    { calls: [{ id: 'native-edit', name: 'apply_patch', code: edit('native-edited.txt') }] },
    { calls: [{ id: 'native-test', name: 'exec_command', args: { cmd: `& ${psQuote(process.execPath)} -e ${psQuote("require('node:assert/strict').equal(require('node:fs').readFileSync('native-edited.txt','utf8'),'NATIVE_ADAPTER_EDIT\\n'); console.log('NATIVE_ADAPTER_TEST_OK'); console.log(process.env.OPENAI_API_KEY || 'NO_PROVIDER_SECRET');")}`, login: false } }] },
    { calls: [{ id: 'minnow-integration', name: 'mn_tool_0' }] },
  ]);
  await new Promise(resolve => setTimeout(resolve, 75));
  assert.equal(h.f.endpoint.requests.length, 0, 'No inference or native action before host barrier.');
  assert.equal(await exists(path.join(h.f.workspace, 'native-edited.txt')), false);
  enter();
  const first = await firstPromise;
  assert.equal(first.state.status, 'complete', first.state.errorMessage);
  assert.equal(first.calls.length, 1);
  assert.equal(first.calls[0].function.name, 'fixture_lookup');
  assert.equal(await fs.readFile(path.join(h.f.workspace, 'native-edited.txt'), 'utf8'), 'NATIVE_ADAPTER_EDIT\n');
  const testRecord = h.records.find(row => row.method === 'item/completed' && row.item.id === 'native-test');
  assert.match(testRecord.item.aggregatedOutput, /NATIVE_ADAPTER_TEST_OK/);
  assert.match(testRecord.item.aggregatedOutput, /NO_PROVIDER_SECRET/);
  assert.doesNotMatch(JSON.stringify(h.records), /FIXTURE_PROVIDER_SECRET_NOT_FOR_SHELL/);
  assert.ok(h.records.some(row => row.item.type === 'fileChange'));
  assert.ok(h.records.every(row => row.threadId && row.turnId && row.item.id));
  assert.equal(first.rows.at(-1).minnow_cli.effective_tool_mode, 'native');
  h.messages.push({ role: 'assistant', content: '', tool_calls: first.calls },
    { role: 'tool', tool_call_id: first.calls[0].id, content: 'REAL_MINNOW_INTEGRATION_RESULT' });
  const cp = await readCliCheckpoint('codex-cli', 'native-adapter-fixture');
  const { checkpointMatches, cliHash } = await import('../../server/generations/agent-cli/checkpoints.js');
  assert.ok(checkpointMatches(cp, cp.fingerprint, h.messages));
  assert.equal(cp.nativeFileDigest, cliHash(await fs.readFile(path.join(h.privateHome, cp.nativeFile))));
  const second = await h.round([{ text: 'Native and Minnow work settled.' }]);
  assert.equal(second.state.status, 'complete', second.state.errorMessage);
  assert.equal(second.rows.at(-1).minnow_cli.continuation, 'resumed');
  assert.match(JSON.stringify(h.f.endpoint.requests.at(-1).input), /REAL_MINNOW_INTEGRATION_RESULT/);
  assert.equal((await readCliCheckpoint('codex-cli', 'native-adapter-fixture')).nativeCoding, true);
  assert.equal(h.boundaries.filter(row => row.stage === 'before').length, 2);
  await shutdownCodexSessions();
  h.messages.push({ role: 'assistant', content: 'Native and Minnow work settled.' }, { role: 'user', content: 'Continue without repeating the edit.' });
  const restored = await h.round([{ text: 'Verified native history resumed.' }]);
  assert.equal(restored.state.status, 'complete', restored.state.errorMessage);
  assert.equal(restored.rows.at(-1).minnow_cli.continuation, 'resumed');
  assert.equal(await fs.readFile(path.join(h.f.workspace, 'native-edited.txt'), 'utf8'), 'NATIVE_ADAPTER_EDIT\n');
  assert.equal(h.records.filter(row => row.item.id === 'native-edit' && row.method === 'item/completed').length, 1);
});

test('native adapter Plan and private/outside/network scope denies hold before effects', installed, async t => {
  const h = await harness(t);
  h.policy.mode = 'read-only';
  h.policy.fingerprint = 'fixture-plan-v1';
  const result = await h.round([
    { calls: [{ id: 'plan-edit', name: 'apply_patch', code: edit('forbidden-plan.txt') }] },
    { calls: [{ id: 'outside-read', name: 'exec_command', args: { cmd: `Get-Content -LiteralPath ${psQuote(path.join(h.f.outside, 'outside-marker.txt'))}`, login: false } }] },
    { calls: [{ id: 'private-read', name: 'exec_command', args: { cmd: 'Get-Content -LiteralPath "$HOME/private-marker.txt"', login: false } }] },
    { calls: [{ id: 'network', name: 'exec_command', args: { cmd: h.f.networkCommand, login: false } }] },
    { text: 'Denied effects settled.' },
  ]);
  assert.equal(result.state.status, 'complete', result.state.errorMessage);
  assert.equal(await exists(path.join(h.f.workspace, 'forbidden-plan.txt')), false);
  assert.equal(h.f.networkHits, 0);
  assert.doesNotMatch(JSON.stringify(h.records), /NATIVE_OUTSIDE_MARKER|NATIVE_ADAPTER_PRIVATE/);
  assert.match(h.records.find(row => row.item.id === 'outside-read' && row.method === 'item/completed').item.aggregatedOutput, /denied|cannot find/i);
});

test('missing or revoked private native contract cannot start inference or silently fall back', installed, async t => {
  const h = await harness(t);
  const rejected = await h.round([], { execution: {} });
  assert.equal(rejected.result.outcome, 'fatal');
  assert.equal(h.f.endpoint.requests.length, 0);
  h.revoke();
  await assert.rejects(h.round([]), /Native policy revoked/);
  assert.equal(h.f.endpoint.requests.length, 0);
});

test('revocation during native command stops the process and preserves an uncertain checkpoint without replay', installed, async t => {
  const h = await harness(t);
  const late = path.join(h.f.workspace, 'must-not-run-after-revocation.txt');
  const original = h.nativeExecution.record;
  h.nativeExecution.record = async event => {
    await original(event);
    if (event.item.type === 'commandExecution' && event.method === 'item/started') h.revoke();
  };
  const result = await h.round([
    { calls: [{ id: 'revoked-command', name: 'exec_command', args: { cmd: `Start-Sleep -Seconds 3; Set-Content -LiteralPath ${psQuote(late)} -Value FORBIDDEN`, login: false } }] },
    { text: 'Must not complete normally.' },
  ]);
  assert.equal(result.result.outcome, 'fatal');
  await shutdownCodexSessions();
  assert.equal(await exists(late), false);
  assert.equal((await readCliCheckpoint('codex-cli', 'native-adapter-fixture')).nativeRecoveryRequired, true);
});

test('real native adapter resumes repository-derived transcripts across handoff and a new fenced host execution', installed, async t => {
  const h = await harness(t);
  const git = promisify(execFile);
  await git('git', ['init', h.f.workspace]);
  await git('git', ['-C', h.f.workspace, 'add', 'allowed.txt']);
  await git('git', ['-C', h.f.workspace, '-c', 'user.name=Native Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture']);
  const db = new Database(':memory:'); initSessionsSchema(db);
  const repository = createChatRepository({ db });
  const chatId = 'native-adapter-fixture', executionId = 'native-host-execution';
  repository.createChat({ id: chatId, name: 'Native host fixture', workspacePath: h.f.workspace });
  const fence = repository.claimExecution({ chatId, executionId, ownerId: 'host', captured: { nativeExecution: {
    version: 1, requestedMode: 'native', effectiveMode: 'native', providerId: 'codex-cli', modelId: 'gpt-5.5',
    cliVersion: '0.166.0', networkAccess: 'off',
  } } });
  const checkpoint = await createChatCheckpointCoordinator({ repository }).prepare({ chatId, executionId,
    cwd: h.f.workspace, fence, signal: h.controller.signal });
  const policy = createChatPolicy({ modeId: 'build', filesystemAccess: 'workspace', fileWriteScope: 'workspace',
    shellSandboxMode: 'require', workspaceIds: ['workspace'], capabilities: [],
    toolPermissions: Object.fromEntries([...NATIVE_READ_TOOLS, ...NATIVE_WRITE_TOOLS].map(name => [name, 'full'])) });
  const authority = await createChatNativeExecution({ repository, checkpoint, capturedPolicy: policy,
    resolveCurrentPolicy: async () => policy, subscribePolicyChanges: () => () => {},
    chatId, executionId, fence, cwd: h.f.workspace, workspaceId: 'workspace', providerId: 'codex-cli',
    modelId: 'gpt-5.5', cliVersion: '0.166.0', requestedNative: true, signal: h.controller.signal });
  t.after(() => { authority.dispose(); db.close(); });
  repository.appendMessage(chatId, h.messages[1], { fence, messageId: 'fixture-user-1' });
  const fromRepository = () => [h.messages[0], ...repository.readTranscript(chatId).messages];
  const result = await h.round([
    { calls: [{ id: 'real-host-native-edit', name: 'apply_patch', code: edit('host-native-edit.txt') }] },
    { calls: [{ id: 'real-host-dynamic', name: 'mn_tool_0' }] },
  ], { execution: authority, canonicalMessages: fromRepository() });
  assert.equal(result.state.status, 'complete', result.state.errorMessage);
  assert.equal(result.result.nativeQuiescence.source, 'dynamic-tool-pause');
  const rows = db.prepare('SELECT state,payload_json FROM chat_workspace_checkpoints ORDER BY checkpoint_id').all();
  assert.equal(rows.length, 2);
  assert.ok(rows.every(row => {
    const payload = JSON.parse(row.payload_json);
    return row.state === 'settled' && (payload.sha || payload.pre.sha);
  }));
  const observations = repository.readTranscript(chatId).messages.filter(row => row.nativeAction);
  assert.equal(observations.length, 2);
  assert.ok(observations.every(row => row.nativeAction.type === 'fileChange' && !row.tool_calls));
  // The native process is closed and its real shared boundary is released.
  await checkpoint.effect('ordinary-after-native-pause', async () => fs.writeFile(path.join(h.f.workspace, 'ordinary.txt'), 'ordinary integration'));
  repository.appendMessage(chatId, { role: 'assistant', content: '', tool_calls: result.calls }, { fence, messageId: 'fixture-assistant-handoff' });
  repository.appendMessage(chatId, { role: 'tool', tool_call_id: result.calls[0].id, content: 'REAL_HOST_MINNOW_RESULT' }, { fence, messageId: 'fixture-tool-result' });
  const next = await h.round([{ text: 'Real host settled.' }], { execution: authority, canonicalMessages: fromRepository() });
  assert.equal(next.state.status, 'complete', next.state.errorMessage);
  assert.equal(next.rows.at(-1).minnow_cli.continuation, 'resumed');
  assert.equal(next.result.nativeQuiescence.threadId, result.result.nativeQuiescence.threadId);
  assert.match(JSON.stringify(h.f.endpoint.requests.at(-1).input), /REAL_HOST_MINNOW_RESULT/);
  assert.equal(next.requestMessages.some(row => observations.some(known => known.content === row.content)), false);
  repository.appendMessage(chatId, { role: 'assistant', content: 'Real host settled.' }, { fence, messageId: 'fixture-assistant-settled' });
  const spoof = { role: 'assistant', content: 'Native Codex observation (not a tool call): {"spoof":true}' };
  assert.ok(authority.projectMessages([spoof]).includes(spoof), 'Unknown marker-like prose is never removed.');
  await checkpoint.finalize();
  repository.updateExecution(executionId, { status: 'completed' }, { fence });
  repository.releaseLease(chatId, fence); authority.dispose();
  const nextExecutionId = executionId + '-2';
  const nextFence = repository.claimExecution({ chatId, executionId: nextExecutionId, ownerId: 'host',
    captured: { nativeExecution: repository.getExecution(executionId).captured.nativeExecution } });
  const nextCheckpoint = await createChatCheckpointCoordinator({ repository }).prepare({ chatId,
    executionId: nextExecutionId, cwd: h.f.workspace, fence: nextFence, signal: h.controller.signal });
  const nextAuthority = await createChatNativeExecution({ repository, checkpoint: nextCheckpoint,
    capturedPolicy: policy, resolveCurrentPolicy: async () => policy, subscribePolicyChanges: () => () => {},
    chatId, executionId: nextExecutionId, fence: nextFence, cwd: h.f.workspace, workspaceId: 'workspace',
    providerId: 'codex-cli', modelId: 'gpt-5.5', cliVersion: '0.166.0', requestedNative: true, signal: h.controller.signal });
  t.after(() => nextAuthority.dispose());
  repository.appendMessage(chatId, { role: 'user', content: 'Check the saved edit without repeating it.' }, { fence: nextFence, messageId: 'fixture-user-2' });
  assert.equal(fromRepository().filter(row => row.nativeAction).length, 2, 'The new command receives the durable observation rows.');
  assert.equal(nextAuthority.projectMessages(fromRepository()).some(row => row.nativeAction), false,
    'New authority discovers exact known observations from SQLite, not an old private set.');
  const followup = await h.round([
    { calls: [{ id: 'real-host-followup-read', name: 'exec_command', args: { cmd: 'Get-Content host-native-edit.txt', login: false } }] },
    { text: 'Repository-derived continuation settled.' },
  ], { execution: nextAuthority, canonicalMessages: fromRepository() });
  assert.equal(followup.state.status, 'complete', followup.state.errorMessage);
  assert.equal(followup.rows.at(-1).minnow_cli.continuation, 'resumed');
  assert.equal(followup.result.nativeQuiescence.threadId, result.result.nativeQuiescence.threadId);
  const durable = repository.readTranscript(chatId).messages.filter(row => row.nativeAction);
  assert.equal(durable.filter(row => row.nativeAction.type === 'fileChange' && row.nativeAction.stage === 'completed').length, 1,
    'The original native edit is not replayed across commands.');
  assert.ok(durable.some(row => row.nativeAction.itemId === 'real-host-followup-read'
    && row.nativeAction.executionId === nextExecutionId && row.nativeAction.output?.includes('NATIVE_ADAPTER_EDIT')));
  assert.equal(await fs.readFile(path.join(h.f.workspace, 'host-native-edit.txt'), 'utf8'), 'NATIVE_ADAPTER_EDIT\n');
  await nextCheckpoint.finalize();
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM chat_workspace_checkpoints WHERE state='uncertain'").get().n, 0);
});

test('mixed dynamic/native siblings are interrupted and cannot continue effects after the returned handoff', installed, async t => {
  const h = await harness(t);
  const file = path.join(h.f.workspace, 'after-handoff-forbidden.txt');
  const result = await h.round([{ calls: [
    { id: 'parallel-dynamic', name: 'mn_tool_0' },
    { id: 'parallel-native', name: 'exec_command', args: {
      cmd: `Start-Sleep -Seconds 3; Set-Content -LiteralPath ${psQuote(file)} -Value FORBIDDEN`, login: false, yield_time_ms: 10000,
    } },
  ] }]);
  assert.equal(result.state.status, 'complete', result.state.errorMessage);
  assert.equal(result.result.nativeQuiescence.source, 'dynamic-tool-pause');
  await new Promise(resolve => setTimeout(resolve, 3500));
  assert.equal(await exists(file), false, 'No native sibling may outlive the host checkpoint boundary.');
});

test('native region leaves no delayed effect from a child whose payload demonstrably started', installed, async t => {
  const h = await harness(t);
  const file = path.join(h.f.workspace, 'background-child-forbidden.txt');
  const result = await h.round([
    { calls: [{ id: 'spawn-child', name: 'exec_command', args: {
      cmd: spawnDelayedChild(file),
      login: false, yield_time_ms: 10000,
    } }] },
    { text: 'Parent command settled.' },
  ]);
  assert.equal(result.state.status, 'complete', result.state.errorMessage);
  const spawned = h.records.find(row => row.method === 'item/completed' && row.item.id === 'spawn-child');
  assert.equal(spawned.item.exitCode, 0, spawned.item.aggregatedOutput);
  assert.match(spawned.item.aggregatedOutput, /BG_CHILD_STARTED:\d+/);
  assert.match(spawned.item.aggregatedOutput, /CHILD_PAYLOAD_STARTED/);
  await new Promise(resolve => setTimeout(resolve, 3500));
  assert.equal(await exists(file), false, 'This started child has no delayed effect after the native region ends; MXC command-lifetime cleanup also applies.');
});

test('MXC positive control: the delayed child payload writes while its launching native command remains alive', installed, async t => {
  const f = await createNativeEnforcementFixture({ windowsSandbox: 'mxc', scoped: true });
  t.after(() => f.close());
  const file = path.join(f.workspace, 'background-positive-control.txt');
  const result = await f.turn({ cmd: spawnDelayedChild(file, true), profile: 'minnow-write' });
  const completed = result.events.find(row => row.method === 'item/completed' && row.params.item.id === result.id);
  assert.equal(completed.params.item.exitCode, 0, result.output);
  assert.match(result.output, /BG_CHILD_STARTED:\d+/);
  assert.ok(result.events.some(row => row.method === 'turn/completed' && row.params.turn.status === 'completed'));
  await new Promise(resolve => setTimeout(resolve, 4000));
  assert.equal(await exists(file + '.started'), true, 'The child payload itself ran, not just Start-Process.');
  assert.equal(await fs.readFile(file, 'utf8').then(text => text.trim()), 'CHILD_EFFECT', 'The same delayed payload can write while the native owner remains alive.');
});

test('MXC short-yield probe records whether the command actually yielded instead of assuming a live session', installed, async t => {
  const f = await createNativeEnforcementFixture({ windowsSandbox: 'mxc', scoped: true });
  t.after(() => f.close());
  const file = path.join(f.workspace, 'yield-positive-control.txt');
  const result = await f.turn({ cmd: `Start-Sleep -Seconds 3; Set-Content -LiteralPath ${psQuote(file)} -Value YIELDED_EFFECT`,
    profile: 'minnow-write', yieldTimeMs: 1 });
  const item = result.events.find(row => row.method === 'item/completed' && row.params.item.id === result.id)?.params.item;
  assert.equal(item?.exitCode, 0, 'This pinned MXC path waited for command exit despite the short yield request.');
  assert.ok(result.events.some(row => row.method === 'turn/completed' && row.params.turn.status === 'completed'));
  await new Promise(resolve => setTimeout(resolve, 3500));
  assert.equal(await exists(file), true, 'This short-yield request completed its command and effect, rather than returning a live yielded session.');
});

test('native adapter short-yield command records a verified exit before returning its region', installed, async t => {
  const h = await harness(t);
  const file = path.join(h.f.workspace, 'yield-after-region-forbidden.txt');
  const result = await h.round([
    { calls: [{ id: 'yielded-command', name: 'exec_command', args: {
      cmd: `Start-Sleep -Seconds 3; Set-Content -LiteralPath ${psQuote(file)} -Value FORBIDDEN`, login: false, yield_time_ms: 1,
    } }] },
    { text: 'Must not be treated as quiescent success.' },
  ]);
  assert.equal(result.result.outcome, 'complete', result.state.errorMessage);
  const completed = h.records.find(row => row.method === 'item/completed' && row.item.id === 'yielded-command');
  assert.equal(completed.item.exitCode, 0);
  assert.equal(await exists(file), true, 'This request did not yield: its effect settled before the region returned.');
});

test('MXC raw completed-launcher lifecycle probe does not confuse command cleanup with app-server closure', installed, async t => {
  const f = await createNativeEnforcementFixture({ windowsSandbox: 'mxc', scoped: true });
  t.after(() => f.close());
  const file = path.join(f.workspace, 'raw-child-after-parent.txt');
  const result = await f.turn({ cmd: spawnDelayedChild(file), profile: 'minnow-write' });
  assert.match(result.output, /CHILD_PAYLOAD_STARTED/);
  assert.equal(await exists(file + '.started'), true);
  await new Promise(resolve => setTimeout(resolve, 3500));
  const wroteAfterParent = await exists(file);
  t.diagnostic('Native parent command completed, app-server retained: delayed child write=' + wroteAfterParent);
  assert.equal(wroteAfterParent, false, 'The pinned MXC command lifetime terminated this started child without needing app-server closure.');
});

test('shared runner and real generation binding preserve canonical native observations across two host commands', installed, async t => {
  const h = await harness(t);
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = h.f.home;
  t.after(() => {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousCodexHome;
    deleteGenerationsForProviderShutdown();
  });
  // Real provider lookup is scratch-local. Inference remains the loopback fake
  // endpoint installed by harness(), never a live account or external model.
  await setAgentCliProviderEnabled('codex', true);
  const git = promisify(execFile);
  await git('git', ['init', h.f.workspace]);
  await git('git', ['-C', h.f.workspace, 'add', 'allowed.txt']);
  await git('git', ['-C', h.f.workspace, '-c', 'user.name=Native Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture']);
  const db = new Database(':memory:'); initSessionsSchema(db);
  t.after(() => db.close());
  const repository = createChatRepository({ db });
  const chatId = 'native-shared-runner-fixture';
  repository.createChat({ id: chatId, name: 'Real native shared runner', workspacePath: h.f.workspace });
  const policy = createChatPolicy({ modeId: 'build', filesystemAccess: 'workspace', fileWriteScope: 'workspace',
    shellSandboxMode: 'require', workspaceIds: ['workspace'], capabilities: [],
    toolPermissions: Object.fromEntries([...NATIVE_READ_TOOLS, ...NATIVE_WRITE_TOOLS].map(name => [name, 'full'])) });
  const captured = { nativeExecution: { version: 1, requestedMode: 'native', effectiveMode: 'native',
    providerId: 'codex-cli', modelId: 'gpt-5.5', cliVersion: '0.166.0', networkAccess: 'off' } };
  const tools = [{ type: 'function', function: { name: 'fixture_lookup', description: 'Run the fixture integration.',
    parameters: { type: 'object', properties: {} } } }];
  const rawRequests = [], results = [], executed = [];
  async function command(executionId, userText, scripts) {
    const fence = repository.claimExecution({ chatId, executionId, ownerId: 'host', captured });
    repository.appendMessage(chatId, { role: 'user', content: userText }, { fence, messageId: executionId + '-user' });
    const checkpoint = await createChatCheckpointCoordinator({ repository }).prepare({ chatId, executionId,
      cwd: h.f.workspace, fence, signal: h.controller.signal });
    const authority = await createChatNativeExecution({ repository, checkpoint, capturedPolicy: policy,
      resolveCurrentPolicy: async () => policy, subscribePolicyChanges: () => () => {},
      chatId, executionId, fence, cwd: h.f.workspace, workspaceId: 'workspace', providerId: 'codex-cli',
      modelId: 'gpt-5.5', cliVersion: '0.166.0', requestedNative: true, signal: h.controller.signal });
    try {
      const transcript = createChatTranscriptStore({ repository, chatId, fence });
      const deps = createServerRunnerDeps(async (provider, body, signal, options) => {
        rawRequests.push(structuredClone(body.messages));
        // Intentionally no projectMessages call here: the production generation
        // binding owns projection before state creation and WeakMap admission.
        return postChatCompletionsInProcess(provider, body, signal, { ...options, chatId,
          fallbackRole: 'default', nativeExecution: authority });
      });
      deps.transcriptStore = transcript;
      deps.runHeadlessToolBatch = async options => {
        const outcomes = [];
        for (const toolCall of options.toolCalls) {
          const result = await options.execute(toolCall.function.name, JSON.parse(toolCall.function.arguments), { toolCallId: toolCall.id });
          const outcome = { toolCall, result }; options.onToolDone?.(outcome); outcomes.push(outcome);
        }
        return outcomes;
      };
      h.f.endpoint.scripts.push(...scripts);
      const result = await runTurn({ chatId, seed: '', seedKind: 'continue', systemPrompt: 'Isolated shared-runner fixture.',
        tools, lazyTools: false, model: { providerId: 'codex-cli', id: 'gpt-5.5', exactModel: true },
        cwd: h.f.workspace, transcript, deps, signal: h.controller.signal,
        injectReportTool: false, nudgeToolUse: false, finalizeStructuredOutcome: false,
        execute: async name => {
          assert.equal(name, 'fixture_lookup'); executed.push(name);
          await checkpoint.effect(executionId + '-fixture-integration', async () => {
            await fs.writeFile(path.join(h.f.workspace, 'runner-integration.txt'), 'REAL_SHARED_RUNNER_RESULT');
          });
          return { content: 'REAL_SHARED_RUNNER_RESULT' };
        },
      });
      assert.equal(result.outcome, 'no_report', JSON.stringify(result));
      await checkpoint.finalize();
      repository.updateExecution(executionId, { status: 'completed' }, { fence });
      repository.releaseLease(chatId, fence);
      results.push(result);
      return readCliCheckpoint('codex-cli', chatId);
    } finally { authority.dispose(); }
  }
  const first = await command('runner-host-1', 'Edit and run the fixture integration.', [
    { calls: [{ id: 'runner-native-edit', name: 'apply_patch', code: edit('runner-native-edit.txt') }] },
    { calls: [{ id: 'runner-dynamic', name: 'mn_tool_0' }] },
    { text: 'Shared runner first command settled.' },
  ]);
  const firstRows = repository.readTranscript(chatId).messages;
  assert.equal(firstRows.filter(row => row.nativeAction).length, 2);
  assert.ok(firstRows.some(row => row.role === 'tool' && row.content.includes('REAL_SHARED_RUNNER_RESULT')));
  assert.ok(firstRows.some(row => row.role === 'assistant' && row.content === 'Shared runner first command settled.'));
  const beforeSecond = rawRequests.length;
  const second = await command('runner-host-2', 'Read the saved edit without repeating the integration.', [
    { calls: [{ id: 'runner-followup-read', name: 'exec_command', args: { cmd: 'Get-Content runner-native-edit.txt', login: false } }] },
    { text: 'Shared runner second command settled.' },
  ]);
  assert.equal(first.nativeId, second.nativeId, 'The same native thread resumes across real runner commands; no rebuild.');
  assert.ok(rawRequests[beforeSecond].some(row => row.role === 'assistant' && row.content.startsWith('Native Codex observation (not a tool call):')),
    'The real runner passed canonical native observation prose to the real binding, not a cleaned fixture transcript.');
  const all = repository.readTranscript(chatId).messages;
  assert.equal(all.filter(row => row.nativeAction?.type === 'fileChange' && row.nativeAction.stage === 'completed').length, 1);
  assert.ok(all.some(row => row.nativeAction?.itemId === 'runner-followup-read' && row.nativeAction.output?.includes('NATIVE_ADAPTER_EDIT')));
  assert.deepEqual(executed, ['fixture_lookup'], 'The real integration effect is not replayed.');
  assert.equal(await fs.readFile(path.join(h.f.workspace, 'runner-native-edit.txt'), 'utf8'), 'NATIVE_ADAPTER_EDIT\n');
  assert.equal(await fs.readFile(path.join(h.f.workspace, 'runner-integration.txt'), 'utf8'), 'REAL_SHARED_RUNNER_RESULT');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM chat_workspace_checkpoints WHERE state!='settled'").get().n, 0);
  assert.equal(results.length, 2);
});

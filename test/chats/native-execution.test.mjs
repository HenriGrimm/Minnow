import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { initSessionsSchema } from '../../server/config/sessions-schema.js';
import { createChatRepository } from '../../server/chats/repository.js';
import { createChatCheckpointCoordinator } from '../../server/chats/checkpoints.js';
import { createChatPolicy } from '../../server/chats/policy.js';
import { createChatNativeExecution, deriveChatNativePolicy, NATIVE_READ_TOOLS, NATIVE_WRITE_TOOLS } from '../../server/chats/native-execution.js';
import { assertNativeExecutionContext, bindNativeExecutionContext, getNativeExecutionContext } from '../../server/generations/native-execution-context.js';

const gate = () => Promise.withResolvers();
const policy = (patch = {}) => createChatPolicy({ modeId: 'build', permissionLevel: 'full', filesystemAccess: 'workspace', fileWriteScope: 'workspace',
  shellSandboxMode: 'require', workspaceIds: ['workspace'], capabilities: [],
  toolPermissions: Object.fromEntries([...NATIVE_READ_TOOLS, ...NATIVE_WRITE_TOOLS].map(name => [name, 'full'])), ...patch });
const derive = (patch = {}) => deriveChatNativePolicy({ capturedPolicy: policy(), currentPolicy: policy(),
  workspaceId: 'workspace', workspace: path.resolve('fixture'), platform: 'win32', cliVersion: '0.166.0', modelId: 'gpt-5.5', ...patch });

async function fixture(t, options = {}) {
  const cwd = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-native-host-')));
  const db = new Database(':memory:'); initSessionsSchema(db);
  const repository = createChatRepository({ db });
  repository.createChat({ id: 'chat', name: 'native host fixture', workspacePath: cwd });
  const nativeSelection = { version: 1, requestedMode: 'native', effectiveMode: 'native',
    providerId: 'codex', modelId: 'gpt-5.5', cliVersion: '0.166.0', networkAccess: 'off' };
  const fence = repository.claimExecution({ chatId: 'chat', executionId: 'execution', ownerId: 'host',
    captured: { nativeExecution: nativeSelection } });
  const stop = new AbortController();
  let currentPolicy = options.policy ?? policy(), invalidate, disposed = 0;
  const captures = [];
  const coordinator = createChatCheckpointCoordinator({ repository, capture: options.capture ?? (async () => {
    captures.push('snapshot'); return { ok: true, sha: 'snapshot-' + captures.length, headSha: 'head' };
  }) });
  const checkpoint = await coordinator.prepare({ chatId: 'chat', executionId: 'execution', cwd, fence, signal: stop.signal });
  const authority = await createChatNativeExecution({ repository, checkpoint, capturedPolicy: currentPolicy,
    resolveCurrentPolicy: async () => currentPolicy,
    subscribePolicyChanges(listener) { invalidate = listener; return () => { disposed++; }; },
    chatId: 'chat', executionId: 'execution', fence, cwd, workspaceId: 'workspace',
    providerId: 'codex', modelId: 'gpt-5.5', cliVersion: '0.166.0', platform: 'win32',
    signal: stop.signal, requestedNative: true, redactionSecrets: ['fixture-secret-value'], ...options.host });
  t.after(async () => { authority.dispose(); db.close(); await fs.rm(cwd, { recursive: true, force: true, maxRetries: 5 }); });
  const meta = (patch = {}) => ({ generationId: 'generation', chatId: 'chat', providerId: 'codex', threadId: 'thread',
    turnId: 'turn', workspace: cwd, mode: authority.policy.mode, policyFingerprint: authority.policy.fingerprint, ...patch });
  const proof = (source = 'turn-completed', patch = {}) => ({ nativeQuiescence: { verified: true, source,
    generationId: 'generation', threadId: 'thread', turnId: 'turn', ...patch } });
  const row = () => db.prepare("SELECT state,payload_json FROM chat_workspace_checkpoints WHERE checkpoint_id!='$baseline'").get();
  return { cwd, db, repository, coordinator, checkpoint, authority, fence, stop, captures, meta, proof, row, nativeSelection,
    setPolicy(value, notify = false) { currentPolicy = value; if (notify) invalidate(); }, invalidate: () => invalidate(),
    get disposed() { return disposed; } };
}

test('native policy admits only the verified exact platform/version/model and workspace', () => {
  assert.equal(derive().mode, 'workspace-write');
  for (const patch of [{ platform: 'linux' }, { cliVersion: '0.167.0' }, { modelId: 'unknown' }, { workspaceId: 'other' }]) {
    assert.throws(() => derive(patch), /verified|scope/);
  }
  assert.throws(() => derive({ capturedPolicy: JSON.parse(JSON.stringify(policy())) }), /server-validated/);
});

test('native capability restrictions remain enforced independently of the global level', () => {
  for (const name of [...NATIVE_READ_TOOLS, ...NATIVE_WRITE_TOOLS]) {
    for (const permission of ['off']) {
      const narrower = policy({ toolPermissions: { ...policy().toolPermissions, [name]: permission } });
      assert.throws(() => derive({ currentPolicy: narrower }), /requires? the tool capability/);
      assert.throws(() => derive({ capturedPolicy: narrower }), /requires? the tool capability/);
    }
  }
  const plan = policy({ modeId: 'plan', fileWriteScope: 'plans',
    toolPermissions: { ...policy().toolPermissions, apply_patch: 'ask', git_commit: 'off' } });
  assert.equal(derive({ capturedPolicy: plan, currentPolicy: policy() }).mode, 'read-only');
  assert.equal(derive({ capturedPolicy: policy(), currentPolicy: plan }).mode, 'read-only');
});

test('native writes require global Full access and legacy Ask is availability only', () => {
  for (const permissionLevel of ['manual', 'auto', 'full']) {
    const available = policy({ permissionLevel, toolPermissions: { ...policy().toolPermissions, save_file: 'ask' } });
    assert.equal(derive({ capturedPolicy: available, currentPolicy: available }).mode,
      permissionLevel === 'full' ? 'workspace-write' : 'read-only');
  }
});

test('native turn starts only after baseline and durable exclusive intent', async t => {
  const started = gate(), release = gate(); let count = 0, ran = 0;
  const f = await fixture(t, { capture: async () => {
    if (++count === 1) { started.resolve(); await release.promise; }
    return { ok: true, sha: 's' + count };
  } });
  await started.promise;
  const pending = f.authority.runTurn(f.meta(), async () => {
    ran++;
    assert.equal(f.row().state, 'executing');
    assert.ok(JSON.parse(f.row().payload_json).pre.sha);
    return f.proof();
  });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(ran, 0);
  release.resolve(); await pending;
  assert.equal(ran, 1); assert.equal(f.row().state, 'settled'); assert.equal(count, 3);
  await assert.rejects(f.authority.runTurn(f.meta(), async () => { ran++; }), /replayed/);
  assert.equal(ran, 1);
});

test('unverified handoff, active items or wrong turn quiescence are uncertainty, not safe lock release', async t => {
  for (const kind of ['missing-proof', 'active-command', 'wrong-turn']) {
    await t.test(kind, async t => {
      const f = await fixture(t);
      await assert.rejects(f.authority.runTurn(f.meta(), async () => {
        if (kind === 'active-command') await f.authority.record(f.meta({ method: 'item/started',
          item: { id: 'cmd', type: 'commandExecution', command: 'test', status: 'inProgress' } }));
        return kind === 'missing-proof' ? { handed: true } : kind === 'wrong-turn' ? f.proof('turn-completed', { turnId: 'other' }) : f.proof('dynamic-tool-pause');
      }), error => error.checkpointUncertain === true);
      assert.equal(f.row().state, 'uncertain');
      assert.equal(f.authority.signal.aborted, true);
      const next = await f.coordinator.prepare({ chatId: 'chat', executionId: 'execution', cwd: f.cwd, fence: f.fence });
      await assert.rejects(next.effect('new-write', async () => {}), /explicit recovery/);
    });
  }
});

test('verified parked native region releases checkout before child/dynamic execution', async t => {
  const f = await fixture(t);
  await f.authority.runTurn(f.meta(), async () => f.proof('dynamic-tool-pause'));
  let childRan = false;
  await f.checkpoint.effect('child-after-pause', async () => { childRan = true; });
  assert.equal(childRan, true);
  await f.authority.runTurn(f.meta({ generationId: 'generation-2' }), async () => f.proof('turn-completed', { generationId: 'generation-2' }));
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM chat_workspace_checkpoints WHERE state='settled'").get().n, 4);
});

test('native records are bounded, deduplicated canonical observations, never executable calls', async t => {
  const f = await fixture(t);
  await f.authority.runTurn(f.meta(), async () => {
    const started = f.meta({ method: 'item/started', item: { id: 'cmd', type: 'commandExecution', command: 'echo fixture-secret-value' } });
    const completed = f.meta({ method: 'item/completed', item: { ...started.item, status: 'completed', exitCode: 0,
      aggregatedOutput: 'fixture-secret-value API_KEY=unwanted-output' } });
    await f.authority.record(started); await f.authority.record(started);
    await f.authority.record(completed); await f.authority.record(completed);
    return f.proof();
  });
  const messages = f.repository.readTranscript('chat').messages;
  assert.equal(messages.length, 2);
  for (const message of messages) {
    assert.equal(message.role, 'assistant'); assert.equal(message.tool_calls, undefined); assert.equal(message.tool_call_id, undefined);
    assert.equal(message.nativeAction.executionId, 'execution');
    assert.doesNotMatch(JSON.stringify(message), /fixture-secret-value|unwanted-output/);
  }
  assert.equal(messages[1].nativeAction.exitCode, 0);
  assert.match(messages[1].nativeAction.output, /redacted/);
  await assert.rejects(f.authority.record(f.meta({ method: 'item/started', item: { id: 'late', type: 'commandExecution' } })), /outside/);
});

test('stale fence and replaced checkout prevent turn/start', async t => {
  await t.test('fence', async t => {
    const f = await fixture(t); let ran = false;
    f.db.prepare("UPDATE chat_execution_leases SET epoch=epoch+1 WHERE chat_id='chat'").run();
    await assert.rejects(f.authority.runTurn(f.meta(), async () => { ran = true; }), /stale/);
    assert.equal(ran, false);
  });
  await t.test('checkout', async t => {
    const f = await fixture(t); await f.checkpoint.baseline;
    const retained = f.cwd + '-retained';
    await fs.rename(f.cwd, retained); await fs.mkdir(f.cwd);
    t.after(() => fs.rm(retained, { recursive: true, force: true, maxRetries: 5 }));
    await assert.rejects(f.authority.runTurn(f.meta(), async () => f.proof()), /identity/);
  });
});

test('live invalidation aborts silent native work; Stop never settles an uncertain region', async t => {
  for (const kind of ['revocation', 'stop', 'cancellation-epoch']) {
    await t.test(kind, async t => {
      const f = await fixture(t), entered = gate(), release = gate();
      const running = f.authority.runTurn(f.meta(), async () => { entered.resolve(); await release.promise; return f.proof(); });
      await entered.promise;
      if (kind === 'revocation') f.invalidate();
      else if (kind === 'stop') f.stop.abort();
      else f.repository.advanceCancellationEpoch('chat');
      release.resolve();
      await assert.rejects(running, error => error.checkpointUncertain === true);
      assert.equal(f.row().state, 'uncertain');
    });
  }
});

test('current policy rechecked after waiting; no native launch on changed policy or skipped baseline', async t => {
  const f = await fixture(t); let ran = false;
  f.setPolicy(policy({ toolPermissions: { ...policy().toolPermissions, apply_patch: 'off' } }));
  await assert.rejects(f.authority.runTurn(f.meta(), async () => { ran = true; }), /requires? the tool capability/);
  assert.equal(ran, false);
  const skipped = await fixture(t, { capture: async () => ({ ok: false, error: 'Not a git repository' }) });
  await assert.rejects(skipped.authority.runTurn(skipped.meta(), async () => { ran = true; }), /Git safety baseline/);
  assert.equal(ran, false);
});

test('approvals bind native identities, observed changes, paths and one-shot durable answer', async t => {
  const requests = [];
  const f = await fixture(t, { host: { waitForApproval: async request => { requests.push(request); return { decision: 'allow_once' }; } } });
  await f.authority.runTurn(f.meta(), async () => {
    const changes = [{ path: path.join(f.cwd, 'file.txt'), kind: { type: 'add' }, diff: '+fixture' }];
    const item = { id: 'edit', type: 'fileChange', changes };
    await f.authority.record(f.meta({ method: 'item/started', item }));
    const request = f.meta({ requestId: 123, itemId: 'edit', method: 'item/fileChange/requestApproval', changes });
    assert.equal(await f.authority.approve({ ...request, grantRoot: f.cwd }), 'decline');
    assert.equal(await f.authority.approve({ ...request, changes: [{ path: path.join(f.cwd, '..', 'outside') }] }), 'decline');
    assert.equal(await f.authority.approve({ ...request, method: 'item/commandExecution/requestApproval' }), 'decline');
    assert.equal(await f.authority.approve(request), 'accept');
    await f.authority.record(f.meta({ method: 'item/completed', item: { ...item, status: 'completed' } }));
    return f.proof();
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].presentation.executionId, 'execution');
  assert.equal(requests[0].presentation.requestId, 123);
  assert.match(requests[0].toolCallId, /^native-approval-/);
});

test('Plan approvals cannot upgrade a native read-only workspace; no invalidation support fails closed', async t => {
  let asked = false;
  const f = await fixture(t, { policy: policy({ modeId: 'plan', fileWriteScope: 'plans' }),
    host: { waitForApproval: async () => { asked = true; return 'allow_once'; } } });
  await f.authority.runTurn(f.meta(), async () => {
    assert.equal(await f.authority.approve(f.meta({ method: 'item/fileChange/requestApproval', itemId: 'edit', requestId: 1 })), 'decline');
    return f.proof();
  });
  assert.equal(asked, false);
  await assert.rejects(createChatNativeExecution({ repository: f.repository, checkpoint: f.checkpoint, capturedPolicy: policy(),
    resolveCurrentPolicy: async () => policy(), chatId: 'chat', executionId: 'execution', fence: f.fence,
    cwd: f.cwd, signal: f.stop.signal }), /invalidation subscription/);
});

test('private authority cannot be cloned/forged, attached to utility, another model/chat or fallback chain', async t => {
  const f = await fixture(t);
  const identity = { chatId: 'chat', providerId: 'codex', modelId: 'gpt-5.5', body: { model: 'gpt-5.5' }, fallbackRole: 'default' };
  assert.equal(assertNativeExecutionContext(f.authority, identity), f.authority);
  assert.throws(() => assertNativeExecutionContext({ ...f.authority }, identity), /authority/);
  for (const patch of [{ chatId: 'other' }, { providerId: 'other' }, { modelId: 'other' },
    { fallbackRole: 'utility' }, { fallbackRole: 'sub-agent' }, { body: { tool_choice: 'none' } }]) {
    assert.throws(() => assertNativeExecutionContext(f.authority, { ...identity, ...patch }), /authority/);
  }
  const state = { chatId: 'chat', providerId: 'codex', requestBody: Buffer.from('{"model":"gpt-5.5"}'),
    candidates: [{ providerId: 'codex', modelId: 'gpt-5.5' }], fallbackRole: 'default' };
  bindNativeExecutionContext(state, f.authority);
  assert.equal(getNativeExecutionContext(state), f.authority);
  assert.equal(state.failoverDisabled, true);
  assert.equal(JSON.stringify(state).includes('fingerprint'), false);
  assert.equal(getNativeExecutionContext({ ...state }), null);
  assert.throws(() => bindNativeExecutionContext({ ...state, candidates: [...state.candidates, ...state.candidates] }, f.authority), /failover/);
  f.authority.dispose(); f.authority.dispose();
  assert.equal(f.disposed, 1);
  assert.throws(() => assertNativeExecutionContext(f.authority, identity));
});

test('Stop interrupts a blocked baseline waiter without launching native inference', async t => {
  const entered = gate(), release = gate();
  const f = await fixture(t, { capture: async () => { entered.resolve(); await release.promise; return { ok: true, sha: 'baseline' }; } });
  await entered.promise; let ran = false;
  const running = f.authority.runTurn(f.meta(), async () => { ran = true; return f.proof(); });
  f.stop.abort(); await assert.rejects(running, { name: 'AbortError' });
  assert.equal(ran, false); assert.equal(f.row(), undefined);
  release.resolve(); await f.checkpoint.baseline;
});

test('untrusted observation failure cannot be swallowed to certify a clean native region', async t => {
  const variants = [
    { id: 'unexpected', type: 'browser' },
    { id: 'large', type: 'commandExecution', command: 'x'.repeat(512 * 1024) },
    { id: 'escape', type: 'fileChange', changes: [{ path: path.resolve('..', 'outside'), kind: { type: 'add' } }] },
  ];
  for (const item of variants) {
    await t.test(item.id, async t => {
      const f = await fixture(t);
      await assert.rejects(f.authority.runTurn(f.meta(), async () => {
        await assert.rejects(f.authority.record(f.meta({ method: 'item/started', item })));
        return f.proof();
      }), error => error.checkpointUncertain === true);
      assert.equal(f.row().state, 'uncertain');
    });
  }
});

test('approval cannot accept session grants or a change mutated after its durable start record', async t => {
  let asked = 0;
  const f = await fixture(t, { host: { waitForApproval: async () => { asked++; return 'acceptForSession'; } } });
  await f.authority.runTurn(f.meta(), async () => {
    const changes = [{ path: path.join(f.cwd, 'file'), kind: { type: 'add' }, diff: '+first' }];
    const item = { id: 'edit', type: 'fileChange', changes };
    await f.authority.record(f.meta({ method: 'item/started', item }));
    const request = f.meta({ method: 'item/fileChange/requestApproval', requestId: 1, itemId: 'edit', changes });
    item.changes[0].diff = '+changed';
    assert.equal(await f.authority.approve(request), 'decline');
    const original = [{ ...changes[0], diff: '+first' }];
    assert.equal(await f.authority.approve({ ...request, changes: original }), 'decline');
    await f.authority.record(f.meta({ method: 'item/completed', item: { ...item, changes: original, status: 'declined' } }));
    return f.proof();
  });
  assert.equal(asked, 1);
});

test('pending approval rechecks revocation and cannot acknowledge native acceptance after Stop', async t => {
  const f = await fixture(t, { host: { waitForApproval: async () => { f.invalidate(); return 'allow_once'; } } });
  await assert.rejects(f.authority.runTurn(f.meta(), async () => {
    const changes = [{ path: path.join(f.cwd, 'file'), kind: { type: 'add' } }];
    await f.authority.record(f.meta({ method: 'item/started', item: { id: 'edit', type: 'fileChange', changes } }));
    await f.authority.approve(f.meta({ method: 'item/fileChange/requestApproval', requestId: 1, itemId: 'edit', changes }));
    return f.proof();
  }), error => error.checkpointUncertain === true);
  assert.equal(f.row().state, 'uncertain');
});

test('a bare adapter outcome is explicitly insufficient, not a supported native handoff contract', async t => {
  const f = await fixture(t);
  const initial = f.meta({ threadId: undefined, turnId: undefined });
  await assert.rejects(f.authority.runTurn(initial, async () => {
    await f.authority.assertCurrent(initial); // Before thread creation.
    await f.authority.assertCurrent(f.meta()); // Bound once the adapter creates it.
    return { outcome: 'complete' }; // A bare outcome cannot certify native quiescence.
  }), error => error.checkpointUncertain === true);
  assert.equal(f.row().state, 'uncertain');
});

test('late identity changes and overlapping native regions cannot inherit authority', async t => {
  const f = await fixture(t), entered = gate(), release = gate();
  const running = f.authority.runTurn(f.meta(), async () => { entered.resolve(); await release.promise; return f.proof(); });
  await entered.promise;
  await assert.rejects(f.authority.runTurn(f.meta({ generationId: 'other' }), async () => f.proof()), /overlap/);
  release.resolve(); await running;
  for (const patch of [{ chatId: 'other' }, { workspace: path.resolve('other') }, { policyFingerprint: 'forged' }]) {
    await assert.rejects(f.authority.runTurn(f.meta(patch), async () => f.proof()), /identity/);
  }
});

test('a native successful file write observed under Plan is uncertainty, not a clean receipt', async t => {
  const f = await fixture(t, { policy: policy({ modeId: 'plan', fileWriteScope: 'plans' }) });
  await assert.rejects(f.authority.runTurn(f.meta(), async () => {
    const item = { id: 'edit', type: 'fileChange', changes: [{ path: path.join(f.cwd, 'file'), kind: { type: 'add' } }] };
    await f.authority.record(f.meta({ method: 'item/started', item }));
    await f.authority.record(f.meta({ method: 'item/completed', item: { ...item, status: 'completed' } }));
    return f.proof();
  }), error => error.checkpointUncertain === true);
  assert.equal(f.row().state, 'uncertain');
});

test('read-only approval checks cannot follow a junction out of the admitted checkout', async t => {
  const f = await fixture(t), outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-native-outside-')));
  t.after(() => fs.rm(outside, { recursive: true, force: true, maxRetries: 5 }));
  await fs.symlink(outside, path.join(f.cwd, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.authority.runTurn(f.meta(), async () => {
    await f.authority.record(f.meta({ method: 'item/started', item: { id: 'escape', type: 'fileChange',
      changes: [{ path: path.join(f.cwd, 'link', 'file'), kind: { type: 'add' } }] } }));
    return f.proof();
  }), error => error.checkpointUncertain === true);
  assert.equal(f.row().state, 'uncertain');
});

test('adapter decline/cancel-only ceiling never offers or accepts an escalation', async t => {
  let asked = false;
  const f = await fixture(t, { host: { waitForApproval: async () => { asked = true; return 'allow_once'; } } });
  await f.authority.runTurn(f.meta(), async () => {
    const changes = [{ path: path.join(f.cwd, 'file'), kind: { type: 'add' } }];
    const item = { id: 'edit', type: 'fileChange', changes };
    await f.authority.record(f.meta({ method: 'item/started', item }));
    const request = f.meta({ method: 'item/fileChange/requestApproval', itemId: 'edit', requestId: 1, changes });
    for (const allowedDecisions of [['decline', 'cancel'], ['acceptForSession'], ['accept', 'acceptForSession'], [], 'accept']) {
      assert.equal(await f.authority.approve({ ...request, allowedDecisions }), 'decline');
    }
    await f.authority.record(f.meta({ method: 'item/completed', item: { ...item, status: 'declined' } }));
    return f.proof();
  });
  assert.equal(asked, false);
});

test('native selection is copied at admission; later preference/source changes cannot alter a queued choice', async t => {
  const f = await fixture(t);
  f.nativeSelection.requestedMode = 'minnow';
  f.nativeSelection.effectiveMode = 'minnow';
  f.nativeSelection.providerId = 'changed-provider';
  const persisted = f.repository.getExecution('execution').captured.nativeExecution;
  assert.equal(persisted.requestedMode, 'native');
  assert.equal(persisted.effectiveMode, 'native');
  assert.equal(persisted.providerId, 'codex');
  await f.authority.runTurn(f.meta(), async () => f.proof());
  assert.equal(f.row().state, 'settled');
  assert.equal(f.authority.policy.networkAccess, 'off');
});

test('runtime opt-in cannot create or widen missing, queued-minnow or mismatched captured selection', async t => {
  const variants = [null, { requestedMode: 'minnow', effectiveMode: 'minnow' }, { providerId: 'other' },
    { modelId: 'other' }, { cliVersion: 'unknown' }, { networkAccess: 'on' }];
  for (const selectionPatch of variants) {
    await t.test(JSON.stringify(selectionPatch), async t => {
      const f = await fixture(t);
      const selected = f.repository.getExecution('execution').captured.nativeExecution;
      const captured = selectionPatch === null ? {} : { nativeExecution: { ...selected, ...selectionPatch } };
      f.db.prepare("UPDATE chat_executions SET captured_json=? WHERE execution_id='execution'").run(JSON.stringify(captured));
      let subscribed = false;
      await assert.rejects(createChatNativeExecution({ repository: f.repository, checkpoint: f.checkpoint, capturedPolicy: policy(),
        resolveCurrentPolicy: async () => policy(), subscribePolicyChanges() { subscribed = true; return () => {}; },
        chatId: 'chat', executionId: 'execution', fence: f.fence, cwd: f.cwd, workspaceId: 'workspace',
        providerId: 'codex', modelId: 'gpt-5.5', cliVersion: '0.166.0', platform: 'win32',
        signal: f.stop.signal, requestedNative: true }), /captured immutably/);
      assert.equal(subscribed, false);
      let ran = false;
      await assert.rejects(f.authority.runTurn(f.meta(), async () => { ran = true; return f.proof(); }), /selection changed/);
      assert.equal(ran, false);
      assert.equal(f.row(), undefined);
    });
  }
});

test('native observations enforce UTF-8 byte limits rather than UTF-16 character counts', async t => {
  const f = await fixture(t);
  const item = { id: 'unicode-command', type: 'commandExecution', command: '\u20ac'.repeat(200000) };
  assert.ok(JSON.stringify(item).length < 512 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(item)) > 512 * 1024);
  await assert.rejects(f.authority.runTurn(f.meta(), async () => {
    await f.authority.record(f.meta({ method: 'item/started', item }));
    return f.proof();
  }), error => error.checkpointUncertain === true);
  assert.equal(f.repository.readTranscript('chat').messages.length, 0);
  assert.equal(f.row().state, 'uncertain');
});

test('approval argument counts and UTF-8 bytes are bounded before hashing or human presentation', async t => {
  let asked = false;
  const f = await fixture(t, { host: { waitForApproval: async () => { asked = true; return 'allow_once'; } } });
  await f.authority.runTurn(f.meta(), async () => {
    const changes = [{ path: path.join(f.cwd, 'file'), kind: { type: 'add' }, diff: '+allowed' }];
    const item = { id: 'edit', type: 'fileChange', changes };
    await f.authority.record(f.meta({ method: 'item/started', item }));
    const request = f.meta({ method: 'item/fileChange/requestApproval', itemId: 'edit', requestId: 1, changes });
    const tooMany = Array.from({ length: 101 }, () => changes[0]);
    tooMany.toJSON = () => { throw new Error('Excess arguments must not reach serialization/hash.'); };
    assert.equal(await f.authority.approve({ ...request, changes: tooMany }), 'decline');
    let serialized = 0;
    const large = [{ toJSON() { serialized++; return { ...changes[0], diff: '\u20ac'.repeat(200000) }; } }];
    assert.equal(await f.authority.approve({ ...request, changes: large }), 'decline');
    assert.equal(serialized, 1, 'Byte rejection must happen before a second serialization for hashing.');
    assert.equal(await f.authority.approve({ ...request, changes: [] }), 'decline');
    assert.equal(await f.authority.approve({ ...request, allowedDecisions: ['accept', 'decline', 'cancel', 'accept'] }), 'decline');
    await f.authority.record(f.meta({ method: 'item/completed', item: { ...item, status: 'declined' } }));
    return f.proof();
  });
  assert.equal(asked, false);
});

test('quoted JSON/CLI credentials and captured secrets are redacted before diagnostic truncation', async t => {
  const secrets = ['immutable-fixture-value', 'xy', 'long-known-fixture-value-' + 'z'.repeat(2500)];
  const originalLong = secrets[2];
  const f = await fixture(t, { host: { redactionSecrets: secrets } });
  secrets.splice(0, secrets.length, 'new-secret-that-was-not-captured');
  await f.authority.runTurn(f.meta(), async () => {
    const command = 'node --token "cli token value" --password \'two words secret\' --api-key=unquoted-value';
    const output = 'prefix '.repeat(500) + JSON.stringify({ apiKey: 'json-key-value', password: 'json password with spaces' })
      + ' immutable-fixture-value ' + originalLong + ' xy';
    const item = { id: 'immutable-fixture-value', type: 'commandExecution', command };
    await f.authority.record(f.meta({ method: 'item/started', item }));
    await f.authority.record(f.meta({ method: 'item/completed', item: { ...item, status: 'completed', aggregatedOutput: output } }));
    return f.proof();
  });
  const messages = f.repository.readTranscript('chat').messages;
  const encoded = JSON.stringify(messages);
  for (const sensitive of ['cli token value', 'two words secret', 'unquoted-value', 'json-key-value',
    'json password with spaces', 'immutable-fixture-value', originalLong, 'xy']) assert.equal(encoded.includes(sensitive), false);
  assert.ok(messages.every(message => message.nativeAction.command.length <= 2000));
  assert.ok(messages[1].nativeAction.output.length <= 2000);
  assert.equal(messages[0].nativeAction.itemId, '[redacted]');
  assert.match(messages[1].nativeAction.output, /redacted/);
});

test('sensitive approval paths are declined rather than shown or accepted in truncated/redacted form', async t => {
  let asked = false;
  const f = await fixture(t, { host: { waitForApproval: async () => { asked = true; return 'allow_once'; } } });
  await f.authority.runTurn(f.meta(), async () => {
    const changes = [{ path: path.join(f.cwd, 'fixture-secret-value.txt'), kind: { type: 'add' } }];
    const item = { id: 'edit', type: 'fileChange', changes };
    await f.authority.record(f.meta({ method: 'item/started', item }));
    assert.equal(await f.authority.approve(f.meta({ method: 'item/fileChange/requestApproval', itemId: 'edit', requestId: 1, changes })), 'decline');
    await f.authority.record(f.meta({ method: 'item/completed', item: { ...item, status: 'declined' } }));
    return f.proof();
  });
  assert.equal(asked, false);
  assert.doesNotMatch(JSON.stringify(f.repository.readTranscript('chat').messages), /fixture-secret-value/);
});

test('native redaction configuration rejects wrong argument types and excessive secret lists before subscription', async t => {
  const f = await fixture(t);
  const cases = ['not-an-array', [123], Array.from({ length: 129 }, () => 'secret'), ['x'.repeat(64 * 1024 + 1)]];
  for (const redactionSecrets of cases) {
    let subscribed = false;
    await assert.rejects(createChatNativeExecution({ repository: f.repository, checkpoint: f.checkpoint, capturedPolicy: policy(),
      resolveCurrentPolicy: async () => policy(), subscribePolicyChanges() { subscribed = true; return () => {}; },
      chatId: 'chat', executionId: 'execution', fence: f.fence, cwd: f.cwd, workspaceId: 'workspace',
      providerId: 'codex', modelId: 'gpt-5.5', cliVersion: '0.166.0', platform: 'win32',
      signal: f.stop.signal, requestedNative: true, redactionSecrets }), /bounded array of strings/);
    assert.equal(subscribed, false);
  }
});

test('native equivalence covers Python/JavaScript in Plan as well as workspace-write modes', () => {
  for (const modeId of ['build', 'plan']) {
    for (const name of ['run_python', 'run_javascript']) {
      for (const permission of ['off']) {
        const narrowed = policy({ modeId, toolPermissions: { ...policy().toolPermissions, [name]: permission } });
        assert.throws(() => derive({ capturedPolicy: narrowed }), /requires? the tool capability/);
        assert.throws(() => derive({ currentPolicy: narrowed }), /requires? the tool capability/);
      }
    }
  }
});

test('all captured/current Git mutation names and code aliases retain capability restrictions with false read metadata', () => {
  const mutations = ['git_switch', 'git_reset', 'git_restore', 'git_clean', 'git_merge', 'git_rebase',
    'git_cherry_pick', 'git_stash', 'git_push', 'git_tag'];
  for (const name of [...mutations, 'execute_code']) {
    for (const permission of ['off']) {
      const broadened = policy({ toolPermissions: { ...policy().toolPermissions, [name]: 'full' }, toolEffects: { [name]: 'read' } });
      const narrowed = policy({ toolPermissions: { ...policy().toolPermissions, [name]: permission }, toolEffects: { [name]: 'read' } });
      assert.throws(() => derive({ capturedPolicy: narrowed, currentPolicy: broadened }), /requires? the tool capability/);
      assert.throws(() => derive({ capturedPolicy: broadened, currentPolicy: narrowed }), /requires? the tool capability/);
    }
  }
  const shellAlias = policy({ toolPermissions: { ...policy().toolPermissions, custom_shell: 'off' }, toolEffects: { custom_shell: 'shell' } });
  assert.throws(() => derive({ currentPolicy: shellAlias }), /requires? the tool capability/);
  for (const name of ['create_pdf', 'create_spreadsheet', 'create_word_document']) {
    const narrowed = policy({ toolPermissions: { ...policy().toolPermissions, [name]: 'off' } });
    assert.throws(() => derive({ capturedPolicy: narrowed }), /requires? the tool capability/);
    assert.throws(() => derive({ currentPolicy: narrowed }), /requires? the tool capability/);
  }
});

test('private native observation projection preserves unknown prose and never silently removes executable or ambiguous rows', async t => {
  const f = await fixture(t);
  await f.authority.runTurn(f.meta(), async () => {
    const item = { id: 'command', type: 'commandExecution', command: 'test' };
    await f.authority.record(f.meta({ method: 'item/started', item }));
    await f.authority.record(f.meta({ method: 'item/completed', item: { ...item, status: 'completed', exitCode: 0 } }));
    return f.proof();
  });
  const observed = f.repository.readTranscript('chat').messages;
  const unknown = { role: 'assistant', content: 'Native Codex observation (not a tool call): unknown marker-like prose' };
  const user = { role: 'user', content: observed[0].content };
  const dynamic = { role: 'assistant', content: 'Actual executable dynamic call.', tool_calls: [{ id: 'call', type: 'function',
    function: { name: 'read_file', arguments: '{"path":"safe"}' } }] };
  assert.deepEqual(f.authority.projectMessages([user, ...observed, unknown, dynamic]), [user, unknown, dynamic]);
  assert.equal(f.repository.readTranscript('chat').messages.length, 2, 'Projection never rewrites the canonical observations.');
  assert.throws(() => f.authority.projectMessages([{ ...dynamic, content: observed[0].content }]), /ambiguous/);
  assert.throws(() => f.authority.projectMessages([{ ...observed[0], tool_call_id: 'forged-result' }]), /ambiguous/);
  assert.throws(() => f.authority.projectMessages([observed[0], { role: 'assistant', content: observed[0].content }]), /ambiguous/);
});

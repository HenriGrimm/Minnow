import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { initSessionsSchema } from '../../server/config/sessions-schema.js';
import { upsertMessageRow } from '../../server/config/sessions-import.js';
import { createChatRepository } from '../../server/chats/repository.js';
import { createChatCommandService } from '../../server/chats/service.js';
import { createChatCaller, createChatProjectRegistry, resolveProjectScope } from '../../server/chats/caller.js';
import { createChatPolicy } from '../../server/chats/policy.js';
import { getOrdinaryChatExecutionFeature } from '../../server/chats/feature.js';

const code = expected => error => error?.code === expected;
async function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minnow-ordinary-routing-'));
  const filename = path.join(root, 'sessions.db');
  let db, repository, service, external = false, captures = 0;
  let gate = { ...getOrdinaryChatExecutionFeature(), admissionEnabled: true, promotionEnabled: true, blockers: [] };
  const registry = createChatProjectRegistry([{ projectId: 'project', workspaceId: 'workspace', canonicalKey: root }]);
  const scope = resolveProjectScope(registry, { projectId: 'project', workspaceKey: root });
  const policy = createChatPolicy({ modeId: 'build', workspaceIds: ['workspace'],
    capabilities: ['chat.read', 'chat.send', 'chat.stop', 'execution.host'], toolPermissions: {} });
  const caller = createChatCaller({ actor: 'human', ingress: 'renderer', chatId: 'human', scope, policy });
  const context = { async resolveTarget(chatId) {
    const chat = repository.getChat(chatId);
    return { chat, scope, policy, currentPolicy: policy, registry, profile: repository.getLatestProfile(chatId), checkoutIdentity: 'original' };
  } };
  const open = () => {
    db = new Database(filename); db.pragma('foreign_keys=ON'); initSessionsSchema(db);
    repository = createChatRepository({ db });
    service = createChatCommandService({ repository, context, ordinaryFeature: () => gate,
      hasExternalOwner: () => external, resolveModelSelection: ({ selection }) => selection,
      captureProfile: async ({ target, selection }) => {
        captures++; await options.capturing?.();
        return { profileId: 'profile-' + target.chat.id, profileVersion: 1, snapshot: { policy, modelSelection: selection, prompt: 'Captured' } };
      } });
  };
  open();
  repository.createChat({ id: 'root', name: 'Root', workspacePath: root, providerId: 'provider', modelId: 'model', modeId: 'build' });
  db.prepare('DELETE FROM chat_conversation_state WHERE chat_id=?').run('root');
  t.after(async () => { await service.dispose(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { get db() { return db; }, get repository() { return repository; }, get service() { return service; }, context, caller, scope, policy,
    input: (id = 'promotion') => ({ chatId: 'root', expectedRevision: repository.getChat('root').revision, clientRequestId: id }),
    setExternal(value) { external = value; }, setGate(value) { gate = value; }, captures: () => captures,
    async restart() { await service.dispose(); db.close(); open(); },
    history(messages) { messages.forEach((message, index) => upsertMessageRow(db, 'root', index, message)); db.prepare('UPDATE chats SET message_count=? WHERE id=?').run(messages.length, 'root'); },
  };
}

test('supported ordinary roots are released by default; explicit rollback stops promotion but not recovery', async t => {
  const production = getOrdinaryChatExecutionFeature({ NODE_ENV: 'production' });
  assert.equal(production.admissionEnabled, true); assert.equal(production.promotionEnabled, true);
  assert.equal(production.reason, 'released'); assert.deepEqual(production.blockers, []);
  const rollback = getOrdinaryChatExecutionFeature({ MINNOW_ORDINARY_CHAT_EXECUTION: '0', NODE_ENV: 'production' });
  assert.equal(rollback.admissionEnabled, false); assert.equal(rollback.promotionEnabled, false);
  assert.equal(rollback.recoveryEnabled, true);
  const f = await fixture(t); f.setGate(rollback);
  assert.equal((await f.service.ordinaryEligibility(f.caller, 'root')).reason, 'disabled');
  await assert.rejects(f.service.promote(f.caller, f.input()), code('capability_unavailable'));
  assert.equal(f.repository.getChat('root').chatCommandVersion, undefined);
  f.db.prepare('INSERT INTO chat_loops(chat_id,loop_id) VALUES (?,?)').run('root', 1);
  assert.equal((await f.service.ordinaryEligibility(f.caller, 'root')).reason, 'legacy_controller_active');
});

test('new eligible roots promote without dispatch; concurrent windows admit exactly one canonical profile and receipt', async t => {
  const f = await fixture(t), input = f.input();
  const [first, repeated] = await Promise.all([f.service.promote(f.caller, input), f.service.promote(f.caller, input)]);
  assert.equal(first.disposition, 'promoted'); assert.equal(repeated.replayed, true); assert.equal(f.captures(), 1);
  assert.equal(f.repository.getChat('root').chatCommandVersion, 1);
  assert.equal(f.repository.listCommands({ chatId: 'root' }).length, 0, 'promotion cannot dispatch a model turn');
  assert.equal((await f.service.promote(f.caller, { ...input, clientRequestId: 'other-window' })).disposition, 'already_canonical');
  let runs = 0;
  f.service.registerHost({ id: 'server', kind: 'server', execute: async () => { runs++; return { outcome: 'no_report' }; } });
  const send = { chatId: 'root', message: 'One reply', clientRequestId: 'send' };
  await Promise.all([f.service.send(f.caller, send), f.service.send(f.caller, send)]);
  await f.service.idle('root'); assert.equal(runs, 1);
});

test('idle historical roots require both gates and the exact saved revision, preserving history and drafts', async t => {
  const f = await fixture(t);
  f.history([{ role: 'user', content: 'Earlier text' }, { role: 'assistant', content: 'Saved reply' }]);
  f.db.prepare('UPDATE chats SET meta_json=? WHERE id=?').run(JSON.stringify({ composerDraft: 'Unsent draft' }), 'root');
  const input = f.input();
  f.setGate({ ...getOrdinaryChatExecutionFeature(), admissionEnabled: true, promotionEnabled: false });
  await assert.rejects(f.service.promote(f.caller, input), code('capability_unavailable'));
  f.setGate({ admissionEnabled: true, promotionEnabled: true, recoveryEnabled: true });
  await assert.rejects(f.service.promote(f.caller, { ...input, expectedRevision: input.expectedRevision + 1 }), code('stale_revision'));
  await f.service.promote(f.caller, input);
  assert.deepEqual(f.repository.readTranscript('root').messages.map(message => message.content), ['Earlier text', 'Saved reply']);
  assert.equal(f.repository.getChat('root').composerDraft, 'Unsent draft');
});

test('live renderer owners and late ownership during capture cannot be taken over', async t => {
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; }), capture = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { capturing: async () => { entered(); await capture; } });
  f.setExternal(true);
  await assert.rejects(f.service.promote(f.caller, f.input()), code('ownership_conflict'));
  assert.equal(f.captures(), 0);
  f.setExternal(false);
  const pending = f.service.promote(f.caller, f.input()); await started;
  f.setExternal(true); release();
  await assert.rejects(pending, code('ownership_conflict'));
  assert.equal(f.repository.getChat('root').chatCommandVersion, undefined);
  assert.equal(f.repository.getLatestProfile('root'), null);
});

test('a competing save during profile capture cancels promotion without changing the legacy root', async t => {
  let f;
  f = await fixture(t, { capturing: () => {
    f.db.prepare('UPDATE chat_revisions SET revision=revision+1 WHERE chat_id=?').run('root');
  } });
  await assert.rejects(f.service.promote(f.caller, f.input()), code('stale_revision'));
  assert.equal(f.repository.getChat('root').chatCommandVersion, undefined);
  assert.equal(f.repository.getLatestProfile('root'), null);
});

test('rollback during profile capture commits no canonical marker or captured profile', async t => {
  let f;
  f = await fixture(t, { capturing: () => f.setGate(getOrdinaryChatExecutionFeature({ MINNOW_ORDINARY_CHAT_EXECUTION: '0' })) });
  await assert.rejects(f.service.promote(f.caller, f.input()), code('capability_unavailable'));
  assert.equal(f.repository.getChat('root').chatCommandVersion, undefined);
  assert.equal(f.repository.getLatestProfile('root'), null);
});

test('lost promotion receipts recover after database reopen and rollout rollback; canonical sends never downgrade', async t => {
  const f = await fixture(t), input = f.input();
  const receipt = await f.service.promote(f.caller, input);
  await f.restart(); f.setGate(getOrdinaryChatExecutionFeature({ MINNOW_ORDINARY_CHAT_EXECUTION: '0' }));
  assert.deepEqual(await f.service.promote(f.caller, input), { ...receipt, replayed: true });
  assert.equal((await f.service.ordinaryEligibility(f.caller, 'root')).route, 'server');
  await assert.rejects(f.service.promote(f.caller, { ...input, expectedRevision: input.expectedRevision + 1 }), code('idempotency_conflict'));
  const accepted = await f.service.send(f.caller, { chatId: 'root', message: 'Still server owned', clientRequestId: 'after-rollback' });
  assert.ok(accepted.commandId); assert.equal(f.repository.getChat('root').chatCommandVersion, 1);
});

test('devices observe routing but cannot promote, and legacy tool/native history is explicitly unsupported', async t => {
  const f = await fixture(t);
  const device = createChatCaller({ actor: 'human', ingress: 'device', chatId: 'device', scope: f.scope, policy: f.policy });
  assert.equal((await f.service.ordinaryEligibility(device, 'root')).route, 'legacy');
  await assert.rejects(f.service.promote(device, f.input()), code('caller_denied'));
  f.history([{ role: 'assistant', content: '', tool_calls: [{ id: 'old-effect', type: 'function', function: { name: 'save_file', arguments: '{}' } }] }]);
  assert.equal((await f.service.ordinaryEligibility(f.caller, 'root')).reason, 'legacy_history_unsupported');
  await assert.rejects(f.service.promote(f.caller, f.input()), code('capability_unavailable'));
});


test('settled historical tool groups promote as observations without dispatching past effects', async t => {
  const f = await fixture(t);
  const history = [{ role: 'user', content: 'Earlier task' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'old-effect', type: 'function', function: { name: 'save_file', arguments: '{"path":"earlier.txt","content":"saved"}' } }] },
    { role: 'tool', tool_call_id: 'old-effect', content: 'Saved' }, { role: 'assistant', content: 'Complete' }];
  f.history(history);
  let effects = 0;
  f.service.registerHost({ id: 'server', kind: 'server', execute: async () => { effects++; return { outcome: 'no_report' }; } });
  await f.service.promote(f.caller, f.input());
  assert.equal(effects, 0); assert.deepEqual(f.repository.readTranscript('root').messages, history);
});

test('Stop during profile capture prevents promotion without losing the saved transcript', async t => {
  let f;
  f = await fixture(t, { capturing: () => f.repository.advanceCancellationEpoch('root') });
  await assert.rejects(f.service.promote(f.caller, f.input()), code('ownership_conflict'));
  assert.equal(f.repository.getChat('root').chatCommandVersion, undefined);
  assert.equal(f.repository.getLatestProfile('root'), null);
});

test('promotion receipt failure atomically rolls back its profile and ownership marker', async t => {
  const f = await fixture(t), save = f.repository.putOutbox;
  f.repository.putOutbox = () => { throw new Error('receipt commit failed'); };
  await assert.rejects(f.service.promote(f.caller, f.input()), /receipt commit failed/);
  assert.equal(f.repository.getChat('root').chatCommandVersion, undefined);
  assert.equal(f.repository.getLatestProfile('root'), null);
  f.repository.putOutbox = save;
  assert.equal((await f.service.promote(f.caller, f.input())).disposition, 'promoted');
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { initSessionsSchema } from '../../server/config/sessions-schema.js';
import { createChatRepository, hashChatPayload } from '../../server/chats/repository.js';
import { createChatRequestService } from '../../server/chats/requests.js';
import { createChatCaller, createChatProjectRegistry, resolveProjectScope } from '../../server/chats/caller.js';
import { createChatPolicy } from '../../server/chats/policy.js';
import { upsertMessageRow } from '../../server/config/sessions-import.js';

const code = expected => error => error?.code === expected;
function fixture(t) {
  const db = new Database(':memory:'); db.pragma('foreign_keys=ON'); initSessionsSchema(db);
  const repository = createChatRepository({ db });
  repository.createChat({ id: 'legacy', name: 'Legacy', workspacePath: 'C:/fixture', providerId: 'provider', modelId: 'model', modeId: 'build' });
  db.prepare('DELETE FROM chat_conversation_state WHERE chat_id=?').run('legacy');
  upsertMessageRow(db, 'legacy', 0, { role: 'assistant', content: 'Unflushed legacy conversation context' });
  const registry = createChatProjectRegistry([{ projectId: 'project', workspaceId: 'workspace', canonicalKey: 'C:/fixture' }]);
  const scope = resolveProjectScope(registry, { projectId: 'project', workspaceKey: 'C:/fixture' });
  const policy = createChatPolicy({ modeId: 'build', workspaceIds: ['workspace'], toolPermissions: { chat_send: 'ask' },
    capabilities: ['execution.host', 'request.respond', 'chat.read', 'chat.send'] });
  const caller = createChatCaller({ actor: 'agent', ingress: 'tool', chatId: 'legacy', executionId: 'renderer-owner-execution',
    executionActive: true, scope, policy });
  const permitted = new WeakSet([caller]); let active = true;
  const runtimeRequests = createChatRequestService({ repository, pollMs: 10,
    assertLegacyOwner: candidate => active && permitted.has(candidate), authorizeResponse: (_request, context) => context?.human === true });
  const input = { caller, toolCallId: 'legacy-call', title: 'Allow chat_send?',
    presentation: { name: 'chat_send', argsHash: hashChatPayload({ chat_id: 'peer', message: 'Work' }), argsPreview: '{"chat_id":"peer"}' } };
  t.after(() => { runtimeRequests.expireExecution(caller.executionId, 'legacy', 'expired'); db.close(); });
  return { db, repository, runtimeRequests, caller, scope, policy, input, setActive: value => { active = value; } };
}

test('legacy approval is durably admitted under an exact owner check without claiming conversation or execution ownership', async t => {
  const f = fixture(t);
  const before = f.repository.readTranscript('legacy').messages;
  const request = f.runtimeRequests.openLegacy(f.input);
  assert.equal(f.repository.getChat('legacy').chatCommandVersion, undefined);
  assert.equal(f.repository.getExecution(f.caller.executionId), null);
  assert.deepEqual(f.repository.readTranscript('legacy').messages, before);
  let checkedInTransaction = false;
  const saved = f.repository.saveLegacyRequest({ ...request, requestId: 'transaction-proof' }, {
    assertOwner: () => { checkedInTransaction = f.db.inTransaction; return true; },
  });
  assert.equal(checkedInTransaction, true); assert.equal(saved.state, 'pending');
  const waiting = f.runtimeRequests.wait(request.requestId);
  await f.runtimeRequests.respond(request.requestId, { answerCommandId: 'allow-once', answer: { decision: 'allow_once' }, context: { human: true } });
  assert.deepEqual(await waiting, { decision: 'allow_once' });
  const retry = f.runtimeRequests.openLegacy(f.input);
  assert.equal(retry.requestId, request.requestId); assert.equal(retry.expiresAt, request.expiresAt);
  assert.equal(retry.state, 'answered');
  assert.deepEqual(await f.runtimeRequests.wait(retry.requestId), { decision: 'allow_once' });
  assert.throws(() => f.runtimeRequests.openLegacy({ ...f.input, presentation: { name: 'chat_send', argsHash: 'changed-input' } }), code('idempotency_conflict'));
});

test('a cloned or separately minted caller cannot forge a raw approval and a stale owner cannot approve or resume it', async t => {
  const f = fixture(t);
  assert.throws(() => f.runtimeRequests.openLegacy({ ...f.input, caller: { ...f.caller } }), code('caller_denied'));
  const other = createChatCaller({ actor: 'agent', ingress: 'tool', chatId: 'legacy', executionId: f.caller.executionId,
    executionActive: true, scope: f.scope, policy: f.policy });
  assert.throws(() => f.runtimeRequests.openLegacy({ ...f.input, caller: other }), code('caller_not_active'));
  const request = f.runtimeRequests.openLegacy(f.input);
  const waiting = assert.rejects(f.runtimeRequests.wait(request.requestId), code('request_expired'));
  f.setActive(false);
  await assert.rejects(f.runtimeRequests.respond(request.requestId, { answerCommandId: 'late-answer', answer: { decision: 'allow_once' }, context: { human: true } }), code('request_expired'));
  await waiting;
  assert.equal(f.repository.getRequest(request.requestId).state, 'expired');
  assert.equal(f.runtimeRequests.hasLiveWaiter(request.requestId), false);
});

test('release cancels a raw approval and process replacement expires orphan approvals while retaining ordinary durable questions', async t => {
  const f = fixture(t);
  const request = f.runtimeRequests.openLegacy(f.input);
  const waiting = assert.rejects(f.runtimeRequests.wait(request.requestId), code('request_expired'));
  f.runtimeRequests.expireExecution(f.caller.executionId, 'legacy', 'cancelled');
  await waiting; assert.equal(f.repository.getRequest(request.requestId).state, 'cancelled');
  const orphan = f.runtimeRequests.openLegacy({ ...f.input, toolCallId: 'orphaned-call' });
  f.repository.createChat({ id: 'managed', name: 'Managed', workspacePath: 'C:/fixture', providerId: 'provider', modelId: 'model', modeId: 'build' });
  const fence = f.repository.claimExecution({ chatId: 'managed', executionId: 'managed-execution', ownerId: 'server' });
  const question = f.runtimeRequests.open({ chatId: 'managed', executionId: fence.executionId, fence, toolCallId: 'question',
    kind: 'question', title: 'Durable question', presentation: {} });
  const replacement = createChatRequestService({ repository: f.repository, authorizeResponse: () => true });
  assert.deepEqual(replacement.expireUnownedLegacyApprovals().map(row => row.requestId), [orphan.requestId]);
  assert.equal(f.repository.getRequest(orphan.requestId).state, 'expired');
  assert.equal(f.repository.getRequest(question.requestId).state, 'pending');
  await replacement.respond(question.requestId, { answerCommandId: 'durable-answer', answer: 'Saved despite process replacement' });
  assert.equal(f.repository.readRequestAnswer(question.requestId), 'Saved despite process replacement');
  f.repository.updateExecution(fence.executionId, { status: 'completed' }, { fence }); f.repository.releaseLease('managed', fence);
});

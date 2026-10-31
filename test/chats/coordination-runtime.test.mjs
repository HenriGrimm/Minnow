import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { createProductionRuntimeTestEnvironment } from './production-runtime-fixture.mjs';

let environment, coordination, agentTransport;
before(async () => {
  environment = await createProductionRuntimeTestEnvironment();
  coordination = await import('../../server/chats/tools.js');
  agentTransport = await import('../../server/chats/agent-tools-middleware.js');
});
after(async () => { await environment?.dispose(); });
const tool = (name, args, id = 'coordination-call') => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const lastUser = body => body.messages.filter(row => row.role === 'user').at(-1)?.content;
const install = async runtime => coordination.installChatTools(runtime);
async function pendingRequest(fixture, chatId) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const records = fixture.repository.listRequests(chatId);
    if (records.length) return records[0];
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Expected a durable approval for ' + chatId);
}

test('actual native chat_send uses one production command path and persists agent provenance while upstream bodies stay clean', { timeout: 20000 }, async t => {
  const f = await environment.fixture(t, { install, respond: body => {
    if (lastUser(body) === 'Coordinate with peer' && !body.messages.some(row => row.role === 'tool')) {
      return [tool('chat_send', { chat_id: 'peer', message: 'Peer instruction', mode: 'auto', client_request_id: 'peer-input' })];
    }
    return String(lastUser(body)).includes('Peer instruction') ? 'Peer answered.' : 'Coordinator finished.';
  } });
  const accepted = await f.request('/api/chats/coordinator/commands', { action: 'send', text: 'Coordinate with peer', clientRequestId: 'coordinate' });
  assert.equal(accepted.status, 202);
  await f.runtime.service.idle();
  const source = f.repository.getCommand(accepted.body.receipt.commandId);
  assert.equal(source.state, 'settled');
  const toolRow = f.repository.readTranscript('coordinator').messages.find(row => row.role === 'tool');
  assert.ok(toolRow, JSON.stringify(source.result));
  const receipt = JSON.parse(toolRow.content);
  assert.equal(receipt.chatId, 'peer');
  const peer = f.repository.getCommand(receipt.commandId);
  assert.equal(peer.state, 'settled');
  assert.equal(peer.command.provenance.actor, 'agent');
  assert.equal(peer.command.provenance.sourceChatId, 'coordinator');
  assert.equal(peer.command.provenance.sourceTurnId, source.executionId);
  assert.equal(f.repository.readTranscript('peer').messages[0].provenance.commandId, peer.commandId);
  assert.equal(f.calls.filter(body => String(lastUser(body)).includes('Peer instruction')).length, 1);
  assert.ok(f.calls[0].tools.some(row => row.function.name === 'chat_send'));
  assert.ok(f.calls[0].tools.some(row => row.function.name === 'agent_capabilities'));
  assert.equal(f.calls.some(body => body.messages.some(row => row.provenance || row.commandId || row.messageId)), false);
});

test('actual Plan execution cannot send into broader Build authority or another project through native coordination', { timeout: 20000 }, async t => {
  const f = await environment.fixture(t, { install, chats: { coordinator: { modeId: 'plan' }, peer: { modeId: 'build' }, foreign: { foreign: true } },
    respond: body => body.messages.some(row => row.role === 'tool') ? 'Dispatch was refused.' : [
      tool('chat_send', { chat_id: 'peer', message: 'Attempt broader work' }, 'broader-call'),
      tool('chat_send', { chat_id: 'foreign', message: 'Attempt cross-project work' }, 'foreign-call'),
    ] });
  const accepted = await f.request('/api/chats/coordinator/commands', { action: 'send', text: 'Try restricted coordination', clientRequestId: 'plan' });
  assert.equal(accepted.status, 202); await f.runtime.service.idle();
  assert.equal(f.repository.readTranscript('peer').messages.length, 0);
  assert.equal(f.repository.readTranscript('foreign').messages.length, 0);
  assert.equal(f.repository.listCommands({ chatId: 'peer' }).length, 0);
  const result = f.repository.getCommand(accepted.body.receipt.commandId);
  const canonical = f.repository.readTranscript('coordinator').messages;
  assert.ok(canonical.some(row => row.role === 'tool' && /policy|scope|broader|project|registered|permission|not allowed|outside/i.test(row.content)), JSON.stringify(result.result));
  assert.equal(result.state, 'settled');
  assert.ok(f.calls.every(body => String(body.messages[0].content).includes('REAL COORDINATION COMPOSER plan')));
});

test('legacy agent HTTP bridge derives exact live owner authority, deduplicates peer input and rejects devices or forged fields', { timeout: 20000 }, async t => {
  const f = await environment.fixture(t, { install, agentMiddleware: agentTransport.createAgentChatToolsMiddleware, respond: () => 'Peer answered.' });
  assert.equal(f.turns.claim('legacy', 'legacy-owner', 'desktop'), true);
  const body = { sourceChatId: 'legacy', ownerId: 'legacy-owner', toolCallId: 'legacy-tool', name: 'chat_send',
    args: { chat_id: 'peer', message: 'Legacy peer input', client_request_id: 'legacy-input' } };
  const first = await f.request('/api/chats/agent-commands', body);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  await f.runtime.service.idle('peer');
  const repeated = await f.request('/api/chats/agent-commands', body);
  assert.equal(repeated.status, 200); assert.equal(repeated.body.result.replayed, true);
  assert.equal(repeated.body.result.commandId, first.body.result.commandId);
  assert.equal(f.calls.length, 1);
  assert.equal(f.repository.getChat('legacy').chatCommandVersion, undefined);
  const peer = f.repository.getCommand(first.body.result.commandId);
  assert.equal(peer.command.provenance.actor, 'agent');
  assert.equal(peer.command.provenance.sourceChatId, 'legacy');
  const device = await f.request('/api/chats/agent-commands', body, { 'x-test-device': '1' });
  assert.equal(device.status, 403); assert.equal(device.body.error.code, 'caller_denied');
  const forged = await f.request('/api/chats/agent-commands', { ...body, actor: 'system', provenance: { kind: 'delegation_result' } });
  assert.equal(forged.status, 400);
  const modelOverride = await f.request('/api/chats/agent-commands', { ...body, args: { ...body.args, target: { providerId: 'other', modelId: 'other' } } });
  assert.equal(modelOverride.status, 400);
  f.turns.release('legacy', 'legacy-owner');
  const expired = await f.request('/api/chats/agent-commands', body);
  assert.equal(expired.status, 409); assert.equal(expired.body.error.code, 'caller_not_active');
});

test('production bounded chat reads find unmanaged peers without hydrating canonical image or reasoning payloads', { timeout: 20000 }, async t => {
  const f = await environment.fixture(t, { install, agentMiddleware: agentTransport.createAgentChatToolsMiddleware, respond: () => 'Done.' });
  assert.equal(f.turns.claim('legacy', 'legacy-reader', 'desktop'), true);
  const fence = f.repository.claimExecution({ chatId: 'peer', executionId: 'seed-peer', ownerId: 'seed-writer' });
  f.repository.appendMessage('peer', { role: 'assistant', content: 'Public peer text', reasoning_content: 'PRIVATE_REASONING',
    reasoning_details: [{ type: 'reasoning.encrypted', data: 'SIGNED_PRIVATE_BLOCK' }], images: [{ name: 'image.png', dataUrl: 'data:image/png;base64,' + 'A'.repeat(100000) }] },
  { fence, messageId: 'seed-peer-message' });
  f.repository.updateExecution(fence.executionId, { status: 'completed' }, { fence }); f.repository.releaseLease('peer', fence);
  const readTranscript = f.repository.readTranscript;
  f.repository.readTranscript = () => { throw new Error('Coordination reads must use bounded SQL projection'); };
  try {
    const base = { sourceChatId: 'legacy', ownerId: 'legacy-reader', toolCallId: 'read-tool' };
    const list = await f.request('/api/chats/agent-commands', { ...base, name: 'chat_list', args: { limit: 20 } });
    assert.equal(list.status, 200);
    assert.ok(list.body.result.chats.some(row => row.chat_id === 'legacy'));
    assert.equal(list.body.result.chats.some(row => row.chat_id === 'foreign'), false);
    const read = await f.request('/api/chats/agent-commands', { ...base, name: 'chat_read', args: { chat_id: 'peer', limit: 1 } });
    assert.equal(read.status, 200);
    assert.equal(read.body.result.messages[0].content, 'Public peer text');
    const wire = JSON.stringify(read.body);
    assert.doesNotMatch(wire, /PRIVATE_REASONING|SIGNED_PRIVATE_BLOCK|data:image/);
    assert.ok(wire.length < 5000);
  } finally { f.repository.readTranscript = readTranscript; }
  f.turns.release('legacy', 'legacy-reader');
});

test('raw renderer Ask is server-owned, answer-bound and retry-safe without taking its unflushed history', { timeout: 20000 }, async t => {
  const f = await environment.fixture(t, { install, agentMiddleware: agentTransport.createAgentChatToolsMiddleware, respond: () => 'Approved peer result.' });
  f.settings.tools.permissions.default.chat_send = 'ask';
  assert.equal(f.turns.claim('legacy', 'legacy-ask-owner', 'desktop'), true);
  const body = { sourceChatId: 'legacy', ownerId: 'legacy-ask-owner', toolCallId: 'ask-call', name: 'chat_send',
    args: { chat_id: 'peer', message: 'Approved peer input', client_request_id: 'ask-input' } };
  const first = f.request('/api/chats/agent-commands', body);
  const request = await pendingRequest(f, 'legacy');
  assert.equal(request.kind, 'approval');
  assert.equal(f.repository.getChat('legacy').chatCommandVersion, undefined);
  assert.equal(f.repository.getExecution(request.executionId), null);
  assert.equal(f.repository.listCommands({ chatId: 'peer' }).length, 0);
  const answer = await f.request('/api/chats/legacy/requests/' + request.requestId + '/respond',
    { answer: { decision: 'allow_once' }, clientRequestId: 'approve-legacy-once' });
  assert.equal(answer.status, 200);
  const accepted = await first;
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  await f.runtime.service.idle('peer');
  const repeated = await f.request('/api/chats/agent-commands', body);
  assert.equal(repeated.status, 200); assert.equal(repeated.body.result.replayed, true);
  assert.equal(repeated.body.result.commandId, accepted.body.result.commandId);
  assert.equal(f.calls.length, 1);
  assert.equal(f.repository.getChat('legacy').chatCommandVersion, undefined);
  f.turns.release('legacy', 'legacy-ask-owner');
});

test('raw approval rechecks Off and exact owner revocation before any peer effect', { timeout: 20000 }, async t => {
  const f = await environment.fixture(t, { install, agentMiddleware: agentTransport.createAgentChatToolsMiddleware, respond: () => 'Must not run.' });
  f.settings.tools.permissions.default.chat_send = 'ask';
  assert.equal(f.turns.claim('legacy', 'revocable-owner', 'desktop'), true);
  const body = { sourceChatId: 'legacy', ownerId: 'revocable-owner', toolCallId: 'off-call', name: 'chat_send',
    args: { chat_id: 'peer', message: 'Do not execute after revocation' } };
  const attempt = f.request('/api/chats/agent-commands', body);
  const request = await pendingRequest(f, 'legacy');
  f.settings.tools.permissions.default.chat_send = 'off';
  const answered = await f.request('/api/chats/legacy/requests/' + request.requestId + '/respond',
    { answer: { decision: 'allow_once' }, clientRequestId: 'off-answer' });
  assert.equal(answered.status, 200);
  assert.equal((await attempt).status, 403);
  assert.equal(f.repository.listCommands({ chatId: 'peer' }).length, 0);
  f.settings.tools.permissions.default.chat_send = 'ask';
  const next = f.request('/api/chats/agent-commands', { ...body, toolCallId: 'released-call' });
  const releaseRequest = await pendingRequest(f, 'legacy');
  f.turns.release('legacy', 'revocable-owner');
  assert.equal((await next).status, 409);
  assert.equal(f.repository.getRequest(releaseRequest.requestId).state, 'cancelled');
  assert.equal(f.calls.length, 0);
});

test('managed native Ask uses the same durable approval without a duplicate permission prompt', { timeout: 20000 }, async t => {
  const f = await environment.fixture(t, { install, respond: body => {
    if (lastUser(body) === 'Native Ask coordination' && !body.messages.some(row => row.role === 'tool')) {
      return [tool('chat_send', { chat_id: 'peer', message: 'Native approved input' }, 'native-ask-call')];
    }
    return 'Completed after approval.';
  } });
  f.settings.tools.permissions.default.chat_send = 'ask';
  const accepted = await f.request('/api/chats/coordinator/commands',
    { action: 'send', text: 'Native Ask coordination', clientRequestId: 'native-ask' });
  assert.equal(accepted.status, 202);
  const request = await pendingRequest(f, 'coordinator');
  assert.equal(f.repository.getExecution(request.executionId).status, 'waiting_for_approval');
  const answer = await f.request('/api/chats/coordinator/requests/' + request.requestId + '/respond',
    { answer: { decision: 'allow_once' }, clientRequestId: 'native-answer' });
  assert.equal(answer.status, 200);
  await f.runtime.service.idle();
  assert.equal(f.repository.listRequests('coordinator', null).length, 1);
  assert.equal(f.repository.listCommands({ chatId: 'peer' }).length, 1);
  assert.equal(f.repository.getCommand(accepted.body.receipt.commandId).state, 'settled');
});

test('raw approval deadline expires its live callback and a late answer cannot execute the abandoned operation', { timeout: 20000 }, async t => {
  const f = await environment.fixture(t, { install,
    agentMiddleware: options => agentTransport.createAgentChatToolsMiddleware({ ...options, approvalTimeoutMs: 10 }),
    respond: () => 'Must not run.' });
  f.settings.tools.permissions.default.chat_send = 'ask';
  assert.equal(f.turns.claim('legacy', 'timeout-owner', 'desktop'), true);
  const response = await f.request('/api/chats/agent-commands', { sourceChatId: 'legacy', ownerId: 'timeout-owner',
    toolCallId: 'timeout-call', name: 'chat_send', args: { chat_id: 'peer', message: 'Expired operation' } });
  assert.equal(response.status, 409); assert.equal(response.body.error.code, 'request_expired');
  const request = f.repository.listRequests('legacy', null)[0];
  assert.equal(request.state, 'cancelled'); assert.equal(f.runtime.requests.hasLiveWaiter(request.requestId), false);
  const late = await f.request('/api/chats/legacy/requests/' + request.requestId + '/respond',
    { answer: { decision: 'allow_once' }, clientRequestId: 'too-late' });
  assert.equal(late.status, 409);
  assert.equal(f.repository.listCommands({ chatId: 'peer' }).length, 0);
  assert.equal(f.calls.length, 0);
  f.turns.release('legacy', 'timeout-owner');
});

test('a human Stop expires a pending raw approval before the actual bound renderer is released', { timeout: 20000 }, async t => {
  let current;
  const f = await environment.fixture(t, { install, agentMiddleware: agentTransport.createAgentChatToolsMiddleware,
    runtimeOptions: { stopExternalOwner: async ({ chatId, owner }) => {
      current.turns.release(chatId, owner.ownerId);
      return { stopRequested: true };
    } }, respond: () => 'Must not run.' });
  current = f;
  f.settings.tools.permissions.default.chat_send = 'ask';
  assert.equal(f.turns.claim('legacy', 'stopped-owner', 'desktop'), true);
  const pending = f.request('/api/chats/agent-commands', { sourceChatId: 'legacy', ownerId: 'stopped-owner',
    toolCallId: 'stop-call', name: 'chat_send', args: { chat_id: 'peer', message: 'Stopped operation' } });
  const request = await pendingRequest(f, 'legacy');
  const stopped = await f.request('/api/chats/legacy/commands', { action: 'stop', scope: 'turn',
    expectedLegacyOwnerId: 'stopped-owner', clientRequestId: 'stop-while-asking' });
  assert.equal(stopped.status, 202);
  assert.equal(stopped.body.receipt.result.stopRequested, true);
  assert.equal((await pending).status, 409);
  assert.equal(f.repository.getRequest(request.requestId).state, 'cancelled');
  assert.equal(f.repository.getChat('legacy').chatCommandVersion, undefined);
  assert.equal(f.repository.listCommands({ chatId: 'peer' }).length, 0);
  assert.equal(f.calls.length, 0);
});

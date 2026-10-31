import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { initSessionsSchema } from '../../server/config/sessions-schema.js';
import { createChatRepository } from '../../server/chats/repository.js';
import { createChatPresentation } from '../../server/chats/presentation.js';
import { createChatTaskRepository } from '../../server/chats/task-repository.js';
import { createChatPolicy } from '../../server/chats/policy.js';

function fixture(t, options = {}) {
  const db = new Database(':memory:'); db.pragma('foreign_keys=ON'); initSessionsSchema(db);
  const repository = createChatRepository({ db, now: () => 1000 });
  for (const id of ['chat', 'sibling', 'foreign']) {
    repository.createChat({ id, name: id, workspacePath: 'C:/fixture', providerId: 'provider', modelId: 'model', modeId: 'build' });
    repository.ensureManagedChat(id, { projectId: id === 'foreign' ? 'other-project' : 'project' });
  }
  const presentation = createChatPresentation({ repository, now: () => 1000, flushMs: 5, ...options });
  t.after(() => { presentation.dispose(); db.close(); });
  function claim(id = 'execution', chatId = 'chat') {
    return repository.claimExecution({ chatId, executionId: id, ownerId: 'server-host' });
  }
  function settle(fence, status = 'completed', chatId = 'chat') {
    repository.updateExecution(fence.executionId, { status }, { fence }); repository.releaseLease(chatId, fence);
  }
  return { db, repository, presentation, claim, settle };
}
function notification(presentation, input, predicate = () => true) {
  let unsubscribe, timer;
  const promise = new Promise((resolve, reject) => {
    timer = setTimeout(() => { unsubscribe?.(); reject(new Error('Expected presentation notification')); }, 2000);
    unsubscribe = presentation.subscribe({ ...input, send: value => { if (predicate(value)) { clearTimeout(timer); resolve(value); } } });
  });
  return { promise, dispose: () => { clearTimeout(timer); unsubscribe?.(); } };
}

test('raw renderer approvals publish scoped request attention and reconnect without claiming or replacing its history', t => {
  const f = fixture(t);
  f.db.prepare('DELETE FROM chat_conversation_state WHERE chat_id=?').run('chat');
  const payload = { version: 1, requestId: 'raw-request', chatId: 'chat', executionId: 'raw-execution', toolCallId: 'call',
    kind: 'approval', state: 'pending', createdAt: 1, title: 'Approve coordination', presentation: { arguments: 'PRIVATE_ARGUMENTS' } };
  f.db.prepare('INSERT INTO chat_requests(request_id,chat_id,execution_id,state,payload_json,updated_at) VALUES(?,?,?,?,?,?)')
    .run(payload.requestId, payload.chatId, payload.executionId, 'pending', JSON.stringify(payload), 1);
  const own = [], other = [];
  f.presentation.subscribe({ projectId: 'project', chatId: 'chat', send: value => own.push(value) });
  f.presentation.subscribe({ projectId: 'other-project', send: value => other.push(value) });
  own.length = 0; other.length = 0;
  f.presentation.externalRequestChanged({ chatId: 'chat', projectId: 'project' });
  assert.equal(own.length, 1); assert.equal(other.length, 0);
  assert.equal(own[0].baseline, undefined, 'a newly opened raw approval is a live transition');
  assert.deepEqual(own[0].fields, { agentRequestSummary: [{ requestId: 'raw-request', kind: 'approval' }] });
  assert.equal(JSON.stringify(own).includes('PRIVATE_ARGUMENTS'), false);
  assert.equal(own[0].frame, undefined);
  assert.equal(f.repository.getChat('chat').chatCommandVersion, undefined);
  const reconnected = [];
  f.presentation.subscribe({ projectId: 'project', chatId: 'chat', send: value => reconnected.push(value) });
  assert.equal(reconnected[0].baseline, true, 'reconnection replays its current state silently');
  assert.equal(reconnected.filter(value => value.chatId === 'chat').length, 1);
  f.repository.settleRequest('raw-request', { state: 'cancelled', settledAt: 1000 });
  f.presentation.externalRequestChanged({ chatId: 'chat', projectId: 'project' });
  assert.deepEqual(own.at(-1).fields.agentRequestSummary, []);
  const later = [];
  f.presentation.subscribe({ projectId: 'project', chatId: 'chat', send: value => later.push(value) });
  assert.equal(later.some(value => value.chatId === 'chat'), false);
});

test('presentation selects the latest execution and transmits a bounded canonical tail without private profile bodies', t => {
  const f = fixture(t);
  const old = f.claim('older-execution');
  for (let index = 0; index < 25; index += 1) {
    f.repository.appendMessage('chat', { role: index % 2 ? 'assistant' : 'user', content: 'Canonical row ' + index },
      { fence: old, messageId: 'row-' + index });
  }
  f.settle(old);
  f.repository.saveProfile('chat', { profileId: 'private-profile', profileVersion: 1, snapshot: { prompt: 'PRIVATE_SYSTEM_PROMPT' } });
  const latest = f.claim('latest-execution');
  const frame = f.presentation.frame('chat');
  assert.equal(frame.fields.agentExecution.executionId, latest.executionId);
  assert.equal(frame.running, true);
  assert.deepEqual({ start: frame.history.start, length: frame.history.length, count: frame.history.messages.length }, { start: 5, length: 25, count: 20 });
  assert.equal(frame.history.messages[0].content, 'Canonical row 5');
  assert.equal(frame.history.messages.at(-1).content, 'Canonical row 24');
  assert.equal(JSON.stringify(frame).includes('PRIVATE_SYSTEM_PROMPT'), false);
  assert.equal(frame.fields.profileReference.profileVersion, 1);
  assert.equal(f.presentation.frame('chat', { history: false }).history, undefined);
});

test('active frames distinguish next-message model controls from captured work and expose only the saved authority ceiling', t => {
  const f = fixture(t), selection = { providerId: 'provider', modelId: 'next', options: { reasoningEffort: 'high', thinkingMode: 'on', thinkingBudgetTokens: 2048 } };
  const captured = { providerId: 'provider', modelId: 'running', options: { reasoningEffort: 'low' } };
  const policy = createChatPolicy({ modeId: 'plan', workspaceIds: ['workspace'], toolPermissions: { read_file: 'full', save_file: 'ask' },
    toolEffects: { read_file: 'read', save_file: 'file-write' }, fileWriteScope: 'plans', filesystemAccess: 'workspace', shellSandboxMode: 'require' });
  f.repository.saveProfile('chat', { profileId: 'profile', profileVersion: 1, snapshot: { modelSelection: selection, policy,
    prompt: { system: 'PRIVATE_PROMPT', config: { privateValue: 'PRIVATE_CONFIG' } } } });
  f.repository.claimExecution({ chatId: 'chat', executionId: 'captured-execution', ownerId: 'server-host', captured: { modelSelection: captured } });
  f.repository.admitCommand({ version: 1, chatId: 'chat', commandId: 'saved-queue', kind: 'send', requestedAt: 1, message: 'Queued', modelSelection: captured,
    provenance: { version: 1, actor: 'human', source: 'composer', kind: 'human_message' } }, { producerId: 'human', requestKey: 'saved-queue' });
  const frame = f.presentation.frame('chat');
  assert.deepEqual(frame.fields.agentModelSelection, selection);
  assert.deepEqual(frame.fields.agentExecution.modelSelection, captured);
  assert.deepEqual(frame.fields.pendingMessageQueue[0].modelSelection, captured);
  assert.equal(frame.fields.reasoningEffort, 'high'); assert.equal(frame.fields.thinkingMode, 'on');
  assert.deepEqual(frame.fields.agentAuthority, { modeId: policy.modeId, filesystemAccess: policy.filesystemAccess,
    fileWriteScope: policy.fileWriteScope, shellSandboxMode: 'require', toolPermissions: { ...policy.toolPermissions } });
  assert.equal(frame.fields.agentAuthority.workspaceIds, undefined);
  assert.equal(JSON.stringify(frame).includes('PRIVATE_'), false);
});

test('live token bursts are coalesced for scoped observers and never become canonical transcript rows', async t => {
  const f = fixture(t), fence = f.claim(), focused = [], summaries = [], foreign = [];
  f.presentation.subscribe({ projectId: 'project', chatId: 'chat', send: value => focused.push(value) });
  f.presentation.subscribe({ projectId: 'project', send: value => summaries.push(value) });
  f.presentation.subscribe({ projectId: 'other-project', chatId: 'chat', send: value => foreign.push(value) });
  const initialChanges = f.db.prepare('SELECT total_changes() AS count').get().count;
  const delivered = notification(f.presentation, { projectId: 'project', chatId: 'chat' }, value => Boolean(value.frame?.live));
  f.presentation.onEvent({ chatId: 'chat', executionId: fence.executionId, event: { type: 'round_start' } });
  for (let index = 1; index <= 100; index += 1) {
    f.presentation.onEvent({ chatId: 'chat', executionId: fence.executionId, event: { type: 'delta', text: 'Tokens ' + index } });
  }
  const frame = (await delivered.promise).frame; delivered.dispose();
  assert.equal(frame.live.lastDelta, 'Tokens 100');
  assert.equal(focused.length, 2);
  assert.equal(summaries.length, 2);
  assert.equal(summaries[0].kind, 'chat-changed');
  assert.equal(JSON.stringify(summaries).includes('Tokens'), false);
  assert.equal(foreign.length, 0);
  assert.equal(f.repository.readTranscript('chat').messages.length, 0);
  assert.equal(f.db.prepare('SELECT total_changes() AS count').get().count, initialChanges);
  const liveOnly = notification(f.presentation, { projectId: 'project', chatId: 'chat' },
    value => value.frame?.live?.lastDelta === 'Final live text');
  const beforeSummaries = summaries.length;
  const originals = Object.fromEntries(['getChat', 'readTranscript', 'listCommands', 'listRequests'].map(name => [name, f.repository[name]]));
  for (const name of Object.keys(originals)) f.repository[name] = () => { throw new Error('Live-only frames cannot read ' + name); };
  f.presentation.onEvent({ chatId: 'chat', executionId: fence.executionId, event: { type: 'delta', text: 'Final live text' } });
  const liveFrame = (await liveOnly.promise).frame;
  assert.equal(liveFrame.history, undefined); assert.equal(liveFrame.fields, undefined);
  assert.equal(summaries.length, beforeSummaries);
  Object.assign(f.repository, originals); liveOnly.dispose();
});

test('paused and stopping executions carry explicit activity without a generating spinner or stale live prose', t => {
  const f = fixture(t), fence = f.claim();
  const event = value => f.presentation.onEvent({ chatId: 'chat', executionId: fence.executionId, event: value });
  event({ type: 'round_start' }); event({ type: 'delta', text: 'Previously generating' });
  for (const status of ['waiting', 'waiting_for_model', 'waiting_for_agents', 'waiting_for_input', 'waiting_for_approval', 'waiting_for_host', 'stopping', 'recovery_required']) {
    f.repository.updateExecution(fence.executionId, { status }, { fence });
    const frame = f.presentation.frame('chat');
    assert.equal(frame.fields.agentExecution.status, status);
    assert.equal(frame.running, false, status);
    assert.equal(frame.live, null, status);
    assert.equal(frame.fields.turnError, status === 'recovery_required');
  }
});

test('late events and terminal notifications from an old execution cannot overwrite or clear the current stream', t => {
  const f = fixture(t), older = f.claim('older');
  f.presentation.onEvent({ chatId: 'chat', executionId: older.executionId, event: { type: 'round_start' } });
  f.presentation.onEvent({ chatId: 'chat', executionId: older.executionId, event: { type: 'delta', text: 'Old stream' } });
  f.settle(older);
  const latest = f.claim('latest');
  assert.equal(f.presentation.frame('chat').live, null);
  f.presentation.onEvent({ chatId: 'chat', executionId: latest.executionId, event: { type: 'round_start' } });
  f.presentation.onEvent({ chatId: 'chat', executionId: latest.executionId, event: { type: 'delta', text: 'Current stream' } });
  f.presentation.onEvent({ chatId: 'chat', executionId: older.executionId, event: { type: 'delta', text: 'Late stale stream' } });
  assert.equal(f.presentation.frame('chat').live.lastDelta, 'Current stream');
  f.presentation.onServiceEvent({ type: 'execution', chatId: 'chat', executionId: older.executionId, status: 'completed' });
  assert.equal(f.presentation.frame('chat').live.lastDelta, 'Current stream');
});

test('each pending human request and held command remains independently visible with its stable identity', t => {
  const f = fixture(t), fence = f.claim();
  for (const [requestId, kind] of [['first-question', 'question'], ['second-approval', 'approval']]) {
    f.repository.saveRequest({ version: 1, requestId, kind, chatId: 'chat', executionId: fence.executionId,
      toolCallId: requestId, title: requestId, presentation: {}, createdAt: 1000, state: 'pending' }, { fence });
  }
  const provenance = { version: 1, actor: 'human', source: 'composer', kind: 'human_message' };
  f.repository.admitCommand({ version: 1, commandId: 'queued-input', chatId: 'chat', kind: 'send', message: 'Queued work',
    requestedAt: 1000, provenance }, { producerId: 'human', requestKey: 'queued' });
  f.repository.holdQueuedCommands('chat');
  const frame = f.presentation.frame('chat');
  assert.deepEqual(frame.fields.agentRequests.map(row => row.requestId).sort(), ['first-question', 'second-approval']);
  assert.equal(frame.fields.pendingMessageQueue[0].id, 'queued-input');
  assert.equal(frame.fields.pendingMessageQueue[0].held, true);
  assert.equal(frame.fields.pendingMessageQueue[0].commandRevision, 1);
});

test('initial project activity replay is bounded, lightweight and ignores an older active-looking execution', t => {
  const f = fixture(t);
  for (let index = 0; index < 105; index += 1) {
    const chatId = 'active-' + String(index).padStart(3, '0');
    f.repository.createChat({ id: chatId, name: chatId, workspacePath: 'C:/fixture', providerId: 'provider', modelId: 'model', modeId: 'build' });
    f.repository.ensureManagedChat(chatId, { projectId: 'project' });
    f.repository.createExecution({ chatId, executionId: 'active-execution-' + index, captured: { prompt: 'PRIVATE_PROFILE' } });
  }
  f.repository.createExecution({ chatId: 'chat', executionId: 'stale-queued' });
  const latest = f.claim('newer-completed'); f.settle(latest);
  const attention = f.claim('attention', 'sibling');
  f.repository.saveRequest({ version: 1, requestId: 'attention-question', kind: 'question', chatId: 'sibling',
    executionId: attention.executionId, toolCallId: 'question', title: 'PRIVATE_QUESTION_BODY', presentation: { question: 'PRIVATE_QUESTION_BODY' },
    createdAt: 1000, state: 'pending' }, { fence: attention });
  const all = [], foreign = [];
  f.presentation.subscribe({ projectId: 'project', send: value => all.push(value) });
  f.presentation.subscribe({ projectId: 'other-project', send: value => foreign.push(value) });
  assert.equal(all.length, 100); assert.equal(foreign.length, 0);
  assert.ok(all.every(value => value.kind === 'chat-changed' && value.fields && !value.history && !value.frame));
  assert.equal(all.some(value => value.chatId === 'chat'), false);
  assert.equal(JSON.stringify(all).includes('PRIVATE_PROFILE'), false);
  assert.equal(JSON.stringify(all).includes('PRIVATE_QUESTION_BODY'), false);
  assert.deepEqual(all.find(value => value.chatId === 'sibling').fields.agentRequestSummary,
    [{ requestId: 'attention-question', kind: 'question' }]);
  assert.deepEqual(f.repository.listActiveChatIds({ projectId: 'project', limit: 1 }), ['sibling']);
  assert.throws(() => f.repository.listActiveChatIds({ projectId: 'project', limit: 101 }), error => error.code === 'invalid_request');
});

test('unresolved current-epoch tasks project separate attention after the parent turn ends and never fabricate a live spinner', t => {
  const f = fixture(t), fence = f.claim(); f.settle(fence);
  const tasks = createChatTaskRepository({ repository: f.repository });
  for (const runId of ['child-one', 'child-two']) tasks.ensureSubscription({ runId, policy: { version: 1, kind: 'wake_delegator',
    recipientChatId: 'chat', subscriptionId: 'wake-' + runId, cancellationEpoch: 0 } });
  const frame = f.presentation.frame('chat');
  assert.equal(frame.fields.agentExecution.status, 'completed');
  assert.equal(frame.running, false);
  assert.deepEqual(frame.fields.agentTaskAttention, { status: 'waiting_for_agents', pendingCount: 2 });
  const notices = [];
  f.presentation.subscribe({ projectId: 'project', send: value => notices.push(value) });
  assert.deepEqual(notices[0].fields.agentTaskAttention, frame.fields.agentTaskAttention);
  f.repository.advanceCancellationEpoch('chat');
  assert.equal(f.presentation.frame('chat').fields.agentTaskAttention, null);
});

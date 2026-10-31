import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { initSessionsSchema } from '../../server/config/sessions-schema.js';
import { createChatRepository } from '../../server/chats/repository.js';
import { createChatRequestService } from '../../server/chats/requests.js';
import { createChatQuestionRecovery } from '../../server/chats/question-recovery.js';
import { createChatTranscriptStore } from '../../server/chats/transcript-store.js';

function fixture(t, { effect = false, toolName = 'ask_question', proof = true, disk = false } = {}) {
  const directory = disk ? fs.mkdtempSync(path.join(os.tmpdir(), 'minnow-question-reopen-')) : null;
  const filename = directory ? path.join(directory, 'sessions.db') : ':memory:';
  let db = new Database(filename); initSessionsSchema(db);
  let repository = createChatRepository({ db });
  repository.createChat({ id: 'chat', workspacePath: '/fixture' });
  const command = { version: 1, commandId: 'command', chatId: 'chat', kind: 'send', mode: 'auto', message: 'Task', requestedAt: 1000,
    provenance: { version: 1, actor: 'human', source: 'composer', kind: 'human_message' } };
  repository.admitCommand(command, { producerId: 'human', requestKey: 'one' });
  const old = repository.claimExecution({ chatId: 'chat', commandId: 'command', executionId: 'execution', ownerId: 'old-server' });
  repository.updateCommand('command', { state: 'running', executionId: 'execution' });
  repository.appendMessage('chat', { role: 'assistant', content: '', tool_calls: [{ id: 'question-call', type: 'function',
    function: { name: toolName, arguments: '{}' } }] }, { fence: old, messageId: 'saved-call' });
  repository.saveRequest({ version: 1, requestId: 'question', chatId: 'chat', executionId: 'execution', toolCallId: 'question-call',
    kind: 'question', state: 'pending', title: 'Choose', presentation: { question: 'Which?' }, createdAt: 1000 }, { fence: old });
  if (effect) repository.recordToolIntent({ invocationId: 'unknown-effect', chatId: 'chat', executionId: 'execution',
    toolCallId: 'other-call', toolName: 'save_file', input: { path: 'maybe-written.txt' } }, { fence: old });
  repository.updateExecution('execution', { status: 'waiting_for_input' }, { fence: old });
  if (disk) { db.close(); db = new Database(filename); initSessionsSchema(db); repository = createChatRepository({ db }); }
  const requests = createChatRequestService({ repository, authorizeResponse: () => true });
  const recovery = createChatQuestionRecovery({ repository, requests, verifyQuiescence: () => proof
    ? { verified: true, source: 'isolated-replacement-process', checkedAt: Date.now() } : null });
  t.after(() => { db.close(); if (directory) {
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(directory, { recursive: true, force: true });
  } });
  return { repository, requests, recovery, old };
}

test('question receipt and original execution resume through actual database close/reopen with one canonical tool answer', async t => {
  const f = fixture(t, { disk: true });
  const result = await f.recovery.beforeExecutionRecovery({ reason: 'startup' });
  assert.deepEqual([...result.heldExecutionIds], ['execution']);
  assert.equal(f.repository.getExecution('execution').status, 'waiting_for_input');
  assert.equal(f.repository.getLease('chat').state, 'released');
  await f.requests.respond('question', { answerCommandId: 'answer', answer: { version: 'two' } });
  const fence = f.repository.claimExecution({ chatId: 'chat', executionId: 'execution', ownerId: 'new-server' });
  assert.ok(fence.epoch > f.old.epoch);
  const transcript = createChatTranscriptStore({ repository: f.repository, chatId: 'chat', fence });
  await f.recovery.hydrate({ execution: f.repository.getExecution('execution'), fence, transcript, signal: new AbortController().signal,
    assertAllowed: async () => {}, status: status => f.repository.updateExecution('execution', { status }, { fence }) });
  assert.deepEqual(f.repository.readTranscript('chat').messages.filter(row => row.role === 'tool').map(row => JSON.parse(row.content)), [{ version: 'two' }]);
  assert.equal(f.repository.getExecution('execution').captured.questionResume, undefined);
});

test('an unverifiable or live owner retains its question and fence without transparent takeover', async t => {
  const f = fixture(t, { proof: false });
  assert.equal((await f.recovery.beforeExecutionRecovery()).heldExecutionIds.size, 0);
  assert.equal(f.repository.getLease('chat').epoch, f.old.epoch);
  assert.equal(f.repository.getLease('chat').state, 'active'); assert.equal(f.repository.getRequest('question').state, 'pending');
});

for (const options of [{ effect: true }, { toolName: 'save_file' }]) test(`unknown or unmatched tool effects prevent question resumption (${options.effect ? 'unsettled intent' : 'wrong canonical call'})`, async t => {
  const f = fixture(t, options);
  assert.equal((await f.recovery.beforeExecutionRecovery()).heldExecutionIds.size, 0);
  assert.equal(f.repository.getRequest('question').state, 'expired');
  assert.equal(f.recovery.canResume(f.repository.getExecution('execution')), false);
  const recovered = f.repository.recoverExecution('execution', { fence: f.old,
    quiescence: { verified: true, source: 'isolated-replacement-process', checkedAt: Date.now() } });
  assert.equal(recovered.status, options.effect ? 'recovery_required' : 'failed');
  if (options.effect) assert.equal(f.repository.listUnsettledToolInvocations('execution').length, 1);
});

test('detached archive imports never turn a saved question into execution authority', async t => {
  const f = fixture(t);
  assert.equal((await f.recovery.beforeExecutionRecovery({ reason: 'import' })).heldExecutionIds.size, 0);
  assert.equal(f.repository.getLease('chat').epoch, f.old.epoch);
  assert.equal(f.recovery.canResume(f.repository.getExecution('execution')), false);
});

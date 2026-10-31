import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { initSessionsSchema } from '../../server/config/sessions-schema.js';
import { createChatRepository } from '../../server/chats/repository.js';
import { normalizeChatRow } from '../../src/state/session-schema.mjs';

const human = { version: 1, actor: 'human', source: 'composer', kind: 'human_message' };
function fixture(t, disk = false) {
  const scratch = disk ? mkdtempSync(join(tmpdir(), 'minnow-activity-')) : null;
  const filename = scratch ? join(scratch, 'sessions.db') : ':memory:';
  let db, repository;
  function open() {
    db = new Database(filename); db.pragma('foreign_keys=ON'); initSessionsSchema(db);
    repository = createChatRepository({ db, now: () => 1000 });
    for (const id of ['parent', 'child']) if (!db.prepare('SELECT 1 FROM chats WHERE id=?').get(id)) repository.createChat({ id, name: id,
      providerId: 'provider', modelId: 'configured-next', modeId: 'build', workspacePath: '/fixture' });
  }
  open(); t.after(() => { if (db.open) db.close(); if (scratch) rmSync(scratch, { recursive: true, force: true }); });
  return { get db() { return db; }, get repository() { return repository; },
    reopen() { db.close(); open(); },
    claim(executionId, extra = {}) { return repository.claimExecution({ chatId: 'child', executionId, ownerId: 'host',
      captured: { modelSelection: { providerId: 'saved', modelId: 'captured-model', options: { reasoningEffort: 'high' } }, ...extra } }); },
    command(commandId, extra = {}) {
      const record = repository.admitCommand({ version: 1, commandId, chatId: 'child', kind: 'send', mode: 'auto',
        requestedAt: 1000, message: 'private input body', provenance: human }, { producerId: 'human', requestKey: commandId });
      return repository.updateCommand(record.commandId, { state: 'queued', ...extra });
    } };
}

test('canonical lightweight activity distinguishes old executions from the exact pending assignment and survives reopen', t => {
  const f = fixture(t, true); const old = f.claim('old');
  f.repository.updateExecutionActivity('old', { resolvedModel: { providerId: 'actual', modelId: 'actual-model' },
    contextUsage: { used: 123, limit: 32000, isEstimate: false } }, { fence: old });
  f.repository.updateExecution('old', { status: 'completed' }, { fence: old }); f.repository.releaseLease('child', old);
  f.command('first-pending', { runId: 'next-task', held: true, error: { code: 'workspace_denied' } });
  f.command('second-pending');
  const before = f.repository.getActivity('child');
  assert.equal(before.agentExecution.executionId, 'old'); assert.equal(before.agentExecution.status, 'completed');
  assert.deepEqual(before.agentPendingCommand, { commandId: 'first-pending', runId: 'next-task', state: 'queued', held: true, errorCode: 'workspace_denied' });
  assert.equal(before.agentExecution.modelSelection.modelId, 'captured-model');
  assert.equal(before.agentExecution.resolvedModel.modelId, 'actual-model');
  assert.equal(before.agentExecution.contextUsage.used, 123);
  assert.doesNotMatch(JSON.stringify(before), /private input body|snapshot|policy/);
  f.reopen(); assert.deepEqual(f.repository.getActivity('child'), before);
  const shell = normalizeChatRow({ ...f.repository.getChat('child'), history: [] });
  assert.equal(shell.agentPendingCommand.commandId, 'first-pending'); assert.equal(shell.agentExecution.modelSelection.modelId, 'captured-model');
  assert.deepEqual(shell.agentActivityCursor, before.agentActivityCursor);
});

test('questions and approvals remain separate bounded summaries without exposing answer or tool argument bodies', t => {
  const f = fixture(t); const fence = f.claim('current');
  for (const kind of ['question', 'approval']) f.repository.saveRequest({ version: 1, requestId: kind, chatId: 'child', executionId: 'current',
    toolCallId: 'tool-' + kind, kind, state: 'pending', title: 'PRIVATE TITLE', createdAt: 1000, presentation: { secret: 'PRIVATE BODY' } }, { fence });
  const activity = f.repository.getActivity('child');
  assert.deepEqual(activity.agentRequestSummary, [{ requestId: 'approval', kind: 'approval' }, { requestId: 'question', kind: 'question' }]);
  assert.doesNotMatch(JSON.stringify(activity), /PRIVATE/);
  f.repository.respondToRequest('question', { answerCommandId: 'answer', answer: 'SECRET ANSWER' });
  assert.deepEqual(f.repository.getActivity('child').agentRequestSummary, [{ requestId: 'approval', kind: 'approval' }]);
});

test('opening a running turn cannot acknowledge its later failure and stale cursors cannot hide a newer completion', t => {
  const f = fixture(t, true); const first = f.claim('first');
  const runningCursor = f.repository.getActivity('child').agentActivityCursor;
  assert.equal(runningCursor.executionId, null);
  assert.equal(f.repository.acknowledgeActivity('child', runningCursor).unread, false);
  f.repository.updateExecution('first', { status: 'failed' }, { fence: first });
  f.repository.releaseLease('child', first);
  let activity = f.repository.getActivity('child');
  assert.equal(activity.unread, true); assert.equal(activity.turnError, true);
  activity = f.repository.acknowledgeActivity('child', runningCursor);
  assert.equal(activity.unread, true); assert.equal(activity.turnError, true);
  const oldCursor = activity.agentActivityCursor;
  f.repository.acknowledgeActivity('child', oldCursor);
  assert.equal(f.repository.getActivity('child').turnError, false);
  const second = f.claim('second');
  f.repository.appendMessage('child', { role: 'assistant', content: 'New response' }, { fence: second, messageId: 'new-response' });
  f.repository.updateExecution('second', { status: 'completed' }, { fence: second }); f.repository.releaseLease('child', second);
  activity = f.repository.acknowledgeActivity('child', oldCursor);
  assert.equal(activity.unread, true); assert.equal(activity.agentExecution.executionId, 'second');
  const visible = activity.agentActivityCursor; f.reopen();
  assert.equal(f.repository.getActivity('child').unread, true);
  assert.equal(f.repository.acknowledgeActivity('child', visible).unread, false);
  f.reopen(); assert.equal(f.repository.getActivity('child').unread, false);
  assert.throws(() => f.repository.acknowledgeActivity('child', { messageSeq: 999, executionId: 'second' }), error => error.code === 'stale_revision');
  f.repository.claimExecution({ chatId: 'parent', executionId: 'foreign', ownerId: 'host' });
  assert.throws(() => f.repository.acknowledgeActivity('child', { ...visible, executionId: 'foreign' }), error => error.code === 'invalid_request');
});

test('canonical incoming peer/result messages create per-chat unread state while a human input does not', t => {
  const f = fixture(t); const fence = f.claim('current');
  f.repository.appendMessage('child', { role: 'user', content: 'Human input', provenance: human }, { fence, messageId: 'human' });
  assert.equal(f.repository.getActivity('child').unread, false);
  const peer = { version: 1, actor: 'agent', source: 'agent_tool', kind: 'peer_message', sourceChatId: 'parent', sourceTurnId: 'parent-turn' };
  f.repository.appendMessage('child', { role: 'user', content: 'Peer instruction', provenance: peer }, { fence, messageId: 'peer' });
  assert.equal(f.repository.getActivity('child').unread, true);
  assert.equal(f.repository.getActivity('parent').unread, false);
  f.repository.acknowledgeActivity('child', f.repository.getActivity('child').agentActivityCursor);
  assert.equal(f.repository.getActivity('child').unread, false);
});

test('additive migration clears old active-execution read baselines instead of pre-acknowledging a later failure', t => {
  const f = fixture(t, true), fence = f.claim('active-before-migration');
  f.db.prepare('UPDATE chat_activity_reads SET execution_id=? WHERE chat_id=?').run('active-before-migration', 'child');
  f.reopen();
  assert.equal(f.db.prepare('SELECT execution_id FROM chat_activity_reads WHERE chat_id=?').get('child').execution_id, null);
  f.repository.updateExecution('active-before-migration', { status: 'failed' }, { fence });
  assert.equal(f.repository.getActivity('child').turnError, true);
});

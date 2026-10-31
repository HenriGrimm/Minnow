import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import Database from 'better-sqlite3';
import { initSessionsSchema } from '../../server/config/sessions-schema.js';
import { createChatRepository, hashChatPayload } from '../../server/chats/repository.js';
import { createChatOutbox } from '../../server/chats/outbox.js';
import { hashPayload } from '../../server/config/sessions-import.js';
import { closeSessionsDb } from '../../server/config/sessions-db.js';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import {
  patchSessionState, readChatHistory, readChatSummaries, readWholeSessionState, writeWholeSessionState,
} from '../../server/config/sessions-repo.js';

const opened = [];
afterEach(() => { for (const db of opened.splice(0)) { if (db.open) db.close(); } });
function setup(file = ':memory:') {
  const db = new Database(file);
  opened.push(db); db.pragma('foreign_keys = ON'); initSessionsSchema(db);
  let clock = 1000;
  const repository = createChatRepository({ db, now: () => clock });
  return { db, repository, advance: (ms) => { clock += ms; } };
}
const chat = (id) => ({
  id, name: id, workspacePath: 'C:/fixture', providerId: 'provider', modelId: 'model', modeId: 'build',
});
const provenance = { version: 1, actor: 'human', source: 'composer', kind: 'human_message' };
const command = (commandId, chatId = 'child', message = 'Read the repository') => ({
  version: 1, commandId, chatId, requestedAt: 1, kind: 'send', provenance, message,
});
function childInput(id = 'child') {
  return {
    chat: chat(id), projectId: 'project',
    relation: { version: 1, childChatId: id, parentChatId: 'parent', rootChatId: 'parent',
      journalOwnerId: 'family', origin: 'delegated', createdAt: 1,
      initialRunId: 'task', profileReference: { profileId: 'profile-' + id, profileVersion: 1 } },
    profile: { profileId: 'profile-' + id, profileVersion: 1, snapshot: {
      prompt: 'Private prompt snapshot', allowedTools: ['read_file'], authority: { modeId: 'plan' },
    } },
    command: command('initial-' + id, id), producerId: 'parent-execution', requestKey: 'spawn-' + id,
    outbox: [{ outboxId: 'spawn-' + id, chatId: id, kind: 'journal_append', payload: { runId: 'task', type: 'run.requested' } }],
  };
}
function running(repository, chatId = 'child', suffix = '') {
  return repository.claimExecution({ chatId, executionId: 'execution' + suffix, ownerId: 'host', captured: { providerId: 'provider', modelId: 'model' } });
}
function code(expected) { return (error) => error?.code === expected; }

describe('protected conversation creation and command admission', () => {
  it('atomically commits one child/profile/input/outbox and returns the same retry receipt', () => {
    const { repository, db } = setup();
    repository.createChat(chat('parent'));
    const input = childInput();
    const created = repository.createChild(input);
    assert.equal(created.chat.agentConversation.journalOwnerId, 'family');
    assert.equal(created.command.state, 'accepted');
    assert.equal(repository.getProfile('profile-child', 1).snapshot.prompt, 'Private prompt snapshot');
    const replay = repository.createChild(input);
    assert.equal(replay.replayed, true);
    assert.equal(replay.command.commandId, created.command.commandId);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM chat_relations').get().n, 1);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM chat_outbox').get().n, 1);
    assert.throws(() => repository.createChild({
      ...input, command: { ...input.command, message: 'Different assignment' },
    }), code('idempotency_conflict'));
  });

  it('rolls back the entire creation if a late outbox/profile step fails', () => {
    const { repository, db } = setup();
    const input = childInput();
    assert.throws(() => repository.createChild({
      ...input, outbox: [...input.outbox, { outboxId: 'bad', kind: 'journal_append', payload: { function() {} } }],
    }), code('invalid_request'));
    for (const table of ['chats', 'chat_relations', 'chat_execution_profiles', 'chat_commands', 'chat_outbox']) {
      assert.equal(db.prepare('SELECT COUNT(*) n FROM ' + table).get().n, 0, table);
    }
    assert.equal(repository.findCommandReceipt(input.producerId, input.requestKey), null);
    repository.createChild(input);
  });

  it('atomically captures a semantic spawn hash and replays its original model/profile before new resolution', () => {
    const { repository } = setup();
    const input = { ...childInput(), spawnIntentHash: hashChatPayload({ task: 'Read the repository', type: 'explore' }),
      captured: { policy: { captured: true }, completionPolicy: { version: 1, kind: 'local_only' } } };
    const first = repository.createChild(input);
    assert.equal(first.command.captured.spawnIntentHash, input.spawnIntentHash);
    const replay = repository.createChild({ ...input, command: { ...input.command, message: 'Newly resolved representation',
      modelSelection: { providerId: 'changed-catalog', modelId: 'changed-model' } } });
    assert.equal(replay.replayed, true);
    assert.equal(replay.command.command.message, input.command.message);
    assert.deepEqual(replay.command.captured.policy, { captured: true });
    assert.throws(() => repository.createChild({ ...input, spawnIntentHash: hashChatPayload({ task: 'Changed semantic intent' }) }), code('idempotency_conflict'));
    assert.throws(() => repository.createChild({ ...input, spawnIntentHash: 'not-a-hash' }), code('invalid_request'));
  });

  it('stores immutable profile versions and keeps prompt/inbox bodies out of lightweight listings', () => {
    const { repository } = setup();
    repository.createChild(childInput());
    assert.throws(() => repository.saveProfile('child', {
      profileId: 'profile-child', profileVersion: 1, snapshot: { prompt: 'Changed in place' },
    }), code('idempotency_conflict'));
    repository.saveProfile('child', { profileId: 'profile-child', profileVersion: 2, snapshot: { prompt: 'Next profile' } });
    assert.equal(repository.getLatestProfile('child').profileVersion, 2);
    const shells = repository.listChats({ projectId: 'project' });
    assert.equal(shells[0].chatCommandVersion, 1);
    assert.equal(shells[0].profileReference.profileVersion, 2);
    const serialized = JSON.stringify(shells);
    assert.equal(serialized.includes('Private prompt'), false);
    assert.equal(serialized.includes('Read the repository'), false);
    assert.equal(serialized.includes('snapshot'), false);
    assert.equal(repository.getRelation('child').missingParent, true);
    assert.equal(repository.listChats({ projectId: 'project', includeChildren: false }).length, 1, 'an orphan remains reachable');
  });

  it('configures next-turn model/profile and presentation atomically while preserving protected state', () => {
    const { repository } = setup();
    repository.createChild(childInput());
    const fence = running(repository);
    repository.appendMessage('child', { role: 'assistant', content: 'Canonical work' }, { fence, messageId: 'work' });
    const configured = repository.configureChat('child', {
      providerId: 'next-provider', modelId: 'next-model', modeId: 'plan', name: '  Human name  ',
    }, { expectedProfileVersion: 1, profile: {
      profileId: 'profile-child', profileVersion: 2, snapshot: { prompt: 'New snapshot', modelSelection: { providerId: 'next-provider', modelId: 'next-model' } },
    } });
    assert.equal(configured.name, 'Human name');
    assert.equal(configured.pinned, undefined);
    assert.equal(configured.profileReference.profileVersion, 2);
    assert.equal(configured.agentConversation.parentChatId, 'parent');
    assert.equal(repository.readTranscript('child').messages[0].content, 'Canonical work');
    assert.equal(repository.getProfile('profile-child', 1).snapshot.prompt, 'Private prompt snapshot');
    assert.throws(() => repository.configureChat('child', { name: 'Stale' }, { expectedProfileVersion: 1 }), code('stale_revision'));
    assert.throws(() => repository.configureChat('child', { name: 'Rollback' }, {
      profile: { profileId: 'profile-child', profileVersion: 2, snapshot: { prompt: 'Rewrite' } },
    }), code('idempotency_conflict'));
    assert.equal(repository.getChat('child').name, 'Human name');
    assert.throws(() => repository.configureChat('child', { pinned: true, name: 'Should roll back' }), code('invalid_request'));
    assert.equal(repository.getChat('child').name, 'Human name');
    repository.configureChat('child', { name: 'Renamed' });
    assert.equal(repository.getLatestProfile('child').profileVersion, 2);
    assert.equal(repository.getChat('child').pinnedAt, undefined);
    assert.throws(() => repository.configureChat('child', { pinned: 'false' }), code('invalid_request'));
  });

  it('supports managed roots without requiring a child relation', () => {
    const { repository, db } = setup();
    repository.createChat(chat('root'));
    const projected = repository.ensureManagedChat('root', {
      projectId: 'project', profile: { profileId: 'root-profile', profileVersion: 1, snapshot: { role: 'general' } },
    });
    assert.equal(projected.chatCommandVersion, 1);
    assert.equal(projected.agentConversation, undefined);
    assert.equal(repository.listChatShells({ projectId: 'project' })[0].id, 'root');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM chat_relations').get().n, 0);
  });

  it('deduplicates by producer/request while retaining target/body/options identity and FIFO ordering', () => {
    const { repository } = setup(); repository.createChat(chat('child'));
    const first = repository.admitCommand(command('first'), { producerId: 'source', requestKey: 'same-key' });
    const replay = repository.admitCommand({ ...command('new-allocation'), requestedAt: 9 }, { producerId: 'source', requestKey: 'same-key' });
    assert.equal(replay.commandId, 'first');
    assert.equal(replay.replayed, true);
    assert.throws(() => repository.admitCommand(command('changed', 'child', 'Changed'), { producerId: 'source', requestKey: 'same-key' }), code('idempotency_conflict'));
    assert.throws(() => repository.admitCommand(command('first'), { producerId: 'other', requestKey: 'same-key' }), code('idempotency_conflict'));
    const next = repository.admitCommand(command('second'), { producerId: 'source' });
    assert.ok(next.position > first.position);
    assert.deepEqual(repository.listCommands({ chatId: 'child' }).map((row) => row.commandId), ['first', 'second']);
  });

  it('edits only effective queued input with revision checks and preserves original retry hashes and captured model', () => {
    const { repository } = setup(); repository.createChat(chat('child'));
    const input = { ...command('first'), modelSelection: { providerId: 'provider', modelId: 'captured' } };
    const receipt = repository.admitCommand(input, { producerId: 'source' });
    const updated = repository.editQueuedCommand('first', { message: 'Corrected assignment', expectedRevision: receipt.revision });
    assert.equal(updated.command.message, input.message);
    assert.equal(updated.effectiveCommand.message, 'Corrected assignment');
    assert.deepEqual(updated.effectiveCommand.modelSelection, input.modelSelection);
    assert.equal(updated.inputHash, receipt.inputHash);
    assert.throws(() => repository.editQueuedCommand('first', { message: 'Stale', expectedRevision: 0 }), code('stale_revision'));
    repository.updateCommand('first', { state: 'running' });
    assert.throws(() => repository.editQueuedCommand('first', { message: 'Too late', expectedRevision: 2 }), code('stale_revision'));
    repository.updateCommand('first', { state: 'settled', result: { ok: true } });
    assert.throws(() => repository.updateCommand('first', { state: 'settled', error: { code: 'later' } }), code('idempotency_conflict'));
    assert.throws(() => repository.updateCommand('first', { state: 'running' }), code('idempotency_conflict'));
  });

  it('filters command state before applying a bounded page limit', () => {
    const { repository } = setup(); repository.createChat(chat('child'));
    repository.admitCommand(command('settled'), { producerId: 'source' });
    repository.updateCommand('settled', { state: 'settled' });
    repository.admitCommand(command('pending'), { producerId: 'source' });
    assert.equal(repository.listCommands({ states: ['accepted'], limit: 1 })[0].commandId, 'pending');
  });
});

describe('execution ownership and canonical transcript transactions', () => {
  it('blocks both concurrent and expired native owners until explicit settlement', () => {
    const { repository, advance } = setup(); repository.createChat(chat('child'));
    const fence = running(repository);
    assert.throws(() => repository.claimExecution({ chatId: 'child', executionId: 'other', ownerId: 'other-host' }), code('ownership_conflict'));
    advance(30001);
    assert.throws(() => repository.claimExecution({ chatId: 'child', executionId: 'other', ownerId: 'other-host' }), code('ownership_conflict'));
    assert.throws(() => repository.appendMessage('child', { role: 'assistant', content: 'stale' }, { fence, messageId: 'stale' }), code('ownership_conflict'));
    assert.throws(() => repository.releaseLease('child', fence), code('ownership_conflict'));
  });

  it('uses monotonic epochs and preserves captured execution configuration', () => {
    const { repository } = setup(); repository.createChat(chat('child'));
    repository.createExecution({ chatId: 'child', executionId: 'first', captured: { reasoningEffort: 'high' } });
    const fence = repository.claimExecution({ chatId: 'child', executionId: 'first', ownerId: 'host' });
    assert.equal(repository.getExecution('first').captured.reasoningEffort, 'high');
    repository.updateExecution('first', { status: 'completed' }, { fence });
    repository.releaseLease('child', fence);
    const next = repository.claimExecution({ chatId: 'child', executionId: 'second', ownerId: 'host' });
    assert.ok(next.epoch > fence.epoch);
    assert.throws(() => repository.releaseLease('child', fence), code('ownership_conflict'));
    assert.throws(() => repository.appendMessage('child', { role: 'assistant' }, { fence, messageId: 'old' }), code('ownership_conflict'));
    assert.throws(() => repository.createExecution({ chatId: 'child', executionId: 'first', captured: { reasoningEffort: 'low' } }), code('idempotency_conflict'));
  });

  it('recovers an expired owner only with explicit runtime quiescence proof and keeps ambiguous effects blocked', () => {
    const { repository, advance } = setup(); repository.createChat(chat('child'));
    const fence = running(repository);
    advance(30001);
    assert.throws(() => repository.recoverExecution(fence.executionId, { fence }), code('invalid_request'));
    const recovered = repository.recoverExecution(fence.executionId, {
      fence, quiescence: { verified: true, source: 'native-session-reconciliation', checkedAt: 31001 },
    });
    assert.equal(recovered.status, 'failed');
    const next = repository.claimExecution({ chatId: 'child', executionId: 'next', ownerId: 'replacement' });
    assert.ok(next.epoch > fence.epoch);
    repository.recordToolIntent({ invocationId: 'uncertain-write', chatId: 'child', executionId: 'next',
      toolCallId: 'save-call', toolName: 'save_file', input: { path: 'file.txt' } }, { fence: next });
    advance(30001);
    const blocked = repository.recoverExecution('next', {
      fence: next, quiescence: { verified: true, source: 'native-session-reconciliation', checkedAt: 61002 },
    });
    assert.equal(blocked.status, 'recovery_required');
    assert.equal(repository.listExecutions({ statuses: ['recovery_required'] })[0].executionId, 'next');
    assert.throws(() => repository.claimExecution({ chatId: 'child', executionId: 'third', ownerId: 'replacement' }), code('recovery_required'));
    assert.throws(() => repository.recoverExecution(fence.executionId, {
      fence, quiescence: { verified: true, source: 'stale-callback', checkedAt: 61002 },
    }), code('ownership_conflict'));
  });

  it('appends and patches full-fidelity rows atomically with FTS, digest, revisions and stable identities', () => {
    const { repository, db } = setup(); repository.createChat(chat('child'));
    const fence = running(repository);
    const first = repository.appendMessage('child', { role: 'user', content: 'needle-value', provenance }, { fence, messageId: 'message-1' });
    const second = repository.appendMessage('child', { role: 'assistant', content: 'answer', thinkingBlocks: [{ type: 'redacted_thinking', data: 'signed' }] }, { fence, messageId: 'message-2' });
    assert.equal(first.rowId, 0); assert.equal(second.rowId, 1); assert.ok(second.revision > first.revision);
    assert.equal(repository.appendMessage('child', { role: 'user', content: 'needle-value', provenance }, { fence, messageId: 'message-1' }).replayed, true);
    assert.throws(() => repository.appendMessage('child', { role: 'user', content: 'changed' }, { fence, messageId: 'message-1' }), code('idempotency_conflict'));
    const previous = repository.readMessage('child', 1);
    repository.patchMessage('child', 1, { content: 'Revised answer', usage: { total_tokens: 12 } }, { fence, expectedHash: previous.rowHash });
    assert.throws(() => repository.patchMessage('child', 1, { content: 'Stale patch' }, { fence, expectedHash: previous.rowHash }), code('stale_revision'));
    assert.throws(() => repository.patchMessage('child', 0, { provenance: { ...provenance, source: 'cli' } }, { fence }), code('policy_denied'));
    const transcript = repository.readTranscript('child');
    assert.deepEqual(transcript.rowIds, [0, 1]);
    assert.equal(transcript.messages[1].thinkingBlocks[0].data, 'signed');
    const hashes = db.prepare('SELECT row_hash FROM messages WHERE chat_id=? ORDER BY seq').all('child').map((row) => row.row_hash);
    assert.equal(repository.getChat('child').historyDigest, hashPayload(hashes.join('\n')));
    assert.equal(repository.getChat('child').lastMessagePreview, 'Revised answer');
    assert.equal(repository.getChat('child').messageCount, 2);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM messages_fts WHERE messages_fts MATCH 'Revised'").get().n, 1);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM messages_fts WHERE messages_fts MATCH 'needle'").get().n, 1);
  });

  it('rolls back a failed append without a partial identity, index, count or revision', () => {
    const { repository, db } = setup(); repository.createChat(chat('child')); const fence = running(repository);
    const before = repository.getChat('child').revision;
    db.exec("CREATE TRIGGER reject_message BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'injected append failure'); END");
    assert.throws(() => repository.appendMessage('child', { role: 'assistant', content: 'not committed' }, { fence, messageId: 'failed' }), /injected/);
    assert.equal(repository.getChat('child').revision, before);
    assert.equal(repository.getChat('child').messageCount, 0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM chat_message_identities').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM messages_fts').get().n, 0);
  });

  it('persists protected compaction/reasoning metadata through the same fence', () => {
    const { repository } = setup(); repository.createChat(chat('child')); const fence = running(repository);
    repository.setTranscriptMeta('child', { reasoningEffort: 'high', compaction: { foldThroughRow: 3, summary: 'Prior evidence' } }, { fence });
    assert.equal(repository.readTranscript('child').compaction.summary, 'Prior evidence');
    assert.throws(() => repository.setTranscriptMeta('child', { providerToken: 'not transcript metadata' }, { fence }), code('invalid_request'));
  });
});

describe('durable requests, side-effect receipts, cancellation and outbox', () => {
  it('keeps multiple pending requests and settles each once with a durable answer receipt', () => {
    const { repository } = setup(); repository.createChat(chat('child')); const fence = running(repository);
    const pending = { version: 1, requestId: 'request', chatId: 'child', executionId: fence.executionId,
      toolCallId: 'tool:1', kind: 'approval', state: 'pending', createdAt: 1, title: 'Run tests?', presentation: { command: 'npm test' } };
    repository.saveRequest(pending, { fence });
    repository.saveRequest({ ...pending, requestId: 'question', kind: 'question' }, { fence });
    assert.equal(repository.listRequests('child').length, 2);
    const settled = repository.settleRequest('request', { state: 'answered', answerCommandId: 'answer', settledAt: 1000 });
    assert.equal(repository.settleRequest('request', { state: 'answered', answerCommandId: 'answer', settledAt: 1000 }).answerCommandId, settled.answerCommandId);
    assert.equal(repository.listRequests('child').length, 1);
    assert.throws(() => repository.settleRequest('request', { state: 'answered', answerCommandId: 'other' }), code('request_expired'));
  });

  it('persists the actual answer body and deduplicates a lost answer receipt without requiring an active host', () => {
    const { repository } = setup(); repository.createChat(chat('child')); const fence = running(repository);
    const pending = { version: 1, requestId: 'request', chatId: 'child', executionId: fence.executionId,
      toolCallId: 'tool:1', kind: 'question', state: 'pending', createdAt: 1, title: 'Which option?',
      presentation: { options: ['Existing', 'New'] } };
    repository.saveRequest(pending, { fence });
    const accepted = repository.respondToRequest('request', { answerCommandId: 'answer', answer: { selected: ['Existing'], text: 'Use the existing API' } });
    assert.equal(accepted.request.state, 'answered');
    assert.deepEqual(repository.readRequestAnswer('request'), accepted.answer);
    assert.equal(repository.respondToRequest('request', { answerCommandId: 'answer', answer: accepted.answer }).replayed, true);
    assert.throws(() => repository.respondToRequest('request', { answerCommandId: 'answer', answer: { selected: ['New'] } }), code('idempotency_conflict'));
    repository.saveRequest({ ...pending, requestId: 'expired', expiresAt: 1000 }, { fence });
    assert.throws(() => repository.respondToRequest('expired', { answerCommandId: 'late-answer', answer: 'late' }), code('request_expired'));
  });

  it('records tool intent before effects and prevents terminal success with an unresolved invocation', () => {
    const { repository } = setup(); repository.createChat(chat('child')); const fence = running(repository);
    const input = { invocationId: 'invoke', chatId: 'child', executionId: fence.executionId, toolCallId: 'call:save', toolName: 'save_file', input: { path: 'file.txt', content: 'data' } };
    assert.equal(repository.recordToolIntent(input, { fence }).state, 'intent');
    assert.equal(repository.recordToolIntent(input, { fence }).replayed, true);
    assert.equal(repository.listUnsettledToolInvocations(fence.executionId).length, 1);
    assert.throws(() => repository.updateExecution(fence.executionId, { status: 'completed' }, { fence }), code('recovery_required'));
    assert.throws(() => repository.recordToolIntent({ ...input, input: { content: 'different' } }, { fence }), code('idempotency_conflict'));
    repository.settleToolInvocation('invoke', { content: 'saved' }, { fence });
    assert.equal(repository.listUnsettledToolInvocations(fence.executionId).length, 0);
    assert.throws(() => repository.settleToolInvocation('invoke', { content: 'different' }, { fence }), code('idempotency_conflict'));
    repository.updateExecution(fence.executionId, { status: 'completed' }, { fence });
  });

  it('atomically advances cancellation epochs and refuses stale scopes', () => {
    const { repository } = setup();
    assert.equal(repository.getCancellationEpoch('family'), 0);
    assert.equal(repository.advanceCancellationEpoch('family', { expectedEpoch: 0 }), 1);
    assert.throws(() => repository.advanceCancellationEpoch('family', { expectedEpoch: 0 }), code('stale_revision'));
    assert.equal(repository.advanceCancellationEpoch('family'), 2);
  });

  it('retains idempotent outbox work through failed apply, retry, expired worker and stale acknowledgement', async () => {
    const { repository, advance } = setup();
    const payload = { outboxId: 'outbox', kind: 'journal_append', payload: { runId: 'run', type: 'run.requested' } };
    repository.putOutbox(payload);
    assert.equal(repository.putOutbox({ ...payload, payload: { type: 'run.requested', runId: 'run' } }).replayed, true);
    assert.throws(() => repository.putOutbox({ ...payload, payload: { runId: 'changed' } }), code('idempotency_conflict'));
    const old = repository.claimOutbox('outbox', 'old-worker', 10);
    assert.equal(repository.claimOutbox('outbox', 'other-worker'), null);
    advance(11);
    const current = repository.claimOutbox('outbox', 'current-worker');
    assert.throws(() => repository.finishOutbox('outbox', old), code('ownership_conflict'));
    repository.finishOutbox('outbox', current, { code: 'internal_error', message: 'Try later', retryable: true });
    let calls = 0;
    const driver = createChatOutbox({ repository, ownerId: 'driver', handlers: {
      journal_append: async (entry) => { calls += 1; assert.equal(entry.outboxId, 'outbox'); },
    } });
    assert.deepEqual(await driver.drain(), { applied: 1, failed: 0, skipped: 0 });
    assert.equal(calls, 1);
    assert.equal(repository.getOutbox('outbox').state, 'applied');
    assert.deepEqual(await driver.drain(), { applied: 0, failed: 0, skipped: 0 });
  });

  it('does not mark external work applied when the durable acknowledgement fails', async () => {
    const { repository, db } = setup();
    repository.putOutbox({ outboxId: 'outbox', kind: 'journal_append', payload: { seq: 1 } });
    db.exec("CREATE TRIGGER reject_outbox_ack BEFORE UPDATE ON chat_outbox WHEN NEW.state='applied' BEGIN SELECT RAISE(ABORT, 'injected ack failure'); END");
    const driver = createChatOutbox({ repository, ownerId: 'driver', handlers: { journal_append: async () => {} } });
    await assert.rejects(driver.drain(), /injected ack failure/);
    assert.equal(repository.getOutbox('outbox').state, 'applying');
  });

  it('rejects prototype data and hashes object keys canonically without changing array order', () => {
    assert.equal(hashChatPayload({ z: 1, a: [2, 3] }), hashChatPayload({ a: [2, 3], z: 1 }));
    assert.notEqual(hashChatPayload([2, 3]), hashChatPayload([3, 2]));
    assert.throws(() => hashChatPayload(JSON.parse('{"__proto__":1}')), code('invalid_request'));
    let invoked = false;
    assert.throws(() => hashChatPayload({ get secret() { invoked = true; return 'no'; } }), code('invalid_request'));
    assert.equal(invoked, false);
  });
});

it('reopens the actual SQLite file with commands, ownership fences, message identities and outbox intact', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'minnow-chat-repository-'));
  const file = path.join(folder, 'sessions.db');
  try {
    const first = setup(file); const { repository } = first;
    repository.createChild(childInput()); const fence = running(repository);
    repository.appendMessage('child', { role: 'assistant', content: 'Persisted result' }, { fence, messageId: 'message' });
    repository.saveRequest({ version: 1, requestId: 'persisted-question', chatId: 'child', executionId: fence.executionId,
      toolCallId: 'call:question', kind: 'question', state: 'pending', createdAt: 1, title: 'Choose?',
      presentation: { options: ['Continue', 'Stop'] } }, { fence });
    repository.respondToRequest('persisted-question', { answerCommandId: 'persisted-answer', answer: { selected: ['Continue'] } });
    first.db.close();
    const second = setup(file);
    assert.equal(second.repository.getCommand('initial-child').state, 'accepted');
    assert.equal(second.repository.readTranscript('child').messages[0].content, 'Persisted result');
    assert.equal(second.repository.getOutbox('spawn-child').state, 'pending');
    assert.deepEqual(second.repository.readRequestAnswer('persisted-question'), { selected: ['Continue'] });
    assert.throws(() => second.repository.claimExecution({ chatId: 'child', executionId: 'other', ownerId: 'other' }), code('ownership_conflict'));
    assert.equal(second.repository.appendMessage('child', { role: 'assistant', content: 'Persisted result' }, { fence, messageId: 'message' }).replayed, true);
    assert.equal(second.db.pragma('user_version', { simple: true }), 1);
    second.db.close();
  } finally {
    for (const db of opened) if (db.open) db.close();
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

it('legacy session saves cannot erase managed history, forge lineage, prune children or resurrect tombstones', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'minnow-chat-legacy-protection-'));
  const priorHome = process.env.MINNOW_HOME;
  const priorStore = process.env.MINNOW_SESSIONS_STORE;
  process.env.MINNOW_HOME = folder;
  delete process.env.MINNOW_SESSIONS_STORE;
  resetMinnowHomeCache();
  try {
    const repository = createChatRepository({ now: () => 1000 });
    repository.createChat(chat('parent'));
    repository.createChild(childInput());
    const fence = running(repository);
    repository.appendMessage('child', { role: 'assistant', content: 'Canonical evidence' }, { fence, messageId: 'canonical' });
    assert.throws(() => patchSessionState({ deleteChatIds: ['parent'] }), code('ownership_conflict'));
    repository.updateExecution(fence.executionId, { status: 'completed' }, { fence });
    repository.releaseLease('child', fence);
    patchSessionState({ chats: [{
      ...chat('child'), name: 'Human renamed child', modelId: 'untrusted-model', history: [],
      agentConversation: { ...childInput().relation, parentChatId: 'forged' },
    }] });
    assert.equal(readChatHistory('child')[0].content, 'Canonical evidence');
    assert.equal(repository.getChat('child').modelId, 'model');
    assert.equal(repository.getRelation('child').parentChatId, 'parent');
    assert.equal(repository.getChat('child').name, 'Human renamed child');
    const shells = readChatSummaries();
    assert.equal(shells.find((row) => row.id === 'child').chatCommandVersion, 1);
    assert.equal(JSON.stringify(shells).includes('Private prompt snapshot'), false);
    assert.equal(readWholeSessionState().chats.find((row) => row.id === 'child').agentConversation.parentChatId, 'parent');
    writeWholeSessionState({ version: 6, chats: [], groups: [] }, { pruneMissingChats: true });
    assert.equal(repository.getChat('child').messageCount, 1);
    assert.throws(() => patchSessionState({ deleteChatIds: ['parent'] }), code('ownership_conflict'));
    repository.updateCommand('initial-child', { state: 'cancelled' });
    const requestFence = repository.claimExecution({ chatId: 'child', executionId: 'request-execution', ownerId: 'request-host' });
    repository.saveRequest({ version: 1, requestId: 'pending-delete-question', chatId: 'child', executionId: requestFence.executionId,
      toolCallId: 'question', kind: 'question', state: 'pending', title: 'Pending attention', presentation: {}, createdAt: 1000 }, { fence: requestFence });
    repository.updateExecution(requestFence.executionId, { status: 'completed' }, { fence: requestFence });
    repository.releaseLease('child', requestFence);
    assert.throws(() => patchSessionState({ deleteChatIds: ['parent'] }), code('ownership_conflict'));
    repository.settleRequest('pending-delete-question', { state: 'cancelled', settledAt: 1001 });
    patchSessionState({ deleteChatIds: ['parent'] });
    assert.equal(repository.getRelation('child').missingParent, true);
    assert.equal(repository.listChatShells({ includeChildren: false }).some((row) => row.id === 'child'), true);
    assert.throws(() => patchSessionState({ chats: [{ ...chat('parent'), history: [] }] }), code('stale_revision'));
    assert.throws(() => repository.createChat(chat('parent')), code('chat_not_found'));
    patchSessionState({ chats: [{
      ...chat('ordinary'), history: [], agentConversation: { ...childInput().relation, childChatId: 'ordinary' },
      chatCommandVersion: 1,
    }] });
    const ordinary = readChatSummaries().find((row) => row.id === 'ordinary');
    assert.equal(ordinary.agentConversation, undefined);
    assert.equal(ordinary.chatCommandVersion, undefined);
  } finally {
    closeSessionsDb();
    if (priorHome === undefined) delete process.env.MINNOW_HOME;
    else process.env.MINNOW_HOME = priorHome;
    if (priorStore === undefined) delete process.env.MINNOW_SESSIONS_STORE;
    else process.env.MINNOW_SESSIONS_STORE = priorStore;
    resetMinnowHomeCache();
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

it('JSON-store development mode refuses new conversation storage without opening a second canonical database', () => {
  const prior = process.env.MINNOW_SESSIONS_STORE;
  process.env.MINNOW_SESSIONS_STORE = 'json';
  try {
    assert.throws(() => createChatRepository(), code('capability_unavailable'));
    const fixture = setup();
    assert.equal(fixture.repository.createChat(chat('fixture')).id, 'fixture', 'explicit injected test DB remains supported');
  } finally {
    if (prior === undefined) delete process.env.MINNOW_SESSIONS_STORE;
    else process.env.MINNOW_SESSIONS_STORE = prior;
  }
});

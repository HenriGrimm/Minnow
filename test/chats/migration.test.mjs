import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { initSessionsSchema, readSessionMeta, writeSessionMeta } from '../../server/config/sessions-schema.js';
import { initSessionsSchema as initPreAgentSchema } from './fixtures/pre-agent-sessions-schema.mjs';
import { createChatRepository } from '../../server/chats/repository.js';
import { createChatTaskRepository } from '../../server/chats/task-repository.js';
import { createChatRequestService } from '../../server/chats/requests.js';
import { createChatUsage } from '../../server/chats/usage.js';
import { createChatWorkspaceRepository } from '../../server/chats/workspace-repository.js';
import { exportChatArchive, importChatArchive, hashChatArchive, CHAT_ARCHIVE_TABLES } from '../../server/chats/archive.js';
import { createChatRecovery, restorePendingChatJournals, reconcileChatJournalStorage } from '../../server/chats/recovery.js';
import { createChatCommandService } from '../../server/chats/service.js';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import { closeSessionsDb, getSessionsDb } from '../../server/config/sessions-db.js';
import { importJsonSessionsIfNeeded, upsertChatRow, upsertMessageRow } from '../../server/config/sessions-import.js';
import { exportSessionStateToJson, patchSessionState } from '../../server/config/sessions-repo.js';
import { writeResource, patchResource } from '../../server/config/store.js';
import { snapshotSessionsDb } from '../../server/config/sessions-snapshot.js';
import { createBackup } from '../../server/backup/export.js';
import { stageRestore } from '../../server/backup/restore.js';
import { applyPendingRestore } from '../../server/backup/restore-apply.js';
import * as journal from '../../server/sub-agents/journal.js';
import { makeEvent } from '../../server/sub-agents/events.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minnow-agent-migration-')), prior = process.env.MINNOW_HOME;
  const opened = [];
  function useHome(name) {
    closeSessionsDb(); journal.resetJournalCache();
    const home = path.join(root, name); fs.mkdirSync(home, { recursive: true });
    process.env.MINNOW_HOME = home; resetMinnowHomeCache(); return home;
  }
  function database(file = ':memory:') {
    const db = new Database(file); opened.push(db); db.pragma('foreign_keys=ON'); initSessionsSchema(db);
    return { db, repository: createChatRepository({ db, now: () => 1000 }) };
  }
  useHome('source');
  t.after(() => {
    closeSessionsDb(); for (const db of opened) if (db.open) db.close(); journal.resetJournalCache();
    if (prior === undefined) delete process.env.MINNOW_HOME; else process.env.MINNOW_HOME = prior;
    resetMinnowHomeCache(); fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, useHome, database };
}
const provenance = { version: 1, actor: 'human', source: 'composer', kind: 'human_message' };
const command = { version: 1, commandId: 'assignment', chatId: 'child', requestedAt: 1, kind: 'send', provenance, message: 'Inspect safely' };
const requested = () => makeEvent('run.requested', { runId: 'task', agentType: 'reviewer', task: 'Inspect safely', parentChatId: 'parent', cwd: 'C:/fixture', requestedAt: 1,
  childChatId: 'child', commandId: 'assignment', journalOwnerId: 'family', executionKind: 'chat' });
async function seed(repository) {
  repository.createChat({ id: 'parent', name: 'Parent', workspacePath: 'C:/fixture', providerId: 'provider', modelId: 'parent-model', modeId: 'build' });
  repository.createChild({ chat: { id: 'child', name: 'Review', workspacePath: 'C:/fixture', providerId: 'provider', modelId: 'child-model', modeId: 'plan' }, projectId: 'project',
    relation: { version: 1, childChatId: 'child', parentChatId: 'parent', rootChatId: 'parent', journalOwnerId: 'family', origin: 'delegated', createdAt: 1,
      initialRunId: 'task', profileReference: { profileId: 'profile-child', profileVersion: 1 } },
    profile: { profileId: 'profile-child', profileVersion: 1, snapshot: { prompt: 'Private snapshot', policy: { toolPermissions: { save_file: 'off' } },
      modelSelection: { providerId: 'provider', modelId: 'child-model', options: { reasoningEffort: 'high', thinkingMode: 'on' } } } },
    command, producerId: 'parent-execution', requestKey: 'spawn-child', captured: { policy: { toolPermissions: { save_file: 'off' } }, modelSelection: { providerId: 'provider', modelId: 'child-model' } },
    outbox: [{ outboxId: 'request-task', chatId: 'child', kind: 'agent.journal.request', payload: { journalOwnerId: 'family', event: requested() } }] });
  const fence = repository.claimExecution({ chatId: 'child', executionId: 'execution', commandId: 'assignment', runId: 'task', attemptId: 'attempt', ownerId: 'host' });
  repository.updateCommand('assignment', { state: 'running', executionId: 'execution', runId: 'task' });
  const rows = [
    { role: 'user', content: 'Inspect safely', images: [{ name: 'sample.png', dataUrl: 'data:image/png;base64,aGVsbG8=' }], provenance, commandId: 'assignment' },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'Private reasoning', signature: 'signed-block' }], tool_calls: [{ id: 'call', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }] },
    { role: 'tool', tool_call_id: 'call', content: 'Original tool result' },
    { role: 'assistant', content: 'Original final prose' },
  ];
  rows.forEach((row, index) => repository.appendMessage('child', row, { fence, messageId: 'row-' + index }));
  repository.setTranscriptMeta('child', { compaction: { version: 1, summary: 'Retained compaction', throughRowId: 1 }, todos: [{ id: 'todo', content: 'Verify', status: 'done' }] }, { fence });
  await createChatUsage({ repository, readProviderPricing: async () => null }).recordRound({ executionId: 'execution', roundIndex: 0, fence,
    modelSelection: { providerId: 'provider', modelId: 'resolved-child' }, turn: { streamMeta: { usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } } } });
  const requests = createChatRequestService({ repository, now: () => 1000 });
  for (const kind of ['question', 'approval']) requests.open({ chatId: 'child', executionId: 'execution', toolCallId: kind, kind, title: 'Choose', presentation: { question: 'Proceed?' }, fence });
  const tasks = createChatTaskRepository({ repository });
  const policy = { version: 1, kind: 'wake_delegator', recipientChatId: 'parent', subscriptionId: 'subscription', cancellationEpoch: 0 };
  tasks.saveResult({ version: 1, runId: 'settled-task', childChatId: 'child', journalOwnerId: 'family', status: 'completed', summary: 'Immutable earlier result', settledAt: 1000, completionPolicy: policy }, { commandId: 'assignment' });
  tasks.ensureSubscription({ runId: 'settled-task', policy });
  tasks.coalesce({ recipientChatId: 'parent', cancellationEpoch: 0, runIds: ['settled-task'] });
  createChatWorkspaceRepository({ db: repository.getDatabase() }).reserve({ allocationId: 'allocation', childChatId: 'child', projectId: 'project', strategy: 'shared',
    sourceWorkspaceId: 'main', sourceCanonicalPath: 'C:/fixture', sourceCommonDir: null, targetPath: 'C:/fixture', branch: null, baseSha: null, sourceHeadSha: null });
  await journal.appendEvent('family', requested(), { idempotencyKey: 'request-task', now: () => 1000 });
  await journal.appendEvent('family', makeEvent('attempt.started', { runId: 'task', attemptId: 'attempt', seed: {}, executionId: 'execution' }), { now: () => 1001 });
  return { rows, fence };
}

test('versioned archive round trip retains full canonical records, exact journals, revisions and child-only usage after reopen', async t => {
  const f = fixture(t), source = f.database(); const { rows } = await seed(source.repository);
  const archive = exportChatArchive(source.db, { now: () => 2000 });
  assert.deepEqual(Object.keys(archive.tables), [...CHAT_ARCHIVE_TABLES]);
  const originalRevision = source.repository.getChat('child').revision;
  f.useHome('target'); const file = path.join(f.root, 'target.db'); let target = f.database(file);
  const receipt = importChatArchive(target.db, archive, { now: () => 3000 });
  assert.equal(receipt.held, true); assert.equal(receipt.journalChunks, 1);
  assert.equal(target.repository.getCommand('assignment').held, true);
  assert.equal(target.repository.getChat('child').revision, originalRevision);
  assert.equal(target.repository.getCancellationEpoch('child'), 1);
  assert.equal(target.repository.getChat('child').archiveImport.sourceProfileTrust, 'archival');
  assert.deepEqual(target.repository.readTranscript('child').messages.map(({ messageId, ...row }) => row), rows);
  assert.equal(target.repository.getProfile('profile-child', 1).snapshot.modelSelection.options.reasoningEffort, 'high');
  assert.equal(target.db.prepare("SELECT COUNT(*) n FROM messages_fts WHERE messages_fts MATCH 'Original'").get().n, 2);
  assert.equal(target.db.prepare('SELECT COUNT(*) n FROM chat_usage_receipts').get().n, 1);
  assert.equal(target.repository.getChat('parent').tokenLedger, undefined);
  assert.equal(target.repository.getChat('child').tokenLedger.totals.totalTokens, 30);
  assert.equal(target.repository.listRequests('child').every(row => row.state === 'expired'), true);
  assert.equal(target.db.prepare('SELECT COUNT(*) n FROM chat_task_results').get().n, 1);
  assert.equal(target.db.prepare('SELECT COUNT(*) n FROM chat_completion_cohorts').get().n, 1);
  await restorePendingChatJournals(target.repository);
  assert.deepEqual(await journal.readEvents('family'), archive.journals[0].events);
  assert.equal(importChatArchive(target.db, archive).replayed, true);
  assert.equal(await restorePendingChatJournals(target.repository), 0);
  target.db.close(); target = f.database(file);
  assert.equal(target.repository.readMessageByIdentity('child', 'row-1').message.content[0].signature, 'signed-block');
  assert.equal(createChatTaskRepository({ repository: target.repository }).getResult('settled-task').summary, 'Immutable earlier result');
  assert.equal(createChatWorkspaceRepository({ db: target.db }).getByChild('child').targetPath, 'C:/fixture');
});

test('archive rejects malformed authority/checksums and overlapping identities without any partial mutation', async t => {
  const f = fixture(t), source = f.database(); await seed(source.repository); const archive = exportChatArchive(source.db);
  f.useHome('target'); const target = f.database();
  const resign = value => { const { digest, ...payload } = value; return { ...payload, digest: hashChatArchive(payload) }; };
  const forged = structuredClone(archive); const relation = JSON.parse(forged.tables.chat_relations[0].payload_json);
  relation.capabilities = { nativeWritable: true }; forged.tables.chat_relations[0].payload_json = JSON.stringify(relation);
  assert.throws(() => importChatArchive(target.db, resign(forged)), { code: 'invalid_request' });
  const corrupted = structuredClone(archive); corrupted.tables.messages[0].payload_json = '{}';
  assert.throws(() => importChatArchive(target.db, resign(corrupted)), { code: 'invalid_request' });
  assert.equal(target.db.prepare('SELECT COUNT(*) n FROM chats').get().n, 0);
  target.repository.createChat({ id: 'child', name: 'Keep current' });
  assert.throws(() => importChatArchive(target.db, archive), { code: 'idempotency_conflict' });
  assert.equal(target.repository.getChat('child').name, 'Keep current');
  assert.equal(target.db.prepare('SELECT COUNT(*) n FROM chat_commands').get().n, 0);
});

test('journal restoration serializes with appends, replays lost ACKs and refuses divergent or gapped timelines', async t => {
  const f = fixture(t), source = f.database(); await seed(source.repository); const archive = exportChatArchive(source.db);
  f.useHome('target'); const target = f.database(); importChatArchive(target.db, archive);
  const original = target.repository.finishOutbox; let injected = true;
  target.repository.finishOutbox = (...args) => { if (injected) { injected = false; throw new Error('lost ACK'); } return original(...args); };
  await assert.rejects(restorePendingChatJournals(target.repository), /lost ACK/);
  await restorePendingChatJournals(target.repository);
  assert.equal((await journal.readEvents('family')).length, 2);
  const end = makeEvent('attempt.ended', { runId: 'task', attemptId: 'attempt', outcome: 'pass', summary: 'Done' });
  await Promise.all([journal.restoreEvents('family', archive.journals[0].events), journal.appendEvent('family', end)]);
  assert.deepEqual((await journal.readEvents('family')).map(row => row.seq), [1, 2, 3]);
  await assert.rejects(journal.restoreEvents('family', [{ ...archive.journals[0].events[0], task: 'Other' }]), { code: 'recovery_required' });
  await assert.rejects(journal.restoreEvents('family', [{ ...archive.journals[0].events[1], seq: 5 }]), { code: 'recovery_required' });
  fs.appendFileSync(journal.journalPath('family'), '{"torn":');
  await assert.rejects(journal.restoreEvents('family', [{ ...archive.journals[0].events[1], seq: 4 }]), { code: 'recovery_required' });
});

test('one recovery entry repairs SQL-ahead/journal-ahead skew before execution and graph recovery', async t => {
  const f = fixture(t), target = f.database(); await seed(target.repository);
  fs.rmSync(journal.agentsDir('family'), { recursive: true, force: true }); journal.resetJournalCache();
  target.db.prepare("UPDATE chat_outbox SET state='applied' WHERE outbox_id='request-task'").run();
  const sequence = [];
  const recovery = createChatRecovery({ repository: target.repository, requests: { expireUnownedLegacyApprovals() { sequence.push('requests'); } },
    service: { async recoverExecutions(verify) { sequence.push('executions'); assert.equal((await journal.readEvents('family')).length, 1); assert.equal(await verify({ executionId: 'held', chatId: 'child' }), null); return []; } },
    taskDelivery: { async recover() { sequence.push('delivery'); } }, getTaskAdapter: () => ({ async recover() { sequence.push('graph'); } }),
    beforeExecutionRecovery() { sequence.push('question-boundary'); return { heldExecutionIds: ['held'] }; }, verifyQuiescence: () => ({ verified: true }) });
  await recovery.run();
  assert.deepEqual(sequence, ['requests', 'question-boundary', 'executions', 'delivery', 'graph']);
  await journal.appendEvent('orphan', makeEvent('run.requested', { ...requested(), runId: 'missing', childChatId: 'missing-child', commandId: 'missing-command' }));
  await reconcileChatJournalStorage(target.repository);
  assert.equal((await journal.loadState('orphan')).runs.get('missing').recoveryRequired, true);
  assert.equal((await journal.readEvents('family')).filter(row => row.type === 'run.requested').length, 1);
});

test('interrupted native intent remains an explicit recovery barrier through imported held work', async t => {
  const f = fixture(t), source = f.database(); const { fence } = await seed(source.repository);
  source.repository.recordToolIntent({ invocationId: 'native-effect', chatId: 'child', executionId: 'execution', toolCallId: 'effect', toolName: 'save_file', input: { path: 'a.ts', content: 'x' } }, { fence });
  const archive = exportChatArchive(source.db); f.useHome('target'); const target = f.database(); importChatArchive(target.db, archive);
  const service = createChatCommandService({ repository: target.repository, context: { resolveTarget() { throw new Error('No inference during recovery'); } } });
  try {
    await service.recoverExecutions(() => ({ verified: true, source: 'isolated-test', checkedAt: 4000 }));
    assert.equal(target.repository.getExecution('execution').status, 'recovery_required');
    assert.equal(target.repository.getCommand('assignment').held, true);
    assert.equal(target.repository.listUnsettledToolInvocations('execution')[0].state, 'intent', 'original unacknowledged effect evidence is retained');
  } finally { await service.dispose(); }
});

test('legacy JSON import stays additive, versioned export imports completely and generic saves reject it', async t => {
  const f = fixture(t), source = f.database(); await seed(source.repository); const archive = exportChatArchive(source.db);
  const home = f.useHome('json-target'); fs.mkdirSync(path.join(home, 'sessions'));
  fs.writeFileSync(path.join(home, 'sessions', 'state.json'), JSON.stringify({ version: 6, conversationArchive: archive }));
  const target = f.database(); const migrated = importJsonSessionsIfNeeded(target.db);
  assert.equal(migrated.migrated, true); assert.equal(target.repository.getRelation('child').parentChatId, 'parent');
  assert.equal(importJsonSessionsIfNeeded(target.db).reason, 'already_migrated');
  assert.equal(fs.existsSync(path.join(home, 'sessions', 'state.json.migrated')), true);
  assert.throws(() => patchSessionState({ conversationArchive: archive }, { db: target.db }), { code: 'invalid_request' });
  await assert.rejects(writeResource('sessions', { conversationArchive: archive }), /archive\/import/);
  await assert.rejects(patchResource('sessions', { conversationArchive: archive }), /archive\/import/);
  const legacyHome = f.useHome('old-json'); fs.mkdirSync(path.join(legacyHome, 'sessions'));
  fs.writeFileSync(path.join(legacyHome, 'sessions', 'state.json'), JSON.stringify({ version: 6, activeId: 'old', groups: [], chats: [{ id: 'old', name: 'Old chat', history: [{ role: 'user', content: 'Keep me' }] }] }));
  const legacy = getSessionsDb();
  assert.equal(createChatRepository({ db: legacy }).getChat('old').chatCommandVersion, undefined);
  assert.equal(exportSessionStateToJson().conversationArchive.tables.messages[0].row_hash.length, 64);
});

test('online snapshots and staged .mnbak restores retain protected rows and complete family evidence', async t => {
  const f = fixture(t), sourceHome = process.env.MINNOW_HOME;
  fs.mkdirSync(path.join(sourceHome, 'sessions')); const source = f.database(path.join(sourceHome, 'sessions', 'sessions.db')); await seed(source.repository);
  writeSessionMeta(source.db, 'jsonImportedAt', 'test');
  const original = exportChatArchive(source.db, { now: () => 2000 });
  const snapshot = await snapshotSessionsDb(source.db, { force: true }); assert.equal(snapshot.ok, true);
  const saved = f.database(snapshot.file);
  for (const table of CHAT_ARCHIVE_TABLES) assert.deepEqual(saved.db.prepare('SELECT * FROM ' + table).all(), source.db.prepare('SELECT * FROM ' + table).all(), table);
  saved.db.close();
  const archivePath = path.join(f.root, 'complete.mnbak');
  await createBackup({ home: sourceHome, outPath: archivePath }); source.db.close();
  const targetHome = f.useHome('backup-target'); await stageRestore({ home: targetHome, archivePath });
  const applied = applyPendingRestore({ home: targetHome }); assert.equal(applied.applied, true, applied.error);
  const restored = getSessionsDb(), exported = exportChatArchive(restored, { now: () => 2000 });
  for (const table of CHAT_ARCHIVE_TABLES.filter(table => table !== 'session_meta')) assert.deepEqual(exported.tables[table], original.tables[table], table);
  assert.deepEqual(exported.journals, original.journals);
  assert.equal(createChatRepository({ db: restored }).listRequests('child', 'pending').length, 2, 'restore retains same-home question evidence for trusted reattachment');
  assert.equal(readSessionMeta(restored, 'revision'), JSON.parse(original.tables.session_meta.find(row => row.key === 'revision').value));
});

test('detached imports retain allocation evidence but cannot manufacture an isolated checkout grant', async t => {
  const f = fixture(t), source = f.database(); await seed(source.repository);
  const allocations = createChatWorkspaceRepository({ db: source.db });
  allocations.reserve({ allocationId: 'isolated', childChatId: 'isolated-child', projectId: 'project', strategy: 'new_worktree', sourceWorkspaceId: 'main',
    sourceCanonicalPath: 'C:/fixture', sourceCommonDir: 'C:/fixture/.git', targetPath: 'C:/worktrees/imported', branch: 'imported', baseSha: 'a'.repeat(40), sourceHeadSha: 'a'.repeat(40) });
  const current = allocations.getByAllocation('isolated');
  const ready = { ...current, setupState: 'ready', targetCanonicalPath: 'C:/worktrees/imported', targetWorkspaceId: 'isolated-workspace' };
  source.db.prepare('UPDATE chat_workspace_allocations SET setup_state=?,payload_json=? WHERE allocation_id=?').run('ready', JSON.stringify(ready), 'isolated');
  const archive = exportChatArchive(source.db); f.useHome('target'); const target = f.database(); importChatArchive(target.db, archive);
  const restored = createChatWorkspaceRepository({ db: target.db }).getByAllocation('isolated');
  assert.equal(restored.setupState, 'recovery_required'); assert.equal(restored.ownerId, null);
  assert.equal(restored.archivedAllocation.setupState, 'ready'); assert.equal(restored.targetCanonicalPath, ready.targetCanonicalPath);
  assert.equal(createChatWorkspaceRepository({ db: target.db }).list({ setupState: 'ready' }).length, 0);
});

test('result ACK recovery settles its durable subscription and an import scope leaves live unrelated outboxes alone', async t => {
  const f = fixture(t), source = f.database(); await seed(source.repository);
  const tasks = createChatTaskRepository({ repository: source.repository });
  const cohort = tasks.listCohorts({ recipientChatId: 'parent' })[0]; tasks.seal(cohort.cohortId);
  tasks.settleCohort(cohort.cohortId, { state: 'admitted', commandId: 'wake-command' });
  const event = makeEvent('result.delivered', { runId: 'settled-task', parentChatId: 'family', recipientChatId: 'parent', disposition: 'accepted', commandId: 'wake-command' });
  source.repository.putOutbox({ outboxId: 'restore-ack', chatId: 'child', kind: 'agent.result.ack', payload: { journalOwnerId: 'family', event } });
  source.repository.createChat({ id: 'unrelated' });
  source.repository.putOutbox({ outboxId: 'unrelated-outbox', chatId: 'unrelated', kind: 'agent.journal.cancel', payload: { journalOwnerId: 'unrelated-family', event: makeEvent('run.cancelled', { runId: 'other', reason: 'user' }) } });
  source.repository.claimOutbox('unrelated-outbox', 'live-owner');
  await reconcileChatJournalStorage(source.repository, { chatIds: ['child'] });
  assert.equal(tasks.getSubscription('settled-task').state, 'delivered');
  assert.equal(source.repository.getOutbox('restore-ack').state, 'applied');
  assert.equal(source.repository.getOutbox('unrelated-outbox').state, 'applying');
  assert.deepEqual(await journal.readEvents('unrelated-family'), []);
  await reconcileChatJournalStorage(source.repository, { chatIds: ['child'] });
  assert.equal((await journal.readEvents('family')).filter(row => row.idempotencyKey === 'restore-ack').length, 1);
});

test('a pre-upgrade backup restores a schema readable by the isolated pre-agent server fixture', async t => {
  const f = fixture(t), home = process.env.MINNOW_HOME;
  fs.mkdirSync(path.join(home, 'sessions')); const file = path.join(home, 'sessions', 'sessions.db');
  let db = new Database(file); initPreAgentSchema(db);
  const chat = { id: 'legacy', name: 'Original legacy conversation', workspacePath: 'C:/fixture', history: [{ role: 'user', content: 'Before upgrade' }] };
  upsertChatRow(db, chat, 0, { messageCount: 1, lastMessagePreview: 'Before upgrade', historyDigest: 'legacy-digest' });
  upsertMessageRow(db, 'legacy', 0, chat.history[0]); writeSessionMeta(db, 'jsonImportedAt', 'pre-upgrade');
  assert.equal(db.pragma('user_version', { simple: true }), 1);
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='chat_conversation_state'").get(), undefined);
  const originalRows = db.prepare('SELECT * FROM chats').all(), originalMessages = db.prepare('SELECT * FROM messages').all();
  const backup = path.join(f.root, 'pre-upgrade.mnbak'); await createBackup({ home, outPath: backup });
  initSessionsSchema(db); const upgraded = createChatRepository({ db }); upgraded.ensureManagedChat('legacy');
  upgraded.createChat({ id: 'new-child', name: 'After upgrade' });
  assert.equal(upgraded.getChat('legacy').chatCommandVersion, 1); db.close();
  await stageRestore({ home, archivePath: backup }); assert.equal(applyPendingRestore({ home }).applied, true);
  // The old binary's schema initializer runs first, without importing any new
  // server module. Its existing SQL readers see exactly their original rows.
  db = new Database(file);
  try {
    initPreAgentSchema(db);
    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='chat_conversation_state'").get(), undefined);
    assert.deepEqual(db.prepare('SELECT * FROM chats').all(), originalRows);
    assert.deepEqual(db.prepare('SELECT * FROM messages').all(), originalMessages);
    assert.equal(JSON.parse(db.prepare('SELECT payload_json FROM messages WHERE chat_id=? AND seq=0').get('legacy').payload_json).content, 'Before upgrade');
  } finally { db.close(); }
});

test('recovery expires orphan question callbacks but preserves exact reattachments, live waiters and unrelated import scopes', async t => {
  const f = fixture(t), target = f.database(), repository = target.repository;
  const requests = createChatRequestService({ repository, now: () => 1000 });
  const saved = new Map();
  for (const id of ['orphan', 'interrupted', 'reattached', 'live', 'unrelated']) {
    repository.createChat({ id, workspacePath: 'C:/fixture' });
    const fence = repository.claimExecution({ chatId: id, executionId: 'exec-' + id, ownerId: 'host' });
    const request = requests.open({ chatId: id, executionId: fence.executionId, toolCallId: 'question-' + id,
      kind: 'question', title: 'Choose', presentation: { question: 'Retain evidence?' }, fence });
    if (['orphan', 'live', 'unrelated'].includes(id)) {
      repository.updateExecution(fence.executionId, { status: 'failed' }, { fence }); repository.releaseLease(id, fence);
    }
    saved.set(id, request);
  }
  const abort = new AbortController(), waiting = requests.wait(saved.get('live').requestId, { signal: abort.signal });
  const caught = waiting.catch(() => {});
  const service = createChatCommandService({ repository, context: { resolveTarget() { throw new Error('Recovery cannot infer'); } } });
  try {
    const recovery = createChatRecovery({ repository, service, requests, taskDelivery: { async recover() {} },
      beforeExecutionRecovery: () => ({ heldExecutionIds: ['exec-reattached'] }),
      verifyQuiescence: () => ({ verified: true, source: 'isolated-recovery', checkedAt: 2000 }) });
    await recovery.run({ reason: 'import', chatIds: ['orphan', 'interrupted', 'reattached', 'live'] });
    for (const id of ['orphan', 'interrupted']) {
      const request = repository.getRequest(saved.get(id).requestId);
      assert.equal(request.state, 'expired'); assert.equal(request.presentation.question, 'Retain evidence?');
      assert.throws(() => repository.respondToRequest(request.requestId, { answerCommandId: 'late-' + id, answer: 'unused answer' }), { code: 'request_expired' });
    }
    for (const id of ['reattached', 'live', 'unrelated']) assert.equal(repository.getRequest(saved.get(id).requestId).state, 'pending', id);
    await recovery.run({ reason: 'startup' });
    assert.equal(repository.getRequest(saved.get('unrelated').requestId).state, 'expired');
  } finally { abort.abort(); await caught; await service.dispose(); }
});

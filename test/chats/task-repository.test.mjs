import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { initSessionsSchema } from '../../server/config/sessions-schema.js';
import { createChatRepository } from '../../server/chats/repository.js';
import { createChatTaskRepository } from '../../server/chats/task-repository.js';

function fixture(file = ':memory:') {
  const db = new Database(file); initSessionsSchema(db);
  const repository = createChatRepository({ db });
  return { db, repository, tasks: createChatTaskRepository({ repository }) };
}
const wake = (runId, epoch = 0, parent = 'parent') => ({ version: 1, kind: 'wake_delegator', recipientChatId: parent,
  subscriptionId: `subscription-${runId}`, cancellationEpoch: epoch });
const result = (runId, policy = wake(runId)) => ({ version: 1, runId, childChatId: 'child', journalOwnerId: 'family',
  executionId: `execution-${runId}`, attemptId: `attempt-${runId}`, status: 'completed', summary: `Result ${runId}`, settledAt: 1000, completionPolicy: policy });
function add(tasks, runId, policy = wake(runId), inlineWait) {
  tasks.saveResult(result(runId, policy), { commandId: `command-${runId}` });
  return tasks.ensureSubscription({ runId, policy, ...(inlineWait ? { inlineWait } : {}) });
}

test('terminal results survive the child lifetime and changed retries cannot rewrite them', () => {
  const { db, repository, tasks } = fixture();
  try {
    repository.createChat({ id: 'child', name: 'Child', workspacePath: '/project', modeId: 'build' });
    const original = result('task');
    assert.deepEqual(tasks.saveResult(original, { commandId: 'command' }), original);
    assert.deepEqual(tasks.saveResult(original, { commandId: 'command' }), original);
    for (const changed of [{ ...original, summary: 'Later turn' }, { ...original, settledAt: 2000 }]) {
      assert.throws(() => tasks.saveResult(changed, { commandId: 'command' }), { code: 'idempotency_conflict' });
    }
    assert.throws(() => tasks.saveResult(original, { commandId: 'another-command' }), { code: 'idempotency_conflict' });
    db.prepare('DELETE FROM chats WHERE id=?').run('child');
    assert.deepEqual(tasks.getResult('task'), original);
    assert.deepEqual(tasks.listResults({ journalOwnerId: 'family' }), [original]);
    assert.deepEqual(tasks.listResults({ journalOwnerId: 'other' }), []);
  } finally { db.close(); }
});

test('inline wait and local continuation capture distinct immutable recipient identities', () => {
  const { db, tasks } = fixture();
  try {
    const inlineWait = { chatId: 'parent', executionId: 'parent-execution', toolCallId: 'spawn-tool' };
    const sub = add(tasks, 'initial', wake('initial'), inlineWait);
    assert.equal(sub.state, 'inline_hold');
    assert.deepEqual(tasks.ensureSubscription({ runId: 'initial', policy: wake('initial'), inlineWait }), sub);
    assert.throws(() => tasks.ensureSubscription({ runId: 'initial', policy: wake('initial', 1), inlineWait }), { code: 'idempotency_conflict' });
    assert.throws(() => tasks.ensureSubscription({ runId: 'initial', policy: wake('initial'), inlineWait: { ...inlineWait, toolCallId: 'other' } }), { code: 'idempotency_conflict' });
    assert.throws(() => tasks.ensureSubscription({ runId: 'wrong', policy: wake('wrong'), inlineWait: { ...inlineWait, chatId: 'peer' } }), { code: 'invalid_request' });
    add(tasks, 'followup', { version: 1, kind: 'local_only' });
    assert.equal(tasks.getSubscription('followup').state, 'local_only');
    assert.equal(tasks.getSubscription('followup').recipientChatId, null);
    assert.equal(tasks.coalesce({ recipientChatId: 'parent', cancellationEpoch: 0, runIds: ['initial', 'followup'] }), null);
    tasks.setSubscription('initial', { state: 'inline_returned' });
    tasks.setSubscription('initial', { state: 'delivered', disposition: 'canonical_inline_result' });
    assert.throws(() => tasks.setSubscription('initial', { state: 'active' }), { code: 'idempotency_conflict' });
  } finally { db.close(); }
});

test('an open cohort coalesces only matching terminal subscriptions and sealed membership stays immutable', () => {
  const { db, tasks } = fixture();
  try {
    for (const runId of ['one', 'two', 'three']) add(tasks, runId);
    add(tasks, 'old', wake('old', 1)); add(tasks, 'peer', wake('peer', 0, 'peer-parent'));
    tasks.ensureSubscription({ runId: 'unfinished', policy: wake('unfinished') });
    const first = tasks.coalesce({ recipientChatId: 'parent', cancellationEpoch: 0, runIds: ['one', 'old', 'peer', 'unfinished', 'missing'] });
    assert.deepEqual(first.runIds, ['one']);
    const coalesced = tasks.coalesce({ recipientChatId: 'parent', cancellationEpoch: 0, runIds: ['two', 'one'] });
    assert.equal(coalesced.cohortId, first.cohortId); assert.deepEqual(coalesced.runIds, ['one', 'two']);
    const sealed = tasks.seal(first.cohortId);
    assert.equal(sealed.state, 'sealed');
    const next = tasks.coalesce({ recipientChatId: 'parent', cancellationEpoch: 0, runIds: ['three'] });
    assert.notEqual(next.cohortId, first.cohortId);
    assert.deepEqual(tasks.getCohort(first.cohortId).runIds, ['one', 'two']);
    tasks.settleCohort(first.cohortId, { state: 'admitted', commandId: 'parent-input' });
    assert.equal(tasks.getSubscription('one').state, 'accepted');
    assert.equal(tasks.getSubscription('two').state, 'accepted');
    tasks.settleCohort(first.cohortId, { state: 'admitted', commandId: 'parent-input' });
    assert.throws(() => tasks.settleCohort(first.cohortId, { state: 'admitted', commandId: 'replacement' }), { code: 'idempotency_conflict' });
    assert.throws(() => tasks.settleCohort(first.cohortId, { state: 'disposed' }), { code: 'idempotency_conflict' });
    tasks.settleCohort(next.cohortId, { state: 'disposed', disposition: 'recipient_stopped' });
    assert.equal(tasks.getSubscription('three').state, 'disposed');
  } finally { db.close(); }
});

test('reopening SQLite preserves saved result, hold, coalesced membership and admitted command identity', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minnow-task-storage-'));
  const file = path.join(root, 'sessions.db');
  let f = fixture(file);
  try {
    add(f.tasks, 'saved');
    add(f.tasks, 'held', wake('held'), { chatId: 'parent', executionId: 'source', toolCallId: 'spawn' });
    const cohort = f.tasks.coalesce({ recipientChatId: 'parent', cancellationEpoch: 0, runIds: ['saved'] });
    f.tasks.seal(cohort.cohortId);
    f.tasks.settleCohort(cohort.cohortId, { state: 'admitted', commandId: 'durable-input' });
    f.db.close(); f = fixture(file);
    assert.deepEqual(f.tasks.getResult('saved'), result('saved'));
    assert.equal(f.tasks.getSubscription('held').state, 'inline_hold');
    assert.equal(f.tasks.getCohort(cohort.cohortId).commandId, 'durable-input');
    assert.deepEqual(f.tasks.getCohort(cohort.cohortId).runIds, ['saved']);
    assert.equal(f.tasks.getSubscription('saved').state, 'accepted');
    assert.throws(() => f.tasks.saveResult({ ...result('saved'), summary: 'Rewritten after restart' }, { commandId: 'command-saved' }), { code: 'idempotency_conflict' });
  } finally {
    if (f.db.open) f.db.close();
    const relative = path.relative(os.tmpdir(), root);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('inline acceptance requires the exact execution, tool call and parsed terminal result', () => {
  const { db, repository, tasks } = fixture();
  try {
    repository.createChat({ id: 'parent', name: 'Parent', workspacePath: '/project', modeId: 'build' });
    const fence = repository.claimExecution({ chatId: 'parent', executionId: 'source', ownerId: 'host' });
    const prefix = 'm-' + createHash('sha256').update('source').digest('hex').slice(0, 32) + '-';
    let seq = 0;
    const append = (value, toolCallId = 'spawn', messageId = prefix + ++seq) => repository.appendMessage('parent',
      { role: 'tool', tool_call_id: toolCallId, content: typeof value === 'string' ? value : JSON.stringify(value) }, { fence, messageId });
    const query = { chatId: 'parent', executionId: 'source', toolCallId: 'spawn', runId: 'task-one' };
    append('Error while waiting for task-one');
    append({ runId: 'task-one-longer', status: 'completed', summary: 'Another task' });
    append({ runId: 'task-one', status: 'running', timedOut: true, summary: 'Still busy' });
    append({ runId: 'task-one', status: 'completed', summary: 'Wrong call' }, 'another-call');
    append({ runId: 'task-one', status: 'completed', summary: 'Old execution' }, 'spawn', 'm-other-execution-row');
    assert.equal(tasks.canonicalToolResult(query), null);
    append({ runId: 'task-one', status: 'completed', summary: 'Accepted final result' });
    assert.equal(JSON.parse(tasks.canonicalToolResult(query).content).summary, 'Accepted final result');
    assert.equal(tasks.canonicalToolResult({ ...query, toolCallId: 'missing' }), null);
  } finally { db.close(); }
});

test('large completion batches retain every result across bounded immutable cohorts', () => {
  const { db, tasks } = fixture();
  try {
    const runIds = Array.from({ length: 70 }, (_, index) => 'result-' + String(index).padStart(3, '0'));
    for (const runId of runIds) add(tasks, runId);
    const first = tasks.coalesce({ recipientChatId: 'parent', cancellationEpoch: 0, runIds });
    assert.equal(first.runIds.length, 64);
    tasks.seal(first.cohortId);
    const second = tasks.coalesce({ recipientChatId: 'parent', cancellationEpoch: 0, runIds });
    assert.equal(second.runIds.length, 6);
    assert.deepEqual(new Set([...first.runIds, ...second.runIds]), new Set(runIds));
    assert.equal(tasks.listSubscriptions({ states: ['active'] }).filter(row => row.cohortId === null).length, 0);
  } finally { db.close(); }
});

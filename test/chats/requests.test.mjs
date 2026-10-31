import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { initSessionsSchema } from '../../server/config/sessions-schema.js';
import { createChatRepository } from '../../server/chats/repository.js';
import { createChatRequestService } from '../../server/chats/requests.js';

function setup(file = ':memory:') {
  const db = new Database(file); initSessionsSchema(db);
  let time = 1000;
  const repository = createChatRepository({ db, now: () => time });
  if (!db.prepare('SELECT id FROM chats WHERE id=?').get('chat')) repository.createChat({ id: 'chat', workspacePath: 'C:/scratch' });
  const fence = repository.getLease('chat') ?? repository.claimExecution({ chatId: 'chat', executionId: 'execution', ownerId: 'host' });
  const service = createChatRequestService({ repository, now: () => time, pollMs: 10, authorizeResponse: (_request, context) => context === 'local-human' });
  const open = (kind = 'question', extra = {}) => service.open({ chatId: 'chat', executionId: 'execution', toolCallId: `tool-${kind}`,
    kind, title: 'Choose', presentation: { question: 'Which?' }, fence, ...extra });
  return { db, repository, fence, service, open, advance: ms => { time += ms; } };
}

test('durable questions survive viewer reconnect, scope responses and deduplicate their answer receipts', async () => {
  const { db, repository, service, open } = setup();
  try {
    const request = open();
    assert.deepEqual(open(), request);
    const answer = service.wait(request.requestId);
    await assert.rejects(service.respond(request.requestId, { answerCommandId: 'answer', answer: 'Blue', context: 'agent' }), { code: 'caller_denied' });
    assert.equal(repository.getRequest(request.requestId).state, 'pending');
    const receipt = await service.respond(request.requestId, { answerCommandId: 'answer', answer: 'Blue', context: 'local-human' });
    assert.equal(await answer, 'Blue');
    assert.equal(receipt.replayed, false);
    assert.equal((await service.respond(request.requestId, { answerCommandId: 'answer', answer: 'Blue', context: 'local-human' })).replayed, true);
    await assert.rejects(service.respond(request.requestId, { answerCommandId: 'answer', answer: 'Red', context: 'local-human' }), { code: 'idempotency_conflict' });
    assert.equal(service.hasLiveWaiter(request.requestId), false);
  } finally { db.close(); }
});

test('approval reconnect keeps a live callback; a process replacement cannot approve stale work', async () => {
  const { db, repository, service, open } = setup();
  try {
    const live = open('approval');
    const waiting = service.wait(live.requestId);
    assert.equal(service.hasLiveWaiter(live.requestId), true);
    await service.respond(live.requestId, { answerCommandId: 'allow', answer: { decision: 'allow_once' }, context: 'local-human' });
    assert.deepEqual(await waiting, { decision: 'allow_once' });
    const stale = open('approval', { toolCallId: 'old-process' });
    const replacement = createChatRequestService({ repository, authorizeResponse: () => true });
    await assert.rejects(replacement.respond(stale.requestId, { answerCommandId: 'too-late', answer: { decision: 'allow_once' } }), { code: 'request_expired' });
    assert.equal(repository.getRequest(stale.requestId).state, 'expired');
  } finally { db.close(); }
});

test('stop cancels only its request, explicit expiry rejects late answers and changed presentation rejects reuse', async () => {
  const { db, repository, service, open, advance } = setup();
  try {
    const cancelled = open();
    const abort = new AbortController();
    const waiting = service.wait(cancelled.requestId, { signal: abort.signal });
    abort.abort(new DOMException('Stopped by user', 'AbortError'));
    await assert.rejects(waiting, { name: 'AbortError' });
    assert.equal(repository.getRequest(cancelled.requestId).state, 'cancelled');
    const expired = open('question', { toolCallId: 'expiring', expiresAt: 1005 });
    advance(6);
    await assert.rejects(service.wait(expired.requestId), { code: 'request_expired' });
    await assert.rejects(service.respond(expired.requestId, { answerCommandId: 'late', answer: 'late', context: 'local-human' }), { code: 'request_expired' });
    assert.throws(() => open('question', { presentation: { question: 'Changed' } }), { code: 'idempotency_conflict' });
    const locked = createChatRequestService({ repository });
    await assert.rejects(locked.respond(cancelled.requestId, { answerCommandId: 'denied', answer: true }), { code: 'caller_denied' });
  } finally { db.close(); }
});

test('accepted answers remain canonical through a real database close and reopen', async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'minnow-request-'));
  const file = path.join(scratch, 'sessions.sqlite');
  let first, second;
  try {
    first = setup(file);
    const request = first.open();
    await first.service.respond(request.requestId, { answerCommandId: 'answer', answer: { selected: ['A'] }, context: 'local-human' });
    first.db.close();
    second = setup(file);
    assert.deepEqual(await second.service.wait(request.requestId), { selected: ['A'] });
    assert.equal(second.repository.getRequest(request.requestId).answerCommandId, 'answer');
  } finally {
    if (first?.db.open) first.db.close(); if (second?.db.open) second.db.close();
    assert.ok(path.resolve(scratch).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('pending request admission is bounded atomically without rejecting an idempotent replay', () => {
  const { db, repository, fence } = setup();
  try {
    const requests = Array.from({ length: 128 }, (_, index) => ({ version: 1, requestId: `request-${String(index).padStart(3, '0')}`,
      chatId: 'chat', executionId: 'execution', toolCallId: `call-${index}`, kind: 'question', state: 'pending',
      title: 'Choose', presentation: { question: 'Which?' }, createdAt: 1000 }));
    for (const request of requests) repository.saveRequest(request, { fence });
    assert.deepEqual(repository.saveRequest(requests[0], { fence }), requests[0]);
    assert.throws(() => repository.saveRequest({ ...requests[0], requestId: 'overflow' }, { fence }), { code: 'queue_full' });
    assert.equal(repository.listRequests('chat').length, 128);
    repository.respondToRequest(requests[0].requestId, { answerCommandId: 'answer', answer: 'Blue' });
    repository.saveRequest({ ...requests[0], requestId: 'replacement' }, { fence });
    assert.equal(repository.listRequests('chat').length, 128);
  } finally { db.close(); }
});

test('oversized human answers fail before settling their request and a bounded retry retains its receipt', async () => {
  const { db, repository, service, open } = setup();
  try {
    const request = open();
    await assert.rejects(service.respond(request.requestId, { answerCommandId: 'bounded-answer', answer: '😀'.repeat(40000), context: 'local-human' }), { code: 'invalid_request' });
    assert.equal(repository.getRequest(request.requestId).state, 'pending');
    const result = await service.respond(request.requestId, { answerCommandId: 'bounded-answer', answer: 'Version two', context: 'local-human' });
    assert.equal(result.request.state, 'answered');
    assert.equal(repository.readRequestAnswer(request.requestId), 'Version two');
  } finally { db.close(); }
});

test('request presentation pages every pending body within the byte budget, including old oversized backlogs', () => {
  const { db, repository, fence } = setup();
  try {
    for (let index = 0; index < 140; index++) {
      const request = { version: 1, requestId: `request-${String(index).padStart(3, '0')}`, chatId: 'chat', executionId: 'execution',
        toolCallId: `call-${index}`, kind: 'question', state: 'pending', title: 'Choose',
        presentation: { question: index < 4 ? 'A'.repeat(120000) : 'Which?' }, createdAt: 1000 };
      // An archive from an older version may predate the new pending-request cap.
      db.prepare('INSERT INTO chat_requests(request_id,chat_id,execution_id,state,payload_json,updated_at) VALUES(?,?,?,?,?,?)')
        .run(request.requestId, request.chatId, request.executionId, request.state, JSON.stringify(request), 1000);
    }
    const ids = []; let afterRequestId;
    do {
      const page = repository.listRequestPresentation('chat', { afterRequestId });
      assert.equal(page.pendingCount, 140); assert.ok(page.requests.length <= 32);
      assert.ok(Buffer.byteLength(JSON.stringify(page)) < 256 * 1024);
      ids.push(...page.requests.map(row => row.requestId)); afterRequestId = page.nextCursor ?? undefined;
    } while (afterRequestId);
    assert.equal(ids.length, 140); assert.equal(new Set(ids).size, 140);
    assert.throws(() => repository.listRequestPresentation('chat', { limit: 33 }), { code: 'invalid_request' });
    assert.throws(() => repository.saveRequest({ version: 1, requestId: 'unicode-large', chatId: 'chat', executionId: 'execution',
      toolCallId: 'unicode-large', kind: 'question', state: 'pending', title: 'Choose', createdAt: 1000,
      presentation: { question: '😀'.repeat(50000) } }, { fence }), { code: 'invalid_request' });
  } finally { db.close(); }
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { initSessionsSchema } from '../../server/config/sessions-schema.js';
import { createChatRepository } from '../../server/chats/repository.js';
import { createChatTranscriptStore } from '../../server/chats/transcript-store.js';
import { emptyCompactionState } from '../../server/runner/compaction/merge.js';

function fixture() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  initSessionsSchema(db);
  const repository = createChatRepository({ db, now: () => 100 });
  repository.createChat({ id: 'child', name: 'Persistent child', workspacePath: '/fixture', modelId: 'model' });
  const fence = repository.claimExecution({ chatId: 'child', executionId: 'execution', ownerId: 'host' });
  return { db, repository, fence, store: createChatTranscriptStore({ chatId: 'child', repository, fence, now: () => 100 }) };
}
const roundEnd = { type: 'round_end', index: 0, text: 'Done', reasoning: 'Read the original input', toolCallCount: 1,
  usage: { prompt_tokens: 20, completion_tokens: 10 }, finishReason: 'tool_calls', t0: 0, tFirst: 100, tEnd: 1100 };

test('canonical SQLite adapter shares decoration and preserves complete history, compaction and search', () => {
  const { db, repository, store } = fixture();
  try {
    const inputProvenance = { version: 1, actor: 'agent', source: 'agent_tool', kind: 'peer_message', sourceChatId: 'parent', sourceTurnId: 'parent-execution' };
    store.append('child', { role: 'user', content: 'Original evidence: needle-value', provenance: inputProvenance });
    store.observePersisted('child', { type: 'round_start', index: 0 });
    store.observePersisted('child', { type: 'thinking', text: 'Read the original input' });
    const blocks = [{ type: 'thinking', thinking: 'Read the original input', signature: 'signature' }, { type: 'redacted_thinking', data: 'opaque' }];
    store.append('child', { role: 'assistant', content: null, reasoning_blocks: blocks,
      tool_calls: [{ id: 'call_read', type: 'function', function: { name: 'read_file', arguments: '{}' } }] });
    const attachments = [{ type: 'image', mime: 'image/png', url: '/shot', dataUrl: 'data:image/png;base64,aA==' }];
    const codeChange = { additions: 2, deletions: 0, workspacePath: '/fixture', gitBranch: 'feature' };
    store.observePersisted('child', { type: 'tool_result', id: 'call_read', name: 'read_file', content: 'evidence', attachments, codeChange });
    store.append('child', { role: 'tool', tool_call_id: 'call_read', content: 'evidence' });
    store.observePersisted('child', { ...roundEnd, reasoningBlocks: blocks });
    for (let n = 0; n < 60; n++) store.append('child', { role: n % 2 ? 'assistant' : 'user', content: `Follow-up ${n}` });
    const checkpoint = { version: 1, foldThroughRow: 1, elideThroughRow: 2, summary: 'Original evidence summary',
      state: emptyCompactionState(), trigger: 'manual', tokensBefore: 1000, tokensAfter: 300 };
    store.setCompaction('child', checkpoint);
    store.setMeta('child', { reasoningEffort: 'high' });
    const reloaded = createChatTranscriptStore({ chatId: 'child', repository, fence: repository.getLease('child') });
    const transcript = reloaded.load('child');
    assert.equal(transcript.messages.length, 63);
    assert.deepEqual(transcript.rowIds, Array.from({ length: 63 }, (_, n) => n));
    assert.equal(transcript.messages[0].content, 'Original evidence: needle-value');
    assert.deepEqual(transcript.messages[0].provenance, inputProvenance);
    assert.deepEqual(transcript.messages[1].thinkingBlocks, blocks);
    assert.equal(transcript.messages[1].usage.total_tokens, 30);
    assert.deepEqual(transcript.messages[2].attachments, attachments);
    assert.deepEqual(transcript.messages[2].codeChange, codeChange);
    assert.deepEqual(transcript.compaction, checkpoint);
    assert.equal(transcript.meta.reasoningEffort, 'high');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM messages_fts WHERE messages_fts MATCH 'needle'").get().n, 1);
    const ids = transcript.messages.map(row => row.messageId);
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(repository.getChat('child').messageCount, 63);
    reloaded.append('child', { role: 'assistant', content: 'New committed turn' });
    assert.equal(repository.getChat('child').messageCount, 64);
  } finally { db.close(); }
});

test('read-only display rows preserve original compaction row ids and cannot escape the execution fence', () => {
  const { db, repository, fence, store } = fixture();
  try {
    store.append('child', { role: 'user', content: 'First' });
    repository.appendMessage('child', { role: 'context', content: 'UI-only checkpoint' }, { fence, messageId: 'context-row' });
    store.append('child', { role: 'assistant', content: 'Answer' });
    assert.deepEqual(store.load('child').rowIds, [0, 2]);
    assert.equal(store.append('child', { role: 'system', content: 'Do not persist the profile' }), -1);
    assert.throws(() => store.append('another-chat', { role: 'user', content: 'wrong' }), /another chat/);
    repository.updateExecution('execution', { status: 'completed' }, { fence });
    repository.releaseLease('child', fence);
    assert.throws(() => store.append('child', { role: 'user', content: 'stale owner' }), error => error.code === 'ownership_conflict');
    assert.equal(repository.readTranscript('child').messages.length, 3);
  } finally { db.close(); }
});

test('committed transcript survives an actual database close and reopen with stable source identities', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'minnow-transcript-restart-'));
  const filename = path.join(scratch, 'sessions.db');
  let db;
  try {
    db = new Database(filename); initSessionsSchema(db);
    let repository = createChatRepository({ db, now: () => 100 });
    repository.createChat({ id: 'child', name: 'Child', workspacePath: '/fixture', modelId: 'model' });
    const fence = repository.claimExecution({ chatId: 'child', executionId: 'execution', ownerId: 'host' });
    let store = createChatTranscriptStore({ chatId: 'child', repository, fence });
    store.append('child', { role: 'user', content: 'Persistent input', messageId: 'original-input' });
    store.append('child', { role: 'assistant', content: 'Persistent result' });
    const before = repository.readTranscript('child');
    db.close();
    db = new Database(filename); initSessionsSchema(db);
    repository = createChatRepository({ db, now: () => 200 });
    store = createChatTranscriptStore({ chatId: 'child', repository, fence });
    assert.deepEqual(store.load('child').messages, before.messages);
    store.append('child', { role: 'user', content: 'Continue after restart' });
    assert.equal(store.load('child').messages.length, 3);
    assert.equal(new Set(store.load('child').messages.map(row => row.messageId)).size, 3);
  } finally {
    if (db?.open) db.close();
    assert.ok(path.resolve(scratch).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('a lost append receipt retries the same identity and decorated payload without duplication', () => {
  const { db, repository, fence } = fixture();
  let lost = true;
  let now = 0;
  const interrupted = { ...repository, appendMessage(...args) {
    const result = repository.appendMessage(...args);
    if (lost) { lost = false; throw new Error('receipt lost after commit'); }
    return result;
  } };
  const store = createChatTranscriptStore({ chatId: 'child', repository: interrupted, fence, now: () => now });
  try {
    store.observePersisted('child', { type: 'round_start', index: 0 });
    store.observePersisted('child', { type: 'thinking', text: 'Measured thought' });
    now = 300;
    const message = { role: 'assistant', content: 'Preserved answer' };
    assert.throws(() => store.append('child', message), /receipt lost/);
    now = 600;
    assert.equal(store.append('child', { ...message }), 0);
    const saved = repository.readTranscript('child').messages;
    assert.equal(saved.length, 1);
    assert.equal(saved[0].thinkingDurationMs, 300);
  } finally { db.close(); }
});

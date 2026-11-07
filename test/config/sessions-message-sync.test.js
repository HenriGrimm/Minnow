import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { initSessionsSchema } from '../../server/config/sessions-schema.js';
import { patchSessionState } from '../../server/config/sessions-repo.js';
import { createChatRepository } from '../../server/chats/repository.js';
import { longChatHistory } from '../fixtures/long-chat-history.mjs';

let db;
afterEach(() => db?.close());

function fixture(history, filename = ':memory:') {
  const statements = [];
  db = new Database(filename, { verbose: sql => statements.push(sql) });
  db.pragma('foreign_keys = ON');
  initSessionsSchema(db);
  const save = rows => patchSessionState({ chats: [{ id: 'chat', name: 'Chat', history: rows }] }, { db });
  save(history);
  db.exec(`CREATE TABLE message_writes (operation TEXT, seq INTEGER);
    CREATE TRIGGER audit_message_insert AFTER INSERT ON messages BEGIN
      INSERT INTO message_writes VALUES ('insert', NEW.seq); END;
    CREATE TRIGGER audit_message_update AFTER UPDATE ON messages BEGIN
      INSERT INTO message_writes VALUES ('update', NEW.seq); END;
    CREATE TRIGGER audit_message_delete AFTER DELETE ON messages BEGIN
      INSERT INTO message_writes VALUES ('delete', OLD.seq); END;`);
  statements.length = 0;
  return { save, statements,
    writes: () => db.prepare('SELECT operation, seq FROM message_writes').all(),
    index: () => db.prepare('SELECT rowid, seq, role, body FROM messages_fts ORDER BY seq').all(),
  };
}

test('appending and settling assistant metadata preserve the unchanged tail and search index', () => {
  const history = [
    { role: 'user', content: 'question' },
    { role: 'assistant', content: 'answer' },
    { role: 'tool', content: 'tool result', tool_call_id: 'call' },
  ];
  const { save, statements, writes, index } = fixture(history);
  const priorIndex = index();
  const next = [...history, { role: 'assistant', content: 'finished' }];
  next[1] = { ...next[1], usage: { total_tokens: 42 }, stats: { generation_time: 1 } };
  save(next);
  assert.deepEqual(writes(), [{ operation: 'update', seq: 1 }, { operation: 'insert', seq: 3 }]);
  assert.deepEqual(index().slice(0, 3), priorIndex);
  assert.equal(statements.some(sql => /DELETE FROM messages_fts/i.test(sql)), false,
    'append and metadata updates must not scan the unindexed search mirror');
  assert.equal(JSON.parse(db.prepare('SELECT payload_json FROM messages WHERE seq=1').get().payload_json).usage.total_tokens, 42);
});

test('saving an unchanged transcript keeps its digest and performs no message or search writes', () => {
  const history = [{ role: 'user', content: 'question' }, { role: 'assistant', content: 'answer' }];
  const { save, statements, writes, index } = fixture(history);
  const before = db.prepare('SELECT message_count, history_digest, last_message_preview FROM chats').get();
  const priorIndex = index();
  save(history);
  assert.deepEqual(writes(), []);
  assert.deepEqual(index(), priorIndex);
  assert.deepEqual(db.prepare('SELECT message_count, history_digest, last_message_preview FROM chats').get(), before);
  assert.equal(statements.some(sql => /(?:INSERT INTO|DELETE FROM) messages_fts/i.test(sql)), false);
});

const managedMetadataStatementCounts = [];
for (const count of [10, 100, 2500]) test(`managed metadata saves preserve ${count} canonical rows without reading message bodies`, t => {
  const { statements, writes, index } = fixture(longChatHistory(count));
  createChatRepository({ db }).ensureManagedChat('chat');
  const before = db.prepare('SELECT rowid, * FROM messages ORDER BY seq').all();
  const beforeIndex = index();
  const derived = db.prepare('SELECT message_count, history_digest FROM chats').get();
  statements.length = 0;
  const start = performance.now();
  for (let iteration = 0; iteration < 3; iteration++) {
    // Stale legacy bases with unchanged presentation exercise recovery without
    // fetching history; real displaced edits still get an atomic recovery copy.
    patchSessionState({ chats: [{ id: 'chat', name: 'Chat', groupId: '', updatedAt: iteration + 1 }],
      chatBaseRevisions: { chat: 0 }, recoverConflicts: true }, { db });
  }
  const durationMs = performance.now() - start;
  managedMetadataStatementCounts.push(statements.length);
  assert.equal(statements.length, managedMetadataStatementCounts[0], 'SQL work is independent of history length');
  t.diagnostic(JSON.stringify({ messages: count, metadataSaves: 3, sqlStatements: statements.length, durationMs: +durationMs.toFixed(3) }));
  assert.equal(statements.some(sql => /SELECT.*payload_json.*FROM messages/i.test(sql)), false);
  assert.deepEqual(writes(), []);
  assert.deepEqual(db.prepare('SELECT rowid, * FROM messages ORDER BY seq').all(), before);
  assert.deepEqual(index(), beforeIndex);
  assert.deepEqual(db.prepare('SELECT message_count, history_digest FROM chats').get(), derived);
});

test('managed metadata writes retain the full settled transcript and row identities across reopen', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minnow-managed-save-'));
  t.after(() => { if (db?.open) db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const filename = path.join(root, 'sessions.sqlite');
  fixture(longChatHistory(2500), filename);
  createChatRepository({ db }).ensureManagedChat('chat');
  const before = db.prepare('SELECT rowid, seq, payload_json, row_hash FROM messages ORDER BY seq').all();
  patchSessionState({ chats: [{ id: 'chat', name: 'Renamed', composerDraft: 'Saved draft' }],
    chatBasePresentationRevisions: { chat: 0 } }, { db });
  db.close(); db = new Database(filename); initSessionsSchema(db);
  assert.deepEqual(db.prepare('SELECT rowid, seq, payload_json, row_hash FROM messages ORDER BY seq').all(), before);
  const chat = db.prepare('SELECT name, meta_json FROM chats WHERE id=?').get('chat');
  assert.equal(chat.name, 'Renamed');
  assert.equal(JSON.parse(chat.meta_json).composerDraft, 'Saved draft');
});

test('editing text, changing roles, truncating and reappending keep search results in sync', () => {
  const { save, writes } = fixture([
    { role: 'user', content: 'obsolete' },
    { role: 'assistant', content: 'retained' },
    { role: 'tool', content: 'removed' },
  ]);
  save([{ role: 'assistant', content: 'replacement' }, { role: 'user', content: 'retained' }]);
  assert.deepEqual(writes(), [
    { operation: 'delete', seq: 2 }, { operation: 'update', seq: 0 }, { operation: 'update', seq: 1 },
  ]);
  assert.equal(db.prepare("SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH 'obsolete OR removed'").get().n, 0);
  assert.deepEqual(db.prepare('SELECT seq, role, body FROM messages_fts ORDER BY seq').all(), [
    { seq: 0, role: 'assistant', body: 'replacement' }, { seq: 1, role: 'user', body: 'retained' },
  ]);
  save([{ role: 'assistant', content: 'replacement' }, { role: 'user', content: 'retained' }, { role: 'assistant', content: 'appended' }]);
  assert.equal(db.prepare("SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH 'appended'").get().n, 1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM messages_fts').get().n, 3);
});

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ChatContractError, validateAgentConversationMeta, validateChatCommand, validateChatRequest, validateChatTaskResult } from './contracts.js';
import { initChatWorkspaceSchema } from './workspace-repository.js';
import { messageTextContent } from '../config/sessions-import.js';
import { readSessionMeta, writeSessionMeta } from '../config/sessions-schema.js';
import { agentsDir, restoreEvents } from '../sub-agents/journal.js';
import { validateEvent } from '../sub-agents/events.js';

export const CHAT_ARCHIVE_VERSION = 1;
export const CHAT_ARCHIVE_TABLES = Object.freeze([
  'session_meta', 'groups', 'chats', 'chat_revisions', 'messages', 'chat_terminal_history', 'chat_runs', 'chat_sub_agent_runs', 'chat_loops', 'board_tasks', 'board_log',
  'chat_conversation_state', 'chat_relations', 'chat_execution_profiles', 'chat_commands', 'chat_executions', 'chat_execution_leases',
  'chat_message_identities', 'chat_requests', 'chat_tool_invocations', 'chat_cancellation_epochs', 'chat_conversation_tombstones', 'chat_outbox',
  'chat_task_results', 'chat_task_subscriptions', 'chat_completion_cohorts', 'chat_activity_reads', 'chat_usage_receipts', 'chat_workspace_allocations',
]);
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_JOURNAL_CHUNK_BYTES = 4 * 1024 * 1024;
const stableId = value => createHash('sha256').update(value).digest('hex');
function fail(code, message) { throw new ChatContractError(code, message); }
function plain(value) { return value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)); }
function canonical(value, depth = 0) {
  if (depth > 64) fail('invalid_request', 'The conversation archive is too deeply nested');
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return Array.from({ length: value.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail('invalid_request', 'Invalid conversation archive array');
    return canonical(descriptor.value, depth + 1);
  });
  if (!plain(value)) fail('invalid_request', 'The conversation archive must contain plain JSON data');
  const output = {};
  for (const key of Object.keys(value).sort()) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (['__proto__', 'constructor', 'prototype'].includes(key) || !descriptor || !Object.hasOwn(descriptor, 'value')) fail('invalid_request', 'Invalid conversation archive field');
    output[key] = canonical(descriptor.value, depth + 1);
  }
  return output;
}
export function hashChatArchive(value) {
  const encoded = JSON.stringify(canonical(value));
  if (Buffer.byteLength(encoded) > MAX_ARCHIVE_BYTES) fail('invalid_request', 'This JSON archive exceeds 256 MiB. Use a Minnow backup for larger stores.');
  return stableId(encoded);
}
function journalOwner(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(value) || value.includes('..')) fail('invalid_request', 'Invalid archived journal owner');
  return value;
}
function validateJournals(journals) {
  if (!Array.isArray(journals)) fail('invalid_request', 'Conversation journals must be an array');
  const owners = new Set();
  for (const journal of journals) {
    if (!plain(journal) || Object.keys(journal).some(key => !['journalOwnerId', 'events'].includes(key)) || !Array.isArray(journal.events)) fail('invalid_request', 'Invalid archived journal');
    const owner = journalOwner(journal.journalOwnerId);
    if (owners.has(owner)) fail('invalid_request', 'A journal owner appears more than once'); owners.add(owner);
    let previous = 0;
    for (const event of journal.events) {
      const checked = validateEvent(event);
      if (!checked.ok || !Number.isSafeInteger(event.seq) || event.seq !== previous + 1) fail('invalid_request', 'An archived journal has invalid or missing events');
      if (Buffer.byteLength(JSON.stringify(event)) > MAX_JOURNAL_CHUNK_BYTES / 2) fail('invalid_request', 'An archived journal event exceeds the supported import size');
      previous = event.seq;
    }
  }
}
function columnsFor(db, table) { return db.prepare('PRAGMA table_info(' + table + ')').all(); }

/** Explicit export may contain private prompts and full history; no summary path calls this. */
export function exportChatArchive(db, { now = Date.now } = {}) {
  initChatWorkspaceSchema(db);
  return db.transaction(() => {
    const tables = Object.fromEntries(CHAT_ARCHIVE_TABLES.map(table => [table, db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all()]));
    const owners = new Set(tables.chat_relations.map(row => row.journal_owner_id));
    for (const row of tables.chat_outbox) {
      const payload = JSON.parse(row.payload_json);
      if (payload.journalOwnerId) owners.add(payload.journalOwnerId);
    }
    // Retain legacy family evidence too, including families with a deleted parent.
    const root = path.dirname(agentsDir('archive-probe'));
    if (fs.existsSync(root)) for (const entry of fs.readdirSync(root, { withFileTypes: true })) if (entry.isDirectory() && /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(entry.name) && !entry.name.includes('..')) owners.add(entry.name);
    const journals = [...owners].sort().map(owner => {
      const file = path.join(agentsDir(journalOwner(owner)), 'journal.jsonl');
      for (const location of [agentsDir(owner), file]) if (fs.existsSync(location) && fs.lstatSync(location).isSymbolicLink()) fail('recovery_required', 'An archived journal cannot be a symbolic link');
      const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
      const events = text.split(/\r?\n/).filter(line => line.trim()).map(line => { try { return JSON.parse(line); } catch { fail('recovery_required', 'A family journal is still being written. Retry the export.'); } });
      return { journalOwnerId: owner, events };
    });
    validateJournals(journals);
    const payload = { version: CHAT_ARCHIVE_VERSION, kind: 'minnow.conversation-archive', clientProtocol: 1, sqliteVersion: 1, sessionVersion: 6, createdAt: now(), tables, journals };
    return { ...payload, digest: hashChatArchive(payload) };
  })();
}

export function validateChatArchive(db, input) {
  if (!plain(input) || input.version !== CHAT_ARCHIVE_VERSION || input.kind !== 'minnow.conversation-archive' || input.clientProtocol !== 1 || input.sqliteVersion !== 1 || input.sessionVersion !== 6) fail('unsupported_version', 'This conversation archive requires a compatible Minnow reader');
  if (Object.keys(input).some(key => !['version', 'kind', 'clientProtocol', 'sqliteVersion', 'sessionVersion', 'createdAt', 'tables', 'journals', 'digest'].includes(key)) || !plain(input.tables) || !Number.isSafeInteger(input.createdAt) || input.createdAt < 0) fail('invalid_request', 'Invalid conversation archive envelope');
  const { digest, ...payload } = input;
  if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest) || hashChatArchive(payload) !== digest) fail('invalid_request', 'The conversation archive checksum does not match');
  if (Object.keys(input.tables).length !== CHAT_ARCHIVE_TABLES.length || Object.keys(input.tables).some(table => !CHAT_ARCHIVE_TABLES.includes(table))) fail('invalid_request', 'The conversation archive table set is incomplete or unsupported');
  initChatWorkspaceSchema(db);
  for (const table of CHAT_ARCHIVE_TABLES) {
    const rows = input.tables[table], allowed = columnsFor(db, table).map(column => column.name);
    if (!Array.isArray(rows)) fail('invalid_request', 'Invalid conversation archive table');
    for (const row of rows) {
      if (!plain(row) || Object.keys(row).length !== allowed.length || Object.keys(row).some(key => !allowed.includes(key)) ||
        Object.values(row).some(value => value !== null && typeof value !== 'string' && !(typeof value === 'number' && Number.isFinite(value)))) fail('invalid_request', 'Invalid conversation archive row in ' + table);
      for (const [key, value] of Object.entries(row)) if (key.endsWith('_json') || table === 'session_meta' && key === 'value') {
        try { JSON.parse(value); } catch { fail('invalid_request', 'Invalid archived JSON in ' + table); }
      }
    }
  }
  validateJournals(input.journals);
  for (const row of input.tables.messages) if (stableId(row.payload_json) !== row.row_hash) fail('invalid_request', 'An archived transcript row has an invalid hash');
  for (const [table, validate, column, key] of [
    ['chat_relations', validateAgentConversationMeta, 'chat_id', 'childChatId'], ['chat_commands', validateChatCommand, 'command_id', 'commandId'],
    ['chat_requests', validateChatRequest, 'request_id', 'requestId'], ['chat_task_results', validateChatTaskResult, 'run_id', 'runId'],
  ]) for (const row of input.tables[table]) {
    const parsed = validate(JSON.parse(row.payload_json));
    if (!parsed.ok || parsed.value[key] !== row[column]) fail('invalid_request', 'Invalid protected archived record in ' + table);
    const value = parsed.value;
    if (table === 'chat_relations' && (value.parentChatId !== row.parent_chat_id || value.rootChatId !== row.root_chat_id || value.journalOwnerId !== row.journal_owner_id) ||
      table === 'chat_requests' && (value.chatId !== row.chat_id || value.executionId !== row.execution_id || value.state !== row.state) ||
      table === 'chat_task_results' && (value.childChatId !== row.chat_id || value.journalOwnerId !== row.journal_owner_id || value.settledAt !== row.settled_at || hashChatArchive(value) !== row.payload_hash)) {
      fail('invalid_request', 'Archived record columns disagree with their protected payload in ' + table);
    }
    if (table === 'chat_commands') {
      const effective = validateChatCommand(JSON.parse(row.effective_json));
      if (!effective.ok || value.chatId !== row.chat_id || effective.value.commandId !== row.command_id || effective.value.chatId !== row.chat_id || effective.value.kind !== value.kind) fail('invalid_request', 'Invalid effective archived command');
    }
  }
  const relations = new Map(input.tables.chat_relations.map(row => [row.chat_id, row]));
  for (const relation of relations.values()) {
    const ancestors = new Set([relation.chat_id]); let parent = relation.parent_chat_id;
    while (parent && relations.has(parent)) {
      if (ancestors.has(parent)) fail('invalid_request', 'An archived conversation family contains a cycle');
      ancestors.add(parent); parent = relations.get(parent).parent_chat_id;
    }
    const reference = JSON.parse(relation.payload_json).profileReference;
    if (reference && !input.tables.chat_execution_profiles.some(row => row.chat_id === relation.chat_id && row.profile_id === reference.profileId && row.profile_version === reference.profileVersion)) fail('invalid_request', 'An archived conversation is missing its captured profile');
  }
  for (const row of input.tables.chat_execution_profiles) if (stableId(row.payload_json) !== row.payload_hash) fail('invalid_request', 'An archived profile has an invalid hash');
  return input;
}

/** Import is additive and held. Only a human's later resume can license imported pending work. */
export function importChatArchive(db, input, { now = Date.now } = {}) {
  const archive = validateChatArchive(db, input);
  const receiptId = 'archive-import-' + archive.digest;
  const existing = db.prepare('SELECT payload_json FROM chat_outbox WHERE outbox_id=?').get(receiptId);
  if (existing) return { ...JSON.parse(existing.payload_json), replayed: true };
  return db.transaction(() => {
    const priorRevision = readSessionMeta(db, 'revision') ?? 0;
    const hadChats = db.prepare('SELECT COUNT(*) AS count FROM chats').get().count > 0;
    const positionOffset = db.prepare('SELECT COALESCE(MAX(position),0) AS n FROM chat_commands').get().n;
    const logOffset = db.prepare('SELECT COALESCE(MAX(seq),0) AS n FROM board_log').get().n;
    for (const table of CHAT_ARCHIVE_TABLES) {
      if (table === 'session_meta') continue;
      const columns = columnsFor(db, table), keys = columns.filter(column => column.pk).sort((a, b) => a.pk - b.pk).map(column => column.name);
      const names = columns.map(column => column.name);
      const lookup = db.prepare('SELECT 1 FROM ' + table + ' WHERE ' + keys.map(key => key + '=?').join(' AND '));
      const insert = db.prepare('INSERT INTO ' + table + '(' + names.join(',') + ') VALUES (' + names.map(() => '?').join(',') + ')');
      for (const row of archive.tables[table]) {
        const restored = table === 'chat_commands' ? { ...row, position: row.position + positionOffset }
          : table === 'board_log' ? { ...row, seq: row.seq + logOffset } : row;
        if (lookup.get(...keys.map(key => restored[key]))) fail('idempotency_conflict', 'This archive overlaps existing ' + table + ' records. Restore a backup to replace an existing home.');
        insert.run(...names.map(name => restored[name]));
      }
    }
    for (const row of archive.tables.session_meta) {
      if (['jsonImportedAt', 'jsonImportFailedAt', 'jsonImportFailedMessage', 'revision'].includes(row.key)) continue;
      db.prepare('INSERT INTO session_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO ' + (hadChats ? 'NOTHING' : 'UPDATE SET value=excluded.value')).run(row.key, row.value);
    }
    const importedIds = archive.tables.chats.map(row => row.id);
    const managed = new Set(archive.tables.chat_conversation_state.map(row => row.chat_id));
    for (const chatId of importedIds) {
      const messages = db.prepare('SELECT seq,payload_json,role FROM messages WHERE chat_id=? ORDER BY seq').all(chatId);
      for (const message of messages) db.prepare('INSERT INTO messages_fts(chat_id,seq,role,body) VALUES(?,?,?,?)').run(chatId, message.seq, message.role, messageTextContent(JSON.parse(message.payload_json)));
      if (managed.has(chatId)) {
        db.prepare("UPDATE chat_commands SET held=1 WHERE chat_id=? AND state IN ('accepted','queued','waiting_for_host','running')").run(chatId);
        db.prepare('INSERT INTO chat_cancellation_epochs(chat_id,epoch) VALUES(?,1) ON CONFLICT(chat_id) DO UPDATE SET epoch=epoch+1').run(chatId);
        const row = db.prepare('SELECT meta_json FROM chat_conversation_state WHERE chat_id=?').get(chatId), meta = JSON.parse(row.meta_json);
        db.prepare('UPDATE chat_conversation_state SET meta_json=? WHERE chat_id=?').run(JSON.stringify({ ...meta, subAgentAutoResumeBlocked: true,
          archiveImport: { digest: archive.digest, importedAt: now(), sourceProfileTrust: 'archival', requiresHumanResume: true } }), chatId);
      }
    }
    const ownerIds = new Set(archive.tables.chat_executions.map(row => row.execution_id));
    for (const executionId of ownerIds) {
      // Explicit JSON imports are detached archival evidence. A same-home boot
      // or .mnbak restore uses recovery instead and can reattach live questions.
      db.prepare("UPDATE chat_requests SET state='expired',payload_json=json_set(payload_json,'$.state','expired','$.settledAt',?) WHERE execution_id=? AND state='pending'").run(now(), executionId);
      db.prepare("UPDATE chat_execution_leases SET expires_at=0 WHERE execution_id=? AND state='active'").run(executionId);
    }
    for (const row of archive.tables.chat_requests) if (!ownerIds.has(row.execution_id) && row.state === 'pending') {
      db.prepare("UPDATE chat_requests SET state='expired',payload_json=json_set(payload_json,'$.state','expired','$.settledAt',?) WHERE request_id=?").run(now(), row.request_id);
    }
    for (const row of archive.tables.chat_outbox) if (row.state === 'applying') db.prepare("UPDATE chat_outbox SET state='pending',owner_id=NULL,expires_at=NULL WHERE outbox_id=?").run(row.outbox_id);
    for (const row of archive.tables.chat_workspace_allocations) {
      const allocation = JSON.parse(row.payload_json);
      if (allocation.strategy !== 'new_worktree' || !['reserved', 'allocating', 'ready'].includes(allocation.setupState)) continue;
      const next = { ...allocation, setupState: 'recovery_required', ownerId: null, revision: allocation.revision + 1, updatedAt: now(),
        archivedAllocation: { setupState: allocation.setupState, importedFrom: archive.digest },
        error: 'This imported checkout is archival evidence. It cannot grant isolated workspace authority; continue in an independently registered checkout.' };
      db.prepare('UPDATE chat_workspace_allocations SET setup_state=?,revision=?,payload_json=?,updated_at=? WHERE allocation_id=?')
        .run(next.setupState, next.revision, JSON.stringify(next), next.updatedAt, row.allocation_id);
    }
    let chunks = 0;
    for (const journal of archive.journals) {
      let events = [], bytes = 0;
      const flush = () => {
        if (!events.length) return;
        const payload = { journalOwnerId: journal.journalOwnerId, events };
        const outboxId = 'archive-journal-' + archive.digest.slice(0, 32) + '-' + stableId(journal.journalOwnerId).slice(0, 16) + '-' + String(chunks++).padStart(10, '0');
        db.prepare('INSERT INTO chat_outbox(outbox_id,chat_id,kind,payload_hash,payload_json,created_at,updated_at) VALUES(?,NULL,?,?,?,?,?)')
          .run(outboxId, 'archive.journal.restore', hashChatArchive({ chatId: null, kind: 'archive.journal.restore', payload }), JSON.stringify(payload), now(), now());
        events = []; bytes = 0;
      };
      for (const event of journal.events) { const size = Buffer.byteLength(JSON.stringify(event)); if (bytes + size > MAX_JOURNAL_CHUNK_BYTES) flush(); events.push(event); bytes += size; }
      flush();
    }
    const sourceRevision = Number(JSON.parse(archive.tables.session_meta.find(row => row.key === 'revision')?.value ?? '0')) || 0;
    const revision = Math.max(priorRevision, sourceRevision) + 1; writeSessionMeta(db, 'revision', revision);
    if (hadChats) for (const chatId of importedIds) db.prepare('INSERT INTO chat_revisions(chat_id,revision) VALUES(?,?) ON CONFLICT(chat_id) DO UPDATE SET revision=excluded.revision').run(chatId, revision);
    const receipt = { version: 1, digest: archive.digest, chatIds: importedIds, sourceRevision, revision, journalChunks: chunks, held: true };
    db.prepare("INSERT INTO chat_outbox(outbox_id,chat_id,kind,payload_hash,payload_json,state,created_at,updated_at) VALUES(?,NULL,'archive.imported',?,?,'applied',?,?)")
      .run(receiptId, hashChatArchive({ chatId: null, kind: 'archive.imported', payload: receipt }), JSON.stringify(receipt), now(), now());
    return { ...receipt, replayed: false };
  }).immediate();
}

/** Replay exact stamped events after SQLite commits; never overwrite a divergent family timeline. */
export async function restoreArchivedJournal({ journalOwnerId, events }) {
  const owner = journalOwner(journalOwnerId);
  validateJournals([{ journalOwnerId: owner, events: events.map((event, index) => ({ ...event, seq: index + 1 })) }]);
  await restoreEvents(owner, events);
}

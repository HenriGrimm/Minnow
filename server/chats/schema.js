/** Additive conversation storage inside sessions.db; no runtime/store imports. */
export function initChatConversationSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_conversation_state (
      chat_id TEXT PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
      record_version INTEGER NOT NULL DEFAULT 1,
      project_id TEXT NOT NULL DEFAULT '',
      meta_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE IF NOT EXISTS chat_relations (
      chat_id TEXT PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
      parent_chat_id TEXT,
      root_chat_id TEXT NOT NULL,
      journal_owner_id TEXT NOT NULL,
      project_id TEXT NOT NULL DEFAULT '',
      payload_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chat_relations_parent ON chat_relations(parent_chat_id);
    CREATE INDEX IF NOT EXISTS idx_chat_relations_project ON chat_relations(project_id);
    CREATE TABLE IF NOT EXISTS chat_execution_profiles (
      profile_id TEXT NOT NULL,
      profile_version INTEGER NOT NULL,
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      payload_hash TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      PRIMARY KEY (profile_id, profile_version)
    );
    CREATE TABLE IF NOT EXISTS chat_commands (
      position INTEGER PRIMARY KEY AUTOINCREMENT,
      command_id TEXT NOT NULL UNIQUE,
      producer_id TEXT NOT NULL,
      request_key TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      input_hash TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      effective_json TEXT NOT NULL,
      captured_json TEXT NOT NULL DEFAULT '{}',
      held INTEGER NOT NULL DEFAULT 0,
      revision INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL DEFAULT 'accepted',
      execution_id TEXT,
      run_id TEXT,
      message_id TEXT,
      result_json TEXT,
      error_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (producer_id, request_key)
    );
    CREATE INDEX IF NOT EXISTS idx_chat_commands_queue ON chat_commands(chat_id, state, position);
    CREATE TABLE IF NOT EXISTS chat_executions (
      execution_id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      command_id TEXT,
      run_id TEXT,
      attempt_id TEXT,
      kind TEXT NOT NULL DEFAULT 'server',
      status TEXT NOT NULL DEFAULT 'queued',
      captured_json TEXT NOT NULL DEFAULT '{}',
      result_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      settled_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_chat_executions_chat ON chat_executions(chat_id, created_at);
    CREATE TABLE IF NOT EXISTS chat_activity_reads (
      chat_id TEXT PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
      message_seq INTEGER NOT NULL DEFAULT -1,
      execution_id TEXT
    );
    CREATE TABLE IF NOT EXISTS chat_usage_receipts (
      execution_id TEXT NOT NULL, round_index INTEGER NOT NULL, chat_id TEXT NOT NULL,
      payload_hash TEXT NOT NULL, payload_json TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY (execution_id, round_index)
    );
    CREATE TABLE IF NOT EXISTS chat_execution_leases (
      chat_id TEXT PRIMARY KEY,
      execution_id TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      epoch INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      state TEXT NOT NULL DEFAULT 'active'
    );
    CREATE TABLE IF NOT EXISTS chat_message_identities (
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      message_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      input_hash TEXT NOT NULL,
      PRIMARY KEY (chat_id, message_id),
      UNIQUE (chat_id, seq)
    );
    CREATE TABLE IF NOT EXISTS chat_requests (
      request_id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      execution_id TEXT NOT NULL,
      state TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      response_hash TEXT,
      response_json TEXT,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chat_requests_pending ON chat_requests(chat_id, state);
    CREATE TABLE IF NOT EXISTS chat_tool_invocations (
      invocation_id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      execution_id TEXT NOT NULL,
      tool_call_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      input_hash TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'intent',
      result_hash TEXT,
      result_json TEXT,
      created_at INTEGER NOT NULL,
      settled_at INTEGER,
      UNIQUE (execution_id, tool_call_id)
    );
    CREATE INDEX IF NOT EXISTS idx_chat_tools_unsettled ON chat_tool_invocations(execution_id, state);
    CREATE TABLE IF NOT EXISTS chat_cancellation_epochs (
      chat_id TEXT PRIMARY KEY,
      epoch INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS chat_conversation_tombstones (
      chat_id TEXT PRIMARY KEY,
      deleted_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chat_outbox (
      outbox_id TEXT PRIMARY KEY,
      chat_id TEXT,
      kind TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      owner_id TEXT,
      expires_at INTEGER,
      error_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chat_outbox_pending ON chat_outbox(state, created_at);
    CREATE TABLE IF NOT EXISTS chat_task_results (
      run_id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, journal_owner_id TEXT NOT NULL,
      command_id TEXT NOT NULL, payload_hash TEXT NOT NULL, payload_json TEXT NOT NULL,
      settled_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chat_task_results_owner ON chat_task_results(journal_owner_id, settled_at);
    CREATE TABLE IF NOT EXISTS chat_task_subscriptions (
      run_id TEXT PRIMARY KEY, subscription_id TEXT NOT NULL UNIQUE, completion_kind TEXT NOT NULL,
      recipient_chat_id TEXT, cancellation_epoch INTEGER NOT NULL DEFAULT 0, policy_json TEXT NOT NULL,
      state TEXT NOT NULL, hold_execution_id TEXT, hold_tool_call_id TEXT, cohort_id TEXT,
      disposition TEXT, updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chat_subscriptions_pending ON chat_task_subscriptions(recipient_chat_id,state);
    CREATE TABLE IF NOT EXISTS chat_completion_cohorts (
      cohort_id TEXT PRIMARY KEY, recipient_chat_id TEXT NOT NULL, cancellation_epoch INTEGER NOT NULL,
      state TEXT NOT NULL DEFAULT 'open', payload_json TEXT NOT NULL DEFAULT '{}',
      command_id TEXT, disposition TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_cohorts_open ON chat_completion_cohorts(recipient_chat_id,cancellation_epoch) WHERE state='open';
  `);
  if (!db.prepare('PRAGMA table_info(chat_conversation_state)').all().some((column) => column.name === 'project_id')) {
    db.exec("ALTER TABLE chat_conversation_state ADD COLUMN project_id TEXT NOT NULL DEFAULT ''");
  }
  const requestColumns = db.prepare('PRAGMA table_info(chat_requests)').all();
  for (const column of ['response_hash', 'response_json']) {
    if (!requestColumns.some((entry) => entry.name === column)) db.exec('ALTER TABLE chat_requests ADD COLUMN ' + column + ' TEXT');
  }
  const commandColumns = db.prepare('PRAGMA table_info(chat_commands)').all();
  if (!db.prepare('PRAGMA table_info(chat_executions)').all().some(column => column.name === 'activated_at')) {
    db.exec('ALTER TABLE chat_executions ADD COLUMN activated_at INTEGER');
  }
  if (!db.prepare('PRAGMA table_info(chat_executions)').all().some(column => column.name === 'activity_json')) {
    db.exec("ALTER TABLE chat_executions ADD COLUMN activity_json TEXT NOT NULL DEFAULT '{}'");
  }
  for (const [column, ddl] of [['captured_json', "TEXT NOT NULL DEFAULT '{}'"], ['held', 'INTEGER NOT NULL DEFAULT 0']]) {
    if (!commandColumns.some((entry) => entry.name === column)) db.exec('ALTER TABLE chat_commands ADD COLUMN ' + column + ' ' + ddl);
  }
  db.exec("INSERT OR IGNORE INTO chat_activity_reads(chat_id,message_seq,execution_id) SELECT s.chat_id,COALESCE((SELECT MAX(m.seq) FROM messages m WHERE m.chat_id=s.chat_id),-1),(SELECT CASE WHEN e.status IN ('completed','failed','stopped','recovery_required') THEN e.execution_id END FROM chat_executions e WHERE e.chat_id=s.chat_id ORDER BY e.rowid DESC LIMIT 1) FROM chat_conversation_state s");
  db.exec("UPDATE chat_activity_reads SET execution_id=NULL WHERE EXISTS (SELECT 1 FROM chat_executions e WHERE e.execution_id=chat_activity_reads.execution_id AND e.status NOT IN ('completed','failed','stopped','recovery_required'))");
}

export function isManagedConversation(db, chatId) {
  return Boolean(db.prepare('SELECT 1 FROM chat_conversation_state WHERE chat_id = ?').get(chatId));
}

/** The projection omits prompt/profile/command bodies, even on summary reads. */
export function readAgentConversationProjection(db, chatId) {
  const row = db.prepare('SELECT payload_json, parent_chat_id FROM chat_relations WHERE chat_id = ?').get(chatId);
  if (!row) return undefined;
  const relation = JSON.parse(row.payload_json);
  if (row.parent_chat_id && !db.prepare('SELECT 1 FROM chats WHERE id = ?').get(row.parent_chat_id)) {
    relation.missingParent = true;
  }
  return relation;
}

/** Retained revision rows fence deleted identities against old client saves. */
export function isDeletedConversation(db, chatId) {
  return !db.prepare('SELECT 1 FROM chats WHERE id = ?').get(chatId)
    && Boolean(db.prepare('SELECT 1 FROM chat_revisions WHERE chat_id = ?').get(chatId));
}

export function isDeletedManagedConversation(db, chatId) {
  return Boolean(db.prepare('SELECT 1 FROM chat_conversation_tombstones WHERE chat_id=?').get(chatId));
}

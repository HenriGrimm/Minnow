/**
 * SQLite DDL for ~/.minnow/sessions/sessions.db (Phase A.1).
 * PRAGMA user_version starts at 1; additive columns use ensureColumn and never bump it.
 * messages_fts is created up front so FTS never forces a user_version move.
 *
 * Meta helpers live here (not sessions-db.js) so sessions-import.js can stamp flags
 * without a circular import through getSessionsDb → importJsonSessionsIfNeeded.
 */

/** SQLite table-layout version (distinct from SESSION_SCHEMA_VERSION wire shape = 6). */
export const SESSIONS_DB_SCHEMA_VERSION = 1;

function parseJson(raw, fallback) {
  if (typeof raw !== 'string' || !raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

/** Read a session_meta value as JSON. */
export function readSessionMeta(db, key, fallback = null) {
  const row = db.prepare('SELECT value FROM session_meta WHERE key = ?').get(key);
  return row ? parseJson(row.value, fallback) : fallback;
}

/** Write a session_meta value as JSON (null/undefined deletes the key). */
export function writeSessionMeta(db, key, value) {
  if (value === undefined || value === null) {
    db.prepare('DELETE FROM session_meta WHERE key = ?').run(key);
    return;
  }
  db.prepare(
    `INSERT INTO session_meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, JSON.stringify(value));
}

/** Board log ring-buffer cap (keep in sync with BOARD_LOG_MAX in client/server validators). */
export const BOARD_LOG_MAX = 100;

/**
 * Add a column to an existing table if it is missing.
 * Kept separate from user_version so additive product changes never trigger rebuilds.
 *
 * @param {import('better-sqlite3').Database} database
 * @param {string} table
 * @param {string} column
 * @param {string} ddl  Column type + constraints, e.g. "TEXT NOT NULL DEFAULT ''"
 */
export function ensureColumn(database, table, column, ddl) {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all();
  if (columns.some((row) => row.name === column)) {
    return false;
  }
  database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  return true;
}

/** Create the standalone FTS5 mirror (not content=) for message body search. */
function createMessagesFtsTable(database) {
  database.exec(`
    CREATE VIRTUAL TABLE messages_fts USING fts5(
      chat_id UNINDEXED,
      seq UNINDEXED,
      role UNINDEXED,
      body,
      tokenize='porter unicode61'
    );
  `);
}

/**
 * Future additive columns land here — never bump user_version for these.
 * Empty at schema v1; call ensureColumn(...) here for later releases.
 * @param {import('better-sqlite3').Database} database
 */
function migrateAddedColumns(database) {
  void database;
}

/**
 * Initialize tables + indices on a fresh or existing connection.
 * Create FTS5 up front so user_version never moves solely for search.
 * @param {import('better-sqlite3').Database} database
 */
export function initSessionsSchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS session_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT ''
    );

    -- Kept after deletion so a stale viewer cannot recreate or overwrite a chat.
    CREATE TABLE IF NOT EXISTS chat_revisions (
      chat_id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS chats (
      id TEXT PRIMARY KEY,
      sort_index INTEGER NOT NULL DEFAULT 0,
      name TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL DEFAULT '',
      app_scope TEXT NOT NULL DEFAULT '',
      expert_id TEXT NOT NULL DEFAULT '',
      workspace_path TEXT NOT NULL DEFAULT '',
      provider_id TEXT NOT NULL DEFAULT '',
      model_id TEXT NOT NULL DEFAULT '',
      mode_id TEXT NOT NULL DEFAULT '',
      group_id TEXT NOT NULL DEFAULT '',
      board_group_id TEXT NOT NULL DEFAULT '',
      board_task_id TEXT NOT NULL DEFAULT '',
      worktree_root TEXT NOT NULL DEFAULT '',
      git_branch TEXT NOT NULL DEFAULT '',
      updated_at INTEGER NOT NULL DEFAULT 0,
      last_message_at INTEGER NOT NULL DEFAULT 0,
      last_assistant_at INTEGER NOT NULL DEFAULT 0,
      unread INTEGER NOT NULL DEFAULT 0,
      turn_error INTEGER NOT NULL DEFAULT 0,
      message_count INTEGER NOT NULL DEFAULT 0,
      last_message_preview TEXT NOT NULL DEFAULT '',
      history_digest TEXT NOT NULL DEFAULT '',
      meta_json TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS messages (
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT '',
      tool_call_id TEXT NOT NULL DEFAULT '',
      has_tool_calls INTEGER NOT NULL DEFAULT 0,
      has_attachments INTEGER NOT NULL DEFAULT 0,
      hidden INTEGER NOT NULL DEFAULT 0,
      text_len INTEGER NOT NULL DEFAULT 0,
      row_hash TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (chat_id, seq)
    );

    CREATE TABLE IF NOT EXISTS chat_terminal_history (
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      id TEXT NOT NULL DEFAULT '',
      command TEXT NOT NULL DEFAULT '',
      cwd TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'agent',
      tool_call_id TEXT NOT NULL DEFAULT '',
      started_at INTEGER NOT NULL DEFAULT 0,
      finished_at INTEGER NOT NULL DEFAULT 0,
      exit_code INTEGER,
      timed_out INTEGER NOT NULL DEFAULT 0,
      log_path TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (chat_id, seq)
    );

    CREATE TABLE IF NOT EXISTS chat_runs (
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      run_id TEXT NOT NULL,
      branch_id TEXT NOT NULL DEFAULT '',
      fork_history_index INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT '',
      payload_json TEXT NOT NULL DEFAULT '{}',
      PRIMARY KEY (chat_id, run_id)
    );

    CREATE TABLE IF NOT EXISTS chat_sub_agent_runs (
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      run_id TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      PRIMARY KEY (chat_id, run_id)
    );

    CREATE TABLE IF NOT EXISTS chat_loops (
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      loop_id INTEGER NOT NULL,
      due_at INTEGER NOT NULL DEFAULT 0,
      paused INTEGER NOT NULL DEFAULT 0,
      payload_json TEXT NOT NULL DEFAULT '{}',
      PRIMARY KEY (chat_id, loop_id)
    );

    CREATE TABLE IF NOT EXISTS groups (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      workspace_path TEXT NOT NULL DEFAULT '',
      collapsed INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT 0,
      orchestrate_plan_path TEXT NOT NULL DEFAULT '',
      view_mode TEXT NOT NULL DEFAULT '',
      planner_chat_id TEXT NOT NULL DEFAULT '',
      board_state_json TEXT NOT NULL DEFAULT '{}',
      payload_json TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS board_tasks (
      group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      task_id TEXT NOT NULL,
      worktree_path TEXT NOT NULL DEFAULT '',
      dev_port INTEGER NOT NULL DEFAULT 0,
      api_port INTEGER NOT NULL DEFAULT 0,
      chat_id TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT '',
      payload_json TEXT NOT NULL DEFAULT '{}',
      PRIMARY KEY (group_id, task_id)
    );

    CREATE TABLE IF NOT EXISTS board_log (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      event_id TEXT NOT NULL DEFAULT '',
      ts INTEGER NOT NULL DEFAULT 0,
      type TEXT NOT NULL DEFAULT '',
      level TEXT NOT NULL DEFAULT 'info',
      task_id TEXT NOT NULL DEFAULT '',
      message TEXT NOT NULL DEFAULT '',
      detail_json TEXT NOT NULL DEFAULT '{}'
    );

    CREATE INDEX IF NOT EXISTS idx_chats_last_message_at
      ON chats(last_message_at DESC);
    CREATE INDEX IF NOT EXISTS idx_chats_workspace_last_message
      ON chats(workspace_path, last_message_at DESC);
    CREATE INDEX IF NOT EXISTS idx_chats_sort_index
      ON chats(sort_index);
    CREATE INDEX IF NOT EXISTS idx_chats_group_id
      ON chats(group_id) WHERE group_id != '';
    CREATE INDEX IF NOT EXISTS idx_chats_board_task_id
      ON chats(board_task_id) WHERE board_task_id != '';
    CREATE INDEX IF NOT EXISTS idx_messages_chat_seq
      ON messages(chat_id, seq);
    CREATE INDEX IF NOT EXISTS idx_board_tasks_worktree
      ON board_tasks(worktree_path);
    CREATE INDEX IF NOT EXISTS idx_board_tasks_chat_id
      ON board_tasks(chat_id) WHERE chat_id != '';
    CREATE INDEX IF NOT EXISTS idx_board_log_group_seq
      ON board_log(group_id, seq DESC);
    CREATE INDEX IF NOT EXISTS idx_chat_loops_due
      ON chat_loops(due_at) WHERE paused = 0;
  `);

  const ftsExists = database
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='messages_fts'")
    .get();
  if (!ftsExists) {
    createMessagesFtsTable(database);
  }

  migrateAddedColumns(database);

  const version = database.pragma('user_version', { simple: true });
  if (version < SESSIONS_DB_SCHEMA_VERSION) {
    database.pragma(`user_version = ${SESSIONS_DB_SCHEMA_VERSION}`);
  }
}

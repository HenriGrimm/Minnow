/**
 * Phase A.3 perf smoke: narrow worktree lookup stays O(1)-ish vs whole-blob GET.
 * Loose thresholds catch N+1 regressions (e.g. scanning all messages per chat).
 *
 * Seed uses bulk SQL inserts (skips FTS) so 500×200 fixtures stay practical in CI.
 */

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { closeSessionsDb, getSessionsDb, writeSessionMeta } from '../../server/config/sessions-db.js';
import {
  readWholeSessionState,
  resolveChatWorktreeContext,
} from '../../server/config/sessions-repo.js';
import { rmTestHome, setTestHome } from './test-helpers.js';

const CHAT_COUNT = 500;
const MESSAGES_PER_CHAT = 200;
const LOOKUP_SAMPLES = 200;
const P50_LOOKUP_MS = 5;
const WHOLE_BLOB_MS = 500;
const WHOLE_BLOB_SAMPLES = 5;

/** Median of a numeric sample (sorted copy). */
function median(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/**
 * Bulk-seed chats + messages without per-row FTS (reconstruction only needs messages).
 * @param {string} probeChatId
 */
function seedLargeSession(probeChatId) {
  const db = getSessionsDb();
  const insertChat = db.prepare(
    `INSERT INTO chats (
       id, sort_index, name, kind, app_scope, expert_id, workspace_path,
       provider_id, model_id, mode_id, group_id, board_group_id, board_task_id,
       worktree_root, git_branch, updated_at, last_message_at, last_assistant_at,
       unread, turn_error, message_count, last_message_preview, history_digest, meta_json
     ) VALUES (
       @id, @sort_index, @name, '', '', '', '',
       '', '', '', '', '', '',
       @worktree_root, '', @updated_at, 0, 0,
       0, 0, @message_count, '', '', '{}'
     )`,
  );
  const insertMessage = db.prepare(
    `INSERT INTO messages (
       chat_id, seq, payload_json, role, tool_call_id, has_tool_calls,
       has_attachments, hidden, text_len, row_hash
     ) VALUES (?, ?, ?, ?, '', 0, 0, 0, ?, ?)`,
  );

  const tx = db.transaction(() => {
    writeSessionMeta(db, 'schemaVersion', 6);
    writeSessionMeta(db, 'activeId', probeChatId);
    writeSessionMeta(db, 'sidebarCollapsed', false);
    writeSessionMeta(db, 'lastActiveChatIdByWorkspace', {});
    writeSessionMeta(db, 'lastActiveChatIdByApp', {});

    for (let i = 0; i < CHAT_COUNT; i += 1) {
      const id = `chat-${String(i).padStart(4, '0')}`;
      insertChat.run({
        id,
        sort_index: i,
        name: `Chat ${i}`,
        worktree_root: i === 0 ? 'C:/worktrees/perf-probe' : '',
        updated_at: i + 1,
        message_count: MESSAGES_PER_CHAT,
      });
      for (let seq = 0; seq < MESSAGES_PER_CHAT; seq += 1) {
        const role = seq % 2 === 0 ? 'user' : 'assistant';
        const content = `m${seq}`;
        const payload = JSON.stringify({ role, content });
        insertMessage.run(id, seq, payload, role, content.length, `h${i}-${seq}`);
      }
    }
  });
  tx();
}

describe('sessions SQLite narrow-query perf (A.3)', () => {
  let homeDir;
  let savedHome;
  let savedStore;
  const probeChatId = 'chat-0000';

  before(() => {
    savedHome = process.env.MINNOW_HOME;
    savedStore = process.env.MINNOW_SESSIONS_STORE;
    delete process.env.MINNOW_SESSIONS_STORE;
    homeDir = setTestHome(process.env, `minnow-sessions-perf-${Date.now()}`);
    seedLargeSession(probeChatId);
  });

  after(() => {
    closeSessionsDb();
    if (savedHome === undefined) delete process.env.MINNOW_HOME;
    else process.env.MINNOW_HOME = savedHome;
    if (savedStore === undefined) delete process.env.MINNOW_SESSIONS_STORE;
    else process.env.MINNOW_SESSIONS_STORE = savedStore;
    return rmTestHome(homeDir);
  });

  test('resolveChatWorktreeContext p50 stays under 5ms', () => {
    // Warm statement cache / OS page cache so cold-start noise does not dominate.
    for (let i = 0; i < 20; i += 1) {
      resolveChatWorktreeContext(probeChatId);
    }

    /** @type {number[]} */
    const samples = [];
    for (let i = 0; i < LOOKUP_SAMPLES; i += 1) {
      const t0 = performance.now();
      const ctx = resolveChatWorktreeContext(probeChatId);
      samples.push(performance.now() - t0);
      assert.equal(ctx.worktreeRoot, 'C:/worktrees/perf-probe');
    }

    const p50 = median(samples);
    assert.ok(
      p50 < P50_LOOKUP_MS,
      `resolveChatWorktreeContext p50=${p50.toFixed(3)}ms (limit ${P50_LOOKUP_MS}ms)`,
    );
  });

  test('whole-blob GET p50 stays under 500ms', () => {
    // Warm once, then sample full reconstructions so a single scheduling pause does not decide the result.
    readWholeSessionState();
    const samples = [];
    for (let i = 0; i < WHOLE_BLOB_SAMPLES; i += 1) {
      const t0 = performance.now();
      const state = readWholeSessionState();
      samples.push(performance.now() - t0);
      assert.equal(state.chats.length, CHAT_COUNT);
      assert.equal(state.chats[0].history.length, MESSAGES_PER_CHAT);
    }
    const p50 = median(samples);
    assert.ok(
      p50 < WHOLE_BLOB_MS,
      `readWholeSessionState p50=${p50.toFixed(1)}ms (limit ${WHOLE_BLOB_MS}ms, samples: ${samples.map(ms => ms.toFixed(1)).join(', ')})`,
    );
  });
});

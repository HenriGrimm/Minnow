/**
 * Phase A.2 contract: kitchen-sink PUT → GET deep-equal through SQLite whole-blob path.
 * terminalHistory is server-owned on PUT — seeded via appendTerminalRun after write.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

import { closeSessionsDb } from '../../server/config/sessions-db.js';
import {
  appendTerminalRun,
  patchSessionState,
  readSessionSummariesState,
  readWholeSessionState,
  writeWholeSessionState,
} from '../../server/config/sessions-repo.js';
import { validateSessionState } from '../../server/config/validators.js';
import { FIXTURES_DIR, rmTestHome, setTestHome } from './test-helpers.js';

const KITCHEN_SINK = path.join(FIXTURES_DIR, 'kitchen-sink-sessions-state.json');

/** Drop undefined keys so omit-style shapes compare cleanly. */
function canonicalize(value) {
  return JSON.parse(JSON.stringify(value));
}

describe('sessions SQLite whole-blob roundtrip', () => {
  let homeDir;
  let savedHome;
  let savedStore;

  before(() => {
    savedHome = process.env.MINNOW_HOME;
    savedStore = process.env.MINNOW_SESSIONS_STORE;
    delete process.env.MINNOW_SESSIONS_STORE;
    homeDir = setTestHome(process.env, `minnow-sessions-roundtrip-${Date.now()}`);
  });

  after(() => {
    closeSessionsDb();
    if (savedHome === undefined) delete process.env.MINNOW_HOME;
    else process.env.MINNOW_HOME = savedHome;
    if (savedStore === undefined) delete process.env.MINNOW_SESSIONS_STORE;
    else process.env.MINNOW_SESSIONS_STORE = savedStore;
    return rmTestHome(homeDir);
  });

  test('kitchen-sink PUT→GET deep-equal (terminalHistory via appendTerminalRun)', () => {
    const raw = JSON.parse(fs.readFileSync(KITCHEN_SINK, 'utf8'));
    const expected = canonicalize(validateSessionState(structuredClone(raw)));

    // Whole-blob write ignores client terminalHistory (server-owned).
    writeWholeSessionState(expected);

    for (const chat of expected.chats) {
      const history = Array.isArray(chat.terminalHistory) ? chat.terminalHistory : [];
      for (const record of history) {
        appendTerminalRun(chat.id, record);
      }
    }

    // revision / chatRevisions are server-owned concurrency counters.
    const { revision: _revision, chatRevisions: _chatRevisions, ...got } = canonicalize(readWholeSessionState());
    // appendTerminalRun bumps chat.updatedAt (server-owned side effect) — align before compare.
    for (const chat of expected.chats) {
      const actual = got.chats.find((c) => c.id === chat.id);
      if (actual) chat.updatedAt = actual.updatedAt;
    }
    assert.deepEqual(got, expected);
  });

  test('subagent thoughts and full responses survive validation and SQLite close/reopen', () => {
    const raw = JSON.parse(fs.readFileSync(KITCHEN_SINK, 'utf8'));
    const chat = raw.chats[0];
    const thought = 'Start of reasoning. ' + 'Provider reasoning retained. '.repeat(60) + ' End of reasoning.';
    const response = 'Start of response. ' + 'Actual assistant response retained. '.repeat(60) + ' End of response.';
    chat.subAgentRuns = [{
      runId: 'complete-subagent-roundtrip', parentTurnId: 'turn-1', type: 'researcher',
      task: 'Verify source compatibility', status: 'completed', summary: 'Short handoff.',
      error: null, startedAt: '2026-10-15T12:00:00Z', endedAt: '2026-10-15T12:02:00Z', toolTurns: 1,
      messages: [
        { role: 'assistant', content: '', reasoning: thought },
        { role: 'assistant', content: null, tool_calls: [{ id: 'read', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'read', content: 'source' },
        { role: 'assistant', content: response },
      ],
    }];
    const expected = validateSessionState(raw);
    writeWholeSessionState(expected);
    closeSessionsDb();
    const restored = readWholeSessionState().chats.find((entry) => entry.id === chat.id);
    assert.deepEqual(restored.subAgentRuns, expected.chats[0].subAgentRuns);
    assert.equal(restored.subAgentRuns[0].messages[0].reasoning, thought);
    assert.equal(restored.subAgentRuns[0].messages[3].content, response);
  });

  test('archive and restore survive SQLite reopen and lazy summary patches without losing history', () => {
    const raw = JSON.parse(fs.readFileSync(KITCHEN_SINK, 'utf8'));
    const chat = raw.chats[0];
    chat.pinnedAt = 300;
    chat.archivedAt = 500;
    writeWholeSessionState(validateSessionState(raw));
    closeSessionsDb();
    const archived = readWholeSessionState().chats.find(entry => entry.id === chat.id);
    assert.equal(archived.archivedAt, 500);
    assert.equal(archived.pinnedAt, 300);
    const summary = readSessionSummariesState().chats.find(entry => entry.id === chat.id);
    assert.equal(summary.archivedAt, 500);
    assert.equal(summary.history, undefined);
    assert.equal(summary.messageCount, archived.history.length);
    delete summary.archivedAt;
    patchSessionState({ baseVersion: 6, chats: [summary] });
    closeSessionsDb();
    const restored = readWholeSessionState().chats.find(entry => entry.id === chat.id);
    assert.equal(restored.archivedAt, undefined);
    assert.equal(restored.pinnedAt, 300);
    assert.equal(restored.groupId, archived.groupId);
    assert.deepEqual(restored.history, archived.history);
  });

  test('shared session validation drops invalid archive timestamps', () => {
    const raw = JSON.parse(fs.readFileSync(KITCHEN_SINK, 'utf8'));
    for (const invalid of [0, -1, 'yes', NaN, Infinity]) {
      raw.chats[0].archivedAt = invalid;
      assert.equal(validateSessionState(raw).chats[0].archivedAt, undefined);
    }
  });
});

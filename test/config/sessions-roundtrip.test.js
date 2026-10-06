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
});

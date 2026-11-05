/**
 * Generation checkpoints: an in-flight stream survives losing the in-memory state.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { after, afterEach, before, describe, test } from 'node:test';

import { resetMinnowHomeCache } from '../../server/config/home.js';
import {
  INTERRUPTED_BY_RESTART_MESSAGE,
  checkpointAppend,
  checkpointCreated,
  deleteCheckpoint,
  flushAllCheckpoints,
  readCheckpoint,
  resetCheckpointWritersForTests,
  sweepCheckpoints,
} from '../../server/generations/checkpoint.js';
import {
  addSubscriber,
  appendChunk,
  createGenerationState,
  deleteGenerationsForProviderShutdown,
  getGenerationState,
  markComplete,
} from '../../server/generations/store.js';
import { rmTestHome, setTestHome } from '../config/test-helpers.js';

/** Minimal ServerResponse stand-in that records everything written to it. */
function fakeResponse() {
  const chunks = [];
  return {
    writableEnded: false,
    destroyed: false,
    write(buf) {
      chunks.push(Buffer.from(buf));
      return true;
    },
    end() {
      this.writableEnded = true;
    },
    destroy() {
      this.destroyed = true;
    },
    once() {},
    on() {},
    text() {
      return Buffer.concat(chunks).toString('utf8');
    },
  };
}

function sseChunk(text) {
  return Buffer.from(
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`,
    'utf8',
  );
}

/** Forget every in-memory generation without touching disk. */
function dropInMemoryState() {
  deleteGenerationsForProviderShutdown();
  resetCheckpointWritersForTests();
}

describe('generation checkpoints', () => {
  let homeDir;
  let savedHome;

  before(() => {
    savedHome = process.env.MINNOW_HOME;
    homeDir = setTestHome(process.env, `minnow-generation-checkpoint-${Date.now()}`);
    fs.mkdirSync(homeDir, { recursive: true });
  });

  afterEach(() => {
    resetCheckpointWritersForTests();
  });

  after(() => {
    resetMinnowHomeCache();
    if (savedHome === undefined) delete process.env.MINNOW_HOME;
    else process.env.MINNOW_HOME = savedHome;
    return rmTestHome(homeDir);
  });

  test('a completed generation replays from disk after the state is dropped', () => {
    const state = createGenerationState({ providerId: 'p1', body: {}, persist: true });
    const id = state.id;
    appendChunk(state, sseChunk('Hello'));
    appendChunk(state, sseChunk(' world'));
    markComplete(state);

    dropInMemoryState();
    assert.equal(readCheckpoint(id)?.status, 'complete');

    const rehydrated = getGenerationState(id);
    assert.ok(rehydrated, 'checkpoint did not rehydrate');
    assert.equal(rehydrated.status, 'complete');

    const res = fakeResponse();
    addSubscriber(rehydrated, res);
    const replayed = res.text();
    assert.ok(replayed.includes('Hello'));
    assert.ok(replayed.includes(' world'));
    assert.match(replayed, /event: end\ndata: \{"status":"complete"\}/);

    deleteCheckpoint(id);
  });

  test('failed disk flush replays only the confirmed prefix while the live reply completes', (t) => {
    for (const prefix of [Buffer.alloc(0), Buffer.alloc(65536, 'p')]) {
      const state = createGenerationState({ providerId: 'p1', body: {}, persist: true });
      if (prefix.length) appendChunk(state, prefix);
      const append = t.mock.method(fs, 'appendFileSync', () => { throw Object.assign(new Error('full'), { code: 'ENOSPC' }); });
      try {
        appendChunk(state, sseChunk('lost'));
        markComplete(state);
      } finally { append.mock.restore(); }
      assert.equal(state.status, 'complete');
      const checkpoint = readCheckpoint(state.id);
      assert.equal(checkpoint.status, 'error');
      assert.match(checkpoint.meta.errorMessage, /incomplete/);
      assert.deepEqual(checkpoint.sse, prefix);
      deleteCheckpoint(state.id);
    }
    const empty = createGenerationState({ providerId: 'p1', body: {}, persist: true });
    markComplete(empty);
    assert.equal(readCheckpoint(empty.id).status, 'complete');
    deleteCheckpoint(empty.id);
  });

  test('a stream killed mid-flight comes back as an error carrying its bytes', () => {
    // A killed process leaves a sidecar still reading `streaming` next to whatever
    // bytes were already flushed. Build exactly that pair — a graceful shutdown
    // would instead mark the generation cancelled.
    const id = randomUUID();
    const state = {
      id,
      persist: true,
      status: 'streaming',
      providerId: 'p1',
      chatId: 'chat-1',
      chosenProviderId: 'p1',
      chosenModelId: 'm1',
      fallbackUsed: false,
      errorMessage: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
    };
    checkpointCreated(state);
    checkpointAppend(state, sseChunk('Half a rep'));
    flushAllCheckpoints();

    const saved = readCheckpoint(id);
    assert.equal(saved?.status, 'error');
    assert.equal(saved.meta.errorMessage, INTERRUPTED_BY_RESTART_MESSAGE);

    const rehydrated = getGenerationState(id);
    assert.ok(rehydrated, 'interrupted checkpoint did not rehydrate');
    assert.equal(rehydrated.status, 'error');
    assert.equal(rehydrated.errorMessage, INTERRUPTED_BY_RESTART_MESSAGE);
    assert.equal(rehydrated.chatId, 'chat-1');

    const res = fakeResponse();
    addSubscriber(rehydrated, res);
    const replayed = res.text();
    assert.ok(replayed.includes('Half a rep'));
    assert.match(replayed, /event: end\ndata: \{"status":"error"/);
    assert.ok(replayed.includes(INTERRUPTED_BY_RESTART_MESSAGE));

    dropInMemoryState();
    deleteCheckpoint(id);
  });

  test('an ephemeral generation writes nothing to disk', () => {
    const state = createGenerationState({ providerId: 'p1', body: {}, persist: false });
    const id = state.id;
    appendChunk(state, sseChunk('ignored'));
    markComplete(state);
    dropInMemoryState();

    assert.equal(readCheckpoint(id), null);
    assert.equal(getGenerationState(id), undefined);
  });

  test('an unknown id still rehydrates to nothing', () => {
    assert.equal(getGenerationState(randomUUID()), undefined);
  });

  test('the boot sweep drops checkpoints past the retention window', () => {
    const state = createGenerationState({ providerId: 'p1', body: {}, persist: true });
    const id = state.id;
    appendChunk(state, sseChunk('old reply'));
    markComplete(state);
    dropInMemoryState();

    const dir = path.join(homeDir, 'generations');
    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
    for (const name of [`${id}.sse`, `${id}.json`]) {
      fs.utimesSync(path.join(dir, name), twoDaysAgo, twoDaysAgo);
    }

    const swept = sweepCheckpoints();
    assert.ok(swept.removed >= 1, 'sweep removed nothing');
    assert.equal(readCheckpoint(id), null);
  });
});

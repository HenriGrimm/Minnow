import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';

import { resetMinnowHomeCache } from '../../server/config/home.js';
import { createScriptedEffector } from '../../server/orchestrator/effector-scripted.js';
import { disposeEngines, getEngine } from '../../server/orchestrator/engine.js';
import { boardExists, resetJournalCache } from '../../server/orchestrator/journal.js';
import { subscribeErrors } from '../../server/orchestrator/live-events.js';
import {
  createBoardsMiddleware,
  setEffectorFactory,
} from '../../server/orchestrator/middleware.js';
import {
  flushTranscripts,
  readTranscript,
  recordTranscriptEnd,
  recordTranscriptEvent,
  resetTranscripts,
  transcriptPath,
} from '../../server/orchestrator/transcripts.js';

const PLAN = `---
name: demo-board
overview: A demo.
todos:
  - id: W1-A
    content: "Wave 1: A"
    status: pending
isProject: true
---

# Demo

## Wave Breakdown

### Wave 1 — One

#### Task W1-A: Alpha
- **Build:** build alpha
- **Test:** test alpha
- **Accept:** alpha works
- **Touches:** src/alpha/**
`;

/** @type {http.Server} */
let server;
/** @type {string} */
let base;
/** @type {string | undefined} */
let previousHome;
let effectorFactory = () =>
  createScriptedEffector({ script: [{ emit: { outcome: 'pass', delayMs: 60_000 } }] });

before(() => {
  previousHome = process.env.MINNOW_HOME;
});

beforeEach(async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-p9-'));
  process.env.MINNOW_HOME = home;
  resetMinnowHomeCache();
  resetJournalCache();
  resetTranscripts();
  disposeEngines();
  effectorFactory = () =>
    createScriptedEffector({ script: [{ emit: { outcome: 'pass', delayMs: 60_000 } }] });
  setEffectorFactory((boardId) => effectorFactory(boardId));

  const middleware = createBoardsMiddleware();
  server = http.createServer((req, res) => {
    void middleware(req, res, () => {
      res.statusCode = 404;
      res.end('not found');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
  disposeEngines();
  await new Promise((resolve) => server.close(resolve));
});

after(() => {
  if (previousHome === undefined) delete process.env.MINNOW_HOME;
  else process.env.MINNOW_HOME = previousHome;
  resetMinnowHomeCache();
  resetJournalCache();
  resetTranscripts();
  disposeEngines();
});

/**
 * @param {string} method
 * @param {string} pathname
 * @param {unknown} [body]
 */
async function call(method, pathname, body) {
  const response = await fetch(`${base}${pathname}`, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed = null;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  return { status: response.status, body: parsed };
}

async function createBoard() {
  const created = await call('POST', '/api/boards', { planPath: 'demo.md', markdown: PLAN });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body.boardId;
}

function unbindableEffector(message = 'no model bound for this attempt') {
  return {
    inspect: () => [],
    async preflight() {
      throw new Error(message);
    },
    async start() {
      throw new Error(message);
    },
    async stop() {},
    onEnd() {},
  };
}

// ── engine failures reach ────────────────────────────────────────────────────

describe('P9-A — engine failures reach the screen', () => {
  it('refuses Start at the button rather than entering a retry loop', async () => {
    effectorFactory = () => unbindableEffector();
    const boardId = await createBoard();

    const started = await call('POST', `/api/boards/${boardId}/start`, { concurrency: 1 });
    assert.equal(started.status, 400);
    assert.match(started.body.error, /no model bound/);

    const after = await call('GET', `/api/boards/${boardId}`);
    assert.equal(after.body.state.status, 'created');
    const journal = await call('GET', `/api/boards/${boardId}/journal`);
    assert.equal(
      journal.body.events.some((e) => e.type === 'board.started'),
      false,
      'a refused start must not journal board.started',
    );
  });

  it('emits a non-journaled error frame when start fails mid-run', async () => {
    const boardId = await createBoard();
    const okStart = await call('POST', `/api/boards/${boardId}/start`, { concurrency: 1 });
    assert.equal(okStart.status, 200);
    disposeEngines(boardId);

    effectorFactory = () => unbindableEffector('the provider is unreachable');
/** @type {any[]} */
    const seen = [];
    const unsubscribe = subscribeErrors(boardId, (payload) => seen.push(payload));
    const engine = await getEngine(boardId, () => effectorFactory(boardId));
    await engine.tick();
    await engine.tick();
    unsubscribe();

    assert.ok(seen.length >= 2, `expected repeated failures, got ${seen.length}`);
    assert.equal(seen[0].taskId, 'W1-A');
    assert.equal(seen[0].role, 'builder');
    assert.match(seen[0].message, /provider is unreachable/);
    assert.equal(seen[0].consecutive, 1);
    assert.equal(seen[1].consecutive, 2);

    const journal = await call('GET', `/api/boards/${boardId}/journal`);
    for (const event of journal.body.events) {
      assert.doesNotMatch(String(event.type), /error|failed/i, `journaled ${event.type}`);
    }
    assert.equal(
      journal.body.events.filter((e) => e.type === 'task.attempt.started').length,
      1,
    );
  });

  it('tells a newly connected stream what is still failing', async () => {
    const boardId = await createBoard();
    await call('POST', `/api/boards/${boardId}/start`, { concurrency: 1 });
    disposeEngines(boardId);

    effectorFactory = () => unbindableEffector('still broken');
    const engine = await getEngine(boardId, () => effectorFactory(boardId));
    await engine.tick();

    const failures = engine.getStartFailures();
    assert.equal(failures.length, 1);
    assert.equal(failures[0].taskId, 'W1-A');
    assert.match(failures[0].message, /still broken/);
  });

  it('forgets a failure the moment that work starts', async () => {
    const boardId = await createBoard();
    await call('POST', `/api/boards/${boardId}/start`, { concurrency: 1 });
    disposeEngines(boardId);

    let broken = true;
    const scripted = createScriptedEffector({
      script: [{ emit: { outcome: 'pass', delayMs: 60_000 } }],
    });
    effectorFactory = () => ({
      ...scripted,
      inspect: () => scripted.inspect(),
      async start(desired) {
        if (broken) throw new Error('temporarily broken');
        return scripted.start(desired);
      },
      onEnd: (handler) => scripted.onEnd(handler),
    });

    const engine = await getEngine(boardId, () => effectorFactory(boardId));
    await engine.tick();
    assert.equal(engine.getStartFailures().length, 1);

    broken = false;
    await engine.tick();
    assert.equal(engine.getStartFailures().length, 0, 'a successful start clears the failure');
  });
});

// ── per-board model binding ──────────────────────────────────────────────────

describe('P9-C — per-board model binding', () => {
  it('journals the binding and derives it back', async () => {
    const boardId = await createBoard();
    const bound = await call('POST', `/api/boards/${boardId}/model`, {
      providerId: 'anthropic',
      id: 'claude-opus-5',
      reasoning: 'on',
    });
    assert.equal(bound.status, 200);
    assert.deepEqual(bound.body.state.model, {
      providerId: 'anthropic',
      id: 'claude-opus-5',
      reasoning: 'on',
    });

    const journal = await call('GET', `/api/boards/${boardId}/journal`);
    const event = journal.body.events.find((e) => e.type === 'board.model.set');
    assert.ok(event, 'board.model.set is not on the journal');
    assert.equal(event.id, 'claude-opus-5');

    disposeEngines(boardId);
    const reread = await call('GET', `/api/boards/${boardId}`);
    assert.equal(reread.body.state.model.id, 'claude-opus-5');
  });

  it('refuses an incomplete or unusable binding', async () => {
    const boardId = await createBoard();
    assert.equal(
      (await call('POST', `/api/boards/${boardId}/model`, { id: 'x' })).status,
      400,
    );
    assert.equal(
      (
        await call('POST', `/api/boards/${boardId}/model`, {
          providerId: 'p',
          id: 'm',
          reasoning: 'turbo',
        })
      ).status,
      400,
      'reasoning must be a value the header and runTurn can honour',
    );
    const effort = await call('POST', `/api/boards/${boardId}/model`, {
      providerId: 'p',
      id: 'm',
      reasoning: 'medium',
    });
    assert.equal(effort.status, 200);
    assert.equal(effort.body.state.model.reasoning, 'medium');
  });

  it('journals board.model.set when create includes a model pair', async () => {
    const created = await call('POST', '/api/boards', {
      planPath: 'demo.md',
      markdown: PLAN,
      providerId: 'lmstudio',
      id: 'qwen/qwen3-8b',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.deepEqual(created.body.state.model, {
      providerId: 'lmstudio',
      id: 'qwen/qwen3-8b',
      reasoning: null,
    });

    const journal = await call('GET', `/api/boards/${created.body.boardId}/journal`);
    const types = journal.body.events.map((e) => e.type);
    assert.ok(types.includes('board.created'));
    assert.ok(types.includes('board.model.set'));
    const event = journal.body.events.find((e) => e.type === 'board.model.set');
    assert.equal(event.providerId, 'lmstudio');
    assert.equal(event.id, 'qwen/qwen3-8b');
  });

  it('Start without a journaled model still 400 when Autopilot and active chat are empty', async () => {
    const { resolveAttemptModel } = await import('../../server/orchestrator/model-binding.js');
    effectorFactory = () => ({
      inspect: () => [],
      async preflight() {
        await resolveAttemptModel(null);
      },
      async start() {
        throw new Error('should not start');
      },
      async stop() {},
      onEnd() {},
    });
    const boardId = await createBoard();
    const started = await call('POST', `/api/boards/${boardId}/start`, { concurrency: 1 });
    assert.equal(started.status, 400);
    assert.match(started.body.error, /no model bound/);
    assert.equal(started.body.state.status, 'created');
  });
});

// ── board lifecycle ──────────────────────────────────────────────────────────

describe('P9-E — board lifecycle', () => {
  it('renames through the journal, not through a field', async () => {
    const boardId = await createBoard();
    const renamed = await call('PATCH', `/api/boards/${boardId}`, { name: 'Phase 9' });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.state.name, 'Phase 9');

    const journal = await call('GET', `/api/boards/${boardId}/journal`);
    assert.ok(journal.body.events.some((e) => e.type === 'board.renamed' && e.name === 'Phase 9'));

    disposeEngines(boardId);
    const reread = await call('GET', `/api/boards/${boardId}`);
    assert.equal(reread.body.state.name, 'Phase 9', 'the rename must survive a replay');
  });

  it('refuses an empty rename', async () => {
    const boardId = await createBoard();
    assert.equal((await call('PATCH', `/api/boards/${boardId}`, { name: '   ' })).status, 400);
  });

  it('deletes the board and its journal', async () => {
    const boardId = await createBoard();
    await call('POST', `/api/boards/${boardId}/start`, { concurrency: 1 });

    const removed = await call('DELETE', `/api/boards/${boardId}`);
    assert.equal(removed.status, 200);
    assert.equal(await boardExists(boardId), false);
    assert.equal((await call('GET', `/api/boards/${boardId}`)).status, 404);
    assert.equal((await call('DELETE', `/api/boards/${boardId}`)).status, 404);

    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(await boardExists(boardId), false, 'the board came back from the dead');
  });
});

// ── command parity ───────────────────────────────────────────────────────────

describe('P9-H — command parity', () => {
  it('abandons a task by hand as a journaled command', async () => {
    const boardId = await createBoard();
    await call('POST', `/api/boards/${boardId}/start`, { concurrency: 1 });

    const abandoned = await call('POST', `/api/boards/${boardId}/tasks/W1-A/abandon`);
    assert.equal(abandoned.status, 200);

    const journal = await call('GET', `/api/boards/${boardId}/journal`);
    const event = journal.body.events.find((e) => e.type === 'task.abandoned');
    assert.ok(event, 'nothing was journaled');
    assert.equal(event.reason, 'user', 'a hand abandonment is distinguishable from a policy one');

    const state = await call('GET', `/api/boards/${boardId}`);
    const task = state.body.state.tasks.__map.find(([id]) => id === 'W1-A')?.[1];
    assert.ok(task, 'W1-A is missing from the serialised state');
    assert.equal(task.phase, 'abandoned');
  });

  it('answers 409 rather than journaling twice', async () => {
    const boardId = await createBoard();
    await call('POST', `/api/boards/${boardId}/start`, { concurrency: 1 });
    assert.equal((await call('POST', `/api/boards/${boardId}/tasks/W1-A/abandon`)).status, 200);
    assert.equal((await call('POST', `/api/boards/${boardId}/tasks/W1-A/abandon`)).status, 409);

    const journal = await call('GET', `/api/boards/${boardId}/journal`);
    assert.equal(journal.body.events.filter((e) => e.type === 'task.abandoned').length, 1);
  });

  it('404s an abandon for a board that does not exist', async () => {
    assert.equal((await call('POST', '/api/boards/nope/tasks/W1-A/abandon')).status, 404);
  });

  it('resets an abandoned task to idle and deletes its transcript', async () => {
    const boardId = await createBoard();
    await call('POST', `/api/boards/${boardId}/start`, { concurrency: 1 });
    const before = await call('GET', `/api/boards/${boardId}`);
    const row = before.body.state.tasks.__map.find(([id]) => id === 'W1-A')?.[1];
    const attemptId = row?.attempts?.[0]?.attemptId;
    assert.ok(attemptId, 'start should have opened an attempt');
    recordTranscriptEvent({
      boardId,
      attemptId,
      role: 'builder',
      event: { type: 'tool_call', name: 'read_file', arguments: '{"path":"a.ts"}' },
    });
    await flushTranscripts();
    const file = transcriptPath(boardId, attemptId);
    await fs.access(file);

    assert.equal((await call('POST', `/api/boards/${boardId}/tasks/W1-A/abandon`)).status, 200);
    // Stop so Reset leaves the card Planned instead of the running scheduler
    // starting a new attempt on the next tick.
    assert.equal((await call('POST', `/api/boards/${boardId}/stop`)).status, 200);
    const reset = await call('POST', `/api/boards/${boardId}/tasks/W1-A/reset`);
    assert.equal(reset.status, 200, JSON.stringify(reset.body));
    assert.deepEqual(reset.body.taskIds, ['W1-A']);

    const after = await call('GET', `/api/boards/${boardId}`);
    const task = after.body.state.tasks.__map.find(([id]) => id === 'W1-A')?.[1];
    assert.equal(task.phase, 'idle');
    assert.equal(task.attempts.length, 0);

    const journal = await call('GET', `/api/boards/${boardId}/journal`);
    assert.ok(journal.body.events.some((e) => e.type === 'task.reset'));

    await assert.rejects(fs.access(file), { code: 'ENOENT' });
  });

  it('409s Reset on a merged task', async () => {
    const { makeEvent } = await import('../../server/orchestrator/core/events.js');
    const { appendEvent } = await import('../../server/orchestrator/journal.js');
    const boardId = await createBoard();
    await appendEvent(
      boardId,
      makeEvent('merge.succeeded', { taskId: 'W1-A', sha: 'deadbeef', beforeSha: 'abc123' }),
    );
    // Create does not load an engine; dispose anyway so Reset folds from disk.
    disposeEngines();
    const reset = await call('POST', `/api/boards/${boardId}/tasks/W1-A/reset`);
    assert.equal(reset.status, 409);
    assert.match(reset.body.error, /Rewind/);
  });

  it('409s Rewind on a task that is not merged', async () => {
    const boardId = await createBoard();
    const rewind = await call('POST', `/api/boards/${boardId}/tasks/W1-A/rewind`);
    assert.equal(rewind.status, 409);
    assert.match(rewind.body.error, /Reset/);
  });
});

// ── attempt transcripts ──────────────────────────────────────────────────────

describe('P9-D — attempt transcripts', () => {
  it('is readable through the API and is not on the journal', async () => {
    const boardId = await createBoard();
    recordTranscriptEvent({
      boardId,
      attemptId: 'r-1',
      role: 'builder',
      event: { type: 'tool_call', name: 'read_file', arguments: '{"path":"a.ts"}' },
    });
    recordTranscriptEnd({ boardId, attemptId: 'r-1', outcome: 'fail', summary: 'could not build' });
    await flushTranscripts(boardId, 'r-1');

    const read = await call('GET', `/api/boards/${boardId}/attempts/r-1`);
    assert.equal(read.status, 200);
    assert.equal(read.body.events.length, 2);
    assert.equal(read.body.events[0].name, 'read_file');
    assert.equal(read.body.events[1].type, 'attempt_end');
    assert.equal(read.body.events[1].summary, 'could not build');

    const journal = await call('GET', `/api/boards/${boardId}/journal`);
    assert.equal(
      journal.body.events.some((e) => e.type === 'tool_call'),
      false,
      'tool calls must stay off the journal — replay has to stay bounded',
    );
  });

  it('treats a missing transcript as an empty one', async () => {
    const boardId = await createBoard();
    const read = await call('GET', `/api/boards/${boardId}/attempts/r-nothing`);
    assert.equal(read.status, 200);
    assert.deepEqual(read.body.events, []);
  });

  it('persists per-round context measurements for the transcript display', async () => {
    const boardId = await createBoard();
    const event = { type: 'context_usage', used: 2300, limit: 32000, isEstimate: true };
    recordTranscriptEvent({ boardId, attemptId: 'r-context', event });
    const { events } = await readTranscript(boardId, 'r-context');
    assert.deepEqual(events.map(({ ts, ...measurement }) => measurement), [event]);
  });

  it('drops token deltas, which are the bulk and none of the story', async () => {
    const boardId = await createBoard();
    for (let i = 0; i < 50; i += 1) {
      recordTranscriptEvent({ boardId, attemptId: 'r-2', event: { type: 'token', text: 'x' } });
    }
    recordTranscriptEvent({ boardId, attemptId: 'r-2', event: { type: 'tool_call', name: 'bash' } });
    const { events } = await readTranscript(boardId, 'r-2');
    assert.equal(events.length, 1);
    assert.equal(events[0].name, 'bash');
  });

  it('drops P10-B high-frequency types and keeps round_end', async () => {
    const boardId = await createBoard();
    for (const type of ['stream_meta', 'phase', 'round_start', 'reasoning_end', 'delta']) {
      recordTranscriptEvent({ boardId, attemptId: 'r-hf', event: { type, text: 'x' } });
    }
    recordTranscriptEvent({
      boardId,
      attemptId: 'r-hf',
      event: {
        type: 'round_end',
        index: 0,
        text: 'done',
        reasoning: '',
        toolCallCount: 1,
      },
    });
    const { events } = await readTranscript(boardId, 'r-hf');
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'round_end');
    assert.equal(events[0].index, 0);
    assert.equal(events[0].toolCallCount, 1);
  });

  it('refuses an attempt id that is not a filename', async () => {
    const boardId = await createBoard();
    const bad = await call('GET', `/api/boards/${boardId}/attempts/${encodeURIComponent('../x')}`);
    assert.equal(bad.status, 500);
    assert.match(String(bad.body.error), /invalid attempt id/);
  });

  it('folds a growing reasoning block into one line instead of one per snapshot', async () => {
    const boardId = await createBoard();
    const whole = 'Let me start by exploring the working directory to understand the layout.';
    for (let i = 1; i <= whole.length; i += 1) {
      recordTranscriptEvent({
        boardId,
        attemptId: 'r-think',
        event: { type: 'thinking', text: whole.slice(0, i) },
      });
    }
    recordTranscriptEvent({
      boardId,
      attemptId: 'r-think',
      event: { type: 'tool_call', name: 'read_file' },
    });
    await flushTranscripts(boardId, 'r-think');

    const { events } = await readTranscript(boardId, 'r-think');
    assert.equal(events.length, 2, 'one reasoning line, then the tool call');
    assert.equal(events[0].type, 'thinking');
    assert.equal(events[0].text, whole, 'the kept line is the whole block, not a prefix');
    assert.equal(events[1].name, 'read_file');
  });

  it('keeps a long thought whole while still clipping a huge tool result', async () => {
    const boardId = await createBoard();
    // Past the tool-payload cap, which is where a reasoning model at high
    // effort routinely lands. Clipping there cut thoughts off mid-argument.
    const thought = `Weighing the options. ${'x'.repeat(20_000)} Settled on the second.`;
    recordTranscriptEvent({
      boardId,
      attemptId: 'r-prose',
      event: { type: 'thinking', text: thought },
    });
    recordTranscriptEvent({
      boardId,
      attemptId: 'r-prose',
      event: { type: 'round_end', text: thought, index: 0 },
    });
    recordTranscriptEvent({
      boardId,
      attemptId: 'r-prose',
      event: { type: 'tool_result', name: 'bash', content: 'y'.repeat(20_000) },
    });
    await flushTranscripts(boardId, 'r-prose');

    const { events } = await readTranscript(boardId, 'r-prose');
    assert.equal(events[0].text, thought, 'a thought is read, so it is kept whole');
    assert.equal(events[1].text, thought, "a round's prose is read too");
    assert.ok(
      String(events[2].content).endsWith('… [clipped]'),
      'a tool result is kept for its shape, so it still clips',
    );
  });

  it('does not append a line per frame once a thought passes the prose cap', async () => {
    const boardId = await createBoard();
    // The clip marker must not carry how much was dropped: clipped frames are
    // folded by comparing them to each other, and a varying marker would make
    // every frame past the cap its own line.
    const base = 'z'.repeat(64_000);
    for (const suffix of ['a', 'ab', 'abc']) {
      recordTranscriptEvent({
        boardId,
        attemptId: 'r-cap',
        event: { type: 'thinking', text: base + suffix },
      });
    }
    await flushTranscripts(boardId, 'r-cap');

    const { events } = await readTranscript(boardId, 'r-cap');
    assert.equal(events.length, 1, 'one clipped line, not one per frame');
  });

  it('starts a second line when the model begins a genuinely new block', async () => {
    const boardId = await createBoard();
    for (const text of ['First thought', 'First thought about it', 'Second, unrelated thought']) {
      recordTranscriptEvent({ boardId, attemptId: 'r-two', event: { type: 'thinking', text } });
    }
    await flushTranscripts(boardId, 'r-two');
    const { events } = await readTranscript(boardId, 'r-two');
    assert.deepEqual(
      events.map((e) => e.text),
      ['First thought about it', 'Second, unrelated thought'],
    );
  });

  it('shows the block still being written, without stranding a prefix on disk', async () => {
    const boardId = await createBoard();
    recordTranscriptEvent({ boardId, attemptId: 'r-live', event: { type: 'thinking', text: 'Half' } });
    const mid = await readTranscript(boardId, 'r-live');
    assert.equal(mid.events.length, 1, 'a reader sees the block as it stands');
    assert.equal(mid.events[0].text, 'Half');

    recordTranscriptEvent({
      boardId,
      attemptId: 'r-live',
      event: { type: 'thinking', text: 'Half and the rest' },
    });
    recordTranscriptEnd({ boardId, attemptId: 'r-live', outcome: 'pass' });
    await flushTranscripts(boardId, 'r-live');

    const done = await readTranscript(boardId, 'r-live');
    assert.deepEqual(
      done.events.map((e) => e.text ?? e.name),
      ['Half and the rest', 'pass'],
      'reading mid-block must not leave a duplicate prefix behind',
    );
  });

  it('folds transcripts written before the recorder coalesced', async () => {
    const boardId = await createBoard();
    const file = transcriptPath(boardId, 'r-old');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(
      file,
      ['Th', 'Thin', 'Think'].map((text) => JSON.stringify({ ts: 1, type: 'thinking', text })).join('\n') +
        '\n' +
        JSON.stringify({ ts: 2, type: 'attempt_end', name: 'pass' }) +
        '\n',
      'utf8',
    );
    const { events } = await readTranscript(boardId, 'r-old');
    assert.deepEqual(
      events.map((e) => e.text ?? e.name),
      ['Think', 'pass'],
    );
  });

  it('keeps what a tool came back with, not only that it ran', async () => {
    const boardId = await createBoard();
    recordTranscriptEvent({
      boardId,
      attemptId: 'r-out',
      event: { type: 'tool_result', name: 'read_file', content: 'export const A = 1;' },
    });
    await flushTranscripts(boardId, 'r-out');
    const { events } = await readTranscript(boardId, 'r-out');
    assert.equal(events[0].content, 'export const A = 1;');
  });

  it('deleting a board takes its transcripts with it', async () => {
    const boardId = await createBoard();
    recordTranscriptEvent({ boardId, attemptId: 'r-3', event: { type: 'tool_call', name: 'ls' } });
    await flushTranscripts(boardId, 'r-3');
    await call('DELETE', `/api/boards/${boardId}`);
    assert.equal((await call('GET', `/api/boards/${boardId}/attempts/r-3`)).status, 404);
  });
});

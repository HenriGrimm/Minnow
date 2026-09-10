import assert from 'node:assert/strict';
import http from 'node:http';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';

import { resetMinnowHomeCache } from '../../server/config/home.js';
import type { BoardState } from '../../server/orchestrator/core/types';
import { derive } from '../../server/orchestrator/core/derive.js';
import { stateToJSON } from '../../server/orchestrator/core/snapshot.js';
import { createScriptedEffector } from '../../server/orchestrator/effector-scripted.js';
import { disposeEngines } from '../../server/orchestrator/engine.js';
import { emitLive } from '../../server/orchestrator/live-events.js';
import { readEvents, resetJournalCache } from '../../server/orchestrator/journal.js';
import {
  createBoardsMiddleware,
  setEffectorFactory,
} from '../../server/orchestrator/middleware.js';
import {
  createBoardClient,
  createBoardFromPlan,
  createBoardListClient,
  listBoards,
  PlanParseFailure,
  readJournal,
  type EventStream,
} from '../../src/orchestrator/client.ts';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const PLAN = `---
name: view-board
overview: A board to look at.
todos:
  - id: W1-A
    content: "Wave 1: A"
    status: pending
  - id: W1-B
    content: "Wave 1: B"
    status: pending
isProject: true
---

# View Board

## Wave Breakdown

### Wave 1 — One

#### Task W1-A: Alpha
- **Build:** build alpha
- **Test:** test alpha
- **Accept:** alpha works
- **Touches:** src/alpha/**

#### Task W1-B: Beta
- **Build:** build beta
- **Test:** test beta
- **Accept:** beta works
- **Touches:** src/beta/**
`;

/** @type {http.Server} */
let server: http.Server;
let base = '';
let previousHome: string | undefined;
let realFetch: typeof globalThis.fetch;

before(() => {
  previousHome = process.env.MINNOW_HOME;
  realFetch = globalThis.fetch;
});

beforeEach(async () => {
  process.env.MINNOW_HOME = await fsp.mkdtemp(path.join(os.tmpdir(), 'minnow-client-'));
  resetMinnowHomeCache();
  resetJournalCache();
  disposeEngines();
  setEffectorFactory(() =>
    createScriptedEffector({ script: [{ emit: { outcome: 'pass', delayMs: 60_000 } }] }),
  );

  const middleware = createBoardsMiddleware();
  server = http.createServer((req, res) => {
    void middleware(req, res, () => {
      res.statusCode = 404;
      res.end('not found');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  globalThis.fetch = ((input: any, init?: any) =>
    realFetch(
      typeof input === 'string' && input.startsWith('/') ? `${base}${input}` : input,
      init,
    )) as typeof globalThis.fetch;
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  disposeEngines();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

after(() => {
  globalThis.fetch = realFetch;
  if (previousHome === undefined) delete process.env.MINNOW_HOME;
  else process.env.MINNOW_HOME = previousHome;
  resetMinnowHomeCache();
  resetJournalCache();
  disposeEngines();
});

function openTestStream(url: string, resumeFrom: string | null = null): EventStream & { reopenedWith?: string } {
  const listeners = new Map<string, Array<(event: { data: string }) => void>>();
  let lastEventId: string | null = resumeFrom;
  let request: http.ClientRequest | null = null;
  let closed = false;

  const fire = (type: string, data: string) => {
    for (const listener of listeners.get(type) ?? []) listener({ data });
  };

  const stream: any = {
    addEventListener(type: string, listener: (event: { data: string }) => void) {
      const existing = listeners.get(type) ?? [];
      existing.push(listener);
      listeners.set(type, existing);
    },
    close() {
      closed = true;
      request?.destroy();
    },
    drop() {
      request?.destroy();
      request = null;
    },
    reconnect() {
      request?.destroy();
      open();
    },
    counts: { snapshot: 0, event: 0 } as Record<string, number>,
    get lastEventId() {
      return lastEventId;
    },
  };

  function open() {
    if (closed) return;
    const headers: Record<string, string> = { Accept: 'text/event-stream' };
    if (lastEventId !== null) headers['Last-Event-ID'] = lastEventId;
    stream.reopenedWith = lastEventId ?? undefined;

    request = http.get(`${base}${url}`, { headers }, (response) => {
      fire('open', '');
      let buffer = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        buffer += chunk;
        let split: number;
        while ((split = buffer.indexOf('\n\n')) !== -1) {
          const raw = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          if (raw.startsWith(':')) continue;
          let type = 'message';
          let data = '';
          for (const line of raw.split('\n')) {
            if (line.startsWith('id: ')) lastEventId = line.slice(4);
            else if (line.startsWith('event: ')) type = line.slice(7);
            else if (line.startsWith('data: ')) data = line.slice(6);
          }
          stream.counts[type] = (stream.counts[type] ?? 0) + 1;
          fire(type, data);
        }
      });
    });
    request.on('error', () => {
      if (!closed) fire('error', '');
    });
  }

  open();
  return stream;
}

function openTestStreamFrom(url: string, from: number) {
  return openTestStream(url, String(from));
}

async function until(predicate: () => boolean, what: string, ms = 5000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${what}`);
}

async function makeBoard() {
  const { boardId } = await createBoardFromPlan('view.md', { markdown: PLAN });
  return boardId;
}

// ── Reading ──────────────────────────────────────────────────────────────────

describe('board client — reading', () => {
  it('lists boards', async () => {
    assert.deepEqual(await listBoards(), []);
    await makeBoard();
    const boards = await listBoards();
    assert.equal(boards.length, 1);
    assert.equal(boards[0].boardId, 'view-board');
    assert.equal(boards[0].taskCount, 2);
  });

  it('surfaces a plan that does not parse with its line numbers', async () => {
    await assert.rejects(
      () => createBoardFromPlan('bad.md', { markdown: PLAN.replace('- **Touches:** src/beta/**\n', '') }),
      (err: unknown) => {
        assert.ok(err instanceof PlanParseFailure);
        assert.ok(err.errors.length > 0);
        assert.equal(typeof err.errors[0].line, 'number');
        assert.ok(err.errors[0].hint.length > 0);
        return true;
      },
    );
  });

  it('does not replay an old integration failure over a newer passing HTTP baseline', async () => {
    const events = [
      { v: 1, seq: 1, type: 'board.created', boardId: 'rechecked', planPath: 'plan.md', tasks: [], waves: [] },
      { v: 1, seq: 2, type: 'final.test.ended', outcome: 'fail' },
      { v: 1, seq: 3, type: 'board.reopened', taskIds: [], reason: 'user' },
      { v: 1, seq: 4, type: 'final.test.ended', outcome: 'pass' },
      { v: 1, seq: 5, type: 'run.finished', summary: 'final test pass' },
      { v: 1, seq: 6, type: 'board.stopped', reason: 'complete' },
    ];
    const listeners = new Map<string, (event: { data: string }) => void>();
    let resolveBaseline!: (response: Response) => void;
    globalThis.fetch = (() => new Promise<Response>((resolve) => { resolveBaseline = resolve; })) as typeof fetch;
    const client = createBoardClient('rechecked', {
      openStream: () => ({ addEventListener(type, listener) { listeners.set(type, listener); }, close() {} }),
    });
    try {
      client.connect();
      listeners.get('event')!({ data: JSON.stringify(events[1]) });
      resolveBaseline(new Response(JSON.stringify({ state: stateToJSON(derive(events)), seq: 6 })));
      await until(() => client.getState() !== null, 'the passing baseline');
      assert.equal(client.getState()!.finalTest?.outcome, 'pass');
      assert.equal(client.getState()!.stopReason, 'complete');
      assert.equal(client.getSeq(), 6);
      listeners.get('event')!({ data: JSON.stringify(events[1]) });
      assert.equal(client.getState()!.finalTest?.outcome, 'pass');
    } finally {
      client.close();
    }
  });

  it('derives the board from the snapshot frame', async () => {
    const boardId = await makeBoard();
    const client = createBoardClient(boardId, { openStream: openTestStream });
    try {
      client.connect();
      await until(() => client.getState() !== null, 'the snapshot frame');

      const state = client.getState()!;
      assert.deepEqual([...state.tasks.keys()], ['W1-A', 'W1-B']);
      assert.equal(state.status, 'created');
      assert.deepEqual(state.tasks.get('W1-A')!.touches, ['src/alpha/**']);
    } finally {
      client.close();
    }
  });

  it('folds each streamed event, matching the server exactly', async () => {
    const boardId = await makeBoard();
    const client = createBoardClient(boardId, { openStream: openTestStream });
    try {
      client.connect();
      await until(() => client.getState() !== null, 'the snapshot frame');

      await client.start(2);
      await until(
        () => client.getState()?.tasks.get('W1-A')?.phase === 'building',
        'the first attempt to start',
      );

      const fromJournal = derive(await readEvents(boardId));
      assert.deepEqual(client.getState(), fromJournal);
    } finally {
      client.close();
    }
  });

  it('surfaces live tool calls without folding them into the journal', async () => {
    const boardId = await makeBoard();
    const client = createBoardClient(boardId, { openStream: openTestStream });
    try {
      client.connect();
      await until(() => client.getState() !== null, 'the snapshot frame');

      emitLive({
        boardId,
        attemptId: 'r-live-test',
        taskId: 'W1-A',
        role: 'builder',
        event: { type: 'tool_call', name: 'save_file' },
      });
      await until(
        () => client.getLiveActivity().get('W1-A')?.text === 'save_file',
        'the live tool activity',
      );
      assert.equal(client.getLiveActivity().get('W1-A')?.role, 'builder');
      assert.equal(client.getLiveActivity().get('W1-A')?.kind, 'tool');

      // Thinking is activity too — the card says what the agent is doing, not
      // only which tool it last reached for.
      emitLive({
        boardId,
        attemptId: 'r-live-test',
        taskId: 'W1-A',
        role: 'builder',
        event: { type: 'thinking', text: 'Checking the existing scaffold first.' },
      });
      await until(
        () => client.getLiveActivity().get('W1-A')?.kind === 'thinking',
        'the live thought',
      );
      assert.match(
        client.getLiveActivity().get('W1-A')!.text,
        /existing scaffold/,
      );

      const events = await readEvents(boardId);
      assert.equal(
        events.some((event) => event.type === 'live' || event.type === 'delta'),
        false,
        'live frames must never become journal lines',
      );
    } finally {
      client.close();
    }
  });

  it('marks the window where a tool is named but its arguments are still streaming', async () => {
    const boardId = await makeBoard();
    const client = createBoardClient(boardId, { openStream: openTestStream });
    try {
      client.connect();
      await until(() => client.getState() !== null, 'the snapshot frame');

      const send = (event: Record<string, unknown>) =>
        emitLive({
          boardId,
          attemptId: 'r-live-stream',
          taskId: 'W1-A',
          role: 'builder',
          event: event as never,
        });

      send({ type: 'thinking', text: 'I should rewrite the config.' });
      await until(
        () => client.getLiveActivity().get('W1-A')?.kind === 'thinking',
        'the live thought',
      );

      // Writing a big argument can take minutes. Without this frame the card
      // sat on the last thought and read as hung.
      send({ type: 'tool_streaming', name: 'save_file' });
      await until(
        () => client.getLiveActivity().get('W1-A')?.preparing === true,
        'the streaming-arguments frame',
      );
      assert.equal(client.getLiveActivity().get('W1-A')?.kind, 'tool');
      assert.equal(client.getLiveActivity().get('W1-A')?.text, 'save_file');

      send({ type: 'tool_call', name: 'save_file' });
      await until(
        () => client.getLiveActivity().get('W1-A')?.preparing !== true,
        'the settled call',
      );
      assert.equal(client.getLiveActivity().get('W1-A')?.settled, false);
    } finally {
      client.close();
    }
  });

  it('moves off a finished tool when the model goes back to writing', async () => {
    const boardId = await makeBoard();
    const client = createBoardClient(boardId, { openStream: openTestStream });
    try {
      client.connect();
      await until(() => client.getState() !== null, 'the snapshot frame');

      const send = (event: Record<string, unknown>) =>
        emitLive({
          boardId,
          attemptId: 'r-live-phase',
          taskId: 'W1-A',
          role: 'builder',
          event: event as never,
        });

      send({ type: 'tool_result', name: 'read_file' });
      await until(
        () => client.getLiveActivity().get('W1-A')?.settled === true,
        'the settled tool',
      );

      send({ type: 'phase', phase: 'generating' });
      await until(
        () => client.getLiveActivity().get('W1-A')?.kind === 'writing',
        'the generating phase',
      );

      // A phase frame is the coarse signal and always precedes the frame that
      // names the work, so it must never overwrite a name already on screen.
      send({ type: 'thinking', text: 'Now the tests.' });
      await until(
        () => client.getLiveActivity().get('W1-A')?.kind === 'thinking',
        'the thought',
      );
      send({ type: 'phase', phase: 'thinking' });
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(client.getLiveActivity().get('W1-A')?.text, 'Now the tests.');
    } finally {
      client.close();
    }
  });

  it('notifies subscribeLive, not subscribe, on thinking and tool frames', async () => {
    const boardId = await makeBoard();
    const client = createBoardClient(boardId, { openStream: openTestStream });
    try {
      client.connect();
      await until(() => client.getState() !== null, 'the snapshot frame');

      let stateCalls = 0;
      let liveCalls = 0;
      client.subscribe(() => {
        stateCalls += 1;
      });
      client.subscribeLive(() => {
        liveCalls += 1;
      });

      emitLive({
        boardId,
        attemptId: 'r-live-bus',
        taskId: 'W1-A',
        role: 'builder',
        event: { type: 'thinking', text: 'Checking the scaffold.' },
      });
      await until(() => liveCalls === 1, 'the live thinking subscriber');
      assert.equal(stateCalls, 0, 'thinking must not trigger a board state paint');

      emitLive({
        boardId,
        attemptId: 'r-live-bus',
        taskId: 'W1-A',
        role: 'builder',
        event: { type: 'tool_call', name: 'read_file' },
      });
      await until(() => liveCalls === 2, 'the live tool subscriber');
      assert.equal(stateCalls, 0, 'tool frames must not trigger a board state paint');
      assert.equal(client.getLiveActivity().get('W1-A')?.kind, 'tool');
    } finally {
      client.close();
    }
  });

  it('reads the raw journal', async () => {
    const boardId = await makeBoard();
    const { events, truncated } = await readJournal(boardId);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'board.created');
    assert.equal(truncated, false);
  });

  it('reads a window of the journal rather than all of it', async () => {
    const boardId = await makeBoard();
    const client = createBoardClient(boardId, { openStream: openTestStream });
    try {
      client.connect();
      await until(() => client.getState() !== null, 'the snapshot frame');
      await client.start(1);
      await until(() => client.getState()?.status === 'running', 'board.started');
      await client.setConcurrency(2);
      await until(() => client.getState()?.concurrency === 2, 'the concurrency change');
    } finally {
      client.close();
    }

    const all = await readJournal(boardId);
    assert.ok(all.events.length >= 3, `only ${all.events.length} events`);

    const since = await readJournal(boardId, { since: 1 });
    assert.deepEqual(since.events, all.events.slice(1));

    const tail = await readJournal(boardId, { limit: 2 });
    assert.deepEqual(tail.events, all.events.slice(-2));
    assert.equal(tail.truncated, true);

    const nothing = await readJournal(boardId, { since: 10_000 });
    assert.deepEqual(nothing.events, []);
  });
});

// ── Board list ───────────────────────────────────────────────────────────────

describe('board list — kept fresh', () => {
  it('polls, and notifies only when the list actually changes', async () => {
    const seen: number[] = [];
    const list = createBoardListClient({ intervalMs: 20 });
    const unsubscribe = list.subscribe((boards) => seen.push(boards.length));
    try {
      list.start();
      await until(() => seen.length === 0 || list.getBoards().length === 0, 'the first poll');
      await new Promise((resolve) => setTimeout(resolve, 80));
      const quiet = seen.length;

      await makeBoard();
      await until(() => list.getBoards().length === 1, 'the new board to appear');
      assert.equal(seen.at(-1), 1);

      await new Promise((resolve) => setTimeout(resolve, 80));
      assert.equal(seen.length, quiet + 1, `notified ${seen.length - quiet} times for one change`);
    } finally {
      unsubscribe();
      list.stop();
    }
  });

  it('refreshes on demand, for the window that issued the command', async () => {
    const list = createBoardListClient({ intervalMs: 60_000 });
    try {
      await list.refresh();
      assert.deepEqual(list.getBoards(), []);
      await makeBoard();
      await list.refresh();
      assert.equal(list.getBoards().length, 1);
    } finally {
      list.stop();
    }
  });

  it('keeps the last good list when a poll fails', async () => {
    let calls = 0;
    const list = createBoardListClient({
      intervalMs: 60_000,
      fetchBoards: async () => {
        calls += 1;
        if (calls === 1) return [{ boardId: 'a' } as any];
        throw new Error('offline');
      },
    });
    try {
      await list.refresh();
      assert.equal(list.getBoards().length, 1);
      await list.refresh();
      assert.equal(list.getBoards().length, 1, 'a failed poll emptied the list');
      assert.match(String(list.getError()?.message), /offline/);
    } finally {
      list.stop();
    }
  });
});

// ── Reconnect ────────────────────────────────────────────────────────────────

describe('board client — reconnect', () => {
  it('catches up through Last-Event-ID rather than re-folding from zero', async () => {
    const boardId = await makeBoard();
    const stream = openTestStream(`/api/boards/${boardId}/events`) as any;
    const client = createBoardClient(boardId, { openStream: () => stream });

    try {
      client.connect();
      await until(() => client.getState() !== null, 'the snapshot frame');
      await client.start(2);
      await until(() => client.getState()?.status === 'running', 'the board to start');

      const seqBefore = client.getSeq();
      assert.ok(seqBefore > 0, 'no baseline seq');
      assert.equal(stream.counts.snapshot, 1);

      stream.drop();
      await client.setConcurrency(1);
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(client.getState()!.concurrency, 2, 'the view saw an event it could not have');

      stream.reconnect();
      await until(() => client.getState()?.concurrency === 1, 'the missed concurrency change');

      assert.equal(stream.reopenedWith, String(seqBefore));
      assert.equal(stream.counts.snapshot, 1, 'the server re-sent a snapshot on resume');
      assert.deepEqual(client.getState(), derive(await readEvents(boardId)));
    } finally {
      client.close();
    }
  });

  it('keeps a resumed tail that arrives before any baseline exists', async () => {
    const boardId = await makeBoard();

    const primer = createBoardClient(boardId, { openStream: openTestStream });
    primer.connect();
    await until(() => primer.getState() !== null, 'the primer snapshot');
    await primer.start(2);
    await until(() => primer.getState()?.status === 'running', 'board.started');
    const resumeFrom = primer.getSeq() - 1;
    primer.close();

    const resumed = openTestStreamFrom(`/api/boards/${boardId}/events`, resumeFrom) as any;
    const client = createBoardClient(boardId, { openStream: () => resumed });
    try {
      client.connect();
      await until(() => client.getState() !== null, 'a baseline from somewhere');
      await until(() => client.getState()?.status === 'running', 'the resumed tail');
      assert.equal(resumed.counts.snapshot ?? 0, 0, 'the server sent a snapshot after all');
      assert.deepEqual(client.getState(), derive(await readEvents(boardId)));
    } finally {
      client.close();
    }
  });

  it('reports the connection state so a view can show it', async () => {
    const boardId = await makeBoard();
    const client = createBoardClient(boardId, { openStream: openTestStream });
    const connections: boolean[] = [];
    client.subscribe(() => connections.push(client.isConnected()));
    try {
      client.connect();
      await until(() => client.isConnected(), 'the stream to open');
      client.close();
      assert.equal(client.isConnected(), false);
      assert.equal(connections.at(-1), false, 'close() never notified anyone');
    } finally {
      client.close();
    }
  });
});

// ── State view ───────────────────────────────────────────────────────────────

describe('board client — the state handed out is a view', () => {
  it('gives a new object identity whenever anything changes', async () => {
    const boardId = await makeBoard();
    const client = createBoardClient(boardId, { openStream: openTestStream });
    const seen: Array<{ state: BoardState; statusThen: string }> = [];
    client.subscribe((state) => {
      if (state) seen.push({ state, statusThen: state.status });
    });
    try {
      client.connect();
      await until(() => client.getState() !== null, 'the snapshot frame');
      const first = client.getState()!;

      await client.start(2);
      await until(() => client.getState()?.status === 'running', 'board.started');
      const second = client.getState()!;

      assert.notEqual(first, second, 'the same object came back after a change');
      assert.equal(first.status, 'created', 'the earlier state was mutated underneath its holder');
      assert.equal(second.status, 'running');
      assert.equal(client.getState(), second);
      for (const { state, statusThen } of seen) {
        assert.equal(state.status, statusThen, 'a delivered state was mutated later');
      }
      assert.ok(
        seen.some((entry) => entry.statusThen === 'created') &&
          seen.some((entry) => entry.statusThen === 'running'),
        'the run never actually changed status',
      );
    } finally {
      client.close();
    }
  });

  it('refuses to be written to', async () => {
    const boardId = await makeBoard();
    const client = createBoardClient(boardId, { openStream: openTestStream });
    try {
      client.connect();
      await until(() => client.getState() !== null, 'the snapshot frame');
      const state = client.getState()!;

      assert.throws(() => {
        (state as any).status = 'running';
      });
      assert.throws(() => state.tasks.set('X', {} as any));
      assert.throws(() => state.tasks.delete('W1-A'));
      assert.throws(() => {
        (state.tasks.get('W1-A') as any).phase = 'merged';
      });
      assert.throws(() => (state.taskOrder as string[]).push('X'));
      assert.equal(state.status, 'created');
    } finally {
      client.close();
    }
  });
});

// ── Commands ─────────────────────────────────────────────────────────────────

describe('board client — commands', () => {
  it('sends every mutation as a POST and waits for the event to come back', async () => {
    const boardId = await makeBoard();
    const client = createBoardClient(boardId, { openStream: openTestStream });
    try {
      client.connect();
      await until(() => client.getState() !== null, 'the snapshot frame');

      const before = client.getState()!;
      assert.equal(before.status, 'created');

      await client.start(2);
      await until(() => client.getState()?.status === 'running', 'board.started');
      assert.equal(client.getState()!.concurrency, 2);

      await client.setConcurrency(3);
      await until(() => client.getState()?.concurrency === 3, 'the concurrency change');

      await client.stop();
      await until(() => client.getState()?.status === 'stopped', 'board.stopped');
      assert.equal(client.getState()!.stopReason, 'user');
    } finally {
      client.close();
    }
  });

  it('reports whether a manual task start was accepted', async () => {
    const boardId = await makeBoard();
    const client = createBoardClient(boardId, { openStream: openTestStream });
    try {
      client.connect();
      await until(() => client.getState() !== null, 'the snapshot frame');
      await client.start(1);
      await until(() => client.getState()?.status === 'running', 'board.started');

      assert.equal(await client.startTask('W1-B'), true);
      await until(
        () => client.getState()?.tasks.get('W1-B')?.phase === 'building',
        'the manual start',
      );
      assert.equal(await client.startTask('W1-B'), false);
    } finally {
      client.close();
    }
  });

  it('notifies subscribers on every change', async () => {
    const boardId = await makeBoard();
    const client = createBoardClient(boardId, { openStream: openTestStream });
    const seen: string[] = [];
    const unsubscribe = client.subscribe((state) => {
      if (state) seen.push(state.status);
    });
    try {
      client.connect();
      await until(() => seen.length > 0, 'the first notification');
      await client.start(1);
      await until(() => seen.includes('running'), 'a running notification');
      unsubscribe();
      const count = seen.length;
      await client.stop();
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(seen.length, count, 'unsubscribe did not take effect');
    } finally {
      client.close();
    }
  });
});

// ── Renderer writes ──────────────────────────────────────────────────────────

describe('the renderer writes nothing', () => {
  it('exposes no way to set board state', () => {
    const client = createBoardClient('x', { openStream: openTestStream });
    client.close();
    const commands = new Set(['setConcurrency', 'setModel']);
    for (const name of Object.keys(client)) {
      if (commands.has(name)) continue;
      assert.doesNotMatch(
        name,
        /^(set|update|patch|write|mutate|apply)/,
        `the client exposes ${name}`,
      );
    }
  });

  it('leaves the local state untouched when a command is issued', async () => {
    const boardId = await makeBoard();
    const client = createBoardClient(boardId, { openStream: openTestStream });
    try {
      client.connect();
      await until(() => client.getState() !== null, 'the snapshot frame');
      const before = client.getState()!;
      const wasConcurrency = before.concurrency;
      assert.equal(before.model, null);

      await client.setConcurrency(wasConcurrency + 2);
      assert.equal(before.concurrency, wasConcurrency);
      await until(
        () => client.getState()!.concurrency === wasConcurrency + 2,
        'the engine to report the new concurrency',
      );
      assert.equal(before.concurrency, wasConcurrency, 'the old copy was mutated');
      assert.notEqual(client.getState(), before, 'a change must produce a new identity');

      assert.throws(
        () => {
          (before.tasks as Map<string, unknown>).set('W9-Z', {});
        },
        /cannot be written to/,
      );
    } finally {
      client.close();
    }
  });

  it('imports the fold from the shared core rather than reimplementing it', async () => {
    const source = await fsp.readFile(
      path.join(PROJECT_ROOT, 'src/orchestrator/client.ts'),
      'utf8',
    );
    assert.match(source, /from '\.\.\/\.\.\/server\/orchestrator\/core\/derive\.js'/);
    assert.match(source, /from '\.\.\/\.\.\/server\/orchestrator\/core\/snapshot\.js'/);
  });

  it('reaches no V1 board module', async () => {
    const source = await fsp.readFile(
      path.join(PROJECT_ROOT, 'src/orchestrator/client.ts'),
      'utf8',
    );
    for (const banned of [
      'orchestrate-board-store',
      'orchestrate-board-actions',
      'orchestrate-self-heal',
      'board-tools',
    ]) {
      assert.equal(source.includes(banned), false, `client.ts reaches ${banned}`);
    }
  });

  it('has no V1 board import anywhere under src/orchestrator', () => {
    const banned = [
      'orchestrate-board-store',
      'orchestrate-board-actions',
      'orchestrate-board-chat',
      'orchestrate-board-kickoff',
      'orchestrate-self-heal',
      'ui/orchestrate-hub',
      'board-display-wake',
      'board-boot-resume',
      'oom-recovery',
      'board-tools',
    ];
    for (const file of sourcesUnder(path.join(PROJECT_ROOT, 'src/orchestrator'))) {
      const source = withoutComments(fs.readFileSync(file.path, 'utf8'));
      for (const name of banned) {
        assert.equal(source.includes(name), false, `${file.name} reaches ${name}`);
      }
      assert.doesNotMatch(
        source,
        /BoardTask/,
        `${file.name} names V1's BoardTask — V2's TaskState is a different shape`,
      );
    }
  });

  it('has no renderer module that writes board state', () => {
    const forbidden: Array<[RegExp, string]> = [
      [/(?<!\.dataset)\.phase\s*=[^=]/, 'assigns to a task phase'],
      [/\.status\s*=\s*['"`](running|stopped|created)/, 'assigns a board status'],
      [/\.mergeQueue\s*[.=]\s*(push|splice|=)/, 'writes the merge queue'],
      [/\.attempts\.(push|splice|pop|shift)/, 'writes an attempt list'],
      [/tasks\.set\(/, 'writes the task map'],
      [/foldInto\(/, 'folds events outside the client'],
    ];
    for (const file of sourcesUnder(path.join(PROJECT_ROOT, 'src/orchestrator'))) {
      if (file.name === 'client.ts') continue;
      const source = withoutComments(fs.readFileSync(file.path, 'utf8'));
      for (const [pattern, what] of forbidden) {
        assert.doesNotMatch(source, pattern, `${file.name} ${what}`);
      }
    }
  });
});

/** Strip block comments and whole-line `//` comments. Good enough for a guard. */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
}

/** Every `.ts` under a directory, recursively. */
function sourcesUnder(dir: string): Array<{ name: string; path: string }> {
  const out: Array<{ name: string; path: string }> = [];
  for (const entry of fs.readdirSync(dir, { recursive: true }) as string[]) {
    const name = String(entry);
    const full = path.join(dir, name);
    if (!fs.statSync(full).isFile()) continue;
    if (!name.endsWith('.ts')) continue;
    out.push({ name, path: full });
  }
  assert.ok(out.length > 0, `no sources found under ${dir}`);
  return out;
}

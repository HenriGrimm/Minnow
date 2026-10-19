/**
 * Phase C.2: ensureChatHistoryLoaded idempotency/dedupe + DEV history trap (flag default ON).
 */

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

import { setStorageModeForTests } from '../../src/config/storage-mode.ts';
import { defaultSessionState } from '../../src/config/defaults.ts';
import {
  attachUnloadedHistoryTrapForTests,
  buildSessionsPatchDelta,
  captureDirtyTrackingShadowForTests,
  chatForSessionsWire,
  ensureChatHistoryLoaded,
  isSessionsLazyHistoryEnabled,
  requireHistory,
  resetSessionPersistenceForTests,
  setDirtyTrackingVerifierForcedForTests,
  setHistoryTrapForcedForTests,
  setSessionStateForTests,
  setSessionsLazyHistoryEnabledForTests,
  sessionState,
  touchChat,
} from '../../src/state/sessions.ts';
import type { Chat, Message, SessionState } from '../../src/types.ts';
import { getPerFileChangeSummary } from '../../src/usage/code-change-ledger.ts';

const CHAT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const CHAT_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

function makeChat(id: string, extra: Partial<Chat> = {}): Chat {
  return {
    id,
    name: id.slice(0, 4),
    workspacePath: '',
    modelId: '',
    modeId: 'build',
    history: [],
    historyLoaded: true,
    lastStats: null,
    modelInfo: {},
    updatedAt: 1_700_000_000_000,
    lastMessageAt: 1_700_000_000_000,
    ...extra,
  };
}

function makeState(chats: Chat[]): SessionState {
  const base = defaultSessionState();
  return {
    ...base,
    version: 6,
    activeId: chats[0]?.id ?? null,
    chats,
  };
}

describe('lazy history (C.2)', () => {
  afterEach(() => {
    // @ts-expect-error test cleanup
    delete globalThis.fetch;
    setStorageModeForTests('localStorage');
    resetSessionPersistenceForTests();
    setSessionStateForTests(null);
  });

  test('lazy-history flag defaults ON', () => {
    assert.equal(isSessionsLazyHistoryEnabled(), true);
  });

  test('ensureChatHistoryLoaded is a no-op when flag is off', async () => {
    setStorageModeForTests('server');
    setSessionsLazyHistoryEnabledForTests(false);
    const chat = makeChat(CHAT_A, { historyLoaded: false });
    setSessionStateForTests(makeState([chat]));

    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      return new Response(JSON.stringify({ chatId: CHAT_A, history: [] }), { status: 200 });
    };

    await ensureChatHistoryLoaded(CHAT_A);
    assert.equal(fetchCalls, 0);
    assert.equal(chat.historyLoaded, false);
  });

  test('ensureChatHistoryLoaded is idempotent and dedupes concurrent callers', async () => {
    setStorageModeForTests('server');
    // Default is ON; keep explicit for clarity.
    setSessionsLazyHistoryEnabledForTests(true);

    const chat = makeChat(CHAT_A, { historyLoaded: false, history: [] });
    setSessionStateForTests(makeState([chat]));

    let fetchCalls = 0;
    let resolveFetch!: (value: Response) => void;
    const fetchGate = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });

    globalThis.fetch = async (input) => {
      const url = String(input);
      assert.ok(url.includes(`/api/config/sessions/history/${CHAT_A}`));
      fetchCalls += 1;
      return fetchGate;
    };

    const messages: Message[] = [
      { role: 'user', content: 'one' },
      { role: 'assistant', content: 'two' },
    ];

    const p1 = ensureChatHistoryLoaded(CHAT_A);
    const p2 = ensureChatHistoryLoaded(CHAT_A);
    assert.equal(fetchCalls, 1, 'concurrent callers share one in-flight fetch');

    resolveFetch(
      new Response(JSON.stringify({ chatId: CHAT_A, history: messages }), { status: 200 }),
    );
    await Promise.all([p1, p2]);

    assert.equal(fetchCalls, 1);
    assert.equal(chat.historyLoaded, true);
    assert.equal(chat.history.length, 2);
    assert.equal(chat.history[0]?.content, 'one');

    // Second wave after load completes — still no extra fetch.
    await ensureChatHistoryLoaded(CHAT_A);
    assert.equal(fetchCalls, 1);
  });

  test('opening a chat fills in the detail its summary left out, keeping what this window recorded', async () => {
    setStorageModeForTests('server');
    setSessionsLazyHistoryEnabledForTests(true);
    const stub = { runId: 'run-1', branchId: 'b1', forkHistoryIndex: 0, status: 'running', createdAt: 1 };
    const localRun = {
      runId: 'run-2', branchId: 'b2', forkHistoryIndex: 2, status: 'running', createdAt: 2,
      snapshot: { note: 'recorded here' },
    };
    const chat = makeChat(CHAT_A, {
      historyLoaded: false,
      runs: [stub, localRun] as unknown as Chat['runs'],
      terminalHistory: [{ id: 't2', command: 'ls', startedAt: 20 }] as unknown as Chat['terminalHistory'],
    });
    setSessionStateForTests(makeState([chat]));

    let requested = '';
    globalThis.fetch = async (input) => {
      requested = String(input);
      return new Response(JSON.stringify({
        chatId: CHAT_A,
        history: [{ role: 'user', content: 'one' }],
        detail: {
          runs: [{ ...stub, status: 'completed', snapshot: { note: 'stored' }, outputMessages: [] }],
          subAgentRuns: [{ runId: 'sub-1' }],
          terminalHistory: [{ id: 't1', command: 'pwd', startedAt: 10 }],
          injectedContext: { 'code-map': 'map' },
        },
      }), { status: 200 });
    };

    await ensureChatHistoryLoaded(CHAT_A);
    assert.match(requested, /\?detail=1$/);
    assert.equal(chat.historyLoaded, true);
    const runs = chat.runs as unknown as Array<{ runId: string; status: string; snapshot?: { note: string } }>;
    assert.deepEqual(runs.map((run) => [run.runId, run.status, run.snapshot?.note]),
      [['run-1', 'completed', 'stored'], ['run-2', 'running', 'recorded here']]);
    assert.deepEqual(chat.subAgentRuns?.map((run) => run.runId), ['sub-1']);
    assert.deepEqual(chat.terminalHistory?.map((row) => row.id), ['t1', 't2']);
    assert.deepEqual(chat.injectedContext, { 'code-map': 'map' });
  });

  test('requireHistory throws while unloaded', () => {
    const chat = makeChat(CHAT_B, { historyLoaded: false });
    assert.throws(() => requireHistory(chat), /history not loaded/);
    chat.historyLoaded = true;
    assert.equal(requireHistory(chat), chat.history);
  });

  test('dev trap fires once on first history read when flag on', () => {
    setSessionsLazyHistoryEnabledForTests(true);
    setHistoryTrapForcedForTests(true);

    const chat = makeChat(CHAT_A, { history: [], historyLoaded: false });
    setSessionStateForTests(makeState([chat]));
    attachUnloadedHistoryTrapForTests(chat);

    const errors: unknown[][] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };
    try {
      const first = chat.history;
      assert.deepEqual(first, []);
      assert.equal(errors.length, 1);
      assert.match(String(errors[0]?.[0]), /ensureChatHistoryLoaded/);

      // Second read while still unloaded must not re-warn.
      void chat.history;
      assert.equal(errors.length, 1);
    } finally {
      console.error = originalError;
    }
  });

  test('code-change listing helpers do not trip the history trap', () => {
    setSessionsLazyHistoryEnabledForTests(true);
    setHistoryTrapForcedForTests(true);

    const chat = makeChat(CHAT_A, {
      history: [],
      historyLoaded: false,
      codeChangeTotals: { additions: 12, deletions: 3 },
    });
    setSessionStateForTests(makeState([chat]));
    attachUnloadedHistoryTrapForTests(chat);

    const errors: unknown[][] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };
    try {
      const summaries = getPerFileChangeSummary(chat);
      assert.deepEqual(summaries, []);
      assert.equal(errors.length, 0);
    } finally {
      console.error = originalError;
      setHistoryTrapForcedForTests(false);
    }
  });

  test('chatForSessionsWire omits history when lazy-unloaded', () => {
    const chat = makeChat(CHAT_A, {
      history: [],
      historyLoaded: false,
      name: 'Unloaded',
    });
    const wire = chatForSessionsWire(chat) as Chat & { history?: Message[] };
    assert.equal('history' in wire, false);
    assert.equal('historyLoaded' in wire, false);
    assert.equal(wire.name, 'Unloaded');

    const loaded = makeChat(CHAT_B, {
      history: [{ role: 'user', content: 'hi' }],
      historyLoaded: true,
    });
    const wireLoaded = chatForSessionsWire(loaded);
    assert.equal(wireLoaded.history.length, 1);
  });

  test('captureDirtyTrackingShadow skips lazy-unloaded history bodies', () => {
    const errors: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
      origError.apply(console, args as Parameters<typeof console.error>);
    };
    try {
      setSessionsLazyHistoryEnabledForTests(true);
      setHistoryTrapForcedForTests(true);
      setDirtyTrackingVerifierForcedForTests(true);
      const chat = makeChat(CHAT_A, { historyLoaded: false, history: [] });
      attachUnloadedHistoryTrapForTests(chat);
      setSessionStateForTests(makeState([chat]));
      captureDirtyTrackingShadowForTests();
      assert.equal(errors.length, 0);
    } finally {
      console.error = origError;
    }
  });

  test('buildSessionsPatchDelta omits history for unloaded dirty chats', () => {
    const unloaded = makeChat(CHAT_A, { historyLoaded: false, name: 'A' });
    const loaded = makeChat(CHAT_B, {
      history: [{ role: 'user', content: 'b' }],
      historyLoaded: true,
    });
    setSessionStateForTests(makeState([unloaded, loaded]));
    touchChat(unloaded);
    touchChat(loaded);

    const delta = buildSessionsPatchDelta(makeState([unloaded, loaded]));
    assert.equal(delta.chats?.length, 2);
    const wireA = delta.chats?.find((c) => c.id === CHAT_A) as Chat & { history?: Message[] };
    const wireB = delta.chats?.find((c) => c.id === CHAT_B);
    assert.equal('history' in (wireA ?? {}), false);
    assert.equal(wireB?.history.length, 1);
  });

  test('materializeChatHistory keeps local tail when a send lands during hydrate', async () => {
    setStorageModeForTests('server');
    setSessionsLazyHistoryEnabledForTests(true);

    const chat = makeChat(CHAT_A, { historyLoaded: false, history: [] });
    setSessionStateForTests(makeState([chat]));

    let resolveFetch!: (value: Response) => void;
    const fetchGate = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });

    globalThis.fetch = async () => fetchGate;

    const hydrate = ensureChatHistoryLoaded(CHAT_A);
    chat.history.push({ role: 'user', content: 'sent while loading' });

    resolveFetch(
      new Response(JSON.stringify({ chatId: CHAT_A, history: [] }), { status: 200 }),
    );
    await hydrate;

    assert.equal(chat.historyLoaded, true);
    assert.equal(chat.history.length, 1);
    assert.equal(chat.history[0]?.content, 'sent while loading');
  });

  test('materializeChatHistory splices a mid-hydrate send onto the stored transcript', async () => {
    // The Continue-after-restart case: the turn appends to the placeholder while the
    // history GET is still in flight. Overwriting the array left the bubble on screen
    // and the row out of the transcript the model replays.
    setStorageModeForTests('server');
    setSessionsLazyHistoryEnabledForTests(true);

    const chat = makeChat(CHAT_A, { historyLoaded: false, history: [] });
    setSessionStateForTests(makeState([chat]));

    let resolveFetch!: (value: Response) => void;
    globalThis.fetch = async () =>
      new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      });

    const hydrate = ensureChatHistoryLoaded(CHAT_A);
    await Promise.resolve();
    chat.history.push({ role: 'user', content: 'continue' });

    const stored: Message[] = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply' },
    ];
    resolveFetch(
      new Response(JSON.stringify({ chatId: CHAT_A, history: stored }), { status: 200 }),
    );
    await hydrate;

    assert.equal(chat.historyLoaded, true);
    assert.deepEqual(
      chat.history.map((m) => m.content),
      ['first', 'reply', 'continue'],
    );
    assert.equal(chat.messageCount, 3);
  });

  test('resetSessionPersistenceForTests restores flag default ON', () => {
    setSessionsLazyHistoryEnabledForTests(false);
    assert.equal(isSessionsLazyHistoryEnabled(), false);
    resetSessionPersistenceForTests();
    assert.equal(isSessionsLazyHistoryEnabled(), true);
    void sessionState;
  });
});

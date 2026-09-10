/**
 * W4-B — renderer claim loop (client).
 *
 * The loop queries the engine for an open delegated lease, claims it with a
 * compare-and-set, runs `runChatTurn` (injected here), and POSTs the outcome.
 * These cases pin the two required behaviours:
 *  - it POSTs the outcome once and never claims again after a terminal state;
 *  - a busy chat (409) does not reset the stage — the claim is retried on the
 *    next stream-end, with the *same* attempt id.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import type { Chat } from '../../src/types.ts';
import {
  claimSuperPlanForChat,
  resetSuperPlanClaimLoopForTests,
  startSuperPlanClaimLoop,
  startSuperPlanEngineRun,
  superPlanStageForRole,
  type DelegatedTurnInput,
  type DelegatedTurnOutcome,
  type SuperPlanClaimResult,
  type SuperPlanClaimTransport,
  type SuperPlanEngineState,
  type SuperPlanFinishResult,
} from '../../src/chat/super-plan/claim-loop.ts';
import { notifyChatStreamEnded } from '../../src/chat/streaming-state.ts';
import { defaultSessionState } from '../../src/config/defaults.ts';
import { setSessionStateForTests } from '../../src/state/sessions.ts';

// ── fixtures ─────────────────────────────────────────────────────────────────

function makeChat(overrides: Partial<Chat> = {}): Chat {
  return {
    id: 'chat-1',
    name: 'Super Plan',
    workspacePath: '/tmp/ws',
    modelId: 'model-1',
    history: [],
    lastStats: null,
    modelInfo: {},
    updatedAt: 0,
    superPlanRunId: 'run-1',
    ...overrides,
  } as Chat;
}

function makeState(overrides: Partial<SuperPlanEngineState> = {}): SuperPlanEngineState {
  return {
    runId: 'run-1',
    prompt: 'Build a Kanban UI',
    status: 'running',
    finished: false,
    stopReason: null,
    stage: 'interview',
    specPath: null,
    researchPath: null,
    planPath: null,
    reviewCount: 0,
    attempts: [{ attemptId: 'att-1', stage: 'interview', ended: false }],
    ...overrides,
  };
}

interface FakeTransport extends SuperPlanClaimTransport {
  calls: {
    fetchState: string[];
    claim: Array<{ runId: string; attemptId: string; clientId: string }>;
    finish: Array<{ runId: string; attemptId: string; outcome: string }>;
    pause: string[];
    createRun: string[];
    startRun: string[];
  };
}

function fakeTransport(options: {
  state?: SuperPlanEngineState;
  claim?: SuperPlanClaimResult;
  finish?: SuperPlanFinishResult;
}): FakeTransport {
  const calls: FakeTransport['calls'] = {
    fetchState: [],
    claim: [],
    finish: [],
    pause: [],
    createRun: [],
    startRun: [],
  };
  return {
    calls,
    async fetchState(runId) {
      calls.fetchState.push(runId);
      return options.state ?? makeState();
    },
    async claim(runId, attemptId, clientId) {
      calls.claim.push({ runId, attemptId, clientId });
      return options.claim ?? { ok: true, status: 200 };
    },
    async heartbeat() {
      return { ok: true, status: 200 };
    },
    async finish(runId, attemptId, end) {
      calls.finish.push({ runId, attemptId, outcome: end.outcome });
      return options.finish ?? { ok: true, status: 200, duplicate: false };
    },
    async pause(runId) {
      calls.pause.push(runId);
      return { ok: true, status: 200 };
    },
    async createRun(input) {
      calls.createRun.push(input.runId);
      return { ok: true, status: 201 };
    },
    async startRun(runId) {
      calls.startRun.push(runId);
      return { ok: true, status: 200 };
    },
  };
}

function registerChat(chat: Chat): void {
  const state = defaultSessionState();
  state.chats = [chat as unknown as (typeof state.chats)[number]];
  state.activeId = chat.id;
  setSessionStateForTests(state);
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setImmediate(resolve));
}

afterEach(() => {
  resetSuperPlanClaimLoopForTests();
  setSessionStateForTests(null);
});

// ── role mapping ─────────────────────────────────────────────────────────────

describe('superPlanStageForRole', () => {
  it('maps interview to grill and draft to the right pass', () => {
    assert.equal(superPlanStageForRole('interview', { reviewCount: 0 }), 'grill');
    assert.equal(superPlanStageForRole('draft', { reviewCount: 0 }), 'draft1');
    assert.equal(superPlanStageForRole('draft', { reviewCount: 1 }), 'draft2');
  });
});

// ── claim → run → finish ─────────────────────────────────────────────────────

describe('claimSuperPlanForChat', () => {
  it('claims the open lease, runs the stage, and POSTs the outcome', async () => {
    const transport = fakeTransport({});
    const turns: DelegatedTurnInput[] = [];
    const chat = makeChat();

    const outcome = await claimSuperPlanForChat(chat, {
      transport,
      heartbeat: false,
      runTurn: async (_chat, input) => {
        turns.push(input);
        return 'pass';
      },
    });

    assert.equal(outcome.kind, 'finished', JSON.stringify(outcome));
    assert.deepEqual(transport.calls.fetchState, ['run-1']);
    assert.equal(transport.calls.claim.length, 1);
    assert.equal(transport.calls.claim[0]!.attemptId, 'att-1');
    assert.equal(transport.calls.claim[0]!.runId, 'run-1');
    assert.ok(transport.calls.claim[0]!.clientId.length > 0);
    assert.equal(turns.length, 1);
    assert.equal(turns[0]!.role, 'interview');
    assert.deepEqual(transport.calls.finish, [
      { runId: 'run-1', attemptId: 'att-1', outcome: 'pass' },
    ]);
    assert.deepEqual(transport.calls.pause, []);
  });

  it('does nothing for a legacy chat without superPlanRunId', async () => {
    const transport = fakeTransport({});
    const outcome = await claimSuperPlanForChat(makeChat({ superPlanRunId: undefined }), {
      transport,
      heartbeat: false,
    });
    assert.equal(outcome.kind, 'legacy');
    assert.deepEqual(transport.calls.fetchState, []);
  });

  it('stops claiming once the run is terminal', async () => {
    const transport = fakeTransport({
      state: makeState({ finished: true, status: 'stopped', stopReason: 'complete' }),
    });
    let ran = 0;
    const outcome = await claimSuperPlanForChat(makeChat(), {
      transport,
      heartbeat: false,
      runTurn: async () => {
        ran += 1;
        return 'pass';
      },
    });
    assert.equal(outcome.kind, 'terminal');
    assert.deepEqual(transport.calls.claim, []);
    assert.deepEqual(transport.calls.finish, []);
    assert.equal(ran, 0);
  });

  it('does not claim a paused run', async () => {
    const transport = fakeTransport({
      state: makeState({ status: 'stopped', stopReason: 'paused' }),
    });
    const outcome = await claimSuperPlanForChat(makeChat(), { transport, heartbeat: false });
    assert.equal(outcome.kind, 'paused');
    assert.deepEqual(transport.calls.claim, []);
  });

  it('posts a pause (not a finish) when the user stops the turn', async () => {
    const transport = fakeTransport({});
    const outcome = await claimSuperPlanForChat(makeChat(), {
      transport,
      heartbeat: false,
      runTurn: async (): Promise<DelegatedTurnOutcome> => 'stopped',
    });
    assert.equal(outcome.kind, 'paused');
    assert.deepEqual(transport.calls.pause, ['run-1']);
    assert.deepEqual(transport.calls.finish, []);
  });

  it('a lost claim (409) does not reset the stage and does not run the turn', async () => {
    const transport = fakeTransport({
      claim: { ok: false, status: 409, error: 'the lease is already claimed' },
    });
    let ran = 0;
    const outcome = await claimSuperPlanForChat(makeChat(), {
      transport,
      heartbeat: false,
      runTurn: async () => {
        ran += 1;
        return 'pass';
      },
    });
    assert.equal(outcome.kind, 'lost');
    assert.equal(outcome.status, 409);
    assert.equal(ran, 0);
    assert.deepEqual(transport.calls.finish, []);
    assert.equal(transport.calls.claim.length, 1);
    assert.equal(transport.calls.claim[0]!.attemptId, 'att-1');
  });

  it('a busy chat (streaming) is skipped without a claim', async () => {
    const transport = fakeTransport({});
    const chat = makeChat();
    const { streamingChatIds } = await import('../../src/app-state.ts');
    streamingChatIds.add(chat.id);
    try {
      const outcome = await claimSuperPlanForChat(chat, { transport, heartbeat: false });
      assert.equal(outcome.kind, 'busy');
      assert.deepEqual(transport.calls.fetchState, ['run-1']);
    } finally {
      streamingChatIds.delete(chat.id);
    }
  });
});

// ── retry on stream-end ──────────────────────────────────────────────────────

describe('claim loop retries on stream-end', () => {
  it('a 409 is retried on the next stream-end with the same attempt id', async () => {
    const transport = fakeTransport({
      claim: { ok: false, status: 409, error: 'already claimed' },
    });
    const chat = makeChat();
    registerChat(chat);
    let ran = 0;
    const runTurn = async (): Promise<DelegatedTurnOutcome> => {
      ran += 1;
      return 'pass';
    };

    // First attempt loses the race (another window claimed it).
    const first = await claimSuperPlanForChat(chat, { transport, heartbeat: false, runTurn });
    assert.equal(first.kind, 'lost');
    assert.equal(ran, 0);

    // The window that won is now gone; the next stream-end retries and wins.
    transport.calls.claim.length = 0;
    (transport as { claim: SuperPlanClaimTransport['claim'] }).claim = async (
      runId,
      attemptId,
      clientId,
    ) => {
      transport.calls.claim.push({ runId, attemptId, clientId });
      return { ok: true, status: 200 };
    };

    const stop = startSuperPlanClaimLoop({ transport, heartbeat: false, runTurn, scanOnStart: false });
    try {
      notifyChatStreamEnded(chat.id);
      await settle();
    } finally {
      stop();
    }

    assert.equal(ran, 1, 'the retry must run the stage exactly once');
    assert.equal(transport.calls.claim.length, 1, 'the retry must re-claim');
    assert.equal(
      transport.calls.claim[0]!.attemptId,
      'att-1',
      'the retry must claim the same attempt — the stage is not reset',
    );
    assert.deepEqual(transport.calls.finish, [
      { runId: 'run-1', attemptId: 'att-1', outcome: 'pass' },
    ]);
  });
});

// ── boot scan ────────────────────────────────────────────────────────────────

describe('claim loop boot scan', () => {
  it('claims an open lease for an engine run on boot', async () => {
    const transport = fakeTransport({});
    const chat = makeChat();
    registerChat(chat);
    let ran = 0;
    const stop = startSuperPlanClaimLoop({
      transport,
      heartbeat: false,
      runTurn: async () => {
        ran += 1;
        return 'pass';
      },
    });
    try {
      await settle();
    } finally {
      stop();
    }
    assert.equal(ran, 1, 'boot must run the open delegated stage');
    assert.equal(transport.calls.claim.length, 1);
    assert.equal(transport.calls.claim[0]!.attemptId, 'att-1');
  });
});

// ── new runs ─────────────────────────────────────────────────────────────────

describe('startSuperPlanEngineRun', () => {
  it('creates the engine run, sets chat.superPlanRunId, and starts it', async () => {
    const transport = fakeTransport({
      state: makeState({ finished: true, status: 'stopped', stopReason: 'complete' }),
    });
    const chat = makeChat({ superPlanRunId: undefined });
    const result = await startSuperPlanEngineRun(
      { chat, prompt: 'Add OAuth login' },
      { transport, heartbeat: false },
    );
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.ok(result.runId && result.runId.startsWith('add-oauth-login-'), String(result.runId));
    assert.equal(chat.superPlanRunId, result.runId);
    assert.deepEqual(transport.calls.createRun, [result.runId]);
    assert.deepEqual(transport.calls.startRun, [result.runId]);
  });
});

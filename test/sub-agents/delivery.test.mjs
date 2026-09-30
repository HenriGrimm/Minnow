/**
 * P8-E — parent delivery is a fold over the journal (MIN-758).
 *
 * The queue is `pendingDeliveries(derive(events))`, not a process-lifetime
 * Set. Completing while the parent streams, a renderer reload, and a server
 * kill mid-delivery all re-offer from the same journal. Duplicate delivery
 * is the failure to design against: inject once per `(runId, parentChatId)`
 * per fold state; a crash after inject before append is the one allowed extra.
 *
 * No live LLM. Deterministic seam + journal only.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { setTestHome, rmTestHome } from '../config/test-helpers.js';
import { ensureMinnowLayout, resetMinnowHomeCache } from '../../server/config/home.js';
import { deleteGenerationsForProviderShutdown } from '../../server/generations/store.js';
import { derive, pendingDeliveries } from '../../server/sub-agents/derive.js';
import { makeEvent } from '../../server/sub-agents/events.js';
    import {
      buildProductionParentMessage,
      createDelivery,
      createMemoryJournal,
      NO_DELIVERY_LISTENER,
    } from '../../server/sub-agents/delivery.js';
import * as agentsJournal from '../../server/sub-agents/journal.js';

const PARENT = 'chat-p8e-parent';
const RUN = 'run-p8e-1';
const RUN_B = 'run-p8e-2';

function requested(runId = RUN, extra = {}) {
  return makeEvent('run.requested', {
    runId,
    agentType: extra.agentType ?? 'explore',
    task: extra.task ?? 'scan',
    parentChatId: extra.parentChatId ?? PARENT,
    cwd: extra.cwd ?? '/tmp/ws',
    requestedAt: extra.requestedAt ?? 1_700_000_000_000,
  });
}

function started(runId = RUN, attemptId = 'a1') {
  return makeEvent('attempt.started', {
    runId,
    attemptId,
    seed: { kind: 'initial' },
  });
}

function ended(runId = RUN, attemptId = 'a1', outcome = 'pass') {
  return makeEvent('attempt.ended', {
    runId,
    attemptId,
    outcome,
    summary: 'FIXED_SUMMARY',
  });
}

/**
 * @param {import('../../server/sub-agents/delivery.js').DeliveryJournal} journal
 * @param {string} [runId]
 * @param {string} [parentChatId]
 */
async function seedPassed(journal, runId = RUN, parentChatId = PARENT) {
  await journal.appendEvent(parentChatId, requested(runId, { parentChatId }));
  await journal.appendEvent(parentChatId, started(runId));
  await journal.appendEvent(parentChatId, ended(runId));
}

/**
 * @param {import('../../server/sub-agents/delivery.js').DeliveryJournal} journal
 */
async function seedRunning(journal, runId = RUN, parentChatId = PARENT) {
  await journal.appendEvent(parentChatId, requested(runId, { parentChatId }));
  await journal.appendEvent(parentChatId, started(runId));
}

// ── fold queue ───────────────────────────────────────────────────────────────

describe('delivery — fold queue (memory journal)', () => {
  test('MIN-639: a failed inject leaves the run pending in the journal, not a Set', async () => {
    const journal = createMemoryJournal();
    await seedPassed(journal);
    /** @type {number} */
    let calls = 0;
    const delivery = createDelivery({
      journal,
      retryDelayMs: 0,
      sleep: async () => {},
      deliverToParent: async () => {
        calls += 1;
        if (calls === 1) throw new Error('resume blew up');
      },
    });

    await delivery.tick(PARENT);
    const pending = pendingDeliveries(await journal.loadState(PARENT));
    assert.deepEqual(
      pending.map((r) => r.runId),
      [RUN],
      'failed inject must not append result.delivered',
    );
    const events = await journal.readEvents(PARENT);
    assert.equal(
      events.some((e) => e.type === 'result.delivered'),
      false,
    );

    await delivery.tick(PARENT);
    assert.equal(calls, 2);
    const delivered = await journal.loadState(PARENT);
    assert.equal(delivered.runs.get(RUN).delivered, true);
    assert.deepEqual(pendingDeliveries(delivered), []);
  });

  test('completing while parent streams, then a reload before stream ends, still delivers', async () => {
    const journal = createMemoryJournal();
    await seedPassed(journal);
    /** @type {string[]} */
    const deliveredIds = [];
    let streaming = true;

    const make = () =>
      createDelivery({
        journal,
        retryDelayMs: 0,
        sleep: async () => {},
        parentStatus: () => ({ streaming, skip: null }),
        deliverToParent: async (_chatId, _message, meta) => {
          deliveredIds.push(...meta.runIds);
        },
      });

    const first = make();
    await first.tick(PARENT);
    assert.deepEqual(deliveredIds, []);
    assert.equal((await journal.loadState(PARENT)).runs.get(RUN).delivered, false);

    // Simulated renderer reload: new handle, same journal, parent still streaming.
    const reloaded = make();
    await reloaded.tick(PARENT);
    assert.deepEqual(deliveredIds, []);

    streaming = false;
    await reloaded.tick(PARENT);
    assert.deepEqual(deliveredIds, [RUN]);
    assert.equal((await journal.loadState(PARENT)).runs.get(RUN).delivered, true);

    await reloaded.tick(PARENT);
    assert.deepEqual(deliveredIds, [RUN], 'fold already delivered — no extra inject');
  });

  test('deliverToParent is called once per (runId, parentChatId) per fold state', async () => {
    const journal = createMemoryJournal();
    await seedPassed(journal);
    /** @type {number} */
    let calls = 0;
    const delivery = createDelivery({
      journal,
      retryDelayMs: 0,
      sleep: async () => {},
      deliverToParent: async () => {
        calls += 1;
      },
    });
    await delivery.tick(PARENT);
    await delivery.tick(PARENT);
    await delivery.tickAll();
    assert.equal(calls, 1);
  });

  test('coalesces two pending runs into one inject, then journals both delivered', async () => {
    const journal = createMemoryJournal();
    await seedPassed(journal, RUN);
    await seedPassed(journal, RUN_B);
    /** @type {string[][]} */
    const batches = [];
    const delivery = createDelivery({
      journal,
      retryDelayMs: 0,
      sleep: async () => {},
      deliverToParent: async (_chatId, _message, meta) => {
        batches.push([...meta.runIds]);
      },
    });
    await delivery.tick(PARENT);
    assert.deepEqual(batches, [[RUN, RUN_B]]);
    const state = await journal.loadState(PARENT);
    assert.equal(state.runs.get(RUN).delivered, true);
    assert.equal(state.runs.get(RUN_B).delivered, true);
    assert.deepEqual(pendingDeliveries(state), []);
  });

  test('production delivery waits for an idempotent acceptance acknowledgement', async () => {
    const journal = createMemoryJournal();
    await seedPassed(journal);
    let frames = 0;
    const delivery = createDelivery({
      journal,
      retryDelayMs: 0,
      requiresAcceptanceAck: true,
      deliverToParent: async () => { frames += 1; },
    });
    await delivery.tick(PARENT);
    assert.equal(frames, 1);
    assert.deepEqual(pendingDeliveries(await journal.loadState(PARENT)).map((run) => run.runId), [RUN]);
    assert.deepEqual(await delivery.acknowledge(PARENT, [RUN, 'unknown']), [RUN]);
    assert.deepEqual(await delivery.acknowledge(PARENT, [RUN]), []);
    assert.deepEqual(pendingDeliveries(await journal.loadState(PARENT)), []);
    await delivery.tick(PARENT);
    assert.equal(frames, 1);
  });

  test('missing_chat skip notifies and journals result.delivered with skipReason', async () => {
    const journal = createMemoryJournal();
    await seedPassed(journal);
    /** @type {string[]} */
    const notified = [];
    /** @type {number} */
    let injects = 0;
    const delivery = createDelivery({
      journal,
      retryDelayMs: 0,
      sleep: async () => {},
      parentStatus: () => ({ streaming: false, skip: 'missing_chat' }),
      deliverToParent: async () => {
        injects += 1;
      },
      notifyUndeliverable: (_chatId, run) => {
        notified.push(run.runId);
      },
    });
    await delivery.tick(PARENT);
    assert.equal(injects, 0);
    assert.deepEqual(notified, [RUN]);
    const state = await journal.loadState(PARENT);
    assert.equal(state.runs.get(RUN).delivered, true);
    assert.equal(state.runs.get(RUN).deliveredSkipReason, 'missing_chat');
    assert.deepEqual(pendingDeliveries(state), []);
  });

  test('orchestrate skip journals a terminal delivery without injecting or notifying', async () => {
    const journal = createMemoryJournal();
    await seedPassed(journal);
    /** @type {number} */
    let injects = 0;
    /** @type {number} */
    let notifies = 0;
    const delivery = createDelivery({
      journal,
      retryDelayMs: 0,
      sleep: async () => {},
      parentStatus: () => ({ streaming: false, skip: 'orchestrate' }),
      deliverToParent: async () => {
        injects += 1;
      },
      notifyUndeliverable: () => {
        notifies += 1;
      },
    });
    await delivery.tick(PARENT);
    assert.equal(injects, 0);
    assert.equal(notifies, 0);
    const state = await journal.loadState(PARENT);
    assert.equal(state.runs.get(RUN).delivered, true);
    assert.equal(state.runs.get(RUN).deliveredSkipReason, 'orchestrate');
    assert.deepEqual(pendingDeliveries(state), []);
  });

  test('check-in nudge fires at most once per run across reloads', async () => {
    const journal = createMemoryJournal();
    await seedRunning(journal);
    /** @type {number} */
    let nudges = 0;

    const make = () =>
      createDelivery({
        journal,
        retryDelayMs: 0,
        sleep: async () => {},
        deliverToParent: async (_chatId, _message, meta) => {
          if (meta.kind === 'check_in_nudge') nudges += 1;
        },
      });

    const first = make();
    assert.equal(await first.offerNudge({ parentChatId: PARENT, runId: RUN, elapsedSec: 12 }), true);
    assert.equal(nudges, 1);
    assert.equal((await journal.loadState(PARENT)).runs.get(RUN).nudged, true);

    for (let i = 0; i < 5; i += 1) {
      const reloaded = make();
      assert.equal(
        await reloaded.offerNudge({ parentChatId: PARENT, runId: RUN, elapsedSec: 12 }),
        false,
      );
    }
    assert.equal(nudges, 1);
  });

  test('nudge crash after inject before append re-fires once, then never again', async () => {
    const journal = createMemoryJournal();
    await seedRunning(journal);
    /** @type {number} */
    let nudges = 0;
    let crashAppend = true;

    const make = () =>
      createDelivery({
        journal,
        retryDelayMs: 0,
        sleep: async () => {},
        appendEvent: async (id, event, opts) => {
          if (crashAppend && event.type === 'run.nudged') throw new Error('killed mid-nudge');
          return journal.appendEvent(id, event, opts);
        },
        deliverToParent: async (_chatId, _message, meta) => {
          if (meta.kind === 'check_in_nudge') nudges += 1;
        },
      });

    await assert.rejects(() =>
      make().offerNudge({ parentChatId: PARENT, runId: RUN, elapsedSec: 3 }),
    );
    assert.equal(nudges, 1);
    assert.equal((await journal.loadState(PARENT)).runs.get(RUN).nudged, false);

    crashAppend = false;
    assert.equal(await make().offerNudge({ parentChatId: PARENT, runId: RUN, elapsedSec: 3 }), true);
    assert.equal(nudges, 2);
    assert.equal((await journal.loadState(PARENT)).runs.get(RUN).nudged, true);
    assert.equal(await make().offerNudge({ parentChatId: PARENT, runId: RUN, elapsedSec: 3 }), false);
    assert.equal(nudges, 2);
  });

  test('no delivery listener parks without retry or error callback', async () => {
    const journal = createMemoryJournal();
    await seedPassed(journal);
    /** @type {number} */
    let injects = 0;
    /** @type {number} */
    let errors = 0;
    const delivery = createDelivery({
      journal,
      retryDelayMs: 30,
      sleep: async () => {},
      deliverToParent: async () => {
        injects += 1;
        throw new Error(NO_DELIVERY_LISTENER);
      },
      onDeliverError: () => {
        errors += 1;
      },
    });

    await delivery.tick(PARENT);
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(injects, 1, 'must not timer-retry while nobody is listening');
    assert.equal(errors, 0, 'a missing viewer is idle, not a delivery failure');
    assert.equal((await journal.loadState(PARENT)).runs.get(RUN).delivered, false);

    delivery.setDeliverToParent(async () => {
      injects += 1;
    });
    await delivery.tick(PARENT);
    assert.equal(injects, 2);
    assert.equal((await journal.loadState(PARENT)).runs.get(RUN).delivered, true);
    delivery.reset();
  });

  test('a real inject failure still retries and reports', async () => {
    const journal = createMemoryJournal();
    await seedPassed(journal);
    /** @type {number} */
    let injects = 0;
    /** @type {string[]} */
    const reported = [];
    /** @type {() => void} */
    let sawRetry = () => {};
    const retried = new Promise((resolve) => {
      sawRetry = resolve;
    });
    const delivery = createDelivery({
      journal,
      retryDelayMs: 30,
      sleep: async () => {},
      deliverToParent: async () => {
        injects += 1;
        if (injects === 1) throw new Error('resume blew up');
        sawRetry();
      },
      onDeliverError: (err) => {
        reported.push(err instanceof Error ? err.message : String(err));
      },
    });

    await delivery.tick(PARENT);
    assert.equal(injects, 1);
    assert.deepEqual(reported, ['resume blew up']);
    await retried;
    // The timer tick is still appending. A follow-up tick waits on that tail.
    await delivery.tick(PARENT);
    assert.equal(injects, 2, 'timer retry must still run for a real inject failure');
    assert.equal((await journal.loadState(PARENT)).runs.get(RUN).delivered, true);
    delivery.reset();
  });
});

// ── kill/restart against ─────────────────────────────────────────────────────

describe('delivery — kill/restart against the on-disk journal', () => {
  /** @type {string} */
  let homeDir = '';

  before(async () => {
    homeDir = setTestHome(process.env, 'minnow-test-p8e-delivery');
    await ensureMinnowLayout();
  });

  after(async () => {
    deleteGenerationsForProviderShutdown();
    agentsJournal.resetJournalCache();
    await rmTestHome(homeDir);
    resetMinnowHomeCache();
  });

  function wrapDisk(overrides = {}) {
    return {
      loadState: (id) => agentsJournal.loadState(id),
      appendEvent: (id, event, opts) => agentsJournal.appendEvent(id, event, opts),
      appendEvents: (id, events, opts) => agentsJournal.appendEvents(id, events, opts),
      listEntries: () => agentsJournal.listEntries(),
      readEvents: (id) => agentsJournal.readEvents(id),
      ...overrides,
    };
  }

  test('crash after inject before append re-delivers exactly once on restart', async () => {
    const parentChatId = 'chat-p8e-crash-before';
    const runId = 'run-p8e-crash-before';
    await seedPassed(wrapDisk(), runId, parentChatId);

    /** @type {number} */
    let injects = 0;
    let crashAppend = true;

    const make = () => {
      const journal = wrapDisk({
        appendEvents: async (id, events, opts) => {
          if (crashAppend && events.some((e) => e.type === 'result.delivered')) {
            throw new Error('killed after inject');
          }
          return agentsJournal.appendEvents(id, events, opts);
        },
      });
      return createDelivery({
        journal,
        retryDelayMs: 0,
        sleep: async () => {},
        deliverToParent: async () => {
          injects += 1;
        },
      });
    };

    await assert.rejects(() => make().tick(parentChatId));
    assert.equal(injects, 1);
    agentsJournal.resetJournalCache();
    const torn = derive(await agentsJournal.readEvents(parentChatId));
    assert.equal(torn.runs.get(runId).delivered, false);
    assert.deepEqual(
      pendingDeliveries(torn).map((r) => r.runId),
      [runId],
    );

    crashAppend = false;
    const restarted = make();
    await restarted.tick(parentChatId);
    assert.equal(injects, 2, 'one extra inject after the crash');
    assert.equal((await agentsJournal.loadState(parentChatId)).runs.get(runId).delivered, true);

    agentsJournal.resetJournalCache();
    await make().tick(parentChatId);
    assert.equal(injects, 2, 'no extra inject once result.delivered is on disk');
  });

  test('crash after append does not re-deliver on restart', async () => {
    const parentChatId = 'chat-p8e-crash-after';
    const runId = 'run-p8e-crash-after';
    await seedPassed(wrapDisk(), runId, parentChatId);

    /** @type {number} */
    let injects = 0;
    const first = createDelivery({
      journal: wrapDisk(),
      retryDelayMs: 0,
      sleep: async () => {},
      deliverToParent: async () => {
        injects += 1;
      },
    });
    await first.tick(parentChatId);
    assert.equal(injects, 1);
    assert.equal((await agentsJournal.loadState(parentChatId)).runs.get(runId).delivered, true);

    agentsJournal.resetJournalCache();
    const restarted = createDelivery({
      journal: wrapDisk(),
      retryDelayMs: 0,
      sleep: async () => {},
      deliverToParent: async () => {
        injects += 1;
      },
    });
    await restarted.tick(parentChatId);
    await restarted.tickAll();
    assert.equal(injects, 1);
  });

  test('tickAll on boot re-offers a pending run written before the process existed', async () => {
    const parentChatId = 'chat-p8e-boot';
    const runId = 'run-p8e-boot';
    await seedPassed(wrapDisk(), runId, parentChatId);
    agentsJournal.resetJournalCache();

    /** @type {string[]} */
    const ids = [];
    const booted = createDelivery({
      journal: wrapDisk(),
      retryDelayMs: 0,
      sleep: async () => {},
      deliverToParent: async (_chatId, _message, meta) => {
        ids.push(...meta.runIds);
      },
    });
    await booted.tickAll();
    assert.deepEqual(ids, [runId]);
    assert.equal((await agentsJournal.loadState(parentChatId)).runs.get(runId).delivered, true);
  });
});

// ── buildProductionParentMessage ─────────────────────────────────────────────

describe('buildProductionParentMessage', () => {
  test('includes type, status, and last attempt summary (not ids-only)', async () => {
    const journal = createMemoryJournal();
    await seedPassed(journal);
    const run = (await journal.loadState(PARENT)).runs.get(RUN);
    const message = buildProductionParentMessage('completion', [run]);
    assert.match(message, /\[Sub-agent finished\]/);
    assert.match(message, /FIXED_SUMMARY/);
    assert.match(message, /"type": "explore"/);
    assert.match(message, /"status": "completed"/);
    // Default copy ended with a comma-joined id list. Product copy must not.
    assert.equal(/\n\n[a-z0-9-]+$/i.test(message.trim()), false);
  });

  test('abandon includes reason and evidence', async () => {
    const journal = createMemoryJournal();
    await journal.appendEvent(PARENT, requested());
    await journal.appendEvent(PARENT, started());
    await journal.appendEvent(
      PARENT,
      makeEvent('attempt.ended', {
        runId: RUN,
        attemptId: 'a1',
        outcome: 'fail',
        summary: 'could not finish',
      }),
    );
    await journal.appendEvent(
      PARENT,
      makeEvent('run.abandoned', {
        runId: RUN,
        reason: 'failed',
        evidence: { files: ['src/a.ts'], note: 'gave up after retry' },
      }),
    );
    const run = (await journal.loadState(PARENT)).runs.get(RUN);
    const message = buildProductionParentMessage('completion', [run]);
    assert.match(message, /"status": "failed"/);
    assert.match(message, /could not finish/);
    assert.match(message, /gave up after retry/);
    assert.match(message, /src\/a\.ts/);
  });

  test('check-in copy stays on the ids-bearing default', () => {
    const message = buildProductionParentMessage(
      'check_in_nudge',
      [{ runId: RUN, type: 'explore', phase: 'running' }],
      { elapsedSec: 12 },
    );
    assert.match(message, /\[Sub-agent check-in\]/);
    assert.match(message, new RegExp(RUN));
    assert.match(message, /12s/);
  });
});

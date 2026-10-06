import { derive, isTerminal, lastEndedAttempt, pendingDeliveries } from './derive.js';
import { makeEvent, validateEvent } from './events.js';

/** Backstop poll while the parent is streaming or a seam call failed. */
export const RETRY_DELAY_MS = 5_000;

/**
 * Production `deliverToParent` throws this when no SSE viewer is connected.
 * The fold stays pending; the wake-up is `GET /api/agents/:runId/events`
 * (subscribe then tick). Do not timer-retry or warn — that is idle, not a failure.
 */
export const NO_DELIVERY_LISTENER = 'no delivery listener';

/** One extra attempt on a transient network error, matching the renderer path. */
const TRANSIENT_RETRY_MS = 1_500;

/**
 * @param {unknown} err
 * @returns {boolean}
 */
export function isNoDeliveryListenerError(err) {
  const text = err instanceof Error ? err.message : String(err);
  return text === NO_DELIVERY_LISTENER;
}

/**
 * In-memory journal with the same load/append/list surface as the disk store.
 *
 * Used by tests that do not need crash-across-process. Production delivery
 * uses the on-disk journal (`runtime.js`); the renderer is a view of SSE.
 *
 * @returns {DeliveryJournal}
 */
export function createMemoryJournal() {
  /** @type {Map<string, Record<string, unknown>[]>} */
  const byId = new Map();

  /** @param {string} id */
  function listOf(id) {
    let list = byId.get(id);
    if (!list) {
      list = [];
      byId.set(id, list);
    }
    return list;
  }

  return {
    async loadState(id) {
      return derive(listOf(id));
    },
    async readEvents(id) {
      return listOf(id).map((e) => ({ ...e }));
    },
    async appendEvent(id, event, options = {}) {
      const list = listOf(id);
      const seq = list.length + 1;
      const now = options.now ?? (() => 0);
      const stamped = { v: 1, ...event, seq, ts: now() };
      const checked = validateEvent(stamped);
      if (!checked.ok) throw new Error(`refusing to journal an invalid event: ${checked.error}`);
      const line = JSON.parse(JSON.stringify(stamped));
      list.push(line);
      return line;
    },
    async appendEvents(id, events, options = {}) {
      const out = [];
      for (const event of events) out.push(await this.appendEvent(id, event, options));
      return out;
    },
    async listEntries() {
      return [...byId.keys()];
    },
    reset() {
      byId.clear();
    },
  };
}

/**
 * Default resume copy for tests and the server tick. Product copy lives in
 * `buildSubAgentParentResumeMessage` and is unchanged — inject `buildMessage`
 * to use it. Prefixes match `hidden-transcript-user-messages.ts` so a server
 * inject is still hidden from the transcript.
 *
 * @param {'completion' | 'check_in_nudge'} kind
 * @param {import('./types').RunState[]} runs
 * @param {{ elapsedSec?: number }} [extra]
 * @returns {string}
 */
export function defaultBuildMessage(kind, runs, extra = {}) {
  if (kind === 'check_in_nudge') {
    const run = runs[0];
    const elapsed = Number.isFinite(extra.elapsedSec) ? extra.elapsedSec : 0;
    const type = run?.type ?? 'sub-agent';
    const runId = run?.runId ?? '';
    return (
      `[Sub-agent check-in] Sub-agent \`${type}\` (\`${runId}\`) has run ${elapsed}s ` +
      `and has not finished yet. It will report back automatically when done. ` +
      `Call \`get_sub_agent_status\` with run_id \`${runId}\` if you want a mid-run check. ` +
      `Do not poll in a loop — wait for the automatic completion message.`
    );
  }
  const ids = runs.map((r) => r.runId).join(',');
  const header =
    runs.length === 1
      ? '[Sub-agent finished] One sub-agent run completed. Use the summary below; `get_sub_agent_status` is available for details.'
      : `[Sub-agent finished] ${runs.length} sub-agent runs completed. Summaries below.`;
  return `${header}\n\n${ids}`;
}

/**
 * Product completion copy for the production host. Includes type, status, and
 * the last attempt summary / abandon evidence — ids-only left the parent
 * with nothing to resume on. Check-in copy matches {@link defaultBuildMessage}.
 *
 * @param {'completion' | 'check_in_nudge'} kind
 * @param {import('./types').RunState[]} runs
 * @param {{ elapsedSec?: number }} [extra]
 * @returns {string}
 */
export function buildProductionParentMessage(kind, runs, extra = {}) {
  if (kind === 'check_in_nudge') return defaultBuildMessage(kind, runs, extra);
  const list = Array.isArray(runs) ? runs : [];
  const blocks = list.map((run) => {
    const last = lastEndedAttempt(run);
    const status =
      run.phase === 'passed'
        ? 'completed'
        : run.phase === 'cancelled'
          ? 'cancelled'
          : run.phase === 'abandoned'
            ? 'failed'
            : run.phase;
    const summary =
      (typeof last?.summary === 'string' && last.summary.trim() && last.summary) ||
      (typeof run.abandonedReason === 'string' && run.abandonedReason) ||
      '';
    /** @type {Record<string, unknown>} */
    const body = {
      runId: run.runId,
      type: run.type,
      status,
      summary,
    };
    if (typeof run.abandonedReason === 'string' && run.abandonedReason) {
      body.error = run.abandonedReason;
    }
    if (run.abandonedEvidence && typeof run.abandonedEvidence === 'object') {
      body.evidence = run.abandonedEvidence;
    }
    return JSON.stringify(body, null, 2);
  });
  const header =
    list.length === 1
      ? '[Sub-agent finished] One sub-agent run completed. Use the summary below; `get_sub_agent_status` is available for details.'
      : `[Sub-agent finished] ${list.length} sub-agent runs completed. Summaries below.`;
  return `${header}\n\n${blocks.join('\n\n---\n\n')}`;
}

/**
 * @param {unknown} err
 * @returns {boolean}
 */
function isTransientDeliverError(err) {
  const text = err instanceof Error ? err.message : String(err);
  return text.includes('Failed to fetch') || text.includes('NetworkError');
}

/**
 * @param {DeliveryOptions} [opts]
 * @returns {DeliveryHandle}
 */
export function createDelivery(opts = {}) {
  const journal = opts.journal ?? createMemoryJournal();
  const loadState = opts.loadState ?? ((id) => journal.loadState(id));
  const appendEvent = opts.appendEvent ?? ((id, event, o) => journal.appendEvent(id, event, o));
  const appendEvents =
    opts.appendEvents ??
    (journal.appendEvents
      ? (id, events, o) => journal.appendEvents(id, events, o)
      : async (id, events, o) => {
          const out = [];
          for (const event of events) out.push(await appendEvent(id, event, o));
          return out;
        });
  const listEntries = opts.listEntries ?? (() => journal.listEntries());
  const parentStatus = opts.parentStatus ?? (() => ({ streaming: false, skip: null }));
  const buildMessage = opts.buildMessage ?? defaultBuildMessage;
  const notifyUndeliverable = opts.notifyUndeliverable ?? (async () => {});
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const retryDelayMs = Number.isFinite(opts.retryDelayMs) ? opts.retryDelayMs : RETRY_DELAY_MS;
  const requiresAcceptanceAck = opts.requiresAcceptanceAck === true;

  /** @type {(parentChatId: string, message: string, meta: DeliveryMeta) => Promise<void>} */
  let deliverToParent = opts.deliverToParent ?? (async () => {});

  /** Per-chat serial tail so overlapping ticks cannot double-inject. */
  /** @type {Map<string, Promise<void>>} */
  const tails = new Map();
  /** @type {Map<string, ReturnType<typeof setTimeout>>} */
  const retryTimers = new Map();

  /**
   * @param {string} parentChatId
   * @param {() => Promise<void>} work
   * @returns {Promise<void>}
   */
  function enqueue(parentChatId, work) {
    const prev = tails.get(parentChatId) ?? Promise.resolve();
    const next = prev.then(work, work);
    tails.set(parentChatId, next.catch(() => {}));
    return next;
  }

  /** @param {string} parentChatId */
  function cancelRetry(parentChatId) {
    const timer = retryTimers.get(parentChatId);
    if (timer === undefined) return;
    clearTimeout(timer);
    retryTimers.delete(parentChatId);
  }

  /** @param {string} parentChatId */
  function scheduleRetry(parentChatId) {
    if (retryTimers.has(parentChatId)) return;
    if (retryDelayMs <= 0) return;
    const timer = setTimeout(() => {
      retryTimers.delete(parentChatId);
      void tick(parentChatId);
    }, retryDelayMs);
    timer.unref?.();
    retryTimers.set(parentChatId, timer);
  }

  /**
   * Call the seam, with one retry on a transient network error. Does NOT
   * journal — the caller appends only after this resolves.
   *
   * @param {string} parentChatId
   * @param {string} message
   * @param {DeliveryMeta} meta
   * @returns {Promise<boolean>}
   */
  async function inject(parentChatId, message, meta) {
    try {
      await deliverToParent(parentChatId, message, meta);
      return true;
    } catch (err) {
      if (!isTransientDeliverError(err)) throw err;
      await sleep(TRANSIENT_RETRY_MS);
      await deliverToParent(parentChatId, message, meta);
      return true;
    }
  }

  /**
   * Offer every pending completion for this parent. The fold is re-read at
   * the start of the work (and after inject, before append) so a concurrent
   * tick cannot mark the same `(runId, parentChatId)` twice.
   *
   * @param {string} parentChatId
   * @returns {Promise<void>}
   */
  async function doTick(parentChatId) {
    const state = await loadState(parentChatId);
    const pending = pendingDeliveries(state);
    if (pending.length === 0) {
      cancelRetry(parentChatId);
      return;
    }

    const status = parentStatus(parentChatId) ?? { streaming: false, skip: null };

    if (status.skip) {
      for (const run of pending) {
        if (status.skip === 'missing_chat') {
          await notifyUndeliverable(parentChatId, run);
        }
        await appendEvent(
          parentChatId,
          makeEvent('result.delivered', {
            runId: run.runId,
            parentChatId,
            skipReason: status.skip,
          }),
        );
      }
      cancelRetry(parentChatId);
      return;
    }

    if (status.streaming) {
      scheduleRetry(parentChatId);
      return;
    }

    const runIds = pending.map((r) => r.runId);
    const message = buildMessage('completion', pending, {});
    try {
      await inject(parentChatId, message, { kind: 'completion', runIds });
    } catch (err) {
      if (isNoDeliveryListenerError(err)) return;
      scheduleRetry(parentChatId);
      if (opts.onDeliverError) opts.onDeliverError(err);
      return;
    }

    // The SSE write proves only that a transport listener existed. Production
    // keeps the result pending until the renderer confirms durable acceptance.
    if (requiresAcceptanceAck) {
      scheduleRetry(parentChatId);
      return;
    }

    const after = await loadState(parentChatId);
    const stillPending = pendingDeliveries(after).filter((r) => runIds.includes(r.runId));
    if (stillPending.length === 0) {
      cancelRetry(parentChatId);
      return;
    }
    try {
      await appendEvents(
        parentChatId,
        stillPending.map((run) =>
          makeEvent('result.delivered', { runId: run.runId, parentChatId }),
        ),
      );
    } catch (err) {
      scheduleRetry(parentChatId);
      if (opts.onDeliverError) opts.onDeliverError(err);
      throw err;
    }
    cancelRetry(parentChatId);
  }

  /**
   * @param {string} parentChatId
   * @returns {Promise<void>}
   */
  function tick(parentChatId) {
    if (!parentChatId) return Promise.resolve();
    return enqueue(parentChatId, () => doTick(parentChatId));
  }

  /** Idempotent, journaled acceptance of terminal results by the parent. */
  function acknowledge(parentChatId, runIds) {
    return enqueue(parentChatId, async () => {
      const state = await loadState(parentChatId);
      const wanted = new Set(runIds);
      const accepted = pendingDeliveries(state).filter((run) => wanted.has(run.runId));
      if (accepted.length > 0) {
        await appendEvents(parentChatId, accepted.map((run) =>
          makeEvent('result.delivered', { runId: run.runId, parentChatId }),
        ));
      }
      return accepted.map((run) => run.runId);
    });
  }

  /**
   * Boot / restart sweep: every journaled parent is re-offered. Pending
   * runs survive because they have no `result.delivered` yet.
   *
   * @returns {Promise<void>}
   */
  async function tickAll() {
    const ids = await listEntries();
    for (const id of ids) await tick(id);
  }

  /**
   * Fire the once-per-run check-in if the fold says it has not landed.
   * Appends `run.nudged` only after the seam resolves — a reload must not
   * re-fire a nudge that already reached the parent, and must re-fire one
   * that crashed between inject and append.
   *
   * @param {{ parentChatId: string, runId: string, elapsedSec?: number }} input
   * @returns {Promise<boolean>} true when a nudge was injected this call
   */
  async function offerNudge(input) {
    const parentChatId = input.parentChatId;
    const runId = input.runId;
    if (!parentChatId || !runId) return false;

    return enqueue(parentChatId, async () => {
      const state = await loadState(parentChatId);
      const run = state.runs.get(runId);
      if (!run) return false;
      if (run.nudged) return false;
      if (isTerminal(run)) return false;

      const status = parentStatus(parentChatId) ?? { streaming: false, skip: null };
      if (status.skip) return false;
      if (status.streaming) return false;

      const message = buildMessage('check_in_nudge', [run], { elapsedSec: input.elapsedSec ?? 0 });
      try {
        await inject(parentChatId, message, { kind: 'check_in_nudge', runIds: [runId] });
      } catch (err) {
        if (!isNoDeliveryListenerError(err) && opts.onDeliverError) opts.onDeliverError(err);
        return false;
      }

      const after = await loadState(parentChatId);
      if (after.runs.get(runId)?.nudged) return true;
      await appendEvent(parentChatId, makeEvent('run.nudged', { runId, parentChatId }));
      return true;
    });
  }

  /**
   * Tests / renderer: swap the seam without rebuilding the handle (the
   * journal stays the source of truth).
   *
   * @param {typeof deliverToParent} fn
   */
  function setDeliverToParent(fn) {
    deliverToParent = fn;
  }

  function reset() {
    for (const timer of retryTimers.values()) clearTimeout(timer);
    retryTimers.clear();
    tails.clear();
    journal.reset?.();
  }

  return {
    tick,
    acknowledge,
    tickAll,
    offerNudge,
    setDeliverToParent,
    reset,
    journal,
    loadState,
  };
}

/**
 * @typedef {object} DeliveryMeta
 * @property {'completion' | 'check_in_nudge'} kind
 * @property {string[]} runIds
 */

/**
 * @typedef {object} ParentStatus
 * @property {boolean} streaming
 * @property {null | 'missing_chat' | 'orchestrate'} skip
 */

/**
 * @typedef {object} DeliveryJournal
 * @property {(id: string) => Promise<import('./types').AgentsState>} loadState
 * @property {(id: string, event: Record<string, unknown>, options?: { now?: () => number }) => Promise<Record<string, unknown>>} appendEvent
 * @property {(id: string, events: Record<string, unknown>[], options?: { now?: () => number }) => Promise<Record<string, unknown>[]>} [appendEvents]
 * @property {() => Promise<string[]>} listEntries
 * @property {(id: string) => Promise<Record<string, unknown>[]>} [readEvents]
 * @property {() => void} [reset]
 */

/**
 * @typedef {object} DeliveryOptions
 * @property {DeliveryJournal} [journal]
 * @property {(id: string) => Promise<import('./types').AgentsState>} [loadState]
 * @property {(id: string, event: Record<string, unknown>, options?: { now?: () => number }) => Promise<Record<string, unknown>>} [appendEvent]
 * @property {(id: string, events: Record<string, unknown>[], options?: { now?: () => number }) => Promise<Record<string, unknown>[]>} [appendEvents]
 * @property {() => Promise<string[]>} [listEntries]
 * @property {(parentChatId: string, message: string, meta: DeliveryMeta) => Promise<void>} [deliverToParent]
 * @property {(parentChatId: string) => ParentStatus} [parentStatus]
 * @property {(kind: 'completion' | 'check_in_nudge', runs: import('./types').RunState[], extra?: { elapsedSec?: number }) => string} [buildMessage]
 * @property {(parentChatId: string, run: import('./types').RunState) => Promise<void> | void} [notifyUndeliverable]
 * @property {(ms: number) => Promise<void>} [sleep]
 * @property {number} [retryDelayMs]
 * @property {boolean} [requiresAcceptanceAck]
 * @property {(err: unknown) => void} [onDeliverError]
 */

/**
 * @typedef {object} DeliveryHandle
 * @property {(parentChatId: string) => Promise<void>} tick
 * @property {() => Promise<void>} tickAll
 * @property {(input: { parentChatId: string, runId: string, elapsedSec?: number }) => Promise<boolean>} offerNudge
 * @property {(fn: (parentChatId: string, message: string, meta: DeliveryMeta) => Promise<void>) => void} setDeliverToParent
 * @property {() => void} reset
 * @property {DeliveryJournal} journal
 * @property {(id: string) => Promise<import('./types').AgentsState>} loadState
 */

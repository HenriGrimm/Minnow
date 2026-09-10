import { peekEngine } from '../orchestrator/engine.js';
import { checkStageArtifact } from './artifacts.js';
/**
 * Delegated effector for the Super Plan run engine (W4-A).
 *
 * `interview` and `draft` are the two stages a human drives in the renderer:
 * the engine cannot run them headlessly, so it *delegates* them. `start()`
 * records a **lease** and publishes it on the live channel; a renderer claims
 * the lease (compare-and-set on `attemptId`) and heartbeats it while it works.
 *
 * The lease is the liveness signal the engine reads through `inspect()`:
 *   - an unexpired lease keeps the attempt live, so `plan()` keeps returning
 *     the same Desired and the engine re-offers it instead of stopping it;
 *   - once the heartbeat stops the lease expires, `inspect()` drops it, the
 *     engine reaps the attempt `crashed`, and the stage is re-planned.
 *
 * There is deliberately no "chat busy" branch: an unclaimed lease is simply
 * offered again on the next tick. Claiming is a compare-and-set on
 * `attemptId`, so two windows racing for one lease produce exactly one winner
 * (the loser gets a `409`). A `finish()` that arrives after the lease was
 * reaped is a no-op, and artifact writes are content-addressed so a duplicate
 * draft cannot apply twice.
 *
 * Like the other effectors this module is I/O — it reads the clock, schedules
 * timeouts, and uses `node:crypto` for ids and content addresses — so it is
 * excluded from the graph purity guard the same way `effector-headless.js` is.
 */

import { createHash, randomUUID } from 'node:crypto';

import { emitLive } from './live-events.js';

/** The two pipeline stages a renderer drives; every other role is headless. */
export const DELEGATED_ROLES = /** @type {const} */ (['interview', 'draft']);

/** How often the claimer should heartbeat. Advertised on the lease. */
export const DEFAULT_HEARTBEAT_MS = 10_000;

/** How long a lease survives without a heartbeat before it is reaped. */
export const DEFAULT_EXPIRY_MS = 45_000;

/** Attempt id prefix, mirroring `sp-` for headless and `r-` for boards. */
const ATTEMPT_PREFIX = 'dlg-';

/**
 * The live delegated effector for each run. The HTTP claim route has no other
 * handle on the effector the engine was built with, so `createDelegatedEffector`
 * registers itself here when it is given a `runId`.
 *
 * @type {Map<string, ReturnType<typeof createDelegatedEffector>>}
 */
const delegatedByRun = new Map();

/**
 * @param {string} runId
 * @returns {ReturnType<typeof createDelegatedEffector> | undefined}
 */
export function getDelegatedEffector(runId) {
  return delegatedByRun.get(String(runId ?? ''));
}

/** Tests: drop the registry so runs do not leak across cases. */
export function resetDelegatedEffectors() {
  delegatedByRun.clear();
}

/** Clock used by the effector. Tests replace it to drive expiry deterministically. */
export const delegatedClock = {
  now: () => Date.now(),
  /**
   * @param {() => void} fn
   * @param {number} ms
   * @returns {unknown}
   */
  setTimer: (fn, ms) => setTimeout(fn, ms),
  /** @param {unknown} handle */
  clearTimer: (handle) => clearTimeout(/** @type {NodeJS.Timeout} */ (handle)),
};

/**
 * A 409-shaped claim conflict. The status is on the object so the HTTP handler
 * (and any caller) can forward it without re-deriving the reason.
 *
 * @param {string} error
 * @returns {{ ok: false, status: 409, error: string }}
 */
function conflict(error) {
  return { ok: false, status: 409, error };
}

/**
 * Deterministic content address for an artifact. Two drafts with identical
 * bytes produce the same address, which is what makes a duplicate write
 * idempotent.
 *
 * @param {string} content
 * @returns {string}
 */
export function contentAddress(content) {
  return createHash('sha256').update(String(content ?? ''), 'utf8').digest('hex').slice(0, 32);
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<any>}
 */
async function readJsonBody(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 1_000_000) throw new Error('payload too large');
  }
  if (body.trim().length === 0) return {};
  return JSON.parse(body);
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} payload
 * @returns {void}
 */
function writeJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

/**
 * Create the delegated effector for one Super Plan run.
 *
 * @param {{
 *   runId?: string,
 *   clock?: { now: () => number, setTimer: (fn: () => void, ms: number) => unknown,
 *             clearTimer: (handle: unknown) => void },
 *   heartbeatMs?: number,
 *   expiryMs?: number,
 * }} [options]
 */
export function createDelegatedEffector(options = {}) {
  const runId = typeof options.runId === 'string' ? options.runId : null;
  const clock = options.clock ?? delegatedClock;
  const heartbeatMs =
    Number.isFinite(options.heartbeatMs) && /** @type {number} */ (options.heartbeatMs) > 0
      ? /** @type {number} */ (options.heartbeatMs)
      : DEFAULT_HEARTBEAT_MS;
  const expiryMs =
    Number.isFinite(options.expiryMs) && /** @type {number} */ (options.expiryMs) > 0
      ? /** @type {number} */ (options.expiryMs)
      : DEFAULT_EXPIRY_MS;

  /**
   * @typedef {object} Lease
   * @property {string} attemptId
   * @property {string | null} taskId
   * @property {string} role
   * @property {string} seedKind
   * @property {string | null} claimedBy
   * @property {number} createdAt
   * @property {number} heartbeatAt
   * @property {number} expiresAt
   * @property {boolean} ended
   * @property {boolean} stopped
   */

  /** @type {Map<string, Lease>} */
  const leases = new Map();
  /** @type {Array<(end: import('../orchestrator/engine.js').AttemptEnd) => Promise<void> | void>} */
  const listeners = [];
  /** @type {Array<{ taskId: string | null, role: string, attemptId: string, seedKind?: string }>} */
  const startLog = [];
  /** Content addresses already recorded; a repeat write is idempotent. */
  const artifactAddresses = new Set();
  /** Attempt ids already finished, so a late finish is an idempotent no-op. */
  const finishedAttempts = new Set();

  /** @param {Lease} lease */
  function isExpired(lease) {
    return Boolean(lease.claimedBy) && lease.expiresAt <= clock.now();
  }

  /** @param {Lease} lease */
  function isLive(lease) {
    return !lease.ended && !lease.stopped && !isExpired(lease);
  }

  /** @param {Lease} lease */
  function touch(lease) {
    const at = clock.now();
    lease.heartbeatAt = at;
    lease.expiresAt = at + expiryMs;
  }

  /**
   * Public shape of a lease — no internal flags, no closures.
   * @param {Lease} lease
   */
  function publicLease(lease) {
    return {
      attemptId: lease.attemptId,
      taskId: lease.taskId,
      role: lease.role,
      seedKind: lease.seedKind,
      claimedBy: lease.claimedBy,
      heartbeatMs,
      expiryMs,
      createdAt: lease.createdAt,
      heartbeatAt: lease.heartbeatAt,
      expiresAt: lease.expiresAt,
    };
  }

  /** Drop ended/expired leases so a long-lived process does not accumulate them. */
  function prune() {
    for (const [attemptId, lease] of leases) {
      if (lease.ended || lease.stopped || isExpired(lease)) leases.delete(attemptId);
    }
  }

  /**
   * The live lease for one task+role, if any — `sameWork` at the effector.
   * @param {string | null} taskId
   * @param {string} role
   * @returns {Lease | undefined}
   */
  function liveLeaseFor(taskId, role) {
    for (const lease of leases.values()) {
      if (lease.taskId === taskId && lease.role === role && isLive(lease)) return lease;
    }
    return undefined;
  }

  const effector = {
    /** @returns {Array<{ taskId: string | null, role: string, attemptId: string }>} */
    inspect() {
      /** @type {Array<{ taskId: string | null, role: string, attemptId: string }>} */
      const out = [];
      for (const lease of leases.values()) {
        if (!isLive(lease)) continue;
        out.push({ taskId: lease.taskId, role: lease.role, attemptId: lease.attemptId });
      }
      return out;
    },

    /**
     * Record a lease and offer it on the live channel. Idempotent per role: an
     * unexpired lease for the same task+role is re-offered (same `attemptId`)
     * rather than duplicated.
     *
     * @param {{ taskId: string | null, role: string, seedKind?: string }} desired
     * @returns {Promise<{ attemptId: string }>}
     */
    async start(desired) {
      const role = String(desired?.role ?? '');
      if (!DELEGATED_ROLES.includes(/** @type {any} */ (role))) {
        throw new Error(`delegated effector: unsupported role ${role}`);
      }
      const taskId = desired?.taskId ?? null;
      if (!taskId) {
        throw new Error('delegated effector: desired.taskId (runId) is required');
      }

      const existing = liveLeaseFor(taskId, role);
      if (existing) return { attemptId: existing.attemptId };

      prune();

      const attemptId = `${ATTEMPT_PREFIX}${randomUUID()}`;
      const at = clock.now();
      /** @type {Lease} */
      const lease = {
        attemptId,
        taskId,
        role,
        seedKind: typeof desired?.seedKind === 'string' ? desired.seedKind : 'initial',
        claimedBy: null,
        createdAt: at,
        heartbeatAt: at,
        expiresAt: at + expiryMs,
        ended: false,
        stopped: false,
      };
      leases.set(attemptId, lease);
      startLog.push({
        taskId,
        role,
        attemptId,
        ...(lease.seedKind !== undefined ? { seedKind: lease.seedKind } : {}),
      });

      // Liveness, not a fact: the lease rides the parallel live channel the
      // renderer subscribes to. Never journaled — replay is a pure fold of
      // durable events and must not depend on who was watching.
      emitLive({
        runId: taskId,
        stage: role,
        event: /** @type {any} */ ({
          type: 'lease',
          attemptId,
          role,
          seedKind: lease.seedKind,
          heartbeatMs,
          expiryMs,
          expiresAt: lease.expiresAt,
        }),
      });

      return { attemptId };
    },

    /**
     * Compare-and-set a claim on `attemptId`. Two windows racing the same
     * lease produce one `200` and one `409`; a re-claim by the same client is
     * idempotent.
     *
     * @param {string} attemptId
     * @param {string} clientId
     * @returns {{ ok: true, status: 200, lease: Record<string, unknown> }
     *          | { ok: false, status: 409, error: string }}
     */
    claim(attemptId, clientId) {
      const lease = leases.get(String(attemptId ?? ''));
      const who = String(clientId ?? '');
      if (!lease) return conflict('no such lease');
      if (lease.ended || lease.stopped) return conflict('the lease has ended');
      if (isExpired(lease)) return conflict('the lease has expired');
      if (!who) return conflict('clientId is required');
      if (lease.claimedBy && lease.claimedBy !== who) return conflict('the lease is already claimed');
      lease.claimedBy = who;
      touch(lease);
      return { ok: true, status: 200, lease: publicLease(lease) };
    },

    /**
     * Extend a claimed lease. Only the claimer may heartbeat; a stale or
     * expired lease is a `409`.
     *
     * @param {string} attemptId
     * @param {string} clientId
     * @returns {{ ok: true, status: 200, expiresAt: number, lease: Record<string, unknown> }
     *          | { ok: false, status: 409, error: string }}
     */
    heartbeat(attemptId, clientId) {
      const lease = leases.get(String(attemptId ?? ''));
      const who = String(clientId ?? '');
      if (!lease) return conflict('no such lease');
      if (lease.ended || lease.stopped) return conflict('the lease has ended');
      if (isExpired(lease)) return conflict('the lease has expired');
      if (lease.claimedBy !== who) return conflict('not the claimer');
      touch(lease);
      return { ok: true, status: 200, expiresAt: lease.expiresAt, lease: publicLease(lease) };
    },

    /**
     * Complete a lease: deliver the attempt end to the engine's `onEnd`
     * handlers and drop the lease from `inspect()`. A late finish for a lease
     * that was already reaped (or ended) is an idempotent no-op.
     *
     * @param {string} attemptId
     * @param {{ outcome?: string, summary?: string, evidence?: Record<string, unknown> }} [end]
     * @returns {Promise<{ ok: boolean, status: number, duplicate?: boolean, error?: string }>}
     */
    async finish(attemptId, end = {}) {
      const id = String(attemptId ?? '');
      const lease = leases.get(id);
      if (!lease) {
        if (finishedAttempts.has(id)) return { ok: true, status: 200, duplicate: true };
        return { ok: false, status: 409, error: 'no such lease' };
      }
      if (lease.ended || lease.stopped) return { ok: true, status: 200, duplicate: true };

      if (isExpired(lease)) return conflict('the lease has expired');
      if (end.clientId && lease.claimedBy !== end.clientId) return conflict('not the claimer');
      const engine = runId ? peekEngine(runId, 'superplan') : null;
      if (engine && end.outcome === 'pass') {
        const checked = await checkStageArtifact(engine.getState(), lease.role);
        end = { ...end, outcome: checked.errors ? 'rejected' : 'pass', evidence: { ...end.evidence, ...checked } };
      }
      if (!isLive(lease)) return conflict('the lease has ended');

      /** @type {import('../orchestrator/engine.js').AttemptEnd} */
      const attemptEnd = {
        attemptId: lease.attemptId,
        taskId: lease.taskId,
        role: lease.role,
        outcome: typeof end.outcome === 'string' ? end.outcome : 'crashed',
        ...(end.summary !== undefined ? { summary: end.summary } : {}),
        ...(end.evidence !== undefined ? { evidence: end.evidence } : {}),
      };
      for (const listener of listeners) await listener(attemptEnd);
      lease.ended = true;
      leases.delete(id);
      finishedAttempts.add(id);
      return { ok: true, status: 200, duplicate: false };
    },

    /**
     * Content-addressed artifact write. The same bytes written twice return
     * `{ duplicate: true }` and emit nothing the second time, so a duplicate
     * draft is idempotent.
     *
     * @param {{ stage?: string, path?: string, content?: string, attemptId?: string }} input
     * @returns {{ ok: true, duplicate: boolean, address: string, path: string | null }}
     */
    writeArtifact(input = {}) {
      const address = contentAddress(input.content ?? '');
      const path = typeof input.path === 'string' ? input.path : null;
      if (artifactAddresses.has(address)) {
        return { ok: true, duplicate: true, address, path };
      }
      artifactAddresses.add(address);
      emitLive({
        runId: runId ?? input.attemptId ?? '',
        stage: typeof input.stage === 'string' ? input.stage : 'draft',
        event: /** @type {any} */ ({
          type: 'artifact.written',
          stage: input.stage ?? 'draft',
          path,
          address,
          attemptId: input.attemptId ?? null,
        }),
      });
      return { ok: true, duplicate: false, address, path };
    },

    /**
     * Drop a lease without delivering an end — the reconcile loop's stop. With
     * `plan()` re-desiring in-flight work this is only reached when the engine
     * genuinely no longer wants the attempt.
     *
     * @param {string} attemptId
     * @returns {Promise<void>}
     */
    async stop(attemptId) {
      const lease = leases.get(String(attemptId ?? ''));
      if (!lease) return;
      lease.stopped = true;
      leases.delete(lease.attemptId);
    },

    /**
     * @param {(end: import('../orchestrator/engine.js').AttemptEnd) => Promise<void> | void} handler
     * @returns {void}
     */
    onEnd(handler) {
      listeners.push(handler);
    },

    get started() {
      return startLog;
    },

    /** Live leases, claimed or not — the introspection seam for tests/UI. */
    leases() {
      /** @type {Array<Record<string, unknown>>} */
      const out = [];
      for (const lease of leases.values()) {
        if (isLive(lease)) out.push(publicLease(lease));
      }
      return out;
    },

    /**
     * @param {string} attemptId
     * @returns {Record<string, unknown> | null}
     */
    leaseOf(attemptId) {
      const lease = leases.get(String(attemptId ?? ''));
      return lease ? publicLease(lease) : null;
    },

    /**
     * Drop every lease without an end — the crash analogue. The engine's next
     * tick reaps the open attempts as crashed and replans.
     * @returns {void}
     */
    vanishAll() {
      for (const lease of leases.values()) lease.stopped = true;
      leases.clear();
    },
  };

  if (runId) delegatedByRun.set(runId, effector);
  return effector;
}

/**
 * Connect-style handler for `POST /api/super-plan/:runId/claim`. Kept beside
 * the effector so the HTTP surface is one wiring step for the caller.
 *
 * @param {{ claim: (attemptId: string, clientId: string) => any }} effector
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
export function createDelegatedClaimHandler(effector) {
  return async (req, res) => {
    try {
      const body = await readJsonBody(req);
      const result = effector.claim(body?.attemptId, body?.clientId);
      writeJson(res, result.status ?? 200, {
        ok: result.ok,
        ...(result.error ? { error: result.error } : {}),
        ...(result.lease ? { lease: result.lease } : {}),
      });
    } catch (err) {
      writeJson(res, 400, {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };
}

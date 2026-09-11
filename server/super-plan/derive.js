/** Fold Super Plan journal events into run state. */

import { validateEvent } from './events.js';
import { decide } from './policy.js';

// ── Empty state ──────────────────────────────────────────────────────────────

/**
 * Pipeline defaults when run.created omits config.
 */
export const DEFAULT_CONFIG = Object.freeze({
  reviewRounds: 2,
  research: true,
  interview: true,
  polish: 'auto',
});

/**
 * The state of a run with no journal at all.
 * @returns {import('./types').RunState}
 */
export function emptyState() {
  return {
    runId: '',
    prompt: '',
    slug: '',
    workspacePath: null,
    config: { ...DEFAULT_CONFIG },
    status: 'created',
    finished: false,
    stopReason: null,
    runOutcome: null,
    runSummary: null,
    stage: null,
    pendingGate: null,
    pendingFinish: null,
    interviewSeed: null,
    draftSeed: null,
    draftAddressed: null,
    disputedClaims: [],
    attempts: [],
    stageRecords: [],
    reviews: [],
    specPath: null,
    researchPath: null,
    planPath: null,
    gate: null,
    gateHistory: [],
  };
}

// ── Fold ─────────────────────────────────────────────────────────────────────

/**
 * Fold events into an existing state, in place.
 * @param {import('./types').RunState} state
 * @param {Iterable<unknown>} events
 * @returns {import('./types').RunState} the same object, for chaining
 */
export function foldInto(state, events) {
  if (!events || typeof (/** @type {any} */ (events)[Symbol.iterator]) !== 'function') {
    return state;
  }
  for (const raw of events) {
    const checked = validateEvent(raw);
    if (!checked.ok || !checked.known) continue;
    apply(state, /** @type {any} */ (checked.event));
  }
  return state;
}

/**
 * Fold a journal into run state.
 *
 * @param {Iterable<unknown>} events
 * @returns {import('./types').RunState}
 */
export function derive(events) {
  return foldInto(emptyState(), events);
}

// ── Apply ────────────────────────────────────────────────────────────────────

/**
 * @param {import('./types').RunState} state
 * @param {any} event
 * @returns {void}
 */
function apply(state, event) {
  switch (event.type) {
    case 'run.created': {
      state.runId = event.runId;
      if (Number.isFinite(event.ts)) state.startedAt = event.ts;
      state.prompt = event.prompt;
      if (typeof event.workspacePath === 'string' && event.workspacePath.trim()) {
        state.workspacePath = event.workspacePath;
      }
      state.config = readConfig(event.config);
      state.chatId = event.chatId ?? null;
      state.slug = event.runId;
      state.stage = state.config.interview ? 'interview' : null;
      state.pendingGate = state.config.interview ? null : 'spec';
      return;
    }

    case 'run.started': {
      state.status = 'running';
      return;
    }

    case 'run.resumed': {
      // D8: resume a paused run. `stage` and `attempts` are untouched, so
      // `plan()` re-desires the *same* stage rather than a fresh pipeline.
      state.status = 'running';
      state.finished = false;
      state.stopReason = null;
      return;
    }

    case 'run.cancelled': {
      state.status = 'stopped';
      state.finished = true;
      state.stopReason = 'cancelled';
      return;
    }

    case 'run.stopped': {
      // D8: `paused` is non-terminal — the run keeps its stage and open
      // attempt, and `run.resumed` re-plans the same stage. `gate-expired`
      // remains the terminal stop.
      state.status = 'stopped';
      state.finished = event.reason !== 'paused';
      state.stopReason = event.reason;
      return;
    }

    case 'run.finished': {
      state.status = 'stopped';
      state.finished = true;
      state.runOutcome = event.outcome;
      state.runSummary = event.summary;
      state.stopReason = stopReasonForOutcome(event.outcome);
      return;
    }

    case 'slug.assigned':
    case 'run.renamed': {
      state.slug = event.slug;
      state.displayTitle = event.displayTitle ?? state.displayTitle;
      return;
    }

    case 'stage.reopened': {
      for (const attempt of state.attempts) attempt.ended = true;
      state.finished = false; state.status = 'running'; state.stopReason = null;
      state.pendingGate = null; state.pendingFinish = null; state.gate = null;
      state.stage = event.stage; state.draftSeed = 'errors';
      state.retryEpochIndex = state.stageRecords.length;
      state.reviews = [];
      return;
    }
    case 'stage.skipped': {
      for (const attempt of state.attempts) attempt.ended = true;
      if (event.stage === 'interview') { state.stage = null; state.pendingGate = 'spec'; }
      else skipStage(state, event.stage);
      return;
    }
    case 'stage.started': {
      const attemptId = String(event.attemptId ?? '');
      if (!attemptId || state.attempts.some((a) => a.attemptId === attemptId)) return;
      state.attempts.push({
        attemptId,
        stage: event.stage,
          seedKind: event.seedKind,
          ...(Number.isFinite(event.ts) ? { startedAt: event.ts } : {}),
        ended: false,
        outcome: null,
        summary: null,
        errors: [],
      });
      return;
    }

    case 'stage.ended': {
      const record = endStageAttempt(state, event);
      if (!record) return;
      state.stageRecords.push(record);
      if (state.gate?.attemptId === event.attemptId) {
        if (!state.gateHistory.some((gate) => gate.gateId === state.gate.gateId)) state.gateHistory.push({ ...state.gate });
        if (state.gate.kind !== 'question') state.pendingGate = state.gate.kind;
        state.gate = null;
      }
      if (state.finished || state.status !== 'running') { record.outcome = 'paused'; return; }
      if (event.stage === 'gate') {
        if (state.pendingGate) {
          record.outcome = 'crashed';
          if (consecutiveFailures(state, 'gate') >= 3) { state.pendingGate = null; state.pendingFinish = 'fail'; }
        }
        return;
      }
      // A draft that ends with an `addressed` claim records what it says it
      // fixed, so the final report can flag claims the next review still saw.
      if (event.stage === 'draft') {
        state.draftAddressed = normalizeAddressed(event.addressed);
      }
      advanceAfterStageEnd(state, record);
      return;
    }

    case 'spec.written': {
      state.specPath = event.path;
      return;
    }

    case 'research.started': { state.researchId = event.researchId; return; }
    case 'research.written': {
      state.researchPath = event.path;
      return;
    }

    case 'plan.written': {
      state.involvesUi = event.involvesUi ?? state.involvesUi;
      state.planPath = event.path;
      state.planSha256 = event.sha256 ?? state.planSha256;
      return;
    }

    case 'review.recorded': {
      const round = state.reviews.length + 1;
      const findings = normalizeFindings(event.findings);
      const claimed = new Set(state.draftAddressed?.findingIds ?? []);
      state.disputedClaims = findings.filter((finding) => claimed.has(finding.id)).map((finding) => finding.id);
      state.reviews.push({ round, findings });
      advanceAfterReview(state);
      return;
    }

    case 'gate.opened': {
      if (state.gate) return;
      state.gate = { ...event, status: 'open', verdict: null, errors: [] };
      if (event.gateId) state.gateHistory.push({ ...state.gate });
      state.pendingGate = null;
      return;
    }

    case 'gate.answered': {
      if (state.finished || (event.gateId && state.gate?.gateId !== event.gateId)) return;
      if (event.attemptId && !state.attempts.some((a) => a.attemptId === event.attemptId && !a.ended)) return;
      const historyIndex = event.gateId ? state.gateHistory.findIndex((gate) => gate.gateId === event.gateId) : -1;
      const answered = {
        ...(historyIndex >= 0 ? state.gateHistory[historyIndex] : {}),
        gateId: event.gateId, attemptId: event.attemptId,
        kind: event.kind,
        verdict: event.verdict,
        errors: readErrors(event),
      };
      if (historyIndex >= 0) state.gateHistory[historyIndex] = answered;
      else state.gateHistory.push(answered);
      state.gate = null;
      advanceAfterGateAnswer(state, event.kind, event.verdict);
      return;
    }

    case 'gate.expired': {
      if (state.finished || state.status !== 'running' || (event.gateId && state.gate?.gateId !== event.gateId)) return;
      if (state.gate && state.gate.kind === event.kind) state.gate.status = 'expired';
      state.status = 'stopped';
      state.finished = true;
      state.stopReason = 'gate-expired';
      return;
    }
  }
}

/**
 * Close one stage attempt and return the completed fact, or null when the
 * attempt was already ended (replay is idempotent).
 *
 * @param {import('./types').RunState} state
 * @param {any} event
 * @returns {import('./types').StageRecord | null}
 */
function endStageAttempt(state, event) {
  const stage = String(event.stage ?? '');
  const attemptId = String(event.attemptId ?? '');
  let attempt = state.attempts.find((a) => a.attemptId === attemptId);
  if (!attempt) {
    attempt = { attemptId, stage, ended: false, outcome: null, summary: null, errors: [] };
    state.attempts.push(attempt);
  }
  if (attempt.ended) return null;
  attempt.ended = true;
  if (Number.isFinite(event.ts)) attempt.finishedAt = event.ts;
  attempt.outcome = event.outcome;
  attempt.summary = typeof event.summary === 'string' ? event.summary : null;
  attempt.errors = readErrors(event);
  return { stage, outcome: event.outcome, summary: attempt.summary, errors: attempt.errors, atMs: event.ts, ...(event.seq ? { seq: event.seq } : {}) };
}

/**
 * Advance the pipeline machine after a completed stage fact.
 * @param {import('./types').RunState} state
 * @param {import('./types').StageRecord} record
 * @returns {void}
 */
function advanceAfterStageEnd(state, record) {
  if (record.outcome === 'ok') {
    switch (record.stage) {
      case 'interview':
        state.stage = null;
        state.pendingGate = 'spec';
        state.interviewSeed = null;
        return;
      case 'spec':
        state.stage = null;
        state.pendingGate = 'spec';
        return;
      case 'research':
        state.stage = 'draft';
        return;
      case 'draft': {
        state.draftSeed = null;
        const next = stageAfterDraftOk(state);
        if (next) {
          state.stage = next;
        } else {
          state.stage = null;
          state.pendingGate = 'accept';
        }
        return;
      }
      case 'review':
        // The round's findings drive the machine via review.recorded.
        return;
      case 'polish':
        state.stage = null;
        state.pendingGate = 'accept';
        return;
    }
  }

  const action = decide({
    stage: record.stage,
    outcome: record.outcome,
    attemptCount: consecutiveFailures(state, record.stage),
  });

  if (action.kind === 'retry') {
    // A draft rejected by the accept gate retries with the errors in the seed
    // (policy `retry('errors')`); every other retry re-runs the same stage.
    if (record.stage === 'draft' && action.seedKind === 'errors') {
      state.draftSeed = 'errors';
    }
    return; // same stage again
  }
  if (action.kind === 'skip') {
    skipStage(state, record.stage);
    return;
  }
  if (action.kind === 'fail') {
    state.stage = null;
    state.pendingFinish = 'fail';
    return;
  }
  if (action.kind === 'stop') {
    state.status = 'stopped';
    state.finished = true;
    state.stopReason = 'gate-expired';
  }
}

/**
 * What comes after a successful draft: another review round while the loop is
 * under its cap, otherwise polish (or the accept gate when polish is off).
 * @param {import('./types').RunState} state
 * @returns {import('./types').StageId | null}
 */
function stageAfterDraftOk(state) {
  const rounds = state.reviews.length;
  if (rounds >= state.config.reviewRounds && rounds > 0) state.reviewExitReason = 'round-cap';
  if (state.config.reviewRounds > 0 && rounds < state.config.reviewRounds) return 'review';
  return polishEnabled(state) ? 'polish' : null;
}

/**
 * Advance as if the stage had succeeded, without its artifact.
 * @param {import('./types').RunState} state
 * @param {import('./types').StageId} stage
 * @returns {void}
 */
function skipStage(state, stage) {
  if (stage === 'research') {
    state.stage = 'draft';
    return;
  }
  if (stage === 'review' || stage === 'polish') {
    state.stage = null;
    state.pendingGate = 'accept';
    return;
  }
  // interview/spec/draft never skip; treat as a failure so the run stops.
  state.stage = null;
  state.pendingFinish = 'fail';
}

// ── Review iterate-loop ──────────────────────────────────────────────────────

/**
 * Advance after a review round was recorded.
 *
 * The draft/review iterate-loop reads `open` (the latest round's findings)
 * filtered by severity, and exits on any of: zero blocking findings, the
 * round cap, or no progress (the consecutive `open` id-sets are equal).
 *
 * @param {import('./types').RunState} state
 * @returns {void}
 */
function advanceAfterReview(state) {
  const latest = state.reviews[state.reviews.length - 1];
  const latestBlocking = blockingFindingIds(latest);

  if (latestBlocking.length === 0) {
    concludeReviewLoop(state); // zero blocking findings
    return;
  }

  const previous = state.reviews.length >= 2 ? state.reviews[state.reviews.length - 2] : null;
  if (previous && sameIdSet(findingIdsOf(previous), findingIdsOf(latest))) {
    state.reviewExitReason = 'no-progress';
    concludeReviewLoop(state); // no-progress: the open id-set repeated itself
    return;
  }

  state.stage = 'draft';
  state.draftSeed = 'findings';
}

/**
 * Close the review loop: the draft is ready for polish (or the accept gate).
 * @param {import('./types').RunState} state
 * @returns {void}
 */
function concludeReviewLoop(state) {
  state.stage = polishEnabled(state) ? 'polish' : null;
  if (state.stage === null) state.pendingGate = 'accept';
}

// ── Gates ────────────────────────────────────────────────────────────────────

/**
 * @param {import('./types').RunState} state
 * @param {import('./types').GateKind} kind
 * @param {import('./types').GateVerdict} verdict
 * @returns {void}
 */
function advanceAfterGateAnswer(state, kind, verdict) {
  if (kind === 'spec') {
    if (verdict === 'confirm') {
      state.stage = researchEnabled(state) ? 'research' : 'draft';
    } else if (verdict === 'revise') {
      state.stage = 'interview';
      state.interviewSeed = 'revise';
    }
    return;
  }

  if (kind === 'accept') {
    if (verdict === 'accept') {
      state.stage = null;
      state.pendingFinish = 'pass';
    } else if (verdict === 'reject') {
      const rejections = acceptGateRejections(state);
      const action = decide({ stage: 'draft', outcome: 'rejected', attemptCount: rejections });
      if (action.kind === 'retry') {
        state.stage = 'draft';
        state.draftSeed = 'errors';
      } else {
        state.stage = null;
        state.pendingFinish = 'fail';
      }
    }
  }
}

// ── Finding ids ──────────────────────────────────────────────────────────────

/**
 * Hand-rolled FNV-1a 32-bit hash. The Node crypto module is banned by the
 * W2-A purity guard, so the finding id is computed with this instead. Returns
 * a lowercase hex string so ids stay short and deterministic across rounds
 * and replays.
 *
 * @param {string} input
 * @returns {string}
 */
export function fnv1a(input) {
  const text = String(input ?? '');
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

/**
 * Collapse a finding title to its id-relevant form: trim, lower-case, and
 * squeeze internal whitespace so minor wording drift does not churn the id.
 * @param {unknown} title
 * @returns {string}
 */
function normalizeTitle(title) {
  return String(title ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/**
 * Purely-computed finding id: `fnv1a(normalize(title) + '|' + sortedPaths.join(','))`.
 * The id is derived, never journaled, so the same finding text in two rounds
 * yields the same id and a changed title yields a different one.
 *
 * @param {string} title
 * @param {readonly unknown[]} [paths]
 * @returns {string}
 */
export function findingId(title, paths = []) {
  const sortedPaths = (Array.isArray(paths) ? paths : [])
    .map((p) => String(p).trim())
    .filter((p) => p.length > 0)
    .sort();
  return fnv1a(`${normalizeTitle(title)}|${sortedPaths.join(',')}`);
}

/**
 * Normalise the raw severities the structured-outcome schema can carry
 * (`blocker` / `warn` / `info`) onto the fold's two-way vocabulary.
 * @param {unknown} severity
 * @returns {import('./types').FindingSeverity}
 */
function normalizeSeverity(severity) {
  return severity === 'blocking' || severity === 'blocker' ? 'blocking' : 'info';
}

// ── Findings ─────────────────────────────────────────────────────────────────

/**
 * Normalise one review round's raw findings into the derived shape
 * (`title/detail/severity/paths`). The id is always computed from the title
 * and paths — an incoming `id` is deliberately ignored.
 * @param {unknown} raw
 * @returns {import('./types').ReviewFinding[]}
 */
export function normalizeFindings(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((f) => {
    const rec = /** @type {any} */ (f);
    const title = typeof rec?.title === 'string' ? rec.title : '';
    const detail = typeof rec?.detail === 'string' ? rec.detail : '';
    const paths = Array.isArray(rec?.paths)
      ? rec.paths
          .filter((p) => typeof p === 'string' && p.trim().length > 0)
          .map((p) => p.trim())
      : [];
    return {
      id: findingId(title, paths),
      severity: normalizeSeverity(rec?.severity),
      title,
      detail,
      paths,
    };
  });
}

/**
 * The finding ids of one review round, in round order.
 * @param {import('./types').ReviewRound | null | undefined} round
 * @returns {string[]}
 */
function findingIdsOf(round) {
  if (!round || !Array.isArray(round.findings)) return [];
  return round.findings
    .map((f) => String(f?.id ?? ''))
    .filter((id) => id.length > 0);
}

/**
 * Are two id lists the same set? Order-insensitive and duplicate-insensitive.
 * @param {readonly string[]} a
 * @param {readonly string[]} b
 * @returns {boolean}
 */
function sameIdSet(a, b) {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size !== setB.size) return false;
  for (const id of setB) {
    if (!setA.has(id)) return false;
  }
  return true;
}

/**
 * Ids of the blocking findings in one review round.
 * @param {import('./types').ReviewRound} round
 * @returns {string[]}
 */
export function blockingFindingIds(round) {
  if (!round || !Array.isArray(round.findings)) return [];
  return round.findings.filter((f) => f.severity === 'blocking').map((f) => f.id);
}

/**
 * Finding ids still open after the latest review round.
 *
 * `open = lastReview.findings` — every finding the latest round saw, before
 * severity filtering.
 *
 * @param {import('./types').RunState} state
 * @returns {string[]}
 */
export function openFindingIds(state) {
  const latest =
    state && Array.isArray(state.reviews) ? state.reviews[state.reviews.length - 1] : null;
  return findingIdsOf(latest);
}

/**
 * Finding ids resolved by the latest review round.
 *
 * `resolved = union(previousRounds) − open` — every id seen in any earlier
 * round that the latest round no longer sees. There is deliberately no stored
 * counter.
 *
 * @param {import('./types').RunState} state
 * @returns {string[]}
 */
export function resolvedFindingIds(state) {
  if (!state || !Array.isArray(state.reviews) || state.reviews.length === 0) return [];
  const open = new Set(openFindingIds(state));
  /** @type {string[]} */
  const seen = [];
  const seenSet = new Set();
  for (let i = 0; i < state.reviews.length - 1; i += 1) {
    for (const id of findingIdsOf(state.reviews[i])) {
      if (!seenSet.has(id)) {
        seenSet.add(id);
        seen.push(id);
      }
    }
  }
  return seen.filter((id) => !open.has(id));
}

/**
 * Open/blocking/resolved summary for the latest review round.
 *
 * `blocking` is `open` filtered by severity (only the latest round's blocking
 * findings); `resolved` is the union of previous rounds minus `open`.
 *
 * @param {import('./types').RunState} state
 * @returns {{ blocking: string[], resolved: string[] }}
 */
export function currentFindings(state) {
  if (!state || state.reviews.length === 0) return { blocking: [], resolved: [] };
  const latest = state.reviews[state.reviews.length - 1];
  return { blocking: blockingFindingIds(latest), resolved: resolvedFindingIds(state) };
}

/**
 * Normalise a draft's `addressed` claim (`findingIds` + `dispositions`) so the
 * final report can flag where a draft claimed a fix the next review still saw.
 * @param {unknown} raw
 * @returns {import('./types').DraftAddressedClaim | null}
 */
export function normalizeAddressed(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const rec = /** @type {Record<string, unknown>} */ (raw);

  const findingIds = Array.isArray(rec.findingIds)
    ? [
        ...new Set(
          rec.findingIds
            .filter((id) => typeof id === 'string' && id.trim().length > 0)
            .map((id) => String(id).trim()),
        ),
      ]
    : [];
  /** @type {Record<string, string>} */
  const dispositions = {};
  if (
    rec.dispositions &&
    typeof rec.dispositions === 'object' &&
    !Array.isArray(rec.dispositions)
  ) {
    for (const [id, value] of Object.entries(
      /** @type {Record<string, unknown>} */ (rec.dispositions),
    )) {
      if (typeof value === 'string' && value.trim().length > 0) dispositions[id] = value.trim();
    }
  }
  if (findingIds.length === 0 && Object.keys(dispositions).length === 0) return null;
  return { findingIds, dispositions };
}

// ── Derived helpers ──────────────────────────────────────────────────────────

/**
 * @param {import('./types').RunState} state
 * @param {import('./types').StageId} stage
 * @returns {number}
 */
export function stageCount(state, stage) {
  if (!state) return 0;
  let n = 0;
  for (const record of state.stageRecords) {
    if (record.stage === stage) n += 1;
  }
  return n;
}

/**
 * The most recent ended stage fact for a stage, or undefined.
 * @param {import('./types').RunState} state
 * @param {import('./types').StageId} stage
 * @returns {import('./types').StageRecord | undefined}
 */
export function lastEndedStage(state, stage) {
  if (!state) return undefined;
  for (let i = state.stageRecords.length - 1; i >= 0; i -= 1) {
    const record = state.stageRecords[i];
    if (record.stage === stage) return record;
  }
  return undefined;
}

/**
 * @param {import('./types').RunState} state
 * @returns {number}
 */
export function acceptGateRejections(state) {
  if (!state) return 0;
  let n = 0;
  for (const entry of state.gateHistory) {
    if (entry.kind === 'accept' && entry.verdict === 'reject') n += 1;
  }
  return n;
}

/**
 * @param {import('./types').RunState} state
 * @returns {boolean}
 */
export function isStopped(state) {
  return !state || state.finished || state.status === 'stopped';
}

// ── Config helpers ───────────────────────────────────────────────────────────

/**
 * @param {unknown} raw
 * @returns {import('./types').RunConfig}
 */
function readConfig(raw) {
  const base = { ...DEFAULT_CONFIG };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base;
  const rec = /** @type {Record<string, unknown>} */ (raw);
  for (const key of ['plannerModel', 'reviewerModel', 'researchModel']) {
    const model = rec[key];
    if (model && typeof model === 'object' && typeof model.providerId === 'string' && typeof model.modelId === 'string') base[key] = { providerId: model.providerId, modelId: model.modelId };
  }
  for (const key of ['reviewTimeoutMs', 'grillQuestionBudget', 'researchMaxRounds']) {
    if (Number.isSafeInteger(rec[key]) && rec[key] >= 0) base[key] = Math.min(rec[key], key === 'reviewTimeoutMs' ? 7200000 : 40);
  }
  if (['quick', 'standard', 'deep', 'auto'].includes(rec.researchDepth)) base.researchDepth = rec.researchDepth;
  if (['web', 'codebase', 'both'].includes(rec.researchScope)) base.researchScope = rec.researchScope;
  if (Number.isSafeInteger(rec.reviewRounds)) {
    base.reviewRounds = Math.min(10, Math.max(0, /** @type {number} */ (rec.reviewRounds)));
  }
  if (typeof rec.research === 'boolean') base.research = rec.research;
  if (typeof rec.interview === 'boolean') base.interview = rec.interview;
  if (rec.polish === 'auto' || rec.polish === 'always' || rec.polish === 'never') {
    base.polish = rec.polish;
  }
  return base;
}

/**
 * @param {import('./types').RunState} state
 * @returns {boolean}
 */
function researchEnabled(state) {
  return state.config.research !== false;
}

/**
 * @param {import('./types').RunState} state
 * @returns {boolean}
 */
export function polishEnabled(state) {
  return state.config.polish === 'always' || (state.config.polish === 'auto' && (state.involvesUi === true || /\b(ui|ux|frontend|css|layout|dashboard|screen|component|interface|impeccable)\b/i.test(state.prompt)));
}

/**
 * @param {import('./types').RunOutcome} outcome
 * @returns {import('./types').StopReason}
 */
function stopReasonForOutcome(outcome) {
  if (outcome === 'pass') return 'complete';
  if (outcome === 'fail') return 'failed';
  return 'skipped';
}

/**
 * @param {any} event
 * @returns {string[]}
 */
function readErrors(event) {
  return Array.isArray(event?.errors) ? event.errors.map(String) : [];
}
function consecutiveFailures(state, stage) {
  let count = 0;
  for (const record of state.stageRecords.slice(state.retryEpochIndex ?? 0).reverse()) {
    if (record.stage !== stage) continue;
    if (record.outcome === 'ok') break;
    if (record.outcome === 'paused') continue;
    count++;
  }
  return count;
}

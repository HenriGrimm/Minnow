/** Fold Super Plan journal events into run state. Pure: no I/O, no clock, no randomness. */

import { OPTIONAL_STAGES, STAGES, validateEvent } from './events.js';
import { decide } from './policy.js';

/** Journals written by this engine carry `engine: 3` on `run.created`. */
export const ENGINE_VERSION = 3;

/** Pipeline defaults when run.created omits config. */
export const DEFAULT_CONFIG = Object.freeze({
  interview: true,
  questionBudget: 20,
  research: true,
  researchScope: 'both',
  researchDepth: 'auto',
  researchMaxRounds: 0,
  reviewRounds: 2,
  reviewTimeoutMs: 20 * 60 * 1000,
  polish: 'auto',
  granularity: 'medium',
});

/** Consecutive failures a stage gets before it is skipped (optional) or halts the run. */
export const MAX_STAGE_FAILURES = 3;

// ── Empty state ──────────────────────────────────────────────────────────────

/**
 * The state of a run with no journal at all.
 * @returns {import('./types').RunState}
 */
export function emptyState() {
  return {
    runId: '',
    prompt: '',
    workspacePath: null,
    chatId: null,
    config: { ...DEFAULT_CONFIG },
    engine: 0,
    legacy: false,
    createdAt: null,
    updatedAt: null,
    lastSeq: 0,
    title: '',
    userTitled: false,
    slug: '',
    slugFinal: false,
    status: 'created',
    finished: false,
    stopReason: null,
    runOutcome: null,
    epoch: 0,
    step: null,
    iterations: {},
    attempts: [],
    stageRecords: [],
    failureFrom: {},
    halted: null,
    skipped: [],
    questions: [],
    questionsClosed: false,
    checkpoints: [],
    feedback: { spec: null, plan: null },
    artifacts: { spec: null, research: null, plan: null },
    specPath: null,
    researchPath: null,
    planPath: null,
    researchId: null,
    researchSettled: false,
    reviews: [],
    reviewCycle: 1,
    reviewCycleKind: 'full',
    reviewExit: null,
    polishedCycle: 0,
    draftAddressed: null,
    disputedClaims: [],
    involvesUi: undefined,
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
    const event = /** @type {any} */ (checked.event);
    if (Number.isFinite(event.ts)) state.updatedAt = event.ts;
    if (Number.isSafeInteger(event.seq) && event.seq > state.lastSeq) state.lastSeq = event.seq;
    if (state.legacy) applyLegacy(state, event);
    else apply(state, event);
  }
  return state;
}

/**
 * Fold a journal into run state.
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
 */
function apply(state, event) {
  switch (event.type) {
    case 'run.created': {
      state.runId = event.runId;
      state.prompt = event.prompt;
      state.createdAt = Number.isFinite(event.ts) ? event.ts : null;
      if (typeof event.workspacePath === 'string' && event.workspacePath.trim()) {
        state.workspacePath = event.workspacePath.trim();
      }
      state.chatId = typeof event.chatId === 'string' && event.chatId ? event.chatId : null;
      state.config = readConfig(event.config);
      state.engine = Number.isSafeInteger(event.config?.engine) ? event.config.engine : 0;
      state.slug = event.runId;
      state.title = typeof event.title === 'string' && event.title.trim() ? event.title.trim() : '';
      if (state.engine < ENGINE_VERSION) {
        // A v2 journal. It folds for reading, but its stages cannot continue.
        state.legacy = true;
        state.step = null;
        return;
      }
      enterStage(state, 'interview', 'initial', event.ts);
      return;
    }

    case 'run.started': {
      if (state.finished) return;
      state.status = 'running';
      state.stopReason = null;
      return;
    }

    case 'run.paused':
      pause(state);
      return;

    case 'run.stopped': {
      if (event.reason === 'paused') pause(state);
      else finish(state, 'failed', 'fail');
      return;
    }

    case 'run.resumed': {
      // Only a paused or halted run resumes. A stray resume on a running run
      // must not bump the epoch, which would restart the live attempt.
      if (state.finished || state.status !== 'stopped') return;
      if (state.halted && state.step?.kind === 'stage') {
        // A retry after the failure budget ran out gets a fresh budget.
        state.failureFrom[state.step.stage] = state.stageRecords.length;
      }
      state.halted = null;
      state.status = 'running';
      state.stopReason = null;
      state.epoch += 1;
      return;
    }

    case 'run.cancelled': {
      if (state.finished) return;
      endLiveAttempts(state, 'cancelled', event.ts);
      for (const question of state.questions) {
        if (question.status === 'open') question.status = 'cancelled';
      }
      finish(state, 'cancelled', 'cancelled');
      return;
    }

    case 'run.finished': {
      if (state.finished) return;
      endLiveAttempts(state, 'cancelled', event.ts);
      finish(state, event.outcome === 'pass' ? 'complete' : 'failed', event.outcome === 'pass' ? 'pass' : 'fail');
      return;
    }

    case 'slug.assigned': {
      state.slug = event.slug;
      state.slugFinal = true;
      const title = typeof event.title === 'string' ? event.title : event.displayTitle;
      if (typeof title === 'string' && title.trim() && !state.userTitled) state.title = title.trim();
      return;
    }

    case 'run.renamed': {
      if (typeof event.title === 'string' && event.title.trim()) {
        state.title = event.title.trim();
        state.userTitled = true;
      }
      return;
    }

    case 'stage.started': {
      const attemptId = String(event.attemptId);
      if (state.attempts.some((a) => a.attemptId === attemptId)) return;
      const step = state.step?.kind === 'stage' && state.step.stage === event.stage ? state.step : null;
      const iteration = Number.isSafeInteger(event.iteration) ? event.iteration : step?.iteration ?? 1;
      state.attempts.push({
        attemptId,
        stage: event.stage,
        seedKind: typeof event.seedKind === 'string' ? event.seedKind : step?.seedKind ?? 'initial',
        iteration,
        transcriptKey:
          typeof event.transcriptKey === 'string' && event.transcriptKey
            ? event.transcriptKey
            : `${event.stage}-${iteration}`,
        ...(Number.isFinite(event.ts) ? { startedAt: event.ts } : {}),
        ended: false,
        outcome: null,
        summary: null,
        errors: [],
      });
      return;
    }

    case 'stage.ended': {
      const record = endAttempt(state, event);
      if (!record) return;
      if (state.finished || state.status !== 'running') {
        // Work that ends while the run is paused or stopped is not a failure.
        record.outcome = 'paused';
        return;
      }
      if (state.step?.kind !== 'stage' || state.step.stage !== record.stage) return;
      if (record.outcome === 'ok') {
        if (record.stage === 'draft') state.draftAddressed = normalizeAddressed(event.addressed);
        advanceAfterOk(state, record, event.ts);
        return;
      }
      handleFailure(state, record, event.ts);
      return;
    }

    case 'stage.skipped': {
      if (state.finished) return;
      if (state.step?.kind !== 'stage' || state.step.stage !== event.stage) return;
      if (!OPTIONAL_STAGES.includes(event.stage)) return;
      endLiveAttempts(state, 'superseded', event.ts);
      state.epoch += 1;
      state.halted = null;
      if (state.stopReason === 'halted') {
        state.status = 'running';
        state.stopReason = null;
      }
      skipStage(state, event.stage, typeof event.reason === 'string' ? event.reason : 'user', event.ts);
      return;
    }

    case 'stage.reopened': {
      if (!STAGES.includes(event.stage)) return;
      if (state.finished && state.stopReason !== 'complete') return;
      endLiveAttempts(state, 'superseded', event.ts);
      reopenRun(state);
      state.epoch += 1;
      reopenStage(state, event.stage, event.ts);
      return;
    }

    case 'artifact.written':
      recordArtifact(state, event.kind, event);
      return;
    case 'spec.written':
      recordArtifact(state, 'spec', event);
      return;
    case 'research.written':
      recordArtifact(state, 'research', event);
      return;
    case 'plan.written':
      recordArtifact(state, 'plan', event);
      return;

    case 'research.started':
      state.researchId = event.researchId;
      return;

    case 'review.recorded': {
      const findings = normalizeFindings(event.findings);
      const round = reviewsInCycle(state).length + 1;
      const claimed = new Set(state.draftAddressed?.findingIds ?? []);
      state.disputedClaims = findings
        .filter((finding) => isActionable(finding) && claimed.has(finding.id))
        .map((finding) => finding.id);
      state.reviews.push({
        round,
        cycle: state.reviewCycle,
        attemptId: typeof event.attemptId === 'string' ? event.attemptId : null,
        summary: typeof event.summary === 'string' ? event.summary : '',
        findings,
        ...(Number.isFinite(event.ts) ? { at: event.ts } : {}),
      });
      return;
    }

    case 'question.asked': {
      if (state.questions.some((q) => q.questionId === event.questionId)) return;
      const attempt = state.attempts.find((a) => a.attemptId === event.attemptId);
      state.questions.push({
        questionId: event.questionId,
        attemptId: typeof event.attemptId === 'string' ? event.attemptId : null,
        transcriptKey: attempt?.transcriptKey ?? null,
        title: typeof event.title === 'string' ? event.title : '',
        questions: event.questions,
        status: 'open',
        answer: null,
        ...(Number.isFinite(event.ts) ? { askedAt: event.ts } : {}),
      });
      return;
    }

    case 'question.answered': {
      const question = state.questions.find((q) => q.questionId === event.questionId);
      if (!question || question.status !== 'open') return;
      question.status = event.skipped === true ? 'skipped' : 'answered';
      question.answer = event.answer ?? null;
      if (Number.isFinite(event.ts)) question.answeredAt = event.ts;
      return;
    }

    case 'question.cancelled': {
      const question = state.questions.find((q) => q.questionId === event.questionId);
      if (question?.status === 'open') question.status = 'cancelled';
      return;
    }

    case 'questions.closed': {
      state.questionsClosed = true;
      for (const question of state.questions) {
        if (question.status === 'open') question.status = 'skipped';
      }
      return;
    }

    case 'checkpoint.answered':
      answerCheckpoint(state, event);
      return;
  }
}

// ── Steps ────────────────────────────────────────────────────────────────────

/**
 * Make `stage` the step the engine should run next.
 * @param {import('./types').RunState} state
 * @param {import('./types').StageId} stage
 * @param {import('./types').SeedKind} seedKind
 * @param {number} [at]
 */
function enterStage(state, stage, seedKind, at) {
  const iteration = (state.iterations[stage] ?? 0) + 1;
  state.iterations[stage] = iteration;
  state.step = {
    kind: 'stage',
    stage,
    seedKind,
    iteration,
    recordsFrom: state.stageRecords.length,
    ...(Number.isFinite(at) ? { since: at } : {}),
  };
  state.failureFrom[stage] = state.stageRecords.length;
  if (stage === 'interview') state.questionsClosed = false;
}

/**
 * Wait for the user.
 * @param {import('./types').RunState} state
 * @param {import('./types').CheckpointKind} checkpoint
 * @param {number} [at]
 */
function enterCheckpoint(state, checkpoint, at) {
  state.step = { kind: 'checkpoint', checkpoint, ...(Number.isFinite(at) ? { since: at } : {}) };
}

/**
 * @param {import('./types').RunState} state
 * @param {import('./types').StageRecord} record
 * @param {number} [at]
 */
function advanceAfterOk(state, record, at) {
  switch (record.stage) {
    case 'interview':
      state.feedback.spec = null;
      enterCheckpoint(state, 'spec', at);
      return;
    case 'research':
      state.researchSettled = true;
      enterDraftFromSpec(state, at);
      return;
    case 'draft': {
      const seed = state.step?.kind === 'stage' ? state.step.seedKind : 'initial';
      if (seed === 'feedback') {
        state.feedback.plan = null;
        enterCheckpoint(state, 'accept', at);
        return;
      }
      afterDraftInCycle(state, at);
      return;
    }
    case 'review': {
      const review = state.reviews.find((r) => r.attemptId === record.attemptId);
      if (!review) {
        // An ok review always journals its findings first; without them the
        // round never happened, so it retries like any other rejection.
        record.outcome = 'rejected';
        record.errors = ['The review ended without reporting findings.'];
        const attempt = state.attempts.find((a) => a.attemptId === record.attemptId);
        if (attempt) {
          attempt.outcome = record.outcome;
          attempt.errors = record.errors;
        }
        handleFailure(state, record, at);
        return;
      }
      afterReview(state, review, at);
      return;
    }
    case 'polish':
      state.polishedCycle = state.reviewCycle;
      enterCheckpoint(state, 'accept', at);
      return;
  }
}

/**
 * The spec is settled: research if it is still owed, otherwise (re)draft.
 * @param {import('./types').RunState} state
 * @param {number} [at]
 */
function enterSpecConfirmed(state, at) {
  if (state.config.research && !state.researchSettled) {
    enterStage(state, 'research', 'initial', at);
    return;
  }
  enterDraftFromSpec(state, at);
}

/**
 * @param {import('./types').RunState} state
 * @param {number} [at]
 */
function enterDraftFromSpec(state, at) {
  const hasPlan = Boolean(state.artifacts.plan);
  if (hasPlan) startReviewCycle(state, 'full');
  enterStage(state, 'draft', hasPlan ? 'rework' : 'initial', at);
}

/**
 * @param {import('./types').RunState} state
 * @param {'full' | 'extra'} kind
 */
function startReviewCycle(state, kind) {
  if (state.reviews.some((r) => r.cycle === state.reviewCycle) || state.reviewExit?.cycle === state.reviewCycle) {
    state.reviewCycle += 1;
  }
  state.reviewCycleKind = kind;
  state.reviewExit = null;
  state.draftAddressed = null;
  state.disputedClaims = [];
}

/**
 * How many review rounds the current cycle may run.
 * @param {import('./types').RunState} state
 * @returns {number}
 */
export function reviewCycleLimit(state) {
  if (state.reviewCycleKind === 'extra') return 1;
  return state.config.reviewRounds;
}

/**
 * @param {import('./types').RunState} state
 * @returns {import('./types').ReviewRound[]}
 */
export function reviewsInCycle(state) {
  return state.reviews.filter((r) => r.cycle === state.reviewCycle);
}

/**
 * A draft landed: review it while the cycle has rounds left, otherwise close
 * the cycle.
 * @param {import('./types').RunState} state
 * @param {number} [at]
 */
function afterDraftInCycle(state, at) {
  const limit = reviewCycleLimit(state);
  const rounds = reviewsInCycle(state).length;
  const reviewSkipped = state.reviewExit?.cycle === state.reviewCycle;
  if (limit > 0 && rounds < limit && !reviewSkipped) {
    enterStage(state, 'review', 'initial', at);
    return;
  }
  if (limit > 0 && !reviewSkipped) state.reviewExit = { reason: 'round-cap', cycle: state.reviewCycle };
  finishCycle(state, at);
}

/**
 * @param {import('./types').RunState} state
 * @param {import('./types').ReviewRound} review
 * @param {number} [at]
 */
function afterReview(state, review, at) {
  const actionable = review.findings.filter(isActionable).map((f) => f.id);
  if (actionable.length === 0) {
    state.reviewExit = { reason: 'clean', cycle: state.reviewCycle };
    finishCycle(state, at);
    return;
  }
  const inCycle = reviewsInCycle(state);
  const previous = inCycle.length >= 2 ? inCycle[inCycle.length - 2] : null;
  if (previous && sameIdSet(previous.findings.filter(isActionable).map((f) => f.id), actionable)) {
    state.reviewExit = { reason: 'no-progress', cycle: state.reviewCycle };
    finishCycle(state, at);
    return;
  }
  enterStage(state, 'draft', 'findings', at);
}

/**
 * Review is done for this cycle: polish once if the plan wants it, then accept.
 * @param {import('./types').RunState} state
 * @param {number} [at]
 */
function finishCycle(state, at) {
  if (state.reviewCycleKind === 'full' && polishEnabled(state) && state.polishedCycle < state.reviewCycle) {
    enterStage(state, 'polish', 'initial', at);
    return;
  }
  enterCheckpoint(state, 'accept', at);
}

/**
 * @param {import('./types').RunState} state
 * @param {import('./types').StageRecord} record
 * @param {number} [at]
 */
function handleFailure(state, record, at) {
  const failures = consecutiveFailures(state, record.stage);
  const action = decide({ stage: record.stage, outcome: record.outcome, attemptCount: failures });
  if (action.kind === 'retry') return;
  if (action.kind === 'skip') {
    skipStage(state, record.stage, 'failed', at);
    return;
  }
  state.status = 'stopped';
  state.stopReason = 'halted';
  state.halted = {
    stage: record.stage,
    summary: record.summary,
    errors: record.errors,
    ...(Number.isFinite(at) ? { at } : {}),
  };
}

/**
 * Advance past an optional stage without its result.
 * @param {import('./types').RunState} state
 * @param {import('./types').StageId} stage
 * @param {string} reason
 * @param {number} [at]
 */
function skipStage(state, stage, reason, at) {
  state.skipped.push({ stage, reason, cycle: state.reviewCycle, ...(Number.isFinite(at) ? { at } : {}) });
  if (stage === 'research') {
    state.researchSettled = true;
    enterDraftFromSpec(state, at);
    return;
  }
  if (stage === 'review') {
    state.reviewExit = { reason: reason === 'user' ? 'skipped' : 'failed', cycle: state.reviewCycle };
    finishCycle(state, at);
    return;
  }
  if (stage === 'polish') {
    state.polishedCycle = state.reviewCycle;
    enterCheckpoint(state, 'accept', at);
  }
}

/**
 * Rework from an earlier stage.
 * @param {import('./types').RunState} state
 * @param {import('./types').StageId} stage
 * @param {number} [at]
 */
function reopenStage(state, stage, at) {
  switch (stage) {
    case 'interview':
      enterStage(state, 'interview', 'rework', at);
      return;
    case 'research':
      state.researchSettled = false;
      enterStage(state, 'research', 'initial', at);
      return;
    case 'draft':
      startReviewCycle(state, 'full');
      enterStage(state, 'draft', state.artifacts.plan ? 'rework' : 'initial', at);
      return;
    case 'review':
      startReviewCycle(state, 'extra');
      enterStage(state, 'review', 'initial', at);
      return;
    case 'polish':
      enterStage(state, 'polish', 'initial', at);
      return;
  }
}

/**
 * @param {import('./types').RunState} state
 * @param {any} event
 */
function answerCheckpoint(state, event) {
  const checkpoint = event.checkpoint;
  const verdict = event.verdict;
  const feedback = typeof event.feedback === 'string' && event.feedback.trim() ? event.feedback.trim() : null;
  const atCheckpoint = state.step?.kind === 'checkpoint' && state.step.checkpoint === checkpoint;
  const acceptedRun = state.finished && state.stopReason === 'complete';

  if (checkpoint === 'spec') {
    if (!atCheckpoint || state.finished) return;
    if (verdict !== 'confirm' && verdict !== 'revise') return;
    // Answering is an explicit "carry on", so it also lifts a pause.
    reopenRun(state);
    if (verdict === 'confirm') {
      state.checkpoints.push(checkpointRecord('spec', verdict, feedback, event.ts));
      enterSpecConfirmed(state, event.ts);
    } else if (verdict === 'revise') {
      state.checkpoints.push(checkpointRecord('spec', verdict, feedback, event.ts));
      state.feedback.spec = feedback;
      enterStage(state, 'interview', 'revise', event.ts);
    }
    return;
  }

  if (checkpoint !== 'accept') return;
  if (!atCheckpoint && !(acceptedRun && verdict !== 'accept')) return;
  if (verdict === 'accept') {
    state.checkpoints.push(checkpointRecord('accept', verdict, feedback, event.ts));
    finish(state, 'complete', 'pass');
    return;
  }
  if (verdict !== 'revise' && verdict !== 'review') return;
  state.checkpoints.push(checkpointRecord('accept', verdict, feedback, event.ts));
  reopenRun(state);
  if (verdict === 'revise') {
    state.feedback.plan = feedback;
    enterStage(state, 'draft', 'feedback', event.ts);
  } else {
    startReviewCycle(state, 'extra');
    enterStage(state, 'review', 'initial', event.ts);
  }
}

/**
 * @param {string} checkpoint
 * @param {string} verdict
 * @param {string | null} feedback
 * @param {number} [at]
 */
function checkpointRecord(checkpoint, verdict, feedback, at) {
  return { checkpoint, verdict, feedback, ...(Number.isFinite(at) ? { at } : {}) };
}

/**
 * An accepted run can be picked up again; nothing else un-finishes.
 * @param {import('./types').RunState} state
 */
function reopenRun(state) {
  if (state.finished && state.stopReason !== 'complete') return;
  state.finished = false;
  state.runOutcome = null;
  state.halted = null;
  state.status = 'running';
  state.stopReason = null;
}

/**
 * @param {import('./types').RunState} state
 */
function pause(state) {
  if (state.finished || state.status !== 'running') return;
  endLiveAttempts(state, 'paused');
  state.status = 'stopped';
  state.stopReason = 'paused';
}

/**
 * @param {import('./types').RunState} state
 * @param {import('./types').StopReason} reason
 * @param {import('./types').RunOutcome} outcome
 */
function finish(state, reason, outcome) {
  state.status = 'stopped';
  state.finished = true;
  state.stopReason = reason;
  state.runOutcome = outcome;
  state.halted = null;
  if (reason !== 'complete') state.step = state.step?.kind === 'stage' ? state.step : null;
  else state.step = null;
}

// ── Attempts ─────────────────────────────────────────────────────────────────

/**
 * Close one attempt and return the completed fact, or null when it had
 * already ended (replay is idempotent and late ends are ignored).
 * @param {import('./types').RunState} state
 * @param {any} event
 * @returns {import('./types').StageRecord | null}
 */
function endAttempt(state, event) {
  const attemptId = String(event.attemptId);
  let attempt = state.attempts.find((a) => a.attemptId === attemptId);
  if (!attempt) {
    attempt = {
      attemptId,
      stage: event.stage,
      seedKind: 'initial',
      iteration: state.iterations[event.stage] ?? 1,
      transcriptKey: `${event.stage}-${state.iterations[event.stage] ?? 1}`,
      ended: false,
      outcome: null,
      summary: null,
      errors: [],
    };
    state.attempts.push(attempt);
  }
  if (attempt.ended) return null;
  attempt.ended = true;
  attempt.outcome = normalizeOutcome(event.outcome);
  attempt.summary = typeof event.summary === 'string' ? event.summary : null;
  attempt.errors = Array.isArray(event.errors) ? event.errors.map(String) : [];
  if (Number.isFinite(event.ts)) attempt.endedAt = event.ts;
  /** @type {import('./types').StageRecord} */
  const record = {
    attemptId,
    stage: attempt.stage,
    outcome: attempt.outcome,
    summary: attempt.summary,
    errors: attempt.errors,
    ...(Number.isFinite(event.ts) ? { at: event.ts } : {}),
  };
  state.stageRecords.push(record);
  return record;
}

/**
 * The fold, not the effector, decides that an attempt is over when the user
 * intervenes. The engine then stops the effector's copy because the plan no
 * longer names it, and any late end for it is ignored here.
 * @param {import('./types').RunState} state
 * @param {'paused' | 'cancelled' | 'superseded'} outcome
 * @param {number} [at]
 */
function endLiveAttempts(state, outcome, at) {
  for (const attempt of state.attempts) {
    if (attempt.ended) continue;
    attempt.ended = true;
    attempt.outcome = outcome;
    if (Number.isFinite(at)) attempt.endedAt = at;
    state.stageRecords.push({
      attemptId: attempt.attemptId,
      stage: attempt.stage,
      outcome,
      summary: null,
      errors: [],
      ...(Number.isFinite(at) ? { at } : {}),
    });
  }
}

/**
 * @param {unknown} outcome
 * @returns {import('./types').StageOutcome}
 */
function normalizeOutcome(outcome) {
  if (outcome === 'ok' || outcome === 'pass') return 'ok';
  if (outcome === 'crashed' || outcome === 'timeout' || outcome === 'rejected') return outcome;
  if (outcome === 'paused' || outcome === 'cancelled' || outcome === 'superseded' || outcome === 'interrupted') return outcome;
  return 'rejected';
}

/**
 * Failures of `stage` since its failure budget last reset. Pauses do not count.
 * @param {import('./types').RunState} state
 * @param {import('./types').StageId} stage
 * @returns {number}
 */
export function consecutiveFailures(state, stage) {
  let count = 0;
  const from = state.failureFrom[stage] ?? 0;
  for (let i = state.stageRecords.length - 1; i >= from; i -= 1) {
    const record = state.stageRecords[i];
    if (record.stage !== stage) continue;
    if (record.outcome === 'ok') break;
    if (record.outcome === 'crashed' || record.outcome === 'timeout' || record.outcome === 'rejected') count += 1;
  }
  return count;
}

// ── Artifacts ────────────────────────────────────────────────────────────────

/**
 * @param {import('./types').RunState} state
 * @param {import('./types').ArtifactKind} kind
 * @param {any} event
 */
function recordArtifact(state, kind, event) {
  const artifact = {
    path: event.path,
    ...(typeof event.sha256 === 'string' ? { sha256: event.sha256 } : {}),
    ...(typeof event.attemptId === 'string' ? { attemptId: event.attemptId } : {}),
    ...(typeof event.title === 'string' && event.title.trim() ? { title: event.title.trim() } : {}),
    ...(event.empty === true ? { empty: true } : {}),
    ...(Number.isSafeInteger(event.bytes) ? { bytes: event.bytes } : {}),
    ...(typeof event.executable === 'boolean' ? { executable: event.executable } : {}),
    ...(Number.isSafeInteger(event.tasks) ? { tasks: event.tasks } : {}),
    ...(Number.isFinite(event.ts) ? { at: event.ts } : {}),
  };
  state.artifacts[kind] = artifact;
  if (kind === 'spec') state.specPath = event.path;
  if (kind === 'research') state.researchPath = event.path;
  if (kind === 'plan') state.planPath = event.path;
  if ((kind === 'plan' || kind === 'spec') && typeof event.involvesUi === 'boolean') {
    state.involvesUi = kind === 'plan' ? event.involvesUi : state.involvesUi || event.involvesUi;
  }
}

// ── Findings ─────────────────────────────────────────────────────────────────

/**
 * Hand-rolled FNV-1a 32-bit hash: the pure core may not import a crypto module.
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
 * Id for a finding the reviewer did not name: its title and paths, normalised.
 * @param {string} title
 * @param {readonly unknown[]} [paths]
 * @returns {string}
 */
export function findingId(title, paths = []) {
  const sortedPaths = (Array.isArray(paths) ? paths : [])
    .map((p) => String(p).trim())
    .filter((p) => p.length > 0)
    .sort();
  const normalized = String(title ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  return `f${fnv1a(`${normalized}|${sortedPaths.join(',')}`)}`;
}

/**
 * @param {unknown} severity
 * @returns {import('./types').FindingSeverity}
 */
export function normalizeSeverity(severity) {
  const value = typeof severity === 'string' ? severity.trim().toLowerCase() : '';
  if (value === 'blocker' || value === 'blocking' || value === 'critical' || value === 'high') return 'blocker';
  if (value === 'warn' || value === 'warning' || value === 'major' || value === 'medium') return 'warn';
  return 'info';
}

/**
 * Normalise one review round's raw findings. A reviewer that re-reports a
 * prior finding keeps its id; anything else gets a derived one.
 * @param {unknown} raw
 * @returns {import('./types').ReviewFinding[]}
 */
export function normalizeFindings(raw) {
  if (!Array.isArray(raw)) return [];
  /** @type {import('./types').ReviewFinding[]} */
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const rec = /** @type {Record<string, unknown>} */ (item);
    const title = typeof rec.title === 'string' ? rec.title.trim() : '';
    if (!title) continue;
    const paths = Array.isArray(rec.paths)
      ? rec.paths.filter((p) => typeof p === 'string' && p.trim()).map((p) => String(p).trim())
      : [];
    const given = typeof rec.id === 'string' && /^[A-Za-z0-9._:-]{1,64}$/.test(rec.id.trim()) ? rec.id.trim() : '';
    let id = given || findingId(title, paths);
    if (seen.has(id)) id = `${id}-${out.length + 1}`;
    seen.add(id);
    out.push({
      id,
      severity: normalizeSeverity(rec.severity),
      title,
      detail: typeof rec.detail === 'string' ? rec.detail.trim() : '',
      ...(typeof rec.fix === 'string' && rec.fix.trim() ? { fix: rec.fix.trim() } : {}),
      paths,
    });
  }
  return out;
}

/**
 * Blockers and warnings drive another revision; notes do not.
 * @param {import('./types').ReviewFinding} finding
 * @returns {boolean}
 */
export function isActionable(finding) {
  return finding.severity === 'blocker' || finding.severity === 'warn';
}

/**
 * @param {readonly string[]} a
 * @param {readonly string[]} b
 * @returns {boolean}
 */
function sameIdSet(a, b) {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size !== setB.size) return false;
  for (const id of setB) if (!setA.has(id)) return false;
  return true;
}

/**
 * Findings of the latest round in the current cycle, and ids earlier rounds
 * saw that the latest no longer does.
 * @param {import('./types').RunState} state
 * @returns {{ open: import('./types').ReviewFinding[], resolved: string[] }}
 */
export function currentFindings(state) {
  const rounds = reviewsInCycle(state);
  const latest = rounds[rounds.length - 1];
  if (!latest) return { open: [], resolved: [] };
  const open = new Set(latest.findings.map((f) => f.id));
  const resolved = [];
  for (const round of rounds.slice(0, -1)) {
    for (const finding of round.findings) {
      if (!open.has(finding.id) && !resolved.includes(finding.id)) resolved.push(finding.id);
    }
  }
  return { open: latest.findings, resolved };
}

/**
 * A draft's claim about the findings it fixed.
 * @param {unknown} raw
 * @returns {import('./types').DraftAddressedClaim | null}
 */
export function normalizeAddressed(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const rec = /** @type {Record<string, unknown>} */ (raw);
  const findingIds = Array.isArray(rec.findingIds)
    ? [...new Set(rec.findingIds.filter((id) => typeof id === 'string' && id.trim()).map((id) => String(id).trim()))]
    : [];
  /** @type {Record<string, string>} */
  const dispositions = {};
  if (rec.dispositions && typeof rec.dispositions === 'object' && !Array.isArray(rec.dispositions)) {
    for (const [id, value] of Object.entries(/** @type {Record<string, unknown>} */ (rec.dispositions))) {
      if (typeof value === 'string' && value.trim()) dispositions[id] = value.trim();
    }
  }
  if (findingIds.length === 0 && Object.keys(dispositions).length === 0) return null;
  return { findingIds, dispositions };
}

// ── Derived helpers ──────────────────────────────────────────────────────────

/**
 * The attempt running right now, if any.
 * @param {import('./types').RunState} state
 * @returns {import('./types').StageAttempt | undefined}
 */
export function liveAttempt(state) {
  return state?.attempts.find((a) => !a.ended);
}

/**
 * The open interview question, if one is waiting.
 * @param {import('./types').RunState} state
 * @returns {import('./types').QuestionRecord | undefined}
 */
export function openQuestion(state) {
  return state?.questions.find((q) => q.status === 'open');
}

/**
 * Records of the current step, oldest first.
 * @param {import('./types').RunState} state
 * @returns {import('./types').StageRecord[]}
 */
export function stepRecords(state) {
  if (state?.step?.kind !== 'stage') return [];
  const stage = state.step.stage;
  return state.stageRecords.slice(state.step.recordsFrom ?? 0).filter((r) => r.stage === stage);
}

/**
 * @param {import('./types').RunState} state
 * @returns {boolean}
 */
export function isStopped(state) {
  return !state || state.finished || state.status !== 'running';
}

/**
 * @param {import('./types').RunState} state
 * @returns {boolean}
 */
export function polishEnabled(state) {
  if (state.config.polish === 'always') return true;
  if (state.config.polish === 'never') return false;
  return state.involvesUi === true;
}

// ── Config ───────────────────────────────────────────────────────────────────

/**
 * @param {unknown} value
 * @param {number} min
 * @param {number} max
 * @returns {number | null}
 */
function clampInt(value, min, max) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * @param {unknown} raw
 * @returns {import('./types').ModelBinding | null}
 */
function readBinding(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const rec = /** @type {Record<string, unknown>} */ (raw);
  let providerId = typeof rec.providerId === 'string' ? rec.providerId.trim() : '';
  let modelId = typeof rec.modelId === 'string' ? rec.modelId.trim() : typeof rec.id === 'string' ? rec.id.trim() : '';
  // The renderer's model picker encodes `provider\u001fmodel` select keys.
  const sep = modelId.indexOf('\u001f');
  if (sep > 0) {
    providerId = modelId.slice(0, sep).trim() || providerId;
    modelId = modelId.slice(sep + 1).trim();
  }
  if (!modelId) return null;
  /** @type {import('./types').ModelBinding} */
  const binding = { providerId, modelId };
  if (typeof rec.thinking === 'string' && ['on', 'off'].includes(rec.thinking)) binding.thinking = /** @type {'on' | 'off'} */ (rec.thinking);
  return binding;
}

/**
 * Accepts the v3 keys and the Settings keys the renderer stores.
 * @param {unknown} raw
 * @returns {import('./types').RunConfig}
 */
export function readConfig(raw) {
  /** @type {import('./types').RunConfig} */
  const config = { ...DEFAULT_CONFIG };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return config;
  const rec = /** @type {Record<string, any>} */ (raw);
  const interview = typeof rec.interview === 'boolean' ? rec.interview : rec.grillEnabled;
  if (typeof interview === 'boolean') config.interview = interview;
  const budget = clampInt(rec.questionBudget ?? rec.grillQuestionBudget, 0, 40);
  if (budget !== null) config.questionBudget = budget;
  const research = typeof rec.research === 'boolean' ? rec.research : rec.researchEnabled;
  if (typeof research === 'boolean') config.research = research;
  if (['web', 'codebase', 'both'].includes(rec.researchScope)) config.researchScope = rec.researchScope;
  if (['quick', 'standard', 'deep', 'auto'].includes(rec.researchDepth)) config.researchDepth = rec.researchDepth;
  const rounds = clampInt(rec.researchMaxRounds, 0, 8);
  if (rounds !== null) config.researchMaxRounds = rounds;
  const reviewRounds = clampInt(rec.reviewRounds, 0, 4);
  if (reviewRounds !== null) config.reviewRounds = reviewRounds;
  const reviewTimeout = clampInt(rec.reviewTimeoutMs, 60_000, 7_200_000);
  if (reviewTimeout !== null) config.reviewTimeoutMs = reviewTimeout;
  const polish = rec.polish ?? rec.impeccable;
  if (polish === 'auto' || polish === 'always' || polish === 'never') config.polish = polish;
  if (['large', 'medium', 'small'].includes(rec.granularity)) config.granularity = rec.granularity;
  for (const key of /** @type {const} */ (['plannerModel', 'reviewerModel', 'researchModel'])) {
    const binding = readBinding(rec[key]);
    if (binding) config[key] = binding;
  }
  if (typeof rec.thinking === 'string' && ['on', 'off'].includes(rec.thinking)) config.thinking = rec.thinking;
  return config;
}

// ── Legacy (v2) journals ─────────────────────────────────────────────────────

/**
 * v2 runs fold far enough to be listed and read: identity, artifacts and a
 * terminal status. Their stages cannot continue on this engine.
 * @param {import('./types').RunState} state
 * @param {any} event
 */
function applyLegacy(state, event) {
  switch (event.type) {
    case 'run.started':
    case 'run.resumed':
      if (!state.finished) {
        state.status = 'stopped';
        state.stopReason = 'halted';
        state.halted = {
          stage: 'interview',
          summary: 'This plan was started by an older version of Super Plan and cannot continue. Its files are kept.',
          errors: [],
        };
      }
      return;
    case 'run.cancelled':
      finish(state, 'cancelled', 'cancelled');
      return;
    case 'run.finished':
      finish(state, event.outcome === 'pass' ? 'complete' : 'failed', event.outcome === 'pass' ? 'pass' : 'fail');
      return;
    case 'run.stopped':
      if (event.reason !== 'paused') finish(state, 'failed', 'fail');
      return;
    case 'slug.assigned':
      state.slug = event.slug;
      if (typeof event.displayTitle === 'string') state.title = event.displayTitle;
      return;
    case 'spec.written':
      recordArtifact(state, 'spec', event);
      return;
    case 'research.written':
      recordArtifact(state, 'research', event);
      return;
    case 'plan.written':
      recordArtifact(state, 'plan', event);
      return;
  }
}

/** Read-only views of a run: the page view and the small chat summary. Pure. */

import { currentFindings, isActionable, openQuestion, polishEnabled, reviewCycleLimit, reviewsInCycle } from './derive.js';
import { OPTIONAL_STAGES } from './events.js';

/** Pipeline positions, in order. Checkpoints sit between stages. */
export const PIPELINE = /** @type {const} */ (['interview', 'spec', 'research', 'draft', 'review', 'polish', 'accept']);

const STAGE_NAMES = {
  interview: 'Interview',
  spec: 'Spec review',
  research: 'Research',
  draft: 'Plan',
  review: 'Review',
  polish: 'Polish',
  accept: 'Accept',
};

/**
 * @param {import('./types').RunState} state
 * @returns {string}
 */
function stepName(state, id) {
  if (id === 'interview' && (!state.config.interview || state.config.questionBudget <= 0)) return 'Spec';
  return STAGE_NAMES[id] ?? id;
}

/**
 * Label for one attempt's transcript.
 * @param {import('./types').RunState} state
 * @param {import('./types').StageAttempt} attempt
 * @returns {string}
 */
export function attemptLabel(state, attempt) {
  switch (attempt.stage) {
    case 'interview':
      if (attempt.seedKind === 'revise') return 'Spec revision';
      if (attempt.seedKind === 'rework') return 'Interview again';
      return stepName(state, 'interview');
    case 'research':
      return 'Research';
    case 'draft':
      if (attempt.seedKind === 'findings') return 'Revision';
      if (attempt.seedKind === 'feedback') return 'Revision from your notes';
      if (attempt.seedKind === 'rework') return 'Redraft';
      return 'Draft';
    case 'review': {
      const review = state.reviews.find((r) => r.attemptId === attempt.attemptId);
      return review ? `Review ${review.round}` : 'Review';
    }
    case 'polish':
      return 'Polish';
    default:
      return attempt.stage;
  }
}

/**
 * Where the run is: the current stage or checkpoint id.
 * @param {import('./types').RunState} state
 * @returns {string | null}
 */
function currentPosition(state) {
  if (state.step?.kind === 'stage') return state.step.stage;
  if (state.step?.kind === 'checkpoint') return state.step.checkpoint;
  if (state.finished && state.stopReason === 'complete') return 'accept';
  return null;
}

/**
 * @param {import('./types').RunState} state
 * @returns {'running' | 'waiting' | 'paused' | 'halted' | 'done' | 'cancelled' | 'failed' | 'legacy' | 'created'}
 */
export function runStatus(state) {
  if (state.legacy && !state.finished) return 'legacy';
  if (state.finished) {
    if (state.stopReason === 'complete') return 'done';
    if (state.stopReason === 'cancelled') return 'cancelled';
    return 'failed';
  }
  if (state.status === 'created') return 'created';
  if (state.stopReason === 'halted') return 'halted';
  if (state.stopReason === 'paused') return 'paused';
  if (state.step?.kind === 'checkpoint' || openQuestion(state)) return 'waiting';
  return 'running';
}

/**
 * What needs the user right now, if anything.
 * @param {import('./types').RunState} state
 * @returns {'question' | 'spec' | 'accept' | 'halted' | null}
 */
function needsInput(state) {
  if (state.finished) return null;
  if (state.stopReason === 'halted') return 'halted';
  if (openQuestion(state)) return 'question';
  if (state.step?.kind === 'checkpoint') return state.step.checkpoint;
  return null;
}

/**
 * Changes once per thing the user is asked, so an alert fires once per ask.
 * @param {import('./types').RunState} state
 * @returns {string}
 */
function attentionKeyOf(state) {
  const needs = needsInput(state);
  if (!needs) return '';
  const question = openQuestion(state);
  const since = state.step?.kind === 'checkpoint' ? state.step.since ?? '' : state.halted?.at ?? '';
  return `${needs}:${question?.questionId ?? currentPosition(state) ?? ''}:${since}`;
}

/**
 * One line about what is happening.
 * @param {import('./types').RunState} state
 * @returns {string}
 */
function activityLine(state) {
  const status = runStatus(state);
  if (status === 'done') return 'Plan accepted';
  if (status === 'cancelled') return 'Cancelled';
  if (status === 'failed') return 'Stopped';
  if (status === 'legacy') return 'Created by an older version';
  if (status === 'halted') return `${stepName(state, state.halted?.stage ?? 'interview')} needs attention`;
  if (openQuestion(state)) return 'Waiting for your answers';
  if (state.step?.kind === 'checkpoint') return state.step.checkpoint === 'spec' ? 'Spec ready for review' : 'Plan ready for review';
  const prefix = status === 'paused' ? 'Paused · ' : '';
  if (state.step?.kind !== 'stage') return `${prefix}Starting`;
  switch (state.step.stage) {
    case 'interview':
      if (state.step.seedKind === 'revise') return `${prefix}Revising the spec`;
      return `${prefix}${state.config.interview && state.config.questionBudget > 0 ? 'Interviewing' : 'Writing the spec'}`;
    case 'research':
      return `${prefix}Researching`;
    case 'draft':
      return `${prefix}${state.step.seedKind === 'initial' ? 'Drafting the plan' : 'Revising the plan'}`;
    case 'review': {
      const round = reviewsInCycle(state).length + 1;
      return `${prefix}Reviewing (round ${round} of ${Math.max(1, reviewCycleLimit(state))})`;
    }
    case 'polish':
      return `${prefix}Polishing the interface tasks`;
    default:
      return prefix || 'Working';
  }
}

/**
 * @param {import('./types').RunState} state
 * @param {string} id
 * @returns {boolean}
 */
function isOff(state, id) {
  if (id === 'research') return !state.config.research;
  if (id === 'review') return state.config.reviewRounds <= 0 && !state.reviews.length;
  if (id === 'polish') {
    if (state.config.polish === 'never') return true;
    if (state.config.polish === 'auto' && state.artifacts.plan && !polishEnabled(state) && state.polishedCycle === 0) return true;
  }
  return false;
}

/**
 * The pipeline column: one row per stage and checkpoint.
 * @param {import('./types').RunState} state
 */
function pipelineSteps(state) {
  const current = currentPosition(state);
  const currentIndex = current ? PIPELINE.indexOf(/** @type {any} */ (current)) : -1;
  const status = runStatus(state);
  return PIPELINE.map((id, index) => {
    const records = state.stageRecords.filter((r) => r.stage === id);
    const attempts = state.attempts.filter((a) => a.stage === id);
    const ok = records.some((r) => r.outcome === 'ok');
    const skipped = state.skipped.filter((s) => s.stage === id);
    const answered = id === 'spec' || id === 'accept' ? state.checkpoints.some((c) => c.checkpoint === id && (c.verdict === 'confirm' || c.verdict === 'accept')) : false;
    /** @type {string} */
    let rowState = 'pending';
    if (isOff(state, id) && !ok && !skipped.length) rowState = 'off';
    else if (id === current && !state.finished) {
      if (status === 'halted') rowState = 'failed';
      else if (status === 'paused') rowState = 'paused';
      else if (id === 'spec' || id === 'accept' || (id === 'interview' && openQuestion(state))) rowState = 'waiting';
      else rowState = 'active';
    } else if (id === 'accept' && state.finished && state.stopReason === 'complete') rowState = 'done';
    else if (ok || answered) rowState = currentIndex >= 0 && index > currentIndex ? 'earlier' : 'done';
    else if (skipped.length) rowState = 'skipped';
    const first = attempts[0];
    const last = attempts[attempts.length - 1];
    return {
      id,
      label: stepName(state, id),
      state: rowState,
      detail: stepDetail(state, id, skipped),
      ...(first?.startedAt ? { startedAt: first.startedAt } : {}),
      ...(last?.endedAt ? { endedAt: last.endedAt } : {}),
      runs: attempts.filter((a) => a.seedKind !== 'continue' && a.seedKind !== 'errors').length,
      reworkable: ['interview', 'research', 'draft', 'review', 'polish'].includes(id) && ok && !state.legacy && !(state.finished && state.stopReason !== 'complete') && id !== current,
      skippable: OPTIONAL_STAGES.includes(/** @type {any} */ (id)) && id === current && !state.finished,
    };
  });
}

/**
 * @param {import('./types').RunState} state
 * @param {string} id
 * @param {Array<{ reason: string }>} skipped
 * @returns {string}
 */
function stepDetail(state, id, skipped) {
  const lastSkip = skipped[skipped.length - 1];
  if (lastSkip && !state.stageRecords.some((r) => r.stage === id && r.outcome === 'ok')) {
    return lastSkip.reason === 'user' ? 'skipped' : lastSkip.reason === 'empty' ? 'nothing found' : 'skipped after errors';
  }
  switch (id) {
    case 'interview': {
      const asked = state.questions.filter((q) => q.status !== 'cancelled').reduce((n, q) => n + q.questions.length, 0);
      return asked ? `${asked} question${asked === 1 ? '' : 's'}` : '';
    }
    case 'spec':
      return state.artifacts.spec?.title ?? '';
    case 'research':
      if (state.artifacts.research?.empty) return 'nothing found';
      return state.artifacts.research ? 'report saved' : '';
    case 'draft':
      return state.artifacts.plan?.tasks ? `${state.artifacts.plan.tasks} tasks` : '';
    case 'review': {
      const exit = state.reviewExit;
      const rounds = reviewsInCycle(state).length;
      if (!rounds && !exit) return state.config.reviewRounds ? `${state.config.reviewRounds} round${state.config.reviewRounds === 1 ? '' : 's'}` : '';
      const reason = exit ? { clean: 'clean', 'round-cap': 'round limit', 'no-progress': 'no progress', skipped: 'skipped', failed: 'failed' }[exit.reason] : '';
      return `${rounds} round${rounds === 1 ? '' : 's'}${reason ? ` · ${reason}` : ''}`;
    }
    case 'polish':
      return state.config.polish === 'auto' && !state.artifacts.plan ? 'if the plan has UI work' : '';
    default:
      return '';
  }
}

/**
 * Transcripts, one per stage step.
 * @param {import('./types').RunState} state
 */
function transcriptsOf(state) {
  /** @type {Map<string, any>} */
  const byKey = new Map();
  for (const attempt of state.attempts) {
    if (attempt.stage === 'research') continue;
    let row = byKey.get(attempt.transcriptKey);
    if (!row) {
      row = {
        key: attempt.transcriptKey,
        stage: attempt.stage,
        iteration: attempt.iteration,
        label: attemptLabel(state, attempt),
        attempts: 0,
        live: false,
        ...(attempt.startedAt ? { startedAt: attempt.startedAt } : {}),
      };
      byKey.set(attempt.transcriptKey, row);
    }
    row.attempts += 1;
    row.live = row.live || !attempt.ended;
    row.outcome = attempt.outcome;
    if (attempt.endedAt) row.endedAt = attempt.endedAt;
    if (attempt.stage === 'review') row.label = attemptLabel(state, attempt);
  }
  return [...byKey.values()];
}

/**
 * A readable history of the run for the activity feed.
 * @param {import('./types').RunState} state
 */
function timelineOf(state) {
  /** @type {Array<{ at: number, kind: string, label: string, detail?: string, tone?: string }>} */
  const rows = [];
  const push = (at, kind, label, detail, tone) => {
    if (!Number.isFinite(at)) return;
    rows.push({ at, kind, label, ...(detail ? { detail } : {}), ...(tone ? { tone } : {}) });
  };
  if (state.createdAt) push(state.createdAt, 'start', 'Plan started');
  for (const attempt of state.attempts) {
    if (attempt.seedKind === 'continue' || attempt.seedKind === 'errors') {
      if (attempt.startedAt) push(attempt.startedAt, 'retry', `${attemptLabel(state, attempt)} resumed`);
    } else if (attempt.startedAt) push(attempt.startedAt, 'stage', `${attemptLabel(state, attempt)} started`);
    if (!attempt.ended || !attempt.endedAt) continue;
    if (attempt.outcome === 'ok') push(attempt.endedAt, 'stage', `${attemptLabel(state, attempt)} finished`, attempt.summary ?? undefined, 'good');
    else if (attempt.outcome === 'rejected') push(attempt.endedAt, 'problem', `${attemptLabel(state, attempt)} needs another pass`, attempt.errors[0] ?? attempt.summary ?? undefined, 'warning');
    else if (attempt.outcome === 'crashed' || attempt.outcome === 'timeout') push(attempt.endedAt, 'problem', `${attemptLabel(state, attempt)} was interrupted`, attempt.summary ?? undefined, 'warning');
  }
  for (const question of state.questions) {
    if (question.askedAt) push(question.askedAt, 'question', `Asked ${question.questions.length} question${question.questions.length === 1 ? '' : 's'}`, question.title || undefined);
    if (question.answeredAt) push(question.answeredAt, 'answer', question.status === 'skipped' ? 'You skipped the remaining questions' : 'You answered');
  }
  for (const checkpoint of state.checkpoints) {
    const label = {
      confirm: 'You confirmed the spec',
      revise: checkpoint.checkpoint === 'spec' ? 'You asked for spec changes' : 'You asked for plan changes',
      accept: 'You accepted the plan',
      review: 'You asked for another review',
    }[checkpoint.verdict] ?? checkpoint.verdict;
    if (checkpoint.at) push(checkpoint.at, 'checkpoint', label, checkpoint.feedback ?? undefined, 'good');
  }
  for (const review of state.reviews) {
    const blockers = review.findings.filter((f) => f.severity === 'blocker').length;
    const warnings = review.findings.filter((f) => f.severity === 'warn').length;
    const counts = review.findings.length
      ? [blockers && `${blockers} blocker${blockers === 1 ? '' : 's'}`, warnings && `${warnings} warning${warnings === 1 ? '' : 's'}`, review.findings.length - blockers - warnings && `${review.findings.length - blockers - warnings} note${review.findings.length - blockers - warnings === 1 ? '' : 's'}`].filter(Boolean).join(', ')
      : 'no issues';
    if (review.at) push(review.at, 'review', `Review ${review.round}: ${counts}`, review.summary || undefined, blockers ? 'warning' : 'good');
  }
  for (const skip of state.skipped) {
    if (skip.at) push(skip.at, 'skip', `${STAGE_NAMES[skip.stage] ?? skip.stage} skipped`, skip.reason === 'user' ? undefined : skip.reason === 'empty' ? 'Nothing useful was found' : 'It kept failing');
  }
  if (state.halted?.at) push(state.halted.at, 'halted', `${stepName(state, state.halted.stage)} stopped after repeated failures`, state.halted.summary ?? undefined, 'danger');
  rows.sort((a, b) => a.at - b.at);
  return rows;
}

/**
 * Everything the page renders.
 * @param {import('./types').RunState} state
 * @param {{ seq?: number, startFailure?: { message: string, consecutive: number } | null }} [extra]
 */
export function projectRunView(state, extra = {}) {
  const status = runStatus(state);
  const question = openQuestion(state);
  const findings = currentFindings(state);
  const current = currentPosition(state);
  return {
    runId: state.runId,
    chatId: state.chatId,
    title: displayTitle(state),
    slug: state.slug,
    prompt: state.prompt,
    workspacePath: state.workspacePath,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    seq: extra.seq ?? state.lastSeq,
    status,
    finished: state.finished,
    legacy: state.legacy,
    current,
    currentLabel: current ? stepName(state, current) : '',
    seedKind: state.step?.kind === 'stage' ? state.step.seedKind : null,
    activity: activityLine(state),
    needsInput: needsInput(state),
    attentionKey: attentionKeyOf(state),
    question: question
      ? { questionId: question.questionId, title: question.title, questions: question.questions, askedAt: question.askedAt ?? null }
      : null,
    checkpoint: state.step?.kind === 'checkpoint' && !state.finished
      ? { kind: state.step.checkpoint, since: state.step.since ?? null }
      : null,
    halted: state.halted
      ? { stage: state.halted.stage, label: stepName(state, state.halted.stage), summary: state.halted.summary, errors: state.halted.errors }
      : null,
    startFailure: extra.startFailure ?? null,
    steps: pipelineSteps(state),
    artifacts: {
      spec: state.artifacts.spec ? { ...state.artifacts.spec } : null,
      research: state.artifacts.research ? { ...state.artifacts.research } : null,
      plan: state.artifacts.plan ? { ...state.artifacts.plan } : null,
    },
    reviews: state.reviews.map((r) => ({ ...r, findings: r.findings.map((f) => ({ ...f })) })),
    reviewCycle: state.reviewCycle,
    reviewExit: state.reviewExit,
    openFindings: findings.open.filter(isActionable).map((f) => f.id),
    resolvedFindings: findings.resolved,
    disputedClaims: state.disputedClaims,
    questions: state.questions
      .filter((q) => q.status !== 'open')
      .map((q) => ({ questionId: q.questionId, title: q.title, status: q.status, questions: q.questions, answer: q.answer, askedAt: q.askedAt ?? null, answeredAt: q.answeredAt ?? null })),
    checkpoints: state.checkpoints.map((c) => ({ ...c })),
    feedback: { ...state.feedback },
    timeline: timelineOf(state),
    transcripts: transcriptsOf(state),
    research: state.researchId ? { researchId: state.researchId } : null,
    config: {
      interview: state.config.interview,
      questionBudget: state.config.questionBudget,
      research: state.config.research,
      researchScope: state.config.researchScope,
      researchDepth: state.config.researchDepth,
      reviewRounds: state.config.reviewRounds,
      polish: state.config.polish,
      granularity: state.config.granularity,
      plannerModel: state.config.plannerModel ?? null,
      reviewerModel: state.config.reviewerModel ?? null,
    },
    actions: {
      pause: status === 'running' || status === 'waiting',
      resume: status === 'paused',
      retry: status === 'halted' && !state.legacy,
      cancel: !state.finished,
      skip: state.step?.kind === 'stage' && OPTIONAL_STAGES.includes(state.step.stage) && !state.finished ? state.step.stage : null,
      stopQuestions: state.step?.kind === 'stage' && state.step.stage === 'interview' && !state.questionsClosed && !state.finished && state.config.questionBudget > 0 && state.config.interview,
      revise: (status === 'waiting' && state.step?.kind === 'checkpoint') || status === 'done',
    },
  };
}

/**
 * The run's display title: the user's rename, the spec title, then the request.
 * @param {import('./types').RunState} state
 * @returns {string}
 */
export function displayTitle(state) {
  if (state.title) return state.title;
  const prompt = String(state.prompt ?? '').replace(/\s+/g, ' ').trim();
  if (!prompt) return 'Untitled plan';
  const firstSentence = prompt.split(/(?<=[.!?])\s/)[0] ?? prompt;
  const text = firstSentence.length > 72 ? `${firstSentence.slice(0, 70).replace(/\s+\S*$/, '')}…` : firstSentence;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * The compact summary stored on the chat (`chat.superPlanView`) for the
 * sidebar, the plan library and boot. The page always reads the full view.
 * @param {import('./types').RunState} state
 * @param {{ seq?: number }} [extra]
 */
export function projectChatSummary(state, extra = {}) {
  const current = currentPosition(state);
  const needs = needsInput(state);
  return {
    runId: state.runId,
    title: displayTitle(state),
    slug: state.slug,
    prompt: state.prompt,
    status: runStatus(state),
    stage: current ?? '',
    stageLabel: current ? stepName(state, current) : '',
    activity: activityLine(state),
    needsInput: needs,
    // Changes once per thing the user is asked, so an alert fires once per ask.
    attentionKey: attentionKeyOf(state),
    finished: state.finished,
    ...(state.artifacts.plan ? { planPath: state.artifacts.plan.path } : {}),
    ...(state.artifacts.spec ? { specPath: state.artifacts.spec.path } : {}),
    atMs: state.updatedAt ?? state.createdAt ?? 0,
    seq: extra.seq ?? state.lastSeq,
  };
}

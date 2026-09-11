import { polishEnabled } from './derive.js';
/** Read-only display projection. Transcript stamps retain their historical names. */
const stamps = { interview: 'grill', research: 'research', draft: 'draft1', review: 'review1', polish: 'impeccable' };
const labels = { interview: 'Interview', research: 'Research', draft: 'Draft', review: 'Review', polish: 'Polish', spec: 'Build specification', accept: 'Accept plan' };
export function projectSuperPlan(state, atMs = 0) {
  const roles = [...(state.config.interview ? ['interview'] : []), 'spec', ...(state.config.research ? ['research'] : []), 'draft', ...(state.config.reviewRounds ? ['review'] : []), ...(polishEnabled(state) ? ['polish'] : []), 'accept'];
  const gateStage = state.gate?.kind === 'question' ? state.stage : state.gate?.kind;
  const stage = gateStage ?? state.pendingGate ?? state.stage ?? (state.finished && state.stopReason === 'failed' ? state.stageRecords.at(-1)?.stage : null) ?? 'accept';
  const activeStage = stamps[stage] ?? (stage === 'spec' ? 'spec_confirm' : 'present');
  const stages = Object.fromEntries(['grill', 'spec_confirm', 'research', 'draft1', 'review1', 'draft2', 'review2', 'impeccable', 'finalize', 'present'].map((id) => [id, { status: 'pending' }]));
  for (const record of state.stageRecords) {
    if (record.outcome === 'paused') continue;
    const id = stamps[record.stage];
    if (id) stages[id] = { status: record.outcome === 'ok' ? 'done' : 'error', error: record.summary ?? undefined };
  }
  if (state.gateHistory.some((gate) => gate.kind === 'spec' && gate.verdict === 'confirm')) stages.spec_confirm.status = 'done';
  for (const attempt of state.attempts) {
    const id = stamps[attempt.stage];
    if (!id || !attempt.startedAt) continue;
    stages[id] = { ...stages[id], startedAt: attempt.startedAt, finishedAt: attempt.finishedAt };
  }
  const status = state.finished ? (state.stopReason === 'complete' ? 'done' : state.stopReason === 'cancelled' ? 'cancelled' : 'error') : state.status === 'stopped' ? 'paused' : state.gate ? 'waiting' : 'running';
  stages[activeStage] = { ...stages[activeStage], status: status === 'waiting' ? 'blocked_user' : status === 'done' ? 'done' : status === 'error' ? 'error' : 'running' };
  if (state.specPath) stages.spec_confirm.artifactPath = state.specPath;
  if (state.planPath) stages.present.artifactPath = state.planPath;
  return {
    runId: state.runId, runStartedAt: state.startedAt, slug: state.slug, displayTitle: state.displayTitle || state.slug.replace(/-/g, ' '), prompt: state.prompt,
    enabledStages: roles.map((role) => stamps[role] ?? (role === 'spec' ? 'spec_confirm' : 'present')),
    stage, stageLabel: labels[stage] ?? stage, stageIndex: roles.indexOf(stage) + 1, stageTotal: roles.length,
    state: status, finished: state.finished, planPath: state.planPath ?? undefined, specPath: state.specPath ?? undefined,
    researchPath: state.researchPath ?? undefined, researchId: state.researchId, atMs, activeStage, stages,
    paused: status === 'paused', cancelled: status === 'cancelled', gate: state.gate,
    reviews: state.reviews, runSummary: state.runSummary, disputedClaims: state.disputedClaims, reviewExitReason: state.reviewExitReason,
  };
}

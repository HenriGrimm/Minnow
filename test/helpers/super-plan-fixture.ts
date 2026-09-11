/**
 * Super Plan fixtures for renderer tests: a chat summary and full run views in
 * the shapes `server/super-plan/projection.js` produces, one per situation the
 * run page has to paint.
 */

import type {
  SuperPlanChatSummary,
  SuperPlanRunView,
  SuperPlanStep,
  SuperPlanStepId,
  SuperPlanStepState,
} from '../../src/chat/super-plan/types';
import type { Chat } from '../../src/types';

export type SuperPlanScenario =
  | 'interviewing'
  | 'question'
  | 'spec'
  | 'researching'
  | 'drafting'
  | 'reviewing'
  | 'accept'
  | 'halted'
  | 'paused'
  | 'done'
  | 'cancelled';

const T0 = Date.UTC(2026, 8, 11, 9, 0, 0);

/** Mirrors STAGE_NAMES in server/super-plan/projection.js. */
const STEP_LABELS: Record<SuperPlanStepId, string> = {
  interview: 'Interview',
  spec: 'Spec review',
  research: 'Research',
  draft: 'Plan',
  review: 'Review',
  polish: 'Polish',
  accept: 'Accept',
};

const ORDER: SuperPlanStepId[] = ['interview', 'spec', 'research', 'draft', 'review', 'polish', 'accept'];

const CURRENT: Record<SuperPlanScenario, SuperPlanStepId | null> = {
  interviewing: 'interview',
  question: 'interview',
  spec: 'spec',
  researching: 'research',
  drafting: 'draft',
  reviewing: 'review',
  accept: 'accept',
  halted: 'draft',
  paused: 'research',
  done: null,
  cancelled: null,
};

function stepsFor(scenario: SuperPlanScenario, t0: number): SuperPlanStep[] {
  const current = CURRENT[scenario];
  const currentIndex = current ? ORDER.indexOf(current) : ORDER.length;
  return ORDER.map((id, index): SuperPlanStep => {
    let state: SuperPlanStepState = index < currentIndex ? 'done' : index === currentIndex ? 'active' : 'pending';
    if (id === 'polish' && index < currentIndex) state = 'off';
    if (id === current) {
      if (scenario === 'question' || scenario === 'spec' || scenario === 'accept') state = 'waiting';
      if (scenario === 'halted') state = 'failed';
      if (scenario === 'paused') state = 'paused';
    }
    if (scenario === 'cancelled' && index >= 3) state = 'pending';
    const startedAt = state === 'pending' || state === 'off' ? undefined : t0 + index * 60_000;
    const endedAt = state === 'done' ? t0 + index * 60_000 + 45_000 : undefined;
    return {
      id,
      label: STEP_LABELS[id],
      state,
      detail: id === 'interview' && state === 'done' ? '4 questions' : '',
      ...(startedAt ? { startedAt } : {}),
      ...(endedAt ? { endedAt } : {}),
      runs: startedAt ? 1 : 0,
      reworkable: state === 'done' && id !== 'spec' && id !== 'accept',
      skippable: (id === 'research' || id === 'review' || id === 'polish') && state === 'active',
    };
  });
}

function statusFor(scenario: SuperPlanScenario): SuperPlanRunView['status'] {
  switch (scenario) {
    case 'question':
    case 'spec':
    case 'accept':
      return 'waiting';
    case 'halted':
      return 'halted';
    case 'paused':
      return 'paused';
    case 'done':
      return 'done';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'running';
  }
}

function needsInputFor(scenario: SuperPlanScenario): SuperPlanRunView['needsInput'] {
  if (scenario === 'question') return 'question';
  if (scenario === 'spec') return 'spec';
  if (scenario === 'accept') return 'accept';
  if (scenario === 'halted') return 'halted';
  return null;
}

const ACTIVITY: Record<SuperPlanScenario, string> = {
  interviewing: 'Reading the repository',
  question: 'Waiting for your answers',
  spec: 'The spec is ready for your review',
  researching: 'Researching',
  drafting: 'Drafting the plan',
  reviewing: 'Review round 1 of 2',
  accept: 'The plan is ready for your review',
  halted: 'Plan needs attention',
  paused: 'Paused',
  done: 'Plan accepted',
  cancelled: 'Cancelled',
};

/** A complete run view for `scenario`; `overrides` replace top-level fields. */
export function superPlanRunView(
  scenario: SuperPlanScenario = 'drafting',
  overrides: Partial<SuperPlanRunView> = {},
): SuperPlanRunView {
  const index = CURRENT[scenario] ? ORDER.indexOf(CURRENT[scenario]!) : ORDER.length;
  const finished = scenario === 'done' || scenario === 'cancelled';
  const hasSpec = index > 1 || scenario === 'spec' || scenario === 'done';
  const hasPlan = index > 3 || scenario === 'done';
  const needsInput = needsInputFor(scenario);
  const status = statusFor(scenario);
  const t0 = overrides.createdAt ?? T0;
  const view: SuperPlanRunView = {
    runId: 'run-fixture',
    chatId: 'chat-fixture',
    title: 'Offline sync queue',
    slug: 'offline-sync-queue',
    prompt: 'Add offline queueing to the sync layer so edits made without a connection are replayed in order.',
    workspacePath: 'C:/work/app',
    createdAt: t0,
    updatedAt: t0 + 5 * 60_000,
    seq: 40,
    status,
    finished,
    legacy: false,
    current: CURRENT[scenario],
    currentLabel: CURRENT[scenario] ? STEP_LABELS[CURRENT[scenario]!] : '',
    seedKind: 'initial',
    activity: ACTIVITY[scenario],
    needsInput,
    attentionKey: needsInput ? `${needsInput}:${scenario}` : '',
    question:
      scenario === 'question'
        ? {
            questionId: 'q-1',
            title: 'Two things the code does not say',
            askedAt: t0 + 60_000,
            questions: [
              {
                id: 'conflict',
                prompt: 'When a queued edit conflicts with a newer server change, which one wins?',
                options: [
                  { id: 'server', label: 'Server wins', description: 'Drop the queued edit and tell the user.', recommended: true },
                  { id: 'client', label: 'Client wins', description: 'Overwrite the server change.' },
                ],
              },
              {
                id: 'scope',
                prompt: 'Which record types should queue offline?',
                allow_multiple: true,
                options: [
                  { id: 'notes', label: 'Notes', recommended: true },
                  { id: 'tasks', label: 'Tasks', recommended: true },
                  { id: 'files', label: 'File uploads' },
                ],
              },
            ],
          }
        : null,
    checkpoint: scenario === 'spec' ? { kind: 'spec', since: t0 + 2 * 60_000 } : scenario === 'accept' ? { kind: 'accept', since: t0 + 5 * 60_000 } : null,
    halted:
      scenario === 'halted'
        ? {
            stage: 'draft',
            label: 'Plan',
            summary: 'The plan did not pass checks three times in a row.',
            errors: ['Task 3 has no Test step.', 'Wave 2 depends on a task that does not exist.'],
          }
        : null,
    startFailure: null,
    steps: stepsFor(scenario, t0),
    artifacts: {
      spec: hasSpec ? { path: 'documentation/plans/offline-sync-queue.spec.md', sha256: 'spec-sha', title: 'Offline sync queue' } : null,
      research: index > 2 || scenario === 'done' ? { path: 'documentation/plans/offline-sync-queue.research.md', sha256: 'research-sha' } : null,
      plan: hasPlan
        ? { path: 'documentation/plans/offline-sync-queue.md', sha256: 'plan-sha', title: 'Offline sync queue', tasks: 7, executable: true }
        : null,
    },
    reviews:
      scenario === 'accept' || scenario === 'done'
        ? [
            {
              round: 1,
              cycle: 1,
              attemptId: 'review-1',
              summary: 'Solid plan; one ordering gap.',
              findings: [
                { id: 'f-order', severity: 'blocker', title: 'Replay order is undefined across tabs', detail: 'Two tabs can drain the queue at once.', fix: 'Add a lock task before wave 2.', paths: ['src/sync/queue.ts'] },
                { id: 'f-copy', severity: 'info', title: 'Offline banner copy is unspecified', detail: '', paths: [] },
              ],
            },
          ]
        : [],
    reviewCycle: 1,
    reviewExit: scenario === 'accept' || scenario === 'done' ? { reason: 'round-cap', cycle: 1 } : null,
    openFindings: scenario === 'accept' ? ['f-order'] : [],
    resolvedFindings: [],
    disputedClaims: [],
    questions: [],
    checkpoints: [],
    feedback: { spec: null, plan: null },
    timeline: [],
    transcripts: [],
    research: null,
    config: {
      interview: true,
      questionBudget: 20,
      research: true,
      researchScope: 'both',
      researchDepth: 'auto',
      reviewRounds: 2,
      polish: 'auto',
      granularity: 'medium',
      plannerModel: null,
      reviewerModel: null,
    },
    // Mirrors projectRunView's actions.
    actions: {
      pause: status === 'running' || status === 'waiting',
      resume: status === 'paused',
      retry: status === 'halted',
      cancel: !finished,
      skip: scenario === 'researching' || scenario === 'reviewing' ? (CURRENT[scenario] as 'research' | 'review') : null,
      stopQuestions: scenario === 'question',
      revise: scenario === 'spec' || scenario === 'accept' || scenario === 'done',
    },
  };
  return { ...view, ...overrides };
}

/** The summary a chat keeps for `view`. */
export function superPlanSummaryFor(view: SuperPlanRunView): SuperPlanChatSummary {
  return {
    runId: view.runId,
    title: view.title,
    slug: view.slug,
    prompt: view.prompt,
    status: view.status,
    stage: view.current ?? '',
    stageLabel: view.currentLabel,
    activity: view.activity,
    needsInput: view.needsInput,
    attentionKey: view.attentionKey,
    finished: view.finished,
    ...(view.artifacts.plan ? { planPath: view.artifacts.plan.path } : {}),
    ...(view.artifacts.spec ? { specPath: view.artifacts.spec.path } : {}),
    atMs: view.updatedAt ?? 0,
    seq: view.seq,
  };
}

/** A chat summary for `scenario`, with overrides. */
export function superPlanSummary(
  scenario: SuperPlanScenario = 'drafting',
  overrides: Partial<SuperPlanChatSummary> = {},
): SuperPlanChatSummary {
  return { ...superPlanSummaryFor(superPlanRunView(scenario)), ...overrides };
}

/** Make `chat` the home of a run in `scenario`. Returns the full view for the store. */
export function attachSuperPlanRun(
  chat: Chat,
  scenario: SuperPlanScenario = 'drafting',
  overrides: Partial<SuperPlanRunView> = {},
): SuperPlanRunView {
  const view = superPlanRunView(scenario, { runId: `run-${chat.id}`, chatId: chat.id, ...overrides });
  chat.modeId = 'super-plan';
  chat.superPlanRunId = view.runId;
  chat.superPlanView = superPlanSummaryFor(view);
  return view;
}

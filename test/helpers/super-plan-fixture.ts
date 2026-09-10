import { SUPER_PLAN_DISPLAY_ORDER, type SuperPlanStageId } from '../../src/chat/super-plan/types';
import type { SuperPlanView } from '../../src/chat/super-plan/view';
import type { Chat } from '../../src/types';
import { notifySuperPlanView } from '../../src/chat/super-plan/client';

export function createInitialSuperPlanStages(): SuperPlanView['stages'] {
  return Object.fromEntries(SUPER_PLAN_DISPLAY_ORDER.map((id) => [id, { status: 'pending' }])) as SuperPlanView['stages'];
}
export function createSuperPlanState(prompt: string): SuperPlanView {
  return { runId: 'fixture', slug: 'plan-12345678', displayTitle: 'Plan 12345678', prompt, activeStage: 'grill', stages: createInitialSuperPlanStages(), stage: 'interview', stageLabel: 'Interview', stageIndex: 1, stageTotal: 7, state: 'running', finished: false, atMs: 1 };
}
export function initSuperPlanState(chat: Chat, prompt: string): SuperPlanView { return chat.superPlanView = createSuperPlanState(prompt); }
export function markSuperPlanStageStatus(chat: Chat, stage: SuperPlanStageId, status: SuperPlanView['stages'][SuperPlanStageId]['status']): void { chat.superPlanView!.stages[stage].status = status; }
export function setSuperPlanActiveStage(chat: Chat, stage: SuperPlanStageId): void { chat.superPlanView!.activeStage = stage; }
export const notifySuperPlanControllerForTests = notifySuperPlanView;
export function resetSuperPlanControllerForTests(): void {}
export function pauseSuperPlan(chat: Chat): void { chat.superPlanView!.paused = true; notifySuperPlanView(chat); }

export function hydrateFixture(chat: Chat): void {
  const view = chat.superPlanView;
  if (!view) return;
  const status = view.stages[view.activeStage]?.status;
  view.finished = view.cancelled === true || (view.activeStage === 'present' && status === 'done');
  view.state = view.cancelled ? 'cancelled' : view.paused ? 'paused' : status === 'error' ? 'error' : status === 'blocked_user' ? 'waiting' : view.finished ? 'done' : 'running';
  if (status === 'blocked_user') view.gate = { gateId: 'fixture:1', kind: view.activeStage === 'spec_confirm' ? 'spec' : 'accept', question: 'Review this artifact' };
}

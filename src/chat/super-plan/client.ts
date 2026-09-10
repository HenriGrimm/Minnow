import type { Chat } from '../../types';
import { getSuperPlanConfigSync, loadSuperPlanConfig } from '../../config/super-plan-meta';
import { defaultSuperPlanClaimTransport, claimSuperPlanForChat, startSuperPlanEngineRun } from './claim-loop';
import { findChatById, scheduleSaveSessions } from '../../state/sessions';
import type { SuperPlanCheckpointAction, SuperPlanStageId, SuperPlanState } from './types';

const listeners = new Set<(chat: Chat) => void>();
export function subscribeSuperPlanView(listener: (chat: Chat) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function notifySuperPlanView(chat: Chat): void {
  for (const listener of listeners) listener(chat);
}
export async function refreshSuperPlanView(chat: Chat): Promise<void> {
  if (!chat.superPlanRunId) return;
  const state = await defaultSuperPlanClaimTransport.fetchState(chat.superPlanRunId);
  if (state.view) chat.superPlanView = state.view;
  notifySuperPlanView(chat);
}
async function command(chat: Chat, action: string, body?: unknown): Promise<void> {
  if (!chat.superPlanRunId) throw new Error('This historical run cannot resume. Start a new plan.');
  const response = await fetch(`/api/super-plan/${encodeURIComponent(chat.superPlanRunId)}/${action}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}),
  });
  if (!response.ok) throw new Error((await response.json()).error ?? 'Super Plan request failed');
  await refreshSuperPlanView(chat);
  void claimSuperPlanForChat(chat);
}
export async function startSuperPlan(chat: Chat, prompt: string): Promise<void> {
  await loadSuperPlanConfig();
  if (chat.superPlanRunId && !chat.superPlanView?.finished) return resumeSuperPlanPipeline(chat);
  delete chat.superPlanRunId;
  const config = getSuperPlanConfigSync();
  const result = await startSuperPlanEngineRun({ chat, prompt, config: {
    ...config, interview: config.grillEnabled, research: config.researchEnabled, polish: config.impeccable,
    plannerModel: config.plannerModel.modelId ? config.plannerModel : { providerId: chat.providerId, modelId: chat.modelId },
  } });
  if (!result.ok) throw new Error(result.error);
  scheduleSaveSessions();
  await refreshSuperPlanView(chat);
}
export function isSuperPlanAdvancing(chatId: string): boolean {
  return findChatById(chatId)?.superPlanView?.state === 'running';
}
export function isSuperPlanPipelineResumable(chat: Chat): boolean {
  return Boolean(chat.superPlanRunId && !chat.superPlanView?.finished);
}
export function isSuperPlanTransportChat(chat: Chat): boolean { return chat.modeId === 'super-plan'; }
export function isSuperPlanStalled(chat: Chat): boolean { return chat.superPlanView?.paused === true; }
export function getSuperPlanCheckpointKind(chat: Chat): 'spec_confirm' | 'present' | null {
  return chat.superPlanView?.gate?.kind === 'spec' ? 'spec_confirm' : chat.superPlanView?.gate?.kind === 'accept' ? 'present' : null;
}
export async function answerSuperPlanGate(chat: Chat, answer: string, errors: string[] = []): Promise<void> {
  const gate = chat.superPlanView?.gate;
  if (!gate) return;
  await command(chat, `gates/${encodeURIComponent(gate.gateId)}/answer`, { answer, errors });
}
export async function resumeSuperPlanAfterUser(chat: Chat, action: SuperPlanCheckpointAction): Promise<void> {
  const accept = chat.superPlanView?.gate?.kind === 'accept';
  await answerSuperPlanGate(chat, accept ? (action === 'confirm' ? 'accept' : 'reject') : action);
}
export async function pauseSuperPlan(chat: Chat): Promise<void> {
  const prior = chat.superPlanView;
  if (prior) chat.superPlanView = { ...prior, paused: true, state: 'paused' };
  notifySuperPlanView(chat);
  try { await command(chat, 'stop'); }
  catch (error) { chat.superPlanView = prior; notifySuperPlanView(chat); throw error; }
  const { stopGeneration } = await import('../stop-generation');
  stopGeneration(chat.id);
}
export async function cancelSuperPlan(chat: Chat): Promise<void> {
  await command(chat, 'cancel');
  const { stopGeneration } = await import('../stop-generation');
  stopGeneration(chat.id);
}
export async function resumeSuperPlanPipeline(chat: Chat): Promise<void> { await command(chat, 'resume'); }
export async function retrySuperPlanStage(chat: Chat): Promise<void> {
  const view = chat.superPlanView;
  if (view?.finished) await command(chat, 'rework', { stage: view.activeStage === 'spec_confirm' ? 'grill' : view.activeStage === 'present' ? 'draft1' : view.activeStage });
  else await command(chat, 'resume');
}
export async function skipSuperPlanStage(chat: Chat): Promise<void> { await command(chat, 'skip'); }
export async function rewindSuperPlanToStage(chat: Chat, stage: SuperPlanStageId): Promise<void> { await command(chat, 'rework', { stage }); }
export function superPlanRunKey(state: SuperPlanState): string { return `${state.slug}:${state.runStartedAt ?? ''}`; }

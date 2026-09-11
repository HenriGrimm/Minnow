/**
 * Super Plan actions for the rest of the app. The server runs every stage;
 * these helpers start runs, send the user's decisions and read the summary a
 * chat keeps.
 */

import type { Chat } from '../../types';
import { getSuperPlanConfigSync, loadSuperPlanConfig } from '../../config/super-plan-meta';
import { loadPromptMetaSettings } from '../../config/prompt-meta';
import { decodeModelSelectKey } from '../../lib/model-select-key';
import { scheduleSaveSessions } from '../../state/sessions';
import { getWorkspacePath } from '../../state/workspace';
import {
  answerSuperPlanQuestion,
  createSuperPlanRun,
  deleteSuperPlanRun,
  sendSuperPlanCommand,
  type SuperPlanCommand,
} from './api';
import { applySuperPlanView, summaryFromView } from './store';
import type { SuperPlanAnswerEntry, SuperPlanRunView, SuperPlanStageId } from './types';

// ── Reading the chat summary ─────────────────────────────────────────────────

/** A Super Plan chat: its home in the sidebar, and the thread the run belongs to. */
export function isSuperPlanTransportChat(chat: Chat): boolean {
  return chat.modeId === 'super-plan';
}

/** True while the run can still move forward (running, waiting, paused or halted). */
export function isSuperPlanPipelineResumable(chat: Chat): boolean {
  return Boolean(chat.superPlanRunId && chat.superPlanView && !chat.superPlanView.finished && chat.superPlanView.status !== 'legacy');
}

/** True while a stage is actively working. */
export function isSuperPlanRunning(chat: Chat | undefined): boolean {
  return chat?.superPlanView?.status === 'running';
}

/** True while the run is working or waiting on the user. */
export function isSuperPlanActive(chat: Chat | undefined): boolean {
  const status = chat?.superPlanView?.status;
  return status === 'running' || status === 'waiting';
}

// ── Starting ─────────────────────────────────────────────────────────────────

/** The planner binding: Settings' planner model, else the chat's own model. */
function plannerBinding(chat: Chat, configured: { providerId: string; modelId: string }): Record<string, unknown> | null {
  if (configured.modelId.trim()) return { providerId: configured.providerId, modelId: configured.modelId };
  const raw = (chat.modelId ?? '').trim();
  if (!raw) return null;
  const decoded = decodeModelSelectKey(raw);
  const binding: Record<string, unknown> = decoded
    ? { providerId: decoded.providerId, modelId: decoded.modelId }
    : { providerId: chat.providerId ?? '', modelId: raw };
  if (chat.thinkingMode === 'on' || chat.thinkingMode === 'off') binding.thinking = chat.thinkingMode;
  return binding;
}

/**
 * Start a run for this chat. The Settings pipeline options and model bindings
 * are snapshotted into the run; later changes apply to new runs.
 */
export async function startSuperPlan(chat: Chat, prompt: string): Promise<SuperPlanRunView> {
  const [config, meta] = await Promise.all([loadSuperPlanConfig(), loadPromptMetaSettings().catch(() => null)]);
  const workspacePath = chat.workspacePath?.trim() || getWorkspacePath();
  const binding = (value: { providerId: string; modelId: string }) => (value.modelId.trim() ? value : undefined);
  const view = await createSuperPlanRun({
    prompt,
    workspacePath,
    chatId: chat.id,
    config: {
      interview: config.grillEnabled,
      questionBudget: config.grillQuestionBudget,
      research: config.researchEnabled,
      researchScope: config.researchScope,
      researchDepth: config.researchDepth,
      researchMaxRounds: config.researchMaxRounds,
      reviewRounds: config.reviewRounds,
      reviewTimeoutMs: config.reviewTimeoutMs,
      polish: config.impeccable,
      granularity: meta?.planGranularity ?? 'medium',
      plannerModel: plannerBinding(chat, config.plannerModel) ?? undefined,
      reviewerModel: binding(config.reviewerModel),
      researchModel: binding(config.researchModel),
    },
  });
  chat.superPlanRunId = view.runId;
  chat.superPlanView = summaryFromView(view);
  if (!chat.workspacePath) chat.workspacePath = workspacePath;
  scheduleSaveSessions({ chatId: chat.id });
  applySuperPlanView(view);
  return view;
}

// ── Commands ─────────────────────────────────────────────────────────────────

function runIdOf(chat: Chat): string {
  const runId = chat.superPlanRunId?.trim();
  if (!runId) throw new Error('This chat has no plan run. Start a new plan.');
  return runId;
}

async function command(chat: Chat, name: SuperPlanCommand, body?: Record<string, unknown>): Promise<SuperPlanRunView> {
  const view = await sendSuperPlanCommand(runIdOf(chat), name, body);
  applySuperPlanView(view);
  return view;
}

export function pauseSuperPlan(chat: Chat): Promise<SuperPlanRunView> {
  return command(chat, 'pause');
}

/** Resume a paused run, or retry a halted stage with a fresh failure budget. */
export function resumeSuperPlan(chat: Chat): Promise<SuperPlanRunView> {
  return command(chat, 'resume');
}

export function cancelSuperPlan(chat: Chat): Promise<SuperPlanRunView> {
  return command(chat, 'cancel');
}

export function skipSuperPlanStage(chat: Chat, stage: SuperPlanStageId): Promise<SuperPlanRunView> {
  return command(chat, 'skip', { stage });
}

export function reworkSuperPlanStage(chat: Chat, stage: SuperPlanStageId): Promise<SuperPlanRunView> {
  return command(chat, 'rework', { stage });
}

/** Tell the interview to stop asking and write the spec with what it has. */
export function stopSuperPlanQuestions(chat: Chat): Promise<SuperPlanRunView> {
  return command(chat, 'questions/close');
}

export async function answerSuperPlanQuestions(
  chat: Chat,
  questionId: string,
  answers: SuperPlanAnswerEntry[],
): Promise<SuperPlanRunView> {
  const view = await answerSuperPlanQuestion(runIdOf(chat), questionId, answers);
  applySuperPlanView(view);
  return view;
}

export function answerSuperPlanCheckpoint(
  chat: Chat,
  checkpoint: 'spec' | 'accept',
  verdict: 'confirm' | 'revise' | 'accept' | 'review',
  feedback?: string,
): Promise<SuperPlanRunView> {
  return command(chat, 'checkpoint', { checkpoint, verdict, ...(feedback?.trim() ? { feedback: feedback.trim() } : {}) });
}

export function renameSuperPlan(chat: Chat, title: string): Promise<SuperPlanRunView> {
  return command(chat, 'rename', { title });
}

/** Remove the run's journal. The chat and plan files are the caller's business. */
export async function deleteSuperPlanRunForChat(chat: Chat): Promise<void> {
  const runId = chat.superPlanRunId?.trim();
  if (!runId) return;
  await deleteSuperPlanRun(runId);
}

/** Settings snapshot the composer chips edit before a run starts. */
export { getSuperPlanConfigSync };

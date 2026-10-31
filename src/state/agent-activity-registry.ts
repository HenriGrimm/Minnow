/**
 * Unified snapshot of all in-flight agent-like work (main turn, sub-agents, title).
 */

import {
  mainTurnActivityElapsedMs,
  type MainTurnActivity,
} from '../chat/main-turn-activity';
import type { TitleJobActivity } from '../chat/titles/activity-events';
import { formatModelLabel } from '../lib/format-model-label';
import type { SubAgentRun } from '../agents/types';
import type { Chat } from '../types';
import { chatReadOnlyReason } from './chat-relationships';

export type AgentActivityKind = 'main_turn' | 'sub_agent' | 'title_job' | 'agent_chat';

export type AgentActivityStatus =
  | 'queued'
  | 'running'
  | 'generating'
  | 'tools'
  | 'pending_question'
  | 'pending_approval'
  | 'waiting'
  | 'stopping'
  | 'recovery_required'
  | 'completed'
  | 'failed'
  | 'stopped';

export interface AgentActivityRow {
  id: string;
  kind: AgentActivityKind;
  chatId: string;
  chatTitle: string;
  label: string;
  status: AgentActivityStatus;
  modelDisplay: string;
  providerId?: string;
  modelId?: string;
  currentTool?: string | null;
  /** Reason shown while the row is parked on the wait tool. */
  waitReason?: string;
  toolTurns?: number;
  contextPercent: number | null;
  contextIsEstimate: boolean;
  startedAtMs: number;
  elapsedMs: number;
  /** When true, the elapsed timer should not tick (e.g. ask_question wait). */
  elapsedFrozen: boolean;
  runId?: string;
  parentToolCallId?: string | null;
  executionId?: string;
  commandId?: string;
  requestIds?: string[];
  canStop?: boolean;
  unread?: boolean;
  updatedAtMs?: number;
  activityCursor?: Chat['agentActivityCursor'];
}

export interface AgentActivityContextFill {
  percent: number | null;
  isEstimate: boolean;
}

export interface BuildAgentActivitySnapshotInput {
  nowMs: number;
  chats: Chat[];
  mainTurns: MainTurnActivity[];
  subAgents: SubAgentRun[];
  titleJobs: TitleJobActivity[];
  contextByChatId?: Map<string, AgentActivityContextFill>;
  resolveSubAgentLabel?: (type: string) => string;
  /** Chats blocked on ask_question (visible or parked strip). */
  questionPendingChatIds?: ReadonlySet<string>;
}

function modelDisplayFromId(modelId: string): string {
  const trimmed = modelId.trim();
  if (!trimmed) return '—';
  return formatModelLabel({ id: trimmed }).primary;
}

function chatTitleFor(chats: Chat[], chatId: string): string {
  const chat = chats.find((c) => c.id === chatId);
  return chat?.name?.trim() || 'Chat';
}

function contextFor(
  chatId: string,
  map: Map<string, AgentActivityContextFill> | undefined,
): AgentActivityContextFill {
  return map?.get(chatId) ?? { percent: null, isEstimate: true };
}

function isQuestionPendingForChat(
  chatId: string,
  pending: ReadonlySet<string> | undefined,
): boolean {
  const trimmed = chatId.trim();
  return trimmed ? Boolean(pending?.has(trimmed)) : false;
}

function mapMainTurnPhase(phase: MainTurnActivity['phase']): AgentActivityStatus {
  if (phase === 'pending_question') return 'pending_question';
  if (phase === 'waiting') return 'waiting';
  if (phase === 'tools') return 'tools';
  if (phase === 'thinking') return 'generating';
  if (phase === 'loading_model') return 'generating';
  return 'generating';
}

function mainTurnRowStatus(
  turn: MainTurnActivity,
  questionPending: boolean,
): AgentActivityStatus {
  // A parked wait owns the row: the turn is not generating, it is on a timer.
  if (turn.phase === 'waiting') return 'waiting';
  if (questionPending || turn.phase === 'pending_question') return 'pending_question';
  return mapMainTurnPhase(turn.phase);
}

function mainTurnRowElapsed(
  turn: MainTurnActivity,
  nowMs: number,
  questionPending: boolean,
): { elapsedMs: number; elapsedFrozen: boolean } {
  const frozen =
    questionPending ||
    turn.phase === 'pending_question' ||
    turn.phase === 'waiting' ||
    turn.pausedAtMs != null;
  return {
    elapsedMs: mainTurnActivityElapsedMs(turn, nowMs),
    elapsedFrozen: frozen,
  };
}

function buildMainTurnRows(
  input: BuildAgentActivitySnapshotInput,
): AgentActivityRow[] {
  const rows: AgentActivityRow[] = [];
  const seen = new Set<string>();

  for (const turn of input.mainTurns) {
    if (input.chats.some(chat => chat.id === turn.chatId && chat.chatCommandVersion === 1)) continue;
    seen.add(turn.chatId);
    const requests = input.chats.find(chat => chat.id === turn.chatId)?.agentRequestSummary ?? [];
    const ctx = contextFor(turn.chatId, input.contextByChatId);
    const questionPending = requests.length > 0 || isQuestionPendingForChat(
      turn.chatId,
      input.questionPendingChatIds,
    );
    const status = requests.some(row => row.kind === 'approval') ? 'pending_approval' : mainTurnRowStatus(turn, questionPending);
    const { elapsedMs, elapsedFrozen } = mainTurnRowElapsed(
      turn,
      input.nowMs,
      questionPending,
    );
    rows.push({
      id: `main:${turn.chatId}`,
      kind: 'main_turn',
      chatId: turn.chatId,
      chatTitle: chatTitleFor(input.chats, turn.chatId),
      label: turn.workAgentLabel,
      status,
      modelDisplay: modelDisplayFromId(turn.modelId),
      providerId: turn.providerId,
      modelId: turn.modelId,
      currentTool:
        status === 'tools' || status === 'pending_question' || status === 'waiting'
          ? turn.currentTool
          : null,
      ...(status === 'waiting' && turn.waitReason ? { waitReason: turn.waitReason } : {}),
      contextPercent: ctx.percent,
      contextIsEstimate: ctx.isEstimate,
      startedAtMs: turn.startedAtMs,
      elapsedMs,
      elapsedFrozen,
      requestIds: requests.map(row => row.requestId),
    });
  }

  for (const chat of input.chats) {
    if (chat.chatCommandVersion === 1) continue;
    const genId = chat.currentGenerationId?.trim();
    if (!genId || seen.has(chat.id)) continue;
    const ctx = contextFor(chat.id, input.contextByChatId);
    const startedAtMs = chat.updatedAt ?? input.nowMs;
    const requests = chat.agentRequestSummary ?? [];
    const questionPending = requests.length > 0 || isQuestionPendingForChat(
      chat.id,
      input.questionPendingChatIds,
    );
    rows.push({
      id: `main:${chat.id}`,
      kind: 'main_turn',
      chatId: chat.id,
      chatTitle: chatTitleFor(input.chats, chat.id),
      label: 'Main turn',
      status: requests.some(row => row.kind === 'approval') ? 'pending_approval' : questionPending ? 'pending_question' : 'generating',
      modelDisplay: modelDisplayFromId(chat.modelId ?? ''),
      providerId: chat.providerId,
      modelId: chat.modelId,
      currentTool: questionPending ? 'ask_question' : null,
      contextPercent: ctx.percent,
      contextIsEstimate: ctx.isEstimate,
      startedAtMs,
      elapsedMs: Math.max(0, input.nowMs - startedAtMs),
      elapsedFrozen: questionPending,
      requestIds: requests.map(row => row.requestId),
    });
  }

  return rows;
}

function buildSubAgentRows(input: BuildAgentActivitySnapshotInput): AgentActivityRow[] {
  const resolveLabel = input.resolveSubAgentLabel ?? ((type: string) => type);
  return input.subAgents.filter(run => !run.childChatId || !input.chats.some(chat => chat.id === run.childChatId && chat.chatCommandVersion === 1)).map((run) => {
    const chatId = run.childChatId ?? run.parentChatId ?? '';
    const child = run.childChatId ? input.chats.find(chat => chat.id === run.childChatId) : undefined;
    const questionPending = chatId
      ? isQuestionPendingForChat(chatId, input.questionPendingChatIds)
      : false;
    const status: AgentActivityStatus = questionPending
      ? 'pending_question'
      : run.status === 'queued'
        ? 'queued'
        : run.childChatId && run.phase?.startsWith('waiting')
          ? run.phase === 'waiting_for_approval' ? 'pending_approval' : run.phase === 'waiting_for_input' ? 'pending_question' : 'waiting'
          : run.childChatId && run.phase === 'stopping' ? 'stopping'
        : run.liveCurrentToolName || run.livePhase === 'tools'
          ? 'tools'
          : run.livePhase === 'thinking' || run.livePhase === 'generating'
            ? 'generating'
            : 'running';
    const startedAtMs = run.startedAt ? Date.parse(run.startedAt) : input.nowMs;
    const safeStart = Number.isFinite(startedAtMs) ? startedAtMs : input.nowMs;
    const elapsedMs = Math.max(0, input.nowMs - safeStart);
    return {
      id: run.childChatId ? run.executionId ? `execution:${run.executionId}` : run.commandId ? `command:${run.commandId}` : `task:${run.runId}` : `sub:${run.runId}`,
      kind: run.childChatId ? 'agent_chat' : 'sub_agent',
      chatId,
      chatTitle: chatId ? chatTitleFor(input.chats, chatId) : '—',
      label: resolveLabel(run.type),
      status,
      modelDisplay: modelDisplayFromId(run.modelId ?? ''),
      providerId: run.providerId,
      modelId: run.modelId,
      currentTool: run.liveCurrentToolName ?? null,
      toolTurns: run.toolTurns,
      contextPercent: null,
      contextIsEstimate: true,
      startedAtMs: safeStart,
      elapsedMs,
      elapsedFrozen: questionPending || status === 'waiting' || status === 'pending_approval' || status === 'stopping',
      runId: run.runId,
      parentToolCallId: run.parentToolCallId,
      ...(run.childChatId ? { executionId: run.executionId, commandId: run.commandId,
        canStop: Boolean(run.executionId) && (!child || !chatReadOnlyReason(child)) && child?.agentConversation?.capabilities?.canStop !== false,
        ...(status === 'waiting' ? { waitReason: waitingLabels[run.phase ?? ''] ?? 'for execution' } : {}) } : {}),
    };
  });
}

const settled = new Set(['completed', 'failed', 'stopped', 'recovery_required']);
const waitingLabels: Record<string, string> = { waiting_for_host: 'for execution host', waiting_for_model: 'for model', waiting_for_capacity: 'for model capacity',
  waiting_for_agents: 'for agents', waiting_for_input: 'for your input', waiting_for_question: 'for your answer', waiting_for_approval: 'for approval', waiting: '' };

function buildManagedChatRows(input: BuildAgentActivitySnapshotInput): AgentActivityRow[] {
  const rows: AgentActivityRow[] = [];
  for (const chat of input.chats) {
    if (chat.chatCommandVersion !== 1) continue;
    const execution = chat.agentExecution, pending = chat.agentPendingCommand;
    const waitingForAgents = execution?.status === 'completed' && (chat.agentTaskAttention?.pendingCount ?? 0) > 0;
    const requests = chat.agentRequestSummary ?? [];
    const requested = execution?.modelSelection, actual = execution?.resolvedModel;
    const model = actual ?? requested;
    const modelDisplay = requested?.providerId === 'minnow-router'
      ? `Pool ${requested.modelId}${actual ? ` → ${modelDisplayFromId(actual.modelId)}` : ''}` : modelDisplayFromId(model?.modelId ?? '');
    const context = execution?.contextUsage;
    const common = { kind: 'agent_chat' as const, chatId: chat.id, chatTitle: chatTitleFor(input.chats, chat.id), label: chat.agentTypeId || 'Agent chat',
      modelDisplay, providerId: model?.providerId, modelId: model?.modelId, contextPercent: context?.limit ? context.used / context.limit * 100 : null,
      contextIsEstimate: context?.isEstimate ?? true, runId: execution?.runId ?? undefined, unread: chat.unread === true,
      requestIds: requests.map(row => row.requestId), activityCursor: chat.agentActivityCursor,
      canStop: !chatReadOnlyReason(chat) && chat.agentConversation?.capabilities?.canStop !== false };
    if (execution && (!settled.has(execution.status) || chat.unread || chat.turnError || requests.length || waitingForAgents)) {
      const status: AgentActivityStatus = requests.some(row => row.kind === 'approval') || execution.status === 'waiting_for_approval' ? 'pending_approval' : requests.length || execution.status === 'waiting_for_input' ? 'pending_question'
        : execution.status === 'queued' ? 'queued'
        : waitingForAgents ? 'waiting'
        : execution.status === 'stopping' ? 'stopping' : execution.status === 'recovery_required' ? 'recovery_required'
        : execution.status === 'failed' ? 'failed' : execution.status === 'completed' ? 'completed' : execution.status === 'stopped' ? 'stopped'
        : execution.status.startsWith('waiting') ? 'waiting' : 'running';
      const startedAtMs = execution.createdAt ?? execution.updatedAt ?? input.nowMs;
      const frozen = !isAgentActivityRunning({ status });
      rows.push({ ...common, id: `execution:${execution.executionId}`, executionId: execution.executionId, commandId: execution.commandId ?? undefined,
        status, ...(status === 'waiting' ? { waitReason: waitingForAgents ? 'for agents' : waitingLabels[execution.status] ?? 'for execution' } : {}),
        currentTool: execution.status === 'loading_model' ? 'Loading model' : null, startedAtMs, updatedAtMs: execution.updatedAt,
        elapsedMs: Math.max(0, (frozen ? execution.settledAt ?? execution.updatedAt ?? startedAtMs : input.nowMs) - startedAtMs), elapsedFrozen: frozen,
        canStop: common.canStop && !settled.has(execution.status) && status !== 'stopping' });
    }
    if (pending && (!execution || settled.has(execution.status))) {
      const startedAtMs = execution?.updatedAt ?? input.nowMs;
      rows.push({ ...common, id: `command:${pending.commandId}`, commandId: pending.commandId, runId: pending.runId ?? undefined,
        modelDisplay: 'Model saved with message', providerId: undefined, modelId: undefined,
        status: pending.state === 'waiting_for_host' ? 'waiting' : 'queued', waitReason: pending.held ? 'for your queue action' : 'for execution host',
        startedAtMs, elapsedMs: 0, elapsedFrozen: true, canStop: false, requestIds: [] });
    }
  }
  return rows;
}

/** One running predicate for the Activity wheel, panel count and native tray. */
export function isAgentActivityRunning(row: Pick<AgentActivityRow, 'status'>): boolean {
  return row.status === 'running' || row.status === 'generating' || row.status === 'tools';
}
export function countRunningAgentRows(rows: readonly AgentActivityRow[]): number {
  return new Set(rows.filter(row => row.kind !== 'title_job' && isAgentActivityRunning(row)).map(row => row.executionId ? `execution:${row.executionId}` : row.id)).size;
}

function buildTitleRows(input: BuildAgentActivitySnapshotInput): AgentActivityRow[] {
  return input.titleJobs.map((job) => {
    const modelId = job.modelId?.trim() ?? '';
    return {
      id: `title:${job.chatId}`,
      kind: 'title_job',
      chatId: job.chatId,
      chatTitle: chatTitleFor(input.chats, job.chatId),
      label: 'Naming chat',
      status: 'running',
      modelDisplay: modelId ? modelDisplayFromId(modelId) : '—',
      providerId: job.providerId,
      modelId: job.modelId,
      contextPercent: null,
      contextIsEstimate: true,
      startedAtMs: job.startedAtMs,
      elapsedMs: Math.max(0, input.nowMs - job.startedAtMs),
      elapsedFrozen: false,
    };
  });
}

/** Sort: main turns first, then by startedAtMs ascending. */
export function sortAgentActivityRows(rows: AgentActivityRow[]): AgentActivityRow[] {
  const kindRank: Record<AgentActivityKind, number> = {
    main_turn: 0,
    agent_chat: 0,
    sub_agent: 1,
    title_job: 2,
  };
  return [...rows].sort((a, b) => {
    const ka = kindRank[a.kind];
    const kb = kindRank[b.kind];
    if (ka !== kb) return ka - kb;
    return a.startedAtMs - b.startedAtMs;
  });
}

/** Merge all activity sources into display rows. */
export function buildAgentActivitySnapshot(
  input: BuildAgentActivitySnapshotInput,
): AgentActivityRow[] {
  const rows = [
    ...buildMainTurnRows(input),
    ...buildManagedChatRows(input),
    ...buildSubAgentRows(input),
    ...buildTitleRows(input),
  ];
  return sortAgentActivityRows(rows);
}

/** Format elapsed ms as m:ss for list UI. */
export function formatAgentActivityElapsed(elapsedMs: number): string {
  const totalSec = Math.max(0, Math.floor(elapsedMs / 1000));
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${sec.toString().padStart(2, '0')}`;
}

/** Human-readable status line for a row. */
export function formatAgentActivityStatusLine(row: AgentActivityRow): string {
  if (row.status === 'waiting') return `Waiting ${row.waitReason ?? ''}`.trim();
  if (row.status === 'pending_question') return 'Pending question';
  if (row.status === 'pending_approval') return 'Needs approval';
  if (row.status === 'stopping') return 'Stopping';
  if (row.status === 'recovery_required') return 'Needs recovery';
  if (row.status === 'failed') return 'Failed';
  if (row.status === 'completed') return 'Completed';
  if (row.status === 'stopped') return 'Stopped';
  if (row.status === 'tools' && row.currentTool) {
    return `Running ${row.currentTool}`;
  }
  if (row.status === 'queued') return row.waitReason === 'for your queue action' ? 'Queued · on hold' : 'Queued';
  if (row.status === 'tools') return 'Running tools';
  if (row.kind === 'title_job') return 'Naming chat';
  if (row.status === 'generating') return 'Generating';
  if (row.kind === 'agent_chat' && row.currentTool === 'Loading model') return 'Loading model';
  return 'Running';
}

/** Optional tool-round suffix for sub-agents. */
export function formatAgentActivityToolRounds(row: AgentActivityRow): string {
  if (row.kind !== 'sub_agent') return '';
  if (row.toolTurns == null) return '';
  return `${row.toolTurns} rounds`;
}

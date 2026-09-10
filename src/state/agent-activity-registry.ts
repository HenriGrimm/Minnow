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

export type AgentActivityKind = 'main_turn' | 'sub_agent' | 'title_job';

export type AgentActivityStatus =
  | 'queued'
  | 'running'
  | 'generating'
  | 'tools'
  | 'pending_question';

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
  toolTurns?: number;
  contextPercent: number | null;
  contextIsEstimate: boolean;
  startedAtMs: number;
  elapsedMs: number;
  /** When true, the elapsed timer should not tick (e.g. ask_question wait). */
  elapsedFrozen: boolean;
  runId?: string;
  parentToolCallId?: string | null;
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
  if (phase === 'tools') return 'tools';
  if (phase === 'thinking') return 'generating';
  if (phase === 'loading_model') return 'generating';
  return 'generating';
}

function mainTurnRowStatus(
  turn: MainTurnActivity,
  questionPending: boolean,
): AgentActivityStatus {
  if (questionPending || turn.phase === 'pending_question') return 'pending_question';
  return mapMainTurnPhase(turn.phase);
}

function mainTurnRowElapsed(
  turn: MainTurnActivity,
  nowMs: number,
  questionPending: boolean,
): { elapsedMs: number; elapsedFrozen: boolean } {
  const frozen =
    questionPending || turn.phase === 'pending_question' || turn.pausedAtMs != null;
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
    seen.add(turn.chatId);
    const ctx = contextFor(turn.chatId, input.contextByChatId);
    const questionPending = isQuestionPendingForChat(
      turn.chatId,
      input.questionPendingChatIds,
    );
    const status = mainTurnRowStatus(turn, questionPending);
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
        status === 'tools' || status === 'pending_question' ? turn.currentTool : null,
      contextPercent: ctx.percent,
      contextIsEstimate: ctx.isEstimate,
      startedAtMs: turn.startedAtMs,
      elapsedMs,
      elapsedFrozen,
    });
  }

  for (const chat of input.chats) {
    const genId = chat.currentGenerationId?.trim();
    if (!genId || seen.has(chat.id)) continue;
    const ctx = contextFor(chat.id, input.contextByChatId);
    const startedAtMs = chat.updatedAt ?? input.nowMs;
    const questionPending = isQuestionPendingForChat(
      chat.id,
      input.questionPendingChatIds,
    );
    rows.push({
      id: `main:${chat.id}`,
      kind: 'main_turn',
      chatId: chat.id,
      chatTitle: chatTitleFor(input.chats, chat.id),
      label: 'Main turn',
      status: questionPending ? 'pending_question' : 'generating',
      modelDisplay: modelDisplayFromId(chat.modelId ?? ''),
      providerId: chat.providerId,
      modelId: chat.modelId,
      currentTool: questionPending ? 'ask_question' : null,
      contextPercent: ctx.percent,
      contextIsEstimate: ctx.isEstimate,
      startedAtMs,
      elapsedMs: Math.max(0, input.nowMs - startedAtMs),
      elapsedFrozen: questionPending,
    });
  }

  return rows;
}

function buildSubAgentRows(input: BuildAgentActivitySnapshotInput): AgentActivityRow[] {
  const resolveLabel = input.resolveSubAgentLabel ?? ((type: string) => type);
  return input.subAgents.map((run) => {
    const chatId = run.parentChatId ?? '';
    const questionPending = chatId
      ? isQuestionPendingForChat(chatId, input.questionPendingChatIds)
      : false;
    const status: AgentActivityStatus = questionPending
      ? 'pending_question'
      : run.status === 'queued'
        ? 'queued'
        : run.liveCurrentToolName || run.livePhase === 'tools'
          ? 'tools'
          : run.livePhase === 'thinking' || run.livePhase === 'generating'
            ? 'generating'
            : 'running';
    const startedAtMs = run.startedAt ? Date.parse(run.startedAt) : input.nowMs;
    const safeStart = Number.isFinite(startedAtMs) ? startedAtMs : input.nowMs;
    const elapsedMs = Math.max(0, input.nowMs - safeStart);
    return {
      id: `sub:${run.runId}`,
      kind: 'sub_agent',
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
      elapsedFrozen: questionPending,
      runId: run.runId,
      parentToolCallId: run.parentToolCallId,
    };
  });
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
  if (row.status === 'pending_question') return 'Pending question';
  if (row.status === 'tools' && row.currentTool) {
    return `Running ${row.currentTool}`;
  }
  if (row.status === 'queued') return 'Queued';
  if (row.status === 'tools') return 'Running tools';
  if (row.kind === 'title_job') return 'Naming chat';
  if (row.status === 'generating') return 'Generating';
  return 'Running';
}

/** Optional tool-round suffix for sub-agents. */
export function formatAgentActivityToolRounds(row: AgentActivityRow): string {
  if (row.kind !== 'sub_agent') return '';
  if (row.toolTurns == null) return '';
  return `${row.toolTurns} rounds`;
}

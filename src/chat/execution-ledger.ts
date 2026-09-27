import { getMode } from './modes/registry';
import { collectTranscriptTurns, type TranscriptTurn } from './transcript-turns';
import { isToolResultFailure, narrationSentence, summarizeTurn, type TurnSummary } from './turn-summary';
import { getUndoEligibility } from './undo-turn';
import type {
  Chat,
  IssueMessageSnapshot,
  PersistedSubAgentRun,
  ToolCall,
  ToolResultMessage,
  TurnRunStatus,
} from '../types';
import {
  getPerFileChangeSummary,
  type FileChangeSummary,
} from '../usage/code-change-ledger';

export type ExecutionLedgerActionStatus = 'pending' | 'succeeded' | 'failed';
export type ExecutionLedgerTurnStatus = TurnRunStatus | 'recorded';

export interface ExecutionLedgerAction {
  id: string;
  toolName: string;
  args: Record<string, unknown>;
  status: ExecutionLedgerActionStatus;
  result?: string;
  exitCode?: number;
  isCommand: boolean;
}

export interface ExecutionLedgerReference {
  kind: 'issue' | 'board' | 'board-task' | 'plan';
  label: string;
  value: string;
}

export interface ExecutionLedgerTurn {
  number: number;
  fork: number;
  end: number;
  prompt: string;
  issue?: IssueMessageSnapshot;
  modeId: string;
  modeLabel: string;
  /** Older stored turns fall back to the chat's current mode rather than claiming it was frozen. */
  modeSource: 'turn' | 'chat';
  status: ExecutionLedgerTurnStatus;
  createdAt?: number;
  endedAt?: number;
  durationMs?: number;
  workAgentId?: string;
  modelId?: string;
  planPath?: string;
  errorMessage?: string;
  stopReason?: string;
  completion?: string;
  summary: TurnSummary;
  actions: ExecutionLedgerAction[];
  files: FileChangeSummary[];
  agents: PersistedSubAgentRun[];
  canUndo: boolean;
}

export interface ExecutionLedger {
  chatId: string;
  title: string;
  references: ExecutionLedgerReference[];
  turns: ExecutionLedgerTurn[];
  /** Honest limits of the current session schema, surfaced by the view and docs. */
  unavailable: string[];
}

const COMMAND_TOOLS = new Set([
  'execute_command',
  'start_background_command',
  'run_javascript',
  'run_python',
]);

function parseArgs(call: ToolCall): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(call.function.arguments || '{}');
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** Exit code from the process-runner header persisted in a shell tool result. */
function parseExitCode(content: string): number | undefined {
  const match = /\(exit (-?\d+)\)/.exec(content);
  if (!match) return undefined;
  const value = Number.parseInt(match[1], 10);
  return Number.isFinite(value) ? value : undefined;
}

function collectActions(chat: Chat, turn: TranscriptTurn): ExecutionLedgerAction[] {
  const results = new Map<string, ToolResultMessage>();
  for (let i = turn.fork; i <= turn.end; i += 1) {
    const message = chat.history[i];
    if (message?.role === 'tool') results.set(message.tool_call_id, message);
  }

  const actions: ExecutionLedgerAction[] = [];
  for (let i = turn.fork; i <= turn.end; i += 1) {
    const message = chat.history[i];
    if (message?.role !== 'assistant' || !('tool_calls' in message)) continue;
    for (const call of message.tool_calls ?? []) {
      const result = results.get(call.id);
      const exitCode = result ? parseExitCode(result.content) : undefined;
      const failed = Boolean(
        result && (isToolResultFailure(result.content) || (exitCode != null && exitCode !== 0)),
      );
      actions.push({
        id: call.id,
        toolName: call.function.name,
        args: parseArgs(call),
        status: result ? (failed ? 'failed' : 'succeeded') : 'pending',
        ...(result ? { result: result.content } : {}),
        ...(exitCode != null ? { exitCode } : {}),
        isCommand: COMMAND_TOOLS.has(call.function.name),
      });
    }
  }
  return actions;
}

function modeLabel(modeId: Chat['modeId']): string {
  try {
    return getMode(modeId ?? 'build').label;
  } catch {
    return modeId || 'Build';
  }
}

function issueFromTurn(chat: Chat, turn: TranscriptTurn): IssueMessageSnapshot | undefined {
  const message = chat.history[turn.fork];
  return message?.role === 'user' ? message.issue : undefined;
}

function completionFromTurn(chat: Chat, turn: TranscriptTurn): string | undefined {
  if (turn.finalIndex == null) return undefined;
  const message = chat.history[turn.finalIndex];
  if (message?.role !== 'assistant' || 'tool_calls' in message) return undefined;
  const text = narrationSentence(message.content);
  return text || undefined;
}

function agentsForTurn(
  chat: Chat,
  turn: TranscriptTurn,
  actionIds: ReadonlySet<string>,
): PersistedSubAgentRun[] {
  const parentTurnId = turn.run?.parentTurnId;
  return (chat.subAgentRuns ?? []).filter((run) => {
    if (run.parentToolCallId && actionIds.has(run.parentToolCallId)) return true;
    return Boolean(parentTurnId && run.parentTurnId === parentTurnId);
  });
}

function collectReferences(chat: Chat, turns: readonly TranscriptTurn[]): ExecutionLedgerReference[] {
  const refs: ExecutionLedgerReference[] = [];
  const seen = new Set<string>();
  const push = (ref: ExecutionLedgerReference): void => {
    const key = `${ref.kind}:${ref.value}`;
    if (seen.has(key)) return;
    seen.add(key);
    refs.push(ref);
  };

  for (const turn of turns) {
    const issue = issueFromTurn(chat, turn);
    if (issue) push({ kind: 'issue', label: issue.id, value: issue.title });
    const plan = turn.run?.snapshot.orchestratePlanPath;
    if (plan) push({ kind: 'plan', label: 'Plan', value: plan });
  }
  if (chat.boardGroupId) {
    push({ kind: 'board', label: 'Board', value: chat.boardGroupId });
  }
  if (chat.boardTaskId) {
    push({ kind: 'board-task', label: 'Board task', value: chat.boardTaskId });
  }
  if (chat.orchestratePlanPath) {
    push({ kind: 'plan', label: 'Plan', value: chat.orchestratePlanPath });
  }
  return refs;
}

/**
 * Project the saved transcript into a task execution ledger. This deliberately
 * adds no persistence: old sessions still render, with missing run metadata
 * called out instead of reconstructed.
 */
export function projectExecutionLedger(chat: Chat): ExecutionLedger {
  const transcriptTurns = collectTranscriptTurns(chat);
  const undoTarget = getUndoEligibility(chat).target;
  const turns = transcriptTurns.map((turn, index): ExecutionLedgerTurn => {
    const run = turn.run;
    const modeId = run?.snapshot.modeId ?? chat.modeId ?? 'build';
    const actions = collectActions(chat, turn);
    const promptMessage = chat.history[turn.fork];
    const prompt = run?.snapshot.userContent ??
      (promptMessage?.role === 'user' ? promptMessage.content : '');
    const createdAt = run?.createdAt;
    const endedAt = run?.endedAt;
    const actionIds = new Set(actions.map((action) => action.id));
    return {
      number: index + 1,
      fork: turn.fork,
      end: turn.end,
      prompt,
      ...(issueFromTurn(chat, turn) ? { issue: issueFromTurn(chat, turn) } : {}),
      modeId,
      modeLabel: modeLabel(modeId),
      modeSource: run ? 'turn' : 'chat',
      status: run?.status ?? 'recorded',
      ...(createdAt != null ? { createdAt } : {}),
      ...(endedAt != null ? { endedAt } : {}),
      ...(createdAt != null && endedAt != null
        ? { durationMs: Math.max(0, endedAt - createdAt) }
        : {}),
      ...(run?.snapshot.workAgentId ? { workAgentId: run.snapshot.workAgentId } : {}),
      ...(run?.snapshot.modelId ? { modelId: run.snapshot.modelId } : {}),
      ...(run?.snapshot.orchestratePlanPath || chat.orchestratePlanPath
        ? { planPath: run?.snapshot.orchestratePlanPath ?? chat.orchestratePlanPath }
        : {}),
      ...(run?.errorMessage ? { errorMessage: run.errorMessage } : {}),
      ...(run?.stopReason ? { stopReason: run.stopReason } : {}),
      ...(completionFromTurn(chat, turn) ? { completion: completionFromTurn(chat, turn) } : {}),
      summary: summarizeTurn(chat.history, turn.fork, turn.end),
      actions,
      files: getPerFileChangeSummary(chat, turn.fork, turn.end),
      agents: agentsForTurn(chat, turn, actionIds),
      canUndo: Boolean(
        undoTarget &&
        undoTarget.forkHistoryIndex === turn.fork &&
        (!run || undoTarget.runId === run.runId),
      ),
    };
  });

  const unavailable = [
    'Individual action timestamps are not stored; action order follows the saved transcript.',
    'Verification is not a separate record; command outcomes come from saved tool results.',
  ];
  if (turns.some((turn) => turn.status === 'recorded')) {
    unavailable.push(
      'Older turns without run records do not have frozen mode, timing, model, or explicit completion status.',
    );
  }

  return {
    chatId: chat.id,
    title: chat.name || 'Untitled task',
    references: collectReferences(chat, transcriptTurns),
    turns,
    unavailable,
  };
}

/**
 * Turn-run CRUD and branch helpers (pure, no DOM).
 */

import { randomUUID } from '../lib/random-id.ts';
import { supportsLocalHistoryMutation } from './chat-relationships';
import type {
  Chat,
  ChatStopReason,
  Message,
  TurnRunId,
  TurnRunRecord,
  TurnRunStatus,
  TurnSnapshot,
} from '../types';

// ── Branches ─────────────────────────────────────────────────────────────────

function ensureRunsArray(chat: Chat): TurnRunRecord[] {
  if (!chat.runs) {
    chat.runs = [];
  }
  return chat.runs;
}

function newRunId(): TurnRunId {
  return randomUUID();
}

function newBranchId(): string {
  return randomUUID();
}

/** Runs at a fork index, newest first. */
export function listRunsAtFork(chat: Chat, forkHistoryIndex: number): TurnRunRecord[] {
  const runs = chat.runs ?? [];
  return runs
    .filter((r) => r.forkHistoryIndex === forkHistoryIndex)
    .sort((a, b) => b.createdAt - a.createdAt);
}

/** Pickable branches (completed or stopped with valid output range). */
export function listSelectableBranchesAtFork(
  chat: Chat,
  forkHistoryIndex: number,
): TurnRunRecord[] {
  return listRunsAtFork(chat, forkHistoryIndex).filter((r) => isBranchActivatable(chat, r));
}

export function isBranchActivatable(chat: Chat, run: TurnRunRecord): boolean {
  if (
    run.status !== 'completed' &&
    run.status !== 'stopped' &&
    run.status !== 'superseded'
  ) {
    return false;
  }
  if (run.outputMessages && run.outputMessages.length > 0) {
    return true;
  }
  const start = run.outputHistoryStart;
  const end = run.outputHistoryEnd;
  if (start === undefined || end === undefined) return false;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) {
    return false;
  }
  return end < chat.history.length;
}

/** Active run record for a fork (from activeBranchByFork map). */
export function getActiveRun(
  chat: Chat,
  forkHistoryIndex: number,
): TurnRunRecord | undefined {
  const forkKey = String(forkHistoryIndex);
  const branchId = chat.activeBranchByFork?.[forkKey];
  if (!branchId) {
    const runs = listRunsAtFork(chat, forkHistoryIndex);
    return runs.find((r) => r.status === 'completed' || r.status === 'stopped');
  }
  return (chat.runs ?? []).find((r) => r.branchId === branchId);
}

export function setActiveBranch(
  chat: Chat,
  forkHistoryIndex: number,
  branchId: string,
): void {
  if (!chat.activeBranchByFork) {
    chat.activeBranchByFork = {};
  }
  chat.activeBranchByFork[String(forkHistoryIndex)] = branchId;
}

/** Clear the active-branch pointer for a fork (e.g. after undo leaves no reply). */
export function clearActiveBranch(chat: Chat, forkHistoryIndex: number): void {
  if (!chat.activeBranchByFork) return;
  delete chat.activeBranchByFork[String(forkHistoryIndex)];
  if (Object.keys(chat.activeBranchByFork).length === 0) {
    delete chat.activeBranchByFork;
  }
}

export interface CreateRunOptions {
  parentRunId?: TurnRunId;
  parentTurnId?: string;
  overrides?: Partial<
    Pick<TurnSnapshot, 'providerId' | 'modelId' | 'temperature' | 'maxTokens'>
  >;
}

// ── Create ───────────────────────────────────────────────────────────────────

/** Append a new run; supersede prior non-superseded runs at the same fork. */
export function createRun(
  chat: Chat,
  snapshot: TurnSnapshot,
  options: CreateRunOptions = {},
): TurnRunRecord {
  const runs = ensureRunsArray(chat);
  for (const existing of runs) {
    if (
      existing.forkHistoryIndex === snapshot.forkHistoryIndex &&
      existing.status !== 'superseded'
    ) {
      existing.status = 'superseded';
      if (!existing.endedAt) {
        existing.endedAt = Date.now();
      }
    }
  }

  const merged: TurnSnapshot = {
    ...snapshot,
    ...(options.overrides?.providerId !== undefined
      ? { providerId: options.overrides.providerId }
      : {}),
    ...(options.overrides?.modelId !== undefined
      ? { modelId: options.overrides.modelId }
      : {}),
    ...(options.overrides?.temperature !== undefined
      ? { temperature: options.overrides.temperature }
      : {}),
    ...(options.overrides?.maxTokens !== undefined
      ? { maxTokens: options.overrides.maxTokens }
      : {}),
  };

  const record: TurnRunRecord = {
    runId: newRunId(),
    branchId: newBranchId(),
    forkHistoryIndex: merged.forkHistoryIndex,
    parentRunId: options.parentRunId,
    parentTurnId: options.parentTurnId,
    status: 'running',
    createdAt: Date.now(),
    snapshot: merged,
    generationIds: [],
  };
  runs.push(record);
  setActiveBranch(chat, merged.forkHistoryIndex, record.branchId);
  return record;
}

export function findRunById(chat: Chat, runId: TurnRunId): TurnRunRecord | undefined {
  return (chat.runs ?? []).find((r) => r.runId === runId);
}

/** Optional git snapshot fields written by the tool loop (MIN-409). */
export interface RunSnapshotAnnotation {
  preTurnSnapshotSha?: string;
  postTurnSnapshotSha?: string;
  headShaAtTurn?: string;
  snapshotCwd?: string;
}

/** Attach pre/post turn git snapshot metadata onto a run (best-effort; never throws). */
export function annotateRunSnapshots(
  chat: Chat,
  runId: TurnRunId,
  fields: RunSnapshotAnnotation,
): void {
  const run = findRunById(chat, runId);
  if (!run) return;
  if (fields.preTurnSnapshotSha?.trim()) {
    run.preTurnSnapshotSha = fields.preTurnSnapshotSha.trim();
  }
  if (fields.postTurnSnapshotSha?.trim()) {
    run.postTurnSnapshotSha = fields.postTurnSnapshotSha.trim();
  }
  if (fields.headShaAtTurn?.trim()) {
    run.headShaAtTurn = fields.headShaAtTurn.trim();
  }
  if (fields.snapshotCwd?.trim()) {
    run.snapshotCwd = fields.snapshotCwd.trim();
  }
}

export function noteRunGeneration(chat: Chat, runId: TurnRunId, generationId: string): void {
  const run = findRunById(chat, runId);
  if (!run) return;
  if (!run.generationIds) {
    run.generationIds = [];
  }
  if (!run.generationIds.includes(generationId)) {
    run.generationIds.push(generationId);
  }
}

export function noteRunOutputIndex(chat: Chat, runId: TurnRunId, historyIndex: number): void {
  const run = findRunById(chat, runId);
  if (!run) return;
  if (run.outputHistoryStart === undefined) {
    run.outputHistoryStart = historyIndex;
  }
  run.outputHistoryEnd = historyIndex;
}

export interface FinalizeRunOptions {
  status: TurnRunStatus;
  outputHistoryStart?: number;
  outputHistoryEnd?: number;
  outputMessages?: Message[];
  endedAt?: number;
  stopReason?: ChatStopReason;
  endReason?: 'max_tool_turns';
  errorMessage?: string;
}

// ── Finalize ─────────────────────────────────────────────────────────────────

export function finalizeRun(
  chat: Chat,
  runId: TurnRunId,
  options: FinalizeRunOptions,
): void {
  const run = findRunById(chat, runId);
  if (!run || run.status === 'superseded') return;
  run.status = options.status;
  run.endedAt = options.endedAt ?? Date.now();
  if (options.outputHistoryStart !== undefined) {
    run.outputHistoryStart = options.outputHistoryStart;
  }
  if (options.outputHistoryEnd !== undefined) {
    run.outputHistoryEnd = options.outputHistoryEnd;
  }
  if (options.outputMessages?.length) {
    run.outputMessages = options.outputMessages.map((m) => ({ ...m }));
  }
  if (run.status === 'stopped' && options.stopReason) {
    run.stopReason = options.stopReason;
  }
  if (options.endReason) {
    run.endReason = options.endReason;
  }
  if (options.errorMessage?.trim()) {
    run.errorMessage = options.errorMessage.trim();
  }
  if (run.status === 'completed' || run.status === 'stopped') {
    setActiveBranch(chat, run.forkHistoryIndex, run.branchId);
  }
}

/** Most recently created run on this chat (stage/turn runners create exactly one run each). */
export function newestRun(chat: Chat): TurnRunRecord | undefined {
  const runs = chat.runs ?? [];
  let newest: TurnRunRecord | undefined;
  for (const run of runs) {
    if (!newest || run.createdAt > newest.createdAt) newest = run;
  }
  return newest;
}

/**
 * After truncate at cutIndex (inclusive user row kept):
 * mark runs whose outputs extended past the cut as superseded.
 * Keep outputMessages so the undone reply stays redoable via activateBranch.
 */
export function pruneSupersededRunsAfterTruncate(chat: Chat, cutIndex: number): void {
  const runs = chat.runs ?? [];
  for (const run of runs) {
    const outStart = run.outputHistoryStart;
    const outEnd = run.outputHistoryEnd;
    if (outStart !== undefined && outStart > cutIndex) {
      run.status = 'superseded';
      delete run.outputHistoryStart;
      delete run.outputHistoryEnd;
      if (!run.endedAt) {
        run.endedAt = Date.now();
      }
    } else if (outEnd !== undefined && outEnd > cutIndex) {
      delete run.outputHistoryStart;
      delete run.outputHistoryEnd;
    }
    if (run.forkHistoryIndex > cutIndex) {
      run.status = 'superseded';
      delete run.outputHistoryStart;
      delete run.outputHistoryEnd;
      if (!run.endedAt) {
        run.endedAt = Date.now();
      }
    }
  }

  if (!chat.activeBranchByFork) return;
  const next: Record<string, string> = {};
  for (const [forkKey, branchId] of Object.entries(chat.activeBranchByFork)) {
    const fork = Number(forkKey);
    if (!Number.isFinite(fork) || fork > cutIndex) continue;
    if (chat.history.length <= fork + 1) continue;
    const run = runs.find((r) => r.branchId === branchId);
    if (run && isBranchActivatable(chat, run)) {
      next[forkKey] = branchId;
    }
  }
  chat.activeBranchByFork = next;
}

/**
 * Snapshot the materialized transcript tail for the active branch at a fork so
 * later branch switches can restore messages sent after the initial reply.
 */
export function persistActiveBranchSuffix(
  chat: Chat,
  forkHistoryIndex: number,
): boolean {
  const active = getActiveRun(chat, forkHistoryIndex);
  if (!active || !isBranchActivatable(chat, active)) {
    return false;
  }

  const prefixEnd = forkHistoryIndex;
  if (prefixEnd < 0 || prefixEnd >= chat.history.length) {
    return false;
  }

  const suffix = chat.history.slice(prefixEnd + 1);
  if (suffix.length === 0) {
    return false;
  }

  active.outputMessages = suffix.map((m) => ({ ...m }));
  active.outputHistoryStart = prefixEnd + 1;
  active.outputHistoryEnd = chat.history.length - 1;
  return true;
}

// ── Activate ─────────────────────────────────────────────────────────────────

/**
 * Rebuild chat.history from shared prefix through fork + selected branch output.
 */
export function activateBranch(
  chat: Chat,
  forkHistoryIndex: number,
  branchId: string,
): boolean {
  if (!supportsLocalHistoryMutation(chat)) return false;
  const currentActive = getActiveRun(chat, forkHistoryIndex);
  if (currentActive?.branchId === branchId) {
    persistActiveBranchSuffix(chat, forkHistoryIndex);
    return true;
  }

  persistActiveBranchSuffix(chat, forkHistoryIndex);

  const run = (chat.runs ?? []).find((r) => r.branchId === branchId);
  if (!run || !isBranchActivatable(chat, run)) {
    return false;
  }

  const prefixEnd = forkHistoryIndex;
  if (prefixEnd < 0 || prefixEnd >= chat.history.length) {
    return false;
  }
  const userRow = chat.history[prefixEnd];
  if (!userRow || userRow.role !== 'user') {
    return false;
  }

  let suffix: Message[];
  if (run.outputMessages?.length) {
    suffix = run.outputMessages.map((m) => ({ ...m }));
  } else {
    const start = run.outputHistoryStart!;
    const end = run.outputHistoryEnd!;
    suffix = chat.history.slice(start, end + 1);
  }
  if (suffix.length === 0) {
    return false;
  }

  chat.history = [...chat.history.slice(0, prefixEnd + 1), ...suffix];
  setActiveBranch(chat, forkHistoryIndex, branchId);
  return true;
}

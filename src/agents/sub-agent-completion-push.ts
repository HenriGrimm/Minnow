import { normalizeModeId } from '../chat/modes/types';
import { buildSubAgentParentResumeMessage } from './sub-agent-resume-message';
import { isChatStreaming, subscribeChatStreamEnd } from '../chat/streaming-state';
import { reportBackgroundError } from '../boot/report-background-error';
import { findChatById } from '../state/sessions';
import type { PersistedSubAgentRun } from '../types';
import {
  acknowledgeSubAgentDelivery,
  getSubAgentRun,
  subscribeSubAgentDeliver,
} from './orchestrator';
import { isSubAgentRunTerminal } from './sub-agent-outcome';
import { subscribeSubAgentRuns } from './sub-agent-events';
import type { SubAgentRun } from './types';
import { createDelivery, createMemoryJournal } from '../../server/sub-agents/delivery.js';
import { derive, isTerminal, lastEndedAttempt } from '../../server/sub-agents/derive.js';
import { makeEvent } from '../../server/sub-agents/events.js';
import type { DeliveryHandle, ParentStatus } from '../../server/sub-agents/delivery.js';
import type { RunState } from '../../server/sub-agents/types';
import type { DeliverFrame } from './sub-agent-client';

let pushInitialized = false;
let ingestChain: Promise<void> = Promise.resolve();

type CompletionDeliverFn = (
  chatId: string,
  message: string,
  runIdsToMark: string[],
) => Promise<void>;

type CompletionNotifyFn = (chatId: string, run: SubAgentRun) => void;

let deliverHook: CompletionDeliverFn | null = null;
let notifyHook: CompletionNotifyFn | null = null;

let delivery: DeliveryHandle | null = null;

const delayedByChat = new Map<string, Array<DeliverFrame & { parentChatId: string }>>();
const queuedDeliveryKeys = new Set<string>();
const resumedDeliveryKeys = new Set<string>();

function deliveryKey(frame: DeliverFrame & { parentChatId: string }): string {
  return `${frame.parentChatId}:${[...frame.runIds].sort().join(',')}`;
}

// ── Adapter ──────────────────────────────────────────────────────────────────

function createAdapterDelivery(): DeliveryHandle {
  const journal = createMemoryJournal();
  return createDelivery({
    journal,
    retryDelayMs: 5_000,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    parentStatus: adapterParentStatus,
    buildMessage: adapterBuildMessage,
    notifyUndeliverable: adapterNotify,
    deliverToParent: adapterDeliver,
    onDeliverError: (err) => reportBackgroundError('sub-agent-completion-push', err),
  });
}

function adapterParentStatus(chatId: string): ParentStatus {
  const chat = findChatById(chatId);
  if (!chat) return { streaming: false, skip: 'missing_chat' };
  if (normalizeModeId(chat.modeId) === 'orchestrate') {
    return { streaming: false, skip: 'orchestrate' };
  }
  return { streaming: isChatStreaming(chatId), skip: null };
}

function foldRunToSubAgentRun(run: RunState): SubAgentRun {
  const last = lastEndedAttempt(run);
  const status =
    run.phase === 'passed' ? 'completed' : run.phase === 'cancelled' ? 'cancelled' : 'failed';
  return {
    runId: run.runId,
    type: run.type,
    task: run.task,
    status,
    parentChatId: run.parentChatId,
    parentToolCallId: null,
    parentTurnId: null,
    summary: last?.summary ?? '',
    error: null,
    startedAt: run.requestedAt != null ? new Date(run.requestedAt).toISOString() : null,
    endedAt: null,
    toolTurns: 0,
    cancelled: run.phase === 'cancelled',
    messages: [],
  };
}

function adapterBuildMessage(
  kind: 'completion' | 'check_in_nudge',
  runs: RunState[],
  extra?: { elapsedSec?: number },
): string {
  const live = runs.map((r) => getSubAgentRun(r.runId) ?? foldRunToSubAgentRun(r));
  if (kind === 'check_in_nudge') {
    const run = live[0];
    return buildSubAgentParentResumeMessage('check_in_nudge', run ? [run] : [], {
      run: run ?? foldRunToSubAgentRun(runs[0]),
      elapsedSec: extra?.elapsedSec ?? 0,
    });
  }
  return buildSubAgentParentResumeMessage('completion', live);
}

async function adapterDeliver(
  chatId: string,
  message: string,
  meta: { kind: string; runIds: string[] },
): Promise<void> {
  const deliver = deliverHook ?? defaultDeliverResume;
  await deliver(chatId, message, meta.runIds);
}

function adapterNotify(chatId: string, run: RunState): void {
  const live = getSubAgentRun(run.runId) ?? foldRunToSubAgentRun(run);
  if (notifyHook) {
    notifyHook(chatId, live);
    return;
  }
  void import('../state/sub-agent-session-sync')
    .then((m) => m.persistSubAgentRunSnapshot(live))
    .catch((err) => reportBackgroundError('sub-agent-completion-persist', err));

  void import('../notifications/push')
    .then(({ pushNotification }) => {
      const summary = live.summary?.trim() || live.error?.trim() || '';
      pushNotification({
        kind: live.status === 'completed' ? 'sub_agent_complete' : 'sub_agent_failed',
        title: `Background ${live.type} ${live.status}`,
        preview: summary.slice(0, 280) || 'Finished with no summary',
        chatId,
        appId: 'code',
        dedupeKey: `sub-agent-completion:${live.runId}`,
      });
    })
    .catch((err) => reportBackgroundError('sub-agent-completion-notify', err));
}

async function defaultDeliverResume(
  chatId: string,
  message: string,
  _runIdsToMark: string[],
): Promise<void> {
  const chat = findChatById(chatId);
  if (!chat) throw new Error('Parent chat is unavailable');
  const { ensureChatHistoryLoaded } = await import('../state/sessions');
  await ensureChatHistoryLoaded(chatId);
  const { resumeParentChatWithMessage } = await import('../chat/run-turn-chat');
  const accepted = await resumeParentChatWithMessage(chat, message, { suppressUserEcho: true });
  if (!accepted) throw new Error('Parent chat did not accept the sub-agent completion');
  const { persistSessionsBeforeDeliveryAck } = await import('../state/sessions');
  if (!(await persistSessionsBeforeDeliveryAck())) {
    throw new Error('Parent chat completion could not be persisted');
  }
}

// ── Hooks ────────────────────────────────────────────────────────────────────

export function setSubAgentCompletionDeliverHook(fn: CompletionDeliverFn | null): void {
  deliverHook = fn;
}

export function setSubAgentCompletionNotifyHook(fn: CompletionNotifyFn | null): void {
  notifyHook = fn;
}

export function setSubAgentDeliveryHandleForTests(handle: DeliveryHandle | null): void {
  delivery = handle;
}

function parseRequestedAt(run: SubAgentRun): number {
  if (!run.startedAt) return 0;
  const ms = Date.parse(run.startedAt);
  return Number.isSafeInteger(ms) ? ms : 0;
}

// ── Ingest ───────────────────────────────────────────────────────────────────

async function ingestControllerRun(run: SubAgentRun): Promise<void> {
  if (!delivery) return;
  const chatId = run.parentChatId?.trim();
  if (!chatId) return;
  const journal = delivery.journal;
  const state = await journal.loadState(chatId);
  let rec = state.runs.get(run.runId);

  if (!rec) {
    await journal.appendEvent(
      chatId,
      makeEvent('run.requested', {
        runId: run.runId,
        agentType: run.type,
        task: run.task ?? '',
        parentChatId: chatId,
        cwd: findChatById(chatId)?.workspacePath ?? '',
        requestedAt: parseRequestedAt(run),
      }),
    );
    rec = (await journal.loadState(chatId)).runs.get(run.runId);
  }
  if (!rec) return;

  if (isSubAgentRunTerminal(run.status) && !isTerminal(rec)) {
    if (run.status === 'cancelled') {
      await journal.appendEvent(chatId, makeEvent('run.cancelled', { runId: run.runId, reason: 'user' }));
      return;
    }
    if (run.status === 'completed') {
      const attemptId = rec.attempts[0]?.attemptId ?? `ingest-${run.runId}`;
      if (rec.attempts.length === 0) {
        await journal.appendEvent(
          chatId,
          makeEvent('attempt.started', { runId: run.runId, attemptId, seed: { kind: 'initial' } }),
        );
      }
      const open = (await journal.loadState(chatId)).runs.get(run.runId);
      const id = open?.attempts.find((a) => !a.ended)?.attemptId ?? attemptId;
      await journal.appendEvent(
        chatId,
        makeEvent('attempt.ended', {
          runId: run.runId,
          attemptId: id,
          outcome: 'pass',
          summary: run.summary ?? '',
        }),
      );
      return;
    }
    await journal.appendEvent(
      chatId,
      makeEvent('run.abandoned', { runId: run.runId, reason: 'failed' }),
    );
    return;
  }

  if (
    (run.status === 'running' || run.status === 'queued') &&
    !isTerminal(rec) &&
    !rec.attempts.some((a) => !a.ended)
  ) {
    await journal.appendEvent(
      chatId,
      makeEvent('attempt.started', {
        runId: run.runId,
        attemptId: `ingest-${run.runId}`,
        seed: { kind: 'initial' },
      }),
    );
  }
}

function follow(work: () => Promise<void>): Promise<void> {
  ingestChain = ingestChain.then(work, work);
  return ingestChain;
}

async function ingestAndTick(run: SubAgentRun): Promise<void> {
  await ingestControllerRun(run);
  const chatId = run.parentChatId?.trim();
  if (chatId && delivery) await delivery.tick(chatId);
}

function onSubAgentRunUpdated(run: SubAgentRun): void {
  if (!delivery) return;
  if (!run.parentChatId) return;
  if (!isSubAgentRunTerminal(run.status)) return;
  void follow(() => ingestAndTick(run));
}

async function resumeDeliverFrame(frame: DeliverFrame & { parentChatId: string }): Promise<void> {
  const chatId = frame.parentChatId;
  const key = deliveryKey(frame);
  const chat = findChatById(chatId);
  if (!chat) {
    const run = getSubAgentRun(frame.runIds[0] ?? '');
    if (run && notifyHook) notifyHook(chatId, run);
    queuedDeliveryKeys.delete(key);
    return;
  }
  try {
    if (frame.kind === 'check_in_nudge') {
      const deliver = deliverHook ?? defaultDeliverResume;
      await deliver(chatId, frame.message, frame.runIds);
      return;
    }
    if (!resumedDeliveryKeys.has(key)) {
      const deliver = deliverHook ?? defaultDeliverResume;
      await deliver(chatId, frame.message, frame.runIds);
      resumedDeliveryKeys.add(key);
    }
    await acknowledgeSubAgentDelivery(chatId, frame.runIds);
    resumedDeliveryKeys.delete(key);
  } finally {
    queuedDeliveryKeys.delete(key);
  }
}

function onDeliverFrame(frame: DeliverFrame & { runId: string }): void {
  const parentChatId =
    (frame as DeliverFrame & { parentChatId?: string }).parentChatId ??
    getSubAgentRun(frame.runId)?.parentChatId ??
    '';
  if (!parentChatId) return;
  const packed = { ...frame, parentChatId };
  const key = deliveryKey(packed);
  if (queuedDeliveryKeys.has(key)) return;
  queuedDeliveryKeys.add(key);
  if (isChatStreaming(parentChatId)) {
    const queued = delayedByChat.get(parentChatId) ?? [];
    queued.push(packed);
    delayedByChat.set(parentChatId, queued);
    return;
  }
  void follow(() => resumeDeliverFrame(packed)).catch((err) => {
    reportBackgroundError('sub-agent-completion-deliver', err);
  });
}

// ── Flush ────────────────────────────────────────────────────────────────────

async function flushDelayed(chatId: string): Promise<void> {
  const queued = delayedByChat.get(chatId) ?? [];
  delayedByChat.delete(chatId);
  for (const frame of queued) await resumeDeliverFrame(frame);
}

export function flushAllPendingSubAgentCompletions(): void {
  void follow(async () => {
    for (const chatId of [...delayedByChat.keys()]) await flushDelayed(chatId);
    if (delivery) await delivery.tickAll();
  });
}

export function fireSubAgentCheckInNudge(runId: string): Promise<void> {
  const run = getSubAgentRun(runId);
  if (!run?.parentChatId) return Promise.resolve();
  if (run.status !== 'running' && run.status !== 'queued') return Promise.resolve();
  if (!delivery) return Promise.resolve();
  const handle = delivery;
  return follow(async () => {
    await ingestControllerRun(run);
    await handle.offerNudge({
      parentChatId: run.parentChatId as string,
      runId,
      elapsedSec: elapsedSeconds(run),
    });
  });
}

function elapsedSeconds(run: SubAgentRun): number {
  if (!run.startedAt) return 0;
  const start = Date.parse(run.startedAt);
  if (!Number.isFinite(start)) return 0;
  return Math.max(0, Math.round((Date.now() - start) / 1000));
}

// ── Init ─────────────────────────────────────────────────────────────────────

export function initSubAgentCompletionPush(): void {
  if (pushInitialized) return;
  pushInitialized = true;

  subscribeSubAgentRuns((run) => {
    onSubAgentRunUpdated(run);
  });

  subscribeSubAgentDeliver((frame) => {
    onDeliverFrame(frame);
  });

  subscribeChatStreamEnd((chatId) => {
    void follow(async () => {
      await flushDelayed(chatId);
      if (delivery) await delivery.tick(chatId);
    });
  });
}

export function resetSubAgentCompletionPushForTests(): void {
  pushInitialized = false;
  deliverHook = null;
  notifyHook = null;
  ingestChain = Promise.resolve();
  delayedByChat.clear();
  queuedDeliveryKeys.clear();
  resumedDeliveryKeys.clear();
  delivery?.reset();
  delivery = createAdapterDelivery();
}

export async function flushSubAgentCompletionPushForChat(chatId: string): Promise<void> {
  await ingestChain;
  await flushDelayed(chatId);
  if (delivery) await delivery.tick(chatId);
}

export function resolveSubAgentRunForParentSession(
  runId: string,
  parentChatId: string,
): SubAgentRun | undefined {
  const live = getSubAgentRun(runId);
  if (live) return live;
  const chat = findChatById(parentChatId);
  const row = chat?.subAgentRuns?.find((r) => r.runId === runId);
  if (!row) return undefined;
  return persistedRowToSubAgentRun(row, parentChatId);
}

function persistedRowToSubAgentRun(
  row: PersistedSubAgentRun,
  parentChatId: string,
): SubAgentRun {
  return {
    runId: row.runId,
    type: row.type,
    task: row.task,
    status: row.status,
    parentChatId,
    parentToolCallId: row.parentToolCallId ?? null,
    parentTurnId: row.parentTurnId ?? null,
    summary: row.summary,
    structuredOutcome: row.structuredOutcome,
    budgetEvents: row.budgetEvents,
    error: row.error ?? null,
    startedAt: row.startedAt ?? null,
    endedAt: row.endedAt ?? null,
    toolTurns: row.toolTurns,
    cancelled: row.status === 'cancelled',
    messages: row.messages as SubAgentRun['messages'],
    category: row.category,
    boardTaskId: row.boardTaskId,
  };
}

export async function adapterDeliveryStateForTests(parentChatId: string) {
  if (!delivery?.journal.readEvents) {
    return derive([]);
  }
  return derive((await delivery.journal.readEvents(parentChatId)) ?? []);
}

import { foldInto, emptyState } from '../../server/sub-agents/derive.js';
import type { RunState } from '../../server/sub-agents/types';
import { applyTurnEventToMessages } from '../../server/orchestrator/transcript-messages.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface EventStream {
  addEventListener(type: string, listener: (event: { data: string }) => void): void;
  close(): void;
}

export interface SubAgentRunClientOptions {
  openStream?: (url: string) => EventStream;
  initialRun?: Record<string, unknown> | null;
  initialSeq?: number;
}

// ── Live frames ──────────────────────────────────────────────────────────────

export function liveFrameBelongsToRun(
  payload: { taskId?: unknown; attemptId?: unknown },
  runId: string,
  raw: Record<string, unknown> | null,
): boolean {
  if (payload.taskId !== runId) return false;
  const attemptId = typeof payload.attemptId === 'string' ? payload.attemptId : '';
  if (!raw) return true;
  const attempts = Array.isArray(raw.attempts) ? raw.attempts : [];
  const phase = (raw as { phase?: unknown }).phase;
  const foldSettled =
    phase === 'passed' || phase === 'cancelled' || phase === 'abandoned';
  if (attempts.length === 0) {
    if (foldSettled) return false;
    return true;
  }
  if (!attemptId) {
    return attempts.some((row) => {
      if (!row || typeof row !== 'object') return false;
      return (row as { ended?: unknown }).ended !== true;
    });
  }
  const open = attempts.find((row) => {
    if (!row || typeof row !== 'object') return false;
    return (row as { ended?: unknown }).ended !== true;
  }) as { attemptId?: unknown } | undefined;
  if (typeof open?.attemptId === 'string' && open.attemptId) {
    return attemptId === open.attemptId;
  }
  return !attempts.some((row) => {
    if (!row || typeof row !== 'object') return false;
    const rec = row as { attemptId?: unknown; ended?: unknown };
    return rec.attemptId === attemptId && rec.ended === true;
  });
}

export function isReplayedLiveFrame(
  payload: { seq?: unknown; attemptId?: unknown },
  raw: Record<string, unknown> | null,
): boolean {
  if (typeof payload.seq === 'number' && Number.isSafeInteger(payload.seq)) return true;
  if (!raw) return false;
  const attempts = Array.isArray(raw.attempts) ? raw.attempts : [];
  const attemptId = typeof payload.attemptId === 'string' ? payload.attemptId : '';
  if (!attemptId) return false;
  const match = attempts.find((row) => {
    if (!row || typeof row !== 'object') return false;
    return (row as { attemptId?: unknown }).attemptId === attemptId;
  }) as { ended?: unknown; outcome?: unknown } | undefined;
  return match?.ended === true && match.outcome != null;
}

export function shouldPaintLiveFrame(
  payload: { taskId?: unknown; attemptId?: unknown; seq?: unknown },
  runId: string,
  raw: Record<string, unknown> | null,
): boolean {
  if (isReplayedLiveFrame(payload, raw)) return false;
  return liveFrameBelongsToRun(payload, runId, raw);
}

export interface EngineError {
  taskId: string | null;
  role: string;
  message: string;
  consecutive: number;
}

export interface DeliverFrame {
  kind: 'completion' | 'check_in_nudge';
  runIds: string[];
  message: string;
}

export interface SubAgentRunClient {
  readonly runId: string;
  getRun(): Record<string, unknown> | null;
  getSeq(): number;
  getEngineError(): EngineError | null;
  getLive(): {
    phase: string | null;
    toolName: string | null;
    thinking: string;
    partialText: string;
    messages: unknown[];
  };
  seedMessages(messages: unknown[]): void;
  subscribe(listener: () => void): () => void;
  subscribeDeliver(listener: (frame: DeliverFrame) => void): () => void;
  connect(): void;
  close(): void;
}

// ── Client ───────────────────────────────────────────────────────────────────

export function createSubAgentRunClient(
  runId: string,
  options: SubAgentRunClientOptions = {},
): SubAgentRunClient {
  const openStream =
    options.openStream ?? ((url: string) => new EventSource(url) as EventStream);

  let raw: Record<string, unknown> | null = options.initialRun ?? null;
  let seq = Number.isSafeInteger(options.initialSeq) ? Number(options.initialSeq) : 0;
  let engineError: EngineError | null = null;
  let livePhase: string | null = null;
  let liveTool: string | null = null;
  let liveThinking = '';
  let livePartialText = '';
  let liveMessages: unknown[] = [];
  let source: EventStream | null = null;
  let pending: Record<string, unknown>[] = [];
  const listeners = new Set<() => void>();
  const deliverListeners = new Set<(frame: DeliverFrame) => void>();

  const emit = () => {
    for (const listener of listeners) {
      try {
        listener();
      } catch (err) {
        console.error('[agents] run subscriber threw', err);
      }
    }
  };

  const applyEvent = (event: Record<string, unknown>): boolean => {
    const eventSeq = Number(event.seq);
    if (Number.isSafeInteger(eventSeq) && eventSeq <= seq) return false;
    if (event.type === 'attempt.started') {
      engineError = null;
      liveMessages = [];
      livePartialText = '';
      liveThinking = '';
      livePhase = null;
      liveTool = null;
    }
    const state = emptyState();
    if (raw) {
      const existing = foldRun(raw);
      if (existing) {
        state.runs.set(existing.runId, existing);
        state.runOrder = [existing.runId];
        state.parentChatId = existing.parentChatId;
      }
    }
    foldInto(state, [event]);
    const next = state.runs.get(runId);
    if (next) raw = runToRaw(next);
    if (Number.isSafeInteger(eventSeq)) seq = eventSeq;
    return true;
  };

  const drainPending = (): boolean => {
    if (pending.length === 0) return false;
    const queued = pending;
    pending = [];
    let changed = false;
    for (const event of queued) changed = applyEvent(event) || changed;
    return changed;
  };

  const onSnapshot = (event: { data: string }) => {
    try {
      const payload = JSON.parse(event.data);
      if (payload?.run?.runId !== runId) return;
      const at = Number(payload.seq) || 0;
      if (raw !== null && at < seq) return;
      raw = payload.run && typeof payload.run === 'object' ? payload.run : null;
      seq = at;
      drainPending();
      emit();
    } catch (err) {
      console.error('[agents] could not read the run snapshot', err);
    }
  };

  const onEvent = (event: { data: string }) => {
    try {
      const journalEvent = JSON.parse(event.data);
      if (journalEvent?.runId !== runId) return;
      if (!raw) {
        pending.push(journalEvent);
        return;
      }
      if (applyEvent(journalEvent)) emit();
    } catch (err) {
      console.error('[agents] could not fold a run event', err);
    }
  };

  const onLive = (event: { data: string }) => {
    try {
      const payload = JSON.parse(event.data) as {
        seq?: unknown;
        taskId?: unknown;
        attemptId?: unknown;
        event?: {
          type?: string;
          name?: string;
          text?: string;
          phase?: string;
          id?: string;
          arguments?: unknown;
          content?: string;
        };
      };
      if (!shouldPaintLiveFrame(payload, runId, raw)) return;
      const inner = payload.event;
      if (!inner?.type) return;
      if (inner.type === 'phase') {
        const next = inner.phase;
        if (next === 'thinking' || next === 'generating' || next === 'tools') {
          livePhase = next;
          if (next !== 'tools') liveTool = null;
          emit();
        }
        return;
      }
      if (inner.type === 'delta') {
        livePhase = 'generating';
        if (typeof inner.text === 'string') livePartialText = inner.text.slice(-400);
        emit();
        return;
      }
      if (inner.type === 'tool_call' || inner.type === 'tool_streaming') {
        livePhase = 'tools';
        liveTool = typeof inner.name === 'string' ? inner.name : liveTool;
        livePartialText = '';
        if (inner.type === 'tool_call') {
          liveMessages = applyTurnEventToMessages(liveMessages, inner);
        }
        emit();
        return;
      }
      if (inner.type === 'tool_result') {
        liveTool = null;
        livePhase = 'generating';
        liveMessages = applyTurnEventToMessages(liveMessages, inner);
        emit();
        return;
      }
      if (inner.type === 'round_end') {
        livePartialText = '';
        livePhase = 'generating';
        liveMessages = applyTurnEventToMessages(liveMessages, inner);
        emit();
        return;
      }
      if (inner.type === 'thinking') {
        livePhase = 'thinking';
        if (typeof inner.text === 'string') {
          liveThinking = inner.text.slice(-400);
          liveMessages = applyTurnEventToMessages(liveMessages, inner);
        }
        emit();
      }
    } catch (err) {
      console.error('[agents] could not read a live frame', err);
    }
  };

  const onError = (event: { data: string }) => {
    if (typeof event?.data !== 'string' || event.data.length === 0) return;
    try {
      const payload = JSON.parse(event.data) as Partial<EngineError> & { error?: string };
      if (typeof payload.message !== 'string') return;
      if (payload.taskId !== runId) return;
      engineError = {
        taskId: typeof payload.taskId === 'string' ? payload.taskId : runId,
        role: String(payload.role ?? 'sub-agent'),
        message: payload.message,
        consecutive: Number(payload.consecutive) || 1,
      };
      emit();
    } catch (err) {
      console.error('[agents] could not read an engine error frame', err);
    }
  };

  return {
    runId,
    getRun: () => raw,
    getSeq: () => seq,
    getEngineError: () => engineError,
    getLive: () => ({
      phase: livePhase,
      toolName: liveTool,
      thinking: liveThinking,
      partialText: livePartialText,
      messages: liveMessages,
    }),
    seedMessages(messages) {
      if (liveMessages.length > 0) return;
      if (!Array.isArray(messages) || messages.length === 0) return;
      liveMessages = messages.slice();
      emit();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribeDeliver(listener) {
      deliverListeners.add(listener);
      return () => deliverListeners.delete(listener);
    },
    connect() {
      if (source) return;
      try {
        source = openStream(`/api/agents/${encodeURIComponent(runId)}/events`);
      } catch (err) {
        console.error('[agents] EventSource unavailable', err);
        return;
      }
      source.addEventListener('snapshot', onSnapshot);
      source.addEventListener('event', onEvent);
      source.addEventListener('live', onLive);
      source.addEventListener('error', onError);
      // Server sends `done` then ends the response. Close so EventSource does not reconnect.
      source.addEventListener('done', (event: { data: string }) => {
        try {
          const payload = JSON.parse(event.data) as { runId?: unknown };
          if (payload.runId !== runId) return;
        } catch {
          return;
        }
        source?.close();
        source = null;
      });
      source.addEventListener('deliver', (event: { data: string }) => {
        try {
          const payload = JSON.parse(event.data) as DeliverFrame;
          if (!payload?.message || !Array.isArray(payload.runIds)) return;
          if (!payload.runIds.includes(runId)) return;
          for (const listener of deliverListeners) {
            try {
              listener(payload);
            } catch (err) {
              console.error('[agents] deliver subscriber threw', err);
            }
          }
        } catch (err) {
          console.error('[agents] could not read a deliver frame', err);
        }
      });
      source.addEventListener('error', (event: { data: string }) => {
        if (typeof event?.data === 'string' && event.data.length > 0) return;
      });
    },
    close() {
      source?.close();
      source = null;
    },
  };
}

function foldRun(raw: Record<string, unknown>): RunState | null {
  const runId = typeof raw.runId === 'string' ? raw.runId : '';
  if (!runId) return null;
  return {
    runId,
    type: String(raw.type ?? ''),
    task: String(raw.task ?? ''),
    parentChatId: String(raw.parentChatId ?? ''),
    cwd: String(raw.cwd ?? ''),
    requestedAt: Number.isSafeInteger(raw.requestedAt) ? Number(raw.requestedAt) : null,
    phase: (raw.phase as RunState['phase']) ?? 'idle',
    attempts: Array.isArray(raw.attempts) ? (raw.attempts as RunState['attempts']) : [],
    abandonedReason: typeof raw.abandonedReason === 'string' ? raw.abandonedReason : null,
    abandonedEvidence:
      raw.abandonedEvidence && typeof raw.abandonedEvidence === 'object'
        ? (raw.abandonedEvidence as Record<string, unknown>)
        : null,
    cancelledReason: raw.cancelledReason === 'user' ? 'user' : null,
    delivered: raw.delivered === true,
    deliveredSkipReason:
      raw.deliveredSkipReason === 'missing_chat' || raw.deliveredSkipReason === 'orchestrate'
        ? raw.deliveredSkipReason
        : null,
    nudged: raw.nudged === true,
    parentTurnId: typeof raw.parentTurnId === 'string' ? raw.parentTurnId : null,
    parentToolCallId: typeof raw.parentToolCallId === 'string' ? raw.parentToolCallId : null,
    model:
      raw.model && typeof raw.model === 'object' && !Array.isArray(raw.model)
        ? (raw.model as { providerId: string; id: string })
        : null,
  };
}

function runToRaw(run: RunState): Record<string, unknown> {
  return {
    runId: run.runId,
    type: run.type,
    task: run.task,
    parentChatId: run.parentChatId,
    cwd: run.cwd,
    requestedAt: run.requestedAt,
    phase: run.phase,
    attempts: run.attempts,
    abandonedReason: run.abandonedReason,
    abandonedEvidence: run.abandonedEvidence,
    cancelledReason: run.cancelledReason,
    delivered: run.delivered,
    deliveredSkipReason: run.deliveredSkipReason,
    nudged: run.nudged,
    parentTurnId: run.parentTurnId,
    parentToolCallId: run.parentToolCallId,
    model: run.model,
  };
}

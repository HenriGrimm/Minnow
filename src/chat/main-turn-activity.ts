export type MainTurnPhase =
  | 'loading_model'
  | 'generating'
  | 'tools'
  | 'thinking'
  | 'pending_question'
  | 'waiting';

export interface MainTurnActivity {
  chatId: string;
  phase: MainTurnPhase;
  currentTool: string | null;
  workAgentLabel: string;
  modelId: string;
  providerId: string;
  startedAtMs: number;
  /** Wall clock when elapsed time was frozen for ask_question or a wait timer. */
  pausedAtMs?: number;
  /** Reason shown while the turn is parked on the wait tool. */
  waitReason?: string;
}

type MainTurnActivityListener = () => void;

const byChatId = new Map<string, MainTurnActivity>();
const listeners = new Set<MainTurnActivityListener>();

/** Register a listener; returns unsubscribe. */
export function subscribeMainTurnActivity(listener: MainTurnActivityListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notify(): void {
  for (const fn of listeners) {
    try {
      fn();
    } catch {}
  }
}

/** Read-only snapshot of all in-flight main turns. */
export function listMainTurnActivity(): MainTurnActivity[] {
  return [...byChatId.values()];
}

/** Lookup activity for one chat. */
export function getMainTurnActivity(chatId: string): MainTurnActivity | undefined {
  return byChatId.get(chatId);
}

/** Update or insert main-turn activity for a chat. */
export function emitMainTurnActivity(partial: MainTurnActivity): void {
  const existing = byChatId.get(partial.chatId);
  byChatId.set(partial.chatId, {
    chatId: partial.chatId,
    phase: partial.phase,
    currentTool: partial.currentTool ?? null,
    workAgentLabel: partial.workAgentLabel,
    modelId: partial.modelId,
    providerId: partial.providerId,
    startedAtMs: existing?.startedAtMs ?? partial.startedAtMs,
  });
  notify();
}

/** Freeze the timer and mark the turn as parked on the wait tool. */
export function pauseMainTurnActivityForWait(
  chatId: string,
  reason: string,
  nowMs = Date.now(),
): void {
  const row = byChatId.get(chatId);
  if (!row || row.phase === 'waiting') return;
  byChatId.set(chatId, {
    ...row,
    phase: 'waiting',
    currentTool: 'wait',
    pausedAtMs: nowMs,
    waitReason: reason.trim() || 'waiting',
  });
  notify();
}

/** Resume the timer after the wait tool returns; phase returns to tools. */
export function resumeMainTurnActivityFromWait(chatId: string, nowMs = Date.now()): void {
  const row = byChatId.get(chatId);
  if (!row || row.phase !== 'waiting' || row.pausedAtMs == null) return;
  const frozenElapsed = row.pausedAtMs - row.startedAtMs;
  byChatId.set(chatId, {
    ...row,
    phase: 'tools',
    currentTool: 'wait',
    startedAtMs: nowMs - frozenElapsed,
    pausedAtMs: undefined,
    waitReason: undefined,
  });
  notify();
}

/** Elapsed ms for a row, respecting ask_question and wait pauses. */
export function mainTurnActivityElapsedMs(row: MainTurnActivity, nowMs: number): number {
  if (row.pausedAtMs != null) {
    return Math.max(0, row.pausedAtMs - row.startedAtMs);
  }
  return Math.max(0, nowMs - row.startedAtMs);
}

/** Freeze the timer and mark the turn as waiting on ask_question. */
export function pauseMainTurnActivityForQuestion(chatId: string, nowMs = Date.now()): void {
  const row = byChatId.get(chatId);
  if (!row || row.phase === 'pending_question') return;
  byChatId.set(chatId, {
    ...row,
    phase: 'pending_question',
    currentTool: 'ask_question',
    pausedAtMs: nowMs,
  });
  notify();
}

/** Resume the timer after ask_question; phase returns to tools until the tool finishes. */
export function resumeMainTurnActivityFromQuestion(chatId: string, nowMs = Date.now()): void {
  const row = byChatId.get(chatId);
  if (!row || row.pausedAtMs == null) return;
  const frozenElapsed = row.pausedAtMs - row.startedAtMs;
  byChatId.set(chatId, {
    ...row,
    phase: 'tools',
    currentTool: 'ask_question',
    startedAtMs: nowMs - frozenElapsed,
    pausedAtMs: undefined,
  });
  notify();
}

/** Patch phase/tool without resetting startedAtMs. */
export function patchMainTurnActivity(
  chatId: string,
  patch: Partial<Pick<MainTurnActivity, 'phase' | 'currentTool' | 'workAgentLabel' | 'modelId' | 'providerId'>>,
): void {
  const row = byChatId.get(chatId);
  if (!row) return;
  // A parked turn (question or wait) keeps its phase until its own resume helper runs.
  if (
    (row.phase === 'pending_question' || row.phase === 'waiting') &&
    patch.phase != null &&
    patch.phase !== row.phase
  ) {
    return;
  }
  byChatId.set(chatId, {
    ...row,
    ...patch,
    currentTool: patch.currentTool !== undefined ? patch.currentTool : row.currentTool,
  });
  notify();
}

/** Remove activity when the turn ends. */
export function clearMainTurnActivity(chatId: string): void {
  if (!byChatId.delete(chatId)) return;
  notify();
}

/** Reset store (tests). */
export function resetMainTurnActivity(): void {
  byChatId.clear();
  listeners.clear();
}

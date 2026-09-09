import type { DiffLine } from '../chat/prompts/text-diff';
import { foldInto } from '../../server/orchestrator/core/derive.js';
import { stateFromJSON } from '../../server/orchestrator/core/snapshot.js';
import { readDisplayedBoardModelSeed } from './board-model-bind';
import type {
  Attempt,
  BoardState,
  ParseError,
  TaskState,
} from '../../server/orchestrator/core/types';

// ── Types ────────────────────────────────────────────────────────────────────

export interface BoardSummary {
  boardId: string;
  name: string;
  planPath: string;
  /** Stamped workspace; null/absent on journals written before MIN-752. */
  workspacePath?: string | null;
  status: BoardState['status'];
  concurrency: number;
  taskCount: number;
  finished: boolean;
}

export interface EventStream {
  addEventListener(type: string, listener: (event: { data: string }) => void): void;
  close(): void;
}

export interface BoardClientOptions {
  openStream?: (url: string) => EventStream;
}

/** What an agent is doing right now, for the card's activity line. */
export interface LiveActivity {
  attemptId: string;
  role: string;
  /** A tool the agent is running, a thought it is having, or prose it is writing. */
  kind: 'tool' | 'thinking' | 'writing';
  /** Tool name for `tool`, the thought itself for `thinking`, empty for `writing`. */
  text: string;
  /** True once the tool came back, so the card can stop saying "running". */
  settled: boolean;
  /**
   * The model is still streaming this call's arguments — it has named the tool
   * but has not finished asking for it. Writing a long argument (a file, a
   * patch) can take minutes, and with nothing marking that window the card sat
   * on the last thought and read as hung.
   */
  preparing?: boolean;
}

export interface EngineError {
  taskId: string | null;
  role: string;
  message: string;
  /** How many ticks in a row this has failed. 40 of these is a different story from 1. */
  consecutive: number;
}

export interface BoardClient {
  readonly boardId: string;
  getState(): BoardState | null;
  isConnected(): boolean;
  getSeq(): number;
  getLiveActivity(): ReadonlyMap<string, LiveActivity>;
  /** When each in-flight attempt started, keyed by attempt id. */
  getAttemptStartedAt(): ReadonlyMap<string, number>;
  getEngineErrors(): ReadonlyMap<string, EngineError>;
  subscribe(listener: (state: BoardState | null) => void): () => void;
  /**
   * Thinking and in-flight tool frames. These must not go through `subscribe`:
   * the board view patches cards and the open thread in place instead of
   * tearing the overlay down on every token.
   */
  subscribeLive(listener: () => void): () => void;
  connect(): void;
  close(): void;

  start(concurrency?: number): Promise<void>;
  stop(): Promise<void>;
  setConcurrency(n: number): Promise<void>;
  startTask(taskId: string): Promise<boolean>;
  abandonTask(taskId: string): Promise<boolean>;
  resetTask(taskId: string): Promise<{ ok: boolean; taskIds: string[]; error?: string }>;
  rewindTask(taskId: string): Promise<{ ok: boolean; taskIds: string[]; error?: string }>;
  setModel(model: { providerId: string; id: string; reasoning?: string | null }): Promise<void>;
  rename(name: string): Promise<void>;
  /** Reopen failed work after a finish. 409 is an answer, not a throw. */
  rerun(taskIds?: string[], concurrency?: number): Promise<{ ok: boolean; taskIds: string[] }>;
}

export class PlanParseFailure extends Error {
  readonly errors: ParseError[];

  constructor(message: string, errors: ParseError[]) {
    super(message);
    this.name = 'PlanParseFailure';
    this.errors = errors;
  }
}

// ── Request ──────────────────────────────────────────────────────────────────

async function request(path: string, init?: RequestInit): Promise<any> {
  const response = await fetch(`/api/boards${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const text = await response.text();
  let body: any = null;
  try {
    body = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!response.ok) {
    if (Array.isArray(body?.errors)) {
      throw new PlanParseFailure(body.detail ?? body.error ?? 'the plan does not parse', body.errors);
    }
    throw new Error(body?.error ?? `${response.status} from /api/boards${path}`);
  }
  return body;
}

async function postTaskWipe(
  url: string,
): Promise<{ ok: boolean; taskIds: string[]; error?: string }> {
  const response = await fetch(url, { method: 'POST' });
  let body: { ok?: boolean; taskIds?: string[]; error?: string } = {};
  try {
    body = (await response.json()) as typeof body;
  } catch {
    body = {};
  }
  if (response.status === 409) {
    return { ok: false, taskIds: body.taskIds ?? [], error: body.error };
  }
  if (!response.ok) {
    throw new Error(body.error ?? `${response.status} from ${url}`);
  }
  return { ok: true, taskIds: body.taskIds ?? [] };
}

// ── Freeze ───────────────────────────────────────────────────────────────────

function readOnlyState(state: BoardState): BoardState {
  const tasks = new Map<string, TaskState>();
  for (const [id, task] of state.tasks) tasks.set(id, freezeTask(task));

  const copy: BoardState = {
    boardId: state.boardId,
    name: state.name,
    planPath: state.planPath,
    workspacePath: state.workspacePath ?? null,
    waves: Object.freeze(state.waves.map((w) => Object.freeze({ ...w }))) as BoardState['waves'],
    status: state.status,
    concurrency: state.concurrency,
    tasks: sealMap(tasks),
    taskOrder: Object.freeze([...state.taskOrder]) as string[],
    mergeQueue: Object.freeze([...state.mergeQueue]) as string[],
    integrationSha: state.integrationSha,
    model: state.model === null ? null : Object.freeze({ ...state.model }),
    finalTest: state.finalTest === null ? null : Object.freeze({ ...state.finalTest }),
    finished: state.finished,
    stopReason: state.stopReason,
    runSummary: state.runSummary,
    rerun:
      state.rerun === null || state.rerun === undefined
        ? null
        : Object.freeze({
            ...state.rerun,
            taskIds: Object.freeze([...state.rerun.taskIds]) as string[],
            previousFinalTest:
              state.rerun.previousFinalTest === null
                ? null
                : Object.freeze({ ...state.rerun.previousFinalTest }),
          }),
  };
  return Object.freeze(copy);
}

function freezeTask(task: TaskState): TaskState {
  return Object.freeze({
    ...task,
    dependsOn: Object.freeze([...task.dependsOn]) as string[],
    touches: Object.freeze([...task.touches]) as string[],
    touchesExpanded:
      task.touchesExpanded === null || task.touchesExpanded === undefined
        ? null
        : (Object.freeze([...task.touchesExpanded]) as string[]),
    emptyTouchesGlobs: Object.freeze([...(task.emptyTouchesGlobs ?? [])]) as string[],
    attempts: Object.freeze(
      task.attempts.map((a) => Object.freeze({ ...a }) as Attempt),
    ) as Attempt[],
    touchesOverflow: Object.freeze(
      task.touchesOverflow.map((o) =>
        Object.freeze({
          ...o,
          declared: Object.freeze([...o.declared]),
          actual: Object.freeze([...o.actual]),
        }),
      ),
    ) as TaskState['touchesOverflow'],
  });
}

/** Make a Map read-only for real, not just non-extensible. */
function sealMap<K, V>(map: Map<K, V>): Map<K, V> {
  const refuse = () => {
    throw new TypeError('the board state is a view and cannot be written to');
  };
  Object.defineProperties(map, {
    set: { value: refuse },
    delete: { value: refuse },
    clear: { value: refuse },
  });
  return Object.freeze(map);
}

// ── REST ─────────────────────────────────────────────────────────────────────

export async function listBoards(): Promise<BoardSummary[]> {
  const body = await request('');
  return body.boards ?? [];
}

export async function createBoardFromPlan(
  planPath: string,
  options: { boardId?: string; markdown?: string; providerId?: string; id?: string } = {},
): Promise<{ boardId: string; state: BoardState }> {
  const seeded =
    options.providerId?.trim() && options.id?.trim()
      ? { providerId: options.providerId.trim(), id: options.id.trim() }
      : readDisplayedBoardModelSeed();
  const body = await request('', {
    method: 'POST',
    body: JSON.stringify({
      planPath,
      ...options,
      ...(seeded ? { providerId: seeded.providerId, id: seeded.id } : {}),
    }),
  });
  return { boardId: body.boardId, state: stateFromJSON(body.state) };
}

export async function readJournal(
  boardId: string,
  options: { since?: number; limit?: number } = {},
): Promise<{ events: Record<string, unknown>[]; truncated: boolean }> {
  const query = new URLSearchParams();
  if (options.since !== undefined && options.since > 0) query.set('since', String(options.since));
  if (options.limit !== undefined && options.limit > 0) query.set('limit', String(options.limit));
  const suffix = query.toString() ? `?${query}` : '';
  const body = await request(`/${encodeURIComponent(boardId)}/journal${suffix}`);
  return { events: body.events ?? [], truncated: Boolean(body.truncated) };
}

export async function readAttemptTranscript(
  boardId: string,
  attemptId: string,
  options: { limit?: number } = {},
): Promise<{ events: Record<string, unknown>[]; truncated: boolean; capped: boolean }> {
  const query = options.limit && options.limit > 0 ? `?limit=${options.limit}` : '';
  const body = await request(
    `/${encodeURIComponent(boardId)}/attempts/${encodeURIComponent(attemptId)}${query}`,
  );
  return {
    events: body.events ?? [],
    truncated: Boolean(body.truncated),
    capped: Boolean(body.capped),
  };
}

// ── Files ────────────────────────────────────────────────────────────────────

export interface TaskFileStat {
  path: string;
  additions: number;
  deletions: number;
  binary: boolean;
}

export interface TaskFilesResult {
  source: 'merged' | 'planned';
  sha: string | null;
  files: TaskFileStat[];
  additions: number;
  deletions: number;
  truncated: boolean;
}

export async function readTaskFiles(
  boardId: string,
  taskId: string,
): Promise<TaskFilesResult> {
  const body = await request(
    `/${encodeURIComponent(boardId)}/tasks/${encodeURIComponent(taskId)}/files`,
  );
  return {
    source: body.source === 'merged' ? 'merged' : 'planned',
    sha: typeof body.sha === 'string' ? body.sha : null,
    files: Array.isArray(body.files) ? body.files : [],
    additions: Number(body.additions) || 0,
    deletions: Number(body.deletions) || 0,
    truncated: Boolean(body.truncated),
  };
}

export async function readTaskFileDiff(
  boardId: string,
  taskId: string,
  filePath: string,
): Promise<{ lines: DiffLine[]; truncated: boolean } | null> {
  const body = await request(
    `/${encodeURIComponent(boardId)}/tasks/${encodeURIComponent(taskId)}/files` +
      `?path=${encodeURIComponent(filePath)}`,
  );
  const file = body.file;
  if (!file || !Array.isArray(file.lines)) return null;
  return { lines: file.lines as DiffLine[], truncated: Boolean(file.truncated) };
}

export async function deleteBoard(boardId: string): Promise<void> {
  await request(`/${encodeURIComponent(boardId)}`, { method: 'DELETE' });
}

/** Stop a running board by id — used by workspace switch (MIN-752) without a live client. */
export async function stopBoard(boardId: string): Promise<void> {
  await request(`/${encodeURIComponent(boardId)}/stop`, { method: 'POST' });
}

export async function readBoardReport(
  boardId: string,
): Promise<{ markdown: string; path: string }> {
  const body = await request(`/${encodeURIComponent(boardId)}/report`);
  return { markdown: String(body.markdown ?? ''), path: String(body.path ?? 'report.md') };
}

// ── List client ──────────────────────────────────────────────────────────────

export interface BoardListClient {
  getBoards(): BoardSummary[];
  getError(): Error | null;
  subscribe(listener: (boards: BoardSummary[]) => void): () => void;
  refresh(): Promise<void>;
  start(): void;
  stop(): void;
}

export function createBoardListClient(
  options: { intervalMs?: number; fetchBoards?: () => Promise<BoardSummary[]> } = {},
): BoardListClient {
  const intervalMs = options.intervalMs ?? 5_000;
  const fetchBoards = options.fetchBoards ?? listBoards;
  const listeners = new Set<(boards: BoardSummary[]) => void>();

  let boards: BoardSummary[] = [];
  let error: Error | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let signature = '';

  const emit = () => {
    for (const listener of listeners) {
      try {
        listener(boards);
      } catch (err) {
        console.error('[orchestrator] board-list subscriber threw', err);
      }
    }
  };

  const refresh = async () => {
    try {
      const next = await fetchBoards();
      error = null;
      const nextSignature = JSON.stringify(next);
      if (nextSignature === signature) return;
      signature = nextSignature;
      boards = Object.freeze(next.map((b) => Object.freeze({ ...b }))) as BoardSummary[];
      emit();
    } catch (err) {
      error = err instanceof Error ? err : new Error(String(err));
    }
  };

  return {
    getBoards: () => boards,
    getError: () => error,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refresh,
    start() {
      if (timer !== null) return;
      void refresh();
      timer = setInterval(() => void refresh(), intervalMs);
    },
    stop() {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    },
  };
}

// ── Board client ─────────────────────────────────────────────────────────────

export function createBoardClient(
  boardId: string,
  options: BoardClientOptions = {},
): BoardClient {
  const openStream = options.openStream ?? ((url: string) => new EventSource(url) as EventStream);

  let internal: BoardState | null = null;
  let view: BoardState | null = null;
  let seq = 0;
  const liveActivity = new Map<string, LiveActivity>();
  /*
   * View-only, and deliberately outside `BoardState`: the fold is a pure
   * function of the journal and must not vary with timestamps. Filled from the
   * `task.attempt.started` line's own `ts`, and from the snapshot's sidecar so
   * a clock survives a reload mid-attempt.
   */
  const attemptStartedAt = new Map<string, number>();
  const engineErrors = new Map<string, EngineError>();

  let source: EventStream | null = null;
  let connected = false;

  let pending: Record<string, unknown>[] = [];

  const listeners = new Set<(state: BoardState | null) => void>();
  const liveListeners = new Set<() => void>();

  const emit = () => {
    for (const listener of listeners) {
      try {
        listener(view);
      } catch (err) {
        console.error('[orchestrator] board subscriber threw', err);
      }
    }
  };

  /** Notify live-activity listeners without a journal/state paint. */
  const emitLiveActivity = () => {
    for (const listener of liveListeners) {
      try {
        listener();
      } catch (err) {
        console.error('[orchestrator] board live subscriber threw', err);
      }
    }
  };

  const publish = () => {
    view = internal === null ? null : readOnlyState(internal);
    emit();
  };

  const applyEvent = (event: Record<string, unknown>): boolean => {
    if (!internal) return false;
    const eventSeq = Number(event.seq);
    if (Number.isSafeInteger(eventSeq) && eventSeq <= seq) return false;
    if (event.type === 'task.attempt.started' || event.type === 'merge.enqueued') {
      const attemptId = typeof event.attemptId === 'string' ? event.attemptId : '';
      if (attemptId && typeof event.ts === 'number') attemptStartedAt.set(attemptId, event.ts);
    }
    if (event.type === 'task.attempt.started') {
      engineErrors.delete(`${String(event.role ?? '')}:${String(event.taskId ?? '')}`);
      liveActivity.delete(String(event.taskId ?? ''));
    }
    if (event.type === 'task.attempt.ended') {
      // The card falls back to the attempt's own outcome; a stale "reading
      // foo.ts" under a finished task reads as if it were still working.
      liveActivity.delete(String(event.taskId ?? ''));
    }
    foldInto(internal, [event]);
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

  const adopt = (state: BoardState, at: number) => {
    if (internal !== null && at < seq) return false;
    internal = state;
    seq = at;
    drainPending();
    return true;
  };

  const onSnapshot = (event: { data: string }) => {
    try {
      const payload = JSON.parse(event.data);
      const started = payload.attemptStartedAt;
      if (started && typeof started === 'object') {
        for (const [attemptId, at] of Object.entries(started)) {
          if (typeof at === 'number') attemptStartedAt.set(attemptId, at);
        }
      }
      if (adopt(stateFromJSON(payload.state), Number(payload.seq) || 0)) publish();
    } catch (err) {
      console.error('[orchestrator] could not read the board snapshot', err);
    }
  };

  const onLive = (event: { data: string }) => {
    try {
      const payload = JSON.parse(event.data) as {
        attemptId?: string;
        taskId?: string | null;
        role?: string;
        event?: { type?: string; name?: string; text?: string; phase?: string };
      };
      const taskId = typeof payload.taskId === 'string' ? payload.taskId : null;
      if (!taskId) return;
      const inner = payload.event;
      if (!inner) return;

      const base = {
        attemptId: String(payload.attemptId ?? ''),
        role: String(payload.role ?? ''),
      };

      /*
       * `phase` is the coarse signal and always arrives before the detailed one
       * for the same stretch of work, so it may only move the card *off* a
       * finished state — never overwrite a name the detailed frame just set.
       */
      if (inner.type === 'phase') {
        const current = liveActivity.get(taskId);
        const same = current?.attemptId === base.attemptId;
        if (inner.phase === 'generating') {
          liveActivity.set(taskId, { ...base, kind: 'writing', text: '', settled: false });
        } else if (inner.phase === 'thinking') {
          if (same && current?.kind === 'thinking') return;
          liveActivity.set(taskId, { ...base, kind: 'thinking', text: '', settled: false });
        } else if (inner.phase === 'tools') {
          if (same && current?.kind === 'tool' && !current.settled) return;
          liveActivity.set(taskId, {
            ...base,
            kind: 'tool',
            text: '',
            settled: false,
            preparing: true,
          });
        } else {
          return;
        }
        emitLiveActivity();
        return;
      }

      // Thinking arrives coalesced: each frame is the thought so far, so the
      // last one wins rather than accumulating.
      if (inner.type === 'thinking') {
        const thought = typeof inner.text === 'string' ? inner.text.trim() : '';
        if (!thought) return;
        liveActivity.set(taskId, { ...base, kind: 'thinking', text: thought, settled: false });
        emitLiveActivity();
        return;
      }

      // Named but not yet asked for: the arguments are still streaming.
      if (inner.type === 'tool_streaming') {
        liveActivity.set(taskId, {
          ...base,
          kind: 'tool',
          text: typeof inner.name === 'string' ? inner.name : '',
          settled: false,
          preparing: true,
        });
        emitLiveActivity();
        return;
      }

      if (inner.type === 'tool_call' || inner.type === 'tool_result') {
        const name = typeof inner.name === 'string' && inner.name ? inner.name : inner.type;
        liveActivity.set(taskId, {
          ...base,
          kind: 'tool',
          text: name,
          settled: inner.type === 'tool_result',
        });
        emitLiveActivity();
      }
    } catch (err) {
      console.error('[orchestrator] could not read a live attempt event', err);
    }
  };

  const onError = (event: { data: string }) => {
    try {
      const payload = JSON.parse(event.data) as Partial<EngineError> & { error?: string };
      if (typeof payload.message !== 'string') return;
      const taskId = typeof payload.taskId === 'string' ? payload.taskId : null;
      const role = String(payload.role ?? '');
      engineErrors.set(`${role}:${taskId ?? ''}`, {
        taskId,
        role,
        message: payload.message,
        consecutive: Number(payload.consecutive) || 1,
      });
      emit();
    } catch (err) {
      console.error('[orchestrator] could not read an engine error frame', err);
    }
  };

  const onEvent = (event: { data: string }) => {
    try {
      const journalEvent = JSON.parse(event.data);
      if (!internal) {
        pending.push(journalEvent);
        void ensureBaseline();
        return;
      }
      if (applyEvent(journalEvent)) publish();
    } catch (err) {
      console.error('[orchestrator] could not fold a board event', err);
    }
  };

  let baselineRequest: Promise<void> | null = null;

  const ensureBaseline = () => {
    if (internal || baselineRequest) return baselineRequest ?? Promise.resolve();
    baselineRequest = (async () => {
      try {
        const body = await request(`/${encodeURIComponent(boardId)}`);
        if (adopt(stateFromJSON(body.state), 0)) publish();
      } catch (err) {
        console.error('[orchestrator] could not establish a baseline for the board', err);
      } finally {
        baselineRequest = null;
      }
    })();
    return baselineRequest;
  };

  return {
    boardId,

    getState: () => view,
    isConnected: () => connected,
    getSeq: () => seq,
    getLiveActivity: () => liveActivity,
    getAttemptStartedAt: () => attemptStartedAt,
    getEngineErrors: () => engineErrors,

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    subscribeLive(listener) {
      liveListeners.add(listener);
      return () => liveListeners.delete(listener);
    },

    connect() {
      if (source) return;
      void ensureBaseline();
      source = openStream(`/api/boards/${encodeURIComponent(boardId)}/events`);
      source.addEventListener('snapshot', onSnapshot);
      source.addEventListener('event', onEvent);
      source.addEventListener('live', onLive);
      source.addEventListener('error', onError);
      source.addEventListener('open', () => {
        connected = true;
        emit();
      });
      source.addEventListener('error', (event: { data: string }) => {
        if (typeof event?.data === 'string' && event.data.length > 0) return;
        connected = false;
        emit();
      });
    },

    close() {
      source?.close();
      source = null;
      if (!connected) return;
      connected = false;
      emit();
    },

    async start(concurrency) {
      await request(`/${encodeURIComponent(boardId)}/start`, {
        method: 'POST',
        body:
          concurrency === undefined
            ? JSON.stringify({})
            : JSON.stringify({ concurrency }),
      });
    },

    async stop() {
      await request(`/${encodeURIComponent(boardId)}/stop`, { method: 'POST' });
    },

    async setConcurrency(n) {
      await request(`/${encodeURIComponent(boardId)}/concurrency`, {
        method: 'POST',
        body: JSON.stringify({ n }),
      });
    },

    async abandonTask(taskId) {
      const response = await fetch(
        `/api/boards/${encodeURIComponent(boardId)}/tasks/${encodeURIComponent(taskId)}/abandon`,
        { method: 'POST' },
      );
      return response.ok;
    },

    async resetTask(taskId) {
      return postTaskWipe(
        `/api/boards/${encodeURIComponent(boardId)}/tasks/${encodeURIComponent(taskId)}/reset`,
      );
    },

    async rewindTask(taskId) {
      return postTaskWipe(
        `/api/boards/${encodeURIComponent(boardId)}/tasks/${encodeURIComponent(taskId)}/rewind`,
      );
    },

    async setModel(model) {
      await request(`/${encodeURIComponent(boardId)}/model`, {
        method: 'POST',
        body: JSON.stringify({
          providerId: model.providerId,
          id: model.id,
          ...(model.reasoning ? { reasoning: model.reasoning } : {}),
        }),
      });
    },

    async rename(name) {
      await request(`/${encodeURIComponent(boardId)}`, {
        method: 'PATCH',
        body: JSON.stringify({ name }),
      });
    },

    async rerun(taskIds, concurrency) {
      const response = await fetch(`/api/boards/${encodeURIComponent(boardId)}/rerun`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(taskIds && taskIds.length > 0 ? { taskIds } : {}),
          ...(concurrency !== undefined ? { concurrency } : {}),
        }),
      });
      let body: { ok?: boolean; taskIds?: string[]; error?: string } = {};
      try {
        body = (await response.json()) as typeof body;
      } catch {
        body = {};
      }
      if (response.status === 409) return { ok: false, taskIds: body.taskIds ?? [] };
      if (!response.ok) {
        throw new Error(body.error ?? `${response.status} from /api/boards/${boardId}/rerun`);
      }
      return { ok: true, taskIds: body.taskIds ?? [] };
    },

    async startTask(taskId) {
      const response = await fetch(
        `/api/boards/${encodeURIComponent(boardId)}/tasks/${encodeURIComponent(taskId)}/start`,
        { method: 'POST' },
      );
      return response.ok;
    },
  };
}

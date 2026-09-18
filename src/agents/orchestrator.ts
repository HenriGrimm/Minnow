import { findChatById, getActiveChat } from '../state/sessions';
import { resolveChatSpawnCwd } from '../state/chat-worktree';
import { getSubAgentExecutorContext } from '../tools/sub-agent-executor-context';
import { getWorkspacePath } from '../state/workspace';
import { getSubAgentTypeConfig } from './sub-agent-config';
import { resolveSubAgentModelBinding } from './resolve-sub-agent-binding';
import {
  isContextBudgetFailure,
  isMaxToolTurnFailure,
  isSubAgentRunTerminal,
} from './sub-agent-outcome';
import { legacyOutcomeFromSummary } from './sub-agent-structured-outcome';
import { DEFAULT_CONTEXT_ENFORCEMENT_POLICY } from '../chat/context-budget';
import {
  clearSubAgentRunListeners,
  emitSubAgentRunUpdated,
  subscribeSubAgentRuns,
} from './sub-agent-events';
import { withSessionToken } from '../api/session-token';
import { createSubAgentRunClient, type EventStream, type DeliverFrame } from './sub-agent-client';
import { countToolCalls, turnEventsToMessages } from '../../server/orchestrator/transcript-messages.js';
import type { PersistedSubAgentRun } from '../types';
import type {
  AggregateResult,
  CancelSubAgentResult,
  SpawnSubAgentInput,
  SpawnSubAgentResult,
  SubAgentRun,
  SubAgentStatus,
  SubAgentTerminalReason,
} from './types';

export { subscribeSubAgentRuns };

const AGGREGATE_MAX_BYTES = 32 * 1024;
const STATUS_PREVIEW_MAX = 240;

const runs = new Map<string, SubAgentRun>();
const clients = new Map<string, ReturnType<typeof createSubAgentRunClient>>();
interface SharedParentStream {
  source: EventStream;
  leases: Set<SharedParentStreamLease>;
}

interface SharedParentStreamLease extends EventStream {
  dispatch(type: string, event: { data: string }): void;
}

const parentStreams = new Map<string, SharedParentStream>();
const parentIndex = new Map<string, Set<string>>();
const turnIndex = new Map<string, Set<string>>();
const hydrating = new Map<string, Promise<void>>();
/** Last successful parent-chat hydrate, for the TTL below. */
const hydratedAt = new Map<string, number>();
/** In-flight transcript hydrates, keyed by run id. */
const transcriptHydrating = new Map<string, Promise<void>>();
/** Runs whose transcript fetch already returned nothing — never worth refetching. */
const transcriptHydrateAttempted = new Set<string>();
/** Spawn requests stopped before their run id was known to the renderer. */
const pendingSpawnTokens = new Map<string, Set<symbol>>();
const cancelledSpawnTokens = new Set<symbol>();
/**
 * A chat switch re-runs the parent hydrate; without this the whole run list is refetched and
 * every run re-published on each switch, fanning out to the card and activity-panel listeners.
 */
const PARENT_HYDRATE_TTL_MS = 15_000;
const deliverListeners = new Set<(frame: DeliverFrame & { runId: string }) => void>();

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;
let apiFetch: FetchFn = (input, init) => fetch(input, init);

let openStream: ((url: string) => EventStream) | undefined;

// ── Tests ────────────────────────────────────────────────────────────────────

export function setSubAgentApiFetchForTests(fn: FetchFn | null): void {
  apiFetch = fn ?? ((input, init) => fetch(input, init));
}

export function setSubAgentOpenStreamForTests(
  fn: ((url: string) => EventStream) | null,
): void {
  openStream = fn ?? undefined;
}

// ── Request ──────────────────────────────────────────────────────────────────

async function request(path: string, init?: RequestInit): Promise<any> {
  const response = await apiFetch(`/api/agents${path}`, {
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
    throw new Error(body?.error ?? `${response.status} from /api/agents${path}`);
  }
  return body;
}

function statusFromPhase(phase: string | undefined): SubAgentStatus {
  if (phase === 'passed') return 'completed';
  if (phase === 'cancelled') return 'cancelled';
  if (phase === 'abandoned') return 'failed';
  if (phase === 'running' || phase === 'cancelling') return 'running';
  return 'queued';
}

function preferNonEmptyString(fold: unknown, prev: unknown): string {
  if (typeof fold === 'string' && fold.trim()) return fold;
  if (typeof prev === 'string' && prev.trim()) return prev;
  if (typeof fold === 'string') return fold;
  if (typeof prev === 'string') return prev;
  return '';
}

function pickMessages(live: unknown[] | undefined, prev: unknown[] | undefined): SubAgentRun['messages'] {
  const a = Array.isArray(live) ? live : [];
  const b = Array.isArray(prev) ? prev : [];
  const chosen = a.length >= b.length ? a : b;
  return chosen as SubAgentRun['messages'];
}

function lastEnded(raw: Record<string, unknown>): Record<string, unknown> | null {
  const attempts = Array.isArray(raw.attempts) ? raw.attempts : [];
  for (let i = attempts.length - 1; i >= 0; i -= 1) {
    const a = attempts[i];
    if (a && typeof a === 'object' && (a as { ended?: boolean }).ended) {
      return a as Record<string, unknown>;
    }
  }
  return null;
}

// ── Fold ─────────────────────────────────────────────────────────────────────

export function subAgentRunFromFold(
  raw: Record<string, unknown>,
  extra: Partial<SubAgentRun> = {},
): SubAgentRun {
  const last = lastEnded(raw);
  const phase = typeof raw.phase === 'string' ? raw.phase : 'idle';
  const status = statusFromPhase(phase);
  const requestedAt = Number(raw.requestedAt);
  const startedAt =
    Number.isSafeInteger(requestedAt) && requestedAt > 0
      ? new Date(requestedAt).toISOString()
      : extra.startedAt ?? null;
  const model =
    raw.model && typeof raw.model === 'object' && !Array.isArray(raw.model)
      ? (raw.model as { providerId?: string; id?: string })
      : null;
  const summary = preferNonEmptyString(last?.summary, extra.summary);
  const error =
    phase === 'abandoned' && typeof raw.abandonedReason === 'string'
      ? raw.abandonedReason
      : extra.error ?? null;
  const foldAttemptCount = Array.isArray(raw.attempts)
    ? raw.attempts.length
    : extra.foldAttemptCount ?? 0;
  const messages = extra.messages ?? [];
  const toolTurns =
    messages.length > 0 ? countToolCalls(messages) : extra.toolTurns ?? 0;
  const structuredOutcome =
    extra.structuredOutcome ??
    (summary.trim() ? legacyOutcomeFromSummary(summary) : undefined);

  return {
    ...extra,
    runId: String(raw.runId ?? extra.runId ?? ''),
    type: String(raw.type ?? extra.type ?? ''),
    task: String(raw.task ?? extra.task ?? ''),
    status,
    parentChatId: typeof raw.parentChatId === 'string' ? raw.parentChatId : extra.parentChatId ?? null,
    parentToolCallId:
      typeof raw.parentToolCallId === 'string' ? raw.parentToolCallId : extra.parentToolCallId ?? null,
    parentTurnId: typeof raw.parentTurnId === 'string' ? raw.parentTurnId : extra.parentTurnId ?? null,
    summary,
    error,
    startedAt,
    endedAt: isSubAgentRunTerminal(status) ? extra.endedAt ?? startedAt : null,
    toolTurns,
    cancelled: status === 'cancelled',
    messages,
    delivered: raw.delivered === true,
    providerId: model?.providerId ?? extra.providerId,
    modelId: model?.id ?? extra.modelId,
    foldAttemptCount,
    ...(structuredOutcome ? { structuredOutcome } : {}),
  };
}

function indexRun(run: SubAgentRun): void {
  if (run.parentChatId) {
    let set = parentIndex.get(run.parentChatId);
    if (!set) {
      set = new Set();
      parentIndex.set(run.parentChatId, set);
    }
    set.add(run.runId);
  }
  if (run.parentTurnId) {
    let set = turnIndex.get(run.parentTurnId);
    if (!set) {
      set = new Set();
      turnIndex.set(run.parentTurnId, set);
    }
    set.add(run.runId);
  }
}

function publish(run: SubAgentRun): void {
  const frozen = Object.freeze({ ...run }) as SubAgentRun;
  runs.set(run.runId, frozen);
  indexRun(frozen);
  emitSubAgentRunUpdated(frozen);
}

function mergeClientView(runId: string): void {
  const client = clients.get(runId);
  const prev = runs.get(runId);
  const raw = client?.getRun();
  if (!raw && !prev) return;
  const live = client?.getLive();
  const err = client?.getEngineError();
  const liveMessages = live?.messages;
  const messages = pickMessages(liveMessages, prev?.messages);
  const folded = subAgentRunFromFold(raw ?? { runId, ...(prev ?? {}) }, {
    ...(prev ?? {}),
    messages,
  });
  const terminal = isSubAgentRunTerminal(folded.status);
  const stopping = raw?.phase === 'cancelling';
  const next = subAgentRunFromFold(raw ?? { runId, ...(prev ?? {}) }, {
    ...(prev ?? {}),
    messages,
    toolTurns: messages.length > 0 ? countToolCalls(messages) : prev?.toolTurns ?? 0,
    livePhase: terminal
      ? undefined
      : stopping
        ? 'stopping'
        : ((live?.phase as SubAgentRun['livePhase']) ?? prev?.livePhase),
    liveCurrentToolName: terminal ? undefined : (live?.toolName ?? prev?.liveCurrentToolName),
    livePartialReasoning: terminal ? undefined : (live?.thinking || prev?.livePartialReasoning),
    livePartialText: terminal ? undefined : (live?.partialText || prev?.livePartialText),
    startError: terminal
      ? null
      : err
        ? { message: err.message, consecutive: err.consecutive }
        : prev?.startError,
    liveNestedToolCalls: terminal
      ? prev?.liveNestedToolCalls
      : live?.toolName && folded.status === 'running'
        ? Math.max(prev?.liveNestedToolCalls ?? 0, 1)
        : prev?.liveNestedToolCalls,
  });
  publish(next);
  // Terminal runs do not need a live SSE socket; holding one exhausts HTTP/1.1's
  // 6-connection pool (MIN-584). Close after publish so waiters already saw the fold.
  if (terminal) releaseClient(runId);
}

// ── Streams ──────────────────────────────────────────────────────────────────

function openAuthenticatedStream(url: string): EventStream {
  return new EventSource(withSessionToken(url)) as EventStream;
}

const SHARED_STREAM_EVENT_TYPES = ['snapshot', 'event', 'live', 'error', 'done', 'deliver'] as const;

/**
 * Lease one logical run onto the parent chat's single physical EventSource.
 * Browsers commonly allow only six HTTP/1.1 requests per origin; a socket per
 * child agent starved ordinary Settings, file-tree, and cancellation requests.
 */
function acquireParentStream(parentChatId: string): EventStream {
  let shared = parentStreams.get(parentChatId);
  if (!shared) {
    const source = (openStream ?? openAuthenticatedStream)(
      `/api/agents/events?parentChatId=${encodeURIComponent(parentChatId)}`,
    );
    shared = { source, leases: new Set() };
    parentStreams.set(parentChatId, shared);
    for (const type of SHARED_STREAM_EVENT_TYPES) {
      source.addEventListener(type, (event) => {
        const current = parentStreams.get(parentChatId);
        if (!current) return;
        for (const lease of [...current.leases]) lease.dispatch(type, event);
      });
    }
  }

  const listeners = new Map<string, Set<(event: { data: string }) => void>>();
  let closed = false;
  const lease: SharedParentStreamLease = {
    addEventListener(type, listener) {
      let set = listeners.get(type);
      if (!set) {
        set = new Set();
        listeners.set(type, set);
      }
      set.add(listener);
    },
    dispatch(type, event) {
      if (closed) return;
      for (const listener of [...(listeners.get(type) ?? [])]) listener(event);
    },
    close() {
      if (closed) return;
      closed = true;
      listeners.clear();
      const current = parentStreams.get(parentChatId);
      current?.leases.delete(lease);
      if (current && current.leases.size === 0) {
        current.source.close();
        parentStreams.delete(parentChatId);
      }
    },
  };
  shared.leases.add(lease);
  return lease;
}

function releaseClient(runId: string): void {
  const client = clients.get(runId);
  if (!client) return;
  client.close();
  clients.delete(runId);
}

/** Physical EventSource count — at most one per parent chat, regardless of child count. */
export function countOpenSubAgentStreams(): number {
  return parentStreams.size;
}

function ensureClient(
  runId: string,
  initialRun?: Record<string, unknown>,
  initialSeq?: number,
): void {
  if (clients.has(runId)) return;
  const existing = runs.get(runId);
  if (existing && isSubAgentRunTerminal(existing.status)) return;
  const parentChatId =
    typeof initialRun?.parentChatId === 'string'
      ? initialRun.parentChatId
      : existing?.parentChatId ?? '';
  const client = createSubAgentRunClient(runId, {
    openStream: parentChatId
      ? () => acquireParentStream(parentChatId)
      : openStream ?? openAuthenticatedStream,
    initialRun,
    initialSeq,
  });
  clients.set(runId, client);
  client.subscribe(() => mergeClientView(runId));
  client.subscribeDeliver((frame) => {
    for (const listener of deliverListeners) {
      try {
        listener({ ...frame, runId });
      } catch (err) {
        console.error('[agents] deliver bus subscriber threw', err);
      }
    }
  });
  client.connect();
}

export function adoptSubAgentRunForTests(run: SubAgentRun): void {
  publish(run);
}

export function subscribeSubAgentDeliver(
  listener: (frame: DeliverFrame & { runId: string }) => void,
): () => void {
  deliverListeners.add(listener);
  return () => deliverListeners.delete(listener);
}

function adoptRaw(raw: Record<string, unknown>, seq?: number): void {
  const runId = String(raw.runId ?? '');
  const prev = runs.get(runId);
  publish(subAgentRunFromFold(raw, prev ?? {}));
  const next = runs.get(runId);
  if (next && isSubAgentRunTerminal(next.status)) {
    // Journal snapshot is enough for finished runs; do not occupy an HTTP/1.1 socket.
    releaseClient(runId);
    if ((next.messages?.length ?? 0) === 0) {
      void hydrateSubAgentTranscript(runId);
    }
    return;
  }
  ensureClient(runId, raw, seq);
}

// ── Hydrate ──────────────────────────────────────────────────────────────────

/** Force the next `hydrateSubAgentRunsForParentChat` past the TTL (spawn, delete, refresh). */
export function invalidateSubAgentParentHydrate(parentChatId?: string): void {
  if (parentChatId) hydratedAt.delete(parentChatId);
  else hydratedAt.clear();
}

export async function hydrateSubAgentRunsForParentChat(
  parentChatId: string,
  options: { force?: boolean } = {},
): Promise<void> {
  if (!parentChatId) return;
  const existing = hydrating.get(parentChatId);
  if (existing) return existing;
  if (!options.force) {
    const last = hydratedAt.get(parentChatId);
    if (last !== undefined && Date.now() - last < PARENT_HYDRATE_TTL_MS) return;
  }
  const work = (async () => {
    try {
      const body = await request(`?parentChatId=${encodeURIComponent(parentChatId)}`);
      const list = Array.isArray(body?.state?.runs) ? body.state.runs : [];
      for (const raw of list) {
        if (raw && typeof raw === 'object' && typeof raw.runId === 'string') {
          adoptRaw(raw, Number(body?.seq) || 0);
        }
      }
      hydratedAt.set(parentChatId, Date.now());
    } catch (err) {
      console.error('[agents] could not hydrate parent chat runs', err);
    } finally {
      hydrating.delete(parentChatId);
    }
  })();
  hydrating.set(parentChatId, work);
  return work;
}

export async function hydrateSubAgentTranscript(runId: string): Promise<void> {
  if (!runId) return;
  const inflight = transcriptHydrating.get(runId);
  if (inflight) return inflight;
  // An empty result is final for a terminal run; without this marker every switch refetches it.
  if (transcriptHydrateAttempted.has(runId)) return;
  const work = hydrateSubAgentTranscriptNow(runId).finally(() => {
    transcriptHydrating.delete(runId);
  });
  transcriptHydrating.set(runId, work);
  return work;
}

async function hydrateSubAgentTranscriptNow(runId: string): Promise<void> {
  try {
    const body = await request(`/${encodeURIComponent(runId)}/transcript`);
    const events = Array.isArray(body?.events) ? body.events : [];
    const mapped = turnEventsToMessages(events);
    transcriptHydrateAttempted.add(runId);
    if (mapped.length === 0) return;
    const client = clients.get(runId);
    if (client) {
      client.seedMessages(mapped);
      mergeClientView(runId);
      return;
    }
    const prev = runs.get(runId);
    if (!prev) return;
    if ((prev.messages?.length ?? 0) >= mapped.length) return;
    publish({
      ...prev,
      messages: mapped as SubAgentRun['messages'],
      toolTurns: countToolCalls(mapped),
    });
  } catch (err) {
    console.error('[agents] could not hydrate run transcript', err);
  }
}

export function getSubAgentRun(runId: string): SubAgentRun | undefined {
  return runs.get(runId);
}

function isListedActiveSubAgentRun(run: SubAgentRun): boolean {
  if (run.status === 'running') return true;
  return run.status === 'queued' && (run.foldAttemptCount ?? 0) === 0;
}

export function listActiveSubAgentRuns(): SubAgentRun[] {
  return [...runs.values()].filter(isListedActiveSubAgentRun);
}

export async function rehydrateLiveParentSubAgents(parentChatId: string): Promise<void> {
  if (!parentChatId) return;
  const live = listSubAgentRunsForParentChat(parentChatId).filter(isListedActiveSubAgentRun);
  if (live.length === 0) return;
  await hydrateSubAgentRunsForParentChat(parentChatId, { force: true });
}

export function listSubAgentRunsForParentChat(parentChatId: string | null | undefined): SubAgentRun[] {
  if (!parentChatId) return [];
  const ids = parentIndex.get(parentChatId);
  if (!ids) return [];
  return [...ids].map((id) => runs.get(id)).filter((r): r is SubAgentRun => Boolean(r));
}

export function listSubAgentRunsForParentTurn(parentTurnId: string | null | undefined): SubAgentRun[] {
  if (!parentTurnId) return [];
  const ids = turnIndex.get(parentTurnId);
  if (!ids) return [];
  return [...ids].map((id) => runs.get(id)).filter((r): r is SubAgentRun => Boolean(r));
}

function resolveParentChatId(input: SpawnSubAgentInput): string {
  if (input.parentChatId?.trim()) return input.parentChatId.trim();
  const fromExecutor = getSubAgentExecutorContext()?.parentChatId?.trim() ?? '';
  if (fromExecutor) return fromExecutor;
  try {
    return getActiveChat()?.id?.trim() ?? '';
  } catch {
    return '';
  }
}

function resolveSpawnCwd(parentChatId: string | null | undefined): string {
  if (parentChatId) {
    const chat = findChatById(parentChatId);
    const fromChat = resolveChatSpawnCwd(chat);
    if (fromChat) return fromChat;
  }
  return getWorkspacePath().trim();
}

// ── Spawn ────────────────────────────────────────────────────────────────────

export async function spawnSubAgent(
  input: SpawnSubAgentInput,
): Promise<SpawnSubAgentResult | AggregateResult> {
  const parentChatId = resolveParentChatId(input);
  const cwd = resolveSpawnCwd(parentChatId);
  let providerId = input.providerId?.trim() ?? '';
  let modelId = input.modelId?.trim() ?? '';
  if (!providerId && !modelId) {
    const typeCfg = await getSubAgentTypeConfig(input.type);
    if (typeCfg) {
      const parentChat = parentChatId ? findChatById(parentChatId) : undefined;
      const binding = resolveSubAgentModelBinding(typeCfg, parentChat);
      providerId = binding.providerId;
      modelId = binding.modelId;
    }
  }
  const spawnToken = Symbol(parentChatId);
  let pending = pendingSpawnTokens.get(parentChatId);
  if (!pending) {
    pending = new Set();
    pendingSpawnTokens.set(parentChatId, pending);
  }
  pending.add(spawnToken);
  let body: any;
  try {
    body = await request('', {
      method: 'POST',
      body: JSON.stringify({
        type: input.type,
        task: input.task,
        parentChatId,
        cwd,
        ...(input.parentTurnId ? { parentTurnId: input.parentTurnId } : {}),
        ...(input.parentToolCallId ? { parentToolCallId: input.parentToolCallId } : {}),
        ...(providerId ? { providerId } : {}),
        ...(modelId ? { modelId } : {}),
      }),
    });
  } catch (err) {
    cancelledSpawnTokens.delete(spawnToken);
    throw err;
  } finally {
    pending.delete(spawnToken);
    if (pending.size === 0) pendingSpawnTokens.delete(parentChatId);
  }
  if (body.run && typeof body.run === 'object') adoptRaw(body.run, Number(body.seq) || 0);
  else if (typeof body.runId === 'string') {
    ensureClient(body.runId);
  }
  const result: SpawnSubAgentResult = {
    runId: String(body.runId),
    status: (body.status as SubAgentStatus) ?? 'queued',
  };
  if (cancelledSpawnTokens.delete(spawnToken)) {
    cancelSubAgent(result.runId, 'parent_chat_abort');
  }
  if (input.wait === true) {
    return waitForSubAgent(result.runId);
  }
  return result;
}

// ── Cancel ───────────────────────────────────────────────────────────────────

export function cancelSubAgent(runId: string, _reason = 'cancelled'): CancelSubAgentResult {
  const prev = runs.get(runId);
  optimisticallyCancelSubAgent(runId);
  void request(`/${encodeURIComponent(runId)}/cancel`, { method: 'POST' })
    .then((body) => {
      if (body?.state?.runs) {
        for (const raw of body.state.runs) {
          if (raw && typeof raw === 'object') adoptRaw(raw, Number(body?.seq) || 0);
        }
      } else if (body?.status && prev) {
        publish({ ...prev, status: body.status, cancelled: body.status === 'cancelled' });
      }
    })
    .catch((err) => {
      console.error('[agents] cancel failed', err);
      if (prev && !isSubAgentRunTerminal(prev.status)) {
        publish({
          ...prev,
          startError: { message: 'Could not stop this sub-agent.', consecutive: 1 },
        });
        if (prev.parentChatId) {
          void hydrateSubAgentRunsForParentChat(prev.parentChatId, { force: true });
        }
      }
    });
  return { ok: true, runId, status: 'cancelled' };
}

export async function restartSubAgent(
  runId: string,
  extra: Partial<SpawnSubAgentInput> = {},
): Promise<SpawnSubAgentResult | AggregateResult> {
  const prev = runs.get(runId);
  cancelSubAgent(runId, 'restart');
  return spawnSubAgent({
    type: extra.type ?? prev?.type ?? 'explore',
    task: extra.task ?? prev?.task ?? '',
    parentChatId: extra.parentChatId ?? prev?.parentChatId,
    parentTurnId: extra.parentTurnId ?? prev?.parentTurnId,
    parentToolCallId: extra.parentToolCallId ?? prev?.parentToolCallId,
    wait: extra.wait,
  });
}

export function cancelAllForParentTurn(parentTurnId: string): void {
  for (const run of listSubAgentRunsForParentTurn(parentTurnId)) {
    cancelSubAgent(run.runId, 'parent_turn_abort');
  }
}

function optimisticallyCancelSubAgent(runId: string): void {
  const prev = runs.get(runId);
  if (!prev || isSubAgentRunTerminal(prev.status)) return;
  publish({
    ...prev,
    status: 'cancelled',
    cancelled: true,
    endedAt: new Date().toISOString(),
    livePhase: undefined,
    liveCurrentToolName: undefined,
    livePartialReasoning: undefined,
    livePartialText: undefined,
    startError: null,
  });
  // Release the long-lived socket before issuing the cancel request so the
  // request cannot queue behind the stream it is trying to terminate.
  releaseClient(runId);
}

export function cancelAllForParentChat(parentChatId: string): void {
  const previous = listSubAgentRunsForParentChat(parentChatId).filter(
    (run) => !isSubAgentRunTerminal(run.status),
  );
  for (const run of previous) optimisticallyCancelSubAgent(run.runId);

  const pending = pendingSpawnTokens.get(parentChatId);
  for (const token of pending ?? []) cancelledSpawnTokens.add(token);
  if (previous.length === 0 && !pending?.size) return;

  void request(`/cancel?parentChatId=${encodeURIComponent(parentChatId)}`, { method: 'POST' })
    .then((body) => {
      for (const raw of body?.state?.runs ?? []) {
        if (raw && typeof raw === 'object') adoptRaw(raw, Number(body?.seq) || 0);
      }
    })
    .catch((err) => {
      console.error('[agents] parent cancel failed', err);
      for (const run of previous) publish(run);
      void hydrateSubAgentRunsForParentChat(parentChatId, { force: true });
    });
}

export async function waitForSubAgent(
  runId: string,
  signal?: AbortSignal,
): Promise<AggregateResult> {
  const initial = getSubAgentRun(runId);
  if (initial && isSubAgentRunTerminal(initial.status)) {
    return buildAggregateResult(initial);
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (result: AggregateResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };
    const onAbort = () => {
      fail(new DOMException('Aborted', 'AbortError'));
      cancelSubAgent(runId, 'parent_abort');
    };
    let unsubscribe: (() => void) | null = null;
    const cleanup = () => {
      signal?.removeEventListener('abort', onAbort);
      unsubscribe?.();
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    unsubscribe = subscribeSubAgentRuns((run) => {
      if (run.runId !== runId) return;
      if (!isSubAgentRunTerminal(run.status)) return;
      finish(buildAggregateResult(run));
    });
    const latest = getSubAgentRun(runId);
    if (latest && isSubAgentRunTerminal(latest.status)) {
      finish(buildAggregateResult(latest));
    }
  });
}

export function recordToolCallForRun(
  _runId: string,
  _name: string,
  _args: Record<string, unknown>,
): void {}

export function getRunToolCallFingerprint(_runId: string): string {
  return '';
}

export function resetSubAgentOrchestrator(): void {
  for (const client of clients.values()) client.close();
  clients.clear();
  for (const stream of parentStreams.values()) stream.source.close();
  parentStreams.clear();
  runs.clear();
  parentIndex.clear();
  turnIndex.clear();
  hydrating.clear();
  hydratedAt.clear();
  transcriptHydrating.clear();
  transcriptHydrateAttempted.clear();
  pendingSpawnTokens.clear();
  cancelledSpawnTokens.clear();
  deliverListeners.clear();
  clearSubAgentRunListeners();
}

export const resetSubAgentController = resetSubAgentOrchestrator;

/** @deprecated Persistence is the journal at ~/.minnow/agents/<parentChatId>/. */
export function initControllerPersistence(): Promise<void> {
  return Promise.resolve();
}

/** @deprecated The SSE store is ready without a registry hydrate. */
export function ensureControllerReady(): Promise<void> {
  return Promise.resolve();
}

// ── Format ───────────────────────────────────────────────────────────────────

function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

export function deriveSubAgentTerminalReason(run: SubAgentRun): SubAgentTerminalReason | undefined {
  if (run.status !== 'completed' && run.status !== 'failed' && run.status !== 'cancelled') {
    return undefined;
  }
  if (run.status === 'cancelled') return 'cancelled';
  if (isMaxToolTurnFailure(run.summary, run.error)) return 'max_tool_turns';
  if (isContextBudgetFailure(run.error)) return 'context_budget';
  if (run.status === 'failed') return 'failed';
  return 'success';
}

export function honestTerminalSummary(run: { status: string; error?: string | null }): string {
  const err = typeof run.error === 'string' ? run.error.trim() : '';
  if (err) return err;
  if (run.status === 'cancelled') return 'Cancelled.';
  if (run.status === 'failed') return 'The sub-agent failed without a written summary.';
  return 'The sub-agent finished without a written summary.';
}

function outcomeForRun(run: SubAgentRun) {
  if (run.structuredOutcome) return run.structuredOutcome;
  const trimmed = typeof run.summary === 'string' ? run.summary.trim() : '';
  if (trimmed) return legacyOutcomeFromSummary(trimmed);
  if (!isSubAgentRunTerminal(run.status)) return null;
  const preview = lastNonSystemPreview(run.messages);
  if (preview) return legacyOutcomeFromSummary(preview);
  return null;
}

export function formatAggregateResult(result: AggregateResult): string {
  let json = JSON.stringify(result, null, 2);
  if (utf8ByteLength(json) <= AGGREGATE_MAX_BYTES) return json;
  const suffix = '\n…[truncated]';
  while (utf8ByteLength(json + suffix) > AGGREGATE_MAX_BYTES && json.length > 0) {
    json = json.slice(0, Math.floor(json.length * 0.9));
  }
  return json + suffix;
}

export function buildAggregateResult(run: SubAgentRun): AggregateResult {
  const outcome =
    outcomeForRun(run) ?? legacyOutcomeFromSummary(honestTerminalSummary(run));
  const out: AggregateResult = {
    runId: run.runId,
    type: run.type,
    status: run.status,
    summary: outcome.summary,
    outcome,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    toolTurns: run.toolTurns,
    cancelled: run.cancelled,
  };
  if (run.error) out.error = run.error;
  const terminalReason = deriveSubAgentTerminalReason(run);
  if (terminalReason) out.terminalReason = terminalReason;
  if (run.budgetEvents?.length) {
    const lastEstimate = run.budgetEvents[run.budgetEvents.length - 1]?.estimatedTokens;
    out.contextBudget = {
      maxInputTokens: run.contextBudgetMaxInputTokens ?? 0,
      estimatedInputTokens: lastEstimate ?? 0,
      policy: run.contextBudgetPolicy ?? DEFAULT_CONTEXT_ENFORCEMENT_POLICY,
      events: run.budgetEvents.map((e) => e.label),
    };
  }
  return out;
}

export function lastNonSystemPreview(messages: unknown[] | undefined | null): string {
  if (!Array.isArray(messages) || messages.length === 0) return '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string; content?: unknown };
    if (!m || m.role === 'system') continue;
    let text = '';
    if (typeof m.content === 'string') text = m.content;
    else if (m.content != null) text = JSON.stringify(m.content);
    const t = text.trim();
    if (!t) continue;
    return t.length > STATUS_PREVIEW_MAX ? `${t.slice(0, STATUS_PREVIEW_MAX)}…` : t;
  }
  return '';
}

export function formatSubAgentListToolResult(parentTurnId: string | null | undefined): string {
  const rows = listSubAgentRunsForParentTurn(parentTurnId).map((r) => ({
    runId: r.runId,
    type: r.type,
    status: r.status,
    taskPreview: r.task.length > 120 ? `${r.task.slice(0, 120)}…` : r.task,
    startedAt: r.startedAt,
    toolTurns: r.toolTurns,
    liveNestedToolCalls: r.liveNestedToolCalls,
  }));
  return JSON.stringify({ runs: rows }, null, 2);
}

export function formatSubAgentListToolResultForChat(
  parentChatId: string,
  persisted: PersistedSubAgentRun[] | undefined,
): string {
  const live = listSubAgentRunsForParentChat(parentChatId);
  const liveIds = new Set(live.map((r) => r.runId));
  const rows = live.map((r) => ({
    runId: r.runId,
    type: r.type,
    status: r.status,
    taskPreview: r.task.length > 120 ? `${r.task.slice(0, 120)}…` : r.task,
    startedAt: r.startedAt,
    toolTurns: r.toolTurns,
    liveNestedToolCalls: r.liveNestedToolCalls,
  }));
  for (const p of persisted ?? []) {
    if (liveIds.has(p.runId)) continue;
    rows.push({
      runId: p.runId,
      type: p.type,
      status: p.status,
      taskPreview: p.task.length > 120 ? `${p.task.slice(0, 120)}…` : p.task,
      startedAt: p.startedAt ?? null,
      toolTurns: p.toolTurns,
      liveNestedToolCalls: undefined,
    });
  }
  rows.sort((a, b) => String(a.startedAt ?? '').localeCompare(String(b.startedAt ?? '')));
  return JSON.stringify({ runs: rows }, null, 2);
}

export function buildSubAgentStatusPayload(run: SubAgentRun): Record<string, unknown> {
  const success = run.status === 'completed' && !isMaxToolTurnFailure(run.summary, run.error);
  const outcome = outcomeForRun(run);
  const preview = lastNonSystemPreview(run.messages);
  const payload: Record<string, unknown> = {
    runId: run.runId,
    type: run.type,
    status: run.status,
    success,
    summary: outcome?.summary ?? preview,
    ...(outcome ? { outcome } : {}),
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    toolTurns: run.toolTurns,
    cancelled: run.cancelled,
    lastMessagePreview: preview,
  };
  if (run.error) payload.error = run.error;
  if (run.liveNestedToolCalls != null) payload.liveNestedToolCalls = run.liveNestedToolCalls;
  if (run.liveCurrentToolName) payload.liveCurrentToolName = run.liveCurrentToolName;
  if (run.livePhase) payload.livePhase = run.livePhase;
  if (run.livePartialReasoning) payload.livePartialReasoning = run.livePartialReasoning;
  if (run.livePartialText) payload.livePartialText = run.livePartialText;
  if (run.startError) payload.startError = run.startError;
  if (run.modelId) payload.modelId = run.modelId;
  if (run.providerId) payload.providerId = run.providerId;
  if (run.budgetEvents?.length) payload.budgetEvents = run.budgetEvents;
  const terminalReason = deriveSubAgentTerminalReason(run);
  if (terminalReason) payload.terminalReason = terminalReason;
  return payload;
}

export function assertSubAgentRunReadableByParent(
  run: SubAgentRun | undefined,
  ctx: { parentChatId: string; parentTurnId?: string },
): SubAgentRun {
  if (!run) throw new Error('Error: unknown sub-agent run');
  if (!run.parentChatId || run.parentChatId !== ctx.parentChatId) {
    throw new Error('Error: sub-agent run is not visible from this chat');
  }
  return run;
}

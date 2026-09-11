import { resolveSummarySchemaPreset, validateStructuredOutcomeForPreset } from '../../agents/sub-agent-summary-schemas';
import type { RunTurnOptions } from '../../../server/runner/run-turn';
import { subscribeSuperPlanEvents } from './events';
import { getChatAbort } from '../../app-state';
import { pauseMainTurnActivityForQuestion, resumeMainTurnActivityFromQuestion } from '../main-turn-activity';
/**
 * Renderer claim loop for the Super Plan run engine (W4-B).
 *
 * `interview` and `draft` are the two stages a human drives in the renderer, so
 * the engine delegates them through a **lease** (`server/super-plan/
 * effector-delegated.js`). This module is the remote effector: on boot and on
 * stream-end it queries the run for an open lease, claims it with a
 * compare-and-set on `attemptId`, runs the stage through {@link runChatTurn}
 * (so every existing caller overlay — streaming rows, tool indicators,
 * round-boundary steer, queue flush, titles, hidden user rows — is untouched),
 * and POSTs the outcome back.
 *
 * Design rules:
 *  - **Never reset the stage.** A busy chat, a `409` claim, or a transient
 *    transport error simply returns; the next stream-end (or the next boot)
 *    retries. The engine re-offers an unclaimed lease on its own tick (D5).
 *  - **Terminal is terminal.** A finished run is never claimed again.
 *  - Historical chats without a server run id remain read-only.
 */

import type { Chat } from '../../types';
import { randomUUID } from '../../lib/random-id.ts';
import { getSuperPlanConfigSync } from '../../config/super-plan-meta';
import { reportBackgroundError } from '../../boot/report-background-error';
import { isChatTurnInProgress, isChatTurnSetupPending } from '../chat-turn-guard';
import { isChatStreaming, subscribeChatStreamEnd } from '../streaming-state';
import {
  adaptGrillingSkillForSuperPlan,
  buildSuperPlanGrillStageUserText,
} from './grill-prompt';
import type { SuperPlanStageId } from './types';

// ── Roles ────────────────────────────────────────────────────────────────────

/** The two pipeline stages the renderer drives; every other role is headless. */
export const DELEGATED_ROLES = ['interview', 'draft'] as const;

export type DelegatedRole = (typeof DELEGATED_ROLES)[number];

/** True for the two lease-backed (chat-visible) stages. */
export function isDelegatedRole(value: string): value is DelegatedRole {
  return (DELEGATED_ROLES as readonly string[]).includes(value);
}

// ── Transport ────────────────────────────────────────────────────────────────

/** One stage attempt, as the engine's `GET /state` reports it. */
export interface SuperPlanEngineAttempt {
  attemptId: string;
  stage: string;
  ended: boolean;
}

/** The subset of the engine's derived state the claim loop reads. */
export interface SuperPlanEngineState {
  runId: string;
  prompt: string;
  status: string;
  finished: boolean;
  stopReason: string | null;
  stage: string | null;
  specPath: string | null;
  researchPath: string | null;
  planPath: string | null;
  /** Number of recorded review rounds (drives draft1 vs draft2 stamping). */
  reviewCount: number;
  view?: import('./view').SuperPlanView;
  config?: Record<string, unknown>;
  reviews?: unknown[];
  stageRecords?: Array<{ stage: string; outcome: string; summary?: string; atMs?: number; seq?: number }>;
  gateHistory?: unknown[];
  slug?: string;
  attempts: SuperPlanEngineAttempt[];
}

export interface SuperPlanClaimResult {
  ok: boolean;
  status: number;
  error?: string;
}

export interface SuperPlanFinishResult {
  ok: boolean;
  status: number;
  duplicate?: boolean;
}

export interface SuperPlanCreateRunInput {
  runId: string;
  prompt: string;
  workspacePath?: string;
  chatId?: string;
  config?: Record<string, unknown>;
}

/** The engine HTTP surface the claim loop uses. Injected in tests. */
export interface SuperPlanClaimTransport {
  fetchState(runId: string, signal?: AbortSignal): Promise<SuperPlanEngineState>;
  claim(runId: string, attemptId: string, clientId: string): Promise<SuperPlanClaimResult>;
  heartbeat(runId: string, attemptId: string, clientId: string): Promise<SuperPlanClaimResult>;
  finish(
    runId: string,
    attemptId: string,
    end: { outcome: string; summary?: string; evidence?: Record<string, unknown> },
  ): Promise<SuperPlanFinishResult>;
  /** D8: a user stop is a pause, non-terminal. */
  pause(runId: string): Promise<SuperPlanClaimResult>;
  createRun?(input: SuperPlanCreateRunInput): Promise<SuperPlanClaimResult>;
  startRun?(runId: string): Promise<SuperPlanClaimResult>;
}

/** Read the JSON body, tolerating an empty body. */
async function readJson(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  if (!text.trim()) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** Coerce the wire state into the narrow shape the loop reads. */
export function normalizeEngineState(
  runId: string,
  raw: Record<string, unknown>,
): SuperPlanEngineState {
  const attempts = Array.isArray(raw.attempts)
    ? raw.attempts
        .filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object')
        .map((row) => ({
          attemptId: String(row.attemptId ?? ''),
          stage: String(row.stage ?? ''),
          ended: Boolean(row.ended),
        }))
        .filter((row) => row.attemptId.length > 0)
    : [];
  const reviews = Array.isArray(raw.reviews) ? raw.reviews.length : 0;
  return {
    runId,
    prompt: typeof raw.prompt === 'string' ? raw.prompt : '',
    status: typeof raw.status === 'string' ? raw.status : 'created',
    finished: raw.finished === true,
    stopReason: typeof raw.stopReason === 'string' ? raw.stopReason : null,
    stage: typeof raw.stage === 'string' ? raw.stage : null,
    specPath: typeof raw.specPath === 'string' ? raw.specPath : null,
    researchPath: typeof raw.researchPath === 'string' ? raw.researchPath : null,
    planPath: typeof raw.planPath === 'string' ? raw.planPath : null,
    reviewCount: reviews,
    view: raw.view as import('./view').SuperPlanView | undefined,
    config: raw.config as Record<string, unknown>,
    reviews: raw.reviews as unknown[],
    stageRecords: raw.stageRecords as SuperPlanEngineState['stageRecords'],
    gateHistory: raw.gateHistory as unknown[],
    slug: String(raw.slug ?? runId),
    attempts,
  };
}

/** Default transport: the `/api/super-plan` HTTP surface. */
export const defaultSuperPlanClaimTransport: SuperPlanClaimTransport = {
  async fetchState(runId, signal) {
    const res = await fetch(`/api/super-plan/${encodeURIComponent(runId)}/state`, {
      cache: 'no-store',
      signal,
    });
    const body = await readJson(res);
    if (!res.ok) {
      throw new Error(
        typeof body.error === 'string' ? body.error : `super-plan state failed (${res.status})`,
      );
    }
    const state =
      body.state && typeof body.state === 'object' && !Array.isArray(body.state)
        ? (body.state as Record<string, unknown>)
        : body;
    return normalizeEngineState(runId, state);
  },
  async claim(runId, attemptId, clientId) {
    const res = await fetch(`/api/super-plan/${encodeURIComponent(runId)}/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ attemptId, clientId }),
    });
    const body = await readJson(res);
    return {
      ok: res.ok && body.ok !== false,
      status: res.status,
      ...(typeof body.error === 'string' ? { error: body.error } : {}),
    };
  },
  async heartbeat(runId, attemptId, clientId) {
    // The heartbeat route is the claim route's CAS sibling; today it rides the
    // same lease and the claim re-touch is enough to keep it alive.
    return this.claim(runId, attemptId, clientId);
  },
  async finish(runId, attemptId, end) {
    const res = await fetch(`/api/super-plan/${encodeURIComponent(runId)}/finish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ attemptId, clientId: superPlanClientId(), ...end }),
    });
    const body = await readJson(res);
    return {
      ok: res.ok && body.ok !== false,
      status: res.status,
      ...(body.duplicate === true ? { duplicate: true } : {}),
    };
  },
  async pause(runId) {
    const res = await fetch(`/api/super-plan/${encodeURIComponent(runId)}/stop`, {
      method: 'POST',
    });
    const body = await readJson(res);
    return { ok: res.ok && body.ok !== false, status: res.status };
  },
  async createRun(input) {
    const res = await fetch('/api/super-plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        runId: input.runId,
        chatId: input.chatId,
        prompt: input.prompt,
        ...(input.workspacePath ? { workspacePath: input.workspacePath } : {}),
        ...(input.config ? { config: input.config } : {}),
      }),
    });
    const body = await readJson(res);
    return {
      ok: res.ok && body.ok !== false,
      status: res.status,
      ...(typeof body.error === 'string' ? { error: body.error } : {}),
    };
  },
  async startRun(runId) {
    const res = await fetch(`/api/super-plan/${encodeURIComponent(runId)}/start`, {
      method: 'POST',
    });
    const body = await readJson(res);
    return { ok: res.ok && body.ok !== false, status: res.status };
  },
};

// ── Turn runner ──────────────────────────────────────────────────────────────

export interface DelegatedTurnInput {
  runId: string;
  role: DelegatedRole;
  attemptId: string;
  state: SuperPlanEngineState;
}

/** `stopped` maps to an engine pause (D8); `fail` to a crashed attempt. */
export type DelegatedTurnOutcome = 'pass' | 'fail' | 'stopped';

export type DelegatedTurnRunner = (
  chat: Chat,
  input: DelegatedTurnInput,
) => Promise<DelegatedTurnOutcome>;

/** Map an engine role onto the renderer's `superPlanStage` transcript stamp. */
export function superPlanStageForRole(
  role: DelegatedRole,
  state: Pick<SuperPlanEngineState, 'reviewCount'>,
): SuperPlanStageId {
  if (role === 'draft') return state.reviewCount > 0 ? 'draft2' : 'draft1';
  return 'grill';
}

/**
 * Build the hidden user row for a delegated stage. Paths come from the engine
 * state, falling back to the legacy `chat.superPlanView` rows the UI still owns
 * until the projection lands (W6-A).
 */
export function buildDelegatedStageUserText(
  chat: Chat,
  role: DelegatedRole,
  state: SuperPlanEngineState,
): string {
  const prompt = state.prompt.trim() || chat.superPlanView?.prompt?.trim() || '';
  if (role === 'interview') {
    return `Interview the user about this request using ask_question. Ask up to ${state.config?.grillQuestionBudget ?? 10} questions, focusing on unknown requirements. Then write the agreed build specification with save_file to documentation/plans/references/${state.slug || state.runId}-spec.md. Include the request, decisions, requirements, constraints and acceptance criteria. Do not ask for final confirmation; the server presents that checkpoint.\n${JSON.stringify(state.gateHistory ?? [])}\n${prompt}`;
  }
  const planPath = state.planPath?.trim() || `documentation/plans/${state.slug || state.runId}.md`;
  const specPath = state.specPath?.trim() || chat.superPlanView?.specPath || '';
  const researchPath = state.researchPath?.trim() || chat.superPlanView?.researchPath || '';
  const pass = state.reviewCount > 0 ? 2 : 1;
  const lines = [
    `Super Plan pipeline — **Draft ${pass}**.`,
    planPath
      ? `Write the executable plan to exactly \`${planPath}\` using \`save_file\` (overwrite if it exists — never pick a different filename).`
      : 'Write the executable plan using `save_file` (overwrite if it exists — never pick a different filename).',
    'Follow the Super Plan markdown structure (front-matter todos, waves, Build/Test per task).',
    'After saving, call report_outcome with summary, findings: [], artifacts: [{kind: "path", label: "Plan", ref: the plan path}], and addressed: {findingIds: [], dispositions: {}} naming review findings you fixed.',
    'Use real file paths from the codebase. No fenced implementation code — prose and inline identifiers only.',
  ];
  if (specPath) lines.push(`Read \`${specPath}\` first.`);
  if (researchPath) lines.push(`Read \`${researchPath}\` first.`);
  lines.push('Address the review findings and rejection feedback below. Preserve completed work from any interrupted attempt. Required sections: Context, Tasks, Verification. If tasks are executable, include Build, Test, Accept, Touches and Depends on for each task.', JSON.stringify({ reviews: state.reviews, previousAttempts: state.stageRecords, answers: state.gateHistory }), '', `Original request: ${prompt}`);
  return lines.join('\n');
}

/**
 * Default runner: the same `runChatTurn` call the legacy stage runner made, so
 * the caller overlays in `run-turn-chat.ts` are unchanged.
 */
async function defaultRunDelegatedTurn(
  chat: Chat,
  input: DelegatedTurnInput,
): Promise<DelegatedTurnOutcome> {
  const [
    { runChatTurn },
    { newestRun },
    { isFirstUserMessagePending },
    { fetchSkillById },
    { detectLocalServer },
  ] = await Promise.all([
    import('../run-turn-chat'),
    import('../../state/runs-store'),
    import('../titles/schedule'),
    import('../../skills/client'),
    import('../../tools/client'),
  ]);

  const userText = buildDelegatedStageUserText(chat, input.role, input.state);
  let skillId: string | null = null;
  let skillBody: string | null = null;
  if (input.role === 'interview') {
    skillId = 'grilling';
    const skill = await fetchSkillById('grilling');
    skillBody = adaptGrillingSkillForSuperPlan(skill?.body ?? null);
  }

  // Mirror the legacy stage runner: the configured planner model wins for the
  // turn, then the chat's own binding is restored.
  const planner = (input.state.config?.plannerModel ?? getSuperPlanConfigSync().plannerModel) as { providerId: string; modelId: string };
  const savedProvider = chat.providerId;
  const savedModel = chat.modelId;
  if (planner.providerId.trim()) chat.providerId = planner.providerId.trim();
  if (planner.modelId.trim()) chat.modelId = planner.modelId.trim();
  try {
    await detectLocalServer();
    await runChatTurn({
      chat,
      pushUser: true,
      rawText: userText,
      userText,
      skillId,
      displayText: userText,
      historyContent: userText,
      validAttachments: [],
      titleSeed: input.state.prompt || userText,
      shouldScheduleTitle: isFirstUserMessagePending(chat),
      skillBody,
      superPlanStage: superPlanStageForRole(input.role, input.state),
    });
  } finally {
    chat.providerId = savedProvider;
    chat.modelId = savedModel;
  }

  const run = newestRun(chat);
  if (run?.status === 'stopped') return 'stopped';
  if (run?.status === 'failed') return 'fail';
  return 'pass';
}

// ── Loop state ───────────────────────────────────────────────────────────────

/** Chats with a turn in flight right now — never double-run one stage. */
const inFlightChats = new Set<string>();
const delegatedReports = new Map<string, { summary: string; addressed?: unknown }>();
const activeDelegatedTurns = new Map<string, DelegatedTurnInput>();
const streamSubscriptions = new Map<string, () => void>();

let transportOverride: SuperPlanClaimTransport | null = null;
let runTurnOverride: DelegatedTurnRunner | null = null;
let streamEndUnsubscribe: (() => void) | null = null;
let cachedClientId: string | null = null;
let reconcileTimer: ReturnType<typeof setInterval> | null = null;

/** Stable per-window id for the lease CAS. */
export function superPlanClientId(): string {
  if (!cachedClientId) cachedClientId = `renderer-${randomUUID()}`;
  return cachedClientId;
}

/** Test seam: replace the HTTP transport (or `null` to restore the default). */
export function setSuperPlanClaimTransportForTests(
  transport: SuperPlanClaimTransport | null,
): void {
  transportOverride = transport;
}

/** Test seam: replace the stage runner (or `null` to restore the default). */
export function setSuperPlanClaimRunTurnForTests(runner: DelegatedTurnRunner | null): void {
  runTurnOverride = runner;
}

/** Test seam: reset module state between cases. */
export function resetSuperPlanClaimLoopForTests(): void {
  streamEndUnsubscribe?.();
  streamEndUnsubscribe = null;
  if (reconcileTimer) clearInterval(reconcileTimer);
  reconcileTimer = null;
  for (const unsubscribe of streamSubscriptions.values()) unsubscribe();
  streamSubscriptions.clear();
  inFlightChats.clear();
  transportOverride = null;
  runTurnOverride = null;
  cachedClientId = null;
  activeDelegatedTurns.clear();
  delegatedReports.clear();
}

// ── Claim ────────────────────────────────────────────────────────────────────

export type ClaimOutcomeKind =
  | 'legacy'
  | 'busy'
  | 'terminal'
  | 'paused'
  | 'idle'
  | 'lost'
  | 'finished'
  | 'error';

export interface ClaimOutcome {
  kind: ClaimOutcomeKind;
  runId?: string;
  attemptId?: string;
  stage?: string;
  status?: number;
}

export interface ClaimLoopOptions {
  transport?: SuperPlanClaimTransport;
  runTurn?: DelegatedTurnRunner;
  clientId?: string;
  /** Heartbeat cadence while a stage runs. Advertised by the lease. */
  heartbeatMs?: number;
  /** Test seam: run without a heartbeat timer. */
  heartbeat?: boolean;
}

function resolveTransport(options: ClaimLoopOptions): SuperPlanClaimTransport {
  return options.transport ?? transportOverride ?? defaultSuperPlanClaimTransport;
}

function startHeartbeat(
  transport: SuperPlanClaimTransport,
  runId: string,
  attemptId: string,
  clientId: string,
  options: ClaimLoopOptions,
  onLost: () => void,
): () => void {
  if (options.heartbeat === false) return () => undefined;
  const ms = options.heartbeatMs ?? 10_000;
  const handle = setInterval(() => {
    void transport.heartbeat(runId, attemptId, clientId).then((result) => {
      if (!result.ok && result.status === 409) onLost();
    }).catch(() => undefined);
  }, ms);
  // Never keep a Node test process alive on the heartbeat alone.
  (handle as unknown as { unref?: () => void }).unref?.();
  return () => clearInterval(handle);
}

/**
 * One claim attempt for a chat. Safe to call on every boot and stream-end:
 * it never resets the stage, never double-runs a chat, and stops at terminal.
 */
export async function claimSuperPlanForChat(
  chat: Chat,
  options: ClaimLoopOptions = {},
): Promise<ClaimOutcome> {
  const runId = chat.superPlanRunId?.trim();
  if (!runId) return { kind: 'legacy' };
  const busy = inFlightChats.has(chat.id) || (
    isChatStreaming(chat.id) ||
    isChatTurnSetupPending(chat.id) ||
    isChatTurnInProgress(chat.id)
  );

  const transport = resolveTransport(options);
  let state: SuperPlanEngineState;
  try {
    state = await transport.fetchState(runId);
    if (state.view) {
      chat.superPlanView = state.view;
      const { notifySuperPlanView } = await import('./client');
      notifySuperPlanView(chat);
    }
  } catch (err) {
    reportBackgroundError('super-plan-claim', err);
    return { kind: 'error', runId };
  }

  if (state.finished) { streamSubscriptions.get(runId)?.(); streamSubscriptions.delete(runId); }
  if (state.finished) return { kind: 'terminal', runId };
  if (busy) return { kind: 'busy', runId };
  if (state.status !== 'running') return { kind: 'paused', runId };

  const attempt = state.attempts.find((a) => !a.ended && isDelegatedRole(a.stage));
  if (!attempt || !isDelegatedRole(attempt.stage)) return { kind: 'idle', runId };
  const role = attempt.stage;

  const clientId = options.clientId ?? superPlanClientId();
  let claim: SuperPlanClaimResult;
  try {
    claim = await transport.claim(runId, attempt.attemptId, clientId);
  } catch (err) {
    reportBackgroundError('super-plan-claim', err);
    return { kind: 'error', runId, attemptId: attempt.attemptId };
  }
  if (!claim.ok) {
    // A `409` (another window, or an expired lease) is not an error: never
    // reset the stage — the next stream-end retries.
    return {
      kind: 'lost',
      runId,
      attemptId: attempt.attemptId,
      stage: attempt.stage,
      status: claim.status,
    };
  }

  if (inFlightChats.has(chat.id)) return { kind: 'busy', runId };
  inFlightChats.add(chat.id);
  let leaseLost = false;
  const stopHeartbeat = startHeartbeat(
    transport,
    runId,
    attempt.attemptId,
    clientId,
    options,
    () => {
      leaseLost = true;
      void import('../stop-generation').then(({ stopGeneration }) => stopGeneration(chat.id));
    },
  );
  try {
    const runner = options.runTurn ?? runTurnOverride ?? defaultRunDelegatedTurn;
    activeDelegatedTurns.set(chat.id, { runId, role, attemptId: attempt.attemptId, state });
    const outcome = await runner(chat, {
      runId,
      role,
      attemptId: attempt.attemptId,
      state,
    });
    if (leaseLost) return { kind: 'lost', runId, attemptId: attempt.attemptId };
    if (outcome === 'stopped') {
      // D8: a user stop pauses the run (non-terminal); the stage re-plans.
      await transport.pause(runId);
      return { kind: 'paused', runId, attemptId: attempt.attemptId, stage: attempt.stage };
    }
    const finish = await transport.finish(runId, attempt.attemptId, {
      outcome: outcome === 'pass' ? 'pass' : 'crashed',
      ...(delegatedReports.has(chat.id) ? { summary: delegatedReports.get(chat.id)!.summary, evidence: { addressed: delegatedReports.get(chat.id)!.addressed } } : {}),
    });
    return {
      kind: finish.ok ? 'finished' : finish.status === 409 ? 'lost' : 'error',
      runId,
      attemptId: attempt.attemptId,
      stage: attempt.stage,
      status: finish.status,
    };
  } catch (err) {
    reportBackgroundError('super-plan-claim-run', err);
    return { kind: 'error', runId, attemptId: attempt.attemptId, stage: attempt.stage };
  } finally {
    stopHeartbeat();
    activeDelegatedTurns.delete(chat.id);
    delegatedReports.delete(chat.id);
    inFlightChats.delete(chat.id);
  }
}

// ── New runs ─────────────────────────────────────────────────────────────────

/** Derive a stable run id from a prompt. */
function slugFromPrompt(prompt: string): string {
  const slug = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || 'super-plan';
}

export interface StartEngineRunInput {
  chat: Chat;
  prompt: string;
  workspacePath?: string;
  config?: Record<string, unknown>;
}

/**
 * Create a server-side run for a chat and set `chat.superPlanRunId`. New runs
 * take the engine path; a chat that already has one is left alone.
 */
export async function startSuperPlanEngineRun(
  input: StartEngineRunInput,
  options: ClaimLoopOptions = {},
): Promise<{ ok: boolean; runId?: string; error?: string }> {
  const transport = resolveTransport(options);
  if (!transport.createRun || !transport.startRun) {
    return { ok: false, error: 'the claim transport does not support run creation' };
  }
  const existing = input.chat.superPlanRunId?.trim();
  const runId = existing || `${slugFromPrompt(input.prompt)}-${randomUUID().slice(0, 8)}`;
  if (!existing) {
    const created = await transport.createRun({
      runId,
      chatId: input.chat.id,
      prompt: input.prompt,
      ...(input.workspacePath ?? input.chat.workspacePath
        ? { workspacePath: input.workspacePath ?? input.chat.workspacePath }
        : {}),
      ...(input.config ? { config: input.config } : {}),
    });
    if (!created.ok) {
      return { ok: false, error: created.error ?? `create failed (${created.status})` };
    }
    input.chat.superPlanRunId = runId;
  }
  const started = await transport.startRun(runId);
  if (!started.ok) {
    return { ok: false, runId, error: `start failed (${started.status})` };
  }
  void claimSuperPlanForChat(input.chat, options);
  return { ok: true, runId };
}

// ── Boot + stream-end wiring ─────────────────────────────────────────────────

export interface ClaimLoopStartOptions extends ClaimLoopOptions {
  /** Test seam: skip the boot scan. */
  scanOnStart?: boolean;
}

/** Boot scan: claim an open lease for every chat that owns an engine run. */
async function scanSuperPlanEngineRuns(options: ClaimLoopOptions): Promise<void> {
  try {
    const { sessionState } = await import('../../state/sessions');
    const chats = (sessionState?.chats ?? []).filter((chat) =>
      Boolean(chat.superPlanRunId?.trim()) && !chat.superPlanView?.finished,
    );
    for (const chat of chats) {
      const runId = chat.superPlanRunId!;
      if (typeof EventSource !== 'undefined' && !streamSubscriptions.has(runId)) {
        streamSubscriptions.set(runId, subscribeSuperPlanEvents(runId, (type) => {
          if (type !== 'live') void claimSuperPlanForChat(chat, options);
        }));
      }
      void claimSuperPlanForChat(chat, options);
    }
  } catch (err) {
    reportBackgroundError('super-plan-claim-boot', err);
  }
}

/**
 * Start the claim loop: claim on boot and retry on every stream-end. Idempotent
 * — repeated calls share one stream-end subscription.
 */
export function startSuperPlanClaimLoop(options: ClaimLoopStartOptions = {}): () => void {
  if (!reconcileTimer) {
    reconcileTimer = setInterval(() => { void scanSuperPlanEngineRuns(options); }, 5000);
    (reconcileTimer as unknown as { unref?: () => void }).unref?.();
  }
  if (!streamEndUnsubscribe) {
    streamEndUnsubscribe = subscribeChatStreamEnd((chatId) => {
      void import('../../state/sessions')
        .then(({ findChatById }) => {
          const chat = findChatById(chatId);
          if (!chat?.superPlanRunId?.trim()) return;
          void claimSuperPlanForChat(chat, options);
        })
        .catch(() => undefined);
    });
  }
  if (options.scanOnStart !== false) {
    void scanSuperPlanEngineRuns(options);
  }
  return () => {
    if (reconcileTimer) clearInterval(reconcileTimer);
    reconcileTimer = null;
    streamEndUnsubscribe?.();
    streamEndUnsubscribe = null;
    for (const unsubscribe of streamSubscriptions.values()) unsubscribe();
    streamSubscriptions.clear();
  };
}

export async function askForDelegatedSuperPlan(chatId: string, question: unknown): Promise<string | null> {
  const turn = activeDelegatedTurns.get(chatId);
  if (!turn) return null;
  const signal = getChatAbort(chatId)?.signal;
  pauseMainTurnActivityForQuestion(chatId);
  try {
    const response = await fetch(`/api/super-plan/${encodeURIComponent(turn.runId)}/ask`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
      body: JSON.stringify({ attemptId: turn.attemptId, clientId: superPlanClientId(), question, wait: false }),
    });
    const body = await readJson(response);
    if (!response.ok) throw new Error(String(body.error ?? 'Question failed'));
    if (!body.gateId) return String(body.answer ?? '');
    return await waitForDelegatedAnswer(chatId, turn, String(body.gateId), signal);
  } finally {
    resumeMainTurnActivityFromQuestion(chatId);
  }
}

/** Short state reads keep the browser connection pool available for lease heartbeats. */
async function waitForDelegatedAnswer(chatId: string, turn: DelegatedTurnInput, gateId: string, signal?: AbortSignal): Promise<string> {
  while (true) {
    signal?.throwIfAborted();
    const state = await defaultSuperPlanClaimTransport.fetchState(turn.runId);
    signal?.throwIfAborted();
    const { findChatById } = await import('../../state/sessions');
    const chat = findChatById(chatId);
    if (chat && state.view) {
      chat.superPlanView = state.view;
      const { notifySuperPlanView } = await import('./client');
      notifySuperPlanView(chat);
    }
    const answered = (state.gateHistory ?? []).find((item) => {
      const gate = item as { gateId?: string; verdict?: string };
      return gate.gateId === gateId && typeof gate.verdict === 'string';
    }) as { verdict: string } | undefined;
    if (answered) return answered.verdict;
    if (state.finished || state.status !== 'running' || !state.attempts.some((a) => a.attemptId === turn.attemptId && !a.ended)) {
      return JSON.stringify({ status: 'cancelled', answers: [] });
    }
    await new Promise<void>((resolve, reject) => {
      const onAbort = (): void => { clearTimeout(timer); reject(signal?.reason); };
      const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, 1000);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  }
}

export function delegatedReportOptions(chatId: string): Partial<RunTurnOptions> {
  if (!activeDelegatedTurns.has(chatId)) return {};
  return {
    injectReportTool: true, finalizeStructuredOutcome: true, summarySchema: 'minnow.sub-agent.v1',
    parseReport(raw) {
      let value = raw;
      if (typeof raw === 'string') { try { value = JSON.parse(raw); } catch { return { ok: false, error: 'Report must be a JSON object.' }; } }
      const structured = validateStructuredOutcomeForPreset(value, resolveSummarySchemaPreset('minnow.sub-agent.v1'));
      if (!structured) return { ok: false, error: 'Report summary, findings (an array, empty if none) and artifacts after saving the stage artifact.' };
      delegatedReports.set(chatId, { summary: structured.summary, addressed: (value as Record<string, unknown>).addressed });
      return { ok: true, result: { outcome: 'pass', summary: structured.summary, evidence: structured.artifacts.map((artifact) => artifact.ref) } };
    },
  };
}

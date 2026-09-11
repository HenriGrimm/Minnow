/** HTTP client for `/api/super-plan`. */

import { withSessionToken } from '../../api/session-token';
import type {
  SuperPlanAnswerEntry,
  SuperPlanLiveFrame,
  SuperPlanRunSummary,
  SuperPlanRunView,
  SuperPlanTranscriptRef,
} from './types';

const BASE = '/api/super-plan';

/** Thrown for a non-2xx answer; `status` is the HTTP code. */
export class SuperPlanApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'SuperPlanApiError';
  }
}

async function request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    cache: 'no-store',
    signal,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: Record<string, unknown> = {};
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    /* empty or non-JSON body */
  }
  if (!res.ok || json.ok === false) {
    const message = typeof json.error === 'string' && json.error ? json.error : `Super Plan request failed (${res.status})`;
    throw new SuperPlanApiError(message, res.status);
  }
  return json as T;
}

function runPath(runId: string, suffix = ''): string {
  return `/${encodeURIComponent(runId)}${suffix}`;
}

export interface CreateSuperPlanRunInput {
  prompt: string;
  workspacePath: string;
  chatId?: string;
  title?: string;
  config?: Record<string, unknown>;
}

export async function createSuperPlanRun(input: CreateSuperPlanRunInput): Promise<SuperPlanRunView> {
  const out = await request<{ view: SuperPlanRunView }>('POST', '', input);
  return out.view;
}

export async function fetchSuperPlanView(runId: string, signal?: AbortSignal): Promise<SuperPlanRunView> {
  const out = await request<{ view: SuperPlanRunView }>('GET', runPath(runId, '/state'), undefined, signal);
  return out.view;
}

export async function listSuperPlanRuns(options: { active?: boolean; ids?: string[] } = {}): Promise<SuperPlanRunSummary[]> {
  const params = new URLSearchParams();
  if (options.active) params.set('active', '1');
  if (options.ids?.length) params.set('ids', options.ids.join(','));
  const query = params.toString();
  const out = await request<{ runs: SuperPlanRunSummary[] }>('GET', `/runs${query ? `?${query}` : ''}`);
  return Array.isArray(out.runs) ? out.runs : [];
}

export type SuperPlanCommand = 'pause' | 'resume' | 'cancel' | 'skip' | 'rework' | 'questions/close' | 'checkpoint' | 'rename';

export async function sendSuperPlanCommand(runId: string, command: SuperPlanCommand, body: Record<string, unknown> = {}): Promise<SuperPlanRunView> {
  const out = await request<{ view: SuperPlanRunView }>('POST', runPath(runId, `/${command}`), body);
  return out.view;
}

export async function answerSuperPlanQuestion(runId: string, questionId: string, answers: SuperPlanAnswerEntry[]): Promise<SuperPlanRunView> {
  const out = await request<{ view: SuperPlanRunView }>(
    'POST',
    runPath(runId, `/questions/${encodeURIComponent(questionId)}/answer`),
    { answer: { status: 'answered', answers } },
  );
  return out.view;
}

export async function fetchSuperPlanTranscripts(runId: string): Promise<SuperPlanTranscriptRef[]> {
  const out = await request<{ transcripts: SuperPlanTranscriptRef[] }>('GET', runPath(runId, '/transcripts'));
  return Array.isArray(out.transcripts) ? out.transcripts : [];
}

export async function fetchSuperPlanTranscript(runId: string, key: string, signal?: AbortSignal): Promise<Record<string, unknown>[]> {
  const out = await request<{ messages: Record<string, unknown>[] }>(
    'GET',
    runPath(runId, `/transcripts/${encodeURIComponent(key)}`),
    undefined,
    signal,
  );
  return Array.isArray(out.messages) ? out.messages : [];
}

export interface SuperPlanPlanFile {
  /** Workspace-relative, always under documentation/plans/. */
  path: string;
  modifiedAt: number;
  bytes: number;
}

/** Saved plan files in the requesting view's workspace, newest first. */
export async function listSuperPlanPlanFiles(): Promise<SuperPlanPlanFile[]> {
  const out = await request<{ plans: SuperPlanPlanFile[] }>('GET', '/plans');
  return Array.isArray(out.plans) ? out.plans : [];
}

/** Delete a plan document under documentation/plans/ in the current workspace. */
export async function deleteSuperPlanPlanFile(path: string): Promise<void> {
  await request('DELETE', '/plans', { path });
}

export async function deleteSuperPlanRun(runId: string): Promise<void> {
  await request('DELETE', runPath(runId));
}

export interface SuperPlanStreamHandlers {
  onView?: (view: SuperPlanRunView) => void;
  onLive?: (frame: SuperPlanLiveFrame) => void;
  onError?: (message: string) => void;
}

/** One SSE connection for a run. Returns a closer. */
export function openSuperPlanStream(runId: string, handlers: SuperPlanStreamHandlers): () => void {
  if (typeof EventSource === 'undefined') return () => undefined;
  const source = new EventSource(withSessionToken(`${BASE}${runPath(runId, '/events')}`));
  const parse = (event: Event): unknown => {
    try {
      return JSON.parse((event as MessageEvent).data as string);
    } catch {
      return null;
    }
  };
  source.addEventListener('view', (event) => {
    const view = parse(event) as SuperPlanRunView | null;
    if (view?.runId) handlers.onView?.(view);
  });
  source.addEventListener('live', (event) => {
    const frame = parse(event) as SuperPlanLiveFrame | null;
    if (frame?.event) handlers.onLive?.(frame);
  });
  source.addEventListener('error', (event) => {
    const data = parse(event) as { message?: string } | null;
    if (data?.message) handlers.onError?.(data.message);
  });
  return () => source.close();
}

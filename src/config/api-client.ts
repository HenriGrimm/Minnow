/**
 * HTTP client for ~/.minnow config API (npm start only).
 */

import type {
  BugsState,
  Chat,
  ChatGroup,
  IssuesState,
  Message,
  SessionState,
  SessionSummariesState,
  SystemPromptSettings,
} from '../types';
import type { IssuesTaxonomy } from '../issues/taxonomy';
import type { SkillConfig } from '../skills/config';
import type { ToolConfig } from '../tools/tool-settings-types';
import type { SearchConfig } from './search-config';
import type { ResearchConfig } from './research-config';
import type { UserRulesSettings } from './user-rules';
import {
  defaultSessionState,
  defaultSystemPromptSettings,
  defaultSkillConfig,
  defaultToolConfig,
  defaultUserRulesSettings,
} from './defaults';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

// ── Transport ────────────────────────────────────────────────────────────────

/**
 * Fetch `keepalive` bodies are capped at 64 KiB by the Fetch spec (Chromium enforces).
 * Larger keepalive PUTs are often a silent no-op — prefer a small PATCH beacon below this.
 */
export const FETCH_KEEPALIVE_MAX_BYTES = 64 * 1024;

/** Prefer sendBeacon when the serialized sessions delta is under this size (margin under 64 KiB). */
export const SESSIONS_BEACON_MAX_BYTES = 60 * 1024;

/** Partial sessions write body for PATCH /api/config/sessions (and POST beacon alias). */
export interface SessionsPatchDelta {
  baseVersion: number;
  /** Store revision this delta was composed against; mismatch returns 409. */
  baseRevision?: number;
  chats?: Chat[];
  deleteChatIds?: string[];
  groups?: ChatGroup[];
  deleteGroupIds?: string[];
  scalars?: Record<string, unknown>;
}

/** Shutdown transport chosen from serialized body size. */
export type SessionsShutdownTransport = 'beacon' | 'keepalive-put';

/** Pick beacon vs keepalive PUT from UTF-8 body length (unit-tested). */
export function chooseSessionsShutdownTransport(bodyByteLength: number): SessionsShutdownTransport {
  return bodyByteLength < SESSIONS_BEACON_MAX_BYTES ? 'beacon' : 'keepalive-put';
}

export interface ConfigStatusResponse {
  ok: boolean;
  storage: string;
  migrated: boolean;
  schemaVersion: number;
}

export interface MigrateBody {
  localStorage?: {
    sessions?: string;
    tools?: string;
    systemPrompt?: string;
  };
  clearLocalStorage?: boolean;
}

export interface MigrateResponse {
  ok: boolean;
  migrated?: boolean;
  skipped?: boolean;
  written?: string[];
  warnings?: string[];
}

async function parseJsonResponse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    const message =
      errBody && typeof errBody === 'object' && 'error' in errBody
        ? String((errBody as { error: unknown }).error)
        : res.statusText;
    throw new Error(message || `Config API ${res.status}`);
  }
  return res.json() as Promise<T>;
}

// ── Sessions ─────────────────────────────────────────────────────────────────

/** GET /api/config/status */
export async function fetchConfigStatus(): Promise<ConfigStatusResponse> {
  const res = await fetch('/api/config/status', { cache: 'no-store' });
  return parseJsonResponse<ConfigStatusResponse>(res);
}

/** GET /api/config/sessions */
export async function getSessions(): Promise<SessionState> {
  const res = await fetch('/api/config/sessions', { cache: 'no-store' });
  return parseJsonResponse<SessionState>(res);
}

/**
 * GET /api/config/bugs — read-only migration source for Issues (MIN-261).
 * Leftover bugs/state.json is left on disk after migration.
 */
/** GET /api/config/sessions/summaries?workspace=… — chats omit `history` (Phase C.1). */
export async function getSessionSummaries(workspace?: string): Promise<SessionSummariesState> {
  const params = new URLSearchParams();
  if (workspace != null && workspace !== '') {
    params.set('workspace', workspace);
  }
  const qs = params.toString();
  const res = await fetch(`/api/config/sessions/summaries${qs ? `?${qs}` : ''}`, {
    cache: 'no-store',
  });
  return parseJsonResponse<SessionSummariesState>(res);
}

/**
 * GET /api/config/sessions/history/:chatId — full message list for one chat.
 * Callers that compute absolute history indices must omit offset/limit.
 */
export async function getChatHistory(
  chatId: string,
  opts?: { offset?: number; limit?: number },
): Promise<Message[]> {
  const params = new URLSearchParams();
  if (opts?.offset != null) params.set('offset', String(opts.offset));
  if (opts?.limit != null) params.set('limit', String(opts.limit));
  const qs = params.toString();
  const path = `/api/config/sessions/history/${encodeURIComponent(chatId)}${qs ? `?${qs}` : ''}`;
  const res = await fetch(path, { cache: 'no-store' });
  const body = await parseJsonResponse<{ chatId: string; history: Message[] }>(res);
  return Array.isArray(body.history) ? body.history : [];
}

/** One hit from GET /api/config/sessions/search (FTS5 / JSON fallback). */
export interface SessionSearchHit {
  chatId: string;
  name: string;
  workspacePath: string;
  lastMessageAt?: number;
  score: number;
  matchedIn: 'title' | 'message';
  role?: 'user' | 'assistant';
  snippet: string;
}

/**
 * GET /api/config/sessions/search?q= — server FTS over titles + message bodies (C.2).
 */
export async function searchSessions(
  query: string,
  opts?: { workspace?: string; limit?: number },
): Promise<SessionSearchHit[]> {
  const params = new URLSearchParams();
  params.set('q', query);
  if (opts?.workspace != null && opts.workspace !== '') {
    params.set('workspace', opts.workspace);
  }
  if (opts?.limit != null) params.set('limit', String(opts.limit));
  const res = await fetch(`/api/config/sessions/search?${params}`, { cache: 'no-store' });
  const body = await parseJsonResponse<{ results: SessionSearchHit[] }>(res);
  return Array.isArray(body.results) ? body.results : [];
}

// ── Issues ───────────────────────────────────────────────────────────────────

/** GET /api/config/bugs */
export async function getBugs(): Promise<BugsState> {
  const res = await fetch('/api/config/bugs', { cache: 'no-store' });
  return parseJsonResponse<BugsState>(res);
}

/**
 * GET /api/config/issues
 * Returns null when the issues file has never been written (triggers migration).
 */
export async function getIssues(): Promise<IssuesState | null> {
  const res = await fetch('/api/config/issues', { cache: 'no-store' });
  if (res.status === 404) return null;
  return parseJsonResponse<IssuesState>(res);
}

/** PUT /api/config/issues */
export async function putIssues(state: IssuesState, base?: IssuesState | null): Promise<IssuesState> {
  const res = await fetch('/api/config/issues', {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify(base === undefined ? state : { state, base }),
  });
  return (await parseJsonResponse<{ ok: boolean; data: IssuesState }>(res)).data;
}

/**
 * GET /api/config/issues-taxonomy
 * Returns null when the taxonomy file has never been written (client seeds defaults).
 */
export async function getIssuesTaxonomy(): Promise<IssuesTaxonomy | null> {
  const res = await fetch('/api/config/issues-taxonomy', { cache: 'no-store' });
  if (res.status === 404) return null;
  return parseJsonResponse<IssuesTaxonomy>(res);
}

/** PUT /api/config/issues-taxonomy */
export async function putIssuesTaxonomy(taxonomy: IssuesTaxonomy): Promise<void> {
  const res = await fetch('/api/config/issues-taxonomy', {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify(taxonomy),
  });
  await parseJsonResponse<{ ok: boolean }>(res);
}

/**
 * GET /api/config/reviews
 * Returns null when the reviews file has never been written.
 */
export async function getReviews(): Promise<{ reviews?: Record<string, unknown> } | null> {
  const res = await fetch('/api/config/reviews', { cache: 'no-store' });
  if (res.status === 404) return null;
  return parseJsonResponse<{ reviews?: Record<string, unknown> }>(res);
}

/** PUT /api/config/reviews */
export async function putReviews(state: unknown): Promise<void> {
  const res = await fetch('/api/config/reviews', {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify(state),
  });
  await parseJsonResponse<{ ok: boolean }>(res);
}

// ── Session writes ───────────────────────────────────────────────────────────

/** Raised when the server rejected a write because another window advanced the store. */
export class SessionsRevisionConflictError extends Error {
  readonly revision: number | undefined;

  constructor(message: string, revision: number | undefined) {
    super(message || 'Session state changed in another window');
    this.name = 'SessionsRevisionConflictError';
    this.revision = revision;
  }
}

async function parseSessionsWriteResponse(res: Response): Promise<number | undefined> {
  if (res.status === 409) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: unknown;
      revision?: unknown;
    };
    throw new SessionsRevisionConflictError(
      typeof body.error === 'string' ? body.error : '',
      typeof body.revision === 'number' ? body.revision : undefined,
    );
  }
  const body = await parseJsonResponse<{ ok: boolean; revision?: number }>(res);
  return typeof body.revision === 'number' ? body.revision : undefined;
}

/** Extra keys the sessions PUT carries alongside the state blob. */
export interface PutSessionsOptions {
  /** Chats to remove. Absence from `state.chats` never deletes anything. */
  deleteChatIds?: string[];
  deleteGroupIds?: string[];
  /**
   * Opt in to removing stored chats missing from this payload. Only safe for a
   * caller that provably holds the complete list — the client never sets it.
   */
  pruneMissingChats?: boolean;
  /** Revision this write was composed against; mismatch returns 409. */
  baseRevision?: number;
}

/** How many times a write re-bases onto a newer revision before giving up. */
const SESSIONS_CONFLICT_RETRIES = 2;

/**
 * Send a sessions write, re-basing onto the server's revision on 409.
 *
 * `sessions.db` keeps one global revision counter, so two workspace views saving
 * at the same time will collide even though they touch disjoint rows. Blind
 * retry is safe here **because a folder opens in exactly one view**: no two
 * views ever own the same chat rows, and the bodies are whole objects for chats
 * this client owns. There is no read-modify-write to lose, so re-sending the
 * identical payload against the newer revision is the correct resolution.
 *
 * The upsert-only rule in `writeWholeSessionState` and the `pruneMissingChats`
 * guard still stand behind this — do not relax either. They are what stopped the
 * 2026-08 history wipe, and a second concurrent writer is precisely the
 * condition they defend against.
 *
 * ⚠️ The "chats this client owns" premise fails for one body: the whole-state
 * describe a lazy boot sends before its dirty sets are trusted. That one carries
 * *every* chat, including rows belonging to another window's folder, frozen at
 * this window's boot. Re-basing it onto a newer revision would push this
 * window's stale copy over edits the other window just made — and would revive
 * chats it deleted. Such a write passes `rebaseOnConflict: false` so the 409
 * stands and the caller drops the describe instead.
 */
async function sendSessionsWrite(
  method: 'PUT' | 'PATCH',
  body: Record<string, unknown>,
  options: { rebaseOnConflict?: boolean } = {},
): Promise<number | undefined> {
  const rebaseOnConflict = options.rebaseOnConflict !== false;
  let payload = body;
  for (let attempt = 0; ; attempt += 1) {
    const res = await fetch('/api/config/sessions', {
      method,
      headers: JSON_HEADERS,
      body: JSON.stringify(payload),
    });
    try {
      return await parseSessionsWriteResponse(res);
    } catch (err) {
      const rebased =
        rebaseOnConflict &&
        err instanceof SessionsRevisionConflictError &&
        attempt < SESSIONS_CONFLICT_RETRIES &&
        typeof err.revision === 'number' &&
        typeof payload.baseRevision === 'number';
      if (!rebased) throw err;
      payload = { ...payload, baseRevision: (err as SessionsRevisionConflictError).revision };
    }
  }
}

/** PUT /api/config/sessions — returns the server's new revision when it reports one. */
export async function putSessions(
  state: SessionState,
  options: PutSessionsOptions = {},
): Promise<number | undefined> {
  return sendSessionsWrite('PUT', { ...state, ...options });
}

/**
 * PATCH /api/config/sessions — partial upsert / explicit deletes.
 *
 * Pass `rebaseOnConflict: false` for a body that describes chats this client
 * does not own (the lazy-boot whole-state describe); the caller then drops the
 * describe on 409 rather than overwriting another window's edits.
 */
export async function patchSessions(
  delta: SessionsPatchDelta,
  options: { rebaseOnConflict?: boolean } = {},
): Promise<number | undefined> {
  return sendSessionsWrite('PATCH', delta as unknown as Record<string, unknown>, options);
}

/**
 * Best-effort whole-blob session save during `pagehide` / abrupt shutdown.
 * `keepalive` lets the browser finish the request after the tab closes.
 *
 * Browsers cap keepalive bodies at {@link FETCH_KEEPALIVE_MAX_BYTES} (64 KiB) and
 * drop oversized ones silently. A full SessionState routinely exceeds that, so an
 * over-cap body is reported as not dispatched rather than pretended into success.
 *
 * @returns whether the request was actually handed to the browser.
 */
export function putSessionsKeepalive(
  state: SessionState,
  options: PutSessionsOptions = {},
): boolean {
  try {
    const body = JSON.stringify({ ...state, ...options });
    if (utf8ByteLength(body) >= FETCH_KEEPALIVE_MAX_BYTES) {
      return false;
    }
    void fetch('/api/config/sessions', {
      method: 'PUT',
      headers: JSON_HEADERS,
      body,
      keepalive: true,
    }).catch(() => {
    });
    return true;
  } catch {
    return false;
  }
}

/** UTF-8 length, falling back to string length where TextEncoder is absent. */
function utf8ByteLength(text: string): number {
  return typeof TextEncoder !== 'undefined'
    ? new TextEncoder().encode(text).length
    : text.length;
}

/**
 * Queue a PATCH-shaped sessions delta via `navigator.sendBeacon` (POST alias).
 * sendBeacon cannot PATCH; the server accepts POST /api/config/sessions as PATCH.
 * @returns true when the browser accepted the beacon (best-effort success).
 */
export function sendSessionsPatchBeacon(delta: SessionsPatchDelta): boolean {
  try {
    if (typeof navigator === 'undefined' || typeof navigator.sendBeacon !== 'function') {
      return false;
    }
    const body = JSON.stringify(delta);
    const blob = new Blob([body], { type: 'application/json' });
    return navigator.sendBeacon('/api/config/sessions', blob);
  } catch {
    return false;
  }
}

/**
 * Shutdown flush: beacon POST when the delta is small; otherwise keepalive whole-blob PUT.
 *
 * `clearedOk` reports what actually left the process. Reporting an unconfirmed
 * keepalive PUT as success let the client drop dirty markers for a write the
 * browser had silently discarded, so the edits were gone on the next boot.
 *
 * An oversized delta is split into per-chat beacons rather than collapsed into one
 * whole-blob PUT that would be over the cap anyway.
 *
 * @returns whether the dirty sets may be cleared.
 */
export function flushSessionsOnShutdown(
  delta: SessionsPatchDelta | null,
  fullState: SessionState,
  fullStateOptions: PutSessionsOptions = {},
): { transport: SessionsShutdownTransport; clearedOk: boolean } {
  if (delta) {
    const byteLength = utf8ByteLength(JSON.stringify(delta));
    const transport = chooseSessionsShutdownTransport(byteLength);
    if (transport === 'beacon') {
      const queued = sendSessionsPatchBeacon(delta);
      if (queued) return { transport, clearedOk: true };
    } else if (splitSessionsPatchBeacons(delta)) {
      return { transport: 'beacon', clearedOk: true };
    }
  }
  const dispatched = putSessionsKeepalive(fullState, fullStateOptions);
  return { transport: 'keepalive-put', clearedOk: dispatched };
}

/**
 * Send an over-cap delta as one beacon per chat plus a tail beacon for everything
 * else. Each chat is independent, so a partial success still persists that chat.
 * @returns true when every piece was queued.
 */
function splitSessionsPatchBeacons(delta: SessionsPatchDelta): boolean {
  const chats = Array.isArray(delta.chats) ? delta.chats : [];
  const { chats: _chats, ...rest } = delta;
  void _chats;

  let allQueued = true;
  for (const chat of chats) {
    const piece: SessionsPatchDelta = { baseVersion: delta.baseVersion, chats: [chat] };
    if (utf8ByteLength(JSON.stringify(piece)) >= SESSIONS_BEACON_MAX_BYTES) {
      allQueued = false;
      continue;
    }
    if (!sendSessionsPatchBeacon(piece)) allQueued = false;
  }

  const hasTail =
    rest.deleteChatIds?.length ||
    rest.groups?.length ||
    rest.deleteGroupIds?.length ||
    rest.scalars;
  if (hasTail && !sendSessionsPatchBeacon(rest as SessionsPatchDelta)) {
    allQueued = false;
  }
  return allQueued;
}

// ── Other config ─────────────────────────────────────────────────────────────

/** GET /api/config/tools */
export async function getTools(): Promise<ToolConfig> {
  const res = await fetch('/api/config/tools', { cache: 'no-store' });
  return parseJsonResponse<ToolConfig>(res);
}

/** PUT /api/config/tools */
export async function putTools(config: ToolConfig): Promise<void> {
  const res = await fetch('/api/config/tools', {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify(config),
  });
  await parseJsonResponse<{ ok: boolean }>(res);
}

/** GET /api/config/search */
export async function getSearch(): Promise<SearchConfig> {
  const res = await fetch('/api/config/search', { cache: 'no-store' });
  return parseJsonResponse<SearchConfig>(res);
}

/** PUT /api/config/search */
export async function putSearch(config: SearchConfig): Promise<SearchConfig> {
  const res = await fetch('/api/config/search', {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify(config),
  });
  const body = await parseJsonResponse<{ ok: boolean; data: SearchConfig }>(res);
  return body.data;
}

/** GET /api/config/research */
export async function getResearch(): Promise<ResearchConfig> {
  const res = await fetch('/api/config/research', { cache: 'no-store' });
  return parseJsonResponse<ResearchConfig>(res);
}

/** PUT /api/config/research */
export async function putResearch(config: ResearchConfig): Promise<ResearchConfig> {
  const res = await fetch('/api/config/research', {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify(config),
  });
  const body = await parseJsonResponse<{ ok: boolean; data: ResearchConfig }>(res);
  return body.data;
}

/** GET /api/config/skills */
export async function getSkills(): Promise<SkillConfig> {
  const res = await fetch('/api/config/skills', { cache: 'no-store' });
  return parseJsonResponse<SkillConfig>(res);
}

/** PUT /api/config/skills */
export async function putSkills(config: SkillConfig): Promise<void> {
  const res = await fetch('/api/config/skills', {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify(config),
  });
  await parseJsonResponse<{ ok: boolean }>(res);
}

/** GET /api/config/system-prompt */
export async function getSystemPrompt(): Promise<SystemPromptSettings> {
  const res = await fetch('/api/config/system-prompt', { cache: 'no-store' });
  return parseJsonResponse<SystemPromptSettings>(res);
}

/** PUT /api/config/system-prompt */
export async function putSystemPrompt(settings: SystemPromptSettings): Promise<void> {
  const res = await fetch('/api/config/system-prompt', {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify(settings),
  });
  await parseJsonResponse<{ ok: boolean }>(res);
}

/** GET /api/config/rules */
export async function getRules(): Promise<UserRulesSettings> {
  const res = await fetch('/api/config/rules', { cache: 'no-store' });
  return parseJsonResponse<UserRulesSettings>(res);
}

/** PUT /api/config/rules */
export async function putRules(settings: UserRulesSettings): Promise<void> {
  const res = await fetch('/api/config/rules', {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify(settings),
  });
  await parseJsonResponse<{ ok: boolean }>(res);
}

/** POST /api/config/migrate */
export async function postMigrate(body: MigrateBody): Promise<MigrateResponse> {
  const res = await fetch('/api/config/migrate', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
  return parseJsonResponse<MigrateResponse>(res);
}

export {
  defaultSessionState,
  defaultSkillConfig,
  defaultToolConfig,
  defaultSystemPromptSettings,
  defaultUserRulesSettings,
};

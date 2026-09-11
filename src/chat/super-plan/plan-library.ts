import { normalizeWorkspacePath } from '../../lib/normalize-workspace-path';
import { isLocalServerAvailable } from '../../tools/config';
import { isExecutableOrchestratePlan } from '../plans/plan-path';
import { normalizeModeId } from '../modes/types';
import { isPlaceholderChatName } from '../titles/placeholder';
import { sessionState } from '../../state/sessions';
import { getWorkspacePath } from '../../state/workspace';
import type { Chat } from '../../types';
import { listSuperPlanPlanFiles, type SuperPlanPlanFile } from './api';
import type { SuperPlanChatSummary } from './types';

// ── Types ────────────────────────────────────────────────────────────────────

/** Row state. Every value renders as its own word, never as colour alone. */
export type PlanLibraryState =
  | 'running'
  | 'waiting'
  | 'paused'
  | 'halted'
  | 'error'
  | 'cancelled'
  | 'done'
  | 'saved';

export interface PlanLibraryEntry {
  /** Stable row key (path when there is a file, else the chat id). */
  key: string;
  /** Workspace-relative path, empty while a run has not written its plan yet. */
  path: string;
  title: string;
  /** Chat that owns the run, when the plan came from one. */
  chatId?: string;
  runId?: string;
  state: PlanLibraryState;
  /** What the run is doing now ("Interviewing", "Review round 2 of 2"). */
  stageLabel?: string;
  /** Epoch ms used for ordering and recency grouping. */
  atMs?: number;
  /** Whether the board can run this plan (gates "Start Orchestrator"). */
  executable: boolean;
}

export interface PlanLibraryGroup {
  label: string;
  entries: PlanLibraryEntry[];
}

export interface PlanLibraryResult {
  entries: PlanLibraryEntry[];
  /** 'server_off' or the server's error. Runs still list without a server. */
  error?: string;
}

const DAY_MS = 86_400_000;

// ── Titles ───────────────────────────────────────────────────────────────────

/** Title-case a plan slug: "server-session-engine" reads as "Server session engine". */
export function titleFromPlanPath(path: string): string {
  const base = (path.split('/').pop() ?? path).replace(/\.md$/i, '');
  if (!base) return path;
  const words = base.replace(/[-_]+/g, ' ').trim();
  if (!words) return base;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** True when the sidebar name is still auto-managed (not a user rename). */
export function isManagedSuperPlanChatTitle(name: string, lastManaged?: string): boolean {
  const trimmed = name.trim();
  if (!trimmed) return true;
  if (isPlaceholderChatName(trimmed)) return true;
  if (trimmed === 'Untitled plan') return true;
  return Boolean(lastManaged && trimmed === lastManaged.trim());
}

/**
 * Keep the chat's sidebar name in step with the run's title while the user has
 * not renamed the chat. `lastManaged` is the title this chat showed before.
 * Returns true when `chat.name` changed.
 */
export function syncSuperPlanChatTitle(chat: Chat, lastManaged?: string): boolean {
  if (normalizeModeId(chat.modeId) !== 'super-plan') return false;
  const sp = chat.superPlanView;
  if (!sp) return false;
  if (!isManagedSuperPlanChatTitle(chat.name, lastManaged)) return false;
  const next = resolveSuperPlanDisplayTitle(sp);
  if (chat.name === next) return false;
  chat.name = next;
  return true;
}

/** UI label for a Super Plan run: its title, else its plan file, never the whole prompt. */
export function resolveSuperPlanDisplayTitle(sp: Pick<SuperPlanChatSummary, 'title' | 'planPath'>, path?: string): string {
  const title = sp.title?.trim();
  if (title) return title;
  const planPath = path?.trim() || sp.planPath?.trim() || '';
  if (planPath) return titleFromPlanPath(planPath);
  return 'Untitled plan';
}

export function planLibraryStateLabel(state: PlanLibraryState): string {
  switch (state) {
    case 'waiting':
    case 'halted':
      return 'needs you';
    case 'error':
      return 'stopped';
    case 'done':
      return 'accepted';
    case 'saved':
      return '';
    default:
      return state;
  }
}

/** Map a run summary onto the rail's vocabulary. */
export function libraryStateFor(sp: SuperPlanChatSummary): PlanLibraryState {
  switch (sp.status) {
    case 'running':
    case 'created':
      return 'running';
    case 'waiting':
      return 'waiting';
    case 'paused':
      return 'paused';
    case 'halted':
      return 'halted';
    case 'done':
      return 'done';
    case 'cancelled':
      return 'cancelled';
    default:
      // failed, and runs from an earlier version that cannot continue
      return 'error';
  }
}

/** True when the chat row belongs to the given workspace folder. */
export function isChatInWorkspace(chat: Chat, workspacePath: string): boolean {
  const key = normalizeWorkspacePath(workspacePath);
  if (!key) return false;
  return normalizeWorkspacePath(chat.workspacePath ?? '') === key;
}

/** True when the chat belongs to the workspace folder Minnow has open right now. */
export function isChatInCurrentWorkspace(chat: Chat): boolean {
  return isChatInWorkspace(chat, getWorkspacePath());
}

// ── Collect ──────────────────────────────────────────────────────────────────

/** Every Super Plan run in the given workspace, from the chats that own them. */
export function collectSuperPlanRuns(workspacePath = getWorkspacePath()): PlanLibraryEntry[] {
  const workspaceKey = normalizeWorkspacePath(workspacePath);
  const chats: Chat[] = sessionState?.chats ?? [];
  const rows: PlanLibraryEntry[] = [];
  for (const chat of chats) {
    if (workspaceKey && !isChatInWorkspace(chat, workspaceKey)) continue;
    if (normalizeModeId(chat.modeId) !== 'super-plan') continue;
    const sp = chat.superPlanView;
    if (!sp?.runId) continue;
    const path = sp.planPath?.trim() ?? '';
    const state = libraryStateFor(sp);
    rows.push({
      key: path || chat.id,
      path,
      title: resolveSuperPlanDisplayTitle(sp, path),
      chatId: chat.id,
      runId: sp.runId,
      state,
      stageLabel: sp.activity || sp.stageLabel,
      atMs: sp.atMs || undefined,
      executable: Boolean(path && isExecutableOrchestratePlan(path)),
    });
  }
  return rows;
}

// ── List ─────────────────────────────────────────────────────────────────────

/**
 * Runs from the chats that own them, plus saved plan files the server lists.
 * Runs still list when the server is off; the files need it.
 */
export async function listSuperPlanLibrary(): Promise<PlanLibraryResult> {
  const runs = collectSuperPlanRuns();
  if (!isLocalServerAvailable()) {
    return { entries: sortLibrary(runs), error: 'server_off' };
  }

  let files: SuperPlanPlanFile[];
  try {
    files = await listSuperPlanPlanFiles();
  } catch (err) {
    return { entries: sortLibrary(runs), error: err instanceof Error ? err.message : 'Could not list plans' };
  }

  const modified = new Map(files.map((file) => [file.path, file.modifiedAt]));
  const runPaths = new Set<string>();
  for (const run of runs) {
    if (!run.path) continue;
    runPaths.add(run.path);
    if (run.atMs === undefined) run.atMs = modified.get(run.path);
  }

  const entries: PlanLibraryEntry[] = [...runs];
  for (const file of files) {
    if (runPaths.has(file.path)) continue;
    entries.push({
      key: file.path,
      path: file.path,
      title: titleFromPlanPath(file.path),
      state: 'saved',
      atMs: file.modifiedAt,
      executable: isExecutableOrchestratePlan(file.path),
    });
  }
  return { entries: sortLibrary(entries) };
}

/** Live rows float to the top, the ones that need you first; the rest by recency, then title. */
function sortLibrary(entries: PlanLibraryEntry[]): PlanLibraryEntry[] {
  const rank: Record<PlanLibraryState, number> = {
    waiting: 0,
    halted: 0,
    running: 1,
    paused: 1,
    error: 2,
    cancelled: 2,
    done: 2,
    saved: 2,
  };
  return [...entries].sort((a, b) => {
    const byRank = rank[a.state] - rank[b.state];
    if (byRank !== 0) return byRank;
    const byTime = (b.atMs ?? 0) - (a.atMs ?? 0);
    if (byTime !== 0) return byTime;
    return a.title.localeCompare(b.title);
  });
}

// ── Group ────────────────────────────────────────────────────────────────────

export function isLivePlanLibraryState(state: PlanLibraryState): boolean {
  return state === 'running' || state === 'waiting' || state === 'paused' || state === 'halted';
}

export function groupPlanLibraryEntries(
  entries: PlanLibraryEntry[],
  nowMs = Date.now(),
): PlanLibraryGroup[] {
  const live = entries.filter((e) => isLivePlanLibraryState(e.state));
  const rest = entries.filter((e) => !isLivePlanLibraryState(e.state));
  const groups: PlanLibraryGroup[] = [];

  if (live.length) {
    groups.push({ label: 'In progress', entries: live });
  }

  if (!rest.length) return groups;

  if (!rest.some((e) => e.atMs !== undefined)) {
    groups.push({ label: live.length ? 'Plans' : '', entries: rest });
    return groups;
  }

  const startOfToday = new Date(nowMs);
  startOfToday.setHours(0, 0, 0, 0);
  const todayMs = startOfToday.getTime();
  const weekMs = todayMs - 6 * DAY_MS;

  const today: PlanLibraryEntry[] = [];
  const week: PlanLibraryEntry[] = [];
  const earlier: PlanLibraryEntry[] = [];
  for (const entry of rest) {
    if (entry.atMs === undefined) earlier.push(entry);
    else if (entry.atMs >= todayMs) today.push(entry);
    else if (entry.atMs >= weekMs) week.push(entry);
    else earlier.push(entry);
  }

  if (today.length) groups.push({ label: 'Today', entries: today });
  if (week.length) groups.push({ label: 'This week', entries: week });
  if (earlier.length) groups.push({ label: 'Earlier', entries: earlier });
  return groups;
}

/** Compact relative time for rail meta lines. */
export function formatRelativeTime(atMs: number | undefined, nowMs = Date.now()): string {
  if (atMs === undefined) return '';
  const diff = Math.max(0, nowMs - atMs);
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w ago`;
  return new Date(atMs).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

import { normalizeWorkspacePath } from '../../lib/normalize-workspace-path';
import { executeTool } from '../../tools/client';
import { isLocalServerAvailable } from '../../tools/config';
import { isExecutableOrchestratePlan } from '../plans/plan-path';
import { normalizeModeId } from '../modes/types';
import { isPlaceholderChatName } from '../titles/placeholder';
import { sessionState } from '../../state/sessions';
import { getWorkspacePath } from '../../state/workspace';
import type { Chat } from '../../types';
import {
  SUPER_PLAN_STAGE_LABELS,
  SUPER_PLAN_DISPLAY_ORDER,
  type SuperPlanState,
} from './types';

// ── Types ────────────────────────────────────────────────────────────────────

/** Row state. Every value renders as its own word, never as colour alone. */
export type PlanLibraryState =
  | 'running'
  | 'waiting'
  | 'paused'
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
  state: PlanLibraryState;
  /** Stage name for live rows ("Research", "Review 1"). */
  stageLabel?: string;
  /** Stage position, 1-based, for live rows. */
  stagePosition?: { index: number; total: number };
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
  /** 'server_off' | 'no_plans_dir' | raw tool error. Runs still list without a server. */
  error?: string;
}

/** Stat fan-out ceiling. Past this the rail groups alphabetically instead. */
const METADATA_BUDGET = 80;
const METADATA_CONCURRENCY = 6;

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

/** Interim slug titles look like "Plan a1b2c3d4" until the spec is confirmed. */
const INTERIM_SUPER_PLAN_TITLE = /^Plan [a-f0-9]{8}$/i;

/** True when the sidebar name is still auto-managed (not a user rename). */
export function isManagedSuperPlanChatTitle(name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed) return true;
  if (isPlaceholderChatName(trimmed)) return true;
  if (trimmed === 'Untitled plan') return true;
  return INTERIM_SUPER_PLAN_TITLE.test(trimmed);
}

/**
 * Keep the chat's sidebar name in lockstep with the pipeline title while it
 * is still auto-managed. Returns true when `chat.name` changed.
 */
export function syncSuperPlanChatTitle(chat: Chat): boolean {
  if (normalizeModeId(chat.modeId) !== 'super-plan') return false;
  const sp = chat.superPlanView;
  if (!sp) return false;
  if (!isManagedSuperPlanChatTitle(chat.name)) return false;
  const next = resolveSuperPlanDisplayTitle(sp);
  if (chat.name === next) return false;
  chat.name = next;
  return true;
}

/** UI label for a Super Plan run — never the full opening prompt. */
export function resolveSuperPlanDisplayTitle(
  sp: SuperPlanState,
  path?: string,
): string {
  const display = sp.displayTitle?.trim();
  if (display) return display;
  const planPath =
    path?.trim() ||
    sp.stages.present?.artifactPath?.trim() ||
    sp.planPath?.trim() ||
    '';
  if (planPath) return titleFromPlanPath(planPath);
  if (sp.specPath?.trim()) {
    const base = sp.specPath.split('/').pop()?.replace(/-spec\.md$/i, '') ?? '';
    if (base && !base.startsWith('plan-')) return titleFromPlanPath(`${base}.md`);
  }
  return 'Untitled plan';
}

export function planLibraryStateLabel(state: PlanLibraryState): string {
  switch (state) {
    case 'waiting':
      return 'needs you';
    case 'saved':
      return '';
    default:
      return state;
  }
}

/** Latest pipeline timestamp on a run, used when the plan file does not exist yet. */
function runTimestamp(sp: SuperPlanState): number | undefined {
  let latest = 0;
  for (const stageId of SUPER_PLAN_DISPLAY_ORDER) {
    const record = sp.stages[stageId];
    if (!record) continue;
    latest = Math.max(latest, record.finishedAt ?? 0, record.startedAt ?? 0);
  }
  return latest > 0 ? latest : undefined;
}

function runState(sp: SuperPlanState): PlanLibraryState {
  if (sp.cancelled) return 'cancelled';
  const record = sp.stages[sp.activeStage];
  if (record?.status === 'error') return 'error';
  if (sp.paused) return 'paused';
  if (record?.status === 'blocked_user') return 'waiting';
  if (sp.activeStage === 'present' && record?.status === 'done') return 'done';
  return 'running';
}

function runPlanPath(sp: SuperPlanState): string {
  return (
    sp.stages.present?.artifactPath?.trim() ||
    sp.planPath?.trim() ||
    ''
  );
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

/** Every super-plan chat that carries pipeline state in the given workspace. */
export function collectSuperPlanRuns(workspacePath = getWorkspacePath()): PlanLibraryEntry[] {
  const workspaceKey = normalizeWorkspacePath(workspacePath);
  const chats: Chat[] = sessionState?.chats ?? [];
  const rows: PlanLibraryEntry[] = [];
  for (const chat of chats) {
    if (workspaceKey && !isChatInWorkspace(chat, workspaceKey)) continue;
    if (normalizeModeId(chat.modeId) !== 'super-plan') continue;
    const sp = chat.superPlanView;
    if (!sp) continue;
    const path = runPlanPath(sp);
    const state = sp.state;
    const position = sp.stageIndex;
    rows.push({
      key: path || chat.id,
      path,
      title: resolveSuperPlanDisplayTitle(sp, path),
      chatId: chat.id,
      state,
      stageLabel: sp.stageLabel,
      stagePosition: position > 0 ? { index: position, total: sp.stageTotal } : undefined,
      atMs: sp.atMs,
      executable: Boolean(path && isExecutableOrchestratePlan(path)),
    });
  }
  return rows;
}

function parseModifiedMs(raw: string): number | undefined {
  const match = /^modified:\s*(.+)$/m.exec(raw);
  if (!match) return undefined;
  const ms = Date.parse(match[1]!.trim());
  return Number.isFinite(ms) ? ms : undefined;
}

/** Bounded parallel stat. Failures resolve to undefined rather than rejecting the list. */
async function readModifiedTimes(paths: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const queue = paths.slice(0, METADATA_BUDGET);
  let cursor = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor;
      cursor += 1;
      const path = queue[index];
      if (!path) return;
      try {
        const result = await executeTool('get_file_metadata', { path });
        const content = typeof result.content === 'string' ? result.content : '';
        const ms = parseModifiedMs(content);
        if (ms !== undefined) out.set(path, ms);
      } catch {}
    }
  }

  const workers = Array.from(
    { length: Math.min(METADATA_CONCURRENCY, queue.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return out;
}

/** Parse find_files stdout into relative paths (drops the truncation footer). */
function parsePaths(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith('Error:') || trimmed.startsWith('No files matching')) {
    return [];
  }
  return trimmed
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('(truncated'));
}

function isTopLevelPlan(path: string): boolean {
  const rest = path.replace(/^documentation\/plans\//, '');
  return rest.length > 0 && !rest.includes('/');
}

// ── List ─────────────────────────────────────────────────────────────────────

export async function listSuperPlanLibrary(): Promise<PlanLibraryResult> {
  const runs = collectSuperPlanRuns();
  const byPath = new Map<string, PlanLibraryEntry>();
  for (const run of runs) {
    if (run.path) byPath.set(run.path, run);
  }

  if (!isLocalServerAvailable()) {
    return { entries: sortLibrary(runs), error: 'server_off' };
  }

  let paths: string[] = [];
  try {
    const result = await executeTool('find_files', {
      path: 'documentation/plans',
      pattern: '*.md',
    });
    const content = typeof result.content === 'string' ? result.content : '';
    const trimmed = content.trim();
    if (trimmed.startsWith('Error:')) {
      const msg = trimmed.replace(/^Error:\s*/i, '').trim();
      const code = /ENOENT|no such file or directory/i.test(msg) ? 'no_plans_dir' : msg;
      return { entries: sortLibrary(runs), error: code || 'find_files failed' };
    }
    paths = parsePaths(content).filter(isTopLevelPlan);
  } catch (err) {
    return {
      entries: sortLibrary(runs),
      error: err instanceof Error ? err.message : 'find_files failed',
    };
  }

  const fileOnly = paths.filter((p) => !byPath.has(p));
  const modified = await readModifiedTimes(paths);

  for (const run of runs) {
    if (run.path && modified.has(run.path) && run.atMs === undefined) {
      run.atMs = modified.get(run.path);
    }
  }

  const entries: PlanLibraryEntry[] = [...runs];
  for (const path of fileOnly) {
    entries.push({
      key: path,
      path,
      title: titleFromPlanPath(path),
      state: 'saved',
      atMs: modified.get(path),
      executable: isExecutableOrchestratePlan(path),
    });
  }

  return { entries: sortLibrary(entries) };
}

/** Live rows float to the top; the rest fall back to recency, then title. */
function sortLibrary(entries: PlanLibraryEntry[]): PlanLibraryEntry[] {
  const rank: Record<PlanLibraryState, number> = {
    waiting: 0,
    running: 0,
    error: 0,
    paused: 0,
    cancelled: 1,
    done: 1,
    saved: 1,
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

export function groupPlanLibraryEntries(
  entries: PlanLibraryEntry[],
  nowMs = Date.now(),
): PlanLibraryGroup[] {
  const isLive = (e: PlanLibraryEntry): boolean =>
    e.state === 'running' || e.state === 'waiting' || e.state === 'paused' || e.state === 'error';
  const live = entries.filter(isLive);
  const rest = entries.filter((e) => !isLive(e));
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

/**
 * Renderer-side cache of Super Plan runs.
 *
 * Views arrive from three places: command responses, the SSE stream of a run
 * someone is looking at, and a background poll of the active runs. Every
 * arrival goes through {@link applySuperPlanView} / {@link applySuperPlanSummary},
 * which keep `chat.superPlanView` (the sidebar and library summary) current
 * and raise one alert each time a run starts waiting on the user.
 */

import { listSuperPlanRuns, fetchSuperPlanView, openSuperPlanStream } from './api';
import { syncSuperPlanChatTitle } from './plan-library';
import { findChatById, scheduleSaveSessions, sessionState } from '../../state/sessions';
import type {
  SuperPlanChatSummary,
  SuperPlanLiveFrame,
  SuperPlanRunSummary,
  SuperPlanRunView,
} from './types';
import type { Chat } from '../../types';

type ViewListener = (view: SuperPlanRunView) => void;
type LiveListener = (frame: SuperPlanLiveFrame) => void;

const views = new Map<string, SuperPlanRunView>();
const viewListeners = new Set<ViewListener>();
const summaryListeners = new Set<(runId: string) => void>();
const streams = new Map<string, { close: () => void; refs: number; live: Set<LiveListener> }>();
/** Last attention key per run, so an alert fires once per ask. */
const attention = new Map<string, string>();

let pollTimer: ReturnType<typeof setInterval> | null = null;
let polling = false;
let sidebarTimer: ReturnType<typeof setTimeout> | null = null;

/** How often the background poll refreshes runs nobody is streaming. */
const POLL_MS = 4000;

// ── Views ────────────────────────────────────────────────────────────────────

export function getSuperPlanRunView(runId: string | undefined | null): SuperPlanRunView | undefined {
  return runId ? views.get(runId) : undefined;
}

/** Fires for every newer view of any run. */
export function subscribeSuperPlanViews(listener: ViewListener): () => void {
  viewListeners.add(listener);
  return () => {
    viewListeners.delete(listener);
  };
}

/** Fires when a chat's summary changed (sidebar, library). */
export function subscribeSuperPlanSummaries(listener: (runId: string) => void): () => void {
  summaryListeners.add(listener);
  return () => {
    summaryListeners.delete(listener);
  };
}

/** The summary the chat row keeps, derived from a full view. */
export function summaryFromView(view: SuperPlanRunView): SuperPlanChatSummary {
  return {
    runId: view.runId,
    title: view.title,
    slug: view.slug,
    prompt: view.prompt,
    status: view.status,
    stage: view.current ?? '',
    stageLabel: view.currentLabel,
    activity: view.activity,
    needsInput: view.needsInput,
    attentionKey: view.attentionKey,
    finished: view.finished,
    ...(view.artifacts.plan ? { planPath: view.artifacts.plan.path } : {}),
    ...(view.artifacts.spec ? { specPath: view.artifacts.spec.path } : {}),
    atMs: view.updatedAt ?? view.createdAt ?? 0,
    seq: view.seq,
  };
}

/** Store a view if it is not older than what we have, and propagate it. */
export function applySuperPlanView(view: SuperPlanRunView): void {
  const prior = views.get(view.runId);
  if (prior && prior.seq > view.seq) return;
  views.set(view.runId, view);
  applySuperPlanSummary(summaryFromView(view), view.chatId);
  for (const listener of viewListeners) {
    try {
      listener(view);
    } catch (err) {
      console.warn('[super-plan] view listener failed:', err);
    }
  }
}

/** The chat that owns a run, if this window knows it. */
export function findSuperPlanChat(runId: string, chatId?: string | null): Chat | undefined {
  return (chatId ? findChatById(chatId) : undefined) ?? sessionState?.chats.find((c) => c.superPlanRunId === runId);
}

/** Store a summary on its chat and raise attention when it starts waiting. */
export function applySuperPlanSummary(summary: SuperPlanChatSummary, chatId?: string | null): void {
  const chat = findSuperPlanChat(summary.runId, chatId);
  if (!chat) return;
  const before = chat.superPlanView;
  if (before && before.runId === summary.runId && (before.seq ?? 0) > summary.seq) return;
  chat.superPlanRunId = summary.runId;
  chat.superPlanView = summary;
  const renamed = syncSuperPlanChatTitle(chat, before?.title);
  if (renamed) scheduleSaveSessions({ chatId: chat.id });
  const changed =
    renamed ||
    !before ||
    before.status !== summary.status ||
    before.needsInput !== summary.needsInput ||
    before.title !== summary.title ||
    before.stageLabel !== summary.stageLabel;
  if (changed) scheduleSidebarRefresh();
  for (const listener of summaryListeners) listener(summary.runId);
  noteAttention(chat, summary);
}

/** Chat names and "needs you" dots follow the run; repaint the sidebar once per burst. */
function scheduleSidebarRefresh(): void {
  if (sidebarTimer) return;
  sidebarTimer = setTimeout(() => {
    sidebarTimer = null;
    void import('../../ui/sidebar').then((m) => m.renderSidebar()).catch(() => undefined);
  }, 120);
}

// ── Attention ────────────────────────────────────────────────────────────────

function attentionCopy(summary: SuperPlanChatSummary): string {
  switch (summary.needsInput) {
    case 'question':
      return 'The interview has questions for you';
    case 'spec':
      return 'The spec is ready for review';
    case 'accept':
      return 'The plan is ready for review';
    case 'halted':
      return summary.activity || 'A stage needs attention';
    default:
      return summary.activity;
  }
}

/**
 * One alert per ask, unless the user is already looking at the run. The first
 * sighting of a run only records its state: a plan that was already waiting
 * when the window opened is shown by the sidebar, not announced again.
 */
function noteAttention(chat: Chat, summary: SuperPlanChatSummary): void {
  const key = summary.attentionKey ?? '';
  const prior = attention.get(summary.runId);
  attention.set(summary.runId, key);
  if (!key || prior === undefined || prior === key) return;
  void (async () => {
    const [{ isSuperPlanScreenShowingRun }, { pushNotification }, { appIdForChat }] = await Promise.all([
      import('../../ui/super-plan-entry'),
      import('../../notifications/push'),
      import('../../notifications/app-for-chat'),
    ]);
    const watching = isSuperPlanScreenShowingRun(summary.runId) && typeof document !== 'undefined' && document.hasFocus();
    if (watching) return;
    pushNotification({
      kind: summary.needsInput === 'halted' ? 'chat_turn_error' : 'chat_question',
      title: summary.title || 'Super Plan',
      preview: attentionCopy(summary),
      chatId: chat.id,
      appId: appIdForChat(chat),
      dedupeKey: `super-plan:${summary.runId}:${key}`,
      os: true,
    });
  })().catch(() => undefined);
}

// ── Fetch and stream ─────────────────────────────────────────────────────────

/** Fetch the run's view from the server and apply it. */
export async function refreshSuperPlanRun(runId: string): Promise<SuperPlanRunView | null> {
  try {
    const view = await fetchSuperPlanView(runId);
    applySuperPlanView(view);
    return view;
  } catch (err) {
    console.warn('[super-plan] could not load run', runId, err);
    return null;
  }
}

/**
 * Stream a run while someone is looking at it. Reference-counted: several
 * views of one run share one connection. The server pushes a fresh view on
 * connect (and on every reconnect) and after every change.
 */
export function watchSuperPlanRun(runId: string, onLive?: LiveListener): () => void {
  let entry = streams.get(runId);
  if (!entry) {
    const live = new Set<LiveListener>();
    const close = openSuperPlanStream(runId, {
      onView: (view) => applySuperPlanView(view),
      onLive: (frame) => {
        for (const listener of live) listener(frame);
      },
    });
    entry = { close, refs: 0, live };
    streams.set(runId, entry);
  }
  entry.refs += 1;
  if (onLive) entry.live.add(onLive);
  const owned = entry;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (onLive) owned.live.delete(onLive);
    owned.refs -= 1;
    if (owned.refs <= 0) {
      owned.close();
      if (streams.get(runId) === owned) streams.delete(runId);
    }
  };
}

// ── Background sync ──────────────────────────────────────────────────────────

async function pollActiveRuns(): Promise<void> {
  if (polling) return;
  polling = true;
  try {
    const tracked = (sessionState?.chats ?? []).filter(
      (chat) => chat.superPlanRunId && !chat.superPlanView?.finished && !streams.has(chat.superPlanRunId),
    );
    if (!tracked.length) return;
    const runs = await listSuperPlanRuns({ ids: tracked.map((chat) => chat.superPlanRunId!) });
    for (const run of runs) applySummaryRow(run);
  } catch {
    /* the server may be restarting; the next tick retries */
  } finally {
    polling = false;
  }
}

function applySummaryRow(run: SuperPlanRunSummary): void {
  const known = views.get(run.runId);
  if (known && known.seq >= run.seq) return;
  const { chatId, workspacePath: _workspace, ...summary } = run;
  applySuperPlanSummary(summary, chatId);
}

/** Keep sidebar and library rows current for runs nobody is streaming. Idempotent. */
export function startSuperPlanBackgroundSync(): void {
  if (pollTimer) return;
  void pollActiveRuns();
  pollTimer = setInterval(() => void pollActiveRuns(), POLL_MS);
  (pollTimer as unknown as { unref?: () => void }).unref?.();
}

/** Tests: drop cached state and timers. */
export function resetSuperPlanStoreForTests(): void {
  views.clear();
  viewListeners.clear();
  summaryListeners.clear();
  for (const entry of streams.values()) entry.close();
  streams.clear();
  attention.clear();
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  if (sidebarTimer) clearTimeout(sidebarTimer);
  sidebarTimer = null;
}

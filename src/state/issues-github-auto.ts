/**
 * Automatic GitHub sync for Issues: change-triggered push/create plus a
 * 5-minute linked-only pull while Minnow is running (including background).
 *
 * Decisions stay in `github-sync-plan.ts`. This module only schedules when
 * to call `syncIssueWithGithub`. Successful background sync stays quiet.
 */

import { userFacingGithubError, isLocalServerOfflineError, isGithubRateLimitError, githubRateLimitRetryAt } from '../issues/github-error';
import { issueNeedsGithubPush, type RemoteIssueSnapshot } from '../issues/github-sync-plan';
import { isLocalServerAvailable } from '../tools/config';
import { normalizeWorkspacePath, workspacePathsEqual } from '../lib/normalize-workspace-path';
import { getWorkspacePath } from './workspace';
import { findIssueById, isIssuesStoreLoaded, listIssues } from './issues-store';
import { subscribeGithubSyncedFieldWrite } from './issues-github-notify';
import { runGithubSyncQueue } from '../issues/github-sync-queue';
import {
  githubAutoSyncActive,
  subscribeIssuesGithubAuto,
  subscribeIssuesGithubMode,
  syncIssueWithGithub,
  readGithubIssueChanges,
  type SyncOutcome,
} from './issues-github';

/** Pause after the last GitHub-field write so a burst of edits is one `gh` call. */
export const GITHUB_AUTO_DEBOUNCE_MS = 1_500;
/** Quiet linked-only check, including while the desktop shell is in the background. */
export const GITHUB_AUTO_POLL_MS = 5 * 60 * 1_000;
/** After auth/`gh` failures, skip poller toasts and ticks for this long. */
export const GITHUB_AUTO_ERROR_COOLDOWN_MS = 15 * 60 * 1_000;

let debounceMs = GITHUB_AUTO_DEBOUNCE_MS;
let pollMs = GITHUB_AUTO_POLL_MS;
let errorCooldownMs = GITHUB_AUTO_ERROR_COOLDOWN_MS;

const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
const inFlight = new Set<string>();
const rerunAfterFlight = new Set<string>();

let loopStarted = false;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let pollerInFlight = false;
let pollerCooldownUntil = 0;
let lastErrorToastAt = 0;
let unsubMode: (() => void) | null = null;
let unsubAuto: (() => void) | null = null;
let unsubPower: (() => void) | null = null;
const pollCursors = new Map<string, { cursor: number; at: number; links: string }>();

function nowMs(): number {
  return Date.now();
}

/** Test-only: shrink debounce / poll / cooldown so assertions do not wait minutes. */
export function setGithubAutoSyncTimingForTests(options: {
  debounceMs?: number;
  pollMs?: number;
  errorCooldownMs?: number;
}): void {
  if (options.debounceMs != null) debounceMs = options.debounceMs;
  if (options.pollMs != null) pollMs = options.pollMs;
  if (options.errorCooldownMs != null) errorCooldownMs = options.errorCooldownMs;
}

function cancelDebounce(issueId: string): void {
  const timer = debounceTimers.get(issueId);
  if (timer != null) {
    clearTimeout(timer);
    debounceTimers.delete(issueId);
  }
}

function cancelAllDebounces(): void {
  for (const timer of debounceTimers.values()) clearTimeout(timer);
  debounceTimers.clear();
}

function stopPollTimer(): void {
  if (pollTimer != null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function ensurePollTimer(): void {
  if (pollTimer != null) return;
  pollTimer = setInterval(() => {
    void runGithubAutoSyncLinkedPass();
  }, pollMs);
}

function shouldToastError(): boolean {
  const now = nowMs();
  if (now - lastErrorToastAt < errorCooldownMs) return false;
  lastErrorToastAt = now;
  return true;
}

function isAuthOrGhError(message: string): boolean {
  return (
    isLocalServerOfflineError(message) ||
    /not signed in/i.test(message) ||
    /gh auth/i.test(message) ||
    /github cli is not/i.test(message) ||
    /could not find gh/i.test(message)
  );
}

async function toastError(message: string): Promise<void> {
  if (!shouldToastError()) return;
  try {
    const { showGitUiFailure } = await import('../ui/git-ui-op');
    showGitUiFailure(message, { chatKind: 'github' });
  } catch {}
}

async function handleAutoOutcome(outcome: SyncOutcome): Promise<void> {
  if (outcome.ok) return;
  const message = userFacingGithubError(outcome.error);
  if (isAuthOrGhError(outcome.error ?? '') || isLocalServerOfflineError(message)) {
    pollerCooldownUntil = nowMs() + errorCooldownMs;
  }
  if (isGithubRateLimitError(outcome.error)) {
    pollerCooldownUntil = Math.max(pollerCooldownUntil, githubRateLimitRetryAt(outcome.error));
  }
  await toastError(message);
}

/** True when a debounce, in-flight call, or queued rerun owns this issue. */
export function isGithubAutoSyncBusy(issueId: string): boolean {
  return debounceTimers.has(issueId) || inFlight.has(issueId) || rerunAfterFlight.has(issueId);
}

async function runAutoSync(issueId: string, snapshot?: { workspacePath: string; remote: RemoteIssueSnapshot }): Promise<SyncOutcome | undefined> {
  if (!githubAutoSyncActive()) return;
  if (nowMs() < pollerCooldownUntil) {
    scheduleIssueGithubAutoSync(issueId);
    return;
  }
  if (inFlight.has(issueId)) {
    rerunAfterFlight.add(issueId);
    return;
  }

  inFlight.add(issueId);
  try {
    if (!findIssueById(issueId)) return;
    const outcome = await syncIssueWithGithub(issueId, snapshot);
    await handleAutoOutcome(outcome);
    if (!outcome.ok && isGithubRateLimitError(outcome.error) && !snapshot) scheduleIssueGithubAutoSync(issueId);
    return outcome;
  } catch (err) {
    const outcome: SyncOutcome = { ok: false, action: 'noop', error: err instanceof Error ? err.message : String(err) };
    await handleAutoOutcome(outcome);
    return outcome;
  } finally {
    inFlight.delete(issueId);
    if (rerunAfterFlight.delete(issueId) && githubAutoSyncActive()) {
      void runAutoSync(issueId);
    }
  }
}

/**
 * After a local GitHub-field write: wait `debounceMs`, then create or sync.
 * No-ops when Auto is off. Coalesces bursts on the same id.
 */
export function scheduleIssueGithubAutoSync(issueId: string): void {
  if (!githubAutoSyncActive()) return;
  const id = issueId.trim();
  if (!id) return;
  cancelDebounce(id);
  const timer = setTimeout(() => {
    debounceTimers.delete(id);
    void runAutoSync(id);
  }, Math.max(debounceMs, pollerCooldownUntil - nowMs()));
  debounceTimers.set(id, timer);
}

/** Run a pending debounce now (peek close / last-edit flush). No-op if none. */
export function flushIssueGithubAutoSync(issueId: string | undefined): void {
  const id = issueId?.trim();
  if (!id) return;
  if (!debounceTimers.has(id)) return;
  cancelDebounce(id);
  void runAutoSync(id);
}

function flushAllPendingGithubAutoSync(): void {
  const ids = [...debounceTimers.keys()];
  cancelAllDebounces();
  for (const id of ids) void runAutoSync(id);
}

/**
 * Linked-only pass used by the 5-minute timer, enable-on, boot, and wake-from-sleep.
 * Never creates unlinked cards. Only polls this window's workspace: the shared
 * issue store also contains closed projects that may no longer be allowlisted.
 */
export async function runGithubAutoSyncLinkedPass(): Promise<void> {
  if (!githubAutoSyncActive()) return;
  if (pollerInFlight) return;
  if (!isLocalServerAvailable()) return;
  if (!isIssuesStoreLoaded()) return;
  if (nowMs() < pollerCooldownUntil) return;

  pollerInFlight = true;
  try {
    const workspace = getWorkspacePath();
    const key = normalizeWorkspacePath(workspace);
    if (!key) return;
    const run = async () => {
      const issues = listIssues().filter((issue) => issue.github &&
        workspacePathsEqual(issue.workspacePath ?? '', workspace));
      if (!issues.length) return;
      const links = issues.map((issue) => issue.github!.number).sort((a, b) => a - b).join(',');
      const storageKey = `minnow.issues.github.poll:${key}`;
      let previous = pollCursors.get(key);
      try { previous = JSON.parse(localStorage.getItem(storageKey) ?? 'null') ?? previous; } catch {}
      if (previous?.links === links && Number.isFinite(previous.cursor) && previous.cursor <= nowMs() &&
        Number.isFinite(previous.at) && previous.at <= nowMs() &&
        nowMs() - previous.at < Math.max(0, pollMs - 1_000)) return;
      const since = previous?.links === links && Number.isFinite(previous.cursor) && previous.cursor <= nowMs()
        ? previous.cursor : undefined;
      const requestedAt = nowMs();
      const response = await readGithubIssueChanges(workspace, since);
      if (!response.ok || !Array.isArray(response.issues) || !Number.isFinite(response.cursor)) {
        await handleAutoOutcome({ ok: false, action: 'noop', error: response.error ?? 'Could not read GitHub issue changes' });
        return;
      }
      const remotes = new Map(response.issues.map((issue) => [issue.number, issue]));
      let completed = true;
      const keepGoing = () => nowMs() >= pollerCooldownUntil && githubAutoSyncActive() &&
        workspacePathsEqual(workspace, getWorkspacePath());
      await runGithubSyncQueue(issues, async (issue) => {
        const current = findIssueById(issue.id);
        if (!current?.github || !workspacePathsEqual(current.workspacePath ?? '', workspace)) {
          completed = false;
          return;
        }
        if (isGithubAutoSyncBusy(issue.id)) { completed = false; return; }
        const remote = remotes.get(issue.github!.number);
        if (!remote && since != null && !issueNeedsGithubPush(issue)) return;
        const outcome = await runAutoSync(issue.id, remote ? { workspacePath: workspace, remote } : undefined);
        if (!outcome?.ok) completed = false;
      }, keepGoing);
      if (completed && keepGoing()) {
        const next = { cursor: response.cursor!, at: requestedAt, links };
        pollCursors.set(key, next);
        try { localStorage.setItem(storageKey, JSON.stringify(next)); } catch {}
      }
    };
    if (typeof navigator !== 'undefined' && navigator.locks) {
      await navigator.locks.request(`minnow-github-poll:${key}`, run);
    } else await run();
  } finally {
    pollerInFlight = false;
  }
}

function applyGithubAutoSyncLoopState(): void {
  if (!githubAutoSyncActive()) {
    stopPollTimer();
    cancelAllDebounces();
    return;
  }
  ensurePollTimer();
  void runGithubAutoSyncLinkedPass();
}

/**
 * Start (or resume) the background loop. Idempotent. Call once after issues load.
 * Desktop shell already disables Chromium background throttling, so the interval
 * keeps firing while minimized.
 */
export function startGithubAutoSyncLoop(): void {
  if (loopStarted) {
    applyGithubAutoSyncLoopState();
    return;
  }
  loopStarted = true;
  unsubMode = subscribeIssuesGithubMode(() => applyGithubAutoSyncLoopState());
  unsubAuto = subscribeIssuesGithubAuto(() => applyGithubAutoSyncLoopState());
  if (typeof window !== 'undefined' && window.minnow?.power?.onScreenUnlocked) {
    unsubPower = window.minnow.power.onScreenUnlocked(() => {
      void runGithubAutoSyncLinkedPass();
    });
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', flushAllPendingGithubAutoSync);
  }
  applyGithubAutoSyncLoopState();
}

/** Stop timers and listeners (tests). Does not abort an in-flight `gh` call. */
export function resetGithubAutoSyncForTests(): void {
  loopStarted = false;
  stopPollTimer();
  cancelAllDebounces();
  inFlight.clear();
  rerunAfterFlight.clear();
  pollerInFlight = false;
  pollerCooldownUntil = 0;
  pollCursors.clear();
  lastErrorToastAt = 0;
  debounceMs = GITHUB_AUTO_DEBOUNCE_MS;
  pollMs = GITHUB_AUTO_POLL_MS;
  errorCooldownMs = GITHUB_AUTO_ERROR_COOLDOWN_MS;
  unsubMode?.();
  unsubAuto?.();
  unsubPower?.();
  unsubMode = null;
  unsubAuto = null;
  unsubPower = null;
  if (typeof window !== 'undefined') {
    window.removeEventListener('beforeunload', flushAllPendingGithubAutoSync);
  }
}

// Store writes notify this module without importing it from issues-store.
subscribeGithubSyncedFieldWrite(scheduleIssueGithubAutoSync);

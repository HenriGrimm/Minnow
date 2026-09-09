/**
 * Automatic GitHub sync for Issues: change-triggered push/create plus a
 * 5-minute linked-only pull while Minnow is running (including background).
 *
 * Decisions stay in `github-sync-plan.ts`. This module only schedules when
 * to call `syncIssueWithGithub`. Successful background sync stays quiet.
 */

import { userFacingGithubError, isLocalServerOfflineError } from '../issues/github-error';
import { isLocalServerAvailable } from '../tools/config';
import { findIssueById, listIssues } from './issues-store';
import { subscribeGithubSyncedFieldWrite } from './issues-github-notify';
import {
  githubAutoSyncActive,
  subscribeIssuesGithubAuto,
  subscribeIssuesGithubMode,
  syncIssueWithGithub,
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
  await toastError(message);
}

/** True when a debounce, in-flight call, or queued rerun owns this issue. */
export function isGithubAutoSyncBusy(issueId: string): boolean {
  return debounceTimers.has(issueId) || inFlight.has(issueId) || rerunAfterFlight.has(issueId);
}

async function runAutoSync(issueId: string): Promise<void> {
  if (!githubAutoSyncActive()) return;
  if (inFlight.has(issueId)) {
    rerunAfterFlight.add(issueId);
    return;
  }

  inFlight.add(issueId);
  try {
    if (!findIssueById(issueId)) return;
    const outcome = await syncIssueWithGithub(issueId);
    await handleAutoOutcome(outcome);
  } catch (err) {
    await toastError(userFacingGithubError(err instanceof Error ? err.message : String(err)));
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
  }, debounceMs);
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
 * Never creates unlinked cards.
 */
export async function runGithubAutoSyncLinkedPass(): Promise<void> {
  if (!githubAutoSyncActive()) return;
  if (pollerInFlight) return;
  if (!isLocalServerAvailable()) return;
  if (nowMs() < pollerCooldownUntil) return;

  pollerInFlight = true;
  try {
    for (const issue of listIssues()) {
      if (!issue.github) continue;
      if (isGithubAutoSyncBusy(issue.id)) continue;
      await runAutoSync(issue.id);
      if (nowMs() < pollerCooldownUntil || !githubAutoSyncActive()) break;
    }

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

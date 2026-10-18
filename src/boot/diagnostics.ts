/**
 * Renderer global error handlers — surface crashes visibly and forward to main log.
 */

import { isFileErrorsToIssuesEnabled } from '../diagnostics/prefs.ts';
import { pushNotification } from '../notifications/push';
import {
  addIssue,
  bugSeverityToIssuePriority,
  isIssuesStoreLoaded,
  updateIssue,
} from '../state/issues-store';
import { getWorkspacePath } from '../state/workspace';
import { setStatus } from '../ui/status';

// ── Surface keys ─────────────────────────────────────────────────────────────

const KEY_DEDUPE_MS = 10_000;
const BUG_CARD_WINDOW_MS = 60_000;
const BUG_CARD_CAP = 5;

/** Tracks per-key UI dedupe and global bug-card rate limit. */
type SurfaceState = {
  lastSurfacedByKey: Map<string, number>;
  bugCardTimestamps: number[];
  suppressedCount: number;
  suppressionBugId: string | null;
};

const surfaceState: SurfaceState = {
  lastSurfacedByKey: new Map(),
  bugCardTimestamps: [],
  suppressedCount: 0,
  suppressionBugId: null,
};

/** Reset dedupe state (tests only). */
export function resetDiagnosticsSurfaceStateForTests(): void {
  surfaceState.lastSurfacedByKey.clear();
  surfaceState.bugCardTimestamps.length = 0;
  surfaceState.suppressedCount = 0;
  surfaceState.suppressionBugId = null;
}

/** Extract first stack frame for dedupe key stability. */
export function firstStackFrame(stack?: string): string {
  if (!stack) return '';
  const line = stack.split('\n').find((l) => l.trim().startsWith('at '));
  return line?.trim() ?? '';
}

/** Build dedupe key from kind, message, and first stack frame. */
export function buildSurfaceKey(kind: string, message: string, stack?: string): string {
  return `${kind}|${message}|${firstStackFrame(stack)}`;
}

/**
 * Decide whether to surface UI for an error.
 * Always logs to main; UI may be suppressed by per-key or global caps.
 */
export function shouldSurface(
  key: string,
  nowMs: number,
  state: SurfaceState = surfaceState,
): { logToMain: boolean; surfaceUi: boolean; rollSuppressionCard: boolean } {
  const lastForKey = state.lastSurfacedByKey.get(key);
  if (lastForKey !== undefined && nowMs - lastForKey < KEY_DEDUPE_MS) {
    return { logToMain: true, surfaceUi: false, rollSuppressionCard: false };
  }

  while (
    state.bugCardTimestamps.length > 0 &&
    nowMs - state.bugCardTimestamps[0]! > BUG_CARD_WINDOW_MS
  ) {
    state.bugCardTimestamps.shift();
  }

  if (state.bugCardTimestamps.length >= BUG_CARD_CAP) {
    state.suppressedCount += 1;
    return { logToMain: true, surfaceUi: false, rollSuppressionCard: true };
  }

  state.lastSurfacedByKey.set(key, nowMs);
  state.bugCardTimestamps.push(nowMs);
  state.suppressedCount = 0;
  state.suppressionBugId = null;
  return { logToMain: true, surfaceUi: true, rollSuppressionCard: false };
}

function truncateStatus(message: string, max = 80): string {
  const trimmed = message.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}…`;
}

/**
 * Chromium reports a ResizeObserver notification backlog as a window `error`.
 * It is not a crash: a callback changed layout in the same frame, so later
 * observations were deferred. CodeMirror, xterm, and compact composer all
 * hit this on workspace mount.
 */
const RESIZE_OBSERVER_LOOP_RE =
  /^ResizeObserver loop (completed with undelivered notifications|limit exceeded)\.?$/i;

/** True when the browser is only warning about a ResizeObserver notification loop. */
export function isBenignResizeObserverLoopError(message: string): boolean {
  return RESIZE_OBSERVER_LOOP_RE.test(message.trim());
}

// ── Report ───────────────────────────────────────────────────────────────────

function report(kind: string, message: string, stack?: string): void {
  const key = buildSurfaceKey(kind, message, stack);
  const decision = shouldSurface(key, Date.now());

  console.error(`[diagnostics] ${kind}: ${message}`, stack ?? '');

  window.minnow?.diagnostics?.reportError({ kind, message, stack });

  void fetch('/api/diagnostics/report', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      kind,
      message,
      stack,
      surface: window.location.hash || 'app',
    }),
  }).catch(() => {
  });

  setStatus('err', message);

  if (!isIssuesStoreLoaded() || !isFileErrorsToIssuesEnabled()) return;

  if (decision.rollSuppressionCard) {
    const count = surfaceState.suppressedCount;
    const title = `+${count} more suppressed errors`;
    const description = `${kind}\n${message}\n${stack ?? ''}`;
    if (surfaceState.suppressionBugId) {
      updateIssue(surfaceState.suppressionBugId, { notes: description });
    } else {
      const issueId = `bug-crash-${Date.now().toString(36)}`;
      addIssue(
        {
          title,
          description,
          type: 'bug',
          status: 'triage',
          priority: bugSeverityToIssuePriority('critical'),
          severity: 'critical',
          legacyBugId: issueId,
          workspacePath: getWorkspacePath(),
          source: 'crash',
        },
        issueId,
      );
      surfaceState.suppressionBugId = issueId;
    }
    return;
  }

  if (!decision.surfaceUi) return;

  const issueId = `bug-crash-${Date.now().toString(36)}`;
  const title = message.trim() || kind;
  addIssue(
    {
      title,
      description: `${kind}\n${stack ?? message}`,
      type: 'bug',
      status: 'triage',
      priority: bugSeverityToIssuePriority('critical'),
      severity: 'critical',
      legacyBugId: issueId,
      workspacePath: getWorkspacePath(),
      source: 'crash',
    },
    issueId,
  );

  pushNotification({
    kind: 'chat_turn_error',
    title: 'Application error',
    preview: truncateStatus(message, 120),
    appId: 'code',
    dedupeKey: `crash:${key}`,
  });
}

// ── Install ──────────────────────────────────────────────────────────────────

/** Install global renderer error handlers and recover last renderer crash marker. */
export function installRendererDiagnostics(): void {
  window.addEventListener('error', (ev) => {
    const message =
      ev.message || (ev.error instanceof Error ? ev.error.message : '') || 'Script error';
    if (isBenignResizeObserverLoopError(message)) {
      ev.preventDefault();
      return;
    }
    const stack = ev.error instanceof Error ? ev.error.stack : undefined;
    report('uncaught-error', message, stack);
  });

  window.addEventListener('unhandledrejection', (ev) => {
    const reason = ev.reason;
    const message =
      reason instanceof Error
        ? reason.message
        : typeof reason === 'string'
          ? reason
          : 'Unhandled rejection';
    const stack = reason instanceof Error ? reason.stack : undefined;
    report('unhandled-rejection', message, stack);
  });

  void window.minnow?.diagnostics?.getLastCrash?.().then((marker) => {
    if (!marker) return;
    const isOom = marker.reason === 'oom';
    const message = isOom
      ? 'Board stopped after out-of-memory crash — press Start when ready.'
      : `Recovered from crash: ${marker.reason ?? marker.kind} (exit ${marker.exitCode ?? '?'})`;
    report('render-process-gone-recovered', message, marker.message);
  });
}

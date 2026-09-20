/**
 * Loaded-model activity chip labels (MIN-647 / MIN-587).
 *
 * Kept I/O-free so Local Server and tests share the same copy without standing
 * up the Models page.
 */

import type { ServeActivity } from './api-client';
import { llamaRuntimeStatusView } from '../chat/llama-runtime-status';
import {
  overlayMatchesActivity,
  type InFlightPromptOverlay,
} from './in-flight-prompt';

/** `1.2k` / `917` — token counts read at a glance without a jumping column width. */
export function formatActivityTokenCount(tokens: number): string {
  if (tokens >= 10_000) return `${Math.round(tokens / 1000)}k`;
  if (tokens >= 1_000) return `${(tokens / 1000).toFixed(1)}k`;
  return String(tokens);
}

/** `1 queued` / `3 queued` — omitted when the host is not backed up. */
export function formatQueuedChipLabel(queued: number): string | null {
  const n = Number.isFinite(queued) ? Math.max(0, Math.trunc(queued)) : 0;
  if (n <= 0) return null;
  return n === 1 ? '1 queued' : `${n} queued`;
}

/**
 * One chip per working slot, Ready when idle, plus queue depth when llama.cpp
 * is deferring requests. Queue wins over Ready so a backed-up host is never
 * labelled idle.
 *
 * Prefill is a percent only when Minnow owns an in-flight `prompt_progress`
 * for this serve. `/slots` has no total, so a curl against the same host keeps
 * an honest token count.
 */
export function serveActivityChipLabels(
  activity: ServeActivity | undefined,
  overlay?: InFlightPromptOverlay | null,
): string[] {
  const queuedLabel = formatQueuedChipLabel(activity?.queued ?? 0);
  if (activity?.mtplx) {
    const work = activity.mtplx.activeRequests > 0 ? `${activity.mtplx.activeRequests} active` : 'Ready';
    return [activity.stale ? `${work} · stale` : work, ...(queuedLabel ? [queuedLabel] : [])];
  }

  if (!activity?.available) {
    return queuedLabel ? [queuedLabel] : ['Ready'];
  }

  const busy = activity.slots.filter((slot) => slot.state !== 'idle');
  if (!busy.length) {
    if (queuedLabel) return [queuedLabel];
    return [activity.stale ? 'Ready · stale' : 'Ready'];
  }

  const usePrefillPercent = overlayMatchesActivity(activity, overlay ?? null);
  const labels = busy.map((slot) => {
    if (slot.state === 'prompt' && usePrefillPercent && overlay) {
      const view = llamaRuntimeStatusView(
        {
          prompt_progress: {
            total: overlay.total,
            processed: overlay.processed,
            cache: overlay.cache,
            time_ms: 0,
          },
        },
        false,
      );
      return view.detail ? `${slot.id} PP ${view.detail}` : `${slot.id} PP ${formatActivityTokenCount(slot.promptProcessed)} tok`;
    }
    if (slot.state === 'prompt') {
      return `${slot.id} PP ${formatActivityTokenCount(slot.promptProcessed)} tok`;
    }
    return `${slot.id} GEN ${formatActivityTokenCount(slot.decoded)} tok`;
  });
  if (queuedLabel) labels.push(queuedLabel);
  return labels;
}

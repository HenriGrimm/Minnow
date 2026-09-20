/**
 * App-wide live activity for local llama.cpp serves.
 *
 * The header model picker is on screen everywhere, but the models store is started by
 * the Models page — subscribing to it from the header would tie a global surface to a
 * page's lifetime, and starting it as an import side effect would open an EventSource
 * on every boot whether or not anything is listening.
 *
 * So the feed owns the single SSE subscription: it opens on the first subscriber and
 * closes when the last one leaves. The models store consumes it like any other caller.
 *
 * Samples carry `libraryId` / `modelLabel`, so a surface can identify a row without
 * holding a serve list of its own.
 */

import { subscribeServeActivity, type ServeActivity } from './api-client';
import { formatQueuedChipLabel } from './serve-activity-chips';
import { getInFlightPromptOverlay } from './in-flight-prompt';

type FeedListener = (activity: ServeActivity) => void;

const listeners = new Set<FeedListener>();
const byServeId = new Map<string, ServeActivity>();
let sseUnsub: (() => void) | null = null;

/**
 * Subscribe to activity for every running local serve. Returns an unsubscribe that
 * tears the stream down once nobody is left listening.
 */
export function subscribeServeActivityFeed(listener: FeedListener): () => void {
  if (typeof EventSource !== 'function') return () => {};

  listeners.add(listener);

  if (!sseUnsub) {
    sseUnsub = subscribeServeActivity((activity) => {
      byServeId.set(activity.serveId, activity);
      for (const fn of listeners) {
        try {
          fn(activity);
        } catch {}
      }
    });
  }

  for (const activity of byServeId.values()) {
    try {
      listener(activity);
    } catch {}
  }

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) stopServeActivityFeed();
  };
}

/** Close the stream and drop the cache. Called on quit and when the last listener goes. */
export function stopServeActivityFeed(): void {
  sseUnsub?.();
  sseUnsub = null;
  byServeId.clear();
}

/** Every current sample, keyed by serve id. */
export function getServeActivityMap(): ReadonlyMap<string, ServeActivity> {
  return byServeId;
}

/**
 * Activity for a picker row, matched on the library id the option carries and falling
 * back to the runtime's own model label.
 *
 * Returns undefined for a model that is not a local serve — most rows in the picker.
 */
export function serveActivityForModelId(modelId: string): ServeActivity | undefined {
  const needle = modelId.trim();
  if (!needle) return undefined;
  for (const activity of byServeId.values()) {
    if (activity.libraryId && activity.libraryId === needle) return activity;
    if (activity.modelLabel && activity.modelLabel === needle) return activity;
  }
  return undefined;
}

/**
 * Compact suffix for a picker row: `pp 10.2k` while a prompt is being processed,
 * `917 tok` while generating, `2 queued` when llama.cpp is deferring work.
 *
 * Prefill is a count rather than a percentage on purpose — `/slots` reports the same
 * running number as both the processed count and the total, so no fraction exists.
 */
export function activitySuffixForModelId(modelId: string): string {
  const activity = serveActivityForModelId(modelId);
  if (activity?.available) {
    const queued = formatQueuedChipLabel(activity.queued ?? 0) ?? '';
    if (activity.stale) return queued;
    if (activity.mtplx) return [activity.mtplx.activeRequests > 0 ? `${activity.mtplx.activeRequests} active` : '', queued].filter(Boolean).join(' · ');
    const busy = activity.slots.find((slot) => slot.state !== 'idle');
    if (!busy) return queued;
    const work =
      busy.state === 'prompt'
        ? `pp ${compactTokens(busy.promptProcessed)}`
        : `${compactTokens(busy.decoded)} tok`;
    return queued ? `${work} · ${queued}` : work;
  }

  const overlay = getInFlightPromptOverlay();
  const needle = modelId.trim();
  if (
    overlay &&
    needle &&
    (overlay.libraryId === needle || overlay.modelLabel === needle)
  ) {
    if (overlay.total > 0 && overlay.processed < overlay.total) {
      const percent = Math.min(99, Math.floor((overlay.processed / overlay.total) * 100));
      return `pp ${percent}%`;
    }
    if ((overlay.predictedN ?? 0) > 0) {
      return `${compactTokens(overlay.predictedN)} tok`;
    }
  }
  return '';
}

/**
 * Repaint every `[data-activity-for]` node from the current samples.
 *
 * Called on each telemetry tick (~400 ms while a slot is busy), so it must never rebuild
 * the picker menu — a rebuild at that cadence would fight the user's pointer. Lives here
 * rather than in the picker because it only needs this module's data.
 */
export function syncModelActivityIndicators(root: ParentNode = document): void {
  const nodes = root.querySelectorAll<HTMLElement>('[data-activity-for]');
  for (const node of nodes) {
    const next = activitySuffixForModelId(node.dataset.activityFor ?? '');
    if (node.textContent !== next) node.textContent = next;
  }
}

/** True when any local serve is working — drives the header dot's animation. */
export function anyServeBusy(): boolean {
  for (const activity of byServeId.values()) {
    if (!activity.available) continue;
    if ((activity.queued ?? 0) > 0) return true;
    if (activity.stale) continue;
    if (activity.slots.some((slot) => slot.state !== 'idle')) return true;
  }
  const overlay = getInFlightPromptOverlay();
  if (!overlay) return false;
  if (overlay.total > 0 && overlay.processed < overlay.total) return true;
  return (overlay.predictedN ?? 0) > 0;
}

function compactTokens(tokens: number): string {
  if (tokens >= 10_000) return `${Math.round(tokens / 1000)}k`;
  if (tokens >= 1_000) return `${(tokens / 1000).toFixed(1)}k`;
  return String(tokens);
}

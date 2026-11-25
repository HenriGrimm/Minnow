import type { ServeActivity } from './api-client';
import { overlayMatchesActivity, type InFlightPromptOverlay } from './in-flight-prompt';

export interface LocalModelPhase {
  phase: 'idle' | 'prompt' | 'generating';
  /** Tokens per second for the current phase; null when no rate is known yet. */
  rate: number | null;
  /** Prompt fraction ready (0–1) when the total is known. */
  progress: number | null;
}

const IDLE: LocalModelPhase = { phase: 'idle', rate: null, progress: null };

function positive(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function fraction(done: number | null | undefined, total: number | null | undefined): number | null {
  if (done == null || !total || total <= 0) return null;
  return Math.max(0, Math.min(1, done / total));
}

/** What a local serve is doing right now: reading the prompt, generating, or nothing. */
export function localModelPhase(
  activity: ServeActivity,
  overlay: InFlightPromptOverlay | null = null,
): LocalModelPhase {
  if (!activity.available || activity.stale) return IDLE;

  const mtplx = activity.mtplx;
  if (mtplx) {
    if (mtplx.activeRequests <= 0) return IDLE;
    const live = mtplx.live;
    // Builds without a snapshot only report completed requests.
    if (!live) return { phase: 'generating', rate: positive(mtplx.latest?.decode_tok_s), progress: null };
    if (live.phase === 'prompt') {
      return { phase: 'prompt', rate: positive(live.promptTokS), progress: fraction(live.promptDone, live.promptTotal) };
    }
    return { phase: 'generating', rate: positive(live.decodeTokS), progress: null };
  }

  const generating = activity.slots.find((slot) => slot.state === 'generating');
  if (generating) return { phase: 'generating', rate: positive(generating.tokensPerSecond), progress: null };
  const prompt = activity.slots.find((slot) => slot.state === 'prompt');
  if (!prompt) return IDLE;
  // `/slots` has no prompt total; only Minnow's own stream knows it.
  const progress = overlay && overlayMatchesActivity(activity, overlay)
    ? fraction(overlay.processed, overlay.total)
    : null;
  return { phase: 'prompt', rate: positive(prompt.promptTokensPerSecond), progress };
}

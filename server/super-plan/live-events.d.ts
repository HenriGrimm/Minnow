/**
 * Live SSE channel for Super Plan: streamed output, tool activity and research
 * progress. Deliberately not journal events.
 */

export interface SuperPlanLiveEvent {
  runId: string;
  stage: string;
  attemptId?: string;
  event: Record<string, unknown>;
}

export function subscribeLive(
  runId: string,
  handler: (payload: SuperPlanLiveEvent) => void,
): () => void;

export function emitLive(payload: SuperPlanLiveEvent): void;

/** Coalesce and trim one attempt's `runTurn` events onto the live channel. */
export function createLiveForwarder(scope: { runId: string; stage: string; attemptId: string }): {
  emit(event: Record<string, unknown>): void;
  flush(): void;
};

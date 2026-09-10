/**
 * Live SSE channel for Super Plan research progress and activity.
 * Deliberately not journal events.
 */

import type { TurnEvent } from '../runner/run-turn';

export interface SuperPlanLiveEvent {
  key?: string;
  runId: string;
  stage: string;
  event: TurnEvent;
}

export function subscribeLive(
  runId: string,
  handler: (payload: SuperPlanLiveEvent) => void,
): () => void;

export function emitLive(payload: SuperPlanLiveEvent): void;

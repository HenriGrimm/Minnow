/** Apply one recorded TurnEvent onto an API-message list. */
export function applyTurnEventToMessages(
  messages: unknown[],
  event: unknown,
): unknown[];

/** Fold a transcript's events into API messages for the drawer. */
export function turnEventsToMessages(events: unknown[]): unknown[];

/** Count nested tool invocations from API-shaped messages. */
export function countToolCalls(messages: unknown[]): number;

/** Reconcile a fetched transcript with overlapping, newer live frames. */
export function mergeTranscriptMessages(history: unknown[], recent: unknown[]): unknown[];

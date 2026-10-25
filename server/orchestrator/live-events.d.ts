import type { TurnEvent } from '../runner/run-turn';

/**
 * Live attempt frame.
 */
export interface LiveAttemptEvent {
  /** Opaque routing key. Board events omit this and route on `boardId`. */
  key?: string;
  boardId: string;
  attemptId: string;
  taskId: string | null;
  role: string;
  roundIndex?: number;
  event: TurnEvent;
}

export function subscribeLive(
  key: string,
  handler: (payload: LiveAttemptEvent) => void,
): () => void;

export function emitLive(payload: LiveAttemptEvent): void;

/**
 * A failure that stopped work from starting.
 */
export interface BoardErrorEvent {
  /** Opaque routing key. Board events omit this and route on `boardId`. */
  key?: string;
  boardId: string;
  taskId: string | null;
  role: string;
  message: string;
  /** How many times this work has failed to start in a row. */
  consecutive: number;
}

export function subscribeErrors(
  key: string,
  handler: (payload: BoardErrorEvent) => void,
): () => void;

export function emitError(payload: BoardErrorEvent): void;

export interface DeliverEvent {
  key?: string;
  parentChatId: string;
  kind: 'completion' | 'check_in_nudge';
  runIds: string[];
  message: string;
}

export function subscribeDeliver(
  key: string,
  handler: (payload: DeliverEvent) => void,
): () => void;

/** Returns how many listeners received the frame. 0 means nobody is watching. */
export function emitDeliver(payload: DeliverEvent): number;

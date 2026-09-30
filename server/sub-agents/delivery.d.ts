import type { AgentsState, RunState } from './types';

export const RETRY_DELAY_MS: number;
/** Thrown by production inject when no SSE viewer is subscribed. */
export const NO_DELIVERY_LISTENER: string;
export function isNoDeliveryListenerError(err: unknown): boolean;

export type DeliverySkipReason = 'missing_chat' | 'orchestrate';

export interface DeliveryMeta {
  kind: 'completion' | 'check_in_nudge';
  runIds: string[];
}

export interface ParentStatus {
  streaming: boolean;
  skip: DeliverySkipReason | null;
}

export interface DeliveryJournal {
  loadState(id: string): Promise<AgentsState>;
  appendEvent(
    id: string,
    event: Record<string, unknown>,
    options?: { now?: () => number },
  ): Promise<Record<string, unknown>>;
  appendEvents?(
    id: string,
    events: Record<string, unknown>[],
    options?: { now?: () => number },
  ): Promise<Record<string, unknown>[]>;
  listEntries(): Promise<string[]>;
  readEvents?(id: string): Promise<Record<string, unknown>[]>;
  reset?(): void;
}

export interface DeliveryOptions {
  journal?: DeliveryJournal;
  loadState?: (id: string) => Promise<AgentsState>;
  appendEvent?: (
    id: string,
    event: Record<string, unknown>,
    options?: { now?: () => number },
  ) => Promise<Record<string, unknown>>;
  appendEvents?: (
    id: string,
    events: Record<string, unknown>[],
    options?: { now?: () => number },
  ) => Promise<Record<string, unknown>[]>;
  listEntries?: () => Promise<string[]>;
  deliverToParent?: (parentChatId: string, message: string, meta: DeliveryMeta) => Promise<void>;
  parentStatus?: (parentChatId: string) => ParentStatus;
  buildMessage?: (
    kind: 'completion' | 'check_in_nudge',
    runs: RunState[],
    extra?: { elapsedSec?: number },
  ) => string;
  notifyUndeliverable?: (parentChatId: string, run: RunState) => Promise<void> | void;
  sleep?: (ms: number) => Promise<void>;
  retryDelayMs?: number;
  requiresAcceptanceAck?: boolean;
  onDeliverError?: (err: unknown) => void;
}

export interface DeliveryHandle {
  tick(parentChatId: string): Promise<void>;
  acknowledge(parentChatId: string, runIds: string[]): Promise<string[]>;
  tickAll(): Promise<void>;
  offerNudge(input: {
    parentChatId: string;
    runId: string;
    elapsedSec?: number;
  }): Promise<boolean>;
  setDeliverToParent(
    fn: (parentChatId: string, message: string, meta: DeliveryMeta) => Promise<void>,
  ): void;
  reset(): void;
  journal: DeliveryJournal;
  loadState(id: string): Promise<AgentsState>;
}

export function createMemoryJournal(): DeliveryJournal;
export function defaultBuildMessage(
  kind: 'completion' | 'check_in_nudge',
  runs: RunState[],
  extra?: { elapsedSec?: number },
): string;
export function buildProductionParentMessage(
  kind: 'completion' | 'check_in_nudge',
  runs: RunState[],
  extra?: { elapsedSec?: number },
): string;
export function createDelivery(opts?: DeliveryOptions): DeliveryHandle;

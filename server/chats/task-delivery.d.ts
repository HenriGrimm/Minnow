import type { ChatCaller } from './caller';
import type { ChatContext } from './context';
import type { ChatTaskTerminalStatus } from './contracts';
import type { ChatRepository } from './repository';
import type { ChatCommandService } from './service';
import type { ChatTaskRepository } from './task-repository';
import type { PersistentTaskSettlement } from './task-bridge';
import type { Engine } from '../orchestrator/engine';
import type { TurnEvent } from '../runner/run-turn';
import type * as diskJournal from '../sub-agents/journal';

export type ChatTaskDeliveryEngine = Pick<Engine, 'append' | 'tick'>;
export interface ChatTaskWaitInput {
  caller: ChatCaller;
  runId: string;
  journalOwnerId: string;
  toolCallId?: string;
  signal?: AbortSignal;
  /** Timeout releases an inline hold without cancelling the task. */
  timeoutMs?: number;
}
export type ChatTaskWaitResult =
  | {
    runId: string; childChatId: string; status: ChatTaskTerminalStatus; summary: string;
    outcome: { kind: ChatTaskTerminalStatus; summary: string };
  }
  | { runId: string; childChatId: string; status: 'running'; timedOut: true };

export interface ChatTaskDelivery {
  readonly tasks: ChatTaskRepository;
  setEngineResolver(resolver: (journalOwnerId: string) => ChatTaskDeliveryEngine | Promise<ChatTaskDeliveryEngine>): void;
  onSettled(input: PersistentTaskSettlement): Promise<void>;
  /** Reconcile terminal journals and durable executions before scheduling work. */
  recover(): Promise<void>;
  start(): Promise<void>;
  drain(): Promise<void>;
  reconcileHolds(): void;
  onServiceEvent(event?: unknown): void;
  onHostEvent(input: { event?: TurnEvent; chatId?: string; executionId?: string }): void;
  onLegacyReleased(): void;
  waitForRun(input: ChatTaskWaitInput): Promise<ChatTaskWaitResult>;
  cancelTree(input: { chatId: string; commandId: string; throughPosition?: number; record?: import('./repository').CommandRecord }): Promise<void>;
  dispose(): Promise<void>;
}

export interface ChatTaskDeliveryOptions {
  repository: ChatRepository;
  context: Pick<ChatContext, 'resolveTarget'>;
  service: Pick<ChatCommandService, 'send' | 'settleChildTask' | 'stopExecution' | 'waitExecution'>;
  journal?: Pick<typeof diskJournal, 'appendEvent' | 'loadState' | 'listEntries'>;
  taskRepository?: ChatTaskRepository;
  isRecipientBusy?(chatId: string): boolean;
  isSourceActive?(source: { chatId: string | null; executionId: string | null }): boolean;
  isReady?(): boolean;
  onChange?(chatId: string): void;
  now?(): number;
  retryMs?: number;
  onError?(error: unknown): void;
}

export function createChatTaskDelivery(options: ChatTaskDeliveryOptions): ChatTaskDelivery;

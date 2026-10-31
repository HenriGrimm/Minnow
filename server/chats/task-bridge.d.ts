import type { AgentsState, RunState } from '../sub-agents/types';
import type { Effector, AttemptEnd } from '../orchestrator/engine';
import type { ChatCommandService } from './service';
import type { ChatRepository } from './repository';
import type { TurnResult } from '../runner/run-turn';
export interface PersistentTaskSettlement { run: RunState; executionId: string; attemptId: string; result: TurnResult; end: AttemptEnd }
export function observePersistentAgentTurn(input: { chatId: string; executionId: string; event: import('../runner/run-turn').TurnEvent }): void;
export function createLazyPersistentSubAgentEffector(options: {
  getRuntime(): Promise<{ service: Pick<ChatCommandService, 'startAdmittedChildTask'>; repository: Pick<ChatRepository, 'readExecutionFinalAssistant'>; taskDelivery?: { onSettled(input: PersistentTaskSettlement): void | Promise<void> } }>;
  legacyEffector: Effector & { started?: unknown[]; vanishAll?(): void; seedTranscript?(...args: any[]): void };
  getState(): AgentsState | Promise<AgentsState>;
  onError?(error: unknown): void;
}): ReturnType<typeof createPersistentSubAgentEffector>;
export function createPersistentSubAgentEffector(options: {
  legacyEffector: Effector & { started?: unknown[]; vanishAll?(): void; seedTranscript?(...args: any[]): void };
  service: Pick<ChatCommandService, 'startAdmittedChildTask'> & Partial<Pick<ChatCommandService, 'canResumeQuestionExecution'>>;
  repository: Pick<ChatRepository, 'readExecutionFinalAssistant'>;
  getState(): AgentsState | Promise<AgentsState>;
  onSettled?(input: PersistentTaskSettlement): void | Promise<void>;
  onError?(error: unknown): void;
}): Effector & { readonly started: unknown[]; vanishAll(): void; seedTranscript(...args: any[]): void };

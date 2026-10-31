import type { ChatCaller } from './caller.js';
import type { ChatCommand } from './contracts.js';
import type { ChatRepository } from './repository.js';

export interface ChatCausalSource { readonly causalRootId: string; readonly causalDepth: number }
export interface ChatCausalAdmission extends ChatCausalSource { readonly agentCoordination?: true }
export interface ChatCausalityLimits { readonly maxPeerCommands: number; readonly maxHops: number; readonly maxPendingPeerInputs: number }
export interface ChatCausality {
  readonly limits: ChatCausalityLimits;
  source(caller: ChatCaller): ChatCausalSource;
  /** Explicit delegation inherits its causal lineage without spending a peer-message budget. */
  inherit(caller: ChatCaller): ChatCausalSource;
  /** Must execute inside the same SQLite transaction as canonical command admission. */
  admit(input: { caller: ChatCaller; command: ChatCommand }): ChatCausalAdmission;
  /** Returns an idempotent disposer for an exact, currently live execution wait edge. */
  beforeWait(input: { caller: ChatCaller; chatId: string; executionId?: string; signal?: AbortSignal }): () => void;
  dispose(): void;
}
export function createChatCausality(options: {
  repository: ChatRepository;
  maxPeerCommands?: number;
  maxHops?: number;
  maxPendingPeerInputs?: number;
  /** Production binds the runtime's private current-owner validator, including legacy raw owners. */
  isCallerActive?: (caller: ChatCaller) => boolean;
}): ChatCausality;

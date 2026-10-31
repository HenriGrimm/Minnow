import type { ChatCaller, ChatProjectScope, ChatProjectRegistry } from './caller';
import type { ChatRepository, CommandRecord, ChatShell } from './repository';
import type { ChatContext, ChatTargetContext } from './context';
import type { ChatCommandService } from './service';
import type { AgentConversationsFeature, ModelSelection, TaskCompletionPolicy } from './contracts';
import type { captureChatProfile } from './preparation';
import type { ResolvedAgentModelSelection, AgentModelSelectionInput, AgentCatalogContext } from './model-selection';
import type { Engine } from '../orchestrator/engine';

export interface DelegationInput {
  type: string; task: string; title?: string; target?: ModelSelection;
  workspace_strategy?: 'shared' | 'new_worktree' | 'existing_worktree' | { kind: 'existing_worktree'; workspaceId: string };
  workspace_id?: string; client_request_id?: string; wait?: boolean;
  /** Compatibility identities; never additional model authority. */
  providerId?: string; modelId?: string; category?: string; board_task_id?: string;
}
export interface DelegationReceipt {
  runId: string; childChatId: string; commandId: string; executionId: string | null; status: string;
  link: string; modelSelection: ModelSelection; modelSource?: string; completionPolicy?: TaskCompletionPolicy;
  journalOwnerId?: string; replayed: boolean;
}
export interface ChatDelegation {
  spawn(caller: ChatCaller, input: DelegationInput, context?: { toolCallId?: string; signal?: AbortSignal }): Promise<DelegationReceipt>;
  admitChildTask(input: { record: CommandRecord; target: ChatTargetContext }): Promise<{ ready: false; runId?: string }>;
  onCommand(record: CommandRecord): Promise<unknown>;
  flush(): Promise<{ applied: number; failed: number; skipped: number }>;
  recover(): Promise<void>;
  cancelTree(input: unknown): Promise<unknown>;
  onTerminal?: (input: unknown) => unknown;
}
export interface ChatDelegationOptions {
  repository: ChatRepository; context: Pick<ChatContext, 'resolveTarget'>; service: ChatCommandService;
  getEngine(journalOwnerId: string): Promise<Engine> | Engine;
  validateSourceCaller(caller: ChatCaller): boolean;
  feature?(): AgentConversationsFeature;
  loadConfig?(): Promise<Record<string, any>>;
  captureProfile?: typeof captureChatProfile;
  resolveModelSelection?(input: AgentModelSelectionInput, context?: AgentCatalogContext): Promise<ResolvedAgentModelSelection>;
  getSourceModelSelection?(caller: ChatCaller, target: ChatTargetContext): ModelSelection | Promise<ModelSelection>;
  inheritCausality?(caller: ChatCaller): { causalRootId: string; causalDepth: number } | undefined;
  resolveWorkspace?(input: { caller: ChatCaller; target: ChatTargetContext; strategy: { kind: string; workspaceId?: string }; allocationId: string; childChatId: string; signal?: AbortSignal }): Promise<{
    workspacePath: string; scope: ChatProjectScope; registry: ChatProjectRegistry; worktreeRoot?: string; binding?: Record<string, unknown>;
  }>;
  now?: () => number; onChange?(chatId: string): void;
  onTerminal?(input: unknown): unknown;
  cancelTree?(input: unknown): Promise<unknown> | unknown;
}
export function createChatDelegation(options: ChatDelegationOptions): ChatDelegation;
export function installChatDelegation(runtime: any, options: Pick<ChatDelegationOptions, 'getEngine'> & Partial<ChatDelegationOptions>): ChatDelegation;

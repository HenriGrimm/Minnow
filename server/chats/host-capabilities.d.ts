import type { ChatRepository, ExecutionFence } from './repository';
import type { ChatHostPreparation } from './execution-host';
export interface HostToolResult { content: string; attachments?: unknown; codeChange?: unknown }
export interface HostToolEnvelope {
  version: 1; type: 'execute'; invocationId: string; hostId: string; projectId: string;
  chatId: string; executionId: string; toolCallId: string; name: string; args: Record<string, unknown>; inputHash: string;
  context: { modeId: string; workspaceRoot: string; runId: string; agentId: string; workAgentId?: string };
}
export interface HostToolCancel { version: 1; type: 'cancel'; invocationId: string }
export interface HostToolInput {
  name: string; args: Record<string, unknown>; ctx: { toolCallId: string }; chatId: string; executionId: string;
  fence: ExecutionFence; signal: AbortSignal; prepared: ChatHostPreparation;
  /** Trusted execution-owner callback, invoked after asynchronous policy hooks and before dispatch. */
  revalidate?(): Promise<unknown>;
}
export interface ChatHostCapabilities {
  register(input: { hostId: string; projectId: string; capabilities: readonly string[]; send(envelope: HostToolEnvelope | HostToolCancel): void | Promise<void> }): () => void;
  executeHostTool(input: HostToolInput): Promise<HostToolResult>;
  respond(input: { hostId: string; invocationId: string; result?: HostToolResult; indeterminate?: true }, context?: { projectId: string }): { accepted: true; replayed: boolean };
  dispose(): void;
  readonly connectedHosts: number; readonly pendingCount: number;
}
export function createChatHostCapabilities(options: {
  repository: ChatRepository;
  resolveProject(input: HostToolInput): Promise<{ projectId: string; workspaceRoot: string }> | { projectId: string; workspaceRoot: string };
  beforeDispatch?(input: HostToolInput): void | Promise<void>;
  onChange?(input: { chatId: string; executionId: string; state: 'waiting_for_host' | 'dispatched' | 'settled' | 'recovery_required' }): void | Promise<void>;
  now?: () => number; maxHosts?: number; maxPending?: number; resultLimit?: number; inputLimit?: number; retryMs?: number;
}): ChatHostCapabilities;
export function isHostToolNotStartedError(error: unknown): boolean;

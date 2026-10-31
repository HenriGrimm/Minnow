import type { ChatCaller } from './caller';
import type { ChatContext, ChatTargetContext } from './context';
import type { ChatRepository } from './repository';
import type { ChatCommandService } from './service';
import type { AgentCapabilitiesContext } from './capabilities';
import type { AgentConversationsFeature } from './contracts';
export interface ChatToolContext {
  caller: ChatCaller; toolCallId?: string; signal?: AbortSignal; approvalGranted?: boolean;
}
export interface ChatTools {
  execute(name: string, args: Record<string, unknown>, context: ChatToolContext): Promise<Record<string, any>>;
}
export interface ChatToolsOptions {
  repository: ChatRepository; context: Pick<ChatContext, 'resolveTarget'>; service: Pick<ChatCommandService, 'send' | 'stop'>;
  validateCaller(caller: ChatCaller): boolean;
  coordinationLimits?(): { maxPeerCommands: number; maxHops: number; maxPendingPeerInputs: number };
  capabilitiesContext?(caller: ChatCaller, source: ChatTargetContext, signal?: AbortSignal): AgentCapabilitiesContext | Promise<AgentCapabilitiesContext>;
  beforeWait?(input: { caller: ChatCaller; chatId: string; executionId: string; signal?: AbortSignal }):
    void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>;
  feature?(): AgentConversationsFeature; now?(): number;
}
export function createChatTools(options: ChatToolsOptions): ChatTools;
export function installChatTools(runtime: any, options?: Partial<ChatToolsOptions>): { tools: ChatTools; dispose(): void };

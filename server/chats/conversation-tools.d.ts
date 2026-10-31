import type { ChatRepository, ExecutionRecord, ExecutionFence } from './repository';
import type { ChatRequestService } from './requests';
import type { ChatPolicySnapshot } from './policy';
import type { PreparedChatExecution } from './preparation';
export function executeConversationTool(name: string, args: Record<string, unknown>, context: {
  repository: ChatRepository; execution: ExecutionRecord; fence: ExecutionFence; prepared: Pick<PreparedChatExecution, 'policy'>;
  requests?: ChatRequestService; signal?: AbortSignal; toolCallId?: string; currentPolicy?: ChatPolicySnapshot;
  askTimeoutMs?: number;
  now?: () => number; loadComposer?: () => Promise<any>;
  onChange?: (chatId: string) => void;
  onStatus?: (input: { chatId: string; executionId: string; status: 'waiting_for_input' | 'running' }) => void;
}): Promise<{ content: string } | null>;

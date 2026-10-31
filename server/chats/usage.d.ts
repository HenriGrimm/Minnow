import type { TokenLedgerEntry, ProviderPricing } from '../../src/usage/types';
import type { ModelSelection } from './contracts.js';
import type { ChatRepository, ExecutionFence } from './repository.js';
export interface ChatUsageReceipt { executionId: string; roundIndex: number; chatId: string; entry: TokenLedgerEntry | null; replayed: boolean }
export interface ChatUsage {
  nextRoundIndex(executionId: string): number;
  recordRound(input: { executionId: string; roundIndex: number; fence: ExecutionFence;
    turn: { providerId?: string; modelId?: string; streamMeta: Record<string, any>; t0?: number; tFirst?: number | null; tEnd?: number };
    modelSelection?: ModelSelection }): Promise<ChatUsageReceipt | null>;
}
export function createChatUsage(options: { repository: ChatRepository; readProviderPricing?: (providerId: string) => Promise<ProviderPricing | null>; now?: () => number }): ChatUsage;

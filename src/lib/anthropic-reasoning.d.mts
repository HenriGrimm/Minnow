import type { AnthropicThinkingBlock, ApiAssistantMessage } from '../types';

export function anthropicReasoningBlocks(value: unknown): AnthropicThinkingBlock[];
export function anthropicReasoningReplayFields(modelId: string, blocks: unknown): Pick<ApiAssistantMessage, 'reasoning_blocks'>;

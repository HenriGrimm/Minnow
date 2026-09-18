import type { AnthropicThinkingBlock, ApiAssistantMessage } from '../../src/types';

export function anthropicReasoningBlocks(value: unknown): AnthropicThinkingBlock[];
export function anthropicReasoningReplayFields(modelId: string, blocks: unknown): Pick<ApiAssistantMessage, 'reasoning_blocks'>;

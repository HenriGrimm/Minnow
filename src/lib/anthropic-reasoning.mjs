/** Preserve exact signed provider blocks separately from formatted UI thoughts. */
export function anthropicReasoningBlocks(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((block) => {
    if (!block || typeof block !== 'object') return [];
    if (block.type === 'thinking' && typeof block.thinking === 'string' &&
        typeof block.signature === 'string' && block.signature.length > 0) {
      return [{ type: 'thinking', thinking: block.thinking, signature: block.signature }];
    }
    if (block.type === 'redacted_thinking' && typeof block.data === 'string' && block.data.length > 0) {
      return [{ type: 'redacted_thinking', data: block.data }];
    }
    return [];
  });
}

export function anthropicReasoningReplayFields(modelId, blocks) {
  const valid = anthropicReasoningBlocks(blocks);
  return /claude/i.test(modelId) && valid.length ? { reasoning_blocks: valid } : {};
}

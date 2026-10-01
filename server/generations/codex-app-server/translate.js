/** Item snapshots fill missing suffixes; they never replay already streamed text. */
export function createCodexTranslator(emit) {
  const text = new Map();
  function append(key, channel, delta) {
    if (typeof delta !== 'string' || !delta) return;
    text.set(key, (text.get(key) ?? '') + delta);
    emit({ [channel]: delta });
  }
  function snapshot(key, channel, value) {
    const previous = text.get(key) ?? '';
    if (typeof value !== 'string') return;
    if (!value.startsWith(previous)) throw new Error('Codex changed an already streamed item.');
    append(key, channel, value.slice(previous.length));
  }
  return event => {
    const p = event.params;
    if (event.method === 'item/agentMessage/delta') append(p.itemId, 'content', p.delta);
    if (event.method === 'item/reasoning/summaryTextDelta') append(`${p.itemId}:${p.summaryIndex ?? 0}`, 'reasoning', p.delta);
    if (event.method === 'item/completed') {
      if (p.item.type === 'agentMessage') snapshot(p.item.id, 'content', p.item.text);
      if (p.item.type === 'reasoning') (p.item.summary ?? []).forEach((value, index) => snapshot(`${p.item.id}:${index}`, 'reasoning', value));
    }
  };
}
export function allocateCodexUsage(total = {}, baseline = {}) {
  const delta = key => Math.max(0, (total[key] ?? 0) - (baseline[key] ?? 0));
  return { prompt_tokens: delta('inputTokens'), completion_tokens: delta('outputTokens'), total_tokens: delta('totalTokens'),
    prompt_tokens_details: { cached_tokens: delta('cachedInputTokens') },
    completion_tokens_details: { reasoning_tokens: delta('reasoningOutputTokens') } };
}

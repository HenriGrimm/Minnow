/** Item snapshots fill missing suffixes; they never replay already streamed text. */
export function createCodexTranslator(emit) {
  const text = new Map();
  let reasoningKey;
  function append(key, channel, delta) {
    if (typeof delta !== 'string' || !delta) return;
    text.set(key, (text.get(key) ?? '') + delta);
    if (channel === 'reasoning') {
      // Summaries and content have independent indexes. Keep their sections
      // readable without inserting separators between tokens of one section.
      if (reasoningKey != null && reasoningKey !== key) delta = `\n\n${delta}`;
      reasoningKey = key;
    }
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
    if (event.method === 'item/reasoning/summaryTextDelta') append(`${p.itemId}:summary:${p.summaryIndex ?? 0}`, 'reasoning', p.delta);
    if (event.method === 'item/reasoning/textDelta') append(`${p.itemId}:content:${p.contentIndex ?? 0}`, 'reasoning', p.delta);
    if (event.method === 'item/completed') {
      if (p.item.type === 'agentMessage') snapshot(p.item.id, 'content', p.item.text);
      if (p.item.type === 'reasoning') {
        for (const field of ['summary', 'content']) {
          (p.item[field] ?? []).forEach((value, index) => snapshot(`${p.item.id}:${field}:${index}`, 'reasoning', value));
        }
      }
    }
  };
}
export function allocateCodexUsage(total = {}, baseline = {}) {
  if (![total.inputTokens, total.outputTokens, total.totalTokens].some(value => typeof value === 'number' && Number.isFinite(value))) return undefined;
  const delta = key => Math.max(0, (total[key] ?? 0) - (baseline[key] ?? 0));
  return { prompt_tokens: delta('inputTokens'), completion_tokens: delta('outputTokens'), total_tokens: delta('totalTokens'),
    ...(total.cachedInputTokens != null ? { prompt_tokens_details: { cached_tokens: delta('cachedInputTokens'),
      uncached_tokens: Math.max(0, delta('inputTokens') - delta('cachedInputTokens')) } } : {}),
    ...(total.reasoningOutputTokens != null ? { completion_tokens_details: { reasoning_tokens: delta('reasoningOutputTokens') } } : {}) };
}

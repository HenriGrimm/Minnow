function count(value) { return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0; }
function detail(value) {
  if (typeof value === 'string') {
    try { return detail(JSON.parse(value)); } catch { return value; }
  }
  return value?.message ?? value?.error?.message ?? JSON.stringify(value ?? 'Agent CLI failed.');
}

function joinedText(value) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.map(row => typeof row === 'string' ? row : row?.text ?? '').filter(Boolean).join('\n');
}

function codexReasoningText(item) {
  return typeof item?.text === 'string' && item.text.length > 0
    ? item.text : joinedText(item?.summary);
}

function minnowToolName(value) {
  if (typeof value !== 'string') return '';
  const match = /^mcp__minnow__(.+)$/i.exec(value.trim());
  return match?.[1] ?? '';
}

/** Provider-reported subscription state, never inferred from token/API costs. */
export function mapClaudeRateLimit(raw) {
  if (!raw || !['allowed', 'allowed_warning', 'rejected'].includes(raw.status)) return undefined;
  const result = { status: raw.status };
  const windows = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet', 'overage'];
  if (windows.includes(raw.rateLimitType)) result.window = raw.rateLimitType;
  // Rejected native responses can report utilization slightly above 1.
  if (Number.isFinite(raw.utilization) && raw.utilization >= 0) result.utilization = raw.utilization;
  if (Number.isFinite(raw.resetsAt) && raw.resetsAt > 0) result.resets_at = raw.resetsAt;
  for (const name of windows) {
    const source = raw.unifiedWindows?.[name];
    if (!source || typeof source !== 'object') continue;
    const row = {};
    if (Number.isFinite(source.utilization) && source.utilization >= 0) row.utilization = source.utilization;
    if (Number.isFinite(source.resetsAt) && source.resetsAt > 0) row.resets_at = source.resetsAt;
    if (Object.keys(row).length) (result.windows ??= {})[name] = row;
  }
  return result;
}

export function mapAgentCliUsage(raw, kind) {
  if (!raw || typeof raw !== 'object') return undefined;
  if (!['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cached_input_tokens', 'cache_creation_input_tokens']
    .some(key => typeof raw[key] === 'number' && Number.isFinite(raw[key]))) return undefined;
  const cached = count(raw.cache_read_input_tokens ?? raw.cached_input_tokens);
  const created = count(raw.cache_creation_input_tokens);
  const prompt = count(raw.input_tokens) + (kind === 'claude' ? cached + count(raw.cache_creation_input_tokens) : 0);
  const completion = count(raw.output_tokens);
  const reasoning = raw.reasoning_output_tokens ?? (kind === 'claude' ? raw.output_tokens_details?.thinking_tokens : undefined);
  return {
    prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion,
    ...(raw.cache_read_input_tokens != null || raw.cached_input_tokens != null || kind === 'claude' ? { prompt_tokens_details: {
      ...(raw.cache_read_input_tokens != null || raw.cached_input_tokens != null ? { cached_tokens: cached } : {}),
      ...(kind === 'claude' && raw.input_tokens != null ? { uncached_tokens: count(raw.input_tokens) } : {}),
      ...(kind === 'claude' && raw.cache_creation_input_tokens != null ? { cache_creation_tokens: created } : {}) } } : {}),
    ...(reasoning != null ? { completion_tokens_details: { reasoning_tokens: count(reasoning) } } : {}),
  };
}

/** Per-invocation state prevents SDK snapshots and terminal summaries from duplicating deltas. */
export function createAgentCliTranslator(kind, emit) {
  if (!['claude', 'codex', 'cursor'].includes(kind)) throw new Error('Unsupported agent CLI.');
  let sawText = false;
  let sawReasoning = false;
  let streamedMessageText = false;
  let streamedMessageReasoning = false;
  let terminal = null;
  let usage;
  let cost;
  const completed = new Set();
  const itemText = new Map();
  let lastActivity = '';
  let claudeUsage = {};
  function text(value) { if (typeof value === 'string' && value) { sawText = true; emit({ content: value }); } }
  function reasoning(value) { if (typeof value === 'string' && value) { sawReasoning = true; emit({ reasoning: value }); } }
  function activity(phase, toolName) {
    const key = `${phase}:${toolName ?? ''}`;
    if (key === lastActivity) return;
    lastActivity = key;
    emit({ activity: { phase, ...(toolName ? { toolName } : {}) } });
  }
  function snapshotDelta(key, value, sink) {
    if (typeof value !== 'string' || !value) return;
    const previous = itemText.get(key) ?? '';
    if (value === previous) return;
    itemText.set(key, value);
    sink(value.startsWith(previous) ? value.slice(previous.length) : value);
  }
  function finish(ok, error, finishReason = 'stop') { terminal = { ok, ...(error ? { error: detail(error) } : {}), finishReason }; }
  function consume(event) {
    if (terminal) return;
    if (kind === 'claude') {
      if (event.type === 'system' && event.subtype === 'api_retry' && [401, 403].includes(event.status ?? event.status_code)) finish(false, 'Authentication failed.');
      if (event.type === 'stream_event') {
        const part = event.event ?? {};
        if (part.type === 'message_start') {
          streamedMessageText = false;
          streamedMessageReasoning = false;
          claudeUsage = { ...part.message?.usage };
          usage = mapAgentCliUsage(claudeUsage, kind);
        }
        if (part.type === 'content_block_start' && part.content_block?.type === 'thinking') activity('thinking');
        if (part.type === 'content_block_start' && part.content_block?.type === 'tool_use') {
          const toolName = minnowToolName(part.content_block.name);
          if (toolName) activity('tools', toolName);
        }
        if (part.type === 'content_block_delta') {
          if (part.delta?.type === 'text_delta') { streamedMessageText = true; text(part.delta.text); }
          if (part.delta?.type === 'thinking_delta') { streamedMessageReasoning = true; activity('thinking'); reasoning(part.delta.thinking); }
        }
        if (part.type === 'message_delta') {
          claudeUsage = { ...claudeUsage, ...part.usage };
          usage = mapAgentCliUsage(claudeUsage, kind);
        }
      }
      if (event.type === 'assistant') {
        // The CLI emits one assistant event per content block, all sharing the
        // message id; only the event uuid identifies a replayed snapshot.
        const key = event.uuid ?? event.message?.id;
        if (key && completed.has(key)) return;
        if (key) completed.add(key);
        for (const block of event.message?.content ?? []) {
          if (block.type === 'text' && !streamedMessageText) text(block.text);
          if (block.type === 'thinking' && !streamedMessageReasoning) reasoning(block.thinking);
          if (block.type === 'tool_use' && !String(block.name).startsWith('mcp__minnow__')) emit({ forbiddenTool: block.name });
        }
        if (event.message?.usage) usage = mapAgentCliUsage(event.message.usage, kind);
      }
      if (event.type === 'result') {
        const ok = event.is_error !== true && (!event.subtype || event.subtype === 'success');
        if (!ok) { finish(false, event.errors?.join('\n') || event.error || event.result || event.subtype); return; }
        if (!sawText) text(event.structured_output != null ? JSON.stringify(event.structured_output) : event.result);
        if (event.usage) usage = mapAgentCliUsage(event.usage, kind);
        if (Number.isFinite(event.total_cost_usd) && event.total_cost_usd >= 0) cost = event.total_cost_usd;
        finish(true);
      }
      if (event.type === 'error') finish(false, event.error ?? event.message);
    } else if (kind === 'codex') {
      const item = event.item;
      if ((event.type === 'item.started' || event.type === 'item.updated') && item) {
        if (item.type === 'reasoning') {
          activity('thinking');
          if (event.type === 'item.updated') snapshotDelta(`reasoning:${item.id ?? 'active'}`, codexReasoningText(item), reasoning);
        }
        if (item.type === 'agent_message' && event.type === 'item.updated') {
          snapshotDelta(`message:${item.id ?? 'active'}`, item.text, text);
        }
        if (item.type === 'mcp_tool_call') {
          const toolName = minnowToolName(item.tool ?? item.name ?? item.tool_name);
          if (toolName) activity('tools', toolName);
        }
      }
      if (event.type === 'item.completed' && item) {
        if (item.id && completed.has(item.id)) return;
        if (item.id) completed.add(item.id);
        if (item.type === 'agent_message') snapshotDelta(`message:${item.id ?? 'active'}`, item.text, text);
        if (item.type === 'reasoning') snapshotDelta(`reasoning:${item.id ?? 'active'}`, codexReasoningText(item), reasoning);
        if (item.type === 'mcp_tool_call' && item.status === 'failed') finish(false, item.error ?? 'Minnow tool handoff failed.');
        if (['command_execution', 'file_change', 'web_search'].includes(item.type)) emit({ forbiddenTool: item.type });
      }
      if (event.type === 'turn.completed') { usage = mapAgentCliUsage(event.usage, kind); finish(true); }
      if (event.type === 'turn.failed' || event.type === 'error') finish(false, event.error ?? event.message);
    } else {
      if (event.type === 'assistant') {
        for (const block of event.message?.content ?? []) {
          if (block.type === 'thinking') { activity('thinking'); reasoning(block.thinking ?? block.text); }
          // Current Cursor stream-json emits ordinary assistant deltas without
          // timestamp_ms. model_call_id rows are aggregate snapshots and would
          // duplicate the timestamped/standard delta stream.
          if (block.type === 'text' && !event.model_call_id) text(block.text);
        }
      }
      if (event.type === 'thinking') {
        activity('thinking');
        reasoning(event.text ?? joinedText(event.message?.content));
      }
      if (event.type === 'result') {
        if (event.is_error === true || (event.subtype && event.subtype !== 'success')) { finish(false, event.error ?? event.result ?? event.subtype); return; }
        if (!sawText) text(event.result);
        usage = mapAgentCliUsage(event.usage, kind);
        finish(true);
      }
      if (event.type === 'error') finish(false, event.error ?? event.message);
    }
  }
  return { consume, snapshot: () => ({ terminal, usage, cost, sawText, sawReasoning }) };
}

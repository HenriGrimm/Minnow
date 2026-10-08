/** Parse JSON lines across arbitrary stdout chunks, including split Unicode. */
export function createAgentEventParser(receive) {
  let buffer = '';
  return text => {
    buffer += text;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (event && typeof event.type === 'string') receive(event);
    }
  };
}

const clipped = (text, max = 16000) => String(text ?? '').slice(0, max);
function displayArgs(raw) {
  let args = raw;
  if (typeof raw === 'string') { try { args = JSON.parse(raw); } catch { return { _raw: clipped(raw, 4000) }; } }
  if (!args || typeof args !== 'object' || Array.isArray(args)) return {};
  const json = JSON.stringify(args);
  if (json.length <= 8000) return args;
  // Keep file targets usable while bounding large source-write payloads.
  return { ...(typeof args.path === 'string' ? { path: clipped(args.path, 1000) } : {}), _raw: clipped(json, 8000) + '\n[Display truncated]' };
}

/** Fold runner snapshots into bounded display data; full chats persist separately. */
export function applyAgentEvent(run, event) {
  if (!['agent_start', 'agent_end', 'round_start', 'delta', 'thinking', 'reasoning_end', 'loading_model', 'tool_streaming', 'tool_call', 'tool_result', 'round_end', 'response_restart', 'context_compaction'].includes(event.type)) return;
  run.agentSessions ??= [];
  let session = run.agentSessions.find(item => item.chatId === event.chatId);
  if (event.type === 'agent_start') {
    if (!session) run.agentSessions.push({ chatId: event.chatId, phase: event.phase, state: 'running', rounds: [] });
    return;
  }
  if (!session) return;
  if (event.type === 'agent_end') {
    session.state = event.error ? 'failed' : 'complete';
    session.error = event.error ? clipped(event.error, 2000) : undefined;
    session.activity = undefined;
  } else {
    let round = session.rounds.at(-1);
    if (event.type === 'round_start' || !round) {
      round = { id: `${session.chatId}:${event.index ?? session.rounds.length}`, text: '', reasoning: '', tools: [] };
      session.rounds.push(round);
    }
    if (event.type === 'delta') { round.text = clipped(event.text); session.activity = 'generating'; }
    if (event.type === 'thinking') { round.reasoning = clipped(event.text); session.activity = 'thinking'; }
    if (event.type === 'reasoning_end') session.activity = 'generating';
    if (event.type === 'loading_model') session.activity = 'loading';
    if (event.type === 'tool_streaming') { session.activity = 'tools'; session.currentTool = event.name; }
    if (event.type === 'tool_call') {
      session.activity = 'tools'; session.currentTool = event.name;
      const id = event.id ?? `${round.id}:tool:${round.tools.length}`;
      if (!round.tools.some(tool => tool.id === id)) round.tools.push({ id, name: event.name, args: displayArgs(event.arguments) });
    }
    if (event.type === 'tool_result') {
      const tool = event.id ? round.tools.find(item => item.id === event.id)
        : round.tools.find(item => item.name === event.name && item.result === undefined);
      if (tool) { tool.result = clipped(event.content, 8000); tool.isError = event.isError || tool.result.trimStart().startsWith('Error:'); }
    }
    if (event.type === 'round_end') {
      round.text = clipped(event.text); round.reasoning = clipped(event.reasoning);
      round.complete = true; session.activity = 'generating'; session.currentTool = undefined;
    }
    if (event.type === 'response_restart') { round.text = ''; round.reasoning = ''; round.notice = clipped(event.warning, 2000); }
    if (event.type === 'context_compaction') round.notice = 'Context compacted. Earlier activity remains in the saved chat.';
  }
  // Remove whole old rounds instead of splitting a tool call from its result.
  while (JSON.stringify(run.agentSessions).length > 512000) {
    const oldest = run.agentSessions.find(item => item.rounds.length > 1);
    if (oldest) { oldest.rounds.shift(); oldest.truncated = true; }
    else if (run.agentSessions.length > 1) run.agentSessions.shift();
    else {
      const round = run.agentSessions[0].rounds[0];
      if (!round?.tools.length) break;
      round.tools.shift(); run.agentSessions[0].truncated = true;
    }
  }
}

import { factoryCheckPassed } from './factory-checkpoint.js';

/** Project scheduled tools onto their lead input for display. The runner reads the original transcript. */
export function withFactoryActivity(db, chatId, messages) {
  const inputs = new Map();
  for (const message of messages) {
    if (message.role === 'user' && message.hiddenFromTranscript && message.commandId &&
        message.provenance?.source === 'factory' && message.provenance.kind === 'goal_continuation') {
      inputs.set(message.commandId, message);
    }
  }
  if (!inputs.size) return messages;
  const rows = db.prepare(`
    SELECT e.command_id, e.status, t.invocation_id, t.tool_call_id, t.tool_name,
           t.payload_json, t.result_json
    FROM chat_executions e JOIN chat_tool_invocations t ON t.execution_id=e.execution_id
    WHERE e.chat_id=? AND t.chat_id=e.chat_id AND e.command_id IN (SELECT value FROM json_each(?))
      AND json_extract(e.captured_json,'$.factoryRunId') IS NOT NULL
      AND ((json_extract(e.captured_json,'$.factoryAssignment') IS NOT NULL AND
             ((t.tool_name='spawn_sub_agent' AND t.tool_call_id=json_extract(t.payload_json,'$.client_request_id')) OR
              (t.tool_name='execute_command' AND t.tool_call_id GLOB 'factory-feature-check-[0-9]*')))
        OR (json_extract(e.captured_json,'$.factoryPhase')='verify' AND
            t.tool_name='execute_command' AND t.tool_call_id GLOB 'factory-check-[0-9]*'))
    ORDER BY t.created_at,t.rowid`).all(chatId, JSON.stringify([...inputs.keys()]));
  const activity = new Map();
  for (const row of rows) {
    const spawn = row.tool_name === 'spawn_sub_agent';
    const scheduledId = spawn ? /^factory-[a-f0-9]{40}$/ : /^factory-(?:feature-)?check-\d+$/;
    if (!scheduledId.test(row.tool_call_id)) continue;
    const input = JSON.parse(row.payload_json);
    const result = JSON.parse(row.result_json);
    // Checks reuse their ordinal across features. Spawn ids also identify the child in the agent journal.
    const tool = { id: spawn ? row.tool_call_id : row.invocation_id, name: row.tool_name,
      args: spawn ? { title: input.title, task: input.task } : { command: input.command, cwd: input.cwd } };
    if (result?.indeterminate) tool.interrupted = 'paused';
    else if (typeof result?.content === 'string') {
      const content = result.content;
      tool.result = content.length <= 4000 ? content : content.slice(0, 2000) + '\n…\n' + content.slice(-2000);
      if (spawn && content.length > 4000 && !result.isError) {
        // Keep the child link parseable when a long report exceeds the tool preview.
        try {
          const { runId, childChatId, status } = JSON.parse(content);
          if (runId) tool.result = JSON.stringify({ runId, childChatId, status });
        } catch { /* Plain-text dispatch failures use the bounded preview. */ }
      }
      if (result.isError || (spawn ? content.startsWith('Error:') : !factoryCheckPassed(result, input.command))) tool.failed = true;
    } else if (row.status === 'stopped') tool.interrupted = 'stopped';
    else if (['recovery_required', 'failed', 'completed'].includes(row.status)) tool.interrupted = 'paused';
    const tools = activity.get(row.command_id) ?? [];
    tools.push(tool);
    activity.set(row.command_id, tools);
  }
  return messages.map(message => inputs.get(message.commandId) === message && activity.has(message.commandId)
    ? { ...message, factoryTools: activity.get(message.commandId) } : message);
}

/** Pure catalog shared by renderer, native CLI handoff and server preparation. */
const string = () => ({ type: 'string' });
const limit = { type: 'integer', minimum: 1, maximum: 100 };
export const CHAT_WAIT_TIMEOUT_MS = Object.freeze({ type: 'integer', minimum: 0, maximum: 120000, default: 10000,
  description: 'Milliseconds to wait. Use 0 for an immediate status check.' });
const entries = [
  ['agent_capabilities', 'Agent capabilities', 'Discover agent types, model IDs, options and availability.',
    { search: string(), cursor: string(), limit }, []],
  ['chat_list', 'List chats', 'List project chats; children omitted by default.',
    { query: string(), status: string(), include_subagents: { type: 'boolean' }, cursor: string(), limit }, []],
  ['chat_create', 'Create a top-level chat', 'Only when explicitly requested by the user. Creates a separate ordinary chat (one-time human confirmation outside Full access). Optional message starts work; report_back allows reading or waiting for the first reply. For an isolated worktree created in Full access, this also lets the same manager coordinate later human-started Full access turns.',
    { title: string(), message: string(), provider_id: string(), model_id: string(), reasoning_effort: string(), workspace_id: string(),
      enable_worktree: { type: 'boolean', description: 'Enable a new isolated worktree for this chat, like the composer. From Local, mirrors every repository in a multi-repo workspace. Cannot be combined with workspace_id.' },
      report_back: { type: 'boolean' }, client_request_id: string() }, ['title']],
  ['chat_read', 'Read chat', 'Read bounded attributed messages/activity; image/reasoning bytes omitted.',
    { chat_id: string(), view: { type: 'string', enum: ['messages', 'activity'] }, after_sequence: { type: 'integer', minimum: -1 }, limit }, ['chat_id']],
  ['chat_send', 'Message chat', 'Message an existing chat. auto starts/queues; steer updates active work. No auto-reply; retry IDs require identical input.',
    { chat_id: string(), message: string(), mode: { type: 'string', enum: ['auto', 'queue', 'steer'] }, execution_id: string(), client_request_id: string() }, ['chat_id', 'message']],
  ['chat_wait', 'Wait for chat', 'Pin execution_id or the command_id receipt from an assigned chat. Timeout never cancels. Returns blocked requests/capabilities.',
    { chat_id: string(), execution_id: string(), command_id: string(), timeout_ms: CHAT_WAIT_TIMEOUT_MS }, ['chat_id']],
  ['chat_retry_worktree', 'Retry assigned chat worktree setup', 'Retry failed setup in the same assigned worktree. Full access manager only. Does not resend the message or fall back to Local. Use the setup intent_id returned by chat_read or chat_wait.',
    { chat_id: string(), intent_id: string() }, ['chat_id', 'intent_id']],
  ['chat_stop', 'Stop chat', 'Stop a turn/tree; stale execution_id never stops newer work.',
    { chat_id: string(), execution_id: string(), scope: { type: 'string', enum: ['turn', 'tree'] }, client_request_id: string() }, ['chat_id']],
];
export const CHAT_COORDINATION_TOOLS = entries.map(([id, label, description, properties, required]) => ({
  id, label, description, category: 'agents', serverRequired: false,
  definition: { type: 'function', function: { name: id, description, parameters: { type: 'object', properties, required } } },
}));

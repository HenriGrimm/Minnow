/** Pure catalog shared by renderer, native CLI handoff and server preparation. */
const string = () => ({ type: 'string' });
const limit = { type: 'integer', minimum: 1, maximum: 100 };
const entries = [
  ['agent_capabilities', 'Agent capabilities', 'Discover agent types, model IDs, options and availability.',
    { search: string(), cursor: string(), limit }, []],
  ['chat_list', 'List chats', 'List project chats; children omitted by default.',
    { query: string(), status: string(), include_subagents: { type: 'boolean' }, cursor: string(), limit }, []],
  ['chat_read', 'Read chat', 'Read bounded attributed messages/activity; image/reasoning bytes omitted.',
    { chat_id: string(), view: { type: 'string', enum: ['messages', 'activity'] }, after_sequence: { type: 'integer', minimum: -1 }, limit }, ['chat_id']],
  ['chat_send', 'Message chat', 'Message an existing chat. auto starts/queues; steer updates active work. No auto-reply; retry IDs require identical input.',
    { chat_id: string(), message: string(), mode: { type: 'string', enum: ['auto', 'queue', 'steer'] }, client_request_id: string() }, ['chat_id', 'message']],
  ['chat_wait', 'Wait for chat', 'Pin execution_id or current work; timeout never cancels. Returns blocked requests/capabilities.',
    { chat_id: string(), execution_id: string(), timeout_ms: { type: 'integer', minimum: 0, maximum: 60000 } }, ['chat_id']],
  ['chat_stop', 'Stop chat', 'Stop a turn/tree; stale execution_id never stops newer work.',
    { chat_id: string(), execution_id: string(), scope: { type: 'string', enum: ['turn', 'tree'] }, client_request_id: string() }, ['chat_id']],
];
export const CHAT_COORDINATION_TOOLS = entries.map(([id, label, description, properties, required]) => ({
  id, label, description, category: 'agents', serverRequired: false,
  definition: { type: 'function', function: { name: id, description, parameters: { type: 'object', properties, required } } },
}));

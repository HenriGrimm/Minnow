import { createHash } from 'node:crypto';
import { buildAgentCliToolCatalog } from '../agent-cli/bridge.js';
import { MAX_TRANSCRIPT_BYTES } from '../agent-cli/prompt.js';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function normalizeMessages(messages) {
  if (!Array.isArray(messages) || !messages.length) throw new Error('Codex requires a conversation.');
  return messages.map(row => {
    if (!['system', 'developer', 'user', 'assistant', 'tool'].includes(row?.role)) throw new Error('Unsupported Codex message role.');
    let content = row.content ?? '';
    if (Array.isArray(content)) content = content.map(part => {
      if (part.type !== 'text') throw new Error('Codex CLI does not support this attachment type.');
      return String(part.text ?? '');
    }).join('\n');
    if (typeof content !== 'string') throw new Error('Unsupported Codex message content.');
    return { role: row.role, content, ...(row.role === 'tool' ? { tool_call_id: row.tool_call_id } : {}),
      ...(row.tool_calls?.length ? { tool_calls: row.tool_calls.map(call => ({ id: call.id, type: 'function',
        function: { name: call.function?.name, arguments: call.function?.arguments } })) } : {}) };
  });
}
export function prepareConversation(body, identity) {
  if (body.n != null && body.n !== 1) throw new Error('Codex supports one response per request.');
  const messages = normalizeMessages(body.messages);
  const tools = buildAgentCliToolCatalog(body).map((tool, index) => ({ ...tool, name: `mn_tool_${index}` }));
  const systems = messages.filter(row => ['system', 'developer'].includes(row.role));
  const instructions = systems.map(row => row.content).join('\n\n');
  if (Buffer.byteLength(JSON.stringify(messages)) > MAX_TRANSCRIPT_BYTES) throw new Error('Codex transcript exceeds 8 MB.');
  return { messages, tools, instructions, signature: hash({ identity, systems, model: body.model, tools,
    effort: body.reasoning_effort, choice: body.tool_choice, format: body.response_format }),
    dynamicTools: tools.map(({ name, description, inputSchema }) => ({ type: 'function', name, description, inputSchema })) };
}
export function continuation(session, prepared) {
  if (session.signature !== prepared.signature || session.closed) return null;
  const before = session.accepted;
  const after = prepared.messages;
  if (after.length < before.length || hash(after.slice(0, before.length)) !== hash(before)) return null;
  const appended = after.slice(before.length);
  if (session.waiting) {
    if (appended.length !== session.handed.length || appended.some(row => row.role !== 'tool')) return null;
    const results = new Map(appended.map(row => [row.tool_call_id, row.content]));
    if (results.size !== session.handed.length || !session.handed.every(call => results.has(call.id))) return null;
    return { results };
  }
  if (!appended.length || appended.some(row => row.role !== 'user')) return null;
  return { input: appended.map(row => ({ type: 'text', text: row.content })) };
}
/** Raw typed history never includes private reasoning or fabricated tool output. */
export function seedConversation(prepared) {
  const rows = prepared.messages.filter(row => !['system', 'developer'].includes(row.role));
  const latest = rows.at(-1)?.role === 'user' ? rows.pop() : null;
  const names = new Map(prepared.tools.map(tool => [tool.originalName, tool.name]));
  const items = [];
  for (const row of rows) {
    if (row.role === 'tool') items.push({ type: 'function_call_output', call_id: row.tool_call_id, output: row.content });
    else {
      if (row.content) items.push({ type: 'message', role: row.role,
        content: [{ type: row.role === 'assistant' ? 'output_text' : 'input_text', text: row.content }] });
      for (const call of row.tool_calls ?? []) items.push({ type: 'function_call', call_id: call.id,
        name: names.get(call.function.name) ?? `historical_${hash(call.function.name).slice(0, 16)}`, arguments: call.function.arguments });
    }
  }
  return { items, input: latest ? [{ type: 'text', text: latest.content }] : [] };
}

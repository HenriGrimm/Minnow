import { createHash } from 'node:crypto';
import { buildAgentCliToolCatalog } from '../agent-cli/bridge.js';
import { MAX_TRANSCRIPT_BYTES, validateAgentCliImageUrl } from '../agent-cli/prompt.js';
import { segmentTurns } from '../../runner/compaction/segment.js';
import { elideToolRow } from '../../runner/compaction/elide.js';
import { codexReadBatchTool } from './read-batch.js';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function normalizeMessages(messages, { deferImageCount = false } = {}) {
  if (!Array.isArray(messages) || !messages.length) throw new Error('Codex requires a conversation.');
  let images = 0;
  return messages.map(row => {
    if (!['system', 'developer', 'user', 'assistant', 'tool'].includes(row?.role)) throw new Error('Unsupported Codex message role.');
    let content = row.content ?? '';
    if (Array.isArray(content)) {
      const parts = content.map(part => {
        if (part?.type === 'text') return { type: 'text', text: String(part.text ?? '') };
        if (part?.type !== 'image_url' || row.role !== 'user') throw new Error('Codex CLI does not support this attachment type.');
        const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
        validateAgentCliImageUrl(url, 'Codex CLI');
        if (++images > 12 && !deferImageCount) throw new Error('Agent CLI accepts at most 12 images per request.');
        return { type: 'image_url', image_url: { url } };
      });
      content = parts.some(part => part.type === 'image_url') ? parts : parts.map(part => part.text).join('\n');
    }
    if (typeof content !== 'string' && !Array.isArray(content)) throw new Error('Unsupported Codex message content.');
    return { role: row.role, content: row.role === 'assistant' && typeof content === 'string' ? content.trim() : content, ...(row.role === 'tool' ? { tool_call_id: row.tool_call_id } : {}),
      ...(row.role === 'user' && row.toolImageFollowUp === true ? { toolImageFollowUp: true, ...(typeof row.toolImageCallId === 'string' ? { toolImageCallId: row.toolImageCallId } : {}) } : {}),
      ...(row.tool_calls?.length ? { tool_calls: row.tool_calls.map(call => ({ id: call.id, type: 'function',
        function: { name: call.function?.name, arguments: call.function?.arguments } })) } : {}) };
  });
}
export function codexUserInput(row) {
  if (typeof row.content === 'string') return [{ type: 'text', text: row.content }];
  return row.content.map(part => part.type === 'text' ? { type: 'text', text: part.text }
    : { type: 'image', url: part.image_url.url });
}
/** Project the native seed only. The canonical rows still identify a pending tool handoff. */
function fitNativeSeed(rows) {
  const size = row => Buffer.byteLength(JSON.stringify(row)) + 1;
  const images = row => Array.isArray(row.content) ? row.content.filter(part => part.type === 'image_url').length : 0;
  let bytes = 1, imageCount = 0;
  for (const row of rows) { bytes += size(row); imageCount += images(row); }
  const fits = () => bytes <= MAX_TRANSCRIPT_BYTES && imageCount <= 12;
  if (fits()) return rows;
  const projected = rows.slice(), turns = segmentTurns(rows), current = turns.at(-1);
  const latestRound = current.rounds.at(-1).start;
  for (let i = 0; i < latestRound && !fits(); i++) {
    const row = rows[i];
    if (row.toolImageFollowUp && images(row)) {
      const compact = { ...row, content: '[Earlier tool screenshot omitted to fit the native request.]' };
      projected[i] = compact; imageCount -= images(row); bytes -= size(row) - size(compact);
      continue;
    }
    if (row.role !== 'tool') continue;
    const compact = elideToolRow(row, { rowId: null });
    if (row !== compact) { projected[i] = compact; bytes -= size(row) - size(compact); }
  }
  for (const turn of turns.slice(0, -1)) {
    if (fits()) break;
    for (let i = turn.start; i < turn.end; i++) {
      const row = projected[i];
      if (row.role === 'system' || row.role === 'developer') continue;
      bytes -= size(row); imageCount -= images(row); projected[i] = null;
    }
  }
  if (imageCount > 12) throw new Error('Codex accepts at most 12 images in the current turn. Send fewer attachments.');
  if (!fits()) throw new Error(`Codex transcript exceeds 8 MiB after compacting older history (${bytes} bytes remain). Reduce the current input, attachments or latest tool output.`);
  return projected.filter(Boolean);
}

export function prepareConversation(body, identity) {
  if (body.n != null && body.n !== 1) throw new Error('Codex supports one response per request.');
  const canonical = normalizeMessages(body.messages, { deferImageCount: true });
  const messages = fitNativeSeed(canonical);
  const tools = buildAgentCliToolCatalog(body).map((tool, index) => ({ ...tool, name: `mn_tool_${index}`,
    description: `Minnow tool: ${tool.originalName}\n${tool.description}` }));
  const batchTool = codexReadBatchTool(tools, body.tool_choice);
  if (batchTool) {
    for (const tool of tools) {
      if (batchTool.inputSchema.properties.calls.items.properties.name.enum.includes(tool.originalName)) {
        tool.description += '\nFor multiple independent lookups, use mn_read_batch with the original Minnow names and these arguments in one request.';
      }
    }
    tools.push(batchTool);
  }
  const systems = messages.filter(row => ['system', 'developer'].includes(row.role));
  const instructions = systems.map(row => row.content).join('\n\n');
  return { messages, canonical, tools, instructions, signature: hash({ identity, systems, model: body.model, tools,
    effort: body.reasoning_effort, choice: body.tool_choice, format: body.response_format }),
    dynamicTools: tools.map(({ name, description, inputSchema }) => ({ type: 'function', name, description, inputSchema })) };
}
export function continuation(session, prepared) {
  if (session.signature !== prepared.signature || session.closed) return null;
  const before = session.accepted;
  const after = prepared.canonical;
  if (after.length < before.length || hash(after.slice(0, before.length)) !== hash(before)) return null;
  const appended = after.slice(before.length);
  if (session.waiting) {
    const results = new Map();
    let previousToolId;
    const attached = new Set();
    for (const row of appended) {
      if (row.role === 'tool') {
        if (results.has(row.tool_call_id)) return null;
        results.set(row.tool_call_id, [{ type: 'inputText', text: row.content }]);
        previousToolId = row.tool_call_id;
      } else if (row.role === 'user' && row.toolImageFollowUp === true) {
        const id = row.toolImageCallId ?? previousToolId;
        if (!results.has(id) || attached.has(id)) return null;
        attached.add(id);
        results.get(id).push(...codexUserInput(row).map(part => part.type === 'text'
          ? { type: 'inputText', text: part.text } : { type: 'inputImage', imageUrl: part.url }));
        previousToolId = undefined;
      } else return null;
    }
    if (results.size !== session.handed.length || !session.handed.every(call => results.has(call.id))) return null;
    return { results };
  }
  if (!appended.length || appended.some(row => row.role !== 'user')) return null;
  return { input: appended.flatMap(codexUserInput) };
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
        content: codexUserInput(row).map(part => part.type === 'image'
          ? { type: 'input_image', image_url: part.url, detail: 'auto' }
          : { type: row.role === 'assistant' ? 'output_text' : 'input_text', text: part.text }) });
      for (const call of row.tool_calls ?? []) items.push({ type: 'function_call', call_id: call.id,
        name: names.get(call.function.name) ?? `historical_${hash(call.function.name).slice(0, 16)}`, arguments: call.function.arguments });
    }
  }
  return { items, input: latest ? codexUserInput(latest) : [] };
}
